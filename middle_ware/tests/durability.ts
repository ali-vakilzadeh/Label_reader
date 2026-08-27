/**
 * Proves the zero-data-loss guarantee end to end:
 *
 *   - a scan submitted while the vision API is broken is still recorded
 *   - the pause survives a simulated restart (it lives in control.db, not memory)
 *   - the UI sees an actionable event and a heartbeat
 *   - a UI command resumes processing and the backlog drains to completion
 *   - a flywheel purge without a watermark is refused
 *
 * Usage: npx tsx tests/durability.ts
 */
process.env.GEMINI_API_KEY = 'AIzaSyDELIBERATELY_INVALID_KEY';
process.env.CONTROL_HEARTBEAT_MS = '3600000'; // manual control in this test
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';
process.env.RENDER_CRON_ENABLED = 'false';

import fs from 'node:fs';
import type { Server } from 'node:http';

let passed = 0;
let failed = 0;
/** Set once the test edits .env, so the file is always put back. */
let restoreEnvFile: (() => void) | null = null;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

let skipped = 0;
function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}

async function main(): Promise<void> {
  const { createApp } = await import('../src/app');
  const { getScan, extractionCounts } = await import('../src/db/operationalDb');
  const { controlDb, readStatus, listOpenEvents, issueCommand, takePendingCommands } =
    await import('../src/db/controlDb');
  const { flywheelDb, insertFlywheelRecord, flywheelMaxRowId, countFlywheelRecords } =
    await import('../src/db/flywheelDb');
  const {
    startControlService,
    processPendingCommands,
    publishHeartbeat,
    isVisionPaused,
  } = await import('../src/services/controlService');
  const { drainNow } = await import('../src/services/extractionQueue');
  const { env } = await import('../src/config/env');
  const { UI_COMMANDS } = await import('../src/db/messageCatalogue');

  // Clean slate.
  controlDb.exec('DELETE FROM server_events; DELETE FROM ui_commands;');
  flywheelDb.exec('DELETE FROM flywheel_training');

  startControlService();

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emp_402', password: env.masterPassword }),
  });
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };

  // ------------------------------------------------------------------------
  section('Scan submitted while the vision API is broken');
  const id = 'DURABILITY-001';
  const form = new FormData();
  form.append('apparel_id', id);
  form.append('username', 'emp_402');
  form.append('key_photo_index', '0');
  form.append(
    'images',
    new Blob([fs.readFileSync('../sample_photo/set00/A1.jpeg')], { type: 'image/jpeg' }),
    'A1.jpeg',
  );

  const res = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  const body = (await res.json()) as Record<string, unknown>;

  check('request fails cleanly (not 200)', res.status >= 400, res.status);
  check(
    'error tells the device the scan was stored',
    String(body.message).toLowerCase().includes('stored'),
    body,
  );

  const row = getScan(id);
  check('THE SCAN SURVIVED — row exists', row !== undefined);
  check('row is queued as PENDING', row?.extraction_status === 'PENDING', row?.extraction_status);
  check('failure reason recorded', row?.extraction_fault_code === 'VISION_BAD_CREDENTIALS', row?.extraction_fault_code);
  check('images retained on disk', JSON.parse(row?.image_paths ?? '[]').length === 1);
  check(
    'photo file actually present',
    fs.existsSync(JSON.parse(row?.image_paths ?? '[]')[0] ?? ''),
  );

  // ------------------------------------------------------------------------
  section('Fault surfaced to the UI');
  const status = readStatus();
  check('vision is PAUSED', status.vision_state === 'PAUSED', status.vision_state);
  check('server state is BLOCKED', status.state === 'BLOCKED', status.state);
  check('active fault named', status.active_fault === 'VISION_BAD_CREDENTIALS', status.active_fault);

  const events = listOpenEvents();
  const credEvent = events.find((e) => e.code === 'VISION_BAD_CREDENTIALS');
  check('actionable event raised', credEvent !== undefined, events.map((e) => e.code));
  check('event carries severity', credEvent?.severity === 'CRITICAL', credEvent?.severity);
  check('VISION_PAUSED event raised', events.some((e) => e.code === 'VISION_PAUSED'));

  const dictionary = controlDb
    .prepare('SELECT * FROM message_dictionary WHERE code = ?')
    .get('VISION_BAD_CREDENTIALS') as { default_text: string; operator_hint: string } | undefined;
  check('code resolves in the dictionary', dictionary !== undefined);
  check('dictionary carries an operator hint', Boolean(dictionary?.operator_hint), dictionary);

  // ------------------------------------------------------------------------
  section('Retry storm does not flood the events table');
  for (let i = 0; i < 5; i += 1) {
    const f = new FormData();
    f.append('apparel_id', `DURABILITY-STORM-${i}`);
    f.append('username', 'emp_402');
    f.append('key_photo_index', '0');
    f.append(
      'images',
      new Blob([fs.readFileSync('../sample_photo/set00/A2.jpeg')], { type: 'image/jpeg' }),
      'A2.jpeg',
    );
    await fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: auth, body: f });
  }
  const afterStorm = listOpenEvents().filter((e) => e.code === 'VISION_BAD_CREDENTIALS');
  check('still exactly one open event', afterStorm.length === 1, afterStorm.length);
  check(
    'paused server stops calling the API entirely',
    afterStorm[0]?.occurrences === 1,
    afterStorm[0]?.occurrences,
  );
  check('but every storm scan was still stored', extractionCounts().pending >= 6, extractionCounts());

  // ------------------------------------------------------------------------
  section('Pause survives a restart (state is on disk, not in memory)');
  await new Promise<void>((r) => server.close(() => r()));
  // A fresh module-level read is what a restarted process would see.
  check('still paused after "restart"', readStatus().vision_state === 'PAUSED');
  check('isVisionPaused() agrees', isVisionPaused());

  const blockedDrain = await drainNow();
  check('drain refuses to run while paused', blockedDrain.skipped, blockedDrain);
  check('nothing was attempted', blockedDrain.attempted === 0, blockedDrain);

  // ------------------------------------------------------------------------
  section('Heartbeat gives the UI liveness + counters');
  publishHeartbeat();
  const beat = readStatus();
  check('heartbeat is recent', Date.now() - beat.heartbeat_at < 5_000, beat.heartbeat_at);
  check('queue depth published', beat.queue_pending >= 6, beat.queue_pending);
  check('flywheel capacity published', beat.flywheel_capacity === env.flywheelMaxRecords);

  // ------------------------------------------------------------------------
  section('Operator fixes the key and the backlog drains');
  // Exercise the real operator flow: edit the .env file, then press
  // "Settings updated" in the UI. The middleware re-reads .env — it does not
  // read the test's process.env — so this is the documented path, not a shortcut.
  const realKey = fs
    .readFileSync('../secrets.txt', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('gemini_api_key'))!
    .split('=')[1]!
    .trim();

  const envBackup = fs.readFileSync('.env', 'utf8');
  restoreEnvFile = () => fs.writeFileSync('.env', envBackup);
  fs.writeFileSync('.env', envBackup.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${realKey}`));

  issueCommand(UI_COMMANDS.VISION_SETTINGS_UPDATED, undefined, 'ui:operator_01');
  check('command is queued as PENDING', takePendingCommands().length === 1);

  processPendingCommands();

  check('vision resumed', !isVisionPaused());
  check('fault cleared', readStatus().active_fault === null, readStatus().active_fault);
  const doneCmd = controlDb
    .prepare('SELECT * FROM ui_commands ORDER BY id DESC LIMIT 1')
    .get() as { status: string; result_detail: string };
  check('command acknowledged as DONE', doneCmd.status === 'DONE', doneCmd);
  check('command carries a result for the UI', Boolean(doneCmd.result_detail), doneCmd);

  const drain = await drainNow();
  console.log(`  (drain: ${JSON.stringify(drain)})`);
  check('drain processed the backlog', drain.completed > 0, drain);

  const recovered = getScan(id);
  check('THE ORIGINAL SCAN COMPLETED', recovered?.extraction_status === 'COMPLETED', recovered?.extraction_status);
  const recoveredData = JSON.parse(recovered?.raw_json_data ?? '{}') as Record<
    string,
    { value: string; confidence: number }
  >;
  check('recovered scan has all 12 contract fields', Object.keys(recoveredData).length === 12);
  // A1.jpeg is a plain garment shot with no label in frame, so brand/price are
  // legitimately empty. What matters is that real extraction ran: at least one
  // field carries a value with non-zero confidence.
  const populated = Object.entries(recoveredData).filter(
    ([, field]) => field.value !== '' && field.confidence > 0,
  );
  check('recovered scan carries real extracted data', populated.length > 0, recoveredData);
  console.log(`  (recovered fields: ${populated.map(([k, v]) => `${k}=${v.value}`).join(', ')})`);

  // ------------------------------------------------------------------------
  section('Flywheel purge requires a watermark');
  // The drain above captured low-confidence scans; start this section clean so
  // the counts assert exactly what the purge did.
  flywheelDb.exec('DELETE FROM flywheel_training');
  insertFlywheelRecord({
    apparel_id: 'PURGE-A',
    key_photo_path: null,
    raw_images_paths: [],
    unconfirmed_gemini_json: {},
    lowest_confidence_score: 0.1,
  });
  const watermark = flywheelMaxRowId();
  insertFlywheelRecord({
    apparel_id: 'PURGE-B-NEWER',
    key_photo_path: null,
    raw_images_paths: [],
    unconfirmed_gemini_json: {},
    lowest_confidence_score: 0.1,
  });

  issueCommand(UI_COMMANDS.FLYWHEEL_DUMPED, {}, 'ui:operator_01');
  processPendingCommands();
  const rejected = controlDb
    .prepare('SELECT * FROM ui_commands ORDER BY id DESC LIMIT 1')
    .get() as { status: string };
  check('purge without watermark is REJECTED', rejected.status === 'REJECTED', rejected);
  check('nothing was destroyed', countFlywheelRecords() === 2, countFlywheelRecords());

  issueCommand(UI_COMMANDS.FLYWHEEL_DUMPED, { exported_through_id: watermark }, 'ui:operator_01');
  processPendingCommands();
  check('watermarked purge removed the exported sample', countFlywheelRecords() === 1);
  check(
    'sample captured AFTER the export survived',
    controlDb !== null &&
      (flywheelDb.prepare('SELECT apparel_id FROM flywheel_training').get() as { apparel_id: string })
        .apparel_id === 'PURGE-B-NEWER',
  );

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  restoreEnvFile?.();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  restoreEnvFile?.();
  process.exit(1);
});
