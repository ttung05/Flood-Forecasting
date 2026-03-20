/**
 * Proxy Controller — Routes that proxy R2 assets (masks, TIFs) and
 * provide heatmap metadata + available-layers info.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { r2GetBuffer, tifKey, warmupTif } from '../../shared/legacy/r2-raster';
import { loadEnv } from '../../shared/config/env';
import { REGION_BOUNDS, LAYER_FOLDER_MAP } from '../../shared/types/common';

export const proxyRouter = Router();

// ── Proxy PNG Mask from Cloudflare R2 (CDN-optimized) ───────────────────────
proxyRouter.get('/mask/:region/:date/label.png', async (req: Request<{region: string; date: string}>, res: Response) => {
    const { region, date } = req.params;
    const r2Key = `FloodData/${region}/Mask/mask_${date}_label.png`;
    try {
        const buf = await r2GetBuffer(r2Key);
        const etag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
        res.setHeader('ETag', etag);
        res.send(buf);
    } catch {
        res.status(404).send('Mask not found');
    }
});

// ── Proxy GeoTIFF directly to Frontend GeoRasterLayer (CDN-optimized) ───────
proxyRouter.get('/tif/:region/:layer/:date', async (req: Request<{region: string; layer: string; date: string}>, res: Response) => {
    const { region, layer, date } = req.params;
    const layerInfo = LAYER_FOLDER_MAP[layer];
    if (!layerInfo) return res.status(400).send('Invalid layer');

    const r2Key = tifKey(region, layerInfo, date);
    try {
        const buf = await r2GetBuffer(r2Key);
        const etag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.setHeader('Content-Type', 'image/tiff');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
        res.setHeader('ETag', etag);
        res.send(buf);
    } catch {
        res.status(404).send('TIF not found');
    }
});

// ── Warmup Stacked COG + NPZ ────────────────────────────────────────────────
proxyRouter.get('/warmup/:region/:date', async (req: Request<{region: string; date: string}>, res: Response) => {
    const { region, date } = req.params;
    const r2KeyStacked = `FloodData/${region}/Stacked/stacked_${date}.tif`;
    const { preloadNpzDates } = await import('../../shared/legacy/npz-reader');
    await Promise.allSettled([
        warmupTif(r2KeyStacked),
        preloadNpzDates([date], 1),
    ]);
    return res.json({ ok: true });
});

// ── Heatmap metadata (bounds + overlay URL for Leaflet imageOverlay) ────────
proxyRouter.get('/heatmap/:region/:date/:layer', async (req: Request<{region: string; date: string; layer: string}>, res: Response) => {
    const { region, date, layer } = req.params;
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: `Unknown region: ${region}` } });

    const validLayers = ['rain', 'soilMoisture', 'tide', 'label', 'flood', 'dem', 'slope', 'flow', 'landCover'];
    if (!validLayers.includes(layer)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: `Invalid layer: ${layer}. Valid: ${validLayers.join(', ')}` } });
    }

    const effectiveLayer = layer === 'flood' ? 'label' : layer;
    const maskUrl = effectiveLayer === 'label'
        ? `/api/mask/${region}/${date}/label.png`
        : `/api/tif/${region}/${effectiveLayer}/${date}`;

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=600');
    return res.json({
        success: true,
        data: {
            layer,
            date,
            region,
            bounds: { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west },
            maskUrl,
        },
    });
});

// ── Available layers check (probes local NPZ data) ──────────────────────────
proxyRouter.get('/available-layers/:region/:date', async (req: Request<{region: string; date: string}>, res: Response) => {
    const { region, date } = req.params;
    const bounds = REGION_BOUNDS[region];
    if (!bounds) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: `Unknown region: ${region}` } });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Date must be YYYY-MM-DD' } });
    }

    const { loadNpzFromLocal } = await import('../../shared/legacy/npz-reader');
    const npz = await loadNpzFromLocal(date);

    const hasNpz = npz !== null;
    const layers = {
        rain: hasNpz && npz.bands >= 1,
        soilMoisture: hasNpz && npz.bands >= 2,
        tide: hasNpz && npz.bands >= 3,
        flood: hasNpz && npz.bands >= 4,
        static: hasNpz && npz.bands >= 5,
    };

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=600');
    return res.json({
        success: true,
        data: {
            region,
            date,
            layers,
            hasAnyData: hasNpz,
        },
    });
});
