import { openDashboardDb } from '../db';
import { audit } from './audit';
import { getItem } from './items';
import type { ItemRow } from '../types/item';

/**
 * Article groups and clone collapsing (plan §7.3).
 *
 * Three separate ideas, deliberately not conflated:
 *   - a physical item is one barcode and always its own row;
 *   - a CLONE is device-level: the operator scanned a second identical garment;
 *   - an ARTICLE GROUP is dashboard-level: similar items placed on one invoice line.
 *
 * Grouping is a label, not a merge. Ungrouping restores the rows untouched.
 */

export function createGroup(actor: string, articleNo: string, title: string | null): void {
  openDashboardDb()
    .prepare(
      `INSERT INTO article_groups (article_no, title, created_at, created_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(article_no) DO UPDATE SET title = COALESCE(excluded.title, article_groups.title)`,
    )
    .run(articleNo, title, Date.now(), actor);
}

export function assignToGroup(actor: string, apparelIds: string[], articleNo: string): number {
  const db = openDashboardDb();
  createGroup(actor, articleNo, null);
  let n = 0;
  const run = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const item = getItem(id);
      if (!item || item.locked) continue;
      db.prepare('UPDATE items SET article_no = ?, updated_at = ?, updated_by = ? WHERE apparel_id = ?').run(
        articleNo,
        Date.now(),
        actor,
        id,
      );
      n += 1;
    }
  });
  run(apparelIds);
  audit(actor, 'GROUP_ASSIGN', 'article_group', articleNo, null, { count: n, ids: apparelIds });
  return n;
}

export function removeFromGroup(actor: string, apparelIds: string[]): number {
  const db = openDashboardDb();
  let n = 0;
  const run = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const item = getItem(id);
      if (!item || item.locked) continue;
      db.prepare('UPDATE items SET article_no = NULL, updated_at = ?, updated_by = ? WHERE apparel_id = ?').run(
        Date.now(),
        actor,
        id,
      );
      n += 1;
    }
  });
  run(apparelIds);
  audit(actor, 'GROUP_REMOVE', 'article_group', null, null, { count: n });
  return n;
}

export function groupMembers(articleNo: string): ItemRow[] {
  return openDashboardDb()
    .prepare('SELECT * FROM items WHERE article_no = ? AND deleted_at IS NULL ORDER BY scanned_at')
    .all(articleNo) as ItemRow[];
}

/** Fields that may be pushed from a representative row to the rest of its group. */
export const APPLICABLE_FIELDS = [
  'brand',
  'category',
  'sub_category',
  'gender',
  'season',
  'color',
  'material',
  'country',
  'size',
  'original_price',
  'netto',
  'brutto',
  'package_code',
  'care_info',
  'hs_code',
  'user_decided_price',
  'notes',
] as const;

export interface ApplyPreview {
  apparel_id: string;
  locked: boolean;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}

/**
 * "Information can be copied efficiently to repeated/similar items" (order letter).
 * Always previewed before it runs, and locked rows are skipped rather than failed.
 */
export function previewApply(sourceId: string, targetIds: string[], fields: string[]): ApplyPreview[] {
  const source = getItem(sourceId);
  if (!source) return [];
  const chosen = fields.filter((f) => (APPLICABLE_FIELDS as readonly string[]).includes(f));
  const out: ApplyPreview[] = [];
  for (const id of targetIds) {
    if (id === sourceId) continue;
    const target = getItem(id);
    if (!target) continue;
    const changes = chosen
      .map((f) => ({
        field: f,
        from: (target as unknown as Record<string, unknown>)[f],
        to: (source as unknown as Record<string, unknown>)[f],
      }))
      .filter((c) => c.from !== c.to);
    out.push({ apparel_id: id, locked: !!target.locked, changes });
  }
  return out;
}

export function applyToGroup(
  actor: string,
  sourceId: string,
  targetIds: string[],
  fields: string[],
): { updated: number; skippedLocked: number } {
  const db = openDashboardDb();
  const source = getItem(sourceId);
  if (!source) return { updated: 0, skippedLocked: 0 };
  const chosen = fields.filter((f) => (APPLICABLE_FIELDS as readonly string[]).includes(f));
  if (!chosen.length) return { updated: 0, skippedLocked: 0 };

  // Copy the derived companions too, so netto/netto_g cannot drift apart.
  const companions: Record<string, string[]> = {
    netto: ['netto_g'],
    brutto: ['brutto_g'],
    original_price: ['original_price_value', 'original_price_currency'],
    user_decided_price: ['user_decided_price_currency'],
    brand: ['brand_id'],
    category: ['category_id'],
    sub_category: ['sub_category_id'],
    gender: ['gender_id'],
    season: ['season_id'],
    color: ['color_id'],
    material: ['material_id'],
    country: ['country_id'],
    hs_code: ['hs_code_src', 'hs_code_basis'],
  };

  const columns = chosen.flatMap((f) => [f, ...(companions[f] ?? [])]);
  const values = columns.map((c) => (source as unknown as Record<string, unknown>)[c] ?? null);

  let updated = 0;
  let skippedLocked = 0;
  const run = db.transaction((ids: string[]) => {
    for (const id of ids) {
      if (id === sourceId) continue;
      const target = getItem(id);
      if (!target) continue;
      if (target.locked) {
        skippedLocked += 1;
        continue;
      }
      db.prepare(
        `UPDATE items SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, updated_by = ?
          WHERE apparel_id = ?`,
      ).run(...(values as never[]), Date.now(), actor, id);
      audit(actor, 'GROUP_APPLY', 'item', id, null, { from: sourceId, fields: chosen });
      updated += 1;
    }
  });
  run(targetIds);
  return { updated, skippedLocked };
}

/* ---------------------- invoice line collapsing ----------------------- */

export interface InvoiceLine {
  representative: ItemRow;
  members: ItemRow[];
  pieces: number;
}

/**
 * One line per article group, or per clone family, or per lone item — and `Pieces` is the
 * sum over the whole family.
 *
 * The seed plan dropped clone rows from the export. That would have under-reported every
 * shipment: a clone is a real physical garment, so it belongs in the quantity even though
 * it does not deserve a line of its own (plan §1 override 9, §7.3).
 */
export function collapseToLines(items: ItemRow[]): InvoiceLine[] {
  const byId = new Map(items.map((i) => [i.apparel_id, i]));
  const keyOf = (item: ItemRow): string => {
    if (item.article_no) return `A:${item.article_no}`;
    // Walk to the root of the clone chain, staying inside the selected set.
    let cursor = item;
    const seen = new Set<string>();
    while (cursor.cloned_from && byId.has(cursor.cloned_from) && !seen.has(cursor.apparel_id)) {
      seen.add(cursor.apparel_id);
      cursor = byId.get(cursor.cloned_from)!;
    }
    return `C:${cursor.apparel_id}`;
  };

  const groups = new Map<string, ItemRow[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const lines: InvoiceLine[] = [];
  for (const [key, members] of groups) {
    // Prefer a non-clone as the representative; it carries the originally extracted data.
    const sorted = [...members].sort((a, b) => {
      if (!!a.cloned_from !== !!b.cloned_from) return a.cloned_from ? 1 : -1;
      return a.scanned_at.localeCompare(b.scanned_at);
    });
    const representative =
      key.startsWith('C:') ? (byId.get(key.slice(2)) ?? sorted[0]) : sorted[0];
    lines.push({
      representative,
      members,
      pieces: members.reduce((sum, m) => sum + (m.pieces || 1), 0),
    });
  }

  lines.sort((a, b) => a.representative.scanned_at.localeCompare(b.representative.scanned_at));
  return lines;
}
