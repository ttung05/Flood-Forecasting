/**
 * NPZ Reader — Parse numpy .npz files from R2 for pixel data.
 *
 * NPZ = zip archive containing .npy files.
 * .npy = magic + header (shape, dtype) + raw binary data.
 *
 * This module downloads NPZ from R2, parses the 'x' array (8 bands)
 * and 'y' array (flood label), caches the result, and provides
 * pixel lookup by lat/lng using region bounds.
 */
import AdmZip from 'adm-zip';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { loadEnv } from '../config/env';
import { MemoryCache } from '../cache/memory-cache';
import { structuredLog } from '../middleware/tracing';
import { REGION_BOUNDS, STACKED_BAND_NAMES } from '../types/common';

// NPZ R2 key pattern — use 'visualize' (raw physical values) instead of 'training' (normalized)
const NPZ_PREFIX = 'visualize/2020-2025/Data_Training_Raw_NPZ';
function npzKey(date: string): string {
    return `${NPZ_PREFIX}/Sample_${date}.npz`;
}

// ── Singleton S3 Client (avoid recreating per request — saves ~500ms each) ──
let _s3Client: S3Client | null = null;
function getS3Client(): S3Client {
    if (_s3Client) return _s3Client;
    const env = loadEnv();
    _s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID!,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        },
    });
    return _s3Client;
}

// ── NPZ Disk Cache (survives server restarts) ──
const NPZ_DISK_CACHE_DIR = path.resolve(process.cwd(), 'data', 'npz_cache');

function ensureDiskCacheDir(): void {
    if (!fs.existsSync(NPZ_DISK_CACHE_DIR)) {
        fs.mkdirSync(NPZ_DISK_CACHE_DIR, { recursive: true });
    }
}

function diskCachePath(date: string): string {
    return path.join(NPZ_DISK_CACHE_DIR, `Sample_${date}.npz`);
}

interface ParsedNpz {
    x: Float32Array; // flattened (8 * H * W)
    y: Float32Array; // flattened (H * W)
    bands: number;
    height: number;
    width: number;
}

// Cache parsed NPZ data (each ~25MB raw, ~32MB parsed)
// Larger cache reduces repeat downloads when history/batch touches many consecutive dates (~960MB max @ 30 entries)
const npzCache = new MemoryCache<ParsedNpz>(30, 2 * 60 * 60 * 1000);
const pendingLoads = new Map<string, Promise<ParsedNpz | null>>();

/**
 * Parse a .npy buffer into typed array + shape.
 * Format: \x93NUMPY + version(2B) + header_len(2B or 4B) + header_str + raw_data
 */
