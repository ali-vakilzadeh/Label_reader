import fs from 'node:fs';
import path from 'node:path';
import { env, ROOT_DIR } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Client reference tables.
 *
 * These CSVs are the single source of truth, shared with the dashboard and
 * edited by hand. Each carries `english`, `armenian` and a numeric `id`; the
 * middleware reads only the English column — Armenian text and the ids are
 * dashboard concerns (see dev_report.md §24.5).
 *
 * They are read from disk at boot rather than compiled in, so a table can be
 * corrected by editing the file and restarting. That is the whole point of
 * committing them as data instead of code.
 */

const REFERENCE_DIR = path.join(ROOT_DIR, 'reference_data');

/**
 * Minimal RFC-4180 reader. The client's files really do contain quoted commas
 * ("Hello, By Loggi"), so splitting on commas would silently corrupt entries.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip a UTF-8 BOM so the first header name is not "﻿Brand".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads one table and returns the distinct values of its English column,
 * in file order.
 */
function readEnglishColumn(fileName: string, englishHeader: string): string[] {
  const filePath = path.join(REFERENCE_DIR, fileName);

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // A missing reference table is a configuration fault, not a runtime blip:
    // without it every scan would come back as unmatched free text and quietly
    // fill the ledger with junk. Fail loudly at boot instead.
    throw new Error(
      `Reference table ${fileName} could not be read from ${REFERENCE_DIR}. ` +
        `Deployments must ship the reference_data/ directory. (${String(error)})`,
    );
  }

  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`Reference table ${fileName} is empty.`);

  const header = rows[0]!.map((cell) => cell.trim());
  const column = header.indexOf(englishHeader);
  if (column === -1) {
    throw new Error(
      `Reference table ${fileName} has no "${englishHeader}" column. Found: ${header.join(', ')}`,
    );
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const value = (row[column] ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }

  if (values.length === 0) {
    throw new Error(`Reference table ${fileName} produced no values.`);
  }
  return values;
}

export const referenceTables = {
  subCategories: readEnglishColumn('sub-category.csv', 'SubGroup_English'),
  brands: readEnglishColumn('brand.csv', 'Brand'),
  countries: readEnglishColumn('country.csv', 'Country_English'),
  materials: readEnglishColumn('material.csv', 'Material_English'),
  colors: readEnglishColumn('color.csv', 'Color_English'),
  genders: readEnglishColumn('gender.csv', 'Gender_English'),
  seasons: readEnglishColumn('season.csv', 'Season_English'),
} as const;

logger.info(
  `Reference tables loaded from ${REFERENCE_DIR} — ` +
    Object.entries(referenceTables)
      .map(([name, values]) => `${name}:${values.length}`)
      .join(' '),
);

// Referenced so the env import is not flagged as unused when tree-shaken.
void env.nodeEnv;
