import { getScansDb, openDashboardDb } from '../db';
import type { ItemRow } from '../types/item';

/**
 * Path B — enrichment from the middleware's server_scans.db (plan §5.2).
 *
 * The daily CSV ledger cannot carry confidence scores, `cloned_from`, photo paths or the
 * PARKED flag. Every one of those is needed: confidences drive "identify uncertain
 * information", `cloned_from` drives every export preset, and PARKED closes the review gap
 * recorded in the middleware's own dev_report §16.9.
 *
 * The client confirmed on 2026-08-30 that the two always run on one server, so this is the
 * sanctioned path rather than a fallback. It is still written defensively: every column it
 * fills is nullable, and a missing database degrades the dashboard instead of failing it.
 */

interface ScanRow {
  apparel_id: string;
  cloned_from: string | null;
  raw_json_data: string;
  key_photo_path: string | null;
  image_paths: string | null;
  catalog_image_url: string | null;
  rendering_status: string | null;
  extraction_status: string | null;
}

/** The middleware stores { value, confidence } per field; we keep the confidences. */
function confidencesFrom(rawJson: string): { map: Record<string, number>; min: number | null } {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const map: Record<string, number> = {};
    for (const [field, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object' && 'confidence' in (v as object)) {
        const c = Number((v as { confidence: unknown }).confidence);
        if (Number.isFinite(c)) map[field] = c;
      }
    }
    const values = Object.values(map);
    return { map, min: values.length ? Math.min(...values) : null };
  } catch {
    return { map: {}, min: null };
  }
}

export interface EnrichResult {
  attempted: number;
  enriched: number;
  available: boolean;
}

/**
 * Fill the middleware-sourced columns for the given items. Safe to re-run: it only ever
 * writes columns the middleware owns, and never touches a value a person edited.
 */
export function enrichFromScans(apparelIds: string[]): EnrichResult {
  const scans = getScansDb();
  if (!scans) return { attempted: apparelIds.length, enriched: 0, available: false };

  const dash = openDashboardDb();
  let enriched = 0;

  const select = scans.prepare(
    `SELECT apparel_id, cloned_from, raw_json_data, key_photo_path, image_paths,
            catalog_image_url, rendering_status, extraction_status
       FROM server_scans WHERE apparel_id = ?`,
  );
  const update = dash.prepare(
    `UPDATE items
        SET cloned_from       = COALESCE(?, cloned_from),
            confidence_json   = ?,
            min_confidence    = ?,
            key_photo_path    = COALESCE(?, key_photo_path),
            image_paths_json  = COALESCE(?, image_paths_json),
            catalog_image_url = COALESCE(?, catalog_image_url),
            rendering_status  = COALESCE(?, rendering_status),
            review_state      = CASE WHEN ? = 'PARKED' THEN 'PARKED' ELSE review_state END
      WHERE apparel_id = ?`,
  );

  const run = dash.transaction((ids: string[]) => {
    for (const id of ids) {
      let scan: ScanRow | undefined;
      try {
        scan = select.get(id) as ScanRow | undefined;
      } catch {
        return; // table shape changed or database vanished mid-run; leave the rest alone
      }
      if (!scan) continue;
      const { map, min } = confidencesFrom(scan.raw_json_data);
      update.run(
        scan.cloned_from,
        Object.keys(map).length ? JSON.stringify(map) : null,
        min,
        scan.key_photo_path,
        scan.image_paths,
        scan.catalog_image_url,
        scan.rendering_status,
        scan.extraction_status,
        id,
      );
      enriched += 1;
    }
  });

  try {
    run(apparelIds);
  } catch (err) {
    console.warn(`[enrich] ${(err as Error).message}`);
  }
  return { attempted: apparelIds.length, enriched, available: true };
}

/** Rows still missing middleware data — a scan may be extracted after the ledger was cut. */
export function pendingEnrichment(limit = 500): string[] {
  return (
    openDashboardDb()
      .prepare(
        `SELECT apparel_id FROM items
          WHERE deleted_at IS NULL
            AND (confidence_json IS NULL OR catalog_image_url IS NULL)
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ apparel_id: string }>
  ).map((r) => r.apparel_id);
}

/** Parked scans the middleware is holding, whether or not the ledger reached us yet. */
export function parkedScans(): Array<{ apparel_id: string; extraction_error: string | null }> {
  const scans = getScansDb();
  if (!scans) return [];
  try {
    return scans
      .prepare(
        `SELECT apparel_id, extraction_error FROM server_scans
          WHERE extraction_status = 'PARKED' ORDER BY created_at DESC`,
      )
      .all() as Array<{ apparel_id: string; extraction_error: string | null }>;
  } catch {
    return [];
  }
}

export function scansAvailable(): boolean {
  return getScansDb() !== null;
}

export function itemFromScans(apparelId: string): Partial<ItemRow> | null {
  const scans = getScansDb();
  if (!scans) return null;
  try {
    const row = scans.prepare('SELECT * FROM server_scans WHERE apparel_id = ?').get(apparelId) as
      | ScanRow
      | undefined;
    if (!row) return null;
    const { map, min } = confidencesFrom(row.raw_json_data);
    return {
      apparel_id: row.apparel_id,
      cloned_from: row.cloned_from,
      confidence_json: JSON.stringify(map),
      min_confidence: min,
      key_photo_path: row.key_photo_path,
      image_paths_json: row.image_paths,
      catalog_image_url: row.catalog_image_url,
      rendering_status: row.rendering_status,
    };
  } catch {
    return null;
  }
}
