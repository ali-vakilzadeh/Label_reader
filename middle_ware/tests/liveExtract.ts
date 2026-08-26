/**
 * Live Gemini verification. Boots the real app and pushes real sample photos
 * through POST /api/v1/vision/extract, so the SDK call, the structured-output
 * schema, weight folding, fuzzy snapping and flywheel screening are all
 * exercised against an actual model response.
 *
 * Requires GEMINI_API_KEY. Usage:
 *   npx tsx tests/liveExtract.ts <image...>
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { getScan } from '../src/db/operationalDb';
import { findSample } from '../src/services/flywheelService';
import { buildBilingualExport } from '../src/services/exportService';
import { env } from '../src/config/env';
import type { ExtractedData } from '../src/types';

async function main(): Promise<void> {
  if (!env.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set. Aborting live test.');
    process.exit(1);
  }

  const images = process.argv.slice(2);
  if (images.length === 0) {
    console.error('Pass at least one image path.');
    process.exit(1);
  }

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emp_402', password: env.masterPassword }),
  });
  const { token } = (await login.json()) as { token: string };

  const apparelId = '40000000857';
  const form = new FormData();
  form.append('apparel_id', apparelId);
  form.append('username', 'emp_402');
  form.append('key_photo_index', '0');
  for (const image of images) {
    const buffer = fs.readFileSync(image);
    form.append('images', new Blob([buffer], { type: 'image/jpeg' }), path.basename(image));
  }

  console.log(`\nSending ${images.length} image(s) to ${env.geminiVisionModel}...`);
  const started = Date.now();
  const response = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const elapsed = Date.now() - started;
  const body = (await response.json()) as Record<string, any>;

  console.log(`HTTP ${response.status} in ${elapsed} ms\n`);
  if (response.status !== 200) {
    console.error(body);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(1);
  }

  console.log(`apparel_id        : ${body.apparel_id}`);
  console.log(`cloned_from       : ${body.cloned_from}`);
  console.log(`timestamp         : ${body.timestamp}`);
  console.log(`catalog_image_url : ${body.catalog_image_url}\n`);

  const data = body.data as ExtractedData;
  console.log('field                 value                                    conf   flag');
  console.log('-'.repeat(78));
  for (const [field, entry] of Object.entries(data)) {
    const flag = entry.confidence < env.flywheelConfidenceThreshold ? 'LOW' : '';
    console.log(
      `${field.padEnd(21)} ${String(entry.value).slice(0, 40).padEnd(40)} ${entry.confidence
        .toFixed(2)
        .padStart(5)}  ${flag}`,
    );
  }

  // --- persistence checks ---------------------------------------------------
  console.log('\n-- persistence --');
  const scan = getScan(apparelId);
  console.log(`server_scans row      : ${scan ? 'present' : 'MISSING'}`);
  console.log(`rendering_status      : ${scan?.rendering_status}`);
  console.log(`key_photo_path        : ${scan?.key_photo_path}`);
  console.log(`stored image count    : ${JSON.parse(scan?.image_paths ?? '[]').length}`);

  const sample = findSample(apparelId);
  console.log(
    `flywheel capture      : ${sample ? `YES (lowest ${sample.lowest_confidence_score})` : 'no (all fields above threshold)'}`,
  );

  // --- bilingual export -----------------------------------------------------
  const bilingual = buildBilingualExport(apparelId, data);
  console.log('\n-- Armenian legal export --');
  for (const field of ['category', 'sub_category', 'color', 'country_of_origin', 'material'] as const) {
    const entry = bilingual.fields[field];
    console.log(`${field.padEnd(21)} ${entry.value_en.padEnd(28)} -> ${entry.value_hy || '(unmapped)'}`);
  }
  if (bilingual.missing_translations.length > 0) {
    console.log(`unmapped terms        : ${bilingual.missing_translations.join(', ')}`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
