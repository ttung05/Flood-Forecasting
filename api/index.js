/**
 * Vercel Serverless Function Entry Point
 * 
 * Wraps the compiled Express app for Vercel's serverless runtime.
 * Vercel rewrites /api/* requests to this file (see vercel.json).
 * 
 * IMPORTANT: Run `npm run build` before deploying to compile TypeScript → dist/
 */
const app = require('../dist/app').default;

module.exports = app;
