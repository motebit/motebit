# --- Base: Node 22 + pnpm ---
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- Build: install deps, compile TypeScript, flatten with pnpm deploy ---
FROM base AS build
WORKDIR /app

# Install build tools for native deps (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy lockfile + workspace config first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy all workspace packages (web-search depends on transitive workspace deps)
COPY packages/ packages/
COPY services/web-search/ services/web-search/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/web-search... build
RUN pnpm --filter @motebit/web-search deploy --prod /app/deployed

# Ensure identity file exists for COPY (gitignored — contains encrypted keys).
# Real file comes from local build context; CI gets an empty placeholder.
# Production identity is injected via Fly volume mount.
RUN test -f services/web-search/motebit.md || touch services/web-search/motebit.md

# --- Runtime: lean image with only production deps ---
FROM node:22-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++

COPY --from=build /app/deployed ./

# Identity file — not included by pnpm deploy (not a source dep)
COPY --from=build /app/services/web-search/motebit.md ./motebit.md

# Create data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV MOTEBIT_PORT=3200
ENV MOTEBIT_DB_PATH=/data/web-search.db
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3200/health || exit 1

# Seed identity file to volume on first boot (CI builds have a placeholder;
# local builds have the real file). Once on the volume it persists across deploys.
CMD ["sh", "-c", "test -s /data/motebit.md || cp /app/motebit.md /data/motebit.md; node dist/index.js"]
