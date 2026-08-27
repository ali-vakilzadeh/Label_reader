/**
 * The message catalogue: every condition the middleware can report to the UI.
 *
 * These codes are a published contract. The UI switches on `code` and never on
 * `default_text`, so wording and translations can change freely without touching
 * UI logic. Adding a code is backward-compatible; renaming or removing one is a
 * breaking change requiring a coordinated UI release.
 *
 * The catalogue is reseeded into control.db at every boot (see controlDb.ts), so
 * the UI can render a message for any code the running middleware can emit —
 * including codes added by an upgrade — by joining on `message_dictionary`.
 *
 * `message_translations` is keyed separately and is never overwritten by the
 * reseed: operator-supplied Armenian or Russian text survives upgrades.
 */

export type MessageSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type MessageCategory = 'VISION' | 'FLYWHEEL' | 'RENDER' | 'QUEUE' | 'SYSTEM';

export interface CatalogueEntry {
  code: string;
  severity: MessageSeverity;
  category: MessageCategory;
  /** True when the condition cannot clear without a person doing something. */
  requiresAction: boolean;
  defaultText: string;
  operatorHint?: string;
}

export const MESSAGE_CATALOGUE: CatalogueEntry[] = [
  // ----------------------------------------------------------------- SYSTEM
  {
    code: 'SERVER_STARTED',
    severity: 'INFO',
    category: 'SYSTEM',
    requiresAction: false,
    defaultText: 'Middleware started.',
  },
  {
    code: 'SERVER_SHUTTING_DOWN',
    severity: 'INFO',
    category: 'SYSTEM',
    requiresAction: false,
    defaultText: 'Middleware is shutting down.',
  },
  {
    code: 'CONFIG_RELOADED',
    severity: 'INFO',
    category: 'SYSTEM',
    requiresAction: false,
    defaultText: 'Vision settings were reloaded from the environment file.',
  },
  {
    code: 'CONFIG_RELOAD_FAILED',
    severity: 'CRITICAL',
    category: 'SYSTEM',
    requiresAction: true,
    defaultText: 'Reloading settings failed; the previous settings are still in force.',
    operatorHint: 'Check the .env file for syntax errors, then issue the command again.',
  },
  {
    code: 'DISK_WRITE_FAILED',
    severity: 'CRITICAL',
    category: 'SYSTEM',
    requiresAction: true,
    defaultText: 'The server could not write to disk.',
    operatorHint: 'Check free space and directory permissions on the data and uploads folders.',
  },

  // ----------------------------------------------------------------- VISION
  {
    code: 'VISION_OK',
    severity: 'INFO',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'Vision extraction is working normally.',
  },
  {
    code: 'VISION_TRANSIENT',
    severity: 'WARNING',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'The vision service is temporarily unavailable. Retrying automatically.',
    operatorHint: 'No action needed unless this persists for more than an hour.',
  },
  {
    code: 'VISION_NETWORK',
    severity: 'WARNING',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'The server cannot reach the vision API. Retrying automatically.',
    operatorHint: 'If it persists, check the server internet connection and DNS.',
  },
  {
    code: 'VISION_RATE_LIMIT_MINUTE',
    severity: 'INFO',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'Vision requests are being throttled briefly. Retrying automatically.',
  },
  {
    code: 'VISION_RATE_LIMIT_DAY',
    severity: 'WARNING',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'The daily vision quota is exhausted. Scans are queued until it resets.',
    operatorHint:
      'Scans keep being accepted and stored. Either wait for the daily reset or raise the quota, then press Retry.',
  },
  {
    code: 'VISION_BILLING_REQUIRED',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'The vision API plan does not cover the configured model. Billing needs checking.',
    operatorHint:
      'Open the Google AI Studio billing page, enable billing or change plan, then press "Account refreshed". Waiting alone will not fix this.',
  },
  {
    code: 'VISION_BAD_CREDENTIALS',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'The vision API rejected the API key.',
    operatorHint: 'Put a valid GEMINI_API_KEY in the server settings, then press "Settings updated".',
  },
  {
    code: 'VISION_MODEL_UNAVAILABLE',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'The configured vision model does not exist or is no longer available.',
    operatorHint:
      'Set a supported model name in the server settings, then press "Settings updated".',
  },
  {
    code: 'VISION_REQUEST_REJECTED',
    severity: 'WARNING',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'The vision service rejected one scan. Other scans are unaffected.',
    operatorHint: 'The scan is parked for review; re-photograph the item if it keeps failing.',
  },
  {
    code: 'VISION_UNKNOWN',
    severity: 'WARNING',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'An unrecognised vision API error occurred. Retrying automatically.',
  },
  {
    code: 'VISION_NOT_CONFIGURED',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'No vision API key is configured. Scans are being stored but not processed.',
    operatorHint:
      'Enter a Gemini API key in server settings. Nothing is lost meanwhile — queued scans ' +
      'are processed automatically once a valid key is accepted.',
  },
  {
    code: 'VISION_SETTINGS_APPLIED',
    severity: 'INFO',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'New vision credentials were validated and accepted.',
  },
  {
    code: 'VISION_SETTINGS_REJECTED',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'The submitted vision credentials were rejected. The previous settings are unchanged.',
    operatorHint: 'Check the key and model name, then submit again.',
  },
  {
    code: 'VISION_PAUSED',
    severity: 'CRITICAL',
    category: 'VISION',
    requiresAction: true,
    defaultText: 'Vision processing is paused. Scans are still being stored, not lost.',
    operatorHint: 'Resolve the reported fault, then press the matching action button.',
  },
  {
    code: 'VISION_RESUMED',
    severity: 'INFO',
    category: 'VISION',
    requiresAction: false,
    defaultText: 'Vision processing has resumed.',
  },

  // ------------------------------------------------------------------ QUEUE
  {
    code: 'QUEUE_BACKLOG',
    severity: 'WARNING',
    category: 'QUEUE',
    requiresAction: false,
    defaultText: 'Scans are waiting for extraction.',
    operatorHint: 'Normal while vision is paused. The backlog drains automatically once it resumes.',
  },
  {
    code: 'QUEUE_PARKED_ITEMS',
    severity: 'WARNING',
    category: 'QUEUE',
    requiresAction: true,
    defaultText: 'Some scans could not be extracted and are parked for review.',
    operatorHint:
      'Nothing was lost — photos and records are on the server. Review the parked list in the dashboard.',
  },
  {
    code: 'QUEUE_DRAINED',
    severity: 'INFO',
    category: 'QUEUE',
    requiresAction: false,
    defaultText: 'All queued scans have been extracted.',
  },

  // --------------------------------------------------------------- FLYWHEEL
  {
    code: 'FLYWHEEL_HALF_FULL',
    severity: 'INFO',
    category: 'FLYWHEEL',
    requiresAction: false,
    defaultText: 'The training buffer is half full.',
    operatorHint: 'No action needed yet. Plan an export before it reaches capacity.',
  },
  {
    code: 'FLYWHEEL_NEARLY_FULL',
    severity: 'WARNING',
    category: 'FLYWHEEL',
    requiresAction: true,
    defaultText: 'The training buffer is nearly full. Oldest samples will start being discarded.',
    operatorHint: 'Export the training set, then press "Flywheel dumped" to free space.',
  },
  {
    code: 'FLYWHEEL_FULL',
    severity: 'WARNING',
    category: 'FLYWHEEL',
    requiresAction: true,
    defaultText: 'The training buffer is at capacity and is now discarding the oldest samples.',
    operatorHint:
      'Operational records are unaffected — only training samples rotate. Export, then press "Flywheel dumped".',
  },
  {
    code: 'FLYWHEEL_PURGED',
    severity: 'INFO',
    category: 'FLYWHEEL',
    requiresAction: false,
    defaultText: 'Exported training samples were purged. Collection has restarted.',
  },
  {
    code: 'FLYWHEEL_PURGE_REJECTED',
    severity: 'WARNING',
    category: 'FLYWHEEL',
    requiresAction: true,
    defaultText: 'A purge command was rejected because it did not specify what had been exported.',
    operatorHint:
      'The UI must send the id of the last exported sample so newer samples are not destroyed.',
  },

  // ----------------------------------------------------------------- RENDER
  {
    code: 'RENDER_JOB_COMPLETED',
    severity: 'INFO',
    category: 'RENDER',
    requiresAction: false,
    defaultText: 'The nightly catalog render finished.',
  },
  {
    code: 'RENDER_JOB_FAILURES',
    severity: 'WARNING',
    category: 'RENDER',
    requiresAction: true,
    defaultText: 'Some catalog images could not be rendered.',
    operatorHint: 'Extraction and records are unaffected. Check the render errors in the dashboard.',
  },
  {
    code: 'RENDER_BILLING_REQUIRED',
    severity: 'WARNING',
    category: 'RENDER',
    requiresAction: true,
    defaultText: 'Catalog image rendering is not covered by the current API plan.',
    operatorHint:
      'Scanning and extraction are unaffected. Enable image-generation billing to get catalog photos.',
  },
];

/** Commands the UI may write into `ui_commands`. Also a published contract. */
export const UI_COMMANDS = {
  /** Billing or plan was fixed — retry vision immediately. */
  VISION_ACCOUNT_REFRESH: 'VISION_ACCOUNT_REFRESH',
  /** API key / model / endpoint changed in .env — re-read settings, then retry. */
  VISION_SETTINGS_UPDATED: 'VISION_SETTINGS_UPDATED',
  /** Training samples were exported. Requires payload { exported_through_id }. */
  FLYWHEEL_DUMPED: 'FLYWHEEL_DUMPED',
  /** Drain the extraction backlog now rather than waiting for the next sweep. */
  DRAIN_QUEUE_NOW: 'DRAIN_QUEUE_NOW',
  /** Liveness probe: middleware answers by completing the command. */
  PING: 'PING',
} as const;

export type UiCommandName = (typeof UI_COMMANDS)[keyof typeof UI_COMMANDS];
