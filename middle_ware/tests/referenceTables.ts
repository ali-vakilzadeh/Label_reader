/**
 * The bilingual reference-table channel.
 *
 * Covers the three things that must hold for an Armenian operator experience
 * built on lookup rather than translation:
 *
 *   1. `GET /api/v1/reference-tables` publishes English keys with their Armenian
 *      labels, ETagged so a device that is current gets a 304.
 *   2. The middleware still stores and emits **English only** in scan data —
 *      serving Armenian must not leak Armenian into the extraction path.
 *   3. Supervisor decisions arriving over control.db are validated, applied to
 *      the CSV additively, and a rejection writes nothing.
 *
 * The suite writes to the real reference_data/*.csv, so every file it touches is
 * captured byte-for-byte on entry and restored in a finally. A failure must not
 * leave the client's tables modified.
 *
 * Usage: npx tsx tests/referenceTables.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.RENDER_CRON_ENABLED = 'false';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';

import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

export {};

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

async function main(): Promise<void> {
  const { createApp } = await import('../src/app');
  const {
    REFERENCE_DIR,
    REFERENCE_FILES,
    REFERENCE_TABLE_NAMES,
    parseCsv,
    serialiseCsv,
    referenceEntries,
    referenceVersion,
  } = await import('../src/data/referenceTables');
  const { applyReferenceRequest, referenceCatalogue, reloadReferenceData, referenceStatus } =
    await import('../src/services/referenceService');
  const { normalizeExtraction } = await import('../src/services/visionService');
  const { buildSystemInstruction } = await import('../src/services/geminiService');
  const { subCategoryIndex, colorIndex } = await import('../src/utils/fuzzyMatcher');

  // Snapshot every table so the suite can put the client's files back exactly.
  const snapshots = new Map<string, Buffer>();
  for (const name of REFERENCE_TABLE_NAMES) {
    const file = path.join(REFERENCE_DIR, REFERENCE_FILES[name].file);
    snapshots.set(file, fs.readFileSync(file));
  }

  const restore = (): void => {
    for (const [file, bytes] of snapshots) fs.writeFileSync(file, bytes);
  };

  try {
    // --------------------------------------------------------------------
    section('CSV round-trip is byte-identical');
    // The writer rewrites whole files. If serialising what was parsed does not
    // reproduce the original bytes, every supervisor edit silently reformats a
    // table the client maintains by hand.
    for (const name of REFERENCE_TABLE_NAMES) {
      const file = REFERENCE_FILES[name].file;
      const raw = fs.readFileSync(path.join(REFERENCE_DIR, file), 'utf8');
      const rebuilt = serialiseCsv(
        parseCsv(raw),
        raw.includes('\r\n') ? '\r\n' : '\n',
        raw.charCodeAt(0) === 0xfeff,
      );
      check(`${file} round-trips unchanged`, rebuilt === raw);
    }

    // --------------------------------------------------------------------
    section('Tables load with Armenian, ids and the right shape');
    const status = referenceStatus();
    check('sub_category 295 rows', status.counts.sub_category.rows === 295, status.counts.sub_category);
    check('brand 839 rows', status.counts.brand.rows === 839, status.counts.brand);
    check('country 222 rows', status.counts.country.rows === 222, status.counts.country);
    check('material 85 rows', status.counts.material.rows === 85, status.counts.material);
    check('color 26 rows', status.counts.color.rows === 26, status.counts.color);
    check('gender 7 rows', status.counts.gender.rows === 7, status.counts.gender);
    check('season 5 rows', status.counts.season.rows === 5, status.counts.season);

    check(
      'every bilingual table is fully translated',
      status.untranslated === 0,
      `${status.untranslated} row(s) without Armenian`,
    );
    check(
      'brand is marked English-only',
      status.counts.brand.bilingual === false && status.counts.brand.armenian === 0,
    );
    check(
      'country is marked English-only',
      status.counts.country.bilingual === false && status.counts.country.armenian === 0,
    );

    const trousers = referenceEntries('sub_category').find((e) => e.en === 'Trousers');
    check('a sub_category row carries Armenian and an id',
      trousers !== undefined && trousers.hy !== null && trousers.id !== null, trousers);
    const unisex = referenceEntries('gender').find((e) => e.en === 'Unisex');
    check('"Unisex" keeps English in the Armenian column, as the client supplied it',
      unisex?.hy === 'Unisex', unisex);

    // --------------------------------------------------------------------
    section('The version fingerprint tracks content');
    const versionBefore = referenceVersion();
    check('version is a stable hex fingerprint', /^[0-9a-f]{16}$/.test(versionBefore), versionBefore);
    reloadReferenceData();
    check('re-reading unchanged files keeps the same version',
      referenceVersion() === versionBefore, referenceVersion());

    // --------------------------------------------------------------------
    section('Serving Armenian does not leak it into extraction');
    // This is the whole design in one check: the operator reads Armenian, the
    // record stays English.
    const extracted = normalizeExtraction({
      brand_name: { value: 'Nike', confidence: 0.9 },
      country_of_origin: { value: 'Made in Viet Nam', confidence: 0.9 },
      size: { value: 'XL', confidence: 0.9 },
      color: { value: 'Black', confidence: 0.9 },
      material: { value: '100% Cotton', confidence: 0.9 },
      original_price: { value: '$45.00', confidence: 0.9 },
      category: { value: 'clothing', confidence: 0.9 },
      sub_category: { value: 'Trousers', confidence: 0.9 },
      gender: { value: 'Men', confidence: 0.9 },
      season: { value: 'Summer', confidence: 0.9 },
      care_info: { value: '', confidence: 0 },
      key_photo_index: 0,
      weights: [{ value: '240g', confidence: 0.8 }],
    });
    const armenianInData = Object.values(extracted).some((field) =>
      /[԰-֏]/.test(field.value),
    );
    check('no Armenian character appears anywhere in extracted data', !armenianInData, extracted);
    check('sub_category is still the English key', extracted.sub_category.value === 'Trousers');

    check(
      'no Armenian character appears in the system instruction',
      !/[԰-֏]/.test(buildSystemInstruction()),
    );

    // --------------------------------------------------------------------
    section('GET /api/v1/reference-tables');
    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      const anonymous = await fetch(`${base}/api/v1/reference-tables`);
      check('requires authentication', anonymous.status === 401, anonymous.status);

      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'emp_402',
          password: process.env.APP_MASTER_PASSWORD,
        }),
      });
      const token = ((await login.json()) as { token?: string }).token ?? '';
      check('a device can log in', token !== '', login.status);
      const auth = { Authorization: `Bearer ${token}` };

      const response = await fetch(`${base}/api/v1/reference-tables`, { headers: auth });
      check('returns 200', response.status === 200, response.status);

      const etag = response.headers.get('etag');
      check('carries an ETag matching the version', etag === `"${referenceVersion()}"`, etag);
      check(
        'is revalidated rather than cached blind',
        (response.headers.get('cache-control') ?? '').includes('no-cache'),
        response.headers.get('cache-control'),
      );

      const body = (await response.json()) as ReturnType<typeof referenceCatalogue>;
      check('reports success', body.status === 'success');
      check('publishes all seven tables',
        Object.keys(body.tables).sort().join(',') ===
          [...REFERENCE_TABLE_NAMES].sort().join(','),
        Object.keys(body.tables));

      const subCategories = body.tables.sub_category;
      check('sub_category is flagged bilingual', subCategories.bilingual === true);
      const hoodie = subCategories.entries.find((e) => e.en === 'Hoodie');
      check('an entry carries {en, hy, id}',
        hoodie !== undefined && typeof hoodie.en === 'string' &&
          typeof hoodie.hy === 'string' && typeof hoodie.id === 'number', hoodie);

      check('brand is flagged English-only', body.tables.brand.bilingual === false);
      check('every brand entry has hy: null',
        body.tables.brand.entries.every((e) => e.hy === null));

      // A device that already holds the current vocabulary should transfer nothing.
      const conditional = await fetch(`${base}/api/v1/reference-tables`, {
        headers: { ...auth, 'If-None-Match': `"${referenceVersion()}"` },
      });
      check('a current device gets 304, not the payload', conditional.status === 304,
        conditional.status);

      const stale = await fetch(`${base}/api/v1/reference-tables`, {
        headers: { ...auth, 'If-None-Match': '"0000000000000000"' },
      });
      check('a stale ETag gets the full 200', stale.status === 200, stale.status);

      const health = await fetch(`${base}/health`);
      const healthBody = (await health.json()) as Record<string, unknown>;
      check('health advertises api_contract 1.4', healthBody.api_contract === '1.4', healthBody);
      check('health advertises the reference version',
        healthBody.reference_version === referenceVersion(), healthBody);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // --------------------------------------------------------------------
    section('Supervisor decisions — rejections write nothing');
    const before = fs.readFileSync(path.join(REFERENCE_DIR, 'sub-category.csv'), 'utf8');

    const unknownTable = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'nonsense',
      english: 'Trousers', armenian: 'Տաբատ', entry_id: null,
    });
    check('unknown table is rejected', unknownTable.outcome === 'REJECTED', unknownTable);

    const unknownAction = applyReferenceRequest({
      action: 'DELETE_ROW', table_name: 'sub_category',
      english: 'Trousers', armenian: null, entry_id: null,
    });
    check('there is no delete action', unknownAction.outcome === 'REJECTED', unknownAction);

    const brandArmenian = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'brand',
      english: 'Nike', armenian: 'Նայք', entry_id: null,
    });
    check('brand cannot be given Armenian', brandArmenian.outcome === 'REJECTED', brandArmenian);

    const latinPaste = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'sub_category',
      english: 'Hoodie', armenian: 'Kapyushon', entry_id: null,
    });
    check('Latin text in the Armenian column is refused',
      latinPaste.outcome === 'REJECTED', latinPaste);

    // The English word is fine for a row with no Armenian yet, but must never
    // overwrite a translation the client supplied.
    const untranslate = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'sub_category',
      english: 'Hoodie', armenian: 'Hoodie', entry_id: null,
    });
    check('the English word cannot replace existing Armenian',
      untranslate.outcome === 'REJECTED', untranslate);

    const missingRow = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'sub_category',
      english: 'Nonexistent Garment', armenian: 'Բան', entry_id: null,
    });
    check('SET_ARMENIAN on an unknown row is refused',
      missingRow.outcome === 'REJECTED', missingRow);

    const duplicate = applyReferenceRequest({
      action: 'ADD_ENTRY', table_name: 'sub_category',
      english: 'Hoodie', armenian: 'Հուդի', entry_id: null,
    });
    check('ADD_ENTRY refuses a term that already exists',
      duplicate.outcome === 'REJECTED', duplicate);

    check('not one rejection touched the file',
      fs.readFileSync(path.join(REFERENCE_DIR, 'sub-category.csv'), 'utf8') === before);

    // --------------------------------------------------------------------
    section('Supervisor decisions — applied additively');
    const highestBefore = referenceEntries('sub_category')
      .reduce((max, entry) => Math.max(max, entry.id ?? 0), 0);
    const added = applyReferenceRequest({
      action: 'ADD_ENTRY', table_name: 'sub_category',
      english: 'Test Garment', armenian: 'Փորձնական', entry_id: null,
    });
    check('a new row is applied', added.outcome === 'APPLIED', added);
    check('reload after the write succeeds', reloadReferenceData().ok === true);

    const newRow = referenceEntries('sub_category').find((e) => e.en === 'Test Garment');
    check('the new row is loaded back with its Armenian',
      newRow?.hy === 'Փորձնական', newRow);
    // Ids come from the client's own numbering, so a new one goes one above
    // their highest. Never into a gap: a freed id may still sit in an export.
    check('the assigned id is one above the highest in the table',
      newRow?.id === highestBefore + 1, { assigned: newRow?.id, highestBefore });
    check('the version changed with the content',
      referenceVersion() !== versionBefore, referenceVersion());
    check('the matcher sees the new term without a restart',
      subCategoryIndex.match('Test Garment') === 'Test Garment');

    // Filling a blank Armenian cell, the case the client actually hits.
    const blanked = applyReferenceRequest({
      action: 'ADD_ENTRY', table_name: 'color',
      english: 'Test Colour', armenian: '', entry_id: null,
    });
    check('a row may be added with no Armenian yet', blanked.outcome === 'APPLIED', blanked);
    reloadReferenceData();
    check('it is reported as untranslated', referenceStatus().untranslated === 1,
      referenceStatus().untranslated);
    check('the constrained-enum prompt picks up the new colour',
      buildSystemInstruction().includes('Test Colour'));
    check('the colour matcher picks it up too',
      colorIndex.match('Test Colour') === 'Test Colour');

    const filled = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'color',
      english: 'Test Colour', armenian: 'Փորձնական գույն', entry_id: null,
    });
    check('SET_ARMENIAN fills the blank cell', filled.outcome === 'APPLIED', filled);
    reloadReferenceData();
    check('nothing is untranslated any more', referenceStatus().untranslated === 0);
    check('the English key was not disturbed',
      referenceEntries('color').some((e) => e.en === 'Test Colour'));

    const noop = applyReferenceRequest({
      action: 'SET_ARMENIAN', table_name: 'color',
      english: 'Test Colour', armenian: 'Փորձնական գույն', entry_id: null,
    });
    check('re-submitting the same label is refused as a no-op',
      noop.outcome === 'REJECTED', noop);

    const staysEnglish = applyReferenceRequest({
      action: 'ADD_ENTRY', table_name: 'season',
      english: 'Test Season', armenian: 'Test Season', entry_id: null,
    });
    check('repeating the English term records "stays English"',
      staysEnglish.outcome === 'APPLIED', staysEnglish);

    // --------------------------------------------------------------------
    section('Existing rows survive every write');
    reloadReferenceData();
    check('sub_category is 296 after one addition',
      referenceEntries('sub_category').length === 296,
      referenceEntries('sub_category').length);
    check('Hoodie still reads the Armenian the client supplied',
      referenceEntries('sub_category').find((e) => e.en === 'Hoodie')?.hy === 'Հուդի');
    check('the quoted brand survived untouched',
      referenceEntries('brand').some((e) => e.en === 'Hello, By Loggi'));
  } finally {
    restore();
    // Leave the process holding the client's real tables, not the test's.
    const { reloadReferenceData: reload } = await import('../src/services/referenceService');
    reload();
    // The writer keeps backups of what it replaced; this suite's are noise.
    fs.rmSync(path.join(
      (await import('../src/data/referenceTables')).REFERENCE_DIR, '.backups',
    ), { recursive: true, force: true });
  }

  section('Tables restored');
  const { referenceStatus: finalStatus } = await import('../src/services/referenceService');
  const final = finalStatus();
  check('sub_category is back to 295', final.counts.sub_category.rows === 295,
    final.counts.sub_category);
  check('color is back to 26', final.counts.color.rows === 26, final.counts.color);
  check('season is back to 5', final.counts.season.rows === 5, final.counts.season);
  check('nothing is left untranslated', final.untranslated === 0, final.untranslated);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
