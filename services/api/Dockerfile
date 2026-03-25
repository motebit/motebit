# --- Base: Node 22 + pnpm (match packageManager in package.json) ---
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- Build: install deps, compile TypeScript, flatten with pnpm deploy ---
FROM base AS build
WORKDIR /app

# Install build tools for native deps (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy lockfile + workspace config first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy all workspace packages (api depends on 14 transitive workspace deps)
COPY packages/ packages/
COPY services/api/ services/api/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/api... build
RUN pnpm --filter @motebit/api deploy --prod /app/deployed

# --- Runtime: lean image with only production deps ---
FROM node:22-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++

# Litestream for streaming SQLite replication to S3.
# Optional — only active when LITESTREAM_REPLICA_BUCKET is set.
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin && rm /tmp/litestream.tar.gz

COPY --from=build /app/deployed ./
COPY services/api/litestream.yml /app/litestream.yml
COPY services/api/run.sh /app/run.sh
RUN chmod +x /app/run.sh

# Create data directory for SQLite persistent volume
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV MOTEBIT_DB_PATH=/data/motebit.db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["/app/run.sh"]
