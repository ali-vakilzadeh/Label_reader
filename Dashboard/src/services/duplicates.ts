import crypto from 'node:crypto';
import { openDashboardDb } from '../db';
import { allSettings } from './settings';
import { audit } from './audit';
import type { ItemRow } from '../types/item';

/**
 * Duplicate and near-duplicate detection (plan §7.4).
 *
 * The order letter requires a warning where "the same or nearly identical item appears to
 * have been scanned more than once". The real warehouse failure is one garment scanned
 * twice minutes apart, which identical attributes catch exactly — with no dependencies and
 * a reason that can be read out loud.
 *
 * The dashboard WARNS and never merges. Deciding two garments are one is a human call with
 * commercial consequences: merging wrongly deletes a real item from a shipment.
 */

const SIGNATURE_COLUMNS = ['brand', 'sub_category', 'size', 'color', 'material', 'country'] as const;
const WEIGHT_TOLERANCE = 0.05;

function signature(item: ItemRow): string | null {
  const parts = SIGNATURE_COLUMNS.map((c) => item[c]);
  // A signature built from blanks would match every other incomplete row.
  if (parts.some((p) => !p)) return null;
  return parts.map((p) => String(p).toLowerCase()).join('|');
}

function weightsClose(a: ItemRow, b: ItemRow): boolean {
  const pairs: Array<[number | null, number | null]> = [
    [a.netto_g, b.netto_g],
    [a.brutto_g, b.brutto_g],
  ];
  for (const [x, y] of pairs) {
    if (x === null || y === null) continue; // unknown weight cannot rule a match out
    const bigger = Math.max(x, y);
    if (bigger > 0 && Math.abs(x - y) / bigger > WEIGHT_TOLERANCE) return false;
  }
  return true;
}

function minutesApart(a: ItemRow, b: ItemRow): number {
  return Math.abs(new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime()) / 60000;
}

function describe(a: ItemRow, b: ItemRow): string {
  const gap = minutesApart(a, b);
  const when =
    gap < 1 ? 'at the same moment' : gap < 60 ? `${Math.round(gap)} minutes apart` : `${(gap / 60).toFixed(1)} hours apart`;
  return `same brand, sub-category, size, colour, material and country as ${b.apparel_id}, scanned ${when}`;
}

/**
 * Scan a set of items against the window and stamp dup_group_id / dup_reason.
 * Returns the number of items newly flagged.
 */
export function detectDuplicates(apparelIds: string[]): number {
  const db = openDashboardDb();
  const windowHours = Number(allSettings().dup_window_hours);
  const windowMs = windowHours * 3600_000;
  let flagged = 0;

  const run = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const item = db.prepare('SELECT * FROM items WHERE apparel_id = ?').get(id) as ItemRow | undefined;
      if (!item || item.deleted_at || item.dup_dismissed) continue;
      const sig = signature(item);
      if (!sig) continue;

      const at = new Date(item.scanned_at).getTime();
      const lo = new Date(at - windowMs).toISOString().slice(0, 19);
      const hi = new Date(at + windowMs).toISOString().slice(0, 19);

      const where = SIGNATURE_COLUMNS.map((c) => `${c} = ?`).join(' AND ');
      const candidates = db
        .prepare(
          `SELECT * FROM items
            WHERE deleted_at IS NULL
              AND apparel_id <> ?
              AND scanned_at BETWEEN ? AND ?
              AND ${where}`,
        )
        .all(item.apparel_id, lo, hi, ...SIGNATURE_COLUMNS.map((c) => item[c] as string)) as ItemRow[];

      const match = candidates.find(
        (c) =>
          weightsClose(item, c) &&
          // A declared clone is not a duplicate — it is a known, intentional copy.
          c.cloned_from !== item.apparel_id &&
          item.cloned_from !== c.apparel_id &&
          !c.dup_dismissed,
      );
      if (!match) continue;

      // Reuse the partner's group if it already has one, so a run of three lands together.
      const groupId = match.dup_group_id ?? `dup_${crypto.randomBytes(6).toString('hex')}`;
      db.prepare('UPDATE items SET dup_group_id = ?, dup_reason = ? WHERE apparel_id = ?').run(
        groupId,
        describe(item, match),
        item.apparel_id,
      );
      if (!match.dup_group_id) {
        db.prepare('UPDATE items SET dup_group_id = ?, dup_reason = ? WHERE apparel_id = ?').run(
          groupId,
          describe(match, item),
          match.apparel_id,
        );
      }
      flagged += 1;
    }
  });

  run(apparelIds);
  return flagged;
}

/** "These really are two different garments." Permanent, and audited. */
export function dismissDuplicate(actor: string, apparelId: string): void {
  openDashboardDb()
    .prepare('UPDATE items SET dup_dismissed = 1, dup_group_id = NULL, dup_reason = NULL WHERE apparel_id = ?')
    .run(apparelId);
  audit(actor, 'DUP_DISMISS', 'item', apparelId);
}

export function duplicatePartners(groupId: string, exclude: string): ItemRow[] {
  return openDashboardDb()
    .prepare('SELECT * FROM items WHERE dup_group_id = ? AND apparel_id <> ? AND deleted_at IS NULL')
    .all(groupId, exclude) as ItemRow[];
}
