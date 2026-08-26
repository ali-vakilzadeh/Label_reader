/**
 * Offline build step: translations.csv -> legalArmenianMap.json
 *
 * Run with:  npm run convert:translations [-- <input.csv> <output.json>]
 *
 * The client supplies translations.csv with at minimum an English column and an
 * Armenian column (an optional `domain` column is carried through for review but
 * is not needed at lookup time). The emitted JSON is a flat
 * { "english term": "Armenian legal text" } map consumed by exportService.
 *
 * This never runs inside the request path — the server only reads the JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import csvParser from 'csv-parser';

interface CsvRow {
  [column: string]: string | undefined;
}

const ENGLISH_COLUMNS = ['english', 'en', 'english_term', 'term', 'source'];
const ARMENIAN_COLUMNS = ['armenian', 'hy', 'armenian_term', 'legal_armenian', 'target'];

function pickColumn(row: CsvRow, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const hit = keys.find((key) => key.trim().toLowerCase() === candidate);
    if (hit) return hit;
  }
  return null;
}

interface ConvertResult {
  entries: number;
  duplicates: string[];
  skipped: number;
  outputPath: string;
}

export async function convertTranslations(
  inputPath: string,
  outputPath: string,
): Promise<ConvertResult> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input CSV not found: ${inputPath}`);
  }

  const map: Record<string, string> = {};
  const duplicates: string[] = [];
  let skipped = 0;
  let englishKey: string | null = null;
  let armenianKey: string | null = null;

  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(inputPath)
      // strip a UTF-8 BOM so the first header name is not "﻿english"
      .pipe(csvParser({ mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim() }))
      .on('data', (row: CsvRow) => {
        if (englishKey === null || armenianKey === null) {
          englishKey = pickColumn(row, ENGLISH_COLUMNS);
          armenianKey = pickColumn(row, ARMENIAN_COLUMNS);
          if (!englishKey || !armenianKey) {
            reject(
              new Error(
                `Could not locate English/Armenian columns. Found: ${Object.keys(row).join(', ')}`,
              ),
            );
            return;
          }
        }

        const english = (row[englishKey] ?? '').trim();
        const armenian = (row[armenianKey] ?? '').trim();

        if (!english || !armenian) {
          skipped += 1;
          return;
        }

        const key = english.toLowerCase();
        if (map[key] !== undefined && map[key] !== armenian) {
          duplicates.push(english);
        }
        map[key] = armenian;
      })
      .on('end', resolve)
      .on('error', reject);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Sorted output keeps the generated file diff-friendly in git.
  const sorted = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  return { entries: Object.keys(sorted).length, duplicates, skipped, outputPath };
}

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  const inputPath = path.resolve(inputArg ?? path.join(root, 'data', 'translations.csv'));
  const outputPath = path.resolve(
    outputArg ?? path.join(root, 'data', 'legalArmenianMap.json'),
  );

  const result = await convertTranslations(inputPath, outputPath);

  console.log(`Wrote ${result.entries} terms -> ${result.outputPath}`);
  if (result.skipped > 0) console.log(`Skipped ${result.skipped} incomplete row(s).`);
  if (result.duplicates.length > 0) {
    console.warn(
      `Conflicting duplicates (last value wins): ${[...new Set(result.duplicates)].join(', ')}`,
    );
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
