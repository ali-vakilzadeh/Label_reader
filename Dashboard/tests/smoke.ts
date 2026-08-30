/**
 * End-to-end smoke test against a throwaway database.
 *
 * These are the acceptance points from Dashboard_plan_final.md §16 that can be checked
 * without a running middleware. Run with: npm test
 *
 * Note on the requires below: `import` is hoisted, so a top-level import of config/env
 * would read process.env before these lines run and the test would quietly operate on the
 * real ./data directory. Everything is therefore required lazily, after the environment
 * is set.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-dash-'));
process.env.DASHBOARD_DATA_DIR = tmp;
process.env.REFERENCE_DATA_DIR = path.resolve(__dirname, '../../middle_ware/reference_data');
process.env.LOCAL_REFERENCE_DIR = path.resolve(__dirname, '../reference_data');
process.env.MIDDLEWARE_DATA_DIR = path.join(tmp, 'no-middleware-here');

/* eslint-disable @typescript-eslint/no-var-requires */
const { openDashboardDb, closeAll } = require('../src/db');
const {
  loadReferenceTables,
  loadCustomsCodes,
  loadHsRules,
  refTable,
} = require('../src/data/referenceTables');
const { resolveTaxonomy, localised } = require('../src/data/resolve');
const { parsePrice, parseWeightToGrams, parseTimestamp } = require('../src/utils/normalise');
const { runImport, DuplicateFileError } = require('../src/services/import');
const {
  getItem,
  queryItems,
  updateItem,
  setLocked,
  reviewReasons,
  recomputeSuggestions,
} = require('../src/services/items');
const { collapseToLines } = require('../src/services/groups');
const { detectDuplicates } = require('../src/services/duplicates');
const { PRESETS, buildLines, renderCsv, warningsFor } = require('../src/services/exportPresets');
const { banner } = require('../src/services/control');
const { ensureSeedAdmin, verifyLogin } = require('../src/services/auth');

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const HEADER =
  'Barcode,Brand,Category,SubCategory,Gender,Season,Size,Color,Material,Country,OriginalPrice,Netto,Brutto,Timestamp,Operator,ExportBatch';

function ledger(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\r\n'), 'utf8');
}

