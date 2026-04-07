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

# Copy all workspace packages (summarize depends on transitive workspace deps)
COPY packages/ packages/
COPY services/summarize/ services/summarize/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/summarize... build
RUN pnpm --filter @motebit/summarize deploy --prod /app/deployed

# --- Runtime: lean image with only production deps ---
FROM node:22-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++

COPY --from=build /app/deployed ./

# Create the persistent data directory. On Fly, /data is the volume
# mount point from fly.toml; here we just ensure it exists for local
# docker runs. The motebit identity (motebit.json / motebit.key /
# motebit.md) is generated on first boot via bootstrapServiceIdentity()
# — no identity file baked into the image.
RUN mkdir -p /data

ENV NODE_ENV=production
ENV MOTEBIT_PORT=3201
ENV MOTEBIT_DB_PATH=/data/summarize.db
ENV MOTEBIT_DATA_DIR=/data
EXPOSE 3201

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3201/health || exit 1

CMD ["node", "dist/index.js"]
