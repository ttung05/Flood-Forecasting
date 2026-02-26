/**
 * Pixel Service — Business logic for pixel data retrieval.
 *
 * Strategy:
 *   1. Try Stacked COG (1 file, 8 bands) → best performance
 *   2. Fallback to legacy 8 separate TIF files
 *   3. Derive flood risk from data
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import {
    REGION_BOUNDS, STACKED_BAND_NAMES, STACKED_BAND_SCALES,
    LAYER_FOLDER_MAP, deriveFloodRisk,
} from '../../shared/types/common';
import type { PixelParams, PixelData } from './pixel.types';
import { MemoryCache } from '../../shared/cache/memory-cache';
import { structuredLog, nextTraceId } from '../../shared/middleware/tracing';

// ── Caches ─────────────────────────────────────────────────
const tifImageCache = new MemoryCache<any>(30, 60 * 60 * 1000);   // L1: parsed TIF image
const pixelCache = new MemoryCache<any>(500, 60 * 60 * 1000);      // L1: pixel results

// ── Dependencies (injected from legacy api.js for now) ─────
let _getCachedTifImage: ((key: string) => Promise<any>) | null = null;
let _readPixelFromR2Tif: ((key: string, lat: number, lng: number, scale: number) => Promise<number | null>) | null = null;
let _tifKey: ((region: string, info: any, date: string) => string) | null = null;

export function injectDeps(deps: {
    getCachedTifImage: (key: string) => Promise<any>;
    readPixelFromR2Tif: (key: string, lat: number, lng: number, scale: number) => Promise<number | null>;
    tifKey: (region: string, info: any, date: string) => string;
}) {
    _getCachedTifImage = deps.getCachedTifImage;
    _readPixelFromR2Tif = deps.readPixelFromR2Tif;
    _tifKey = deps.tifKey;
}

// ── Stacked COG reader ─────────────────────────────────────
async function readFromStackedCOG(
    region: string, date: string, lat: number, lng: number,
): Promise<Record<string, number | null> | null> {
    if (!_getCachedTifImage) return null;

    const r2Key = `FloodData/${region}/Stacked/stacked_${date}.tif`;
    const cacheKey = `stacked_${r2Key}_${lat.toFixed(4)}_${lng.toFixed(4)}`;

    const cached = pixelCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const img = await _getCachedTifImage(r2Key);
        const [west, south, east, north] = img.getBoundingBox();
        const width = img.getWidth();
        const height = img.getHeight();

        const col = Math.floor((lng - west) / (east - west) * width);
        const row = Math.floor((north - lat) / (north - south) * height);

        if (col < 0 || col >= width || row < 0 || row >= height) {
            pixelCache.set(cacheKey, null);
            return null;
        }

        const rasterData = await img.readRasters({ window: [col, row, col + 1, row + 1] });
        const nodataStr = img.fileDirectory?.GDAL_NODATA;
        const nod = nodataStr !== undefined ? parseFloat(nodataStr) : -9999;

        const result: Record<string, number | null> = {};
        for (let i = 0; i < STACKED_BAND_NAMES.length; i++) {
            const bandName = STACKED_BAND_NAMES[i];
            const scale = STACKED_BAND_SCALES[i];
            if (!bandName || scale === undefined) continue;
            const band = rasterData[i];
            const raw = band ? (band as Float64Array)[0] : null;
            if (raw === null || raw === undefined || raw === nod || isNaN(raw) || raw <= -9998) {
                result[bandName] = null;
            } else {
                result[bandName] = parseFloat((raw / scale).toFixed(4));
            }
        }

        pixelCache.set(cacheKey, result);
        return result;
    } catch {
        return null;
    }
}

// ── Legacy 8-TIF reader ────────────────────────────────────
async function readFromLegacy8Tif(
    region: string, date: string, lat: number, lng: number,
): Promise<Record<string, number | null>> {
    if (!_readPixelFromR2Tif || !_tifKey) throw new Error('Dependencies not injected');

    const L = LAYER_FOLDER_MAP;
    const [rainfall, soilMoisture, tide, flood, dem, slope, flow, landCover] = await Promise.all([
        _readPixelFromR2Tif(_tifKey(region, L['rain']!, date), lat, lng, L['rain']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['soilMoisture']!, date), lat, lng, L['soilMoisture']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['tide']!, date), lat, lng, L['tide']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['label']!, date), lat, lng, L['label']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['dem']!, date), lat, lng, L['dem']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['slope']!, date), lat, lng, L['slope']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['flow']!, date), lat, lng, L['flow']!.scale),
        _readPixelFromR2Tif(_tifKey(region, L['landCover']!, date), lat, lng, L['landCover']!.scale),
    ]);

    return { rainfall, soilMoisture, tide, flood, dem, slope, flow, landCover };
}

// ── Main Service Method ────────────────────────────────────
export async function getPixel(params: PixelParams): Promise<Result<PixelData, AppError>> {
    const t0 = Date.now();
    const traceId = nextTraceId('px');
    const { lat, lng, date, region } = params;

    // Bounds check
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return Err(AppErrors.validation(`Unknown region: ${region}`));
    if (lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) {
        return Err(AppErrors.outOfBounds(`Coordinates (${lat}, ${lng}) outside ${region}`));
    }

    let dataSource: 'stacked_cog' | 'legacy_8tif' = 'stacked_cog';
    let values: Record<string, number | null>;

    // Strategy 1: Stacked COG
    const stackedResult = await readFromStackedCOG(region, date, lat, lng);
    if (stackedResult) {
        values = stackedResult;
    } else {
        // Strategy 2: Legacy 8 TIF
        dataSource = 'legacy_8tif';
        structuredLog('info', 'pixel_fallback_legacy', { region, date, traceId });
        try {
            values = await readFromLegacy8Tif(region, date, lat, lng);
        } catch (err) {
            return Err(AppErrors.internal(`Failed to read pixel: ${(err as Error).message}`));
        }
    }

    const hasData = Object.values(values).some(v => v !== null);
    if (!hasData) {
        return Err(AppErrors.notFound(`No data for ${region} on ${date}`));
    }

    const floodRisk = deriveFloodRisk(values.flood ?? null, values.rainfall ?? null);
    const elapsed = Date.now() - t0;

    structuredLog('info', 'pixel_response', {
        traceId, region, date, durationMs: elapsed, source: dataSource, floodRisk,
        cacheStats: { tif: tifImageCache.size, pixel: pixelCache.size },
    });

    return Ok({
        lat, lng, date, region,
        rainfall: values.rainfall ?? null,
        soilMoisture: values.soilMoisture ?? null,
        tide: values.tide ?? null,
        flood: values.flood ?? null,
        dem: values.dem ?? null,
        slope: values.slope ?? null,
        flow: values.flow ?? null,
        landCover: values.landCover ?? null,
        floodRisk,
        bounds: { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west },
        metadata: {
            source: dataSource,
            traceId,
            responseTimeMs: elapsed,
            cacheSize: { tif: tifImageCache.size, pixel: pixelCache.size },
        },
    });
}
