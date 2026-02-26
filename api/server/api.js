/**
 * api.js – Flood Forecasting Backend API
 *
 * Architecture:
 *   - Data SOURCE:     GeoTIFF files in Cloudflare R2 (original .tif)
 *   - Pixel lookup:    Download TIF on-demand and read pixel via geotiff
 *   - Cache:           In-process LRU (R2 listing + pixel results)
 *
 * R2 Folder structure (TIF source):
 *   FloodData/{region}/Daily/Rain/Rain_YYYY_MM_DD.tif
 *   FloodData/{region}/LabelDaily/Flood/Flood_YYYY_MM_DD.tif
 *   FloodData/{region}/Static/DEM/DEM.tif
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const https = require('https');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ──────────────────────────────────────────────────────────────
// CLOUDFLARE R2 CLIENT (AWS S3-compatible)
// ──────────────────────────────────────────────────────────────
const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'satellite-data';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || `https://pub-${R2_ACCOUNT_ID}.r2.dev`;

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

if (!R2_ACCOUNT_ID) {
    console.warn('⚠️  R2_ACCOUNT_ID not set – R2 features will not work.');
}

// ──────────────────────────────────────────────────────────────
// HELPERS: Standard API Response Envelope
// ──────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, data });
}
function fail(res, message, status = 500, code = null) {
    console.error(`[API ${status}] ${message}`);
    return res.status(status).json({ success: false, error: { code: code || status, message } });
}

// ──────────────────────────────────────────────────────────────
// VALIDATION
// ──────────────────────────────────────────────────────────────
const VALID_REGIONS = ['DaNang'];
const VALID_LAYERS = ['rain', 'soilMoisture', 'tide', 'label'];

const LAYER_FOLDER_MAP = {
    rain: { sub: 'Daily', folder: 'Rain', prefix: 'Rain', scale: 1000 },
    soilMoisture: { sub: 'Daily', folder: 'SoilMoisture', prefix: 'SoilMoisture', scale: 1000 },
    tide: { sub: 'Daily', folder: 'Tide', prefix: 'Tide', scale: 1000 },
    label: { sub: 'LabelDaily', folder: '', prefix: 'Flood', scale: 1000 },
    dem: { sub: 'Static', prefix: 'DEM', isFlat: true, scale: 1 },
    slope: { sub: 'Static', prefix: 'Slope', isFlat: true, scale: 1 },
    flow: { sub: 'Static', prefix: 'Flow', isFlat: true, scale: 1 },
    landCover: { sub: 'Static', prefix: 'LandCover', isFlat: true, scale: 1 },
};

// GeoTIFF bounds per region (must match actual TIF data)
const REGION_BOUNDS = {
    DaNang: {
        north: 16.25, south: 15.95,
        east: 108.40, west: 107.90,
        rows: 20, cols: 20
    }
};

function isValidRegion(r) { return VALID_REGIONS.includes(r); }
function isValidDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    return !isNaN(new Date(d + 'T00:00:00Z').getTime());
}
function isValidCoord(lat, lng) {
    return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ──────────────────────────────────────────────────────────────
// 2-TIER CACHE: tifImageCache (parsed TIF objects) + pixelCache (results)
// ──────────────────────────────────────────────────────────────

// Tier 1: Parsed GeoTIFF Image objects (避免重复下载+解码)
const _tifImageCache = new Map();
const TIF_CACHE_MAX = 30;
const TIF_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

// Tier 2: Pixel/Grid results
const _cache = new Map();
const CACHE_MAX = 200;
const CACHE_TTL = 90 * 60 * 1000; // 90 minutes

function cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts >= CACHE_TTL) { _cache.delete(key); return null; }
    return e.v;
}
function cacheSet(key, value) {
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(key, { v: value, ts: Date.now() });
}

// TIF Image cache helpers
function tifCacheGet(key) {
    const e = _tifImageCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts >= TIF_CACHE_TTL) { _tifImageCache.delete(key); return null; }
    e.ts = Date.now(); // Refresh TTL on access
    return e.v;
}
function tifCacheSet(key, value) {
    if (_tifImageCache.size >= TIF_CACHE_MAX) _tifImageCache.delete(_tifImageCache.keys().next().value);
    _tifImageCache.set(key, { v: value, ts: Date.now() });
}

// ──────────────────────────────────────────────────────────────
// CONCURRENCY CONTROL (p-limit: max 5 simultaneous TIF decodes)
// ──────────────────────────────────────────────────────────────
let _limit;
async function getLimit() {
    if (!_limit) {
        const pLimit = (await import('p-limit')).default;
        _limit = pLimit(5);
    }
    return _limit;
}

// ──────────────────────────────────────────────────────────────
// R2 HELPERS
// ──────────────────────────────────────────────────────────────

/**
 * List all objects under a given R2 prefix.
 * Returns array of { Key, LastModified, Size }
 */
