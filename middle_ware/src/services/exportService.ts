import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { EXTRACTED_FIELDS, type ExtractedData, type ExtractedFieldName } from '../types';

/**
 * Bilingual export (Armenian legal declarations).
 *
 * Extraction is normalised to English enum keys; Armenian customs paperwork needs
 * the exact legal wording. legalArmenianMap.json — produced offline by
 * scripts/convertTranslations.ts from the client's translations.csv — is the
 * single source of that wording.
 *
 * Lookup is deliberately strict: an unmapped term is reported, never guessed,
 * because a wrong Armenian legal term on an export declaration is worse than a
 * flagged gap.
 */

export interface LegalArmenianMap {
  /** Lower-cased English term -> Armenian legal text. */
  [englishTerm: string]: string;
}

const MAP_FILENAME = 'legalArmenianMap.json';

let cachedMap: LegalArmenianMap | null = null;

export function legalMapPath(): string {
  return path.join(env.dataDir, MAP_FILENAME);
}

export function loadLegalArmenianMap(force = false): LegalArmenianMap {
  if (cachedMap && !force) return cachedMap;

  const filePath = legalMapPath();
  if (!fs.existsSync(filePath)) {
    logger.warn(
      `${MAP_FILENAME} not found at ${filePath}. Run "npm run convert:translations" ` +
        'to build it from translations.csv. Armenian export fields will be empty.',
    );
    cachedMap = {};
    return cachedMap;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegalArmenianMap;
    cachedMap = normalizeKeys(parsed);
    logger.info(`Loaded ${Object.keys(cachedMap).length} Armenian legal terms.`);
    return cachedMap;
  } catch (error) {
    logger.error(`Failed to parse ${MAP_FILENAME}; Armenian export disabled.`, error);
    cachedMap = {};
    return cachedMap;
  }
}

function normalizeKeys(map: LegalArmenianMap): LegalArmenianMap {
  const normalized: LegalArmenianMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string') continue;
    normalized[key.trim().toLowerCase()] = value;
  }
  return normalized;
}

/** Translates a single English term. Returns null when unmapped. */
export function toArmenian(term: string): string | null {
  if (!term) return null;
  return loadLegalArmenianMap()[term.trim().toLowerCase()] ?? null;
}

/**
 * Material arrives as a composition string ("80% Wool 20% Polyamide"), so an
 * exact map lookup would always miss. Each fibre segment is translated
 * individually with its percentage preserved; a fibre with no legal Armenian
 * term is left in English and reported through `missing`.
 */
export function translateMaterial(
  composition: string,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const trimmed = composition.trim();
  if (!trimmed) return { text: '', missing };

  // Whole-string hit first ("cotton", "faux leather").
  const whole = toArmenian(trimmed);
  if (whole) return { text: whole, missing };

  // Split on commas, slashes and percentage boundaries, keeping the numbers.
  const segments = trimmed
    .split(/[,;/]+|(?<=%)\s+(?=\d)/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const translated = segments.map((segment) => {
    const match = segment.match(/^(\d+(?:[.,]\d+)?\s*%)?\s*(.+?)\s*(\d+(?:[.,]\d+)?\s*%)?$/);
    const percentage = (match?.[1] ?? match?.[3] ?? '').trim();
    const fibre = (match?.[2] ?? segment).trim();

    const armenian = toArmenian(fibre);
    if (!armenian) {
      missing.push(fibre);
      return segment;
    }
    return percentage ? `${percentage} ${armenian}` : armenian;
  });

  return { text: translated.join(', '), missing };
}

/** Fields carrying controlled vocabulary — the only ones worth translating. */
export const TRANSLATABLE_FIELDS: ExtractedFieldName[] = [
  'country_of_origin',
  'color',
  'category',
  'sub_category',
  'gender',
  'season',
  'material',
];

export interface BilingualField {
  value_en: string;
  value_hy: string;
  confidence: number;
  /** True when the English term had no entry in the legal map. */
  untranslated: boolean;
}

export type BilingualRecord = Record<ExtractedFieldName, BilingualField>;

export interface BilingualExport {
  apparel_id: string;
  fields: BilingualRecord;
  /** English terms with no Armenian mapping — surfaced for supervisor review. */
  missing_translations: string[];
}

export function buildBilingualExport(
  apparelId: string,
  data: ExtractedData,
): BilingualExport {
  const fields = {} as BilingualRecord;
  const missing: string[] = [];

  for (const field of EXTRACTED_FIELDS) {
    const entry = data[field] ?? { value: '', confidence: 0 };
    const translatable = TRANSLATABLE_FIELDS.includes(field);

    let armenian: string | null = null;
    if (translatable && entry.value) {
      if (field === 'material') {
        // A partly-translated composition is still usable; only the unmapped
        // fibre names are reported for review.
        const composition = translateMaterial(entry.value);
        armenian = composition.text;
        missing.push(...composition.missing);
      } else {
        armenian = toArmenian(entry.value);
        if (armenian === null) missing.push(entry.value);
      }
    }

    fields[field] = {
      value_en: entry.value,
      // Untranslatable fields (size, price, brand) are legally reproduced as-is.
      value_hy: armenian ?? (translatable ? '' : entry.value),
      confidence: entry.confidence,
      untranslated: translatable && entry.value !== '' && (armenian === null || armenian === ''),
    };
  }

  return { apparel_id: apparelId, fields, missing_translations: missing };
}

const CSV_HEADERS = [
  'apparel_id',
  ...EXTRACTED_FIELDS.flatMap((field) => [field, `${field}_hy`]),
];

/** Bilingual CSV row set, ready for the Armenian customs declaration workbook. */
export function toBilingualCsv(records: BilingualExport[]): string {
  const lines = [CSV_HEADERS.map(csvCell).join(',')];

  for (const record of records) {
    const row = [record.apparel_id];
    for (const field of EXTRACTED_FIELDS) {
      const entry = record.fields[field];
      row.push(entry.value_en, entry.value_hy);
    }
    lines.push(row.map(csvCell).join(','));
  }

  // BOM so Excel opens the Armenian script in the correct encoding.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function csvCell(value: string): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
