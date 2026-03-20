/**
 * Batch Pixel Service — Fetch pixel data for multiple dates in a single request.
 *
 * POST /api/pixel/batch
 * Body: { lat, lng, region, dates: ["2024-01-01", "2024-01-02", ...] }
 *
 * Benefits:
 *   - Single HTTP round-trip instead of N sequential requests
 *   - Controlled concurrency to avoid R2 socket exhaustion
 *   - Shared cache hits across batch items
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import { createHash } from 'crypto';
import { REGION_BOUNDS } from '../../shared/types/common';
import * as pixelService from './pixel.service';
import { structuredLog } from '../../shared/middleware/tracing';
import { MemoryCache } from '../../shared/cache/memory-cache';
import { preloadNpzDates } from '../../shared/legacy/npz-reader';

const MAX_BATCH_SIZE = 60; // Max unique dates per request
const BATCH_CONCURRENCY = 40; // Concurrent pixel reads (NPZ coalesces same-date downloads)

export interface BatchPixelRequest {
    lat: number;
    lng: number;
    region: string;
    dates: string[];
}

export interface BatchPixelItem {
    date: string;
    rainfall: number | null;
    soilMoisture: number | null;
    tide: number | null;
    flood: number | null;
    dem: number | null;
    slope: number | null;
    flow: number | null;
    landCover: number | null;
    floodRisk: string;
}

export interface BatchPixelResponse {
    lat: number;
    lng: number;
    region: string;
    items: BatchPixelItem[];
    metadata: {
        requested: number;
        returned: number;
        responseTimeMs: number;
    };
}

/** Repeat loads skip R2/NPZ work */
const batchResponseCache = new MemoryCache<BatchPixelResponse>(200, 15 * 60 * 1000);

function batchResultCacheKey(region: string, lat: number, lng: number, dates: string[]): string {
    const sorted = [...dates].sort().join(',');
    const h = createHash('sha256').update(sorted).digest('hex').slice(0, 20);
    return `pb_${region}_${lat.toFixed(4)}_${lng.toFixed(4)}_${dates.length}_${h}`;
}

export async function getBatchPixels(
    req: BatchPixelRequest
): Promise<Result<BatchPixelResponse, AppError>> {
    const t0 = Date.now();
    const { lat, lng, region, dates } = req;

    // Validation
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return Err(AppErrors.validation(`Unknown region: ${region}`));

    if (lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) {
        return Err(AppErrors.outOfBounds(`Coordinates (${lat}, ${lng}) outside ${region}`));
    }

    if (!dates || dates.length === 0) {
        return Err(AppErrors.validation('dates array is required and must not be empty'));
    }

    const uniqueDates = [...new Set(dates)].sort();
    if (uniqueDates.length > MAX_BATCH_SIZE) {
        return Err(AppErrors.validation(`Maximum ${MAX_BATCH_SIZE} dates per batch request`));
    }

    const cacheKey = batchResultCacheKey(region, lat, lng, uniqueDates);
    const cached = batchResponseCache.get(cacheKey);
    if (cached) {
        const cacheMs = Date.now() - t0;
        structuredLog('info', 'pixel_batch_cached', {
            region, lat, lng, requested: uniqueDates.length, durationMs: cacheMs,
        });
        return Ok({
            ...cached,
            metadata: {
                ...cached.metadata,
                responseTimeMs: cacheMs,
            },
        });
    }

    // Prefetch all needed NPZ files in parallel before processing (all at once)
    await preloadNpzDates(uniqueDates, 14);

    // Process dates with controlled concurrency
    const items: BatchPixelItem[] = [];

    for (let i = 0; i < uniqueDates.length; i += BATCH_CONCURRENCY) {
        const batch = uniqueDates.slice(i, i + BATCH_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (date) => {
                const result = await pixelService.getPixel({
                    region: region as any,
                    date,
                    lat,
                    lng,
                });

                if (result.ok) {
                    return {
                        date,
                        rainfall: result.value.rainfall,
                        soilMoisture: result.value.soilMoisture,
                        tide: result.value.tide,
                        flood: result.value.flood,
                        floodRisk: result.value.floodRisk,
                        dem: result.value.dem,
                        slope: result.value.slope,
                        flow: result.value.flow,
                        landCover: result.value.landCover,
                    };
                }

                return {
                    date,
                    rainfall: null,
                    soilMoisture: null,
                    tide: null,
                    flood: null,
                    floodRisk: 'LOW' as string,
                    dem: null,
                    slope: null,
                    flow: null,
                    landCover: null,
                };
            })
        );
        items.push(...batchResults);
    }

    items.sort((a, b) => a.date.localeCompare(b.date));

    const elapsed = Date.now() - t0;
    structuredLog('info', 'pixel_batch', {
        region, lat, lng,
        requested: uniqueDates.length,
        returned: items.length,
        durationMs: elapsed,
    });

    const payload: BatchPixelResponse = {
        lat,
        lng,
        region,
        items,
        metadata: {
            requested: uniqueDates.length,
            returned: items.length,
            responseTimeMs: elapsed,
        },
    };
    batchResponseCache.set(cacheKey, payload);
    return Ok(payload);
}
