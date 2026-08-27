/**
 * Gemini error classification.
 *
 * The API returns HTTP 429 / RESOURCE_EXHAUSTED for two completely different
 * situations: a per-minute burst limit that clears in seconds, and a plan that
 * does not cover the model at all. Treating them alike is the difference between
 * a brief pause and hammering a wall forever, so the distinction is made here
 * once and every caller reads the classification rather than the raw error.
 *
 * The discriminator lives in `error.details[]`, not in the message string:
 *
 *   google.rpc.QuotaFailure  violations[].quotaId  -> which window was hit
 *   google.rpc.RetryInfo     retryDelay            -> server's suggested wait
 *
 * Trap: when the plan excludes a model the API still returns a RetryInfo
 * ("Please retry in 43.4s") alongside "limit: 0". That retryDelay is a lie —
 * `limit: 0` means no amount of waiting will help, so the limit-zero test runs
 * before the retryDelay is trusted.
 */

/** Stable codes. These are part of the UI contract — never renumber or rename. */
export const GEMINI_FAULTS = [
  'VISION_OK',
  'VISION_TRANSIENT',
  'VISION_NETWORK',
  'VISION_RATE_LIMIT_MINUTE',
  'VISION_RATE_LIMIT_DAY',
  'VISION_BILLING_REQUIRED',
  'VISION_BAD_CREDENTIALS',
  'VISION_MODEL_UNAVAILABLE',
  'VISION_REQUEST_REJECTED',
  'VISION_UNKNOWN',
] as const;

export type GeminiFault = (typeof GEMINI_FAULTS)[number];

/** How the caller should behave. */
export type FaultDisposition =
  /** Retry with backoff; it will probably clear on its own. */
  | 'RETRY'
  /** Retry, but not before `retryAfterMs`. */
  | 'RETRY_AFTER'
  /** Stop calling Gemini. A human must change something first. */
  | 'HALT'
  /** This specific request will never succeed; other requests are fine. */
  | 'REJECT';

export interface GeminiClassification {
  fault: GeminiFault;
  disposition: FaultDisposition;
  /** HTTP status, when one was returned. */
  httpStatus: number | null;
  /** Google's canonical status string, e.g. RESOURCE_EXHAUSTED. */
  apiStatus: string | null;
  /** Server-suggested wait, in ms, when trustworthy. */
  retryAfterMs: number | null;
  /** Short operator-facing summary; the full text lives in the message dictionary. */
  detail: string;
  /** Quota identifiers that were violated, for diagnostics. */
  quotaIds: string[];
}

interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
}

/** The SDK stringifies the JSON envelope into Error.message; other layers throw plain objects. */
function parseEnvelope(error: unknown): GoogleErrorEnvelope['error'] | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as Record<string, unknown>;

  // Some SDK paths attach the parsed body directly.
  if (candidate.error && typeof candidate.error === 'object') {
    return candidate.error as GoogleErrorEnvelope['error'];
  }

  const message = typeof candidate.message === 'string' ? candidate.message : null;
  if (message) {
    const start = message.indexOf('{');
    if (start !== -1) {
      try {
        const parsed = JSON.parse(message.slice(start)) as GoogleErrorEnvelope;
        if (parsed.error) return parsed.error;
      } catch {
        /* not a JSON envelope */
      }
    }
  }

  // Bare status/code on the error object.
  const code = typeof candidate.status === 'number' ? candidate.status : undefined;
  if (code !== undefined) return { code, message: message ?? undefined };

  return null;
}

function detailsOfType(
  details: Array<Record<string, unknown>> | undefined,
  suffix: string,
): Record<string, unknown> | null {
  if (!details) return null;
  for (const entry of details) {
    const type = entry['@type'];
    if (typeof type === 'string' && type.endsWith(suffix)) return entry;
  }
  return null;
}

/** "43.410718034s" / "43s" -> milliseconds. */
export function parseRetryDelay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Math.round(Number(match[1]) * 1000);
}

function isNetworkError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code;
  if (typeof code === 'string' && /UND_ERR|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /fetch failed|network|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message);
}

/**
 * Maps any thrown value onto a stable fault code and a disposition.
 * Never throws; an unrecognised failure classifies as VISION_UNKNOWN/RETRY so
 * the system errs toward retrying rather than silently discarding work.
 */
