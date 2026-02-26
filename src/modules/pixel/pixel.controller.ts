/**
 * Pixel Controller — Route handler with Zod validation.
 * Never throws. Uses Result pattern from service layer.
 */
import { Router } from 'express';
import { PixelParamsSchema } from './pixel.types';
import * as pixelService from './pixel.service';
import * as pixelHistoryService from './pixel.history';
import { ok, fail } from '../../shared/types/envelope';
import { z } from 'zod';
import { LatSchema, LngSchema, RegionSchema, DateStrSchema } from '../../shared/types/common';

const router = Router();

// GET /api/pixel/history?lat=&lng=&region=&startDate=&endDate=
router.get('/pixel/history', async (req, res) => {
    const QuerySchema = z.object({
        lat: LatSchema,
        lng: LngSchema,
        region: RegionSchema,
        startDate: DateStrSchema,
        endDate: DateStrSchema
    });

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return fail(res, `Invalid history query params: ${parsed.error.message}`, 400, 'VALIDATION');
    }

    const { lat, lng, region, startDate, endDate } = parsed.data;
    const result = await pixelHistoryService.getPixelHistory(region, lat, lng, startDate, endDate);

    if (!result.ok) {
        return fail(res, result.error.message, result.error.statusCode, result.error.code);
    }

    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
    return ok(res, result.value);
});

router.get('/pixel/:lat/:lng/:date/:region', async (req, res) => {
    const parsed = PixelParamsSchema.safeParse(req.params);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(res, `${issue?.path.join('.')}: ${issue?.message}`, 400, 'VALIDATION');
    }

    const result = await pixelService.getPixel(parsed.data);

    if (!result.ok) {
        return fail(res, result.error.message, result.error.statusCode, result.error.code);
    }

    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
    res.setHeader('X-Response-Time', `${result.value.metadata.responseTimeMs}ms`);
    res.setHeader('X-Trace-Id', result.value.metadata.traceId);
    return ok(res, result.value);
});

export { router as pixelRouter };