async function r2List(prefix) {
    const keys = [];
    let continuationToken;
    do {
        const cmd = new ListObjectsV2Command({
            Bucket: R2_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        });
        const res = await r2.send(cmd);
        (res.Contents || []).forEach(o => keys.push(o));
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
}

/**
 * Download an R2 object (binary) and return as Buffer.
 */
async function r2GetBuffer(key) {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const res = await r2.send(cmd);
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/**
 * Check if a key exists in R2. Returns true/false.
 */
async function r2Exists(key) {
    try {
        await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return true;
    } catch { return false; }
}

function tifKey(region, layerInfo, date) {
    if (layerInfo.isFlat) {
        return `FloodData/${region}/${layerInfo.sub}/${layerInfo.prefix}.tif`;
    }
    if (layerInfo.folder) {
        return `FloodData/${region}/${layerInfo.sub}/${layerInfo.folder}/${layerInfo.prefix}_${date}.tif`;
    }
    return `FloodData/${region}/${layerInfo.sub}/${layerInfo.prefix}_${date}.tif`;
}

// ──────────────────────────────────────────────────────────────
// DATE INDEX: Scan R2 TIF listing → available dates per region
// ──────────────────────────────────────────────────────────────

/**
 * Scan R2 for all TIF files of a region under FloodData/{region}/Daily/Rain/
 * to build the date index. Rain is used as the canonical "has this day" layer.
 *
 * Returns:
 * {
 *   region, date_range: {start, end}, total_days,
 *   available_dates: { "2000": { "01": [1, 8, 15, ...] }, ... },
 *   data_source: "r2"
 * }
 */
async function loadDateIndex(region) {
    const cacheKey = `dateindex_${region}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // Use Rain as canonical date availability check
    const canonicalLayer = LAYER_FOLDER_MAP.rain;
    const prefix = `FloodData/${region}/${canonicalLayer.sub}/${canonicalLayer.folder}/`;

    const objects = await r2List(prefix);

    const dateSet = new Set();
    const RE = /(\d{4})-(\d{2})-(\d{2})\.tif$/i;

    objects.forEach(obj => {
        const m = obj.Key.match(RE);
        if (m) dateSet.add(`${m[1]}-${m[2]}-${m[3]}`);
    });

    const sortedDates = Array.from(dateSet).sort();
    if (sortedDates.length === 0) return null;

    const available_dates = {};
    sortedDates.forEach(ds => {
        const [y, mo, d] = ds.split('-');
        if (!available_dates[y]) available_dates[y] = {};
        if (!available_dates[y][mo]) available_dates[y][mo] = [];
        available_dates[y][mo].push(parseInt(d, 10));
    });

    const index = {
        region,
        date_range: { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] },
        total_days: sortedDates.length,
        available_dates,
        data_source: 'r2',
    };

    cacheSet(cacheKey, index);
    return index;
}

// ──────────────────────────────────────────────────────────────
// GEOTIFF PIXEL LOOKUP
// ──────────────────────────────────────────────────────────────

let GeoTIFF; // lazy-loaded
async function getGeoTIFF() {
    if (!GeoTIFF) {
        GeoTIFF = await import('geotiff');
    }
    return GeoTIFF;
}

/**
 * Get or cache a parsed GeoTIFF Image object.
 * This avoids re-downloading and re-parsing the same TIF file.
 */
async function getCachedTifImage(r2Key) {
    const cached = tifCacheGet(r2Key);
    if (cached) return cached;

    const limit = await getLimit();
    return limit(async () => {
        // Double-check after acquiring semaphore
        const recheck = tifCacheGet(r2Key);
        if (recheck) return recheck;

        const buf = await r2GetBuffer(r2Key);
        const GT = await getGeoTIFF();
        const tiff = await GT.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const img = await tiff.getImage();
        tifCacheSet(r2Key, img);
        return img;
    });
}

/**
 * Read the entire grid values from an R2-hosted GeoTIFF.
 * Uses Tier-1 TIF Image cache to avoid redundant downloads.
 */
async function readGridFromR2Tif(r2Key, scale = 1) {
    const cacheKey = `grid_${r2Key}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    try {
        const img = await getCachedTifImage(r2Key);

        const [west, south, east, north] = img.getBoundingBox();
        const width = img.getWidth();
        const height = img.getHeight();

        const [rasters] = await img.readRasters();
        const nodata = img.fileDirectory.GDAL_NODATA;
        const nod = nodata !== undefined ? parseFloat(nodata) : -9999;

        const data = new Array(width * height);
        for (let i = 0; i < rasters.length; i++) {
            const rawValue = rasters[i];
            if (rawValue === nod || rawValue === null || isNaN(rawValue) || rawValue <= -9998) {
                data[i] = null;
            } else {
                data[i] = parseFloat((rawValue / scale).toFixed(4));
            }
        }

        const result = {
            data,
            bounds: { north, south, east, west },
            width,
            height
        };
        cacheSet(cacheKey, result);
        return result;
    } catch (err) {
        console.warn(`⚠️  readGridFromR2Tif(${r2Key}): ${err.message}`);
        return null;
    }
}

/**
 * Read one pixel value from an R2-hosted GeoTIFF at (lat, lng).
 * Uses Tier-1 TIF Image cache to avoid redundant downloads.
 * Returns numeric value or null.
 */
async function readPixelFromR2Tif(r2Key, lat, lng, scale = 1) {
    const cacheKey = `pixel_${r2Key}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    try {
        const img = await getCachedTifImage(r2Key);

        const [west, south, east, north] = img.getBoundingBox();
        const width = img.getWidth();
        const height = img.getHeight();

        // Compute pixel coordinates
        const col = Math.floor((lng - west) / (east - west) * width);
        const row = Math.floor((north - lat) / (north - south) * height);

        if (col < 0 || col >= width || row < 0 || row >= height) {
            cacheSet(cacheKey, null);
            return null;
        }

        // Read only the 1×1 window we need
        const [rasters] = await img.readRasters({ window: [col, row, col + 1, row + 1] });
        const rawValue = rasters[0];
        const nodata = img.fileDirectory.GDAL_NODATA;
        const nod = nodata !== undefined ? parseFloat(nodata) : -9999;

        const value = (rawValue === nod || rawValue === null || isNaN(rawValue) || rawValue <= -9998)
            ? null
            : parseFloat((rawValue / scale).toFixed(4));

        cacheSet(cacheKey, value);
        return value;
    } catch (err) {
        console.warn(`⚠️  readPixelFromR2Tif(${r2Key}): ${err.message}`);
        return null;
    }
}

// ──────────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────────

// ── GET /api/dates/:region ──────────────────────────────────────
router.get('/dates/:region', async (req, res) => {
    const { region } = req.params;
    if (!isValidRegion(region))
        return fail(res, `Invalid region "${region}". Valid: ${VALID_REGIONS.join(', ')}`, 400, 'INVALID_REGION');

    try {
        const index = await loadDateIndex(region);
        if (!index)
            return fail(res, `No TIF data found for region "${region}" in R2`, 404, 'NOT_FOUND');

        res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=300');
        return ok(res, {
            region: index.region,
            dateRange: index.date_range,
            totalDays: index.total_days,
            availableDates: index.available_dates,
            dataSources: { type: index.data_source },
        });
    } catch (err) {
        return fail(res, `Failed to load date index: ${err.message}`);
    }
});

// ── GET /api/timeline ──────────────────────────────────────────
router.get('/timeline', async (req, res) => {
    try {
        const dnResult = await loadDateIndex('DaNang');

        const allDates = new Set();
        function addDates(index) {
            if (!index?.available_dates) return;
            Object.entries(index.available_dates).forEach(([year, months]) => {
                Object.entries(months).forEach(([month, days]) => {
                    days.forEach(day => allDates.add(`${year}-${month}-${String(day).padStart(2, '0')}`));
                });
            });
        }
        addDates(dnResult);

        const dates = Array.from(allDates).sort();

        return ok(res, {
            dates,
            dateRange: { start: dates[0] || '2020-01-01', end: dates[dates.length - 1] || '' },
            totalDays: dates.length,
            regions: { DaNang: !!dnResult },
        });
    } catch (err) {
        return fail(res, `Failed to load timeline: ${err.message}`);
    }
});

// ── GET /api/pixel/:lat/:lng/:date/:region ─────────────────────
// Read pixel value from GeoTIFF in R2 for all layers
router.get('/pixel/:lat/:lng/:date/:region', async (req, res) => {
    const t0 = Date.now();
    const { region, date } = req.params;
    const lat = parseFloat(req.params.lat);
    const lng = parseFloat(req.params.lng);

    if (!isValidRegion(region)) return fail(res, `Invalid region "${region}"`, 400, 'INVALID_REGION');
    if (!isValidDate(date)) return fail(res, `Invalid date "${date}"`, 400, 'INVALID_DATE');
    if (!isValidCoord(lat, lng)) return fail(res, `Invalid coords lat=${lat} lng=${lng}`, 400, 'INVALID_COORDS');

    const bounds = REGION_BOUNDS[region];
    if (lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) {
        return fail(res, `Coordinates (${lat}, ${lng}) are outside region ${region} bounds`, 404, 'OUT_OF_BOUNDS');
    }

    try {
        // Read all daily and static layers in parallel
        const [rainfall, soilMoisture, tide, flood, dem, slope, flow, landCover] = await Promise.all([
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.rain, date), lat, lng, LAYER_FOLDER_MAP.rain.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.soilMoisture, date), lat, lng, LAYER_FOLDER_MAP.soilMoisture.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.tide, date), lat, lng, LAYER_FOLDER_MAP.tide.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.label, date), lat, lng, LAYER_FOLDER_MAP.label.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.dem, date), lat, lng, LAYER_FOLDER_MAP.dem.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.slope, date), lat, lng, LAYER_FOLDER_MAP.slope.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.flow, date), lat, lng, LAYER_FOLDER_MAP.flow.scale),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.landCover, date), lat, lng, LAYER_FOLDER_MAP.landCover.scale),
        ]);

        // Derive flood risk from available data
        let floodRisk = 'LOW';
        if (flood !== null && flood > 0.5) floodRisk = 'HIGH';
        else if (rainfall !== null && rainfall > 80) floodRisk = 'HIGH';
        else if (rainfall !== null && rainfall > 40) floodRisk = 'MEDIUM';

        // Check if we got at least one value
        const hasData = [rainfall, soilMoisture, tide, flood, dem, slope, flow, landCover].some(v => v !== null);
        if (!hasData) {
            return fail(res, `No data available for ${region} on ${date}`, 404, 'NOT_FOUND');
        }

        const elapsed = Date.now() - t0;
        console.log(`⚡ /pixel [${lat.toFixed(4)},${lng.toFixed(4)}] ${date} → ${elapsed}ms`);

        res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
        res.setHeader('X-Response-Time', `${elapsed}ms`);
        return ok(res, {
            lat, lng, date, region,
            rainfall,
            soilMoisture,
            tide,
            flood,
            dem,
            slope,
            flow,
            landCover,
            floodRisk,
            bounds,
            metadata: { source: 'geotiff_r2', layers_checked: Object.keys(LAYER_FOLDER_MAP), responseTimeMs: elapsed },
        });
    } catch (err) {
        return fail(res, `Failed to read pixel data: ${err.message}`);
    }
});

// ── GET /api/grid/:region/:date/:layer ─────────────────
// Read full grid data for a given layer
router.get('/grid/:region/:date/:layer', async (req, res) => {
    const t0 = Date.now();
    const { region, date, layer } = req.params;

    if (!isValidRegion(region)) return fail(res, `Invalid region "${region}"`, 400, 'INVALID_REGION');
    const layerInfo = LAYER_FOLDER_MAP[layer];
    if (!layerInfo) return fail(res, `Invalid layer "${layer}"`, 400, 'INVALID_LAYER');
    if (!isValidDate(date) && !layerInfo.isFlat) return fail(res, `Invalid date "${date}"`, 400, 'INVALID_DATE');

    try {
        const key = tifKey(region, layerInfo, date);
        const grid = await readGridFromR2Tif(key, layerInfo.scale);
        if (!grid) return fail(res, `Failed to fetch TIF grid data for layer ${layer}`, 404, 'NOT_FOUND');

        const elapsed = Date.now() - t0;
        console.log(`⚡ /grid ${layer} ${date} → ${elapsed}ms`);
        res.setHeader('Cache-Control', layerInfo.isFlat ? 'public, max-age=86400' : 'public, max-age=3600');
        res.setHeader('X-Response-Time', `${elapsed}ms`);
        return ok(res, grid);
    } catch (err) {
        return fail(res, `Error fetching grid: ${err.message}`);
    }
});

// ── GET /api/available-layers/:region/:date ───────────────────
// Check which TIF files exist in R2 for a given day
router.get('/available-layers/:region/:date', async (req, res) => {
    const { region, date } = req.params;
    if (!isValidRegion(region)) return fail(res, `Invalid region "${region}"`, 400, 'INVALID_REGION');
    if (!isValidDate(date)) return fail(res, `Invalid date "${date}"`, 400, 'INVALID_DATE');

    try {
        // Check TIF existence (authoritative) in parallel
        const checks = await Promise.all(
            Object.entries(LAYER_FOLDER_MAP).map(async ([name, info]) => {
                const exists = await r2Exists(tifKey(region, info, date));
                return [name, exists];
            })
        );
        const availability = Object.fromEntries(checks);
        const hasAnyData = Object.values(availability).some(Boolean);

        return ok(res, { region, date, layers: availability, hasAnyData });
    } catch (err) {
        return fail(res, `Failed to check layers: ${err.message}`);
    }
});

// ── GET /api/debug/paths ──────────────────────────────────────
router.get('/debug/paths', (req, res) => {
    ok(res, {
        R2_ACCOUNT_ID: R2_ACCOUNT_ID ? '*** (set)' : '(NOT SET)',
        R2_BUCKET,
        R2_PUBLIC_URL,
        pixelCacheEntries: _cache.size,
        tifImageCacheEntries: _tifImageCache.size,
        architecture: 'R2-native, 2-tier cache, p-limit concurrency',
    });
});

// ── GET /api/health ───────────────────────────────────────────
router.get('/health', async (req, res) => {
    let r2Status = 'unknown';
    try {
        await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'FloodData/', MaxKeys: 1 }));
        r2Status = 'connected';
    } catch (e) {
        r2Status = `error: ${e.message}`;
    }
    res.setHeader('Cache-Control', 'no-cache');
    ok(res, { status: 'ok', uptime: process.uptime().toFixed(1) + 's', r2: r2Status, pixelCache: _cache.size, tifCache: _tifImageCache.size });
});

// ── LEGACY REDIRECT ───────────────────────────────────────────
router.get('/rainfall/:region/:date', (req, res) => {
    const { region, date } = req.params;
    res.redirect(301, `/api/heatmap/${region}/${date}/rain`);
});

// ── CACHE MANAGEMENT ─────────────────────────────────────────
router.delete('/cache', (req, res) => {
    const pixelSize = _cache.size;
    const tifSize = _tifImageCache.size;
    _cache.clear();
    _tifImageCache.clear();
    return ok(res, { clearedPixelCache: pixelSize, clearedTifCache: tifSize });
});

module.exports = router;
module.exports.readPixelFromR2Tif = readPixelFromR2Tif; // exported for local testing

// ──────────────────────────────────────────────────────────────
// COLD-START ELIMINATION: Preload static layers into TIF cache
// ──────────────────────────────────────────────────────────────
module.exports.preloadStaticLayers = async function preloadStaticLayers() {
    const region = 'DaNang';
    const staticLayers = ['dem', 'slope', 'flow', 'landCover'];

    console.log('🔥 Preloading static layers into TIF cache...');
    const t0 = Date.now();

    const results = await Promise.allSettled(
        staticLayers.map(async (layerName) => {
            const info = LAYER_FOLDER_MAP[layerName];
            const key = tifKey(region, info, '');
            try {
                await getCachedTifImage(key);
                console.log(`  ✅ Preloaded: ${layerName} (${key})`);
                return layerName;
            } catch (err) {
                console.warn(`  ⚠️  Failed to preload ${layerName}: ${err.message}`);
                return null;
            }
        })
    );

    const loaded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const elapsed = Date.now() - t0;
    console.log(`🔥 Preloaded ${loaded}/${staticLayers.length} static layers in ${elapsed}ms`);
    console.log(`📊 TIF cache size: ${_tifImageCache.size} objects`);
};
