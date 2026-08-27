/**
 * Classifier checks built from real payloads captured from the live Gemini API
 * (see dev_report.md §1). Usage: npx tsx tests/errorClassification.ts
 */
import { classifyGeminiError, parseRetryDelay } from '../src/services/geminiErrors';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}

/** Rebuilds an SDK-style error: the JSON envelope stringified into .message. */
function sdkError(envelope: unknown): Error {
  return new Error(JSON.stringify(envelope));
}

// ---------------------------------------------------------------------------
// Verbatim from the live API: image model on a plan that excludes it.
const BILLING_ENVELOPE = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. ' +
      '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-flash-image\n' +
      '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image\n' +
      'Please retry in 43.410718034s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          { quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' },
          { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' },
          { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43s' },
    ],
  },
};

console.log('\n== Billing exhaustion (limit: 0) ==');
const billing = classifyGeminiError(sdkError(BILLING_ENVELOPE));
check('classified as VISION_BILLING_REQUIRED', billing.fault === 'VISION_BILLING_REQUIRED', billing.fault);
check('disposition is HALT', billing.disposition === 'HALT', billing.disposition);
check(
  'misleading retryDelay is NOT trusted',
  billing.retryAfterMs === null,
  billing.retryAfterMs,
);
check('quota ids captured for diagnostics', billing.quotaIds.length === 3, billing.quotaIds);

console.log('\n== Per-minute rate limit (real limit, not zero) ==');
const perMinute = classifyGeminiError(
  sdkError({
    error: {
      code: 429,
      message: 'Quota exceeded for metric: ..., limit: 60, model: gemini-3.7-flash',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
      ],
    },
  }),
);
check('classified as VISION_RATE_LIMIT_MINUTE', perMinute.fault === 'VISION_RATE_LIMIT_MINUTE', perMinute.fault);
check('disposition is RETRY_AFTER', perMinute.disposition === 'RETRY_AFTER', perMinute.disposition);
check('honours server retryDelay (12s)', perMinute.retryAfterMs === 12_000, perMinute.retryAfterMs);

console.log('\n== Daily quota ==');
const perDay = classifyGeminiError(
  sdkError({
    error: {
      code: 429,
      message: 'Quota exceeded, limit: 1500',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
        },
      ],
    },
  }),
);
check('classified as VISION_RATE_LIMIT_DAY', perDay.fault === 'VISION_RATE_LIMIT_DAY', perDay.fault);
check('disposition is HALT (not a seconds-scale wait)', perDay.disposition === 'HALT', perDay.disposition);

console.log('\n== Credentials ==');
const badKey = classifyGeminiError(
  sdkError({
    error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
  }),
);
check('invalid key -> VISION_BAD_CREDENTIALS', badKey.fault === 'VISION_BAD_CREDENTIALS', badKey.fault);
check('invalid key halts', badKey.disposition === 'HALT', badKey.disposition);

const denied = classifyGeminiError(
  sdkError({ error: { code: 403, message: "Method doesn't allow unregistered callers", status: 'PERMISSION_DENIED' } }),
);
check('403 -> VISION_BAD_CREDENTIALS', denied.fault === 'VISION_BAD_CREDENTIALS', denied.fault);

console.log('\n== Model configuration ==');
const retired = classifyGeminiError(
  sdkError({
    error: {
      code: 404,
      message: 'This model models/gemini-2.5-flash is no longer available to new users.',
      status: 'NOT_FOUND',
    },
  }),
);
check('retired model -> VISION_MODEL_UNAVAILABLE', retired.fault === 'VISION_MODEL_UNAVAILABLE', retired.fault);
check('retired model halts', retired.disposition === 'HALT', retired.disposition);

console.log('\n== Transient ==');
const busy = classifyGeminiError(
  sdkError({
    error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' },
  }),
);
check('503 -> VISION_TRANSIENT', busy.fault === 'VISION_TRANSIENT', busy.fault);
check('503 retries', busy.disposition === 'RETRY', busy.disposition);

console.log('\n== Network ==');
const netErr = Object.assign(new TypeError('fetch failed'), {
  cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
});
const net = classifyGeminiError(netErr);
check('connect timeout -> VISION_NETWORK', net.fault === 'VISION_NETWORK', net.fault);
check('network retries', net.disposition === 'RETRY', net.disposition);

console.log('\n== Per-request rejection ==');
const rejected = classifyGeminiError(
  sdkError({ error: { code: 400, message: 'Request contains an invalid image.', status: 'INVALID_ARGUMENT' } }),
);
check('bad image -> VISION_REQUEST_REJECTED', rejected.fault === 'VISION_REQUEST_REJECTED', rejected.fault);
check(
  'rejection does not halt the whole fleet',
  rejected.disposition === 'REJECT',
  rejected.disposition,
);

console.log('\n== Unknown input never throws ==');
check('undefined classifies', classifyGeminiError(undefined).fault === 'VISION_UNKNOWN');
check('string classifies', classifyGeminiError('boom').fault === 'VISION_UNKNOWN');
check('unknown errs toward RETRY', classifyGeminiError({}).disposition === 'RETRY');

console.log('\n== retryDelay parsing ==');
check('43.410718034s -> 43411ms', parseRetryDelay('43.410718034s') === 43411, parseRetryDelay('43.410718034s'));
check('43s -> 43000ms', parseRetryDelay('43s') === 43_000);
check('garbage -> null', parseRetryDelay('soon') === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