async function main(): Promise<void> {
  openDashboardDb();
  ensureSeedAdmin();
  loadReferenceTables();
  loadCustomsCodes();
  loadHsRules();

  section('Reference tables');
  check('brand table loaded', refTable('brand').rows.length > 800);
  check('sub-category table loaded', refTable('sub_category').rows.length > 250);
  check('colour has Armenian', refTable('color').hasArmenian);
  check('brand has no Armenian (English always, by client instruction)', !refTable('brand').hasArmenian);
  check('category table supplied by this project', refTable('category').rows.length === 3);

  section('Normalisation');
  check('240g -> 240', parseWeightToGrams('240g') === 240);
  check('0.24kg -> 240', parseWeightToGrams('0.24kg') === 240);
  check('empty weight stays null, never 0', parseWeightToGrams('') === null);
  check('EUR price parsed', parsePrice('€79.90').value === 79.9 && parsePrice('€79.90').currency === 'EUR');
  check('comma decimal parsed', parsePrice('79,90 EUR').value === 79.9);
  check('ledger timestamp -> ISO', parseTimestamp('2026-08-28 14:30:00') === '2026-08-28T14:30:00');
  check("client's DD.MM.YYYY accepted", parseTimestamp('31.07.2026') === '2026-07-31T00:00:00');

  section('Taxonomy resolution');
  const exact = resolveTaxonomy('color', 'Blue - Navy');
  check('exact match resolves with an id', exact?.src === 'LOOKUP' && exact.id !== null);
  const armenianIn = resolveTaxonomy('color', 'Սև');
  check('Armenian input reverse-maps to English', armenianIn?.value === 'Black' && armenianIn.src === 'LOOKUP');
  const nonsense = resolveTaxonomy('sub_category', 'zzqqxx not a garment');
  check('unmatched keeps the original text', nonsense?.value === 'zzqqxx not a garment' && nonsense.src === 'UNMATCHED');
  check('unmatched has no id', nonsense?.id === null);

  section('Bilingual rendering');
  check('colour renders Armenian', localised('color', 'Black', 'hy') === 'Սև');
  check('brand renders English under AM', localised('brand', 'Nike', 'hy') === 'Nike');
  check('country renders English under AM', localised('country', 'VIETNAM', 'hy') === 'VIETNAM');
  check('missing translation falls back to English, never blank', localised('gender', 'Unisex', 'hy') === 'Unisex');
  check('unmatched value renders as typed', localised('sub_category', 'trowsers', 'hy') === 'trowsers');

  section('Import');
  const file = ledger([
    '8901,Nike,clothing,Trousers,Men,Summer,XL,Black,Cotton,VIETNAM,€79.90,240g,290g,2026-08-28 14:30:00,emp_402,EXPORT_1',
    '8902,Adidas,clothing,trowsers,Women,Winter,M,Blue,Polyester,ITALY,€49.00,300g,340g,2026-08-28 14:35:00,emp_402,EXPORT_1',
    '8903,Nike,clothing,Trousers,Men,Summer,XL,Black,Cotton,VIETNAM,€79.90,242g,291g,2026-08-28 14:34:00,emp_403,EXPORT_1',
  ]);
  const first = runImport('ui:test', 'ledger.csv', file, 'SKIP');
  check('three rows inserted', first.inserted === 3, JSON.stringify(first.rows));
  check('no failures', first.failed === 0);

  let refused = false;
  try {
    runImport('ui:test', 'renamed.csv', file, 'SKIP');
  } catch (err) {
    refused = err instanceof DuplicateFileError;
  }
  check('the same file, renamed, is refused by digest', refused);
  check('still three items', queryItems({}, { limit: 100 }).length === 3);

  section('Review flags');
  // "trowsers" resolves at 0.88 similarity, above the 0.85 gate, so it IS snapped —
  // and the snap is surfaced on the row rather than applied silently.
  const snapped = getItem('8902');
  const snapReasons = reviewReasons(snapped);
  check('a close typo is snapped to the table entry', snapped.sub_category === 'Trousers');
  check('the snap is stamped with its score', JSON.parse(snapped.field_src_json).sub_category.startsWith('FUZZY:'));
  check('and it is surfaced as a non-blocking reason', snapReasons.some((r: any) => r.kind === 'FUZZY' && !r.blocking));

  // Below the gate the operator's text must survive untouched.
  const belowGate = runImport(
    'ui:test',
    'unmatched.csv',
    ledger(['8904,Nike,clothing,Jaket,Men,Summer,XL,Black,Cotton,VIETNAM,€20,100g,110g,2026-08-29 09:00:00,emp_402,EXPORT_9']),
    'SKIP',
  );
  check('the unmatched row imported', belowGate.inserted === 1);
  const unmatched = getItem('8904');
  check('an unmatched value keeps the operator text', unmatched.sub_category === 'Jaket');
  check('and carries no invented id', unmatched.sub_category_id === null);
  check('it is flagged UNMATCHED', JSON.parse(unmatched.field_src_json).sub_category === 'UNMATCHED');
  check(
    'with a blocking review reason',
    reviewReasons(unmatched).some((r: any) => r.kind === 'UNMATCHED' && r.blocking),
  );
  check('and the row waits for review', unmatched.review_state === 'NEEDS_REVIEW');

  section('Duplicates');
  detectDuplicates(['8901', '8903']);
  const a = getItem('8901');
  const b = getItem('8903');
  check('near-duplicates share a group', !!a.dup_group_id && a.dup_group_id === b.dup_group_id);
  check('the reason is readable', (a.dup_reason ?? '').includes('8903'));
  check('neither was deleted or merged', !a.deleted_at && !b.deleted_at);

  section('Locking');
  setLocked('ui:test', '8901', true);
  let editRefused = false;
  try {
    updateItem('ui:test', '8901', { size: 'S' });
  } catch {
    editRefused = true;
  }
  check('a locked row refuses edits', editRefused);
  const overwrite = runImport(
    'ui:test',
    'ledger2.csv',
    ledger(['8901,Puma,clothing,Shirt,Women,Winter,S,White,Wool,ITALY,€10,100g,110g,2026-08-28 15:00:00,emp_404,EXPORT_2']),
    'OVERWRITE',
  );
  check('overwrite skips the locked row', overwrite.skipped === 1 && overwrite.updated === 0);
  check('the locked row is unchanged', getItem('8901').brand === 'Nike');
  setLocked('ui:test', '8901', false);

  section('Protected columns');
  updateItem('ui:test', '8902', { user_decided_price: '25', hs_code: '6204', notes: 'checked by hand' });
  runImport(
    'ui:test',
    'ledger3.csv',
    ledger(['8902,Adidas,clothing,Trousers,Women,Winter,M,Blue,Polyester,ITALY,€49.00,300g,340g,2026-08-28 14:35:00,emp_402,EXPORT_3']),
    'OVERWRITE',
  );
  const reimported = getItem('8902');
  check('a decided price survives an overwrite import', reimported.user_decided_price === 25);
  check('an HS code survives an overwrite import', reimported.hs_code === '6204');
  check('a note survives an overwrite import', reimported.notes === 'checked by hand');
  check('the extracted field was refreshed', reimported.sub_category === 'Trousers');

  section('Clone collapsing');
  const db = openDashboardDb();
  db.prepare("UPDATE items SET cloned_from = '8901' WHERE apparel_id = '8903'").run();
  const lines = collapseToLines(queryItems({}, { limit: 100 }));
  const family = lines.find((l: any) => l.representative.apparel_id === '8901');
  check('parent and clone become one line', !!family && family.members.length === 2);
  check('pieces sums the family', family?.pieces === 2);
  check('the clone has no line of its own', !lines.some((l: any) => l.representative.apparel_id === '8903'));

  section('Suggestions');
  // Seed enough priced history for tier 4 (sub_category + gender, n >= 5).
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) {
    db.prepare(
      `INSERT INTO items (apparel_id, operator, scanned_at, source, sub_category, gender, brand, season,
                          material, country, size, user_decided_price, field_src_json, created_at, updated_at, updated_by)
       VALUES (?, 'seed', '2026-08-01T10:00:00', 'MANUAL', 'Trousers', 'Men', 'Levis', 'Summer',
               'Cotton', 'ITALY', 'L', ?, '{}', ?, ?, 'seed')`,
    ).run(`seed${i}`, 30 + i, now, now);
  }
  recomputeSuggestions(['8901']);
  const suggested = getItem('8901');
  check('a price was suggested', suggested.suggested_price !== null);
  check('the suggestion carries a basis', !!suggested.suggested_price_basis);
  check('the suggestion carries a sample size', (suggested.suggested_price_n ?? 0) >= 5);
  check('it did not become the decided price', suggested.user_decided_price === null);

  section('Exports');
  const invoiceLines = buildLines({}, PRESETS.seller_invoice);
  const csv = renderCsv(PRESETS.seller_invoice, invoiceLines, 'hy');
  check('CSV starts with a UTF-8 BOM so Excel reads Armenian', csv[0] === 0xef && csv[1] === 0xbb && csv[2] === 0xbf);
  const text = csv.toString('utf8');
  const header = text.split('\r\n')[0].replace('﻿', '');
  check(
    "header matches the client's own invoice",
    header === 'No,ID code,Sub-category,Gender,Season,Netto,Brutto,Pieces,Brand,Country,Size,Original price,Color,Material,package,group,date',
    header,
  );
  check('Armenian values are exported', text.includes('Տղամարդկանց') || text.includes('Ամառ'), text.slice(0, 400));
  check('brand stays English in the Armenian export', text.includes('Nike'));
  const customsWarnings = warningsFor(PRESETS.customs, buildLines({}, PRESETS.customs));
  check('customs export warns about missing HS codes', customsWarnings.some((w: any) => w.kind === 'NO_HS_CODE'));

  section('Working without the middleware');
  const offline = banner(null, 'en');
  check('no control.db is reported honestly', offline.code === 'NO_CONTROL_DB');
  check('and it never claims OK', offline.level !== 'green');
  const dead = banner(
    {
      id: 1,
      state: 'OK',
      vision_state: 'OK',
      active_fault: null,
      active_fault_since: null,
      detail: null,
      heartbeat_at: Date.now() - 200_000,
      started_at: 0,
      queue_pending: 0,
      queue_parked: 0,
      flywheel_records: 0,
      flywheel_capacity: 0,
      updated_at: 0,
    },
    'en',
  );
  check("a stale heartbeat beats state='OK'", dead.code === 'SERVER_UNREACHABLE' && dead.level === 'red');
  const healthyQueue = banner(
    {
      id: 1,
      state: 'OK',
      vision_state: 'OK',
      active_fault: null,
      active_fault_since: null,
      detail: null,
      heartbeat_at: Date.now(),
      started_at: 0,
      queue_pending: 40,
      queue_parked: 0,
      flywheel_records: 0,
      flywheel_capacity: 0,
      updated_at: 0,
    },
    'en',
  );
  check('a non-empty queue is throughput, not a fault', healthyQueue.level === 'blue');

  section('Authentication');
  check('seeded admin can sign in', verifyLogin('admin', 'admin') !== null);
  check('and is forced to change the password', verifyLogin('admin', 'admin').must_change_password === 1);
  check('a wrong password is rejected', verifyLogin('admin', 'wrong') === null);

  closeAll();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
