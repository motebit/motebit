# --- Base: Node 22 + pnpm (Debian for glibc — onnxruntime-node requires it) ---
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- Build: install deps, compile TypeScript ---
FROM base AS build
WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY services/embed/ services/embed/

RUN pnpm install --frozen-lockfile --filter @motebit/embed...
RUN pnpm --filter @motebit/embed build
RUN pnpm --filter @motebit/embed deploy --prod /app/deployed

# --- Runtime: lean glibc image ---
FROM node:22-slim AS runtime
WORKDIR /app

COPY --from=build /app/deployed ./

ENV NODE_ENV=production
ENV MOTEBIT_PORT=3200
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=3s CMD curl -sf http://localhost:3200/health || exit 1

CMD ["node", "dist/index.js"]
