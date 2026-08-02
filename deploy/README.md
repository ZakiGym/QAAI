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
| `http://localhost:4000` | API — `/health`, `/health/ready`            |
| `http://localhost:5050` | Bundled demo store (the app QAAI tests)     |

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

## What is still unproven

Everything that needs a container runtime:

- **The image has never been built.** Layer ordering, the cross-stage
  `COPY --from=deps-prod /app ./` (which relies on npm's workspace symlinks being
  relative), and `next build` inside the image are all unexercised.
- **The stack has never come up.** Service ordering, healthcheck commands and
  `migrate` completing before the API starts are untested.
- **`minio/minio:latest` healthcheck** uses `curl`, which recent MinIO images may
  not ship. If MinIO never reports healthy, that check is the first suspect.
- **Image tags are unpinned** — `minio/minio:latest` and `minio/mc:latest` should
  be pinned to dated `RELEASE.*` tags before production.
- **Chromium install** — `npx playwright install --with-deps chromium` on
  Debian bookworm is the standard path but has not been run here.
- **Resource limits** — no CPU/memory limits are set on any service. The worker
  is the one that will surprise you: budget ~500MB per `WORKER_CONCURRENCY` slot.

## Leftovers for whoever owns those files

`apps/{api,worker,web,demo}/Dockerfile` are now unreferenced — the root
`Dockerfile` replaces all four. They were left in place because they fall outside
this change's file ownership. **They should be deleted**, or they will drift back
into use: they are the files that carried bug 1 and bug 2 above.
