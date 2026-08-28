import { env } from '../config/env';
import {
  initialiseStatus,
  listOpenEvents,
  markCommand,
  raiseEvent,
  readStatus,
  resolveEvent,
  setServerState,
  takePendingCommands,
  writeHeartbeat,
  type UiCommandRow,
} from '../db/controlDb';
import { UI_COMMANDS } from '../db/messageCatalogue';
import { clearExtractionBackoff, extractionCounts } from '../db/operationalDb';
import { countFlywheelRecords, purgeFlywheelThrough } from '../db/flywheelDb';
import {
  credentialSource,
  probeCredentials,
  reloadGeminiClient,
} from './geminiService';
import { seedTestAccounts } from '../db/appUsers';
import {
  applyVisionSettings,
  fingerprintOf,
  markPending,
  markSettingsInvalid,
  takePendingSettings,
} from '../db/visionSettings';
import { processPendingUserRequests } from './userService';
import { logger } from '../utils/logger';
import type { GeminiClassification } from './geminiErrors';

/**
 * Control plane: owns the pause state and the conversation with the Web UI.
 *
 * The pause decision lives in control.db rather than in memory, so a restart
 * cannot silently resume hammering an API that still needs a human. Everything
 * the UI needs to render is derived from that same table.
 */

/** Faults that stop vision calls until an operator acts. */
const HALTING_FAULTS = new Set([
  'VISION_BILLING_REQUIRED',
  'VISION_BAD_CREDENTIALS',
  'VISION_MODEL_UNAVAILABLE',
  'VISION_RATE_LIMIT_DAY',
  'VISION_NOT_CONFIGURED',
]);

let heartbeatTimer: NodeJS.Timeout | null = null;
let commandTimer: NodeJS.Timeout | null = null;

/** Set when a command asks for an immediate drain; read by the queue worker. */
let drainRequested = false;

export function consumeDrainRequest(): boolean {
  const requested = drainRequested;
  drainRequested = false;
  return requested;
}

// ------------------------------------------------------------ pause state --

export function isVisionPaused(): boolean {
  return readStatus().vision_state === 'PAUSED';
}

export function activeFault(): string | null {
  return readStatus().active_fault;
}

/**
 * Records the outcome of a vision call. A halting fault pauses processing and
 * raises an actionable event; a transient one is reported without pausing.
 */
export function reportVisionFault(classification: GeminiClassification): void {
  const { fault, detail } = classification;

  if (HALTING_FAULTS.has(fault)) {
    const alreadyPaused = isVisionPaused() && activeFault() === fault;
    setServerState('BLOCKED', 'PAUSED', fault, detail);
    raiseEvent(fault, detail, {
      httpStatus: classification.httpStatus,
      apiStatus: classification.apiStatus,
      quotaIds: classification.quotaIds,
    });
    if (!alreadyPaused) {
      raiseEvent('VISION_PAUSED', detail, { cause: fault });
      logger.error(`Vision PAUSED: ${fault} — ${detail}`);
    }
    return;
  }

  // Transient: stay running, but make the condition visible.
  if (!isVisionPaused()) {
    setServerState('RETRYING', 'OK', fault, detail);
  }
  raiseEvent(fault, detail, { httpStatus: classification.httpStatus });
}

/** A successful call clears transient faults. A pause is only lifted by a command. */
export function reportVisionSuccess(): void {
  const status = readStatus();
  if (status.vision_state === 'PAUSED') return;

  if (status.state !== 'OK' || status.active_fault !== null) {
    for (const event of listOpenEvents()) {
      if (event.code.startsWith('VISION_') && event.code !== 'VISION_PAUSED') {
        resolveEvent(event.code);
      }
    }
    setServerState('OK', 'OK', null, null);
  }
}

