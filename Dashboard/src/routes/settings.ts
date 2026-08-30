import { Router } from 'express';
import { actorOf, requireAdmin, requireAuth, requireCsrf } from '../web/context';
import {
  SEEDED_TEST_ACCOUNTS,
  acknowledgeEvent,
  eventHistory,
  flywheelRows,
  flywheelWatermark,
  issueCommand,
  listOperators,
  messageDictionary,
  openEvents,
  pendingVisionSettings,
  recentCommands,
  recentOperatorRequests,
  saveTranslation,
  submitOperatorRequest,
  submitVisionSettings,
  visionSettings,
  type CommandName,
  type OperatorAction,
} from '../services/control';
import { createUser, listUsers, setPassword, setStatus, type Role } from '../services/auth';
import { referenceSummary, reloadAllReferenceData } from '../data/referenceTables';
import { listEngines } from '../suggest';
import { allSettings, setSetting } from '../services/settings';
import { audit } from '../services/audit';
import { resetMiddlewareHandles } from '../db';

const router = Router();

/* ---------------- Card 6: operations, credentials, operators -------------- */

router.get('/settings/server', requireAuth, (req, res) => {
  res.render('server-settings', {
    title: 'Server settings',
    events: openEvents(req.locale),
    history: eventHistory(req.locale, 100),
    vision: visionSettings(),
    pending: pendingVisionSettings(),
    operators: listOperators(),
    requests: recentOperatorRequests(),
    commands: recentCommands(),
    seeded: SEEDED_TEST_ACCOUNTS,
  });
});

router.post('/settings/server/acknowledge/:id', requireAuth, requireCsrf, (req, res) => {
  acknowledgeEvent(Number(req.params.id), actorOf(req));
  res.redirect('/settings/server');
});

const ALLOWED_COMMANDS: CommandName[] = [
  'VISION_ACCOUNT_REFRESH',
  'VISION_SETTINGS_UPDATED',
  'DRAIN_QUEUE_NOW',
  'PING',
];

router.get('/settings/server/command/:command', requireAuth, (req, res) => {
  // A GET link from a banner button lands here and asks for confirmation, so a crawler or
  // a prefetch can never issue a command.
  const command = req.params.command as CommandName;
  if (!ALLOWED_COMMANDS.includes(command)) {
    return res.status(400).render('error', { title: 'Unknown command', message: `${command} is not a command this UI issues.` });
  }
  res.render('confirm-command', { title: 'Confirm', command });
});

router.post('/settings/server/command', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const command = String(req.body.command) as CommandName;
  if (!ALLOWED_COMMANDS.includes(command)) {
    return res.status(400).render('error', { title: 'Unknown command', message: 'Not a command this UI issues.' });
  }
  const id = issueCommand(command, actorOf(req));
  audit(actorOf(req), 'COMMAND', 'ui_command', String(id), null, { command });
  res.redirect('/settings/server');
});

router.post('/settings/server/vision', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const apiKey = String(req.body.api_key ?? '').trim();
  if (!apiKey) {
    return res.status(400).render('error', { title: 'No key', message: 'Enter an API key to submit.' });
  }
  // The key is written straight to vision_settings_pending and never stored, logged or
  // echoed here. The middleware validates it against the live API before adopting it.
  submitVisionSettings(
    actorOf(req),
    apiKey,
    String(req.body.vision_model ?? '').trim() || null,
    String(req.body.image_model ?? '').trim() || null,
  );
  audit(actorOf(req), 'VISION_SETTINGS_SUBMITTED', 'vision_settings_pending', null);
  res.redirect('/settings/server#vision');
});

const OPERATOR_ACTIONS: OperatorAction[] = ['CREATE', 'SET_PASSWORD', 'DISABLE', 'ENABLE', 'DELETE', 'RENAME'];

router.post('/settings/server/operator', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const action = String(req.body.action) as OperatorAction;
  if (!OPERATOR_ACTIONS.includes(action)) {
    return res.status(400).render('error', { title: 'Unknown action', message: 'Not an operator action.' });
  }
  const username = String(req.body.username ?? '').trim();

  // Mirror the middleware's validation so a mistake is caught immediately rather than
  // coming back as a rejected request 15 seconds later.
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).render('error', {
      title: 'Invalid username',
      message: 'Username must be 3-64 characters, letters/digits/dot/underscore/hyphen only.',
    });
  }
  const password = String(req.body.password ?? '');
  if ((action === 'CREATE' || action === 'SET_PASSWORD') && (password.length < 8 || password !== password.trim())) {
    return res.status(400).render('error', {
      title: 'Invalid password',
      message: 'Password must be at least 8 characters, with no leading or trailing space.',
    });
  }

  submitOperatorRequest(actorOf(req), action, username, password || null, String(req.body.display_name ?? '') || null);
  audit(actorOf(req), `OPERATOR_${action}`, 'app_user_request', username);
  res.redirect('/settings/server#operators');
});

