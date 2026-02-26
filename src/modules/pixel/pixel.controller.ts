/**
 * Pixel Controller — Route handler with Zod validation.
 * Never throws. Uses Result pattern from service layer.
 */
import { Router } from 'express';
import { PixelParamsSchema } from './pixel.types';
import * as pixelService from './pixel.service';
import { ok, fail } from '../../shared/types/envelope';

const router = Router();

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
