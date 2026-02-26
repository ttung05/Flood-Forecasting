/**
 * Grid Service — Serves pre-built grid JSON or falls back to raster decode.
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import { MemoryCache } from '../../shared/cache/memory-cache';
import { structuredLog } from '../../shared/middleware/tracing';
import type { GridParams, GridJSON } from './grid.types';
import { getEnv } from '../../shared/config/env';

// L1 cache for grid results
const gridCache = new MemoryCache<GridJSON>(50, 30 * 60 * 1000);

// ── Dependencies ───────────────────────────────────────────
let _r2GetJson: ((key: string) => Promise<any>) | null = null;
let _legacyGridHandler: ((region: string, date: string, layer: string) => Promise<any>) | null = null;

export function injectDeps(deps: {
    r2GetJson?: (key: string) => Promise<any>;
    legacyGridHandler?: (region: string, date: string, layer: string) => Promise<any>;
}) {
    _r2GetJson = deps.r2GetJson ?? null;
    _legacyGridHandler = deps.legacyGridHandler ?? null;
}

export async function getGrid(params: GridParams): Promise<Result<GridJSON | any, AppError>> {
    const { region, date, layer } = params;
    const t0 = Date.now();
    const env = getEnv();

    // Strategy 1: Pre-built JSON from R2 (zero decode)
    if (env.USE_PREBUILT_GRID && _r2GetJson) {
        const cacheKey = `grid_${region}_${date}_${layer}`;
        const cached = gridCache.get(cacheKey);
        if (cached) {
            structuredLog('info', 'grid_cache_hit', { region, date, layer, durationMs: Date.now() - t0 });
            return Ok(cached);
        }

        try {
            const r2Key = `FloodData/${region}/Grid/grid_${date}_${layer}.json`;
            const gridJson = await _r2GetJson(r2Key) as GridJSON;
            if (gridJson && gridJson.v) {
                gridCache.set(cacheKey, gridJson);
                structuredLog('info', 'grid_prebuilt', { region, date, layer, durationMs: Date.now() - t0 });
                return Ok(gridJson);
            }
        } catch {
            // Pre-built not available — fallback
        }
    }

    // Strategy 2: Legacy raster decode (fallback)
    if (_legacyGridHandler) {
        try {
            const data = await _legacyGridHandler(region, date, layer);
            structuredLog('info', 'grid_legacy_decode', { region, date, layer, durationMs: Date.now() - t0 });
            return Ok(data);
        } catch (err) {
            return Err(AppErrors.internal(`Grid decode failed: ${(err as Error).message}`));
        }
    }

    return Err(AppErrors.internal('Grid service not configured'));
}
