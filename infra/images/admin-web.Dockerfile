# syntax=docker/dockerfile:1.10
# Tessera admin console: the production build of apps/admin served by nginx with the headers the
# build wrote, behind the identity-aware proxy (docs/admin.md §1).
# Build `apps/admin` first; then, from the repository root: docker build -f infra/images/admin-web.Dockerfile .

ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS config
WORKDIR /src
COPY infra/images/nginx/render.mjs ./
COPY apps/admin/dist/security-headers.json ./
RUN node render.mjs --app=admin --headers=security-headers.json > nginx.conf

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY --from=config /src/nginx.conf /etc/nginx/nginx.conf
COPY apps/admin/dist /usr/share/nginx/html
USER 65532:65532
EXPOSE 8080 8081
# nginx directly: the image's entrypoint scripts rewrite files, which a read-only root forbids.
ENTRYPOINT ["nginx", "-e", "stderr", "-g", "daemon off;"]
