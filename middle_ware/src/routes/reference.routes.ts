import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { referenceCatalogue } from '../services/referenceService';
import { referenceVersion } from '../data/referenceTables';

export const referenceRouter: Router = Router();

/**
 * GET /api/v1/reference-tables
 *
 * The client's seven taxonomy tables — English key, Armenian label, numeric id —
 * so the Android app can show the operator Armenian and still store the English
 * key. api_contract.md v1.3 §4.6.
 *
 * This is what makes an Armenian operator experience possible without a single
 * machine translation. The app looks a value up in this table; it never
 * translates, and neither does the model. A row with no Armenian is published as
 * `hy: null` and the app renders the English word.
 *
 * Strongly ETagged on the table content, so the normal case for a handset that
 * already has the current vocabulary is a 304 with no body. The payload is
 * roughly 90 KB and changes only when a supervisor changes a table, so a device
 * can safely check on every login.
 */
referenceRouter.get('/', requireAuth, (req, res) => {
  const version = referenceVersion();
  const etag = `"${version}"`;

  res.setHeader('ETag', etag);
  // Devices must notice a supervisor's correction within a shift, so the copy is
  // revalidated rather than served blind from cache. Revalidation is cheap: it
  // is a 304 unless the tables actually changed.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');

  // If-None-Match may carry a list, and a proxy may have weakened the tag.
  const presented = req.headers['if-none-match'];
  if (presented) {
    const offered = presented
      .split(',')
      .map((candidate) => candidate.trim().replace(/^W\//, ''));
    if (offered.includes(etag)) {
      res.status(304).end();
      return;
    }
  }

  res.json(referenceCatalogue());
});
