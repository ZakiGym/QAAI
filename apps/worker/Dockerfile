# QAAI worker.
#
# Based on the Playwright image because this is the process that launches
# browsers — the base image already carries Chromium, Firefox, WebKit and their
# system libraries, which is far less fragile than installing them by hand.
# Keep the tag's Playwright version in step with the one in package.json.

FROM mcr.microsoft.com/playwright:v1.62.0-jammy
WORKDIR /app

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

RUN npx prisma generate --schema apps/api/prisma/schema.prisma

ENV NODE_ENV=production
# Playwright's browsers live in the image, not in node_modules.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["npx", "tsx", "apps/worker/src/index.ts"]
