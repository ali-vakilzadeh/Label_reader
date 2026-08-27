/**
 * Covers:
 *   - operator changes the API key through the UI (validated before adoption)
 *   - a bad key is rejected and the previous one is kept
 *   - a missing key is reported, not silently tolerated, and never falls back
 *   - a device re-submitting a scan it already completed gets the stored result
 *     back instead of re-billing the vision API
 *   - a device that lost the response can fetch it later without re-uploading
 *
 * Usage: npx tsx tests/settingsAndDelivery.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';
process.env.RENDER_CRON_ENABLED = 'false';

import fs from 'node:fs';
import type { Server } from 'node:http';

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}
function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}
function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

async function main(): Promise<void> {
  const { controlDb, readStatus, listOpenEvents } = await import('../src/db/controlDb');
  const {
    submitPendingSettings,
    readVisionSettings,
    storedApiKey,
  } = await import('../src/db/visionSettings');
  const {
    startControlService,
    processPendingSettings,
    evaluateCredentialState,
    isVisionPaused,
  } = await import('../src/services/controlService');
  const { credentialSource, activeApiKey } = await import('../src/services/geminiService');
  const { createApp } = await import('../src/app');
  const { getScan } = await import('../src/db/operationalDb');
  const { env } = await import('../src/config/env');

  controlDb.exec(
    'DELETE FROM server_events; DELETE FROM ui_commands; DELETE FROM vision_settings_pending;',
  );
  controlDb.exec(
    "UPDATE vision_settings SET api_key_ciphertext=NULL, api_key_iv=NULL, api_key_tag=NULL, validation_status='UNSET' WHERE id=1",
  );

  startControlService();

  // ------------------------------------------------------------------------
  section('No key configured (item 3): reported, never silently tolerated');
  check('credential source is NONE', credentialSource() === 'NONE', credentialSource());
  check('active key is empty', activeApiKey() === '', activeApiKey());
  evaluateCredentialState();
  check('vision is PAUSED, waiting for a key', isVisionPaused());
  check(
    'VISION_NOT_CONFIGURED raised for the UI',
    listOpenEvents().some((e) => e.code === 'VISION_NOT_CONFIGURED'),
    listOpenEvents().map((e) => e.code),
  );

  // ------------------------------------------------------------------------
  section('Bad key submitted through the UI is rejected');
  submitPendingSettings('AIzaSyTOTALLY_INVALID_KEY_000', null, null, 'ui:operator_01');
  await processPendingSettings();

  const rejected = controlDb
    .prepare('SELECT * FROM vision_settings_pending ORDER BY id DESC LIMIT 1')
    .get() as { status: string; result_detail: string; api_key: string | null };
  check('submission REJECTED', rejected.status === 'REJECTED', rejected.status);
  check('rejection explains why', /VISION_BAD_CREDENTIALS/.test(rejected.result_detail), rejected);
  check('plaintext key erased after handling', rejected.api_key === null, rejected.api_key);
  check('no key was adopted', storedApiKey() === null);
  check('still paused', isVisionPaused());
  check(
    'operator told the submission failed',
    listOpenEvents().some((e) => e.code === 'VISION_SETTINGS_REJECTED'),
  );

  // ------------------------------------------------------------------------
  section('Good key submitted through the UI is validated and adopted');
  const realKey = fs
    .readFileSync('../secrets.txt', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('gemini_api_key'))!
    .split('=')[1]!
    .trim();

  submitPendingSettings(realKey, 'gemini-3.7-flash', null, 'ui:operator_01');
  await processPendingSettings();

  const applied = controlDb
    .prepare('SELECT * FROM vision_settings_pending ORDER BY id DESC LIMIT 1')
    .get() as { status: string; result_detail: string; api_key: string | null };

  const quotaBlocked = applied.status === 'REJECTED' && /RATE_LIMIT_DAY|BILLING/.test(applied.result_detail);

  if (quotaBlocked) {
    skip('key adopted', `account quota exhausted (${applied.result_detail})`);
    skip('vision resumed', 'depends on adoption');
  } else {
    check('submission APPLIED', applied.status === 'APPLIED', applied);
    check('plaintext key erased after adoption', applied.api_key === null);
    check('key retrievable by the middleware', storedApiKey() === realKey);
    check('credential source is now UI', credentialSource() === 'UI', credentialSource());
    check('vision resumed automatically', !isVisionPaused());
    check(
      'VISION_NOT_CONFIGURED cleared',
      !listOpenEvents().some((e) => e.code === 'VISION_NOT_CONFIGURED'),
    );
  }

  // ------------------------------------------------------------------------
  section('Encryption at rest (offline: no API probe involved)');
  const { applyVisionSettings } = await import('../src/db/visionSettings');
  const fakeKey = 'AIzaSyOFFLINE_ROUNDTRIP_TEST_KEY_12345';
  applyVisionSettings(fakeKey, 'gemini-3.7-flash', null, 'ui:offline_test');

  const offlineRow = readVisionSettings();
  check('key round-trips through encryption', storedApiKey() === fakeKey);
  check(
    'ciphertext does not contain the key',
    !JSON.stringify(offlineRow).includes(fakeKey),
    offlineRow.api_key_ciphertext?.slice(0, 24),
  );
  check(
    'fingerprint exposes only the last 4 chars',
    offlineRow.api_key_fingerprint === '****2345',
    offlineRow.api_key_fingerprint,
  );
  check('credential source becomes UI', credentialSource() === 'UI');
  check('stored key wins over the .env value', activeApiKey() === fakeKey);

  // Clear it again so the delivery section starts from a known state.
  controlDb.exec(
    "UPDATE vision_settings SET api_key_ciphertext=NULL, api_key_iv=NULL, api_key_tag=NULL, validation_status='UNSET' WHERE id=1",
  );
  check('cleared key does NOT fall back to a previous one', storedApiKey() === null);

  // ------------------------------------------------------------------------
  section('Key is encrypted at rest (a control.db reader cannot lift it)');
  const settings = readVisionSettings();
  if (settings.api_key_ciphertext) {
    check('ciphertext stored, not plaintext', !settings.api_key_ciphertext.includes(realKey));
    check('fingerprint shown for the UI', settings.api_key_fingerprint?.startsWith('****') === true, settings.api_key_fingerprint);
    check(
      'raw key appears nowhere in the settings row',
      !JSON.stringify(settings).includes(realKey),
    );
  } else {
    skip('encryption at rest', 'no key was adopted in this run');
  }

  // ------------------------------------------------------------------------
  section('Item 4B: device loses the response and re-submits');
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

  const id = 'DELIVERY-001';
  const photo = fs.readFileSync('../sample_photo/set00/A1.jpeg');
  const buildForm = () => {
    const form = new FormData();
    form.append('apparel_id', id);
    form.append('username', 'emp_402');
    form.append('key_photo_index', '0');
    form.append('images', new Blob([photo], { type: 'image/jpeg' }), 'A1.jpeg');
    return form;
  };

  const first = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: buildForm(),
  });
  const firstBody = (await first.json()) as Record<string, any>;

  if (first.status !== 200) {
    skip('duplicate submission replays the stored result', `first extraction unavailable (${firstBody.error_code})`);
    skip('result retrievable after a lost response', 'depends on a completed extraction');
    // The guarantee that still must hold:
    check('scan stored despite extraction failure', getScan(id) !== undefined);
  } else {
    const storedAfterFirst = getScan(id);
    check('first submission completed', storedAfterFirst?.extraction_status === 'COMPLETED');
    const attemptsBefore = storedAfterFirst?.extraction_attempts ?? 0;
    const completedAtBefore = storedAfterFirst?.completed_at;

    // The device never saw the response and sends the identical scan again.
    const second = await fetch(`${base}/api/v1/vision/extract`, {
      method: 'POST',
      headers: auth,
      body: buildForm(),
    });
    const secondBody = (await second.json()) as Record<string, any>;

    check('duplicate returns 200', second.status === 200, second.status);
    check(
      'duplicate returns the SAME data',
      JSON.stringify(secondBody.data) === JSON.stringify(firstBody.data),
      { first: firstBody.data?.color, second: secondBody.data?.color },
    );
    const storedAfterSecond = getScan(id);
    check(
      'stored result was NOT destroyed',
      storedAfterSecond?.extraction_status === 'COMPLETED',
      storedAfterSecond?.extraction_status,
    );
    check(
      'vision API was NOT called again',
      storedAfterSecond?.completed_at === completedAtBefore &&
        storedAfterSecond?.extraction_attempts === attemptsBefore,
      { before: completedAtBefore, after: storedAfterSecond?.completed_at },
    );

    // Recovery without re-uploading photos.
    const fetched = await fetch(`${base}/api/v1/vision/result/${id}`, { headers: auth });
    const fetchedBody = (await fetched.json()) as Record<string, any>;
    check('GET /vision/result returns 200', fetched.status === 200, fetched.status);
    check('reports extraction_status', fetchedBody.extraction_status === 'COMPLETED', fetchedBody.extraction_status);
    check(
      'returns the same data without re-uploading',
      JSON.stringify(fetchedBody.data) === JSON.stringify(firstBody.data),
    );
    check('carries the catalog URL', typeof fetchedBody.catalog_image_url === 'string');
  }

  // ------------------------------------------------------------------------
  // The replay decision happens BEFORE any vision call, so it is fully testable
  // without API quota: seed a completed scan whose digest matches the photo we
  // are about to re-send, then confirm the re-send is answered from store.
  section('Item 4B offline: replay is decided before any API call');
  const { digestImages } = await import('../src/services/storageService');
  const { upsertScan, completeExtraction } = await import('../src/db/operationalDb');
  const { emptyExtraction } = await import('../src/services/visionService');

  const offlineId = 'DELIVERY-OFFLINE-001';
  const knownDigest = digestImages([{ buffer: photo }]);
  const knownData = { ...emptyExtraction(), brand_name: { value: 'LIU JO', confidence: 0.99 } };

  upsertScan({
    apparel_id: offlineId,
    cloned_from: null,
    username: 'emp_402',
    timestamp: new Date().toISOString(),
    raw_json_data: JSON.stringify(emptyExtraction()),
    key_photo_path: '/tmp/x.jpg',
    image_paths: JSON.stringify(['/tmp/x.jpg']),
    catalog_image_url: 'http://localhost/catalog/IMG_offline.jpg',
    rendering_status: 'PENDING',
    extraction_status: 'PENDING',
    image_digest: knownDigest,
  });
  completeExtraction(offlineId, JSON.stringify(knownData));

  const seeded = getScan(offlineId);
  const seededCompletedAt = seeded?.completed_at;

  const offlineForm = new FormData();
  offlineForm.append('apparel_id', offlineId);
  offlineForm.append('username', 'emp_402');
  offlineForm.append('key_photo_index', '0');
  offlineForm.append('images', new Blob([photo], { type: 'image/jpeg' }), 'A1.jpeg');

  const replayed = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: offlineForm,
  });
  const replayedBody = (await replayed.json()) as Record<string, any>;

  check('duplicate answered 200 even with no usable API key', replayed.status === 200, replayedBody);
  check(
    'stored result replayed verbatim',
    replayedBody.data?.brand_name?.value === 'LIU JO',
    replayedBody.data?.brand_name,
  );
  const afterReplay = getScan(offlineId);
  check('result not overwritten', afterReplay?.extraction_status === 'COMPLETED');
  check('no new extraction attempt', afterReplay?.completed_at === seededCompletedAt);

  // A genuinely different photo set for the same id must NOT replay.
  const differentForm = new FormData();
  differentForm.append('apparel_id', offlineId);
  differentForm.append('username', 'emp_402');
  differentForm.append('key_photo_index', '0');
  differentForm.append(
    'images',
    new Blob([fs.readFileSync('../sample_photo/set00/A3.jpeg')], { type: 'image/jpeg' }),
    'A3.jpeg',
  );
  const rescan = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: differentForm,
  });
  check(
    're-scan with DIFFERENT photos is not replayed',
    rescan.status !== 200,
    rescan.status,
  );
  check(
    're-scan is queued for fresh extraction',
    getScan(offlineId)?.extraction_status === 'PENDING',
    getScan(offlineId)?.extraction_status,
  );

  const fetchedOffline = await fetch(`${base}/api/v1/vision/result/${offlineId}`, { headers: auth });
  const fetchedOfflineBody = (await fetchedOffline.json()) as Record<string, any>;
  check('result endpoint reports the queued state', fetchedOfflineBody.extraction_status === 'PENDING');

  const missing = await fetch(`${base}/api/v1/vision/result/NO-SUCH-SCAN`, { headers: auth });
  check('unknown id returns 404', missing.status === 404, missing.status);

  const unauth = await fetch(`${base}/api/v1/vision/result/${id}`);
  check('result endpoint requires auth', unauth.status === 401, unauth.status);

  await new Promise<void>((r) => server.close(() => r()));

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