function parseNpy(buf: Buffer): { data: Float32Array; shape: number[] } {
    // Magic: first byte is 0x93 (above ASCII range), followed by 'NUMPY'
    if (buf[0] !== 0x93 || buf.toString('ascii', 1, 6) !== 'NUMPY') {
        throw new Error('Not a valid .npy file');
    }

    const major = buf[6]!;
    let headerLen: number;
    let headerOffset: number;

    if (major === 1) {
        headerLen = buf.readUInt16LE(8);
        headerOffset = 10;
    } else {
        headerLen = buf.readUInt32LE(8);
        headerOffset = 12;
    }

    const headerStr = buf.toString('ascii', headerOffset, headerOffset + headerLen);

    // Parse shape from header like "{'descr': '<f4', 'fortran_order': False, 'shape': (8, 1115, 1856), }"
    const shapeMatch = headerStr.match(/shape['"]\s*:\s*\(([^)]+)\)/);
    if (!shapeMatch) throw new Error(`Cannot parse shape from npy header: ${headerStr}`);
    const shape = shapeMatch[1]!.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

    const descrMatch = headerStr.match(/descr['"]\s*:\s*'([^']+)'/);
    const descr = descrMatch ? descrMatch[1]! : '<f4';

    const dataOffset = headerOffset + headerLen;
    const totalElements = shape.reduce((a, b) => a * b, 1);

    let data: Float32Array;
    if (descr === '<f4' || descr === 'float32') {
        data = new Float32Array(buf.buffer, buf.byteOffset + dataOffset, totalElements);
    } else if (descr === '<f8' || descr === 'float64') {
        const f64 = new Float64Array(buf.buffer, buf.byteOffset + dataOffset, totalElements);
        data = new Float32Array(f64);
    } else {
        // Best effort: treat as float32
        data = new Float32Array(buf.buffer, buf.byteOffset + dataOffset, totalElements);
    }

    return { data, shape };
}

/**
 * Load and parse NPZ from local filesystem (fallback when R2 is unreachable).
 */
import fs from 'fs';
import path from 'path';

const LOCAL_NPZ_DIR = path.resolve(process.cwd(), 'data', 'training', 'Data_Training_Raw_NPZ');

export async function loadNpzFromLocal(date: string): Promise<ParsedNpz | null> {
    const cacheKey = `npz_${date}`;
    const cached = npzCache.get(cacheKey);
    if (cached) return cached;

    const filePath = path.join(LOCAL_NPZ_DIR, `Sample_${date}.npz`);
    if (!fs.existsSync(filePath)) return null;

    try {
        const t0 = Date.now();
        const buf = fs.readFileSync(filePath);
        const zip = new AdmZip(buf);
        const entries = zip.getEntries();

        let xData: Float32Array | null = null;
        let yData: Float32Array | null = null;
        let xShape: number[] = [];

        for (const entry of entries) {
            if (entry.entryName === 'x.npy') {
                const parsed = parseNpy(entry.getData());
                xData = parsed.data;
                xShape = parsed.shape;
            } else if (entry.entryName === 'y.npy') {
                const parsed = parseNpy(entry.getData());
                yData = parsed.data;
            }
        }

        if (!xData || xShape.length !== 3) return null;

        const [bands, height, width] = xShape as [number, number, number];
        const result: ParsedNpz = {
            x: xData,
            y: yData || new Float32Array(height * width),
            bands, height, width,
        };

        npzCache.set(cacheKey, result);
        structuredLog('info', 'npz_local_loaded', { date, durationMs: Date.now() - t0, bands, height, width });
        return result;
    } catch (e) {
        structuredLog('error', 'npz_local_error', { date, error: (e as Error).message });
        return null;
    }
}

/**
 * List available dates from local NPZ files.
 */
export function listLocalNpzDates(): string[] {
    if (!fs.existsSync(LOCAL_NPZ_DIR)) return [];
    const files = fs.readdirSync(LOCAL_NPZ_DIR);
    return files
        .filter(f => f.startsWith('Sample_') && f.endsWith('.npz'))
        .map(f => f.replace('Sample_', '').replace('.npz', ''))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
}

/**
 * List available dates from R2 NPZ files (scan bucket prefix).
 * Cached for 10 minutes to avoid excessive ListObjects calls.
 */
const r2DatesCache = new MemoryCache<string[]>(1, 10 * 60 * 1000);
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

export async function listR2NpzDates(): Promise<string[]> {
    const cacheKey = 'r2_npz_dates';
    const cached = r2DatesCache.get(cacheKey);
    if (cached) return cached;

    const s3 = getS3Client();

    const dates: string[] = [];
    let token: string | undefined;

    try {
        const env = loadEnv(); // Load env here to get bucket name
        if (!env.R2_BUCKET_NAME) {
            structuredLog('error', 'r2_npz_dates_error', { error: 'R2_BUCKET_NAME not set' });
            return [];
        }

        do {
            const res = await s3.send(new ListObjectsV2Command({
                Bucket: env.R2_BUCKET_NAME,
                Prefix: `${NPZ_PREFIX}/Sample_`,
                MaxKeys: 1000,
                ContinuationToken: token,
            }));

            for (const obj of (res.Contents || [])) {
                const match = obj.Key?.match(/Sample_(\d{4}-\d{2}-\d{2})\.npz$/);
                if (match) dates.push(match[1]!);
            }

            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);

        dates.sort();
        r2DatesCache.set(cacheKey, dates);
        structuredLog('info', 'r2_npz_dates_listed', { count: dates.length, firstDate: dates[0], lastDate: dates[dates.length - 1] });
        return dates;
    } catch (e) {
        structuredLog('error', 'r2_npz_dates_error', { error: (e as Error).message });
        return [];
    }
}

/**
 * Compute region-average rainfall (mm) from local NPZ for the trend chart.
 * Band 0 = rainfall — auto-detects whether normalized (0-1) or physical (mm).
 * Samples a 20×20 grid and returns the mean rainfall in mm.
 */
export async function getLocalRainfallTotal(date: string, region: string): Promise<number | null> {
    const npz = await loadNpzFromLocal(date);
    if (!npz) return null;

    const { x, bands, height, width } = npz;
    if (bands < 1) return null;

    const bounds = REGION_BOUNDS[region];
    const gridRows = bounds?.rows ?? 20;
    const gridCols = bounds?.cols ?? 20;

    const samples: number[] = [];
    for (let gr = 0; gr < gridRows; gr++) {
        for (let gc = 0; gc < gridCols; gc++) {
            const r = Math.floor((gr + 0.5) / gridRows * height);
            const c = Math.floor((gc + 0.5) / gridCols * width);
            const idx = 0 * height * width + r * width + c;
            const val = x[idx];
            if (val !== undefined && !isNaN(val) && val >= 0) {
                samples.push(val);
            }
        }
    }

    if (samples.length === 0) return 0;

    const rawMean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const maxSample = Math.max(...samples);

    // Auto-detect normalization: if max <= 1.5, data is in [0,1] range → denorm × 200
    const mean = maxSample <= 1.5 ? rawMean * 200 : rawMean;

    return parseFloat(mean.toFixed(2));
}

/**
 * Download and parse NPZ from R2.
 * Disk cache: check local file first, save after download.
 */
export async function loadNpzFromR2(date: string): Promise<ParsedNpz | null> {
    const key = npzKey(date);
    const cacheKey = `npz_${date}`;

    const cached = npzCache.get(cacheKey);
    if (cached) return cached;

    if (pendingLoads.has(cacheKey)) {
        return pendingLoads.get(cacheKey)!;
    }

    const loadPromise = (async (): Promise<ParsedNpz | null> => {
        try {
            let buf: Buffer;
            const diskPath = diskCachePath(date);

            // Strategy A: Read from disk cache (instant, ~5ms)
            if (fs.existsSync(diskPath)) {
                const t0 = Date.now();
                buf = fs.readFileSync(diskPath);
                structuredLog('info', 'npz_disk_cache_hit', { date, bytes: buf.byteLength, durationMs: Date.now() - t0 });
            } else {
                // Strategy B: Download from R2 and save to disk
                const env = loadEnv();
                if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
                    structuredLog('error', 'npz_no_creds', { key });
                    return null;
                }

                structuredLog('info', 'npz_download_start', { key });
                const t0 = Date.now();
                const s3 = getS3Client();
                const resp = await s3.send(new GetObjectCommand({
                    Bucket: env.R2_BUCKET_NAME,
                    Key: key,
                }));

                const arr = await resp.Body?.transformToByteArray();
                if (!arr) {
                    structuredLog('error', 'npz_empty_body', { key });
                    return null;
                }

                buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
                const downloadMs = Date.now() - t0;
                structuredLog('info', 'npz_downloaded', { key, downloadMs, bytes: buf.byteLength });

                // Save to disk cache (background, non-blocking)
                try {
                    ensureDiskCacheDir();
                    fs.writeFileSync(diskPath, buf);
                    structuredLog('info', 'npz_disk_cache_saved', { date, bytes: buf.byteLength });
                } catch (diskErr) {
                    structuredLog('warn', 'npz_disk_cache_save_error', { date, error: (diskErr as Error).message });
                }
            }

            // Parse zip
            const zip = new AdmZip(buf);
            const entries = zip.getEntries();

            let xData: Float32Array | null = null;
            let yData: Float32Array | null = null;
            let xShape: number[] = [];
            let yShape: number[] = [];

            for (const entry of entries) {
                const name = entry.entryName;
                if (name === 'x.npy') {
                    const npyBuf = entry.getData();
                    const parsed = parseNpy(npyBuf);
                    xData = parsed.data;
                    xShape = parsed.shape;
                } else if (name === 'y.npy') {
                    const npyBuf = entry.getData();
                    const parsed = parseNpy(npyBuf);
                    yData = parsed.data;
                    yShape = parsed.shape;
                }
            }

            if (!xData || xShape.length !== 3) {
                structuredLog('error', 'npz_invalid_x', { key, xShape });
                return null;
            }

            const [bands, height, width] = xShape as [number, number, number];
            const result: ParsedNpz = {
                x: xData,
                y: yData || new Float32Array(height * width),
                bands,
                height,
                width,
            };

            npzCache.set(cacheKey, result);
            structuredLog('info', 'npz_loaded', {
                key, bands, height, width,
                xLen: xData.length, yLen: result.y.length,
            });
            return result;
        } catch (e) {
            structuredLog('error', 'npz_load_error', { key, error: (e as Error).message });
            return null;
        } finally {
            pendingLoads.delete(cacheKey);
        }
    })();

    pendingLoads.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * De-normalization from GEE unitScale ranges.
 *
 * NOTE: Using Raw NPZ (visualize folder) — values are already physical.
 * This function now passes through raw values without transformation.
 * Kept for API compatibility with readPixelFromNpz.
 */
function denormalize(bandName: string, raw: number): number {
    // Raw NPZ already contains physical values — no transformation needed
    return raw;
}

/**
 * Read pixel values from NPZ file on R2.
 * Returns de-normalized physical values keyed by STACKED_BAND_NAMES.
 */
export async function readPixelFromNpz(
    region: string,
    date: string,
    lat: number,
    lng: number,
): Promise<Record<string, number | null> | null> {
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return null;

    const npz = await loadNpzFromR2(date);
    if (!npz) return null;

    const { x, y, bands, height, width } = npz;

    // Map lat/lng to row/col
    const col = Math.floor((lng - bounds.west) / (bounds.east - bounds.west) * width);
    const row = Math.floor((bounds.north - lat) / (bounds.north - bounds.south) * height);

    if (col < 0 || col >= width || row < 0 || row >= height) return null;

    const result: Record<string, number | null> = {};
    for (let i = 0; i < Math.min(bands, STACKED_BAND_NAMES.length); i++) {
        const bandName = STACKED_BAND_NAMES[i]!;
        const idx = i * height * width + row * width + col;
        const val = x[idx];
        if (val === undefined || isNaN(val)) {
            result[bandName] = null;
        } else {
            // Raw NPZ already has physical values — pass through
            result[bandName] = parseFloat(val.toFixed(4));
        }
    }

    // Flood label comes from y.npy (separate array) in Raw NPZ
    if (y && y.length > 0) {
        const floodIdx = row * width + col;
        const floodVal = y[floodIdx];
        if (floodVal !== undefined && !isNaN(floodVal)) {
            // y.npy contains raw values (can be large negatives like -19.62 for flooded areas)
            // Convert to binary: value <= -30 → 1 (flooded), else → 0 (not flooded)
            // This matches grid.service.ts logic for label layer
            result['flood'] = floodVal <= -30 ? 1 : 0;
        } else {
            result['flood'] = null;
        }
    }

    return result;
}

/**
 * Preload multiple NPZ files in parallel (for batch/history requests).
 * This avoids serial downloads when processing many dates.
 * @param dates - Array of date strings to preload
 * @param concurrency - Max concurrent downloads (default 6)
 */
export async function preloadNpzDates(dates: string[], concurrency = 14): Promise<void> {
    // Filter out dates that are already cached
    const uncachedDates = dates.filter(d => !npzCache.get(`npz_${d}`) && !pendingLoads.has(`npz_${d}`));
    if (uncachedDates.length === 0) return;

    structuredLog('info', 'npz_preload_start', { count: uncachedDates.length, total: dates.length });
    const t0 = Date.now();

    for (let i = 0; i < uncachedDates.length; i += concurrency) {
        const batch = uncachedDates.slice(i, i + concurrency);
        await Promise.allSettled(
            batch.map(date => {
                // Try local first, then R2
                return loadNpzFromLocal(date).then(result => {
                    if (!result) return loadNpzFromR2(date);
                    return result;
                });
            })
        );
    }

    structuredLog('info', 'npz_preload_done', {
        preloaded: uncachedDates.length,
        durationMs: Date.now() - t0,
    });
}

/**
 * Preload NPZ files for adjacent dates (±count days).
 * Fire-and-forget: runs in background to warm cache for date switching.
 * @param date - Center date (YYYY-MM-DD)
 * @param count - Number of days before and after to preload (default 2)
 */
export async function preloadAdjacentNpz(date: string, count = 2): Promise<void> {
    const dates: string[] = [];
    const d = new Date(date + 'T00:00:00Z');
    for (let i = -count; i <= count; i++) {
        if (i === 0) continue; // Skip current date (already loaded)
        const adj = new Date(d);
        adj.setUTCDate(adj.getUTCDate() + i);
        dates.push(adj.toISOString().split('T')[0]!);
    }
    // Low concurrency to avoid overwhelming R2 while user is browsing
    await preloadNpzDates(dates, 3).catch(() => {});
}
