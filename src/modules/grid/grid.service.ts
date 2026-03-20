/**
 * Grid Service — Serves pre-built grid JSON or generates from TIF/NPZ.
 *
 * Strategy priority:
 *   1. In-memory cache (fastest)
 *   2. Pre-built JSON from R2 (zero decode)
 *   3. On-the-fly TIF decode from R2 (COG range request)
 *   4. Local NPZ file decode (offline fallback)
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import { MemoryCache } from '../../shared/cache/memory-cache';
import { structuredLog } from '../../shared/middleware/tracing';
import type { GridParams, GridJSON } from './grid.types';
import { getEnv } from '../../shared/config/env';
import { LAYER_FOLDER_MAP, REGION_BOUNDS, STACKED_BAND_NAMES } from '../../shared/types/common';
import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';

const gridCache = new MemoryCache<GridJSON>(500, 60 * 60 * 1000);

// Layer name → NPZ band index (matches Raw NPZ merger file)
// x.npy bands: [Rain(T), Rain(T-1), Rain(T-2), SoilMoisture, Tide, DEM, Slope, FlowAcc]
// y.npy: Label (flood probability)
const LAYER_TO_BAND_INDEX: Record<string, number> = {
    rain: 0, soilMoisture: 3, tide: 4,
    dem: 5, slope: 6, flow: 7,
    // label (flood): from y.npy (not in x bands)
    // landCover: not available in Raw NPZ
};

let tifFailCount = 0;
const TIF_FAIL_THRESHOLD = 3;

function denormalizeNpz(bandName: string, raw: number): number {
    switch (bandName) {
        case 'rainfall':     return Math.round(raw * 200 * 100) / 100;
        case 'soilMoisture': return Math.round(raw * 0.5 * 10000) / 10000;
        case 'tide':         return Math.round((raw * 3.0 - 1.5) * 1000) / 1000;
        case 'slope':        return Math.round(raw * 90 * 100) / 100;
        case 'flow':         return raw > 0 ? Math.round((Math.pow(10, raw * 5) - 1) * 100) / 100 : 0;
        case 'dem':          return Math.round(raw * 10000) / 10000;
        case 'landCover':    return Math.round(raw * 100000) / 100000;
        case 'flood':        return raw >= 0.5 ? 1 : 0;
        default:             return raw;
    }
}

// ── Dependencies ───────────────────────────────────────────
let _r2GetBuffer: ((key: string) => Promise<Buffer>) | null = null;
let _r2GetJson: ((key: string) => Promise<any>) | null = null;
let _tifKey: ((region: string, layerInfo: any, date: string) => string) | null = null;
let _getCachedTifImage: ((r2Key: string) => Promise<any>) | null = null;

export function injectDeps(deps: {
    r2GetJson?: (key: string) => Promise<any>;
    r2GetBuffer?: (key: string) => Promise<Buffer>;
    tifKey?: (region: string, layerInfo: any, date: string) => string;
    getCachedTifImage?: (r2Key: string) => Promise<any>;
}) {
    _r2GetJson = deps.r2GetJson ?? null;
    _r2GetBuffer = deps.r2GetBuffer ?? null;
    _tifKey = deps.tifKey ?? null;
    _getCachedTifImage = deps.getCachedTifImage ?? null;
}

const CATEGORICAL_LAYERS = new Set(['label', 'landCover']);

export function downsampleGrid(grid: GridJSON, maxRows: number): GridJSON {
    const { r: srcRows, c: srcCols } = grid.size;
    if (srcRows <= maxRows) return grid;

    const ratio = maxRows / srcRows;
    const dstRows = maxRows;
    const dstCols = Math.max(1, Math.round(srcCols * ratio));

    const rowStep = srcRows / dstRows;
    const colStep = srcCols / dstCols;
    const data = new Float32Array(dstRows * dstCols);
    const isCat = CATEGORICAL_LAYERS.has(grid.layer);

    for (let dr = 0; dr < dstRows; dr++) {
        for (let dc = 0; dc < dstCols; dc++) {
            if (isCat) {
                const srcR = Math.min(Math.floor((dr + 0.5) * rowStep), srcRows - 1);
                const srcC = Math.min(Math.floor((dc + 0.5) * colStep), srcCols - 1);
                data[dr * dstCols + dc] = grid.data[srcR * srcCols + srcC]!;
            } else {
                const srcR0 = Math.floor(dr * rowStep);
                const srcR1 = Math.min(Math.floor((dr + 1) * rowStep), srcRows);
                const srcC0 = Math.floor(dc * colStep);
                const srcC1 = Math.min(Math.floor((dc + 1) * colStep), srcCols);

                let sum = 0, count = 0;
                for (let r = srcR0; r < srcR1; r++) {
                    for (let c = srcC0; c < srcC1; c++) {
                        const v = grid.data[r * srcCols + c]!;
                        if (v !== grid.nodata && v > -9998 && !isNaN(v)) {
                            sum += v;
                            count++;
                        }
                    }
                }
                data[dr * dstCols + dc] = count > 0
                    ? Math.round((sum / count) * 10000) / 10000
                    : grid.nodata;
            }
        }
    }

    return { ...grid, size: { r: dstRows, c: dstCols }, data };
}

export async function getGrid(params: GridParams): Promise<Result<GridJSON, AppError>> {
    const { region, date, layer } = params;
    const t0 = Date.now();
    const env = getEnv();
    const cacheKey = `grid_${region}_${date}_${layer}`;

    // ── Strategy 0: In-memory cache ──
    const cached = gridCache.get(cacheKey);
    if (cached) {
        structuredLog('info', 'grid_cache_hit', { region, date, layer, durationMs: Date.now() - t0 });
        return Ok(cached);
    }

    // ── Strategy 0.5: Pre-built .gridbin file from Cloudflare R2 ──
    // ── Strategy 0.5 + Strategy 1: DISABLED ──
    // Pre-built gridbin and JSON do not exist for Raw NPZ (visualize/) data.
    // Skipping them saves ~400-800ms per request (2 failed R2 calls).

    // ── Validate layer & region (shared by Strategy 2 + 3) ──
    const layerInfo = LAYER_FOLDER_MAP[layer];
    if (!layerInfo) {
        return Err(AppErrors.validation(`Unknown layer: ${layer}`));
    }
    const bounds = REGION_BOUNDS[region];
    if (!bounds) {
        return Err(AppErrors.validation(`Unknown region: ${region}`));
    }

    // ── Strategy 2: DISABLED ──
    // TIF files do not exist for Raw NPZ (visualize/) data.
    // Skipping saves ~200-500ms per request (1 failed R2 request).

    // ── Strategy 3: Local NPZ file decode (and R2 fallback) ──
    try {
        const { loadNpzFromLocal, loadNpzFromR2 } = await import('../../shared/legacy/npz-reader');
        let npz = await loadNpzFromLocal(date);
        if (!npz) {
            npz = await loadNpzFromR2(date);
        }
        if (npz) {
            // Special handling: Label (flood) is in y.npy (not x.npy bands) in Raw NPZ
            if (layer === 'label') {
                const { y, height, width } = npz;
                const total = height * width;
                const data = new Float32Array(total);
                for (let i = 0; i < total; i++) {
                    const raw = y[i]!;
                    if (raw === undefined || isNaN(raw)) {
                        data[i] = -9999;
                    } else {
                        // Flood threshold: value <= -20 → flooded (1), value > -20 → not flooded (0)
                        data[i] = raw <= -20 ? 1 : 0;
                    }
                }
                const regionBounds = REGION_BOUNDS[region]!;
                const gridJson: GridJSON = {
                    v: 1, region, date, layer,
                    bounds: { n: regionBounds.north, s: regionBounds.south, e: regionBounds.east, w: regionBounds.west },
                    size: { r: height, c: width }, scale: 1, nodata: -9999, data,
                };
                gridCache.set(cacheKey, gridJson);
                structuredLog('info', 'grid_npz_decode', { region, date, layer, source: 'y.npy', rasterSize: `${width}x${height}`, durationMs: Date.now() - t0 });
                return Ok(gridJson);
            }

            // landCover not available in Raw NPZ
            if (layer === 'landCover') {
                return Err(AppErrors.notFound(`Layer "landCover" not available in Raw NPZ`));
            }

            const bandIdx = LAYER_TO_BAND_INDEX[layer];
            if (bandIdx === undefined || bandIdx >= npz.bands) {
                return Err(AppErrors.validation(`Layer "${layer}" not available in NPZ (bands=${npz.bands})`));
            }

            const bandName = STACKED_BAND_NAMES[bandIdx];
            const { x, height, width } = npz;
            const total = height * width;
            const bandOffset = bandIdx * total;

            const data = new Float32Array(total);
            for (let i = 0; i < total; i++) {
                const raw = x[bandOffset + i]!;
                if (raw === undefined || isNaN(raw)) {
                    data[i] = -9999;
                } else {
                    // Raw NPZ (visualize folder) already contains physical values — no denormalization needed
                    data[i] = Math.round(raw * 10000) / 10000;
                }
            }

            const regionBounds = REGION_BOUNDS[region]!;
            const gridJson: GridJSON = {
                v: 1,
                region, date, layer,
                bounds: {
                    n: regionBounds.north, s: regionBounds.south,
                    e: regionBounds.east, w: regionBounds.west,
                },
                size: { r: height, c: width },
                scale: 1,
                nodata: -9999,
                data,
            };

            gridCache.set(cacheKey, gridJson);
            structuredLog('info', 'grid_npz_decode', {
                region, date, layer, bandIdx,
                rasterSize: `${width}x${height}`,
                durationMs: Date.now() - t0,
            });
            return Ok(gridJson);
        }
    } catch (err) {
        structuredLog('error', 'grid_npz_error', { region, date, layer, error: (err as Error).message });
    }

    return Err(AppErrors.notFound(`Grid data not available for ${layer} on ${date}`));
}
