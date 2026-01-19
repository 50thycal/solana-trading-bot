# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm ci

# Copy source files
COPY . .

# Build TypeScript (if build script exists)
RUN npm run build 2>/dev/null || true

# Runtime stage
FROM node:20-alpine

# Install su-exec for dropping privileges in entrypoint
RUN apk add --no-cache su-exec

# Create non-root user for security
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

WORKDIR /app

# Copy dependencies from builder (includes compiled native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy source files
COPY --from=builder /app/*.ts ./
COPY --from=builder /app/*.json ./
COPY --from=builder /app/cache ./cache
COPY --from=builder /app/filters ./filters
COPY --from=builder /app/helpers ./helpers
COPY --from=builder /app/listeners ./listeners
COPY --from=builder /app/transactions ./transactions
COPY --from=builder /app/risk ./risk
COPY --from=builder /app/persistence ./persistence

# Copy health server
COPY --from=builder /app/health.ts ./

# Copy and setup entrypoint script for Railway volume permission handling
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create data directory with correct permissions for SQLite database
RUN mkdir -p ./data && chown -R botuser:botuser ./data

# Create snipe-list.txt if it doesn't exist
RUN touch ./snipe-list.txt && chown botuser:botuser ./snipe-list.txt

# Set ownership of app directory
RUN chown -R botuser:botuser /app

# Note: USER directive removed - entrypoint handles user switching after fixing volume permissions

# Health check - checks the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose health check port
EXPOSE 8080

# Set default environment variables
ENV NODE_ENV=production
ENV HEALTH_PORT=8080
ENV DATA_DIR=./data

# Entrypoint handles permission fixing and user switching
ENTRYPOINT ["docker-entrypoint.sh"]

# Run the bot using ts-node with transpile-only for faster startup
CMD ["npx", "ts-node", "--transpile-only", "index.ts"]
