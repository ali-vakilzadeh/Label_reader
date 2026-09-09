/**
 * The sync engine's decision rules.
 *
 * These branches only fire against a contract v1.4 server. The deployed middleware is
 * still on v1.2 and returns no `care_info`, no `data_hy` and no
 * `suggested_key_photo_index`, so none of this can be checked by using the app - which
 * is exactly why it is checked here.
 *
 *   npm test
 */
import {
  clampPollSeconds,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  pollDelaySeconds,
  resolveCareInfo,
  resolveKeyPhotoIndex
} from '../src/services/syncRules';

let passed = 0;
let failed = 0;

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}`);
    console.log(`          actual   ${JSON.stringify(actual)}`);
  }
}

const photos = (n: number) => Array.from({ length: n }, (_, i) => `data:image/jpeg;base64,IMG${i}`);

// ---------------------------------------------------------------- key photo --

section('Key photo: a default yields to the model, a choice does not');

check(
  'no operator choice -> the suggestion is taken',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(4) }, 2),
  2
);

check(
  'a legacy record with no flag counts as no choice',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: undefined, photos: photos(4) }, 3),
  3
);

check(
  'the operator starred one -> the suggestion is ignored',
  resolveKeyPhotoIndex({ keyPhotoIndex: 1, keyPhotoExplicit: true, photos: photos(4) }, 2),
  1
);

check(
  'no suggestion (null) -> the default stands',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(4) }, null),
  0
);

check(
  'a pre-v1.4 server sends nothing -> the default stands',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(4) }, undefined),
  0
);

check(
  'an index past the end of the batch is refused, not clamped',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(3) }, 7),
  0
);

check(
  'a negative index is refused',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(3) }, -1),
  0
);

check(
  'a fractional index is refused',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(3) }, 1.5),
  0
);

check(
  'suggesting the photo already selected is a no-op',
  resolveKeyPhotoIndex({ keyPhotoIndex: 0, keyPhotoExplicit: false, photos: photos(3) }, 0),
  0
);

// ---------------------------------------------------------------- care info --

section('care_info: the device beats the model');

check(
  'a QR decoded on the device survives the AI result',
  resolveCareInfo({ deviceCareInfo: 'https://care.example.com/real' }, 'https://care.example.com/hallucinated'),
  { value: 'https://care.example.com/real', fromDevice: true }
);

check(
  'the AI value is erased even when the device read is the only one',
  resolveCareInfo({ deviceCareInfo: 'https://care.example.com/real' }, ''),
  { value: 'https://care.example.com/real', fromDevice: true }
);

check(
  'no device read -> the AI value is used',
  resolveCareInfo({ deviceCareInfo: undefined }, 'https://care.example.com/ai'),
  { value: 'https://care.example.com/ai', fromDevice: false }
);

check(
  'an empty device read does not blank a good AI value',
  resolveCareInfo({ deviceCareInfo: '' }, 'https://care.example.com/ai'),
  { value: 'https://care.example.com/ai', fromDevice: false }
);

check(
  'whitespace is not a device read',
  resolveCareInfo({ deviceCareInfo: '   ' }, 'https://care.example.com/ai'),
  { value: 'https://care.example.com/ai', fromDevice: false }
);

check(
  'neither side has one -> empty, as the contract defines an unreadable field',
  resolveCareInfo({ deviceCareInfo: undefined }, ''),
  { value: '', fromDevice: false }
);

// ------------------------------------------------------------------ polling --

section('Polling honours the server, section 5.1 and 5.4');

check('the server asks for 60s and gets 60s', pollDelaySeconds({ retry_after_seconds: 60 }), 60);

check(
  'a paused queue backs off to the ceiling whatever it asked for',
  pollDelaySeconds({ retry_after_seconds: 5, blocking_fault: 'VISION_BILLING_REQUIRED' }),
  MAX_POLL_SECONDS
);

check(
  'no blocking fault means the ordinary cadence',
  pollDelaySeconds({ retry_after_seconds: 30, blocking_fault: null }),
  30
);

check('a missing hint falls to the floor, never to zero', clampPollSeconds(undefined), MIN_POLL_SECONDS);
check('zero is not a licence to poll continuously', clampPollSeconds(0), MIN_POLL_SECONDS);
check('a negative hint is refused', clampPollSeconds(-30), MIN_POLL_SECONDS);
check('below the floor is raised to it', clampPollSeconds(2), MIN_POLL_SECONDS);
check('above the ceiling is lowered to it', clampPollSeconds(600), MAX_POLL_SECONDS);
check('a fractional hint is floored, not rounded up', clampPollSeconds(42.9), 42);
check('NaN cannot become a poll interval', clampPollSeconds(Number.NaN), MIN_POLL_SECONDS);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
