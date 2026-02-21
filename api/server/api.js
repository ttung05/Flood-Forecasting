/**
 * api.js – Flood Forecasting Backend API
 *
 * Architecture:
 *   - Data SOURCE:     GeoTIFF files in Cloudflare R2 (original .tif)
 *   - Heatmap overlay: Pre-rendered PNG masks in R2 (processed-masks/)
 *   - Pixel lookup:    Download TIF on-demand and read pixel via geotiff
 *   - Cache:           In-process LRU (R2 listing + pixel results)
 *
 * R2 Folder structure (TIF source):
 *   FloodData/{region}/Daily/Rain/Rain_YYYY_MM_DD.tif
 *   FloodData/{region}/LabelDaily/Flood/Flood_YYYY_MM_DD.tif
 *   FloodData/{region}/Static/DEM/DEM.tif
 *
 * R2 Folder structure (PNG output from process_and_upload.py):
 *   processed-masks/{region}/Daily/Rain/Rain_YYYY_MM_DD.png
 *   processed-masks/{region}/LabelDaily/Flood/Flood_YYYY_MM_DD.png
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
const VALID_REGIONS = ['DBSCL', 'CentralCoast'];
const VALID_LAYERS = ['rain', 'soilMoisture', 'tide', 'flood'];

// Layer folder mapping: API name → R2 folder path segment
const LAYER_FOLDER_MAP = {
    rain: { sub: 'Daily', folder: 'Rain', prefix: 'Rain' },
    soilMoisture: { sub: 'Daily', folder: 'SoilMoisture', prefix: 'SoilMoisture' },
    tide: { sub: 'Daily', folder: 'Tide', prefix: 'Tide' },
    flood: { sub: 'LabelDaily', folder: 'Flood', prefix: 'Flood' },
};

// GeoTIFF bounds per region (must match actual TIF data)
const REGION_BOUNDS = {
    DBSCL: {
        north: 11.0, south: 8.5,
        east: 107.0, west: 104.0,
        rows: 25, cols: 30
    },
    CentralCoast: {
        north: 16.5, south: 14.5,
        east: 109.5, west: 107.5,
        rows: 20, cols: 20
    },
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
// IN-PROCESS LRU CACHE
// ──────────────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_MAX = 100;
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

/**
 * Build the R2 key for a TIF file.
 * Pattern: FloodData/{region}/{sub}/{folder}/{prefix}_YYYY_MM_DD.tif
 */
function tifKey(region, layerInfo, date) {
    const [y, m, d] = date.split('-');
    return `FloodData/${region}/${layerInfo.sub}/${layerInfo.folder}/${layerInfo.prefix}_${y}_${m}_${d}.tif`;
}

/**
 * Build the R2 key for a PNG mask file.
 * Pattern: processed-masks/{region}/{sub}/{folder}/{prefix}_YYYY_MM_DD.png
 */
function pngKey(region, layerInfo, date) {
    const [y, m, d] = date.split('-');
    return `processed-masks/${region}/${layerInfo.sub}/${layerInfo.folder}/${layerInfo.prefix}_${y}_${m}_${d}.png`;
}

/**
 * Build the public URL for a PNG mask.
 */
