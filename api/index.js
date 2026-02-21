const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const apiRouter = require('./server/api');

const app = express();
const PORT = process.env.PORT || 8000;

// Update data directory path from Env or default (Fallback to root data folder)
global.kDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data', 'FloodData');

// CORS configuration
app.use(cors());

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

    // Serve Static Frontend HTML/JS
    // Need to resolve path relative to project root since this file is in /api/
    const frontendPath = path.join(__dirname, '../frontend');
    app.use(express.static(frontendPath));

    // Fallback all non-API routes to index.html (SPA logic)
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(frontendPath, 'index.html'));
        }
    });

    app.listen(PORT, () => {
        console.log(`🚀 Vietnam Flood Dashboard running at http://localhost:${PORT}`);
        console.log(`📊 Press Ctrl+C to stop the server`);
    });
} else {
    console.log("⚡ Running in Serverless Mode (Vercel Edge)");
}

// For Vercel Serverless Function (Vercel will import this module)
module.exports = app;
