/**
 * Application Entry Point
 * 100% TypeScript, No api/ directory legacy
 */
import 'dotenv/config';
import app from './app';
import { loadEnv } from './shared/config/env';
import { structuredLog } from './shared/middleware/tracing';
import { TifWorkerPool } from './shared/worker/pool';

// Inject Dependencies for Legacy Fallback & TS Services
import { injectDeps as injectPixelDeps } from './modules/pixel/pixel.service';
import { injectDeps as injectMetadataDeps } from './modules/metadata/metadata.service';
import { injectDeps as injectGridDeps } from './modules/grid/grid.service';
import * as legacyR2 from './shared/legacy/r2-raster';

const env = loadEnv();

structuredLog('info', 'ts_bootstrap', {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    useWorkerPool: env.USE_WORKER_POOL,
    usePrebuiltGrid: env.USE_PREBUILT_GRID,
});

// ── Dependency Injection (Ngắt kết nối api.js cũ) ─────────────────────────
injectPixelDeps({
    getCachedTifImage: legacyR2.getCachedTifImage,
    readPixelFromR2Tif: legacyR2.readPixelFromR2Tif,
    tifKey: legacyR2.tifKey as any
});

injectMetadataDeps({
    loadDateIndex: legacyR2.loadDateIndex,
    r2GetJson: legacyR2.r2GetJson
});

injectGridDeps({
    r2GetJson: legacyR2.r2GetJson,
    legacyGridHandler: async () => null // Bỏ qua legacy vì đã pre-build
});

// ── Worker Pool (Tối ưu giải nén TIFF) ──────────────────────────────────────
let workerPool: TifWorkerPool | null = null;
if (env.USE_WORKER_POOL) {
    workerPool = new TifWorkerPool({
        maxWorkers: env.WORKER_POOL_SIZE,
        maxQueueSize: 50,
        taskTimeoutMs: 5000,
    });
    structuredLog('info', 'worker_pool', { status: 'ready', size: env.WORKER_POOL_SIZE });
}
export function getWorkerPool() { return workerPool; }


// ── Start Express Server ───────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
    console.log(`🚀 Vietnam Flood Dashboard running at http://localhost:${env.PORT}`);
    console.log(`📊 Press Ctrl+C to stop the server`);
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
    structuredLog('info', 'shutdown', { reason: signal });
    server.close();
    if (workerPool) await workerPool.shutdown();
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
