/**
 * The decisions the sync engine makes when a response envelope lands.
 *
 * They live apart from `syncEngine.ts` because that module reaches IndexedDB the
 * moment it is imported, and these three rules are the part worth checking: they
 * govern branches that only fire against a v1.4 server, which is not what is
 * deployed today. Pure functions, no I/O - see `tests/syncRules.test.ts`.
 */
import type { AsyncVisionResponse, ScanEntity } from '../types/models';

/** What a scan needs to have in order for these rules to apply to it. */
type KeyPhotoInput = Pick<ScanEntity, 'keyPhotoIndex' | 'keyPhotoExplicit' | 'photos'>;
type CareInfoInput = Pick<ScanEntity, 'deviceCareInfo'>;

/** Contract section 5.1: retry_after_seconds is clamped to this window. */
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 120;

/**
 * The key photo after a result lands.
 *
 * The operator's own choice is the authority and is never overwritten (contract
 * section 4.2). But when nobody chose - the app defaulted to the first photo taken -
 * the model's suggestion is the better answer, so it takes over.
 *
 * An index outside the batch is ignored rather than clamped: a suggestion pointing at
 * a photo that is not there means the server and the device disagree about the batch,
 * and quietly picking a neighbour would hide that.
 */
export function resolveKeyPhotoIndex(
  scan: KeyPhotoInput,
  suggested: number | null | undefined
): number {
  if (scan.keyPhotoExplicit) return scan.keyPhotoIndex;
  if (typeof suggested !== 'number' || !Number.isInteger(suggested)) return scan.keyPhotoIndex;
  if (suggested < 0 || suggested >= scan.photos.length) return scan.keyPhotoIndex;
  return suggested;
}

export interface CareInfoDecision {
  value: string;
  /** True when the device's own QR read displaced the model's. */
  fromDevice: boolean;
}

/**
 * `care_info` after a result lands.
 *
 * A QR the device decoded itself beats the model's reading of the same code. The
 * scanner either resolves the symbol or reports nothing; Gemini can return a
 * well-formed URL that is simply wrong, and no operator can catch that by eye
 * (api_contract.md section 8.4). So the device value wins outright where it exists.
 */
export function resolveCareInfo(scan: CareInfoInput, aiValue: string): CareInfoDecision {
  const device = scan.deviceCareInfo?.trim();
  if (device) return { value: device, fromDevice: true };
  return { value: aiValue, fromDevice: false };
}

/**
 * How long to wait before polling this scan again.
 *
 * Contract section 5.1: honour `retry_after_seconds`, never poll faster. Section 5.4:
 * when processing is paused the wait is operator-dependent, so back off to the ceiling
 * instead of asking again on the server's usual cadence.
 */
export function pollDelaySeconds(
  response: Pick<AsyncVisionResponse, 'retry_after_seconds' | 'blocking_fault'>
): number {
  if (response.blocking_fault) return MAX_POLL_SECONDS;
  return clampPollSeconds(response.retry_after_seconds);
}

/** The contract's 5-120s window, with a safe floor for anything missing or absurd. */
export function clampPollSeconds(seconds: number | undefined | null): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return MIN_POLL_SECONDS;
  }
  return Math.max(MIN_POLL_SECONDS, Math.min(MAX_POLL_SECONDS, Math.floor(seconds)));
}