/** Lifts a pause after an operator action. */
export function resumeVision(reason: string): void {
  const fault = activeFault();
  if (fault) resolveEvent(fault);
  resolveEvent('VISION_PAUSED');
  setServerState('RETRYING', 'OK', null, reason);
  raiseEvent('VISION_RESUMED', reason);

  // An operator pressing "retry" means try again NOW. Queued scans are still
  // serving out exponential backoff from the failures that caused the pause;
  // that backoff is meaningless once the underlying fault is fixed.
  const cleared = clearExtractionBackoff();
  if (cleared > 0) logger.info(`Cleared retry backoff on ${cleared} queued scan(s).`);

  drainRequested = true;
  logger.info(`Vision resumed: ${reason}`);
}

// --------------------------------------------------------------- heartbeat --

export function publishHeartbeat(): void {
  try {
    const counts = extractionCounts();
    writeHeartbeat({
      queuePending: counts.pending,
      queueParked: counts.parked,
      flywheelRecords: countFlywheelRecords(),
      flywheelCapacity: env.flywheelMaxRecords,
    });
    evaluateQueueEvents(counts.pending, counts.parked);
    evaluateFlywheelEvents();
    evaluateCredentialState();
  } catch (error) {
    logger.error('Heartbeat failed', error);
  }
}

function evaluateQueueEvents(pending: number, parked: number): void {
  if (pending > env.queueBacklogWarning) {
    raiseEvent('QUEUE_BACKLOG', `${pending} scans are waiting for extraction.`, { pending });
  } else if (pending === 0) {
    if (resolveEvent('QUEUE_BACKLOG') > 0) raiseEvent('QUEUE_DRAINED', null);
  }

  if (parked > 0) {
    raiseEvent('QUEUE_PARKED_ITEMS', `${parked} scans are parked for review.`, { parked });
  } else {
    resolveEvent('QUEUE_PARKED_ITEMS');
  }
}

function evaluateFlywheelEvents(): void {
  const records = countFlywheelRecords();
  const capacity = env.flywheelMaxRecords;
  const ratio = capacity > 0 ? records / capacity : 0;

  if (ratio >= 1) {
    resolveEvent('FLYWHEEL_HALF_FULL');
    resolveEvent('FLYWHEEL_NEARLY_FULL');
    raiseEvent('FLYWHEEL_FULL', `Training buffer at capacity (${records}/${capacity}).`, {
      records,
      capacity,
    });
  } else if (ratio >= 0.9) {
    resolveEvent('FLYWHEEL_HALF_FULL');
    raiseEvent('FLYWHEEL_NEARLY_FULL', `Training buffer ${Math.round(ratio * 100)}% full.`, {
      records,
      capacity,
    });
  } else if (ratio >= 0.5) {
    raiseEvent('FLYWHEEL_HALF_FULL', `Training buffer ${Math.round(ratio * 100)}% full.`, {
      records,
      capacity,
    });
  } else {
    resolveEvent('FLYWHEEL_HALF_FULL');
    resolveEvent('FLYWHEEL_NEARLY_FULL');
    resolveEvent('FLYWHEEL_FULL');
  }
}

// ---------------------------------------------------------------- commands --

function handleCommand(command: UiCommandRow): void {
  markCommand(command.id, 'IN_PROGRESS');

  switch (command.command) {
    case UI_COMMANDS.PING:
      markCommand(command.id, 'DONE', 'pong');
      return;

    case UI_COMMANDS.VISION_ACCOUNT_REFRESH:
      resumeVision('Operator reported the vision account was refreshed.');
      markCommand(command.id, 'DONE', 'Vision processing resumed; queue will drain.');
      return;

    case UI_COMMANDS.VISION_SETTINGS_UPDATED:
      try {
        reloadGeminiClient();
        raiseEvent('CONFIG_RELOADED', 'Vision settings reloaded on operator request.');
        resolveEvent('CONFIG_RELOAD_FAILED');
        resumeVision('Operator updated the vision settings.');
        markCommand(command.id, 'DONE', 'Settings reloaded; vision processing resumed.');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        raiseEvent('CONFIG_RELOAD_FAILED', detail);
        markCommand(command.id, 'FAILED', detail);
      }
      return;

    case UI_COMMANDS.DRAIN_QUEUE_NOW:
      drainRequested = true;
      markCommand(command.id, 'DONE', 'Drain scheduled.');
      return;

    case UI_COMMANDS.FLYWHEEL_DUMPED:
      handleFlywheelDump(command);
      return;

    default:
      markCommand(command.id, 'REJECTED', `Unknown command "${command.command}".`);
      logger.warn(`Rejected unknown UI command "${command.command}"`);
  }
}

