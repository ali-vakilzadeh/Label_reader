import type { Db } from '../db';
import type { ItemRow } from '../types/item';
import type { SuggestionEngine, SuggestionContext, Suggestion } from './types';
import priceEngine from './price';
import weightEngine from './weight';
import hsCodeEngine from './hsCode';

export type { SuggestionEngine, SuggestionContext, Suggestion } from './types';
export { priceContext } from './price';

/**
 * The registry (plan §8.0). The only import path the rest of the application uses.
 *
 * Adding an engine: write the file, add it to this array. Removing one: delete the file
 * and its line. Nothing else in the codebase references an engine by name.
 */
const ENGINES: SuggestionEngine[] = [priceEngine, weightEngine, hsCodeEngine];

export function listEngines(): Array<{ id: string; version: string; targets: string[] }> {
  return ENGINES.map((e) => ({ id: e.id, version: e.version, targets: e.targets.map(String) }));
}

/** Column writes each engine's result maps to. The registry owns this, not the engine. */
function applySuggestion(engineId: string, s: Suggestion, patch: Record<string, unknown>): void {
  switch (engineId) {
    case 'price':
      patch.suggested_price = Number(s.value);
      patch.suggested_price_basis = s.basis;
      patch.suggested_price_n = s.n;
      break;
    case 'weight':
      patch.suggested_netto_g = Number(s.value);
      patch.suggested_brutto_g = s.value2 === null || s.value2 === undefined ? null : Number(s.value2);
      patch.weight_suggestion_basis = `${s.basis} (n=${s.n})`;
      break;
    case 'hs_code':
      // A suggested HS code is written into hs_code itself, but stamped with its source
      // so the UI can show it as a suggestion and never mistake it for a human decision.
      patch.hs_code = String(s.value);
      patch.hs_code_src = s.basis.startsWith('rule') ? 'RULE' : 'HISTORY';
      patch.hs_code_basis = `${s.basis} (n=${s.n})`;
      break;
  }
}

/**
 * Run every applicable engine for one item and return the column patch.
 *
 * The caller writes it, inside its own transaction — an engine can never half-update a
 * row. Human-set values are protected by each engine's `appliesTo`, and again here.
 */
export function computeSuggestions(
  item: ItemRow,
  db: Db,
  settings: Record<string, string>,
  log: (m: string) => void = () => {},
): Record<string, unknown> {
  const ctx: SuggestionContext = { db, settings, now: new Date(), log };
  const patch: Record<string, unknown> = {};
  const versions: Record<string, string> = {};

  for (const engine of ENGINES) {
    // Never overwrite a value a human has set.
    if (engine.id === 'hs_code' && item.hs_code_src === 'MANUAL') continue;
    if (!engine.appliesTo(item)) continue;

    let result: Suggestion | null = null;
    try {
      result = engine.suggest(item, ctx);
    } catch (err) {
      log(`[suggest:${engine.id}] ${item.apparel_id}: ${(err as Error).message}`);
      continue;
    }
    if (!result) continue;

    // A number without a defensible basis has no business on an invoice.
    if (!result.basis || !Number.isFinite(result.n)) {
      log(`[suggest:${engine.id}] dropped a result with no basis or sample size`);
      continue;
    }

    applySuggestion(engine.id, result, patch);
    versions[engine.id] = engine.version;
  }

  if (Object.keys(versions).length) patch.suggestion_versions_json = JSON.stringify(versions);
  return patch;
}