function maskPublicUrl(region, layerInfo, date) {
    return `${R2_PUBLIC_URL}/${pngKey(region, layerInfo, date)}`;
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
    const RE = /(\d{4})_(\d{2})_(\d{2})\.tif$/i;

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
 * Read one pixel value from an R2-hosted GeoTIFF at (lat, lng).
 * Downloads the TIF to memory, then uses geotiff to read the pixel.
 * Returns { value, bounds: {north,south,east,west} } or null.
 */
async function readPixelFromR2Tif(r2Key, lat, lng) {
    const cacheKey = `pixel_${r2Key}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    try {
        const buf = await r2GetBuffer(r2Key);
        const GT = await getGeoTIFF();
        const tiff = await GT.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const img = await tiff.getImage();

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
            : parseFloat(rawValue.toFixed(4));

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
        const [dbsclResult, ccResult] = await Promise.allSettled([
            loadDateIndex('DBSCL'),
            loadDateIndex('CentralCoast'),
        ]);

        const dbscl = dbsclResult.status === 'fulfilled' ? dbsclResult.value : null;
        const cc = ccResult.status === 'fulfilled' ? ccResult.value : null;

        const allDates = new Set();
        function addDates(index) {
            if (!index?.available_dates) return;
            Object.entries(index.available_dates).forEach(([year, months]) => {
                Object.entries(months).forEach(([month, days]) => {
                    days.forEach(day => allDates.add(`${year}-${month}-${String(day).padStart(2, '0')}`));
                });
            });
        }
        addDates(dbscl);
        addDates(cc);

        const dates = Array.from(allDates).sort();

        return ok(res, {
            dates,
            dateRange: { start: dates[0] || '2000-01-01', end: dates[dates.length - 1] || '' },
            totalDays: dates.length,
            regions: { DBSCL: !!dbscl, CentralCoast: !!cc },
        });
    } catch (err) {
        return fail(res, `Failed to load timeline: ${err.message}`);
    }
});

// ── GET /api/heatmap/:region/:date/:layer ─────────────────────
// Returns PNG public URL + bounds (no computation needed)
router.get('/heatmap/:region/:date/:layer', (req, res) => {
    const { region, date, layer } = req.params;

    if (!isValidRegion(region)) return fail(res, `Invalid region "${region}"`, 400, 'INVALID_REGION');
    if (!isValidDate(date)) return fail(res, `Invalid date "${date}"`, 400, 'INVALID_DATE');

    const layerInfo = LAYER_FOLDER_MAP[layer];
    if (!layerInfo) return fail(res, `Invalid layer "${layer}". Valid: ${Object.keys(LAYER_FOLDER_MAP).join(', ')}`, 400, 'INVALID_LAYER');

    const maskUrl = maskPublicUrl(region, layerInfo, date);

    return ok(res, {
        layer,
        date,
        region,
        bounds: REGION_BOUNDS[region],
        maskUrl,
    });
});

// ── GET /api/pixel/:lat/:lng/:date/:region ────────────────────
// Read pixel value from GeoTIFF in R2 for all layers
router.get('/pixel/:lat/:lng/:date/:region', async (req, res) => {
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
        // Read all daily layers in parallel
        const [rainfall, soilMoisture, tide, flood] = await Promise.all([
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.rain, date), lat, lng),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.soilMoisture, date), lat, lng),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.tide, date), lat, lng),
            readPixelFromR2Tif(tifKey(region, LAYER_FOLDER_MAP.flood, date), lat, lng),
        ]);

        // Derive flood risk from available data
        let floodRisk = 'LOW';
        if (flood !== null && flood > 0.5) floodRisk = 'HIGH';
        else if (rainfall !== null && rainfall > 80) floodRisk = 'HIGH';
        else if (rainfall !== null && rainfall > 40) floodRisk = 'MEDIUM';

        // Check if we got at least one value
        const hasData = [rainfall, soilMoisture, tide, flood].some(v => v !== null);
        if (!hasData) {
            return fail(res, `No data available for ${region} on ${date}`, 404, 'NOT_FOUND');
        }

        return ok(res, {
            lat, lng, date, region,
            rainfall,
            soilMoisture,
            tide,
            flood,
            floodRisk,
            bounds,
            metadata: { source: 'geotiff_r2', layers_checked: Object.keys(LAYER_FOLDER_MAP) },
        });
    } catch (err) {
        return fail(res, `Failed to read pixel data: ${err.message}`);
    }
});

// ── GET /api/available-layers/:region/:date ───────────────────
// Check which PNG masks already exist in R2 for a given day
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
        cacheEntries: _cache.size,
        architecture: 'R2-native (no Postgres)',
    });
});

// ── GET /api/health ───────────────────────────────────────────
router.get('/health', async (req, res) => {
    let r2Status = 'unknown';
    try {
        await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'processed-masks/', MaxKeys: 1 }));
        r2Status = 'connected';
    } catch (e) {
        r2Status = `error: ${e.message}`;
    }
    ok(res, { status: 'ok', uptime: process.uptime().toFixed(1) + 's', r2: r2Status, cacheSize: _cache.size });
});

// ── LEGACY REDIRECT ───────────────────────────────────────────
router.get('/rainfall/:region/:date', (req, res) => {
    const { region, date } = req.params;
    res.redirect(301, `/api/heatmap/${region}/${date}/rain`);
});

// ── CACHE MANAGEMENT ─────────────────────────────────────────
router.delete('/cache', (req, res) => {
    const size = _cache.size;
    _cache.clear();
    return ok(res, { cleared: size });
});

module.exports = router;
