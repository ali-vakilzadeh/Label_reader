import { Router } from 'express';
import { config } from '../config/env';
import { actorOf, requireAuth, requireCsrf } from '../web/context';
import {
  EditRefused,
  countItems,
  distinctValues,
  getItem,
  queryItems,
  recomputeSuggestions,
  reviewReasons,
  setLocked,
  setReviewState,
  softDelete,
  updateItem,
  type ItemFilters,
} from '../services/items';
import { dismissDuplicate, duplicatePartners } from '../services/duplicates';
import { applyToGroup, assignToGroup, groupMembers, previewApply, removeFromGroup, APPLICABLE_FIELDS } from '../services/groups';
import { customsCodeName, searchCustomsCodes } from '../data/referenceTables';
import { optionsFor } from '../data/resolve';
import { priceContext } from '../suggest';
import { openDashboardDb } from '../db';
import { allSettings } from '../services/settings';
import { recentAudit } from '../services/audit';

const router = Router();

export function filtersFrom(query: Record<string, unknown>): ItemFilters {
  const pick = (k: string): string | undefined => {
    const v = query[k];
    if (v === undefined || v === null || v === '') return undefined;
    return String(v);
  };
  const lastN = Number(query.lastN);
  return {
    from: pick('from'),
    to: pick('to'),
    operator: pick('operator'),
    brand: pick('brand'),
    sub_category: pick('sub_category'),
    gender: pick('gender'),
    season: pick('season'),
    country: pick('country'),
    category: pick('category'),
    review_state: pick('review_state'),
    article_no: pick('article_no'),
    export_batch: pick('export_batch'),
    has_price: pick('has_price') as ItemFilters['has_price'],
    has_hs: pick('has_hs') as ItemFilters['has_hs'],
    duplicates: pick('duplicates') as ItemFilters['duplicates'],
    unmatched: pick('unmatched') as ItemFilters['unmatched'],
    locked: pick('locked') as ItemFilters['locked'],
    q: pick('q'),
    lastN: Number.isFinite(lastN) && lastN > 0 ? lastN : undefined,
  };
}

router.get('/items', requireAuth, (req, res) => {
  const filters = filtersFrom(req.query as Record<string, unknown>);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Number(allSettings().page_size) || config.pageSize;
  const sort = String(req.query.sort ?? 'scanned_at');
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

  const total = countItems(filters);
  const items = queryItems(filters, { limit: pageSize, offset: (page - 1) * pageSize, sort, dir });

  res.render('items', {
    title: 'Items',
    items,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sort,
    dir,
    filters,
    reasonsFor: (id: string) => {
      const item = items.find((i) => i.apparel_id === id);
      return item ? reviewReasons(item) : [];
    },
    operators: distinctValues('operator'),
    articles: distinctValues('article_no'),
    options: {
      brand: optionsFor('brand', req.locale),
      sub_category: optionsFor('sub_category', req.locale),
      gender: optionsFor('gender', req.locale),
      season: optionsFor('season', req.locale),
      country: optionsFor('country', req.locale),
      category: optionsFor('category', req.locale),
    },
  });
});

router.get('/items/:id', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item) {
    return res.status(404).render('error', { title: 'Not found', message: `No item ${req.params.id}.` });
  }
  const settings = allSettings();
  res.render('item', {
    title: item.apparel_id,
    item,
    reasons: reviewReasons(item),
    priceCtx: priceContext(item, { db: openDashboardDb(), settings, now: new Date(), log: () => {} }),
    hsName: customsCodeName(item.hs_code),
    duplicates: item.dup_group_id ? duplicatePartners(item.dup_group_id, item.apparel_id) : [],
    groupSiblings: item.article_no ? groupMembers(item.article_no).filter((m) => m.apparel_id !== item.apparel_id) : [],
    history: recentAudit(50, item.apparel_id),
    prices: openDashboardDb()
      .prepare('SELECT * FROM price_history WHERE apparel_id = ? ORDER BY set_at DESC LIMIT 20')
      .all(item.apparel_id),
    applicableFields: APPLICABLE_FIELDS,
    options: {
      brand: optionsFor('brand', req.locale),
      category: optionsFor('category', req.locale),
      sub_category: optionsFor('sub_category', req.locale),
      gender: optionsFor('gender', req.locale),
      season: optionsFor('season', req.locale),
      color: optionsFor('color', req.locale),
      material: optionsFor('material', req.locale),
      country: optionsFor('country', req.locale),
    },
  });
});

