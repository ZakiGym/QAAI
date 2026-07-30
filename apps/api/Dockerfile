# QAAI API.
#
# The monorepo is copied whole and run with tsx rather than precompiled. That is
# a deliberate simplification for this stage — see README §Known gaps. A
# production image should build to dist/ and ship only the runtime deps.

FROM node:22-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/runner/package.json packages/runner/
COPY packages/agent/package.json packages/agent/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/demo/package.json apps/demo/
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts

COPY . .

# Generate the Prisma client for this platform's binary target.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

ENV NODE_ENV=production
EXPOSE 4000

# Migrations and the seed run from the compose command; this is the fallback.
CMD ["npx", "tsx", "apps/api/src/index.ts"]
