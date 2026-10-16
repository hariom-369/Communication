# syntax=docker/dockerfile:1.10
# Tessera realtime gateway image (WebSocket fan-out, docs/realtime.md).
# Build context: repository root (`docker build -f infra/images/realtime.Dockerfile .`).

ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/platform/package.json packages/platform/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
COPY services/realtime/package.json services/realtime/
RUN pnpm install --frozen-lockfile --filter "@tessera/realtime..."
COPY packages/platform packages/platform
COPY packages/shared packages/shared
COPY packages/validation packages/validation
COPY services/realtime services/realtime
RUN pnpm --filter "@tessera/realtime..." build \
 && pnpm --filter @tessera/realtime deploy --prod --legacy --config.strict-peer-dependencies=false /out \
 && rm -rf /out/src /out/*.config.ts /out/tsconfig*.json \
 && find /out/dist -name '*.test.*' -delete

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=0:0 /out /app
ENV NODE_ENV=production
USER 65532:65532
EXPOSE 8081 9091
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/server.js"]
