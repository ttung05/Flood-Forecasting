import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';

import { pixelRouter } from './modules/pixel/pixel.controller';
import { metadataRouter } from './modules/metadata/metadata.controller';
import { gridRouter } from './modules/grid/grid.controller';
import { structuredLog } from './shared/middleware/tracing';

const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

// Request logging
app.use('/api', (req, res, next) => {
    structuredLog('info', 'api_request', { method: req.method, path: req.path });
    next();
});

// Proxy PNG Mask from Cloudflare R2
import { r2GetBuffer } from './shared/legacy/r2-raster';
app.get('/api/mask/:region/:date/label.png', async (req, res) => {
    const { region, date } = req.params;
    const r2Key = `FloodData/${region}/Mask/mask_${date}_label.png`;
    try {
        const buf = await r2GetBuffer(r2Key);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch {
        res.status(404).send('Mask not found');
    }
});

// Mount TS Routers
app.use('/api', metadataRouter);
app.use('/api', pixelRouter);
app.use('/api', gridRouter);

// Global Error Handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    structuredLog('error', 'unhandled_error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err.message }
    });
});

// 404 Handler
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Endpoint not found: ${req.path}` }
    });
});

// Serve frontend in local/render mode
const frontendPath = path.join(process.cwd(), 'frontend');
app.use(express.static(frontendPath, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    }
}));

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(frontendPath, 'index.html'));
    }
});

export default app;
