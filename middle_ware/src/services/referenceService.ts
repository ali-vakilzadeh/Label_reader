import {
  appendRow,
  isBilingual,
  REFERENCE_FILES,
  REFERENCE_TABLE_NAMES,
  referenceCounts,
  referenceEntries,
  referenceLoadedAt,
  referenceVersion,
  reloadReferenceTables,
  writeArmenian,
  type ReferenceEntry,
  type ReferenceTableName,
} from '../data/referenceTables';
import { reloadTaxonomyIndexes } from '../utils/fuzzyMatcher';
import { logger } from '../utils/logger';

/**
 * The reference-table service.
 *
 * Two jobs, both of them lookups rather than translations:
 *
 *  1. **Publish** the client's tables to the Android app, English keys with
 *     their Armenian labels alongside, so the operator can read and choose in
 *     Armenian while the value the app stores and exports stays the canonical
 *     English key. See api_contract.md v1.3 §4.6.
 *  2. **Apply** supervisor decisions arriving from the dashboard over
 *     `control.db` — a missing Armenian label filled in, or a genuinely new row
 *     the label vocabulary needed. See UI_messaging_protocol.md v1.4 §9.2.
 *
 * Nothing here translates anything. A term with no Armenian is published with
 * `hy: null` and the app renders the English word, which is the same rule the
 * dashboard follows (Dashboard_plan_final.md §6.3).
 */

// -------------------------------------------------------------- publishing --

export interface PublishedTable {
  /** False for brand and country, which the client keeps in English by decision. */
  bilingual: boolean;
  entries: ReferenceEntry[];
}

export interface ReferenceCatalogue {
  status: 'success';
  version: string;
  generated_at: string;
  tables: Record<ReferenceTableName, PublishedTable>;
}

export function referenceCatalogue(): ReferenceCatalogue {
  const tables = {} as Record<ReferenceTableName, PublishedTable>;
  for (const name of REFERENCE_TABLE_NAMES) {
    tables[name] = {
      bilingual: isBilingual(name),
      entries: referenceEntries(name) as ReferenceEntry[],
    };
  }

  return {
    status: 'success',
    version: referenceVersion(),
    generated_at: new Date(referenceLoadedAt()).toISOString(),
    tables,
  };
}

// --------------------------------------------------------------- reloading --

/**
 * Re-reads the CSVs and rebuilds the matcher indexes together.
 *
 * The two must move as one. Reloading the tables without rebuilding the indexes
 * would leave the device being served a vocabulary the matcher cannot snap onto.
 */
export function reloadReferenceData(): { ok: true; version: string } | { ok: false; error: string } {
  const result = reloadReferenceTables();
  if (result.ok) reloadTaxonomyIndexes();
  return result;
}

// ---------------------------------------------------------------- requests --

export type ReferenceAction = 'SET_ARMENIAN' | 'ADD_ENTRY';

export interface ReferenceRequest {
  action: string;
  table_name: string;
  english: string;
  armenian: string | null;
  entry_id: number | null;
}

export type ApplyOutcome =
  | { outcome: 'APPLIED'; detail: string }
  | { outcome: 'REJECTED'; detail: string };

/** Armenian script, including the ligature block. */
const ARMENIAN_SCRIPT = /[԰-֏ﬓ-ﬗ]/;

const MAX_TERM_LENGTH = 200;

function knownTable(name: string): ReferenceTableName | null {
  return (REFERENCE_TABLE_NAMES as string[]).includes(name)
    ? (name as ReferenceTableName)
    : null;
}

function findEntry(table: ReferenceTableName, english: string): ReferenceEntry | undefined {
  const needle = english.trim().toLowerCase();
  return referenceEntries(table).find((entry) => entry.en.toLowerCase() === needle);
}

/**
 * Validates and applies one supervisor decision.
 *
 * Deliberately **additive only**. There is no rename and no delete, because the
 * English key is the join everything downstream depends on: stored scans, the
 * dashboard's numeric-id joins, and exports already delivered to the client all
 * carry it. Changing a key here would silently orphan records that already use
 * it, which is exactly the failure the whole English-canonical design exists to
 * prevent.
 */
export function applyReferenceRequest(request: ReferenceRequest): ApplyOutcome {
  const table = knownTable(request.table_name);
  if (!table) {
    return {
      outcome: 'REJECTED',
      detail:
        `Unknown table "${request.table_name}". Expected one of: ` +
        `${REFERENCE_TABLE_NAMES.join(', ')}.`,
    };
  }

  const english = request.english.trim();
  if (!english) {
    return { outcome: 'REJECTED', detail: 'english is required and cannot be blank.' };
  }
  if (english.length > MAX_TERM_LENGTH) {
    return {
      outcome: 'REJECTED',
      detail: `english is ${english.length} characters; the limit is ${MAX_TERM_LENGTH}.`,
    };
  }

  const armenian = request.armenian?.trim() ?? '';
  if (armenian.length > MAX_TERM_LENGTH) {
    return {
      outcome: 'REJECTED',
      detail: `armenian is ${armenian.length} characters; the limit is ${MAX_TERM_LENGTH}.`,
    };
  }

  switch (request.action) {
    case 'SET_ARMENIAN':
      return setArmenian(table, english, armenian);
    case 'ADD_ENTRY':
      return addEntry(table, english, armenian, request.entry_id);
    default:
      return {
        outcome: 'REJECTED',
        detail: `Unknown action "${request.action}". Expected SET_ARMENIAN or ADD_ENTRY.`,
      };
  }
}

