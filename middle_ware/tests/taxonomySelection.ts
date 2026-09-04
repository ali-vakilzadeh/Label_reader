/**
 * The two-mode taxonomy design, and the matcher at real client table sizes.
 *
 *   REPORTED    sub_category, brand_name, country_of_origin, material
 *               -> never in the prompt; Gemini transcribes, matcher selects.
 *                  `material` is matched per fibre segment, not whole-string
 *                  (v1.4) - see the composition section below
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
  const { buildSystemInstruction, buildExtractionSchema } = await import(
    '../src/services/geminiService'
  );
  const SYSTEM_INSTRUCTION = buildSystemInstruction();
  const EXTRACTION_SCHEMA = buildExtractionSchema();
  const { normalizeExtraction, readSuggestedKeyPhoto, emptyExtraction } = await import(
    '../src/services/visionService'
  );
  const { referenceEntries } = await import('../src/data/referenceTables');
  const emptyExtractionForTest = () => emptyExtraction();

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
  // The ceiling guards against a long TABLE (295 sub-categories, 839 brands)
  // leaking into the prompt, not against extraction rules - the material,
  // size, care-QR and key-photo rules are deliberate prose and cost a few
  // hundred chars each. Raised from 2600 for v1.4; a jump past this means a
  // table leaked, because prose does not arrive 1,000 characters at a time.
  check(
    'prompt stays small',
    SYSTEM_INSTRUCTION.length < 3800,
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
  section('Material rules are stated to the model');
  check('multilingual compositions collapse to English',
    /ONCE in English/i.test(SYSTEM_INSTRUCTION));
  check('the five-language cotton example is spelled out',
    SYSTEM_INSTRUCTION.includes('100% Cotton') &&
      SYSTEM_INSTRUCTION.includes('ALGODON'));
  check('the schema repeats the English-only rule',
    /ENGLISH ONLY/i.test(schemaText));
  check('footwear without a printed composition is inferred, not left empty',
    /SHOES:/.test(SYSTEM_INSTRUCTION) &&
      /infer the material of the upper/i.test(SYSTEM_INSTRUCTION));
  check('an inferred footwear material is capped below the flywheel threshold',
    /confidence 0\.50 or lower/i.test(SYSTEM_INSTRUCTION));
  // The single terms the shoe rule offers must survive the local matcher —
  // "Leather + Sole: Rubber" would fuzzy-snap onto the wrong table entry.
  for (const term of ['Leather', 'Faux leather', 'Suede', 'Textile',
    'Synthetic material', 'Rubber', 'Mesh']) {
    check(`suggested shoe material "${term}" is a real table entry`,
      materialIndex.match(term) === term, materialIndex.match(term));
  }

  section('The v1.4 size rule is stated to the model');
  check('the model is told to report the European size only',
    /report ONLY the European one/i.test(SYSTEM_INSTRUCTION));
  check('EUR is normalised to EU, with the worked example',
    SYSTEM_INSTRUCTION.includes('EUR 122/128') && SYSTEM_INSTRUCTION.includes('EU 122/128'));
  check('the value after the prefix is copied verbatim',
    /never simplify, split or convert/i.test(SYSTEM_INSTRUCTION));
  // The fallback matters as much as the rule: without it every adult garment
  // with a plain letter size breaks.
  check('a label with no European size is reported as printed',
    /NO European size/i.test(SYSTEM_INSTRUCTION) &&
      /add no prefix/i.test(SYSTEM_INSTRUCTION));
  check('the rule chooses between systems, it does not invent one',
    /never invent one it does not/i.test(SYSTEM_INSTRUCTION));
  check('the schema repeats the EU-only rule',
    /EUROPEAN size only/i.test(schemaText) && /no prefix added/i.test(schemaText));

  section('care_info is asked for, and asked for carefully');
  check('care_info is in the response schema',
    /care_info/.test(schemaText));
  check('the model is told to decode the care QR code',
    /CARE QR CODE:/.test(SYSTEM_INSTRUCTION));
  check('the URL is returned alone, not in a sentence',
    /Return the URL only/i.test(SYSTEM_INSTRUCTION));
  check('an unreadable QR code returns empty at 0.0, not a guess',
    /empty string/i.test(SYSTEM_INSTRUCTION) &&
      /cannot be spotted by eye/i.test(SYSTEM_INSTRUCTION));

  section('The key-photo suggestion is asked for, and may be declined');
  check('key_photo_index is in the response schema',
    /key_photo_index/.test(schemaText));
  check('the model is told the images are numbered from 0',
    /numbered from 0/i.test(SYSTEM_INSTRUCTION));
  check('a label, tag or scale display is not the product shot',
    /not a care label/i.test(SYSTEM_INSTRUCTION));
  // A wrong confident answer is worse than an honest absence.
  check('the model may refuse rather than fall back to photo 0',
    /return\s*\n?\s*-1/.test(SYSTEM_INSTRUCTION) || /return -1/i.test(SYSTEM_INSTRUCTION));
  check('and -1 is read back as null, not as photo 0',
    readSuggestedKeyPhoto({ key_photo_index: -1 }, 4) === null);
  check('an in-range suggestion is kept', readSuggestedKeyPhoto({ key_photo_index: 2 }, 4) === 2);
  check('an out-of-range suggestion is discarded, not clamped',
    readSuggestedKeyPhoto({ key_photo_index: 9 }, 4) === null);

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

  // ------------------------------------------------------------------------
  section('material: the full composition survives, with invariant fibre names');
  const { normalizeComposition } = await import('../src/utils/fuzzyMatcher');
  const composition = (input: string) => normalizeComposition(input).value;

  // The v1.3 defect: the whole string snapped onto the table and the
  // percentage was thrown away. This is the check that must never regress.
  check('"100% Cotton" keeps its percentage',
    composition('100% Cotton') === '100% Cotton', composition('100% Cotton'));
  check('a multi-fibre composition survives intact',
    composition('80% Cotton 20% Polyester') === '80% Cotton 20% Polyester',
    composition('80% Cotton 20% Polyester'));
  check('three fibres survive, in the printed order and spacing',
    composition('40% Cotton 40% Nylon 20% Elastane') === '40% Cotton 40% Nylon 20% Elastane',
    composition('40% Cotton 40% Nylon 20% Elastane'));
  check('comma-separated compositions keep their commas',
    composition('60% Wool, 40% Polyamide') === '60% Wool, 40% Polyamide',
    composition('60% Wool, 40% Polyamide'));

  // Invariance is the point: the same fibre must always arrive spelled the same
  // way, or the value stops being groupable on the paperwork.
  check('a foreign fibre name normalises to its canonical English term',
    composition('80% COTONE 20% POLIESTER') === '80% Cotton 20% Polyester',
    composition('80% COTONE 20% POLIESTER'));
  check('casing is normalised without touching the percentage',
    composition('100% cotton') === '100% Cotton', composition('100% cotton'));

  // A wrong canonical key is worse than an unmatched one - everywhere.
  check('an unknown fibre passes through exactly as transcribed',
    composition('70% Cotton 30% Unobtanium') === '70% Cotton 30% Unobtanium',
    composition('70% Cotton 30% Unobtanium'));
  check('a composition of nothing but unknown fibres is untouched',
    composition('100% Unobtanium') === '100% Unobtanium', composition('100% Unobtanium'));

  // The footwear inference is a single term with no percentage; it must still
  // land on itself rather than being mangled by the segmenter.
  check('a single-term shoe inference lands on itself',
    composition('Leather') === 'Leather' && composition('Suede') === 'Suede',
    [composition('Leather'), composition('Suede')]);

  // Percentages are transcribed, never computed: nothing sums, normalises or
  // reorders them, even when the label does not add up.
  check('percentages are not summed or corrected',
    composition('60% Cotton 60% Polyester') === '60% Cotton 60% Polyester',
    composition('60% Cotton 60% Polyester'));
  check('a decimal percentage is preserved',
    composition('97,5% Cotton 2,5% Elastane') === '97,5% Cotton 2,5% Elastane',
    composition('97,5% Cotton 2,5% Elastane'));

  section('The composition split is lossless');
  const { assertLossless } = await import('../src/utils/composition');
  for (const sample of [
    '100% Cotton',
    '80% Cotton 20% Polyester',
    '40% Cotton 40% Nylon 20% Elastane',
    '60% Wool, 40% Polyamide',
    'Upper: Leather / Sole: Rubber',
    'Leather',
    'Cotton 100%',
    '  95% Cotton   5% Elastane  ',
  ]) {
    check(`split and rejoin reproduces ${JSON.stringify(sample)}`, assertLossless(sample));
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
    care_info: cf('', 0),
    key_photo_index: 0,
    weights: [cf('290g', 0.86), cf('240g', 0.86)],
  });

  check('brand_name selected locally', normalized.brand_name.value === 'Zara', normalized.brand_name);
  check('country selected locally', normalized.country_of_origin.value === 'VIETNAM', normalized.country_of_origin);
  check(
    'sub_category selected locally',
    normalized.sub_category.value === 'Trousers',
    normalized.sub_category,
  );
  // v1.4: matched per fibre segment, so the percentage survives the trip.
  check('material keeps its composition through normalisation',
    normalized.material.value === '100% Cotton', normalized.material);

  check('color passed through untouched', normalized.color.value === 'Blue - Navy', normalized.color);
  check('gender passed through untouched', normalized.gender.value === 'Women', normalized.gender);
  check('season passed through untouched', normalized.season.value === 'All Seasons', normalized.season);
  check('category passed through untouched', normalized.category.value === 'clothing', normalized.category);

  check('confidence preserved through selection', normalized.sub_category.confidence === 0.87);
  // The EU rule is applied by the model, not the server: `size` passes through
  // neither MATCHED_FIELDS nor CONSTRAINED_FIELDS, so whatever the model
  // reports is what the device gets. A plain letter size must survive that.
  check('a plain letter size is passed through untouched', normalized.size.value === 'XL');
  check('care_info empty when the model saw no QR code',
    normalized.care_info.value === '' && normalized.care_info.confidence === 0,
    normalized.care_info);
  check('weights still folded', normalized.brutto.value === '290g' && normalized.netto.value === '240g');

  section('A decoded care QR code is reported, but never as if it were read');
  const { careInfoConfidence } = await import('../src/services/visionService');
  const { env } = await import('../src/config/env');
  const withQr = normalizeExtraction({
    brand_name: cf('Zara', 0.9),
    country_of_origin: cf('ITALY', 0.9),
    size: cf('EU 122/128', 0.9),
    color: cf('Black', 0.9),
    material: cf('100% Cotton', 0.9),
    original_price: cf('', 0),
    category: cf('clothing', 0.9),
    sub_category: cf('Trousers', 0.9),
    gender: cf('Women', 0.9),
    season: cf('Summer', 0.9),
    care_info: cf('https://care.example.com/x7f9', 0.95),
    key_photo_index: 1,
    weights: [],
  });
  check('the URL itself is reported verbatim',
    withQr.care_info.value === 'https://care.example.com/x7f9', withQr.care_info);
  // Gemini is not a QR decoder, and a misread URL cannot be caught by eye.
  check('an over-confident QR read is capped',
    withQr.care_info.confidence <= 0.6, withQr.care_info);
  check('the cap lands below FLYWHEEL_CONFIDENCE_THRESHOLD, so it routes for review',
    withQr.care_info.confidence < env.flywheelConfidenceThreshold, {
      capped: withQr.care_info.confidence,
      threshold: env.flywheelConfidenceThreshold,
    });
  check('a confidence already below the cap is not raised to it',
    careInfoConfidence(0.2) === 0.2, careInfoConfidence(0.2));
  // Lowering the threshold must not quietly switch the review off.
  check('the cap tracks the threshold when the threshold is lowered',
    careInfoConfidence(0.95, 0.4) < 0.4, careInfoConfidence(0.95, 0.4));

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
    care_info: cf('', 0),
    key_photo_index: -1,
    weights: [],
  });
  check('unexpected colour preserved verbatim', odd.color.value === 'Chartreuse', odd.color);

  // ------------------------------------------------------------------------
  section('data_hy: 13 keys, sourced from the reference catalogue');
  const { buildArmenianData, NEVER_TRANSLATED } = await import(
    '../src/services/armenianService'
  );
  const { EXTRACTED_FIELDS } = await import('../src/types');
  const hy = buildArmenianData(withQr);
  const armenianScript = /[\u0530-\u058f]/;

  check('all 13 keys present, same set as data',
    Object.keys(hy).length === 13 &&
      EXTRACTED_FIELDS.every((f) => f in hy),
    Object.keys(hy));
  check('every value is a plain string or null - no confidence',
    Object.values(hy).every((v) => v === null || typeof v === 'string'), hy);
  check('the seven never-translated keys are null by design',
    NEVER_TRANSLATED.every((f) => hy[f] === null), hy);
  check('sub_category comes from the reference table, not a translator',
    hy.sub_category === referenceEntries('sub_category').find((e) => e.en === 'Trousers')?.hy,
    hy.sub_category);
  check('color comes from the reference table',
    hy.color === referenceEntries('color').find((e) => e.en === 'Black')?.hy, hy.color);
  check('category comes from enums.json, the one taxonomy with no client CSV',
    typeof hy.category === 'string' && armenianScript.test(hy.category), hy.category);
  check('material is rendered per fibre, with the percentage kept',
    typeof hy.material === 'string' && hy.material.startsWith('100% ') &&
      armenianScript.test(hy.material),
    hy.material);

  // Multi-fibre, and a fibre the tables cannot place.
  const mixed = buildArmenianData({
    ...withQr,
    material: cf('80% Cotton 20% Polyester', 0.9),
  });
  check('a two-fibre composition renders both fibres in Armenian',
    typeof mixed.material === 'string' &&
      mixed.material.includes('80%') && mixed.material.includes('20%') &&
      !/[A-Za-z]/.test(mixed.material),
    mixed.material);

  const partly = buildArmenianData({ ...withQr, material: cf('90% Cotton 10% Unobtanium', 0.9) });
  check('an untranslatable fibre stays English inside the Armenian string',
    typeof partly.material === 'string' && partly.material.includes('Unobtanium') &&
      armenianScript.test(partly.material),
    partly.material);

  // Rule 1: null means "display the English value", never "show nothing".
  const unmatched = buildArmenianData({
    ...withQr,
    sub_category: cf('Qzxwv Nonsense', 0.4),
    material: cf('100% Unobtanium', 0.4),
  });
  check('a value with no table row is null, not blank and not machine-translated',
    unmatched.sub_category === null, unmatched.sub_category);
  check('a composition with nothing translatable is null, not half-empty',
    unmatched.material === null, unmatched.material);

  const blank = buildArmenianData(emptyExtractionForTest());
  check('an empty extraction still returns all 13 keys, every one null',
    Object.keys(blank).length === 13 && Object.values(blank).every((v) => v === null),
    blank);

  check('nothing Armenian leaked back into data',
    Object.values(withQr).every((f) => !armenianScript.test(f.value)), withQr);

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
