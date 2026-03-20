# ══════════════════════════════════════════════════
#  Dockerfile — Vietnam Flood Dashboard
#  Node.js Backend (Express API) + Static Frontend
# ══════════════════════════════════════════════════

# ── Stage 1: Build TypeScript ────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (layer cache optimization)
COPY package*.json ./
RUN npm ci

# Build TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Stage 2: Production Image ───────────────────
FROM node:20-slim

WORKDIR /app

# Only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled backend + static frontend
COPY --from=builder /app/dist ./dist
COPY frontend/ ./frontend/

# Copy Vercel serverless entry (also usable for compatibility)
COPY api/ ./api/

# Environment
ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://localhost:8000/api/dates/DaNang', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
