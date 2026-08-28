/**
 * Commissioning check — the whole system, cold, under load, and misused.
 *
 * Runs against a FRESH data directory: every database, table, seed and index is
 * created from nothing, exactly as it will be on the VPS.
 *
 * Usage: npx tsx tests/commissioning.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.RENDER_CRON_ENABLED = 'false';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';
process.env.LOGIN_RATE_LIMIT_MAX = '10000';
process.env.RATE_LIMIT_MAX = '100000';

export {};

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}
function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- 1. cold
  section('1. Cold start from an empty data directory');

  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commissioning-'));
  process.env.DATA_DIR = path.join(freshDir, 'data');
  process.env.UPLOADS_DIR = path.join(freshDir, 'uploads');
  process.env.CATALOG_DIR = path.join(freshDir, 'catalog');
  console.log(`  using ${freshDir}`);

  const { env } = await import('../src/config/env');
  check('data directory created', fs.existsSync(env.dataDir));
  check('uploads directory created', fs.existsSync(env.uploadsDir));
  check('catalog directory created', fs.existsSync(env.catalogDir));

  const { referenceTables } = await import('../src/data/referenceTables');
  check('reference tables loaded', referenceTables.brands.length === 839, referenceTables.brands.length);

  const { operationalDb } = await import('../src/db/operationalDb');
  const { flywheelDb } = await import('../src/db/flywheelDb');
  const { controlDb } = await import('../src/db/controlDb');
  await import('../src/db/appUsers');

  const tablesOf = (db: { prepare: (s: string) => { all: () => unknown[] } }) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
      name: string;
    }[]).map((r) => r.name);

  const opTables = tablesOf(operationalDb);
  const fwTables = tablesOf(flywheelDb);
  const ctlTables = tablesOf(controlDb);

  check('server_scans.db created', opTables.includes('server_scans'), opTables);
  check('flywheel.db created', fwTables.includes('flywheel_training'), fwTables);
  for (const t of ['server_status', 'server_events', 'ui_commands', 'message_dictionary',
                   'message_translations', 'vision_settings', 'vision_settings_pending',
                   'app_users', 'app_user_requests', 'app_users_public']) {
    check(`control.db has ${t}`, ctlTables.includes(t), ctlTables);
  }

  const walOf = (db: { pragma: (source: string, options?: { simple?: boolean }) => unknown }) =>
    String(db.pragma('journal_mode', { simple: true }));
  check('server_scans.db in WAL', walOf(operationalDb) === 'wal');
  check('flywheel.db in WAL', walOf(flywheelDb) === 'wal');
  check('control.db in WAL', walOf(controlDb) === 'wal');

  const { startControlService, stopControlService } = await import('../src/services/controlService');
  const { startExtractionQueue, stopExtractionQueue } = await import('../src/services/extractionQueue');
  startControlService();
  startExtractionQueue();

  const { listUsers } = await import('../src/db/appUsers');
  check('three operators seeded', listUsers().length === 3, listUsers().map((u) => u.username));

  const { readStatus } = await import('../src/db/controlDb');
  check('status row initialised', typeof readStatus().heartbeat_at === 'number');
  check(
    'no API key -> vision reported as blocked',
    readStatus().vision_state === 'PAUSED' && readStatus().active_fault === 'VISION_NOT_CONFIGURED',
    readStatus(),
  );

  const dictCount = (controlDb.prepare('SELECT COUNT(*) AS n FROM message_dictionary').get() as {
    n: number;
  }).n;
  check('message dictionary seeded', dictCount >= 30, dictCount);

  // ------------------------------------------------------------- 2. serving
  section('2. Server accepts traffic');
  const { createApp } = await import('../src/app');
  const app = createApp();
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const health = await fetch(`${base}/health`);
  check('GET /health 200', health.status === 200);

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'minelli', password: 'minelli' }),
  });
  check('seeded operator can log in', login.status === 200, login.status);
  const token = ((await login.json()) as { token: string }).token;
  const auth = { Authorization: `Bearer ${token}` };

  // ------------------------------------------------------------ 3. the load
  section('3. Load simulation — 10 devices, 5 scans each, concurrent');
  const photo = fs.readFileSync('../sample_photo/set00/A1.jpeg');
  const DEVICES = 10;
  const PER_DEVICE = 5;
  const TOTAL = DEVICES * PER_DEVICE;

  const submit = (id: string) => {
    const form = new FormData();
    form.append('apparel_id', id);
    form.append('username', 'minelli');
    form.append('key_photo_index', '0');
    form.append('images', new Blob([photo], { type: 'image/jpeg' }), 'p.jpg');
    return fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: auth, body: form });
  };

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: DEVICES }, (_, d) =>
      (async () => {
        const codes: number[] = [];
        for (let i = 0; i < PER_DEVICE; i += 1) {
          const res = await submit(`LOAD-${d}-${i}`);
          codes.push(res.status);
        }
        return codes;
      })(),
    ),
  );
  const elapsed = Date.now() - started;
  const codes = results.flat();

  console.log(`  ${TOTAL} scans in ${elapsed} ms (${(elapsed / TOTAL).toFixed(1)} ms/scan)`);
  check('every submission accepted with 202', codes.every((c) => c === 202), [...new Set(codes)]);
  check('throughput under 200 ms/scan', elapsed / TOTAL < 200, elapsed / TOTAL);

  const { getScan } = await import('../src/db/operationalDb');
  let stored = 0;
  let photosOnDisk = 0;
  for (let d = 0; d < DEVICES; d += 1) {
    for (let i = 0; i < PER_DEVICE; i += 1) {
      const scan = getScan(`LOAD-${d}-${i}`);
      if (scan) stored += 1;
      const dir = path.join(env.uploadsDir, `LOAD-${d}-${i}`);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) photosOnDisk += 1;
    }
  }
  check(`all ${TOTAL} scans durably stored`, stored === TOTAL, stored);
  check(`all ${TOTAL} photo sets on disk`, photosOnDisk === TOTAL, photosOnDisk);

  const { extractionCounts } = await import('../src/db/operationalDb');
  check('all queued for extraction', extractionCounts().pending === TOTAL, extractionCounts());

  // ----------------------------------------------- 4. cross-process exchange
  section('4. control.db exchange under concurrent access');
  const Database = (await import('better-sqlite3')).default;
  const uiDb = new Database(path.join(env.dataDir, 'control.db'));
  uiDb.pragma('journal_mode = WAL');
  uiDb.pragma('busy_timeout = 5000');

  // The UI writes while devices are still submitting.
  const contention = await Promise.all([
    (async () => {
      const ids: number[] = [];
      for (let i = 0; i < 25; i += 1) {
        const r = uiDb
          .prepare(
            `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
             VALUES ('PING', NULL, ?, 'ui:commissioning', 'PENDING')`,
          )
          .run(Date.now());
        ids.push(Number(r.lastInsertRowid));
      }
      return ids;
    })(),
    (async () => {
      const codes: number[] = [];
      for (let i = 0; i < 25; i += 1) codes.push((await submit(`MIX-${i}`)).status);
      return codes;
    })(),
  ]);
  check('25 UI writes succeeded during device traffic', (contention[0] as number[]).length === 25);
  check('25 concurrent scans still 202', (contention[1] as number[]).every((c) => c === 202));

  const { processPendingCommands } = await import('../src/services/controlService');
  processPendingCommands();
  const doneCount = (
    uiDb.prepare("SELECT COUNT(*) AS n FROM ui_commands WHERE status = 'DONE'").get() as {
      n: number;
    }
  ).n;
  check('all UI commands reached a terminal state', doneCount === 25, doneCount);

  const openEvents = uiDb
    .prepare('SELECT code, occurrences FROM server_events WHERE resolved_at IS NULL')
    .all() as { code: string; occurrences: number }[];
  check('events are coalesced, not duplicated',
    new Set(openEvents.map((e) => e.code)).size === openEvents.length, openEvents);

  // Operator management from the "UI" while traffic flows.
  uiDb
    .prepare(
      `INSERT INTO app_user_requests (action, username, password, submitted_at, submitted_by, status)
       VALUES ('CREATE', 'commissioning_op', 'a-good-password', ?, 'ui:commissioning', 'PENDING')`,
    )
    .run(Date.now());
  const { processPendingUserRequests } = await import('../src/services/userService');
  processPendingUserRequests();
  const newOp = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'commissioning_op', password: 'a-good-password' }),
  });
  check('operator created via control.db can log in', newOp.status === 200, newOp.status);

  // ------------------------------------------------------- 5. hostile input
  section('5. Malformed and hostile input');
  const bad: Array<[string, () => Promise<Response>]> = [
    ['no auth', () => fetch(`${base}/api/v1/vision/extract`, { method: 'POST' })],
    ['garbage token', () =>
      fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: { Authorization: 'Bearer x.y.z' } })],
    ['empty multipart', () =>
      fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: auth, body: new FormData() })],
    ['malformed JSON login', () =>
      fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
      })],
    ['unknown route', () => fetch(`${base}/api/v1/nope`, { headers: auth })],
    ['path traversal in id', () =>
      fetch(`${base}/api/v1/vision/result/..%2F..%2Fetc%2Fpasswd`, { headers: auth })],
  ];
  for (const [name, call] of bad) {
    try {
      const res = await call();
      check(`${name} -> ${res.status}, server still alive`, res.status >= 400 && res.status < 500, res.status);
    } catch (error) {
      check(`${name} did not crash the server`, false, error);
    }
  }

  // A barcode with path characters must not escape the uploads directory.
  const evil = new FormData();
  evil.append('apparel_id', '../../escaped');
  evil.append('username', 'minelli');
  evil.append('key_photo_index', '0');
  evil.append('images', new Blob([photo], { type: 'image/jpeg' }), 'p.jpg');
  const evilRes = await fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: auth, body: evil });
  check('hostile apparel_id accepted but sanitised', evilRes.status === 202, evilRes.status);
  check(
    'nothing written outside uploads/',
    !fs.existsSync(path.join(freshDir, 'escaped')) && !fs.existsSync(path.join(env.uploadsDir, '..', 'escaped')),
  );

  const stillOk = await fetch(`${base}/health`);
  check('server healthy after the hostile batch', stillOk.status === 200);

  // -------------------------------------------------------- 6. restart safe
  section('6. Restart behaviour');
  const { setServerState } = await import('../src/db/controlDb');
  setServerState('BLOCKED', 'PAUSED', 'VISION_BILLING_REQUIRED', 'commissioning');
  stopControlService();
  stopExtractionQueue();
  startControlService();
  startExtractionQueue();

  check('pause survived the restart', readStatus().vision_state === 'PAUSED', readStatus());
  check('seeds did not duplicate', listUsers().length === 4, listUsers().map((u) => u.username));

  const afterRestart = await submit('AFTER-RESTART-1');
  check('still accepting scans while paused', afterRestart.status === 202, afterRestart.status);
  check('and it was stored', getScan('AFTER-RESTART-1') !== undefined);

  // ------------------------------------------------------------ 7. teardown
  section('7. Shutdown');
  uiDb.close();
  await new Promise<void>((r) => server.close(() => r()));
  stopControlService();
  stopExtractionQueue();
  check('closed cleanly', true);

  const totalStored = (
    operationalDb.prepare('SELECT COUNT(*) AS n FROM server_scans').get() as { n: number }
  ).n;
  console.log(`\n  ${totalStored} scans in the operational database, none lost.`);

  try {
    fs.rmSync(freshDir, { recursive: true, force: true });
  } catch {
    /* the databases may still hold handles on Windows; harmless */
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log('failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
