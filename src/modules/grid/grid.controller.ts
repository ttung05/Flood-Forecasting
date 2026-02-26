/**
 * Grid Controller — Pre-built grid JSON endpoint.
 */
import { Router } from 'express';
import { GridParamsSchema } from './grid.types';
import * as gridService from './grid.service';
import { ok, fail } from '../../shared/types/envelope';

const router = Router();

// GET /api/grid/:region/:date/:layer
router.get('/grid/:region/:date/:layer', async (req, res) => {
    const parsed = GridParamsSchema.safeParse(req.params);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(res, `${issue?.path.join('.')}: ${issue?.message}`, 400, 'VALIDATION');
    }

    const result = await gridService.getGrid(parsed.data);
    if (!result.ok) return fail(res, result.error.message, result.error.statusCode, result.error.code);

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=600');
    return ok(res, result.value);
});

export { router as gridRouter };
