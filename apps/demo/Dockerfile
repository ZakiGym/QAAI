# The bundled demo store. No database, no build step — it boots in a second,
# which is what makes the offline demo and the onboarding walkthrough viable.

FROM node:22-slim
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

ENV NODE_ENV=production
EXPOSE 5050 5051

CMD ["npx", "tsx", "apps/demo/src/index.ts"]
