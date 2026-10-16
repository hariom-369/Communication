# syntax=docker/dockerfile:1.10
# Tessera API image: one image, four entrypoints (docs/deployment.md §3) —
#   dist/server.js (user API), dist/admin-server.js (admin API, ZTNA-only ingress),
#   dist/fetcher-server.js (isolated link-preview fetcher, F-05), dist/cli/migrate.js (pre-deploy Job).
# Build context: repository root (`docker build -f infra/images/api.Dockerfile .`).
# Base images are pinned by version here; Dependabot (docker ecosystem) proposes updates and the
# release pipeline records the resolved digests in the image's provenance attestation.

ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /src
# Manifests first, so dependency layers are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/platform/package.json packages/platform/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter "@tessera/api..."
COPY packages/platform packages/platform
COPY packages/shared packages/shared
COPY packages/validation packages/validation
COPY services/api services/api
RUN pnpm --filter "@tessera/api..." build \
 && pnpm --filter @tessera/api deploy --prod --legacy --config.strict-peer-dependencies=false /out \
 && rm -rf /out/src /out/scripts /out/*.config.ts /out/tsconfig*.json /out/openapi.json \
 && find /out/dist -name '*.test.*' -delete

# Distroless: no shell, no package manager; runs as the unprivileged "nonroot" user (65532).
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=0:0 /out /app
ENV NODE_ENV=production
USER 65532:65532
EXPOSE 8080 9090
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/server.js"]
