FROM node:22-alpine AS base
RUN npm install -g pnpm@9

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ packages/
COPY services/api/ services/api/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @motebit/api... build
RUN pnpm --filter @motebit/api deploy --prod /app/deployed

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/deployed ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
