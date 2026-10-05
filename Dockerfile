# BOTH IMAGES FROM ONE BUILD STAGE, so the `shared/*.js` the page loads are the bytes
# the server runs (ADR 0001) by construction rather than by a parity check.
#
#   docker build --target api --build-arg GIT_SHA=<sha> .   the sync server (`/api/*`)
#   docker build --target web .                             the page, behind Caddy
#
# The api image is the one every target runs. The web image is for hosts with no
# CloudFront + S3 in front (the homelab NAS): Caddy serves the page and forwards
# `/api/*` to the `api` service, the split CloudFront does on AWS.

# `node:24`, not slim: web/ installs a dependency straight from GitHub, which needs git.
FROM node:24 AS build
WORKDIR /repo
COPY . .
# `scripts/`' build compiles shared/ (its .js is gitignored build output) and bundles
# the page. The server's runtime deps are installed separately, without dev deps.
RUN npm ci --prefix scripts \
 && npm --prefix scripts run build \
 && npm ci --prefix sync-server --omit=dev \
 && mkdir /site \
 && cp -R web/dist/. /site/ \
 && cp web/AGENTS.md web/llms.txt /site/ \
 && for f in web/*.js; do if [ -L "$f" ]; then cp -L "$f" /site/; fi; done

# The container mirrors the repo layout (/app/sync-server + /app/shared) so the
# `../../shared/...` imports resolve identically in local dev and in the image.
FROM node:24-slim AS api
WORKDIR /app/sync-server
COPY --from=build /repo/sync-server/package.json /repo/sync-server/tsconfig.json ./
COPY --from=build /repo/sync-server/node_modules ./node_modules
COPY --from=build /repo/sync-server/src ./src
COPY --from=build /repo/shared /app/shared
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA PORT=8080
EXPOSE 8080
# tsx directly, not `npm start`: npm wants a writable $HOME for its logs, and on the
# NAS this runs read-only as an unprivileged uid with only /tmp writable.
CMD ["node_modules/.bin/tsx", "src/server.ts"]

FROM caddy:2-alpine AS web
COPY --from=build /site /srv
COPY web/Caddyfile /etc/caddy/Caddyfile
ARG GIT_SHA=""
LABEL org.opencontainers.image.revision=$GIT_SHA
EXPOSE 8080
