/**
 * Value normalisation for imported ledger rows (plan §5.1 step 4).
 *
 * The governing rule: an empty value stays empty. It never becomes 0, and it never
 * becomes a guess. A zero weight or a zero price on a customs form is worse than a
 * blank one, because a blank is visibly missing and a zero is silently wrong.
 */

export function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** "240g" · "0.24kg" · "240" · "240 g" · "1,2 kg" -> grams. Null when not parseable. */
export function parseWeightToGrams(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  const m = s.match(/^([0-9]*\.?[0-9]+)(kg|kgs|g|gr|grams?)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2] ?? 'g';
  const grams = unit.startsWith('k') ? value * 1000 : value;
  return Math.round(grams * 100) / 100;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  '₽': 'RUB',
  '֏': 'AMD',
  '₴': 'UAH',
  '₺': 'TRY',
};

/** "€79.90" · "79,90 EUR" · "$45.00" -> { value, currency }. Either half may be null. */
export function parsePrice(raw: string | null): { value: number | null; currency: string | null } {
  if (!raw) return { value: null, currency: null };
  const s = raw.trim();

  let currency: string | null = null;
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (s.includes(sym)) {
      currency = code;
      break;
    }
  }
  if (!currency) {
    const iso = s.match(/\b(EUR|USD|GBP|AMD|RUB|UAH|TRY|PLN|CHF)\b/i);
    if (iso) currency = iso[1].toUpperCase();
  }

  // Strip everything but digits and separators, then decide which separator is decimal.
  const numeric = s.replace(/[^0-9.,]/g, '');
  if (!numeric) return { value: null, currency };
  let cleaned = numeric;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal separator; the other groups thousands.
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    cleaned = cleaned.replace(',', '.');
  }
  const value = Number(cleaned);
  return { value: Number.isFinite(value) ? value : null, currency };
}

/** "2026-08-28 14:30:00" or an ISO string -> ISO 8601. Returns null if unusable. */
export function parseTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const sqlish = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (sqlish) {
    const [, y, mo, d, h, mi, sec] = sqlish;
    return `${y}-${mo}-${d}T${h}:${mi}:${sec ?? '00'}`;
  }
  const dotted = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); // the client's DD.MM.YYYY
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}T00:00:00`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19);
  return null;
}

/** ISO 8601 -> DD.MM.YYYY, the format in the client's own invoice files. */
export function toClientDate(iso: string | null): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

export function formatEpoch(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** "2 h 14 m", "45 s" — for fault durations and uptime. */
export function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function median(values: number[]): number | null {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function monthsBetween(isoFrom: string, to: Date = new Date()): number {
  const from = new Date(isoFrom);
  if (Number.isNaN(from.getTime())) return 0;
  return Math.max(0, (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
}
