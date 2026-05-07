# Browser-sandbox: cloud-hosted Chromium driving the virtual_browser
# embodiment via the computer-use-v1 wire format. Per
# `docs/doctrine/motebit-computer.md` and `spec/computer-use-v1.md`
# §8.1 — sibling to the desktop Tauri bridge, not a Stripe-style
# medium plumb.
#
# The Playwright base image bundles Chromium + every system library
# headless Chromium needs (libnss3, libdrm, libxcb, etc.). Building
# from `node:22-alpine` and apt-installing Chromium is a 30-step
# Dockerfile that's brittle across Chromium upgrades; the official
# Playwright image is the right metabolic absorption.

# --- Build: install deps + compile TypeScript with full pnpm workspace ---
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS build
WORKDIR /app

# pnpm via corepack (Node 22+ ships corepack; Playwright base has Node 20).
# Pin to repo-wide pnpm version (CLAUDE.md: pnpm 9.15).
RUN npm install -g corepack@latest && \
    corepack enable && \
    corepack prepare pnpm@9.15.0 --activate

# Copy lockfile + workspace config first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy workspace packages browser-sandbox depends on (transitive).
COPY packages/ packages/
COPY services/browser-sandbox/ services/browser-sandbox/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/browser-sandbox... build
RUN pnpm --filter @motebit/browser-sandbox deploy --prod /app/deployed

# --- Runtime: Playwright base + the deployed bundle ---
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS runtime
WORKDIR /app

# Drop privileges — Playwright's base image runs as root by default,
# but headless Chromium doesn't require it. The `pwuser` account is
# pre-provisioned in the Playwright image.
USER pwuser

COPY --from=build --chown=pwuser:pwuser /app/deployed ./

ENV NODE_ENV=production
ENV MOTEBIT_PORT=3500
EXPOSE 3500

HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget -qO- http://localhost:3500/health || exit 1

CMD ["node", "dist/index.js"]
