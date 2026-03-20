import { Result, Ok, Err, AppError, AppErrors } from '../../shared/types/result';
import * as metadataService from '../metadata/metadata.service';
import * as gridService from '../grid/grid.service';
import { REGION_BOUNDS, Region } from '../../shared/types/common';
import { structuredLog } from '../../shared/middleware/tracing';
import { MemoryCache } from '../../shared/cache/memory-cache';

export interface RegionHistoryData {
    date: string;
    totalRainfall: number | null;
    avgSoilMoisture: number | null;
    avgDem: number | null;
    avgSlope: number | null;
    avgFlow: number | null;
    avgLandCover: number | null;
}

/** Response-level cache: same region + date range → skip all grid reads */
const historyCache = new MemoryCache<RegionHistoryData[]>(60, 30 * 60 * 1000); // 30min TTL

/** Static layers cache per region (DEM/slope/flow/landCover rarely change) */
const staticLayerCache = new MemoryCache<{
    avgDem: number | null;
    avgSlope: number | null;
    avgFlow: number | null;
    avgLandCover: number | null;
}>(10, 30 * 60 * 1000); // 30min TTL

/**
 * Calculates average/sum of a grid array ignoring nodata values.
 */
function calculateGridStats(
    dataArray: number[] | Float32Array | Float64Array | null | undefined,
    nodata: number,
    scale: number | undefined,
    type: 'sum' | 'avg' | 'mode'
): number | null {
    if (!dataArray || dataArray.length === 0) return null;

    let sum = 0;
    let count = 0;

    for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i];
        if (val !== undefined && val !== nodata && val > -9998) {
            sum += val;
            count++;
        }
    }

    if (count === 0) return null;

    let result = type === 'avg' ? (sum / count) : sum;
    if (scale) {
        result *= scale;
    }

    return parseFloat(result.toFixed(4));
}

/** Concurrency-limited daily grid fetch */
const DAILY_CONCURRENCY = 8; // Process 8 days at a time (each day = 2 grid reads)

export async function getRegionHistory(region: Region, startDateStr: string, endDateStr: string): Promise<Result<RegionHistoryData[], AppError>> {
    const t0 = Date.now();
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return Err(AppErrors.validation(`Unknown region: ${region}`));

    // ── Check response-level cache ──
    const cacheKey = `reghist_${region}_${startDateStr}_${endDateStr}`;
    const cached = historyCache.get(cacheKey);
    if (cached) {
        structuredLog('info', 'region_history_cached', { region, days: cached.length, durationMs: Date.now() - t0 });
        return Ok(cached);
    }

    // 1. Get timeline
    const timelineResult = await metadataService.getDates(region);
    if (!timelineResult.ok) return Err(timelineResult.error);

    const availableDates: string[] = [];
    const nested = timelineResult.value.availableDates;
    for (const year of Object.keys(nested).sort()) {
        const months = nested[year];
        if (!months) continue;
        for (const month of Object.keys(months).sort()) {
            const days = months[month]?.sort((a: number, b: number) => a - b) || [];
            for (const day of days) {
                availableDates.push(`${year}-${month.padStart(2, '0')}-${String(day).padStart(2, '0')}`);
            }
        }
    }

    const rangeDates = availableDates.filter(d => d >= startDateStr && d <= endDateStr);
    if (rangeDates.length === 0) return Ok([]);

    // 2. Fetch static layers once (with dedicated cache)
    const staticCacheKey = `static_${region}`;
    let staticData = staticLayerCache.get(staticCacheKey);

    if (!staticData) {
        const firstDate = rangeDates[0];
        const [demRes, slopeRes, flowRes, lcRes] = await Promise.all([
            gridService.getGrid({ region: region as 'DaNang', date: firstDate as any, layer: 'dem' }),
            gridService.getGrid({ region: region as 'DaNang', date: firstDate as any, layer: 'slope' }),
            gridService.getGrid({ region: region as 'DaNang', date: firstDate as any, layer: 'flow' }),
            gridService.getGrid({ region: region as 'DaNang', date: firstDate as any, layer: 'landCover' })
        ]);

        staticData = {
            avgDem: (demRes.ok && demRes.value?.data) ? calculateGridStats(demRes.value.data, demRes.value.nodata, demRes.value.scale, 'avg') : null,
            avgSlope: (slopeRes.ok && slopeRes.value?.data) ? calculateGridStats(slopeRes.value.data, slopeRes.value.nodata, slopeRes.value.scale, 'avg') : null,
            avgFlow: (flowRes.ok && flowRes.value?.data) ? calculateGridStats(flowRes.value.data, flowRes.value.nodata, flowRes.value.scale, 'sum') : null,
            avgLandCover: (lcRes.ok && lcRes.value?.data) ? calculateGridStats(lcRes.value.data, lcRes.value.nodata, lcRes.value.scale, 'avg') : null,
        };
        staticLayerCache.set(staticCacheKey, staticData);
    }

    // 3. Fetch dynamic (daily) data with CONCURRENCY LIMITER
    const results: RegionHistoryData[] = [];

    for (let i = 0; i < rangeDates.length; i += DAILY_CONCURRENCY) {
        const batch = rangeDates.slice(i, i + DAILY_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (dateStr) => {
                let totalRainfall: number | null = null;
                let avgSoilMoisture: number | null = null;

                const [rainRes, smRes] = await Promise.all([
                    gridService.getGrid({ region: region as 'DaNang', date: dateStr as any, layer: 'rain' }),
                    gridService.getGrid({ region: region as 'DaNang', date: dateStr as any, layer: 'soilMoisture' })
                ]);

                if (rainRes.ok && rainRes.value?.data) {
                    totalRainfall = calculateGridStats(rainRes.value.data, rainRes.value.nodata, rainRes.value.scale, 'sum');
                }

                if (smRes.ok && smRes.value?.data) {
                    avgSoilMoisture = calculateGridStats(smRes.value.data, smRes.value.nodata, smRes.value.scale, 'avg');
                }

                return {
                    date: dateStr,
                    totalRainfall,
                    avgSoilMoisture,
                    avgDem: staticData!.avgDem,
                    avgSlope: staticData!.avgSlope,
                    avgFlow: staticData!.avgFlow,
                    avgLandCover: staticData!.avgLandCover
                };
            })
        );
        results.push(...batchResults);
    }

    results.sort((a, b) => a.date.localeCompare(b.date));

    // Cache the result
    historyCache.set(cacheKey, results);

    structuredLog('info', 'region_history', { region, days: results.length, durationMs: Date.now() - t0 });
    return Ok(results);
}
