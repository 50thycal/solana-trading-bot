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

# Build TypeScript to JavaScript for faster startup
RUN npm run build

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

# Copy compiled JavaScript from dist folder
COPY --from=builder /app/dist ./dist

# Copy package.json for version info (already in dist from tsc)
# COPY --from=builder /app/package.json ./

# Copy dashboard public files to the correct location relative to compiled code
# The compiled dashboard/server.js looks for public files in __dirname/public
COPY --from=builder /app/dashboard/public ./dist/dashboard/public

# Create snipe-list.txt in dist folder (snipe-list.cache.js looks for ../snipe-list.txt from dist/cache/)
RUN touch ./dist/snipe-list.txt

# Copy and setup entrypoint script for Railway volume permission handling
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create data directory with correct permissions for SQLite database
RUN mkdir -p ./data && chown -R botuser:botuser ./data

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
ENV DASHBOARD_ENABLED=true
ENV DASHBOARD_PORT=8080

# Entrypoint handles permission fixing and user switching
ENTRYPOINT ["docker-entrypoint.sh"]

# Run the pre-compiled JavaScript for instant startup
# Using bootstrap.js to ensure health server starts before config validation
CMD ["node", "dist/bootstrap.js"]