/**
 * Purge is watermark-based and never "delete everything": the UI must state the
 * highest sample id it actually exported, so samples captured after the export
 * began survive. A command without a watermark is rejected, not guessed at.
 */
function handleFlywheelDump(command: UiCommandRow): void {
  let watermark: number | null = null;
  try {
    const payload = command.payload_json
      ? (JSON.parse(command.payload_json) as { exported_through_id?: unknown })
      : {};
    if (typeof payload.exported_through_id === 'number') {
      watermark = payload.exported_through_id;
    }
  } catch {
    /* fall through to rejection */
  }

  if (watermark === null) {
    const detail =
      'FLYWHEEL_DUMPED requires payload {"exported_through_id": <rowid>} naming the ' +
      'last exported sample. Nothing was purged.';
    raiseEvent('FLYWHEEL_PURGE_REJECTED', detail);
    markCommand(command.id, 'REJECTED', detail);
    return;
  }

  const removed = purgeFlywheelThrough(watermark);
  const remaining = countFlywheelRecords();
  resolveEvent('FLYWHEEL_FULL');
  resolveEvent('FLYWHEEL_NEARLY_FULL');
  resolveEvent('FLYWHEEL_HALF_FULL');
  resolveEvent('FLYWHEEL_PURGE_REJECTED');
  raiseEvent(
    'FLYWHEEL_PURGED',
    `Purged ${removed} exported sample(s); ${remaining} newer sample(s) retained.`,
    { removed, remaining, watermark },
  );
  markCommand(
    command.id,
    'DONE',
    `Purged ${removed} sample(s) up to id ${watermark}; ${remaining} retained.`,
  );
}

/**
 * Consumes credential submissions from the UI.
 *
 * The candidate is probed against the live API before it is adopted, so a typo
 * is reported back to the operator instead of silently taking extraction down.
 * A rejected candidate leaves the previous settings untouched.
 */
