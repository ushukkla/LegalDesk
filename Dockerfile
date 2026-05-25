# ═══════════════════════════════════════════════════════════════════════
#  LegalDesk API Server — Docker Image
#  Multi-stage build for minimal production image
# ═══════════════════════════════════════════════════════════════════════

FROM node:20-slim AS base

# Install system dependencies for sharp (image processing) and Tesseract
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Stage 1: Install dependencies ────────────────────────────────────
FROM base AS deps

# Copy both package.json files
COPY api-server/package.json api-server/package-lock.json* ./api-server/
COPY allahabad-hc-mcp/package.json allahabad-hc-mcp/package-lock.json* ./allahabad-hc-mcp/

# Install API server dependencies
WORKDIR /app/api-server
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Install captcha-solver dependencies (sharp + tesseract.js)
WORKDIR /app/allahabad-hc-mcp
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Stage 2: Production image ────────────────────────────────────────
FROM node:20-slim AS production

# Tesseract.js downloads its own WASM worker, no system tesseract needed
WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/api-server/node_modules ./api-server/node_modules
COPY --from=deps /app/allahabad-hc-mcp/node_modules ./allahabad-hc-mcp/node_modules

# Copy source code
COPY api-server/package.json ./api-server/
COPY api-server/index.js ./api-server/
COPY allahabad-hc-mcp/captcha-solver.js ./allahabad-hc-mcp/
COPY allahabad-hc-mcp/package.json ./allahabad-hc-mcp/

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3001
ENV TZ=Asia/Kolkata

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:${PORT}/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

WORKDIR /app/api-server

EXPOSE 3001

CMD ["node", "index.js"]