router.post('/items/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    updateItem(actorOf(req), req.params.id, req.body as Record<string, string>);
    recomputeSuggestions([req.params.id]);
  } catch (err) {
    if (err instanceof EditRefused) {
      return res.status(409).render('error', { title: 'Edit refused', message: err.message });
    }
    throw err;
  }
  res.redirect(`/items/${encodeURIComponent(req.params.id)}`);
});

router.post('/items/:id/lock', requireAuth, requireCsrf, (req, res) => {
  setLocked(actorOf(req), req.params.id, req.body.locked === '1');
  res.redirect(req.body.back || `/items/${encodeURIComponent(req.params.id)}`);
});

router.post('/items/:id/delete', requireAuth, requireCsrf, (req, res) => {
  try {
    softDelete(actorOf(req), req.params.id);
  } catch (err) {
    if (err instanceof EditRefused) {
      return res.status(409).render('error', { title: 'Delete refused', message: err.message });
    }
    throw err;
  }
  res.redirect(req.body.back || '/items');
});

router.post('/items/:id/review', requireAuth, requireCsrf, (req, res) => {
  const state = String(req.body.state);
  if (['NEW', 'NEEDS_REVIEW', 'REVIEWED', 'PARKED'].includes(state)) {
    setReviewState(actorOf(req), req.params.id, state as never);
  }
  res.redirect(req.body.back || `/items/${encodeURIComponent(req.params.id)}`);
});

router.post('/items/:id/dismiss-duplicate', requireAuth, requireCsrf, (req, res) => {
  dismissDuplicate(actorOf(req), req.params.id);
  res.redirect(req.body.back || `/items/${encodeURIComponent(req.params.id)}`);
});

/* ------------------------------ bulk actions ----------------------------- */

function selectedIds(body: Record<string, unknown>): string[] {
  const raw = body.ids;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw) return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

router.post('/items/bulk', requireAuth, requireCsrf, (req, res) => {
  const ids = selectedIds(req.body);
  const actor = actorOf(req);
  const back = String(req.body.back || '/items');
  if (!ids.length) return res.redirect(back);

  switch (String(req.body.action)) {
    case 'group':
      assignToGroup(actor, ids, String(req.body.article_no || '').trim() || `ART-${Date.now()}`);
      break;
    case 'ungroup':
      removeFromGroup(actor, ids);
      break;
    case 'set_price': {
      const price = Number(req.body.price);
      if (Number.isFinite(price)) {
        for (const id of ids) {
          try {
            updateItem(actor, id, { user_decided_price: String(price) });
          } catch {
            /* locked rows are skipped, as everywhere else */
          }
        }
      }
      break;
    }
    case 'set_package': {
      const pkg = String(req.body.package_code || '');
      for (const id of ids) {
        try {
          updateItem(actor, id, { package_code: pkg });
        } catch {
          /* locked */
        }
      }
      break;
    }
    case 'mark_reviewed':
      for (const id of ids) setReviewState(actor, id, 'REVIEWED');
      break;
    case 'recompute':
      recomputeSuggestions(ids);
      break;
    default:
      break;
  }
  res.redirect(back);
});

/* --------------------------- apply to group ------------------------------ */

router.post('/items/:id/apply-preview', requireAuth, requireCsrf, (req, res) => {
  const source = getItem(req.params.id);
  if (!source) return res.status(404).render('error', { title: 'Not found', message: 'No such item.' });
  const fields = ([] as string[]).concat(req.body.fields ?? []);
  const targets = source.article_no
    ? groupMembers(source.article_no).map((m) => m.apparel_id)
    : selectedIds(req.body);
  res.render('apply-preview', {
    title: 'Apply to group',
    source,
    fields,
    preview: previewApply(source.apparel_id, targets, fields),
  });
});

router.post('/items/:id/apply', requireAuth, requireCsrf, (req, res) => {
  const source = getItem(req.params.id);
  if (!source) return res.status(404).render('error', { title: 'Not found', message: 'No such item.' });
  const fields = ([] as string[]).concat(req.body.fields ?? []);
  const targets = ([] as string[]).concat(req.body.targets ?? []);
  const result = applyToGroup(actorOf(req), source.apparel_id, targets, fields);
  res.render('apply-result', { title: 'Applied', source, result });
});

/* ------------------------------ HS picker -------------------------------- */

router.get('/hs-codes', requireAuth, (req, res) => {
  res.json(searchCustomsCodes(String(req.query.q ?? ''), 25));
});

export default router;
