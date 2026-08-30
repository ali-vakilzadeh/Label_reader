import { Router } from 'express';
import { requireAuth } from '../web/context';
import { filtersFrom } from './items';
import {
  coverage,
  importVolume,
  reviewBreakdown,
  scansPerDay,
  scansPerOperator,
  topBrands,
  topSubCategories,
} from '../services/analytics';
import { distinctValues } from '../services/items';

const router = Router();

router.get('/analytics', requireAuth, (req, res) => {
  const filters = filtersFrom(req.query as Record<string, unknown>);
  res.render('analytics', {
    title: 'Analytics',
    filters,
    operators: distinctValues('operator'),
    charts: {
      perDay: scansPerDay(filters, 30),
      perOperator: scansPerOperator(filters),
      review: reviewBreakdown(filters),
      brands: topBrands(filters),
      subCategories: topSubCategories(filters),
      imports: importVolume(),
    },
    coverage: coverage(filters),
  });
});

export default router;
