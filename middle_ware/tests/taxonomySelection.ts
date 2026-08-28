/**
 * The two-mode taxonomy design, and the matcher at real client table sizes.
 *
 *   REPORTED    sub_category, brand_name, country_of_origin, material
 *               -> never in the prompt; Gemini transcribes, matcher selects
 *   CONSTRAINED category, color, gender, season
 *               -> listed in the prompt; value used exactly as returned
 *
 * Usage: npx tsx tests/taxonomySelection.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.RENDER_CRON_ENABLED = 'false';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';

export {};

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

const cf = (value: string, confidence: number) => ({ value, confidence });

async function main(): Promise<void> {
  const {
    subCategoryIndex,
    brandIndex,
    countryIndex,
    materialIndex,
    colorIndex,
    genderIndex,
    seasonIndex,
    TAXONOMY_KEYS,
  } = await import('../src/utils/fuzzyMatcher');
  const { SYSTEM_INSTRUCTION, EXTRACTION_SCHEMA } = await import('../src/services/geminiService');
  const { normalizeExtraction } = await import('../src/services/visionService');

  // ------------------------------------------------------------------------
  section('Tables come from the committed CSVs, not a second copy');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ROOT_DIR } = await import('../src/config/env');
  const { parseCsv, referenceTables } = await import('../src/data/referenceTables');

  const refDir = path.join(ROOT_DIR, 'reference_data');
  check('reference_data ships inside the middleware', fs.existsSync(refDir), refDir);
  for (const file of ['sub-category.csv', 'brand.csv', 'country.csv', 'material.csv',
                      'color.csv', 'gender.csv', 'season.csv']) {
    check(`${file} present`, fs.existsSync(path.join(refDir, file)));
  }
  check(
    'no duplicate taxonomy JSON left behind',
    !fs.existsSync(path.join(ROOT_DIR, 'src', 'data', 'taxonomy', 'subCategories.json')),
  );

  // The client files really do contain quoted commas; splitting would corrupt them.
  const q = String.fromCharCode(34);
  const sample = [
    'a,b',
    q + 'Hello, By Loggi' + q + ',940',
    q + 'say ' + q + q + 'hi' + q + q + q + ',7',
  ].join(String.fromCharCode(10));
  const quoted = parseCsv(sample);
  check('quoted comma parsed as one field', quoted[1]?.[0] === 'Hello, By Loggi', quoted[1]);
  check('escaped quotes handled', quoted[2]?.[0] === 'say ' + q + 'hi' + q, quoted[2]);
  check(
    'the real quoted brand survived the load',
    referenceTables.brands.includes('Hello, By Loggi'),
  );

  // ------------------------------------------------------------------------
  section('Table sizes match the client workbook');
  check('sub_category 295', subCategoryIndex.size === 295, subCategoryIndex.size);
  check('brand 839', brandIndex.size === 839, brandIndex.size);
  check('country 222', countryIndex.size === 222, countryIndex.size);
  check('material 85', materialIndex.size === 85, materialIndex.size);
  check('color 26', colorIndex.size === 26, colorIndex.size);
  check('gender 7', genderIndex.size === 7, genderIndex.size);
  check('season 5', seasonIndex.size === 5, seasonIndex.size);

  // ------------------------------------------------------------------------
  section('Long tables are NOT sent to Gemini');
  const longSamples = ['Rinascimento', 'Long-sleeved T-shirt', 'AFGHANISTAN', 'Crocodile leather'];
  const schemaText = JSON.stringify(EXTRACTION_SCHEMA);
  for (const sample of longSamples) {
    check(`"${sample}" absent from the system instruction`, !SYSTEM_INSTRUCTION.includes(sample));
    check(`"${sample}" absent from the response schema`, !schemaText.includes(sample));
  }
  check(
    'prompt stays small',
    SYSTEM_INSTRUCTION.length < 1500,
    `${SYSTEM_INSTRUCTION.length} chars`,
  );
  check('TAXONOMY_KEYS exposes only the four short enums',
    Object.keys(TAXONOMY_KEYS).sort().join(',') === 'category,color,gender,season',
    Object.keys(TAXONOMY_KEYS));

  section('Short enums ARE sent to Gemini');
  for (const value of ['Multicolored', 'Baby Girl', 'All Seasons']) {
    check(`"${value}" listed in the system instruction`, SYSTEM_INSTRUCTION.includes(value));
  }
  check('instruction tells the model to transcribe the reported fields',
    /EXACTLY what is printed/i.test(SYSTEM_INSTRUCTION));

  // ------------------------------------------------------------------------
  section('Local selection replaces what Gemini reported');
  const cases: Array<[string, { match(v: string): string | null }, string]> = [
    ['Trousers', subCategoryIndex, 'Trousers'],
    ['trowsers', subCategoryIndex, 'Trousers'],
    ['t shirt', subCategoryIndex, 'T-shirt'],
    ['Made in Viet Nam', countryIndex, 'VIETNAM'],
    ['made in china', countryIndex, 'CHINA'],
    ['ITALY', countryIndex, 'ITALY'],
    ['100% cotton', materialIndex, 'Cotton'],
    ['polyester', materialIndex, 'Polyester'],
    ['ZARA', brandIndex, 'Zara'],
    ['calvin klein', brandIndex, 'Calvin Klein'],
  ];
  for (const [input, index, expected] of cases) {
    const got = index.match(input);
    check(`"${input}" -> ${expected}`, got === expected, got);
  }

  section('Unrecognisable text is kept, never forced onto a wrong entry');
  const nonsense = subCategoryIndex.matchOrKeep('qzxwv nonsense 12345');
  check('no match reported', nonsense.matched === false, nonsense);
  check('original text preserved', nonsense.value === 'qzxwv nonsense 12345', nonsense.value);

  // ------------------------------------------------------------------------
  section('End-to-end normalisation applies the right mode per field');
  const normalized = normalizeExtraction({
    brand_name: cf('ZARA', 0.9),
    country_of_origin: cf('Made in Viet Nam', 0.88),
    size: cf('XL', 0.9),
    color: cf('Blue - Navy', 0.92),
    material: cf('100% cotton', 0.85),
    original_price: cf('$45.00', 0.99),
    category: cf('clothing', 0.9),
    sub_category: cf('Trousers', 0.87),
    gender: cf('Women', 0.9),
    season: cf('All Seasons', 0.88),
    weights: [cf('290g', 0.86), cf('240g', 0.86)],
  });

  check('brand_name selected locally', normalized.brand_name.value === 'Zara', normalized.brand_name);
  check('country selected locally', normalized.country_of_origin.value === 'VIETNAM', normalized.country_of_origin);
  check(
    'sub_category selected locally',
    normalized.sub_category.value === 'Trousers',
    normalized.sub_category,
  );
  check('material selected locally', normalized.material.value === 'Cotton', normalized.material);

  check('color passed through untouched', normalized.color.value === 'Blue - Navy', normalized.color);
  check('gender passed through untouched', normalized.gender.value === 'Women', normalized.gender);
  check('season passed through untouched', normalized.season.value === 'All Seasons', normalized.season);
  check('category passed through untouched', normalized.category.value === 'clothing', normalized.category);

  check('confidence preserved through selection', normalized.sub_category.confidence === 0.87);
  check('size untouched', normalized.size.value === 'XL');
  check('weights still folded', normalized.brutto.value === '290g' && normalized.netto.value === '240g');

  section('An off-list constrained value is passed through, not rewritten');
  const odd = normalizeExtraction({
    brand_name: cf('', 0),
    country_of_origin: cf('', 0),
    size: cf('', 0),
    color: cf('Chartreuse', 0.4),
    material: cf('', 0),
    original_price: cf('', 0),
    category: cf('clothing', 0.9),
    sub_category: cf('', 0),
    gender: cf('Women', 0.9),
    season: cf('Summer', 0.9),
    weights: [],
  });
  check('unexpected colour preserved verbatim', odd.color.value === 'Chartreuse', odd.color);

  // ------------------------------------------------------------------------
  section('Selection latency at real table sizes');
  function bench(name: string, fn: (i: number) => void, n: number): number {
    for (let i = 0; i < 50; i += 1) fn(i);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) fn(i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
    console.log(`  ${name.padEnd(40)} ${ms.toFixed(4)} ms`);
    return ms;
  }

  const cached = bench('cached repeat (brand, 839)', () => brandIndex.match('ZARA'), 20000);
  const coldBrand = bench('cold miss (brand, 839)', (i) => brandIndex.match(`zzqx${i}`), 500);
  const coldSub = bench('cold miss (sub_category, 295)', (i) => subCategoryIndex.match(`zzqx${i}`), 500);
  const realistic = bench('realistic mixed lookup', (i) => {
    const inputs = ['Trousers', 'Made in Viet Nam', '100% cotton', 'ZARA'];
    subCategoryIndex.match(inputs[i % 4]!);
  }, 20000);

  check('cached lookup under 0.1 ms', cached < 0.1, cached);
  check('realistic lookup under 0.5 ms', realistic < 0.5, realistic);
  check('cold brand miss under 5 ms', coldBrand < 5, coldBrand);
  check('cold sub_category miss under 3 ms', coldSub < 3, coldSub);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