export async function processPendingSettings(): Promise<void> {
  for (const pending of takePendingSettings()) {
    markPending(pending.id, 'VALIDATING', 'Validating against the vision API...');

    const apiKey = pending.api_key?.trim() ?? '';
    if (!apiKey) {
      markPending(pending.id, 'REJECTED', 'No API key supplied.');
      raiseEvent('VISION_SETTINGS_REJECTED', 'Submission contained no API key.');
      continue;
    }

    const model = pending.vision_model?.trim() || env.geminiVisionModel;

    try {
      const probe = await probeCredentials(apiKey, model);

      if (probe.outcome === 'INCONCLUSIVE') {
        // Neither adopt nor reject. The candidate stays PENDING and is retried on
        // a later poll; the credentials currently in force are untouched.
        markPending(
          pending.id,
          'PENDING',
          `Could not verify yet (${probe.fault}); will retry automatically.`,
        );
        logger.warn(
          `Credential validation inconclusive (${probe.fault}); leaving submission queued.`,
        );
        continue;
      }

      if (probe.outcome === 'INVALID') {
        markSettingsInvalid(probe.detail);
        markPending(pending.id, 'REJECTED', `${probe.fault}: ${probe.detail}`);
        raiseEvent('VISION_SETTINGS_REJECTED', probe.detail, { fault: probe.fault });
        logger.warn(`Rejected submitted vision credentials: ${probe.fault}`);
        continue;
      }

      applyVisionSettings(
        apiKey,
        pending.vision_model?.trim() || null,
        pending.image_model?.trim() || null,
        pending.submitted_by,
      );
      reloadGeminiClient();

      markPending(
        pending.id,
        'APPLIED',
        `Validated and applied (key ${fingerprintOf(apiKey)}, model ${model}).`,
      );
      resolveEvent('VISION_SETTINGS_REJECTED');
      resolveEvent('VISION_NOT_CONFIGURED');
      raiseEvent('VISION_SETTINGS_APPLIED', `Key ${fingerprintOf(apiKey)} accepted.`);
      resolveEvent('VISION_SETTINGS_APPLIED');
      resumeVision('Operator supplied new, validated vision credentials.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      markPending(pending.id, 'REJECTED', detail);
      raiseEvent('VISION_SETTINGS_REJECTED', detail);
      logger.error('Validating submitted vision credentials failed', error);
    }
  }
}

/**
 * Raises (or clears) the "no key configured" fault. Called at boot and on every
 * heartbeat, so an operator who clears a key sees it reported rather than the
 * server quietly continuing on a stale one.
 */
export function evaluateCredentialState(): void {
  if (credentialSource() === 'NONE') {
    const newlyDetected = activeFault() !== 'VISION_NOT_CONFIGURED';
    if (newlyDetected) {
      setServerState('BLOCKED', 'PAUSED', 'VISION_NOT_CONFIGURED', 'No vision API key configured.');
      logger.warn('No vision API key configured — scans will queue until one is supplied.');
    }
    // Raised unconditionally: raiseEvent coalesces onto the open row, so this is
    // idempotent, and it self-heals if the events table was pruned while the
    // fault persisted. Gating the raise on "newly detected" would leave a live
    // fault with no visible event.
    raiseEvent(
      'VISION_NOT_CONFIGURED',
      'No vision API key configured; scans are being stored and queued.',
    );
    return;
  }
  resolveEvent('VISION_NOT_CONFIGURED');
}

export function processPendingCommands(): void {
  try {
    for (const command of takePendingCommands()) {
      try {
        handleCommand(command);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        markCommand(command.id, 'FAILED', detail);
        logger.error(`UI command ${command.command} failed`, error);
      }
    }
  } catch (error) {
    logger.error('Command polling failed', error);
  }
}

// ------------------------------------------------------------------ start --

export function startControlService(): void {
  const status = initialiseStatus();

  // Restart amnesia guard: a pause recorded before the restart still stands.
  if (status.vision_state === 'PAUSED') {
    logger.warn(
      `Vision is PAUSED from a previous run (fault ${status.active_fault}). ` +
        'Scans will be stored and queued until an operator resolves it.',
    );
  } else {
    setServerState('OK', 'OK', null, null);
  }

  raiseEvent('SERVER_STARTED', `Middleware started on port ${env.port}.`);
  resolveEvent('SERVER_STARTED');

  // Bootstrap operators before the first heartbeat, so a device can log in
  // the moment the server is up.
  seedTestAccounts(env.seedTestAccounts);

  evaluateCredentialState();
  publishHeartbeat();
  heartbeatTimer = setInterval(publishHeartbeat, env.controlHeartbeatMs);
  commandTimer = setInterval(() => {
    processPendingCommands();
    processPendingUserRequests();
    void processPendingSettings();
  }, env.controlPollMs);
  heartbeatTimer.unref();
  commandTimer.unref();

  logger.info(
    `Control channel active — heartbeat ${env.controlHeartbeatMs} ms, ` +
      `command poll ${env.controlPollMs} ms.`,
  );
}

export function stopControlService(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (commandTimer) clearInterval(commandTimer);
  heartbeatTimer = null;
  commandTimer = null;
  try {
    raiseEvent('SERVER_SHUTTING_DOWN', 'Middleware is stopping.');
    setServerState('DEGRADED', readStatus().vision_state, activeFault(), 'Server stopped.');
  } catch {
    /* shutting down anyway */
  }
}
