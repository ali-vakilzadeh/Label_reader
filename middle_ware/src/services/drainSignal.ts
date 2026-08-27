/**
 * One-way nudge from the request path to the drain worker.
 *
 * `visionService` wants to say "there is new work" the moment a scan is
 * accepted, but the drain worker already imports `visionService` to run an
 * extraction. Importing back would be a cycle, so the signal goes through this
 * dependency-free module instead: the worker registers a handler at start-up,
 * the request path fires it, and neither module knows about the other.
 */

type DrainHandler = () => void;

let handler: DrainHandler | null = null;

export function onDrainRequested(fn: DrainHandler | null): void {
  handler = fn;
}

/**
 * Fire-and-forget. Never throws and never blocks the caller: a scan is already
 * durably stored by the time this runs, so a failed nudge only means the queue
 * waits for its next scheduled sweep.
 */
export function requestDrain(): void {
  if (!handler) return;
  try {
    handler();
  } catch {
    /* the scheduled sweep will pick the work up regardless */
  }
}
