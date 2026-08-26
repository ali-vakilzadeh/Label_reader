import type { ConfidenceField } from '../types';

/**
 * Weight resolution (contract rule):
 *   2 weights -> MAX becomes brutto, MIN becomes netto
 *   1 weight  -> netto = brutto = that value
 *   0 weights -> netto = brutto = "" with 0.0 confidence
 *
 * Scale displays are photographed in mixed units, so values are compared on a
 * normalised gram magnitude while the operator-facing string is preserved
 * verbatim (the ledger and CSV export expect "240g", not 240).
 */

const EMPTY: ConfidenceField = { value: '', confidence: 0 };

const UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  gr: 1,
  gm: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilogram: 1000,
  kilograms: 1000,
  mg: 0.001,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
};

/** Parses "1,24 kg" / "240g" / "0.55 LB" into grams; null when unreadable. */
export function toGrams(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/,/g, '.');
  const match = cleaned.match(/(-?\d+(?:\.\d+)?)\s*([a-z]*)/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2] ?? '';
  // A bare number on a scale display is grams by warehouse convention.
  const multiplier = unit === '' ? 1 : UNIT_TO_GRAMS[unit];
  if (multiplier === undefined) return null;

  return amount * multiplier;
}

export interface ResolvedWeights {
  netto: ConfidenceField;
  brutto: ConfidenceField;
}

export function resolveWeights(weights: ConfidenceField[] | undefined): ResolvedWeights {
  const usable = (weights ?? []).filter(
    (weight) => typeof weight?.value === 'string' && weight.value.trim() !== '',
  );

  if (usable.length === 0) {
    return { netto: { ...EMPTY }, brutto: { ...EMPTY } };
  }

  if (usable.length === 1) {
    const only = usable[0]!;
    const field: ConfidenceField = {
      value: only.value.trim(),
      confidence: clampConfidence(only.confidence),
    };
    return { netto: { ...field }, brutto: { ...field } };
  }

  // 2+ readings: the heaviest is gross, the lightest is net. Extra readings
  // (a mis-fired third capture) collapse into the same min/max rule.
  const ranked = usable
    .map((weight) => ({ weight, grams: toGrams(weight.value) }))
    .sort((a, b) => (a.grams ?? Number.POSITIVE_INFINITY) - (b.grams ?? Number.POSITIVE_INFINITY));

  const min = ranked[0]!.weight;
  const max = ranked[ranked.length - 1]!.weight;

  return {
    netto: { value: min.value.trim(), confidence: clampConfidence(min.confidence) },
    brutto: { value: max.value.trim(), confidence: clampConfidence(max.confidence) },
  };
}

export function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, Number(numeric.toFixed(4))));
}
