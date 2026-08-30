import { Router } from 'express';
import { actorOf, requireAuth, requireCsrf } from '../web/context';
import { filtersFrom } from './items';
import {
  PRESETS,
  buildLines,
  exportFilename,
  logExport,
  recentExports,
  renderCsv,
  renderXlsx,
  warningsFor,
  type Format,
  type PresetId,
} from '../services/exportPresets';
import { distinctValues } from '../services/items';
import type { Locale } from '../data/resolve';

const router = Router();

function presetOf(value: unknown): PresetId {
  const id = String(value);
  return (id in PRESETS ? id : 'seller_invoice') as PresetId;
}

router.get('/exports', requireAuth, (req, res) => {
  const filters = filtersFrom(req.query as Record<string, unknown>);
  const preset = PRESETS[presetOf(req.query.preset ?? 'seller_invoice')];
  const locale = (req.query.locale === 'hy' ? 'hy' : req.query.locale === 'en' ? 'en' : (preset.defaultLocale ?? req.locale)) as Locale;

  // A live count and the warnings, computed before anything is written — nobody should
  // discover a missing HS code at the customs desk.
  const lines = buildLines(filters, preset);

  res.render('exports', {
    title: 'Exports',
    presets: Object.values(PRESETS),
    preset,
    locale,
    filters,
    rowCount: lines.length,
    itemCount: lines.reduce((n, l) => n + l.members.length, 0),
    pieces: lines.reduce((n, l) => n + l.pieces, 0),
    warnings: warningsFor(preset, lines),
    operators: distinctValues('operator'),
    history: recentExports(25),
  });
});

router.post('/exports/run', requireAuth, requireCsrf, async (req, res) => {
  const filters = filtersFrom(req.body as Record<string, unknown>);
  const preset = PRESETS[presetOf(req.body.preset)];
  const locale = (req.body.locale === 'hy' ? 'hy' : 'en') as Locale;
  const format = (req.body.format === 'xlsx' ? 'xlsx' : 'csv') as Format;

  const lines = buildLines(filters, preset);
  const filename = exportFilename(preset.id, format, locale);

  const body = format === 'xlsx' ? await renderXlsx(preset, lines, locale) : renderCsv(preset, lines, locale);

  logExport(actorOf(req), preset.id, locale, format, filters, lines.length, filename);

  res.setHeader(
    'Content-Type',
    format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
});

export default router;
