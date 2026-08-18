# Deploying QAAI

One image, one compose file, one command.

> ### Nothing here has been built or run
>
> Docker is not installed on the machine this was written on — no `docker`
> binary, no Docker Desktop, no podman, colima or nerdctl:
>
> ```
> $ docker info
> zsh: command not found: docker
> ```
>
> So treat this as **reviewed and statically validated, not proven**. What was
> actually verified is listed under [What was verified](#what-was-verified);
> what a first `docker compose up` still has to confirm is listed under
> [What is still unproven](#what-is-still-unproven). A compose file nobody has
> run is a guess, and the honest thing is to say which parts are guesses.

---

## Quickstart

```bash
cp deploy/.env.example .env          # compose reads .env from the repo root

# Generate the five required secrets (none of them have defaults).
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "MINIO_ROOT_USER=qaai-$(openssl rand -hex 4)"
  echo "MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"
  echo "SESSION_SECRET=$(openssl rand -base64 48)"
  echo "VAULT_MASTER_KEY=$(openssl rand -base64 32)"
} >> .env

docker compose up -d --build
```

Then:

| URL                     | What                                        |
| ----------------------- | ------------------------------------------- |
| `http://localhost:3000` | Cockpit                                     |
| `http://localhost:4000` | API — `/health`, `/health/ready`, `/metrics` |
| `http://localhost:5050` | Bundled demo store (the app QAAI tests)     |

To put it on the internet, use the Caddy override — see
[The front door](#the-front-door-tls-with-caddy-recommended). For scraping and
alerting, see [Metrics](#metrics-prometheus-scraping-metrics) and
[Logs, error reporting and alerting](#logs-error-reporting-and-alerting).

To load the demo org/project/suite (**first boot only** — see
[Seeding](#seeding)). The `seed` service lives in the override file, so copy it
first; compose then picks it up automatically:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose run --rm seed
```

---

## Back up `VAULT_MASTER_KEY` before you boot

`VAULT_MASTER_KEY` is the AES-256-GCM key that seals every credential a customer
stores — their app logins, integration tokens, the GitHub App private key. It is
not a session secret and it is not rotatable in any useful sense: **change it and
every sealed secret in the database becomes permanently unreadable.**

- Store it in a password manager or KMS *before* first boot.
- Back it up **alongside, never inside**, the database dump. A dump that
  contains its own decryption key is a plaintext dump.
- In production, prefer injecting it from KMS at run time over a file on disk.

There is deliberately no default. `docker compose up` fails with a named error
until you supply one, because a default in a public repo is not a default — it
is a published encryption key shared by every install that ever copied it. Two
independent layers enforce this:

1. **Compose** — every credential is written `${VAR:?message}`, which refuses to
   start when the variable is unset *or empty*.
2. **The API** — `apps/api/src/env.ts` requires `VAULT_MASTER_KEY` to decode to
   exactly 32 bytes and calls `process.exit(1)` otherwise. Verified: the old
   `replace-me-with-openssl-rand-base64-32` placeholder decodes to 28 bytes and
   is rejected, so a copied placeholder cannot boot.

---

## How the image is put together

`Dockerfile` at the repo root replaces the four per-app Dockerfiles. Stages:

```
base ─┬─ manifests ─┬─ deps-full ── build ──┐   (npm ci, all deps; next build)
      │             └─ deps-prod ───────────┤   (npm ci --omit=dev)
      │                                     │
      └─────────────── runtime ◀────────────┘   api · web · demo
                          └── runtime-browsers  worker
```

Run a service by naming it:

```bash
docker run --rm qaai/app:local api      # or worker | web | demo | migrate | seed
docker run --rm qaai/app:local node -v  # anything else passes through
```

### Why the worker gets its own target

The brief asked for a single image; this is the one place it is split, because
both alternatives are worse. Putting Chromium in the shared layer makes the API,
cockpit and demo store each carry ~400MB of browser they never open — paid on
every pull, on every node, forever. Leaving it out means the worker cannot run a
single test.

`runtime-browsers` is `FROM runtime`, so this is not a second build: every layer
below is byte-identical and shared, and exactly one layer differs. There is
still one Dockerfile and one dependency tree, so there is nothing to drift —
which was the actual problem with the four Dockerfiles this replaces.

Only Chromium is installed. Every launch site in the codebase is
`chromium.launch()` (`packages/runner/src/{login,browser-pool}.ts`,
`packages/agent/src/crawler.ts`), so Firefox and WebKit would be dead weight.
Re-check if a plugin ever launches another engine.

### Why TypeScript runs through `tsx` instead of compiled output

`apps/{api,worker,demo}/tsconfig.json` all set `"noEmit": true`, so
`npm run build` emits nothing and the `"start": "node dist/index.js"` script in
each manifest points at a `dist/` that is never produced. Until those tsconfigs
emit, the only runnable form of this code is the source. `tsx` is therefore
installed into the final layer — pinned to `4.23.1`, the version in
`package-lock.json` — even though npm classifies it as a devDependency.

This is the main thing worth fixing later: compiling to `dist/` would drop the
transpiler, the TypeScript sources and roughly a third of the image.

Everything else in the final layer is production-only (`npm ci --omit=dev`). The
Prisma CLI survives that prune because `@prisma/client` declares it as a peer
dependency, which is what makes the `migrate` verb work in a prod image.

---

## Two bugs this found

Both were verified against the live local Postgres, not read off the page.

**1. The previous compose file's migration step could never have worked.**

It ran `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma` from
the repo root. But `schema.prisma` declares `datasource db` with **no `url`** —
the connection string lives in `apps/api/prisma.config.ts`, which Prisma 7
resolves relative to the *working directory*, not to `--schema`:

```
$ npx prisma migrate status --schema apps/api/prisma/schema.prisma   # repo root
Error: The datasource.url property is required in your Prisma config file
       when using prisma migrate status.

$ cd apps/api && npx prisma migrate status                           # correct
Loaded Prisma config from prisma.config.ts.
Datasource "db": PostgreSQL database "qaai" ... at "localhost:5432"
11 migrations found in prisma/migrations
Database schema is up to date!
```

The API's boot command chained `migrate deploy && db:seed && tsx index.ts`, so
the API would have crash-looped on first boot. The `migrate` verb in the new
entrypoint `cd`s into `apps/api` first.

**2. Seeding on every boot corrupts or crashes.**

The old API command ran `npm run db:seed` on every start. `apps/api/prisma/seed.ts`
uses `prisma.*.create()`, not `upsert`, and has no "already seeded" guard — so
the second boot either duplicates the demo org or dies on a unique constraint.
Seeding is now a `profiles: ["tools"]` service that a plain `up` never triggers.

---

## Design decisions worth knowing

**Migrations are a separate one-shot service**, not a step in the API's command.
Scaling the API to two replicas would otherwise run two concurrent
`migrate deploy`s against one database, and a migration failure now stops the
rollout instead of leaving a half-migrated API serving traffic. The API waits on
`migrate: {condition: service_completed_successfully}`.

**Datastores are not published to the host.** Postgres, Redis and MinIO are
reachable only on the compose network. `docker-compose.override.yml.example`
publishes them on `127.0.0.1` for local work.

**App ports bind to `127.0.0.1` by default** (`API_BIND`/`WEB_BIND`/`DEMO_BIND`).
These services do not terminate TLS; set `0.0.0.0` only behind a reverse proxy
that does.

**The container runs as the unprivileged `node` user.** Root is used only to
install Chromium's system libraries, then dropped.

**`tini` is PID 1**, so `SIGTERM` reaches the process and the worker's browser
children get reaped instead of becoming zombies that hold the container open.

**Secrets reach `minio-init` through the environment, not the command line**, so
they do not appear in `docker ps`, `docker inspect` or compose logs.

---

## Seeding

`docker compose run --rm seed` is safe on an empty database and destructive-ish
on a populated one (duplicate demo org, or a unique-constraint error). It is a
first-boot convenience, never a startup step. See bug 2 above.

---

## Backup and restore

The database and the vault key are two separate backups, and a restore needs
both.

The worker now schedules the real backup path itself: set `QAAI_BACKUP_DIR`
(and optionally `QAAI_BACKUP_KEEP`, default 7) and it runs `qaai backup create` (the CLI is `@qaai/cli` — `npm i -g @qaai/cli`; the unscoped `qaai` on npm is a different project)
daily into timestamped subdirectories, pruning all but the newest N after each
success — see `deploy/backup.md`. **In-container caveat, stated honestly:** the
image does not install the PostgreSQL client tools, so inside the worker
container that schedule currently fails loudly every night with an install
hint. Until `postgresql-client-17` is added to the runtime layer (see the
unproven list), either run the scheduled worker on a host that has `pg_dump`
17, or take manual dumps through the postgres container:

```bash
# Database
docker compose exec -T postgres pg_dump -U qaai -d qaai --format=custom > qaai-$(date +%F).dump

# Restore into a fresh stack
docker compose exec -T postgres pg_restore -U qaai -d qaai --clean --if-exists < qaai-YYYY-MM-DD.dump
```

Artifacts (screenshots, videos, traces) live in the `qaai-miniodata` volume, or
`qaai-artifacts` when `ARTIFACTS_LOCAL=true`. They are reproducible by re-running
a suite, so they are lower-value than the database — but a run's evidence is
gone once pruned.

**A database backup without `VAULT_MASTER_KEY` restores to an account whose every
stored credential is undecryptable.** Back up the key separately, and test the
restore path before you need it.

---

## The front door: TLS with Caddy (recommended)

The app services do not terminate TLS and never should — `API_BIND`/`WEB_BIND`
keep them on `127.0.0.1` for exactly that reason. The recommended way onto the
internet is the Caddy override: one domain, automatic certificates, the cockpit
at `/` and the API under `/api`.

```bash
# .env — the three values that must agree:
#   QAAI_DOMAIN=qaai.example.com
#   NEXT_PUBLIC_API_URL=https://qaai.example.com/api
#   WEB_PUBLIC_URL=https://qaai.example.com

docker compose -f docker-compose.yml -f deploy/docker-compose.tls.yml up -d --build
```

Files: `deploy/caddy/Caddyfile` (the routing) and `deploy/docker-compose.tls.yml`
(the service). Things worth knowing, all commented in those files too:

- **`NEXT_PUBLIC_API_URL` is baked into the cockpit's JS at image build time.**
  Changing it means `docker compose build web`, not a restart. The `--build`
  above is not decoration.
- **The proxy strips `/api`**, so the API serves `/auth`, `/runs`, `/webhooks`…
  at its root exactly as it does locally. External webhook URLs (Stripe, GitHub)
  become `https://<domain>/api/webhooks/…`.
- **`/api/metrics` answers 404 at the edge.** `/metrics` is unauthenticated by
  design (see [Metrics](#metrics-prometheus-scraping-metrics)) and its privacy
  model is the network boundary; the front door must not move that boundary.
- **Leave `API_BIND`/`WEB_BIND` at `127.0.0.1`.** Caddy reaches the services
  over the compose network; publishing them on `0.0.0.0` would put plaintext
  ports beside the TLS ones.
- The demo store is deliberately not proxied — it is a practice target, not
  product surface.

---

## Metrics: Prometheus scraping /metrics

The API serves Prometheus text format at `/metrics`, and the workers are
included in the same body (they publish snapshots via Redis; the API renders
them — there is no worker port to scrape). Wire it in with:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.metrics.yml up -d
```

**There is no token, and that is not an oversight.** The header of
`apps/api/src/routes/health.ts` states the position: a scrape config has no
session, and giving Prometheus a credential means writing a credential into a
scrape config. The trade it buys: every metric is a non-tenant aggregate over
closed label vocabularies — no org, project, test, branch or URL ever appears —
and privacy comes from the network boundary. So the wiring to document is not a
token, it is the boundary: `deploy/prometheus/prometheus.yml` targets `api:4000`
on the compose-internal network, and the Caddyfile refuses `/api/metrics` from
the internet. Scraping from outside the compose network means *you* are moving
the boundary — put your own auth in front (Caddy `basic_auth` on a separate
hostname) if you do.

The Prometheus UI itself is bound to `127.0.0.1:9090` because it has no auth of
its own; reach it over an SSH tunnel.

---

## Logs, error reporting and alerting

**There is deliberately no Sentry SDK here.** One almost shipped: a
`SENTRY_DSN` variable used to be parsed and forwarded, consumed by nothing — an
operator could set it and believe they had error reporting when they had a
discarded string. It was removed for that reason (the comment in
`apps/api/src/env.ts` is the record). Adding the SDK back is a fine future
decision; adding the *impression* of it is not. What exists instead is real:
every service logs structured JSON (pino) to stdout with request ids, and every
5xx already increments `qaai_api_exceptions_total` / `qaai_http_errors_total`
on `/metrics`.

**Shipping logs** is therefore a Docker logging-driver decision, not an app
change. At minimum, bound the local files (the default `json-file` driver is
unbounded):

```yaml
# docker-compose.override.yml — applies per service; repeat or anchor it.
services:
  api:
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

To ship them off the box, swap the driver per service — `syslog` to an rsyslog
target, `fluentd`, `gelf`, or Grafana's Loki driver plugin — and keep pino's
JSON intact end to end: `docker logs` and every log pipeline then see the same
searchable fields (`level`, `requestId`, `err`). Start with rotation; add
shipping when a second machine exists to ship to.

**Alerting on queue health.** Two surfaces, two jobs. For *investigating*, the
queue-health endpoint — `GET /health/queues` (behind the front door:
`https://<domain>/api/health/queues`) — reports, per queue, what is waiting,
executing and permanently failed, plus the newest failed job's name, error line
and timestamp. It requires a session at ADMIN or better, unlike `/metrics`,
precisely because failed-job error text can carry anything a processor threw;
that makes it the runbook's first `curl`, not a scrape target. For *paging*,
the aggregate signals live on `/metrics`, and the ones that page well are
already documented in their own HELP text:

| Expression | Meaning |
|---|---|
| `qaai_workers_online == 0 and qaai_queue_depth > 0` | the definition of a stalled install — work waiting, nobody draining |
| `qaai_queue_oldest_job_age_seconds > 600` | a queue that is moving too slowly to matter, even if it is moving |
| `rate(qaai_worker_jobs_total{outcome="failed"}[10m]) > 0` | jobs are completing by dying |
| `qaai_oldest_queued_run_age_seconds > 300` | the number a customer feels |

Alert on `qaai_workers_online` (emitted even at zero), never on the
per-instance `qaai_worker_up` series, which disappear rather than going to
zero. For a plain uptime check without Prometheus, poll `/health/ready` — it
returns 503 naming which dependency is down.

---

## What was verified

Without Docker, everything below was checked by running it, not by reading:

- **Prisma migration path** — reproduced the failure from the repo root and the
  success from `apps/api`, against the live local Postgres (read-only
  `migrate status`; no `deploy`, no `reset`, no seed was run).
- **The entrypoint dispatcher** — extracted the `RUN` block from the Dockerfile,
  executed it to generate the script, and dispatched every verb against stub
  binaries. All seven resolve correctly; `migrate` and `seed` run with
  `cwd=apps/api`; unknown commands pass through; exit codes propagate.
- **Compose YAML parses** — with a real YAML parser. This caught a genuine
  break: `${VAR:?generate with: openssl ...}` messages contain a colon-space,
  which YAML reads as a nested mapping. Those values are now quoted.
- **Anchor/merge expansion** — `worker.build` correctly inherits the shared build
  block and overrides only `target`; `api.environment` merges to 22 keys.
- **Secret hygiene** — no credential has a non-empty default in compose; all
  seven secret slots in `.env.example` are blank; no secret appears in any
  `ENV` or build `ARG`; `.dockerignore` excludes `.env`.
- **Dependency layering** — `npm ci --omit=dev --dry-run` against the real
  lockfile confirms `prisma`, `@prisma/client`, `next` and `playwright` survive
  the prune and `tsx` does not, which is why `tsx` is installed explicitly.
- **Workspace manifest list** — confirmed all ten workspaces in the lockfile, and
  that omitting `apps/desktop` keeps `electron@43` out of the build while
  `npm ci` still installs cleanly (602 → 432 packages prod-only).
- **Placeholder rejection** — `replace-me-with-openssl-rand-base64-32` decodes to
  28 bytes, so `apps/api/src/env.ts` rejects it.
- **All five compose files parse** — the base file, the override example, the
  TLS override, the metrics override and `deploy/prometheus/prometheus.yml`,
  each through a real YAML parser, after the tag/limit/front-door changes.
- **Tag pinning basis** — `postgres:17.2-alpine` and `redis:7.4-alpine` name
  releases that shipped more than a year before this change, in libraries that
  publish `major.minor` tags as policy. That is an argument from history, not a
  registry lookup (no docker here) — stated as such. MinIO has no minor line to
  pin and its dated `RELEASE.*` tags cannot be named from memory without risk
  of inventing one, so it stays `latest` with digest-pinning instructions in
  the compose file instead.
- **The /metrics contract** — read, not assumed: the endpoint is deliberately
  unauthenticated (`apps/api/src/routes/health.ts`), which is why the scrape
  config carries no token and the Caddyfile blocks the path at the edge.
- **Restart policies** — audited rather than added: every long-running service
  already carried `unless-stopped`, the one-shots `no`/`on-failure`. The new
  caddy and prometheus services follow suit.
- **The scheduled backup tick** — unit-tested against the real filesystem and a
  faked `backupMain`: the repeatable job's dedupe key is fixed across boots, the
  prune keeps the newest `QAAI_BACKUP_KEEP` and touches nothing outside its own
  `qaai-backup-*` naming, a failed backup prunes nothing, and the unconfigured
  path warns daily instead of throwing
  (`apps/worker/src/processors/backup.test.ts`). Compose forwards
  `QAAI_BACKUP_DIR`/`QAAI_BACKUP_KEEP` to the worker service.

## What is still unproven

Everything that needs a container runtime:

- **The image has never been built.** Layer ordering, the cross-stage
  `COPY --from=deps-prod /app ./` (which relies on npm's workspace symlinks being
  relative), and `next build` inside the image are all unexercised.
- **The stack has never come up.** Service ordering, healthcheck commands and
  `migrate` completing before the API starts are untested.
- **`minio/minio:latest` healthcheck** uses `curl`, which recent MinIO images may
  not ship. If MinIO never reports healthy, that check is the first suspect.
- **MinIO/mc are still floating on `latest`** — pin them by digest before
  production; the exact commands are commented in `docker-compose.yml`. The
  `caddy:2-alpine` and `prom/prometheus:v2.53.1` tags in the overrides were
  chosen for certainty-from-memory, not confirmed against a registry.
- **Chromium install** — `npx playwright install --with-deps chromium` on
  Debian bookworm is the standard path but has not been run here.
- **In-container nightly backups cannot succeed yet.** The runtime layer
  installs no `pg_dump`, so the worker's daily backup tick inside this image
  fails with the CLI's install hint (loudly — the job goes FAILED, nothing is
  pruned) until `postgresql-client-17` is added to the Dockerfile. That is a
  real apt-source change (bookworm ships client 15; 17 needs the PGDG repo)
  which nobody here can build or boot, so it is recorded as the gap it is
  rather than committed untested. Until then, scheduled in-container backups
  are a promise the image does not keep — run them from a host with the 17
  client, or use the manual `docker compose exec postgres pg_dump` path above.
- **Resource limits are budgets, not measurements.** Every long-running service
  now carries a `mem_limit`, but none has been exercised under load. The worker
  is the one that will surprise you: ~500MB per `WORKER_CONCURRENCY` slot plus
  the 1GB `/dev/shm` counting against the same cgroup — `WORKER_MEM_LIMIT` is
  the knob if the budget is wrong.
- **The TLS front door has never terminated a connection.** The Caddyfile is
  unvalidated (no caddy binary here — not even `caddy validate` has run);
  ACME issuance, the `/api` prefix strip, the SSE flush behaviour and the
  `/api/metrics` block are all reasoned, not observed. Validate on first
  deploy: `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`.
- **The Prometheus config has never been loaded by Prometheus.** It parses as
  YAML, but `promtool` is not installed here, so `promtool check config` has
  never run — do it once on a machine that has it (the command is in the file's
  header). Whether the scrape actually lands is likewise unproven.

## Leftovers for whoever owns those files

`apps/{api,worker,web,demo}/Dockerfile` are now unreferenced — the root
`Dockerfile` replaces all four. They were left in place because they fall outside
this change's file ownership. **They should be deleted**, or they will drift back
into use: they are the files that carried bug 1 and bug 2 above.
