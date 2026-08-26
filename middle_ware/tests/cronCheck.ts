/**
 * Verifies the cron wiring: that the 20:00 expression is valid, that a
 * scheduled tick actually reaches runRenderJob, and that a record whose key
 * photo is missing on disk is marked FAILED rather than retried forever.
 *
 * Uses a one-second schedule so the test does not wait until 20:00.
 * Usage: npx tsx tests/cronCheck.ts
 */

// Set before any project module loads — env.ts snapshots process.env on import,
// so these must be dynamic imports, not top-level ones.
process.env.RENDER_CRON_ENABLED = 'true';
process.env.RENDER_CRON_SCHEDULE = '* * * * * *';
process.env.RENDER_CRON_TIMEZONE = 'UTC';
process.env.GEMINI_API_KEY = 'test-key-so-the-job-is-not-skipped';

async function main(): Promise<void> {
  const cron = (await import('node-cron')).default;
  console.log(`cron.validate("0 20 * * *") -> ${cron.validate('0 20 * * *')}`);
  console.log(`cron.validate("bogus")      -> ${cron.validate('bogus')}`);

  const { startCronService, stopCronService } = await import('../src/services/cronService');
  const { upsertScan, getScan } = await import('../src/db/operationalDb');

  // A record whose key photo is absent must end FAILED with the attempt counted.
  const id = 'CRON-TEST-0001';
  upsertScan({
    apparel_id: id,
    cloned_from: null,
    username: 'emp_test',
    timestamp: new Date().toISOString(),
    raw_json_data: '{}',
    key_photo_path: 'C:/does/not/exist/IMG_missing.jpg',
    image_paths: '[]',
    catalog_image_url: 'http://localhost/catalog/IMG_CRON-TEST-0001.jpg',
    rendering_status: 'PENDING',
  });

  startCronService();
  await new Promise((resolve) => setTimeout(resolve, 3500));
  stopCronService();

  const after = getScan(id);
  console.log(`\nstatus after tick : ${after?.rendering_status}`);
  console.log(`render_attempts   : ${after?.render_attempts}`);
  console.log(`render_error      : ${after?.render_error}`);

  const ok = after?.rendering_status === 'FAILED' && (after?.render_attempts ?? 0) >= 1;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} — cron tick reached the render job`);
  process.exit(ok ? 0 : 1);
}

void main();
