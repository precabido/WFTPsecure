# API image.
#
# Runs TypeScript directly under Node's native type stripping — no build step,
# so the code that runs is byte-identical to the code that was reviewed. This is
# why apps/ and packages/ contain no TypeScript syntax that emits code
# (parameter properties, enums, decorators).
FROM node:22.12.0-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/config/package.json      packages/config/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/crypto/package.json      packages/crypto/
COPY packages/database/package.json    packages/database/
COPY packages/storage/package.json     packages/storage/
COPY packages/test-utils/package.json  packages/test-utils/
COPY apps/api/package.json             apps/api/
RUN pnpm install --frozen-lockfile --filter @cinderlink/api...

FROM node:22.12.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Non-root, matching the uid/gid pinned in docker-compose.yml.
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY packages ./packages
COPY apps/api ./apps/api
COPY package.json pnpm-workspace.yaml ./
USER app
EXPOSE 4000
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
