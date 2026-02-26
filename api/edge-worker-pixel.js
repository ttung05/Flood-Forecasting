/**
 * edge-worker-pixel.js — Cloudflare Worker for Edge Pixel API
 *
 * ARCHITECTURE:
 *   User → Cloudflare Edge Worker → R2 (COG multiband) → Worker returns pixel
 *
 * This Worker runs at the edge closest to the user.
 * It reads multiband COG files using HTTP Range Requests via geotiff.js,
 * fetching only the tile (~2KB) containing the target pixel.
 *
 * DEPLOYMENT:
 *   1. Install wrangler: npm i -g wrangler
 *   2. Configure wrangler.toml (see below)
 *   3. Deploy: wrangler deploy
 *
 * wrangler.toml example:
 *   name = "flood-pixel-api"
 *   main = "api/edge-worker-pixel.js"
 *   compatibility_date = "2025-01-01"
 *   
 *   [[r2_buckets]]
 *   binding = "R2_BUCKET"
 *   bucket_name = "satellite-data-10x10"
 *
 * BAND ORDER (must match merge_multiband.py):
 *   Band 1: Rain            (scale 1000)
 *   Band 2: SoilMoisture    (scale 1000)
 *   Band 3: Tide            (scale 1000)
 *   Band 4: Flood           (scale 1000)
 *   Band 5: DEM             (scale 1)
 *   Band 6: Slope           (scale 1)
 *   Band 7: Flow            (scale 1)
 *   Band 8: LandCover       (scale 1)
 */

// NOTE: In Cloudflare Workers, import geotiff as ESM
// import * as GeoTIFF from 'geotiff';

const BAND_NAMES = ['rainfall', 'soilMoisture', 'tide', 'flood', 'dem', 'slope', 'flow', 'landCover'];
const BAND_SCALES = [1000, 1000, 1000, 1000, 1, 1, 1, 1];
const REGION = 'DaNang';

// In-Worker memory cache for parsed TIF objects
const tiffCache = new Map();
const MAX_CACHE_SIZE = 20;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // Route: /pixel/:lat/:lng/:date
        const match = url.pathname.match(/^\/pixel\/([\d.-]+)\/([\d.-]+)\/([\d-]+)$/);
        if (!match) {
            return jsonResponse({ error: 'Invalid route. Use /pixel/:lat/:lng/:date' }, 400);
        }

        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        const date = match[3];
        const t0 = Date.now();

        try {
            // Construct R2 key for stacked multiband COG
            const r2Key = `FloodData/${REGION}/Stacked/stacked_${date}.tif`;

            // Get or cache the parsed TIF image
            let image = tiffCache.get(r2Key);
            if (!image) {
                // Option A: Using R2 binding (internal network, zero latency)
                const obj = await env.R2_BUCKET.get(r2Key);
                if (!obj) {
                    return jsonResponse({ error: `No data for date ${date}` }, 404);
                }

                const buf = await obj.arrayBuffer();
                const GeoTIFF = await import('geotiff');
                const tiff = await GeoTIFF.fromArrayBuffer(buf);
                image = await tiff.getImage();

                // Evict oldest if cache full
                if (tiffCache.size >= MAX_CACHE_SIZE) {
                    tiffCache.delete(tiffCache.keys().next().value);
                }
                tiffCache.set(r2Key, image);
            }

            // Compute pixel coordinates
            const [west, south, east, north] = image.getBoundingBox();
            const width = image.getWidth();
            const height = image.getHeight();

            const col = Math.floor(((lng - west) / (east - west)) * width);
            const row = Math.floor(((north - lat) / (north - south)) * height);

            if (col < 0 || col >= width || row < 0 || row >= height) {
                return jsonResponse({ error: 'Coordinates out of bounds' }, 404);
            }

            // Read all 8 bands at once for the 1×1 pixel window
            // With COG, this only fetches the tile containing this pixel (~2KB)
            const rasterData = await image.readRasters({
                window: [col, row, col + 1, row + 1]
            });

            // Build result object with scaled values
            const nodata = image.fileDirectory.GDAL_NODATA;
            const nod = nodata !== undefined ? parseFloat(nodata) : -9999;

            const result = {};
            for (let i = 0; i < BAND_NAMES.length; i++) {
                const raw = rasterData[i] ? rasterData[i][0] : null;
                if (raw === null || raw === nod || isNaN(raw) || raw <= -9998) {
                    result[BAND_NAMES[i]] = null;
                } else {
                    result[BAND_NAMES[i]] = parseFloat((raw / BAND_SCALES[i]).toFixed(4));
                }
            }

            // Derive flood risk
            result.floodRisk = 'LOW';
            if (result.flood !== null && result.flood > 0.5) result.floodRisk = 'HIGH';
            else if (result.rainfall !== null && result.rainfall > 80) result.floodRisk = 'HIGH';
            else if (result.rainfall !== null && result.rainfall > 40) result.floodRisk = 'MEDIUM';

            const elapsed = Date.now() - t0;

            return jsonResponse({
                success: true,
                data: {
                    lat, lng, date, region: REGION,
                    ...result,
                    metadata: { source: 'edge-worker-cog', responseTimeMs: elapsed }
                }
            }, 200, {
                'Cache-Control': 'public, max-age=3600, stale-while-revalidate=600',
                'X-Response-Time': `${elapsed}ms`,
            });

        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    }
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        }
    });
}