/**
 * @param replacingExisting true when the row already carries an Armenian label.
 */
function checkArmenian(
  english: string,
  armenian: string,
  replacingExisting: boolean,
): string | null {
  if (!armenian) return 'armenian is required and cannot be blank.';
  if (ARMENIAN_SCRIPT.test(armenian)) return null;

  // `Unisex` and `All Seasons` already ship with English in the Armenian column,
  // and that is correct — some terms are simply not translated. Repeating the
  // English word exactly is the documented way to record that.
  //
  // But only for a row that has no Armenian yet. Sending the English word for a
  // row that already reads `Հուդի` would replace a good translation with an
  // English one, and the overwhelmingly likelier cause of that submission is a
  // copied cell, not a decision. Deliberately un-translating a term is a hand
  // edit to the CSV plus a reload — visible, reviewable, and hard to do by
  // accident.
  if (!replacingExisting && armenian.toLowerCase() === english.toLowerCase()) return null;

  if (replacingExisting && armenian.toLowerCase() === english.toLowerCase()) {
    return (
      `"${english}" already has an Armenian label. Replacing it with the English ` +
      'word would discard a translation the client supplied. Edit the CSV directly ' +
      'and reload if that is really intended.'
    );
  }

  return (
    `"${armenian}" contains no Armenian characters. Submit Armenian text, or ` +
    'repeat the English term exactly to record that it stays English.'
  );
}

function setArmenian(
  table: ReferenceTableName,
  english: string,
  armenian: string,
): ApplyOutcome {
  if (!isBilingual(table)) {
    return {
      outcome: 'REJECTED',
      detail:
        `${REFERENCE_FILES[table].file} has no Armenian column. The client writes ` +
        'brand and country in English everywhere, including on the paperwork ' +
        '(decision of 2026-08-30).',
    };
  }

  const existing = findEntry(table, english);
  if (!existing) {
    return {
      outcome: 'REJECTED',
      detail:
        `No row in ${REFERENCE_FILES[table].file} has the English value "${english}". ` +
        'Use ADD_ENTRY to create it.',
    };
  }

  const problem = checkArmenian(english, armenian, existing.hy !== null);
  if (problem) return { outcome: 'REJECTED', detail: problem };

  if (existing.hy === armenian) {
    return {
      outcome: 'REJECTED',
      detail: `"${english}" already reads "${armenian}". Nothing to change.`,
    };
  }

  const previous = existing.hy;
  writeArmenian(table, { english, armenian });

  return {
    outcome: 'APPLIED',
    detail: previous
      ? `${table}: "${english}" Armenian changed from "${previous}" to "${armenian}".`
      : `${table}: "${english}" now reads "${armenian}".`,
  };
}

function addEntry(
  table: ReferenceTableName,
  english: string,
  armenian: string,
  entryId: number | null,
): ApplyOutcome {
  if (findEntry(table, english)) {
    return {
      outcome: 'REJECTED',
      detail:
        `${REFERENCE_FILES[table].file} already contains "${english}". ` +
        'Use SET_ARMENIAN to change its Armenian label.',
    };
  }

  if (isBilingual(table) && armenian) {
    const problem = checkArmenian(english, armenian, false);
    if (problem) return { outcome: 'REJECTED', detail: problem };
  }
  if (!isBilingual(table) && armenian) {
    return {
      outcome: 'REJECTED',
      detail:
        `${REFERENCE_FILES[table].file} has no Armenian column; submit the English ` +
        'term only.',
    };
  }

  const entries = referenceEntries(table);
  let id = entryId;
  if (id !== null && entries.some((entry) => entry.id === id)) {
    return {
      outcome: 'REJECTED',
      detail: `id ${id} is already used in ${REFERENCE_FILES[table].file}.`,
    };
  }
  if (id === null) {
    // The client owns these ids, so a new one goes above everything they have
    // used. Never reuse a gap: a freed id may still be sitting in an export.
    const highest = entries.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0);
    id = highest + 1;
  }

  appendRow(table, { english, armenian: armenian || undefined, id });

  return {
    outcome: 'APPLIED',
    detail:
      `${table}: added "${english}"` +
      (armenian ? ` ("${armenian}")` : ' with no Armenian label') +
      ` as id ${id}.`,
  };
}

// ------------------------------------------------------------------ status --

export interface ReferenceStatus {
  version: string;
  loadedAt: number;
  counts: ReturnType<typeof referenceCounts>;
  /** Bilingual rows still waiting for an Armenian label. */
  untranslated: number;
}

export function referenceStatus(): ReferenceStatus {
  const counts = referenceCounts();
  let untranslated = 0;
  for (const name of REFERENCE_TABLE_NAMES) {
    const table = counts[name];
    if (table.bilingual) untranslated += table.rows - table.armenian;
  }
  return {
    version: referenceVersion(),
    loadedAt: referenceLoadedAt(),
    counts,
    untranslated,
  };
}

export function logReferenceStatus(): void {
  const status = referenceStatus();
  logger.info(
    `Reference data version ${status.version} — ` +
      `${status.untranslated} bilingual row(s) still have no Armenian label.`,
  );
}
