# QAAI cockpit.
#
# NEXT_PUBLIC_API_URL is baked in at build time by Next, so the compose file
# passes the browser-reachable URL (localhost:4000), not the in-network one.

FROM node:22-slim AS builder
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

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @qaai/web

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start", "-w", "@qaai/web"]
