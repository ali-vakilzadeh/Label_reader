import { config } from './config/env';
import { createApp } from './app';
import { closeAll, openDashboardDb } from './db';
import { ensureSeedAdmin, purgeExpiredSessions } from './services/auth';
import { loadReferenceTables, loadCustomsCodes, loadHsRules, referenceSummary } from './data/referenceTables';
import { enrichFromScans, pendingEnrichment, scansAvailable } from './services/enrich';
import { pruneImportRows } from './services/import';

function boot(): void {
  openDashboardDb();
  ensureSeedAdmin();

  // A missing reference table is a boot error, not a warning: without the client's
  // taxonomy the dashboard cannot resolve or translate anything correctly.
  loadReferenceTables();
  loadCustomsCodes();
  loadHsRules();

  for (const t of referenceSummary()) {
    console.log(`[reference] ${t.key.padEnd(14)} ${String(t.rows).padStart(5)} rows${t.armenian ? '  (armenian)' : ''}`);
  }
  console.log(`[middleware] server_scans.db ${scansAvailable() ? 'available' : 'not reachable — running without enrichment'}`);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[dashboard] listening on http://localhost:${config.port}`);
  });

  // Housekeeping. Both are cheap and neither touches anything a user is looking at.
  setInterval(() => {
    purgeExpiredSessions();
    pruneImportRows();
  }, 3600_000).unref();

  // A scan may be extracted after the ledger was cut, so re-check the middleware for rows
  // still missing confidence or media (plan §5.2).
  setInterval(() => {
    const ids = pendingEnrichment(500);
    if (ids.length) enrichFromScans(ids);
  }, 300_000).unref();
}

process.on('SIGINT', () => {
  closeAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeAll();
  process.exit(0);
});

boot();
