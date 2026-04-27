# --- Base: Node 22 + pnpm (match packageManager in package.json) ---
# Pinned by SHA256 digest. Node 22.22-alpine3.23 as of 2026-04-15.
# Bump deliberately when upstream node:22-alpine moves; do not float.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS base
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
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++ ca-certificates

# Litestream for streaming SQLite replication to S3.
# Optional — only active when LITESTREAM_REPLICA_BUCKET is set.
# TARGETARCH is set automatically by buildx (amd64 | arm64) for cross-arch builds.
ARG TARGETARCH
RUN wget -qO /tmp/litestream.tar.gz \
    "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${TARGETARCH}.tar.gz" \
 && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin \
 && rm /tmp/litestream.tar.gz

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

# OCI image labels — static metadata. Dynamic labels (revision, version,
# created, source) are injected by the publish-images workflow per-build.
LABEL org.opencontainers.image.title="motebit-api" \
      org.opencontainers.image.description="The motebit relay — identity, settlement, federation, discovery, rate limiting, disputes, credential anchoring." \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.url="https://motebit.com" \
      org.opencontainers.image.documentation="https://github.com/motebit/motebit/blob/main/docs/operator/self-host.md" \
      org.opencontainers.image.vendor="Motebit, Inc."

CMD ["/app/run.sh"]
