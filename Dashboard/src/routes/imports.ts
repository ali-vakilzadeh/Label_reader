import { Router } from 'express';
import multer from 'multer';
import { actorOf, requireAuth, requireCsrf } from '../web/context';
import {
  DuplicateFileError,
  findPreviousImport,
  importRows,
  recentImports,
  runImport,
  sha256,
  type CollisionPolicy,
} from '../services/import';
import { scansAvailable } from '../services/enrich';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

const POLICIES: CollisionPolicy[] = ['SKIP', 'UPDATE_EMPTY_ONLY', 'OVERWRITE'];

router.get('/import', requireAuth, (_req, res) => {
  res.render('import', {
    title: 'Import',
    imports: recentImports(50),
    scans: scansAvailable(),
    report: null,
    preview: null,
    error: null,
  });
});

/**
 * Preview first, always. The order letter forbids losing data during import, and the
 * cheapest way to keep that promise is to show exactly what will happen before it does.
 */
// multer must run BEFORE requireCsrf: on a multipart request the body — and with it the
// _csrf field — does not exist until multer has parsed it.
router.post('/import/preview', requireAuth, upload.single('file'), requireCsrf, (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).render('import', {
      title: 'Import',
      imports: recentImports(50),
      scans: scansAvailable(),
      report: null,
      preview: null,
      error: 'Choose a CSV file first.',
    });
  }

  const policy = (POLICIES.includes(req.body.policy) ? req.body.policy : 'SKIP') as CollisionPolicy;
  const digest = sha256(file.buffer);
  const previous = findPreviousImport(digest);

  if (previous) {
    return res.status(409).render('import', {
      title: 'Import',
      imports: recentImports(50),
      scans: scansAvailable(),
      report: null,
      preview: null,
      error: `This exact file was already imported on ${new Date(previous.uploaded_at)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')} by ${previous.uploaded_by} (as "${previous.filename}"). Nothing was changed.`,
    });
  }

  const preview = runImport(actorOf(req), file.originalname, file.buffer, policy, true);

  res.render('import', {
    title: 'Import',
    imports: recentImports(50),
    scans: scansAvailable(),
    report: null,
    error: preview.error,
    preview: {
      ...preview,
      // The file has to be re-sent on confirm; holding it server-side between two
      // requests would mean a session-scoped upload cache for no real benefit.
      payload: file.buffer.toString('base64'),
      filename: file.originalname,
      policy,
    },
  });
});

router.post('/import/confirm', requireAuth, requireCsrf, (req, res) => {
  const payload = String(req.body.payload ?? '');
  const filename = String(req.body.filename ?? 'upload.csv');
  const policy = (POLICIES.includes(req.body.policy) ? req.body.policy : 'SKIP') as CollisionPolicy;
  if (!payload) return res.redirect('/import');

  let report;
  try {
    report = runImport(actorOf(req), filename, Buffer.from(payload, 'base64'), policy, false);
  } catch (err) {
    if (err instanceof DuplicateFileError) {
      return res.status(409).render('import', {
        title: 'Import',
        imports: recentImports(50),
        scans: scansAvailable(),
        report: null,
        preview: null,
        error: err.message,
      });
    }
    throw err;
  }

  res.render('import', {
    title: 'Import',
    imports: recentImports(50),
    scans: scansAvailable(),
    report,
    preview: null,
    error: report.error ?? null,
  });
});

router.get('/import/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const record = recentImports(200).find((r) => (r as { id: number }).id === id);
  if (!record) return res.status(404).render('error', { title: 'Not found', message: 'No such import.' });
  res.render('import-detail', { title: `Import ${id}`, record, rows: importRows(id) });
});

export default router;