export function classifyGeminiError(error: unknown): GeminiClassification {
  const base = {
    httpStatus: null as number | null,
    apiStatus: null as string | null,
    retryAfterMs: null as number | null,
    quotaIds: [] as string[],
  };

  if (isNetworkError(error)) {
    return {
      ...base,
      fault: 'VISION_NETWORK',
      disposition: 'RETRY',
      detail: 'Could not reach the vision API (network or DNS failure).',
    };
  }

  const envelope = parseEnvelope(error);
  if (!envelope) {
    return {
      ...base,
      fault: 'VISION_UNKNOWN',
      disposition: 'RETRY',
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }

  const httpStatus = typeof envelope.code === 'number' ? envelope.code : null;
  const apiStatus = typeof envelope.status === 'string' ? envelope.status : null;
  const message = envelope.message ?? '';

  const quotaFailure = detailsOfType(envelope.details, 'QuotaFailure');
  const violations = Array.isArray(quotaFailure?.violations)
    ? (quotaFailure!.violations as Array<Record<string, unknown>>)
    : [];
  const quotaIds = violations
    .map((violation) => violation.quotaId)
    .filter((id): id is string => typeof id === 'string');

  const retryInfo = detailsOfType(envelope.details, 'RetryInfo');
  const retryAfterMs = parseRetryDelay(retryInfo?.retryDelay);

  const shaped = { ...base, httpStatus, apiStatus, quotaIds };

  // --- 429: the ambiguous one -------------------------------------------
  if (httpStatus === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    // "limit: 0" means the plan does not include this model. The RetryInfo the
    // API sends alongside it is misleading and must be ignored.
    if (/limit:\s*0\b/.test(message)) {
      return {
        ...shaped,
        fault: 'VISION_BILLING_REQUIRED',
        disposition: 'HALT',
        detail:
          'The API plan does not include this model (quota limit is 0). ' +
          'Enable billing or switch models — waiting will not help.',
      };
    }

    if (quotaIds.some((id) => /PerDay/i.test(id))) {
      return {
        ...shaped,
        fault: 'VISION_RATE_LIMIT_DAY',
        disposition: 'HALT',
        detail: 'Daily request quota exhausted. It resets on Google\'s daily boundary.',
      };
    }

    return {
      ...shaped,
      retryAfterMs: retryAfterMs ?? 60_000,
      fault: 'VISION_RATE_LIMIT_MINUTE',
      disposition: 'RETRY_AFTER',
      detail: 'Per-minute rate limit reached; backing off briefly.',
    };
  }

  // --- permanent configuration faults ------------------------------------
  if (httpStatus === 400 && /api key not valid/i.test(message)) {
    return {
      ...shaped,
      fault: 'VISION_BAD_CREDENTIALS',
      disposition: 'HALT',
      detail: 'GEMINI_API_KEY is not valid. Update the key and reload settings.',
    };
  }

  if (httpStatus === 401 || httpStatus === 403 || apiStatus === 'PERMISSION_DENIED') {
    return {
      ...shaped,
      fault: 'VISION_BAD_CREDENTIALS',
      disposition: 'HALT',
      detail: 'The vision API rejected the credentials (missing or unauthorised key).',
    };
  }

  if (httpStatus === 404 || apiStatus === 'NOT_FOUND') {
    return {
      ...shaped,
      fault: 'VISION_MODEL_UNAVAILABLE',
      disposition: 'HALT',
      detail: `The configured model is unavailable: ${message.slice(0, 160)}`,
    };
  }

  // --- per-request rejections: other scans are unaffected -----------------
  if (httpStatus === 400 || apiStatus === 'INVALID_ARGUMENT') {
    return {
      ...shaped,
      fault: 'VISION_REQUEST_REJECTED',
      disposition: 'REJECT',
      detail: `The vision API rejected this request: ${message.slice(0, 160)}`,
    };
  }

  // --- transient backend faults -------------------------------------------
  if (httpStatus !== null && httpStatus >= 500) {
    return {
      ...shaped,
      retryAfterMs,
      fault: 'VISION_TRANSIENT',
      disposition: retryAfterMs === null ? 'RETRY' : 'RETRY_AFTER',
      detail: 'The vision service is temporarily unavailable (demand spike or backend fault).',
    };
  }

  if (httpStatus === 408) {
    return { ...shaped, fault: 'VISION_TRANSIENT', disposition: 'RETRY', detail: 'Request timed out.' };
  }

  return {
    ...shaped,
    fault: 'VISION_UNKNOWN',
    disposition: 'RETRY',
    detail: message.slice(0, 200) || 'Unrecognised vision API failure.',
  };
}

/** True when the fault requires a human before any further call can succeed. */
export function requiresHumanAction(classification: GeminiClassification): boolean {
  return classification.disposition === 'HALT';
}
