# Web image.
#
# Next.js `output: 'standalone'` emits a self-contained server with only the
# modules it actually imports, so the runtime layer carries no build toolchain
# and no source it does not need.
FROM node:22.12.0-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @cinderlink/web...
# Build-time values are baked into the client bundle; they contain no secrets.
ARG BUILD_ID=unknown
ARG COMMIT_SHA=unknown
ENV BUILD_ID=$BUILD_ID COMMIT_SHA=$COMMIT_SHA NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @cinderlink/web build

FROM node:22.12.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=builder --chown=10001:10001 /app/apps/web/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=10001:10001 /app/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
