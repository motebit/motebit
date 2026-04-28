# --- Base: Node 22-slim (debian) + pnpm (match packageManager in package.json) ---
# Pinned by SHA256 digest. Node 22.22-slim as of 2026-04-15.
# Bump deliberately when upstream node:22-slim moves; do not float.
#
# Why debian-slim and not alpine: better-sqlite3 publishes prebuilt binaries
# only for glibc (debian/ubuntu), not musl (alpine). Under multi-arch builds
# (linux/amd64,linux/arm64), alpine forces a from-source compile of
# better-sqlite3 under arm64 QEMU emulation — measured at >24min and timed out
# at the 30min job budget on 2026-04-27 (run id 24998262611). debian-slim drops
# the prebuilt binary in for both arches, building in a few minutes natively.
# ~30MB image-size cost is irrelevant for a long-lived relay.
FROM node:22-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- Build: install deps, compile TypeScript, flatten with pnpm deploy ---
FROM base AS build
WORKDIR /app

# Install build tools for native deps (kept for any package without a
# prebuilt binary; better-sqlite3 itself uses prebuild-install on glibc).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy lockfile + workspace config first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy all workspace packages (relay depends on 14 transitive workspace deps)
COPY packages/ packages/
COPY services/relay/ services/relay/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/relay... build
RUN pnpm --filter @motebit/relay deploy --prod /app/deployed

# --- Runtime: lean image with only production deps ---
FROM node:22-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c AS runtime
WORKDIR /app

# debian-slim already includes libstdc++; only ca-certificates needed for
# outbound TLS (Stripe webhooks, Solana RPC, federation peers, etc.).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

# Litestream for streaming SQLite replication to S3.
# Optional — only active when LITESTREAM_REPLICA_BUCKET is set.
# TARGETARCH is set automatically by buildx (amd64 | arm64) for cross-arch builds.
ARG TARGETARCH
RUN wget -qO /tmp/litestream.tar.gz \
    "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${TARGETARCH}.tar.gz" \
 && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin \
 && rm /tmp/litestream.tar.gz

COPY --from=build /app/deployed ./
COPY services/relay/litestream.yml /app/litestream.yml
COPY services/relay/run.sh /app/run.sh
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
LABEL org.opencontainers.image.title="motebit-relay" \
      org.opencontainers.image.description="The motebit relay — identity, settlement, federation, discovery, rate limiting, disputes, credential anchoring." \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.url="https://motebit.com" \
      org.opencontainers.image.documentation="https://github.com/motebit/motebit/blob/main/docs/operator/self-host.md" \
      org.opencontainers.image.vendor="Motebit, Inc."

CMD ["/app/run.sh"]
