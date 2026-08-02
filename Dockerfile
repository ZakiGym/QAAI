# QAAI — one image, every service.
#
# Build once, run as `api`, `worker`, `web`, `demo`, `migrate` or `seed` by
# passing the name as the command. The four per-app Dockerfiles this replaces
# (apps/{api,worker,web,demo}/Dockerfile) were near-identical and had already
# drifted: each copied a slightly different subset of the workspace manifests,
# and none of them copied packages/cli or apps/desktop.
#
# ── Why TypeScript is executed directly, not compiled ────────────────────────
# apps/{api,worker,demo}/tsconfig.json all set "noEmit": true, so `npm run build`
# emits nothing and the `"start": "node dist/index.js"` script in each manifest
# points at a dist/ that is never produced. Until those tsconfigs emit, the only
# runnable form of this code is the source, executed through tsx. That is why
# tsx is installed into the final layer even though npm classifies it as a
# devDependency — for this repo it is a production runtime requirement.
#
# ── Why there are two final targets ──────────────────────────────────────────
# See the `runtime-browsers` stage at the bottom.

# ─────────────────────────────────────────────────────────────────────────────
# base — shared OS layer.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
WORKDIR /app

# openssl: Prisma links against it. tini: real PID 1, so SIGTERM reaches the
# process and the worker's browser children get reaped instead of becoming
# zombies that hold the container open.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# ─────────────────────────────────────────────────────────────────────────────
# manifests — just the package.json files, so `npm ci` caches independently of
# source edits. Every workspace npm resolves from the lockfile must be listed.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS manifests

COPY package.json package-lock.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/storage/package.json  packages/storage/
COPY packages/runner/package.json   packages/runner/
COPY packages/agent/package.json    packages/agent/
COPY packages/cli/package.json      packages/cli/
COPY apps/api/package.json          apps/api/
COPY apps/worker/package.json       apps/worker/
COPY apps/web/package.json          apps/web/
COPY apps/demo/package.json         apps/demo/

# apps/desktop is deliberately NOT copied (and is excluded in .dockerignore).
# It is an Electron shell that no server-side service imports, and including its
# manifest pulls electron 43 — a ~200MB devDependency — into the build cache for
# no benefit. npm tolerates a workspace whose directory is absent: the `apps/*`
# glob simply does not match it, and `npm ci` still installs cleanly.

# ─────────────────────────────────────────────────────────────────────────────
# deps-full — every dependency, including dev. Needed only to build the cockpit
# (tailwind/postcss/@types are devDependencies of @qaai/web).
# ─────────────────────────────────────────────────────────────────────────────
FROM manifests AS deps-full
# --ignore-scripts: the root package.json has a postinstall that runs
# `prisma generate`, which needs the schema — not yet copied at this point.
# Generation happens explicitly in the build stage instead.
RUN npm ci --ignore-scripts --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────────────
# deps-prod — production dependencies only. This is what ships.
# ─────────────────────────────────────────────────────────────────────────────
FROM manifests AS deps-prod
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────────────
# build — generate the Prisma client and compile the cockpit.
# ─────────────────────────────────────────────────────────────────────────────
FROM deps-full AS build

COPY . .

# The generator emits plain TypeScript (provider = "prisma-client", driver
# adapters, no Rust query engine), so the output is platform-independent and
# safe to copy into the runtime stage rather than regenerating there. Run from
# apps/api because prisma.config.ts — which carries the datasource URL — is
# resolved relative to the working directory, not to --schema.
WORKDIR /app/apps/api
RUN npx prisma generate
WORKDIR /app

# Next inlines NEXT_PUBLIC_API_URL at build time, so this must be the URL the
# *browser* will use, not the compose-network hostname. Override per deployment:
#   docker compose build --build-arg NEXT_PUBLIC_API_URL=https://qaai.example.com
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @qaai/web

# ─────────────────────────────────────────────────────────────────────────────
# runtime — api, web, demo. No browsers.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS runtime

