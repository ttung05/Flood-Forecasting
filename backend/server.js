const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const apiRouter = require('./server/api');

const app = express();
const PORT = process.env.PORT || 8000;

// Update data directory path from Env or default
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

// Serve static files (Optional: only for local dev if frontend build is copied here)
// app.use(express.static(path.join(__dirname, '../frontend')));

// API routes
app.use('/api', apiRouter);

// Serve the dashboard on root route
// Serve the dashboard message on root route
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>🚀 Vietnam Flood Dashboard API is Running</h1>
            <p>This is the Backend Server.</p>
            <p>Please access the Frontend Web App at: <a href="http://localhost:3000">http://localhost:3000</a></p>
        </div>
    `);
});

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


app.listen(PORT, () => {
    console.log(`🚀 Vietnam Flood Dashboard running at http://localhost:${PORT}`);
    console.log(`📊 Press Ctrl+C to stop the server`);
});
