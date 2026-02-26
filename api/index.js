const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression'); // 🚀 WPO: Add HTTP Compression
require('dotenv').config(); // Load from root
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') }); // Load from backend
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') }); // Load from backend (failsafe)

const apiRouter = require('./server/api');

const app = express();
const PORT = process.env.PORT || 8000;

// Update data directory path from Env or default (Fallback to root data folder)
global.kDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data', 'FloodData');

// CORS configuration & Compression
app.use(cors());
app.use(compression()); // 🚀 Enable Gzip/Brotli for all responses (HTML, JS, CSS, JSON)

// Request logging (chỉ log API requests)
app.use('/api', (req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Serve the generated image masks statically so the frontend Leaflet map can mount them
app.use('/masks', express.static(path.join(__dirname, 'public', 'masks')));

// API routes - Mount at /api so both Vercel and Render handle logic correctly
app.use('/api', apiRouter);

// Global error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: {
            code: 500,
            message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
        }
    });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 404, message: `Endpoint not found: ${req.path}` }
    });
});

// =========================================================================
// UNIVERSAL DEPLOYMENT LOGIC (RENDER & VERCEL SUPPORT)
// =========================================================================

// If not on Vercel Edge (Render/Local Env), serve static frontend & start listening port
if (process.env.NODE_ENV !== 'production' || process.env.RENDER) {
    console.log("🛠️ Running in Local / Render mode (Long-running Process)");

    // Serve Static Frontend HTML/JS with Cache-Control 🚀
    // Need to resolve path relative to project root since this file is in /api/
    const frontendPath = path.join(__dirname, '../frontend');
    app.use(express.static(frontendPath, {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
                // No cache for JS/CSS during development to avoid stale code
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            } else if (filePath.endsWith('.json') || filePath.endsWith('.png')) {
                res.setHeader('Cache-Control', 'public, max-age=3600');
            }
        }
    }));

    // Fallback all non-API routes to index.html (SPA logic)
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(frontendPath, 'index.html'));
        }
    });

    app.listen(PORT, async () => {
        console.log(`🚀 Vietnam Flood Dashboard running at http://localhost:${PORT}`);
        console.log(`📊 Press Ctrl+C to stop the server`);

        // Cold-start elimination: preload static layers into TIF cache
        if (apiRouter.preloadStaticLayers) {
            apiRouter.preloadStaticLayers().catch(err => {
                console.warn('⚠️  Preload failed:', err.message);
            });
        }
    });
} else {
    console.log("⚡ Running in Serverless Mode (Vercel Edge)");
}

// For Vercel Serverless Function (Vercel will import this module)
module.exports = app;
