FROM node:22-alpine AS base
RUN npm install -g pnpm@9

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/event-log/package.json packages/event-log/
COPY packages/core-identity/package.json packages/core-identity/
COPY packages/persistence/package.json packages/persistence/
COPY packages/crypto/package.json packages/crypto/
COPY packages/policy-invariants/package.json packages/policy-invariants/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ packages/
COPY services/api/ services/api/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/api... build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/
COPY --from=build /app/packages/event-log/dist ./packages/event-log/dist
COPY --from=build /app/packages/event-log/package.json ./packages/event-log/
COPY --from=build /app/packages/core-identity/dist ./packages/core-identity/dist
COPY --from=build /app/packages/core-identity/package.json ./packages/core-identity/
COPY --from=build /app/packages/persistence/dist ./packages/persistence/dist
COPY --from=build /app/packages/persistence/package.json ./packages/persistence/
COPY --from=build /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=build /app/packages/crypto/package.json ./packages/crypto/
COPY --from=build /app/packages/policy-invariants/dist ./packages/policy-invariants/dist
COPY --from=build /app/packages/policy-invariants/package.json ./packages/policy-invariants/
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/package.json ./services/api/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "services/api/dist/index.js"]
