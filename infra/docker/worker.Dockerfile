# Cleanup worker image. Same runtime approach as the API.
FROM node:22.12.0-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/config/package.json     packages/config/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/crypto/package.json     packages/crypto/
COPY packages/database/package.json   packages/database/
COPY packages/storage/package.json    packages/storage/
COPY packages/test-utils/package.json packages/test-utils/
COPY apps/worker/package.json         apps/worker/
RUN pnpm install --frozen-lockfile --filter @cinderlink/worker...

FROM node:22.12.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY package.json pnpm-workspace.yaml ./
USER app
CMD ["node", "--experimental-strip-types", "apps/worker/src/main.ts"]