# Ownership is set per-COPY rather than with a trailing `chown -R /app`: a
# recursive chown rewrites every file into a new layer, roughly doubling the
# image. --chown costs nothing.
#
# Production dependency tree (root + any nested workspace node_modules). The
# @qaai/* entries are relative symlinks into packages/, which resolve because
# the source lands at the same /app paths below.
COPY --from=deps-prod --chown=node:node /app ./

# Source. .dockerignore keeps node_modules, .env, .git and build output out, so
# this cannot clobber the dependency tree copied above.
COPY --chown=node:node . ./

COPY --from=build --chown=node:node /app/apps/api/src/generated ./apps/api/src/generated
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next

# tsx is pinned to the exact version in package-lock.json so the image cannot
# silently drift to a newer transpiler than the one this repo is tested against.
RUN npm i -g --no-audit --no-fund tsx@4.23.1

# Service dispatcher. Kept inline rather than as a checked-in script so the
# whole contract lives in one reviewable file.
RUN set -eux; \
    { \
      echo '#!/bin/sh'; \
      echo '# One image, many services. See Dockerfile.'; \
      echo 'set -e'; \
      echo 'cmd="${1:-api}"'; \
      echo 'if [ $# -gt 0 ]; then shift; fi'; \
      echo 'case "$cmd" in'; \
      echo '  api)     exec tsx apps/api/src/index.ts ;;'; \
      echo '  worker)  exec tsx apps/worker/src/index.ts ;;'; \
      echo '  demo)    exec tsx apps/demo/src/index.ts ;;'; \
      echo '  web)     exec npm run start -w @qaai/web ;;'; \
      echo '  migrate) cd apps/api; exec npx prisma migrate deploy ;;'; \
      echo '  seed)    cd apps/api; exec npx tsx prisma/seed.ts ;;'; \
      echo '  *)       exec "$cmd" "$@" ;;'; \
      echo 'esac'; \
    } > /usr/local/bin/qaai-entrypoint; \
    chmod 0755 /usr/local/bin/qaai-entrypoint

# The artifacts volume mounts here; it must exist and be owned by the
# unprivileged user before the volume is bound, or Docker seeds the named volume
# from a root-owned directory and the worker cannot write screenshots to it.
RUN mkdir -p /app/.artifacts && chown node:node /app/.artifacts

# node:22-slim ships an unprivileged `node` user (uid 1000). Nothing here needs
# root at runtime.
USER node

EXPOSE 3000 4000 5050 5051

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/qaai-entrypoint"]
CMD ["api"]

# ─────────────────────────────────────────────────────────────────────────────
# runtime-browsers — the worker, and only the worker.
# ─────────────────────────────────────────────────────────────────────────────
#
# The brief asked for a single image. This is the one place I split it, because
# the alternative was worse in both directions:
#
#   - Put Chromium in the shared `runtime` layer and the API, cockpit and demo
#     store each carry ~400MB of browser they never open. That cost is paid on
#     every pull, on every node, forever.
#   - Leave the browsers out and the worker cannot run a single test.
#
# This target is `FROM runtime`, so it is not a second build: every layer below
# is byte-identical and shared: the same npm install, the same source, the same
# entrypoint. Only one extra layer differs. There is nothing to drift, because
# there is still exactly one Dockerfile and one dependency tree.
#
# Only Chromium is installed. Every launch site in the codebase is
# `chromium.launch()` — packages/runner/src/{login,browser-pool}.ts and
# packages/agent/src/crawler.ts — so Firefox and WebKit would be dead weight.
# Re-check that if a plugin ever launches another engine.
FROM runtime AS runtime-browsers

USER root

# Browsers go outside node_modules so they survive a dependency reinstall, and
# so this layer stays cacheable independently of the app code.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# --with-deps installs the system libraries Chromium needs (fonts, nss, dbus).
# Keep this version in step with the `playwright` dependency in package.json.
RUN npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /ms-playwright

USER node

CMD ["worker"]