/* --------------- Card 7: training data and localisation ------------------ */

router.get('/settings/training', requireAuth, (req, res) => {
  res.render('training', {
    title: 'Training data',
    watermark: flywheelWatermark(),
    dictionary: messageDictionary(req.locale),
    reference: referenceSummary(),
    engines: listEngines(),
    settings: allSettings(),
  });
});

/**
 * The flywheel export. Step order is the whole point: the watermark is captured BEFORE
 * the rows are read, and the purge command carries exactly that watermark. Samples
 * captured during the export survive to the next cycle.
 */
router.post('/settings/training/export', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const watermark = flywheelWatermark();
  if (watermark === null) {
    return res.status(409).render('error', {
      title: 'Nothing to export',
      message: 'The training buffer is empty, or flywheel.db could not be read.',
    });
  }
  const rows = flywheelRows(watermark);
  const filename = `flywheel_through_${watermark}_${new Date().toISOString().slice(0, 10)}.json`;
  audit(actorOf(req), 'FLYWHEEL_EXPORT', 'flywheel', String(watermark), null, { rows: rows.length });

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify({ exported_through_id: watermark, exported_at: Date.now(), rows }, null, 2));
});

router.post('/settings/training/purge', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const watermark = Number(req.body.exported_through_id);
  if (!Number.isFinite(watermark) || watermark <= 0) {
    // Without a watermark the middleware rejects the command and deletes nothing — the UI
    // refuses first so the user gets a useful message rather than a silent rejection.
    return res.status(400).render('error', {
      title: 'Missing watermark',
      message: 'Export the training data first. A purge without a watermark would destroy samples that were never exported.',
    });
  }
  const id = issueCommand('FLYWHEEL_DUMPED', actorOf(req), { exported_through_id: watermark });
  audit(actorOf(req), 'FLYWHEEL_PURGE', 'ui_command', String(id), null, { watermark });
  res.redirect('/settings/training');
});

router.post('/settings/training/translation', requireAuth, requireCsrf, (req, res) => {
  const code = String(req.body.code ?? '').trim();
  const text = String(req.body.text ?? '').trim();
  if (code && text) {
    saveTranslation(code, 'hy', text, String(req.body.hint ?? '').trim() || null);
    audit(actorOf(req), 'TRANSLATION_SAVE', 'message_translations', code);
  }
  res.redirect('/settings/training#translations');
});

router.post('/settings/training/reload-reference', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  reloadAllReferenceData();
  resetMiddlewareHandles();
  audit(actorOf(req), 'REFERENCE_RELOAD', 'reference_data', null);
  res.redirect('/settings/training#reference');
});

router.post('/settings/tunables', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  for (const key of [
    'fuzzy_min_similarity',
    'dup_window_hours',
    'low_confidence_threshold',
    'price_decay_per_month',
    'price_decay_floor',
    'default_currency',
    'page_size',
  ]) {
    const value = req.body[key];
    if (value !== undefined && String(value).trim() !== '') setSetting(key, String(value).trim());
  }
  audit(actorOf(req), 'SETTINGS_UPDATE', 'settings', null);
  res.redirect('/settings/training#tunables');
});

/* ------------------------- dashboard users ------------------------------- */

router.get('/settings/users', requireAuth, requireAdmin, (_req, res) => {
  res.render('users', { title: 'Dashboard users', users: listUsers(), error: null });
});

router.post('/settings/users', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const error = createUser(
    actorOf(req),
    String(req.body.username ?? '').trim(),
    String(req.body.password ?? ''),
    String(req.body.display_name ?? '').trim() || null,
    (req.body.role === 'admin' ? 'admin' : 'viewer') as Role,
  );
  if (error) return res.status(400).render('users', { title: 'Dashboard users', users: listUsers(), error });
  res.redirect('/settings/users');
});

router.post('/settings/users/:id/password', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const error = setPassword(actorOf(req), Number(req.params.id), String(req.body.password ?? ''));
  if (error) return res.status(400).render('users', { title: 'Dashboard users', users: listUsers(), error });
  res.redirect('/settings/users');
});

router.post('/settings/users/:id/status', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const error = setStatus(actorOf(req), Number(req.params.id), req.body.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED');
  if (error) return res.status(400).render('users', { title: 'Dashboard users', users: listUsers(), error });
  res.redirect('/settings/users');
});

export default router;
