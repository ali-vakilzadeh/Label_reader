import { Router } from 'express';
import { requireAuth } from '../web/context';
import { banner, readCommand, readStatus } from '../services/control';
import { searchCustomsCodes } from '../data/referenceTables';

/**
 * Small JSON endpoints for the page's own polling. There is no public API here — the
 * dashboard is server-rendered, and these exist only so the banner and a running command
 * can refresh without a full reload.
 */
const router = Router();

router.get('/status', requireAuth, (req, res) => {
  const status = readStatus();
  res.json({ status, banner: banner(status, req.locale), at: Date.now() });
});

/**
 * Poll a command until it reaches a terminal status, then stop. The protocol is explicit:
 * PENDING means "not yet polled by the middleware", never "ignored".
 */
router.get('/command/:id', requireAuth, (req, res) => {
  const row = readCommand(Number(req.params.id)) as
    | { status: string; result_detail: string | null; completed_at: number | null }
    | null;
  if (!row) return res.status(404).json({ error: 'unknown command' });
  res.json({ ...row, terminal: ['DONE', 'FAILED', 'REJECTED'].includes(row.status) });
});

router.get('/hs-codes', requireAuth, (req, res) => {
  res.json(searchCustomsCodes(String(req.query.q ?? ''), 25));
});

export default router;
