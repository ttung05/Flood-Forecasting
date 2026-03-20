/**
 * Express Application Setup
 * 
 * Clean entry point: middleware → routers → error handling → static files.
 * All route logic lives in dedicated controllers under src/modules/.
 */
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { loadEnv } from './shared/config/env';
import { structuredLog } from './shared/middleware/tracing';

// ── Module Routers ──────────────────────────────────────────────────────────
import { pixelRouter } from './modules/pixel/pixel.controller';
import { metadataRouter } from './modules/metadata/metadata.controller';
import { gridRouter } from './modules/grid/grid.controller';
import { floodRiskRouter } from './modules/grid/flood-risk.controller';
import { gridBatchRouter } from './modules/grid/grid-batch.controller';
import { forecastRouter } from './modules/forecast/forecast.controller';
import { inferenceRouter } from './modules/inference/inference.controller';
import { proxyRouter } from './modules/proxy/proxy.controller';
import { debugRouter } from './modules/debug/debug.controller';

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        const type = res.getHeader('Content-Type') || '';
        if (typeof type === 'string' && type.includes('octet-stream')) return true;
        return compression.filter(req, res);
    }
}));
app.use(express.json());

// Request logging
app.use('/api', (req, res, next) => {
    structuredLog('info', 'api_request', { method: req.method, path: req.path });
    next();
});

// ── Mount Routers ───────────────────────────────────────────────────────────
app.use('/api', proxyRouter);
app.use('/api', metadataRouter);
app.use('/api', pixelRouter);
app.use('/api', gridRouter);
app.use('/api', gridBatchRouter);
app.use('/api/v1', floodRiskRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/inference', inferenceRouter);

// Debug endpoints — only in development
const env = loadEnv();
if (env.NODE_ENV !== 'production') {
    app.use('/api/debug', debugRouter);
    structuredLog('info', 'debug_routes', { status: 'mounted', warning: 'Disable in production' });
}

// ── Error Handling ──────────────────────────────────────────────────────────
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    structuredLog('error', 'unhandled_error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err.message }
    });
});

// 404 Handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Endpoint not found: ${req.path}` }
    });
});

// ── Serve Frontend (local / Render / Docker) ────────────────────────────────
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
