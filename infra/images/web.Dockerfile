# syntax=docker/dockerfile:1.10
# Tessera web app: the signed production build of apps/web served by nginx with the headers the
# build wrote, plus LiveKit signalling proxied under /sfu (docs/deployment.md §2).
# Build `apps/web` first (`pnpm build` with the release signing key, as the release workflow does);
# then, per environment, from the repository root:
#   docker build -f infra/images/web.Dockerfile --build-arg MEDIA_ORIGIN=https://<media bucket host> .
# The build is the same for every environment; only the CSP's connect-src names its media origin.

ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS config
WORKDIR /src
COPY infra/images/nginx/render.mjs ./
COPY apps/web/dist/security-headers.json ./
ARG SFU_UPSTREAM=livekit.tessera-media.svc.cluster.local:7880
ARG MEDIA_ORIGIN
RUN test -n "${MEDIA_ORIGIN}" && node render.mjs --app=web --headers=security-headers.json \
      --sfu-upstream="${SFU_UPSTREAM}" --media-origin="${MEDIA_ORIGIN}" > nginx.conf

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY --from=config /src/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/dist /usr/share/nginx/html
USER 65532:65532
EXPOSE 8080 8081
# nginx directly: the image's entrypoint scripts rewrite files, which a read-only root forbids.
ENTRYPOINT ["nginx", "-e", "stderr", "-g", "daemon off;"]
