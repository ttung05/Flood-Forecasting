/**
 * Forecast Controller — aggregated API endpoints.
 */
import { Router } from 'express';
import * as forecastService from './forecast.service';
import { ok, fail } from '../../shared/types/envelope';
import { z } from 'zod';
import { RegionSchema, DateStrSchema } from '../../shared/types/common';

const router = Router();

const TrendParamsSchema = z.object({
    region: RegionSchema,
});
const TrendQuerySchema = z.object({
    date: DateStrSchema,
});

// GET /api/forecast/:region/rainfall-trend?date=YYYY-MM-DD
router.get('/:region/rainfall-trend', async (req, res) => {
    const paramsParsed = TrendParamsSchema.safeParse(req.params);
    const queryParsed = TrendQuerySchema.safeParse(req.query);

    if (!paramsParsed.success) {
        return fail(res, 'Invalid region', 400, 'VALIDATION');
    }
    if (!queryParsed.success) {
        return fail(res, 'Invalid date query parameter format (YYYY-MM-DD required)', 400, 'VALIDATION');
    }

    const { region } = paramsParsed.data;
    const { date } = queryParsed.data;

    const result = await forecastService.getRainfallTrend(region, date);

    if (!result.ok) {
        return fail(res, result.error.message, result.error.statusCode, result.error.code);
    }

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=600');
    return ok(res, result.value);
});

export { router as forecastRouter };
