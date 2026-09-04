import { logger } from './logger';

/**
 * Fibre-composition segmentation — the one parser.
 *
 * `material` is not a table key, it is a sentence: "80% Cotton 20% Polyester".
 * Three call sites need to reach the individual fibre names inside it:
 *
 *   1. normalisation      — snap each fibre onto the 85-entry material table so
 *                           the same fibre always arrives spelled the same way
 *                           (api_contract.md v1.4 §8.1)
 *   2. `data_hy`          — render the composition in Armenian for the operator
 *   3. the legal export   — the same, in the customs wording
 *
 * All three split the string the same way, so they share this module rather than
 * carrying three regexes that can drift apart.
 *
 * **The split is lossless.** A segment keeps the separator, percentage and
 * spacing that surrounded it, so `prefix + fibre + suffix` concatenated over
 * every segment reproduces the input byte for byte. That is what lets
 * `mapComposition()` swap fibre names without touching the operator's
 * punctuation: `40% Cotton 40% Nylon 20% Elastane` comes back with its spaces,
 * not rejoined with commas the label never printed.
 */

/** One fibre of a composition, with everything printed around it preserved. */
export interface CompositionSegment {
  /** Separator, leading percentage and spacing that came before the fibre. */
  prefix: string;
  /** The fibre name as printed, trimmed. May be '' for a stray separator. */
  fibre: string;
  /** Trailing percentage and spacing that came after the fibre. */
  suffix: string;
  /** The percentage token as printed ('80%', '12,5 %'), or '' when absent. */
  percentage: string;
}

/**
 * Segment boundaries: an explicit separator, or the whitespace immediately
 * before a "NN%" token — run-on compositions ("38% Cotton 27% Wool") print no
 * separator at all. The capture group keeps the separator in the split output.
 */
const BOUNDARY = /(\s*[,;/]+\s*|\s+(?=\d+(?:[.,]\d+)?\s*%))/;

const LEADING_PERCENT = /^\s*\d+(?:[.,]\d+)?\s*%\s*/;
const TRAILING_PERCENT = /\s*\d+(?:[.,]\d+)?\s*%\s*$/;

/**
 * Splits a composition into one segment per fibre.
 *
 * An empty or whitespace-only input yields no segments; a single fibre with no
 * percentage ("Leather", the footwear inference) yields exactly one, which is
 * why a shoe material still reaches the matcher unchanged.
 */
export function splitComposition(text: string): CompositionSegment[] {
  if (!text) return [];

  const parts = text.split(BOUNDARY);
  const segments: CompositionSegment[] = [];
  let separator = '';

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    // Odd indexes are the captured separators; they belong to the NEXT segment.
    if (i % 2 === 1) {
      separator += part;
      continue;
    }
    if (part === '' && separator === '') continue;
    segments.push(parseSegment(separator, part));
    separator = '';
  }

  // A trailing separator with nothing after it still has to be reproduced.
  if (separator !== '') {
    if (segments.length > 0) segments[segments.length - 1]!.suffix += separator;
    else segments.push({ prefix: separator, fibre: '', suffix: '', percentage: '' });
  }

  return segments;
}

function parseSegment(separator: string, body: string): CompositionSegment {
  let prefix = separator;
  let suffix = '';
  let percentage = '';
  let rest = body;

  // A percentage sits before the fibre ("80% Cotton") far more often than after
  // it ("Cotton 80%"), but labels print both.
  const leading = rest.match(LEADING_PERCENT);
  if (leading) {
    prefix += leading[0];
    percentage = leading[0].trim();
    rest = rest.slice(leading[0].length);
  } else {
    const trailing = rest.match(TRAILING_PERCENT);
    if (trailing) {
      suffix = trailing[0] + suffix;
      percentage = trailing[0].trim();
      rest = rest.slice(0, rest.length - trailing[0].length);
    }
  }

  if (rest.trim() === '') {
    return { prefix: prefix + rest, fibre: '', suffix, percentage };
  }

  const lead = /^\s*/.exec(rest)![0];
  const trail = /\s*$/.exec(rest)![0];
  return {
    prefix: prefix + lead,
    fibre: rest.slice(lead.length, rest.length - trail.length),
    suffix: trail + suffix,
    percentage,
  };
}

/**
 * Rebuilds the composition with each fibre name replaced by `replace(fibre)`.
 * Returning null (or the same string) leaves that fibre exactly as printed.
 *
 * Percentages are transcribed, never computed: nothing here sums, normalises or
 * reorders them, because a composition the operator can check against the label
 * is worth more than a tidy one.
 */
export function mapComposition(
  segments: readonly CompositionSegment[],
  replace: (fibre: string) => string | null,
): string {
  return segments
    .map((segment) => {
      if (!segment.fibre) return segment.prefix + segment.suffix;
      const replacement = replace(segment.fibre);
      return segment.prefix + (replacement ?? segment.fibre) + segment.suffix;
    })
    .join('');
}

/**
 * Rebuilds the composition as a comma-separated list — `80% Բամբակ, 20%
 * Պոլիեսթեր`. Used for the Armenian renderings, where the source punctuation is
 * an artefact of the label rather than something the operator should read back.
 * The English value keeps the label's own spacing instead; see `mapComposition`.
 */
export function joinComposition(
  segments: readonly CompositionSegment[],
  replace: (fibre: string) => string | null,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const rendered: string[] = [];

  for (const segment of segments) {
    if (!segment.fibre) continue;
    const replacement = replace(segment.fibre);
    if (replacement === null) missing.push(segment.fibre);
    const name = replacement ?? segment.fibre;
    rendered.push(segment.percentage ? `${segment.percentage} ${name}` : name);
  }

  return { text: rendered.join(', '), missing };
}

/** Development guard: the split must be reversible, or a value would be lost. */
export function assertLossless(text: string): boolean {
  const rebuilt = mapComposition(splitComposition(text), () => null);
  if (rebuilt !== text) {
    logger.error(`Composition split was lossy: ${JSON.stringify(text)} -> ${JSON.stringify(rebuilt)}`);
    return false;
  }
  return true;
}
