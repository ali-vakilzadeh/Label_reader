/**
 * End-to-end smoke test. Boots the real app on an ephemeral port and exercises
 * every endpoint plus the flywheel ring buffer and the pure business rules.
 *
 * Usage: npx tsx tests/smoke.ts
 */
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { upsertScan } from '../src/db/operationalDb';
import {
  flywheelDb,
  insertFlywheelRecord,
  getFlywheelRecord,
  enforceRingBuffer,
} from '../src/db/flywheelDb';
import { normalizeExtraction } from '../src/services/visionService';
import { screenConfidence } from '../src/services/flywheelService';
import { resolveWeights } from '../src/utils/weights';
import { SYSTEM_INSTRUCTION, EXTRACTION_SCHEMA } from '../src/services/geminiService';
import type { GeminiRawExtraction } from '../src/types';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : detail);
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

const cf = (value: string, confidence: number) => ({ value, confidence });

function formData(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

function sampleGemini(overrides: { genderConf?: number } = {}): GeminiRawExtraction {
  return {
    brand_name: cf('Nike', 0.95),
    country_of_origin: cf('Made in Viet Nam', 0.88),
    size: cf('XL', 0.9),
    color: cf('Navy Blue', 0.92),
    material: cf('100% Polyester', 0.88),
    original_price: cf('$45.00', 0.99),
    category: cf('clothing', 0.9),
    sub_category: cf('Trousers', 0.87),
    gender: cf('unisex', overrides.genderConf ?? 0.9),
    season: cf('all-seasons', 0.88),
    weights: [cf('290g', 0.86), cf('240g', 0.86)],
  };
}

async function main(): Promise<void> {
  // Isolate this run from any real training data.
  flywheelDb.exec('DELETE FROM flywheel_training');

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  // ---------------------------------------------------------------- health
  section('GET /health');
  const health = await fetch(`${base}/health`);
  const healthBody = (await health.json()) as Record<string, unknown>;
  check('returns 200', health.status === 200, health.status);
  check('status is ok', healthBody.status === 'ok', healthBody);
  check('reports uptime_seconds', typeof healthBody.uptime_seconds === 'number', healthBody);

  // ------------------------------------------------------------------ auth
  section('POST /api/v1/auth/login');
  const badLogin = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emp_402', password: 'wrong' }),
  });
  check('rejects wrong password with 401', badLogin.status === 401, badLogin.status);
  const badBody = (await badLogin.json()) as Record<string, unknown>;
  check('error envelope shape', badBody.status === 'error' && !!badBody.error_code, badBody);

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emp_402', password: process.env.APP_MASTER_PASSWORD }),
  });
  const loginBody = (await login.json()) as { status: string; token: string; expires_in: string };
  check('accepts correct password', login.status === 200, login.status);
  check('issues a JWT', typeof loginBody.token === 'string' && loginBody.token.length > 20);
  check('expires_in is 30d', loginBody.expires_in === '30d', loginBody.expires_in);
  const auth = { Authorization: `Bearer ${loginBody.token}` };

  // ------------------------------------------------------------ auth guard
  section('Auth guard on /vision/extract');
  const noAuth = await fetch(`${base}/api/v1/vision/extract`, { method: 'POST' });
  check('401 without a token', noAuth.status === 401, noAuth.status);

  const badToken = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not.a.real.token' },
  });
  check('401 with an invalid token', badToken.status === 401, badToken.status);

  // --------------------------------------------------------- extract rules
  section('POST /api/v1/vision/extract - validation');
  const noImages = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: formData({ apparel_id: 'BAR-1', username: 'emp_402', key_photo_index: '0' }),
  });
  const noImagesBody = (await noImages.json()) as Record<string, unknown>;
  check('400 when no images and no cloned_from', noImages.status === 400, noImages.status);
  check(
    'error_code is INVALID_IMAGE_PAYLOAD',
    noImagesBody.error_code === 'INVALID_IMAGE_PAYLOAD',
    noImagesBody,
  );

  const noId = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: formData({ username: 'emp_402', key_photo_index: '0', cloned_from: 'X' }),
  });
  check('400 when apparel_id is missing', noId.status === 400, noId.status);

  // -------------------------------------------------------------- cloning
  section('Cloning workflow (Gemini bypassed)');
  const parentData = normalizeExtraction(sampleGemini());
  upsertScan({
    apparel_id: '890123456789',
    cloned_from: null,
    username: 'emp_402',
    timestamp: new Date().toISOString(),
    raw_json_data: JSON.stringify(parentData),
    key_photo_path: '/tmp/IMG_890123456789_0.jpg',
    image_paths: JSON.stringify(['/tmp/IMG_890123456789_0.jpg']),
    catalog_image_url: 'http://localhost/catalog/IMG_890123456789.jpg',
    rendering_status: 'PENDING',
    extraction_status: 'COMPLETED',
  });

  const clone = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: formData({
      apparel_id: '890123456790',
      username: 'emp_402',
      key_photo_index: '0',
      cloned_from: '890123456789',
    }),
  });
  const cloneBody = (await clone.json()) as Record<string, any>;
  // api_contract.md v1.1: every accepted submission answers 202, including clones.
  check('clone returns 202 with no images uploaded', clone.status === 202, cloneBody);
  check(
    'clone is immediately READY_TO_CONFIRM',
    cloneBody.processing_status === 'READY_TO_CONFIRM',
    cloneBody.processing_status,
  );
  check('cloned_from is echoed', cloneBody.cloned_from === '890123456789', cloneBody.cloned_from);
  check('apparel_id is the new child id', cloneBody.apparel_id === '890123456790');
  check(
    'catalog URL is pre-generated for the child',
    cloneBody.catalog_image_url === 'http://localhost:4311/catalog/IMG_890123456790.jpg',
    cloneBody.catalog_image_url,
  );
  check(
    'parent field values are rebound',
    cloneBody.data?.brand_name?.value === 'Nike' && cloneBody.data?.size?.value === 'XL',
    cloneBody.data,
  );
  check(
    'all 12 contract fields present',
    Object.keys(cloneBody.data ?? {}).length === 12,
    Object.keys(cloneBody.data ?? {}),
  );

  const orphan = await fetch(`${base}/api/v1/vision/extract`, {
    method: 'POST',
    headers: auth,
    body: formData({
      apparel_id: 'BAR-ORPHAN',
      username: 'emp_402',
      key_photo_index: '0',
      cloned_from: 'DOES-NOT-EXIST',
    }),
  });
  check('404 when the parent record is unknown', orphan.status === 404, orphan.status);

  // ------------------------------------------------------ flywheel confirm
  section('PUT /api/v1/flywheel/confirm/:apparel_id');
  const lowConfidence = normalizeExtraction(sampleGemini({ genderConf: 0.4 }));
  insertFlywheelRecord({
    apparel_id: '890123456789',
    key_photo_path: '/tmp/IMG_890123456789_0.jpg',
    raw_images_paths: ['/tmp/IMG_890123456789_0.jpg'],
    unconfirmed_gemini_json: { normalized: lowConfidence },
    lowest_confidence_score: 0.4,
  });

  const confirm = await fetch(`${base}/api/v1/flywheel/confirm/890123456789`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { gender: 'female', brand_name: 'Nike' } }),
  });
  check('confirm returns 200', confirm.status === 200, await confirm.clone().text());
  const stored = getFlywheelRecord('890123456789');
  const confirmed = stored?.confirmed_json ? JSON.parse(stored.confirmed_json) : null;
  check('ground truth persisted to flywheel.db', confirmed?.gender?.value === 'female', confirmed);
  check('confirmed_at timestamp set', typeof stored?.confirmed_at === 'number', stored?.confirmed_at);

  const missingSample = await fetch(`${base}/api/v1/flywheel/confirm/NOPE`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { gender: 'female' } }),
  });
  check('404 for an unknown sample', missingSample.status === 404, missingSample.status);

  const stats = await fetch(`${base}/api/v1/flywheel/stats`, { headers: auth });
  const statsBody = (await stats.json()) as Record<string, unknown>;
  check('stats reports capacity 10000', statsBody.capacity === 10000, statsBody);
  check('stats reports threshold 0.85', statsBody.threshold === 0.85, statsBody);

  // ----------------------------------------------------------- 404 handler
  section('Unknown route');
  const unknown = await fetch(`${base}/api/v1/nope`, { headers: auth });
  check('404 envelope', unknown.status === 404, unknown.status);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // ------------------------------------------------------- pure unit checks
  section('Weight rule');
  const two = resolveWeights([cf('290g', 0.8), cf('240g', 0.82)]);
  check('2 weights: max -> brutto', two.brutto.value === '290g', two);
  check('2 weights: min -> netto', two.netto.value === '240g', two);

  const twoMixed = resolveWeights([cf('1.2 kg', 0.7), cf('950g', 0.7)]);
  check('unit-aware comparison (1.2kg > 950g)', twoMixed.brutto.value === '1.2 kg', twoMixed);

  const one = resolveWeights([cf('500g', 0.6)]);
  check('1 weight: netto == brutto', one.netto.value === '500g' && one.brutto.value === '500g');

  const none = resolveWeights([]);
  check(
    '0 weights: empty string at 0.0 confidence',
    none.netto.value === '' && none.netto.confidence === 0 && none.brutto.confidence === 0,
    none,
  );

  section('Normalisation: reported fields matched, constrained fields passed through');
  const normalized = normalizeExtraction(sampleGemini());
  // REPORTED -> replaced with a client table entry
  check('country matched locally', normalized.country_of_origin.value === 'VIETNAM', normalized.country_of_origin);
  check('sub_category matched locally', normalized.sub_category.value === 'Trousers', normalized.sub_category);
  check('brand matched locally', normalized.brand_name.value === 'Nike', normalized.brand_name);
  // CONSTRAINED -> used exactly as the model returned it
  check('color used as returned', normalized.color.value === 'Navy Blue', normalized.color);
  check('confidence preserved', normalized.color.confidence === 0.92);

  section('Prompt / taxonomy coupling');
  const subCategoryKeys = (
    require('../src/data/taxonomy/subCategories.json') as string[]
  );
  // Long tables must NEVER reach the model: the client's 295 sub-categories and
  // 839 brands would bloat every request and push the model toward guessing a
  // listed option instead of reading the label.
  check(
    'long sub_category table is NOT in the system instruction',
    !subCategoryKeys.some((key) => key.length > 6 && SYSTEM_INSTRUCTION.includes(key)),
    subCategoryKeys.filter((k) => k.length > 6 && SYSTEM_INSTRUCTION.includes(k)).slice(0, 3),
  );
  check(
    'long sub_category table is NOT in the response schema',
    !subCategoryKeys.some(
      (key) => key.length > 6 && JSON.stringify(EXTRACTION_SCHEMA).includes(key),
    ),
  );
  // Short enums still are, so the model can choose from them.
  const enumData = require('../src/data/taxonomy/enums.json') as {
    color: string[];
    gender: string[];
    season: string[];
  };
  check(
    'every colour is offered to the model',
    enumData.color.every((c) => SYSTEM_INSTRUCTION.includes(c)),
    enumData.color.filter((c) => !SYSTEM_INSTRUCTION.includes(c)),
  );
  check(
    'every gender is offered to the model',
    enumData.gender.every((g) => SYSTEM_INSTRUCTION.includes(g)),
  );
  check(
    'every season is offered to the model',
    enumData.season.every((s2) => SYSTEM_INSTRUCTION.includes(s2)),
  );

  section('Confidence screening');
  const high = screenConfidence(normalizeExtraction(sampleGemini()));
  check('all-high payload is not intercepted', high.belowThreshold === false, high);
  const low = screenConfidence(normalizeExtraction(sampleGemini({ genderConf: 0.4 })));
  check('low field triggers interception', low.belowThreshold === true, low);
  check('weakest field identified', low.lowestField === 'gender', low);

  section('Flywheel FIFO ring buffer');
  flywheelDb.exec('DELETE FROM flywheel_training');
  const CAP = 25;
  const idFor = (i: number) => `RING-${String(i).padStart(4, '0')}`;
  for (let i = 0; i < CAP + 10; i += 1) {
    insertFlywheelRecord({
      apparel_id: idFor(i),
      key_photo_path: null,
      raw_images_paths: [],
      unconfirmed_gemini_json: { i },
      lowest_confidence_score: 0.1,
    });
    // Force a strictly increasing created_at so FIFO order is unambiguous
    // without sleeping between inserts.
    flywheelDb
      .prepare('UPDATE flywheel_training SET created_at = ? WHERE apparel_id = ?')
      .run(1_000_000 + i, idFor(i));
    enforceRingBuffer(CAP);
  }
  const total = (
    flywheelDb.prepare('SELECT COUNT(*) AS n FROM flywheel_training').get() as { n: number }
  ).n;
  check(`buffer capped at ${CAP}`, total === CAP, total);
  check('oldest record evicted', getFlywheelRecord(idFor(0)) === undefined);
  check('newest record retained', getFlywheelRecord(idFor(CAP + 9)) !== undefined);
  flywheelDb.exec('DELETE FROM flywheel_training');

  // NOTE: the bilingual Armenian export moved out of scope — Armenian text and
  // the numeric ids are dashboard concerns now (see dev_report.md §24). The
  // reference tables carrying them live in reference_data/*.csv.

  // ------------------------------------------------------------------ result
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
