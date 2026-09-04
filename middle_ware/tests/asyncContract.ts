/**
 * Asserts api_contract.md v1.1 exactly as an Android client would read it.
 *
 * Runs with NO usable API key, which is the point: pure async means the submit
 * path must behave identically whether the AI is reachable or not.
 *
 * Usage: npx tsx tests/asyncContract.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';
process.env.RENDER_CRON_ENABLED = 'false';
process.env.VISION_SECONDS_PER_ITEM = '5';

import fs from 'node:fs';
import type { Server } from 'node:http';

let passed = 0;
let failed = 0;

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

const CONTRACT_FIELDS = [
  'status',
  'apparel_id',
  'cloned_from',
  'timestamp',
  'catalog_image_url',
  'processing_status',
  'queue_depth',
  'estimated_wait_seconds',
  'retry_after_seconds',
  'blocking_fault',
  'data',
];

async function main(): Promise<void> {
  const { controlDb } = await import('../src/db/controlDb');
  const { operationalDb, upsertScan, completeExtraction, failExtraction } = await import(
    '../src/db/operationalDb'
  );
  const { createApp } = await import('../src/app');
  const { env } = await import('../src/config/env');
  const { emptyExtraction } = await import('../src/services/visionService');

  controlDb.exec('DELETE FROM server_events; DELETE FROM ui_commands;');
  operationalDb.exec('DELETE FROM server_scans');

  // Earlier suites in a chained run may leave the control DB paused (they boot
  // without a key). Start from a known-running state so the queue-hint
  // assertions below measure what they claim to measure.
  const { setServerState } = await import('../src/db/controlDb');
  setServerState('OK', 'OK', null, null);

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

  const photo = fs.readFileSync('../sample_photo/set00/A1.jpeg');
  const photoB = fs.readFileSync('../sample_photo/set00/A3.jpeg');
  const form = (id: string, buf: Buffer, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.append('apparel_id', id);
    f.append('username', 'emp_402');
    f.append('key_photo_index', '0');
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    f.append('images', new Blob([buf], { type: 'image/jpeg' }), 'p.jpg');
    return f;
  };
  const post = (body: FormData) =>
    fetch(`${base}/api/v1/vision/extract`, { method: 'POST', headers: auth, body });

  // ---------------------------------------------------------------- §4.2 ---
  section('§4.2 submit returns 202 immediately, even with no API key');
  const started = Date.now();
  const first = await post(form('ASYNC-001', photo));
  const elapsed = Date.now() - started;
  const body = (await first.json()) as Record<string, any>;

  check('HTTP 202 Accepted', first.status === 202, first.status);
  check('returns fast (no AI wait)', elapsed < 3000, `${elapsed} ms`);
  check('status is success', body.status === 'success', body.status);
  check('processing_status is PENDING_AI', body.processing_status === 'PENDING_AI', body.processing_status);
  check('data is null while pending', body.data === null, body.data);
  for (const field of CONTRACT_FIELDS) {
    check(`contract field "${field}" present`, field in body, Object.keys(body));
  }
  check('catalog_image_url is deterministic',
    body.catalog_image_url.endsWith('/catalog/IMG_ASYNC-001.jpg'), body.catalog_image_url);

  section('§4.2 polling hints');
  check('queue_depth is a number', typeof body.queue_depth === 'number', body.queue_depth);
  check('retry_after_seconds present', typeof body.retry_after_seconds === 'number');
  check('retry_after_seconds >= floor',
    body.retry_after_seconds >= env.pollRetryMinSeconds, body.retry_after_seconds);
  check('retry_after_seconds <= ceiling',
    body.retry_after_seconds <= env.pollRetryMaxSeconds, body.retry_after_seconds);

  // Queue several more so the depth-based estimate is exercised.
  for (const id of ['ASYNC-002', 'ASYNC-003', 'ASYNC-004']) await post(form(id, photo));
  const deeper = (await (await post(form('ASYNC-005', photo))).json()) as Record<string, any>;
  check('queue_depth grows with the backlog', deeper.queue_depth >= 4, deeper.queue_depth);
  check(
    'estimated_wait_seconds = depth x seconds_per_item',
    deeper.estimated_wait_seconds === deeper.queue_depth * 5,
    { depth: deeper.queue_depth, est: deeper.estimated_wait_seconds },
  );

  // ------------------------------------------------------- storage invariant
  section('§2 storage invariant: 2xx means stored');
  const stored = await fetch(`${base}/api/v1/vision/result/ASYNC-001`, { headers: auth });
  check('a 202-accepted scan is retrievable', stored.status === 200, stored.status);

  section('§2 4xx means NOT stored');
  const noImages = new FormData();
  noImages.append('apparel_id', 'ASYNC-NOPE');
  noImages.append('username', 'emp_402');
  noImages.append('key_photo_index', '0');
  const rejected = await post(noImages);
  check('missing images -> 400', rejected.status === 400, rejected.status);
  const shouldMiss = await fetch(`${base}/api/v1/vision/result/ASYNC-NOPE`, { headers: auth });
  check('nothing was stored for it', shouldMiss.status === 404, shouldMiss.status);

  // ---------------------------------------------------------------- §4.3 ---
  section('§4.3 single result reflects lifecycle');
  const pending = (await (
    await fetch(`${base}/api/v1/vision/result/ASYNC-001`, { headers: auth })
  ).json()) as Record<string, any>;
  check('PENDING_AI while queued', pending.processing_status === 'PENDING_AI', pending.processing_status);
  check('data null while queued', pending.data === null);
  check('attention_reason null while queued', pending.attention_reason === null);

  completeExtraction(
    'ASYNC-001',
    JSON.stringify({ ...emptyExtraction(), brand_name: { value: 'LIU JO', confidence: 0.99 } }),
  );
  const ready = (await (
    await fetch(`${base}/api/v1/vision/result/ASYNC-001`, { headers: auth })
  ).json()) as Record<string, any>;
  check('READY_TO_CONFIRM once extracted', ready.processing_status === 'READY_TO_CONFIRM');
  check('data present when ready', ready.data?.brand_name?.value === 'LIU JO', ready.data?.brand_name);
  check('all 12 fields returned', Object.keys(ready.data).length === 12, Object.keys(ready.data).length);
  check('terminal state reports no wait', ready.estimated_wait_seconds === 0, ready.estimated_wait_seconds);

  failExtraction('ASYNC-002', 'PARKED', 'VISION_REQUEST_REJECTED', 'Images unreadable.', null);
  const parked = (await (
    await fetch(`${base}/api/v1/vision/result/ASYNC-002`, { headers: auth })
  ).json()) as Record<string, any>;
  check('NEEDS_ATTENTION when parked', parked.processing_status === 'NEEDS_ATTENTION');
  check('attention_reason explains why', parked.attention_reason === 'Images unreadable.', parked.attention_reason);
  check('data null when parked', parked.data === null);

  // ---------------------------------------------------------------- §4.4 ---
  section('§4.4 batch results');
  const batchRes = await fetch(
    `${base}/api/v1/vision/results?ids=ASYNC-001,ASYNC-002,ASYNC-003,GHOST-999`,
    { headers: auth },
  );
  const batch = (await batchRes.json()) as Record<string, any>;
  check('HTTP 200', batchRes.status === 200, batchRes.status);
  check('returns the three known scans', batch.results.length === 3, batch.results.length);
  check('unknown id reported, not fatal', batch.not_found.includes('GHOST-999'), batch.not_found);
  check('carries queue_depth', typeof batch.queue_depth === 'number');
  check('carries retry_after_seconds', typeof batch.retry_after_seconds === 'number');
  const byId = Object.fromEntries(batch.results.map((r: any) => [r.apparel_id, r]));
  check('mixed states in one batch',
    byId['ASYNC-001'].processing_status === 'READY_TO_CONFIRM' &&
      byId['ASYNC-002'].processing_status === 'NEEDS_ATTENTION' &&
      byId['ASYNC-003'].processing_status === 'PENDING_AI',
    Object.entries(byId).map(([k, v]: any) => `${k}=${v.processing_status}`),
  );
  check('batch entries carry the full contract shape',
    CONTRACT_FIELDS.every((f) => f in byId['ASYNC-001']),
    Object.keys(byId['ASYNC-001']));

  const empty = await fetch(`${base}/api/v1/vision/results`, { headers: auth });
  check('no ids -> 400 MISSING_IDS', empty.status === 400, empty.status);
  const tooMany = await fetch(
    `${base}/api/v1/vision/results?ids=${Array.from({ length: 101 }, (_, i) => `X${i}`).join(',')}`,
    { headers: auth },
  );
  check('over the batch limit -> 400', tooMany.status === 400, tooMany.status);
  const unauth = await fetch(`${base}/api/v1/vision/results?ids=ASYNC-001`);
  check('batch requires auth', unauth.status === 401, unauth.status);

  // ------------------------------------------------------------ idempotency
  section('Duplicate submission replays state, never re-queues');
  const dupOfReady = (await (await post(form('ASYNC-001', photo))).json()) as Record<string, any>;
  check('duplicate of a ready scan returns READY_TO_CONFIRM',
    dupOfReady.processing_status === 'READY_TO_CONFIRM', dupOfReady.processing_status);
  check('duplicate returns the stored data',
    dupOfReady.data?.brand_name?.value === 'LIU JO', dupOfReady.data?.brand_name);

  const dupOfParked = (await (await post(form('ASYNC-002', photo))).json()) as Record<string, any>;
  check('duplicate of a parked scan stays NEEDS_ATTENTION',
    dupOfParked.processing_status === 'NEEDS_ATTENTION', dupOfParked.processing_status);

  const rescan = (await (await post(form('ASYNC-001', photoB))).json()) as Record<string, any>;
  check('different photos re-queue as a genuine re-scan',
    rescan.processing_status === 'PENDING_AI', rescan.processing_status);

  // ------------------------------------------------------------------ clone
  section('Cloning is ready immediately');
  completeExtraction(
    'ASYNC-003',
    JSON.stringify({ ...emptyExtraction(), brand_name: { value: 'Nike', confidence: 0.95 } }),
  );
  const cloneRes = await post(form('ASYNC-CLONE', photo, { cloned_from: 'ASYNC-003' }));
  const clone = (await cloneRes.json()) as Record<string, any>;
  check('clone answers 202 like everything else', cloneRes.status === 202, cloneRes.status);
  check('clone is READY_TO_CONFIRM', clone.processing_status === 'READY_TO_CONFIRM');
  check('clone carries inherited data', clone.data?.brand_name?.value === 'Nike');
  check('clone echoes cloned_from', clone.cloned_from === 'ASYNC-003', clone.cloned_from);

  const orphan = await post(form('ASYNC-ORPHAN', photo, { cloned_from: 'DOES-NOT-EXIST' }));
  check('unknown parent -> 404', orphan.status === 404, orphan.status);

  // ------------------------------------------------------------------ pause
  section('Paused processing: still 202, no misleading estimate');
  setServerState('BLOCKED', 'PAUSED', 'VISION_BILLING_REQUIRED', 'Billing needs checking.');

  const whilePaused = (await (await post(form('ASYNC-PAUSED', photo))).json()) as Record<string, any>;
  check('still accepted while paused', whilePaused.processing_status === 'PENDING_AI');
  check('estimated_wait_seconds is null (no honest estimate)',
    whilePaused.estimated_wait_seconds === null, whilePaused.estimated_wait_seconds);
  check('blocking_fault surfaced to the device',
    whilePaused.blocking_fault === 'VISION_BILLING_REQUIRED', whilePaused.blocking_fault);
  check('polls at the ceiling while paused',
    whilePaused.retry_after_seconds === env.pollRetryMaxSeconds, whilePaused.retry_after_seconds);
  const pausedStored = await fetch(`${base}/api/v1/vision/result/ASYNC-PAUSED`, { headers: auth });
  check('scan stored despite the pause', pausedStored.status === 200, pausedStored.status);

  setServerState('OK', 'OK', null, null);

  section('A missing status row self-heals instead of 500ing');
  controlDb.exec('DELETE FROM server_status');
  const afterWipe = await post(form('ASYNC-NOSTATUS', photo));
  check('submission still succeeds', afterWipe.status === 202, afterWipe.status);
  const statusRow = controlDb.prepare('SELECT COUNT(*) AS n FROM server_status').get() as {
    n: number;
  };
  check('status row was recreated', statusRow.n === 1, statusRow);

  // ----------------------------------------------------------------- health
  section('§4.5 health advertises the contract revision');
  const health = (await (await fetch(`${base}/health`)).json()) as Record<string, any>;
  check('api_contract is 1.3', health.api_contract === '1.3', health.api_contract);
  check('gemini_ready reported', typeof health.gemini_ready === 'boolean');

  // --------------------------------------------------- safety hardening ---
  // Runs LAST: closing control.db cannot be undone in-process.
  //
  // The polling hints are read AFTER the scan is committed. If that read fails,
  // the scan is already safe — so the response must still be 2xx. A 5xx here
  // would tell the device to resend something the server already holds, which is
  // exactly what api_contract.md §2 forbids.
  section('Advisory hints can fail without breaking the storage invariant');
  controlDb.close();

  const duringFailure = await post(form('ASYNC-HINTFAIL', photo));
  const hintBody = (await duringFailure.json()) as Record<string, any>;
  check('still 202 when hints are unavailable', duringFailure.status === 202, duringFailure.status);
  check(
    'still reports PENDING_AI',
    hintBody.processing_status === 'PENDING_AI',
    hintBody.processing_status,
  );
  check(
    'degrades to a conservative poll interval',
    hintBody.retry_after_seconds === env.pollRetryMaxSeconds,
    hintBody.retry_after_seconds,
  );
  const hintStored = await fetch(`${base}/api/v1/vision/result/ASYNC-HINTFAIL`, { headers: auth });
  check('and the scan really was stored', hintStored.status === 200, hintStored.status);

  await new Promise<void>((r) => server.close(() => r()));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
