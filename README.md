# QAAI — the AI QA engineer

An autonomous agent that tests your app like a staff QA engineer, plus a cockpit
where your team supervises it. Everything it writes is standard code you own.

**This repository is a working foundation and vertical slice, not the finished
product described in the spec.** The [Status](#status) section below is an
honest inventory of what runs, what is scaffolded, and what is absent. Read it
before assuming a feature exists.

---

## What works today

A run against the bundled demo store produces this, end to end:

```
RUN FAILED   passed=4 failed=2 flaky=0

FAILED   E2E            Order total equals subtotal plus shipping and tax
       ok  [0] Open the products page                     (37ms)
       ok  [1] Add the Brew Scale to the cart             (22ms)
       ok  [2] Add the Single Origin coffee to the cart   (59ms)
      FAIL [3] The order total is the sum of its parts    (20ms)
           expected=7504  actual=5704   screenshot captured

PASSED   E2E            A single-line cart totals correctly
PASSED   SMOKE          The storefront is up and listing products
PASSED   API            Health endpoint reports the store is up
PASSED   ACCESSIBILITY  Storefront pages meet WCAG 2.1 AA      (4 serious findings)
FAILED   SECURITY_SMOKE Security smoke: auth walls, object ids, headers
      FAIL [2] IDOR probe: /orders/ORD-1001 — object readable anonymously
```

That failure is the point. The demo store carries a planted bug: with two or
more line items, the order total silently drops the cheapest one. Every price on
the page is correct, so a pixel diff or a "page loaded" check sails past it. Only
an assertion about _meaning_ — total equals subtotal plus shipping plus tax —
catches it. Flip `DEMO_PLANTED_BUG=false` and the same test goes green.

---

## Quick start

### With Docker

```bash
cp .env.example .env
# Generate the two required secrets:
#   SESSION_SECRET   -> openssl rand -base64 48
#   VAULT_MASTER_KEY -> openssl rand -base64 32
docker compose up
```

Cockpit at http://localhost:3000, API at http://localhost:4000, demo store at
http://localhost:5050. The API container runs migrations and the seed on boot.

### Without Docker

Postgres 17 and Redis 7 need to be reachable. On macOS:

```bash
brew install postgresql@17 redis && brew services start postgresql@17 && brew services start redis
createdb qaai
```

Then:

```bash
npm install
npx playwright install chromium
cp .env.example .env    # fill in SESSION_SECRET and VAULT_MASTER_KEY
npm run db:migrate -w @qaai/api
npm run db:seed
```

Four processes, one per terminal:

```bash
npm run dev:demo     # :5050  the app under test
npm run dev:api      # :4000
npm run dev:worker   #        runs the agents and the tests
npm run dev:web      # :3000  the cockpit
```

Sign in as `owner@qaai.local` / `qaai-demo-password-1`, then **Run against
local**.

> Homebrew's Redis 8.10 formula ships a `redis.conf` that loads four module
> `.so` files it does not install, so the service aborts on boot. Comment out
> the `loadmodule ./modules/...` lines near the end of
> `/opt/homebrew/etc/redis.conf`. QAAI uses none of those modules.

---

## Architecture

```
apps/
  web/      Next.js cockpit + marketing site
  api/      Express + Prisma — REST, SSE, auth, tenancy, the vault
  worker/   BullMQ — the agents and the test runner execute here
  demo/     The bundled store under test, with a planted bug and an SMTP catcher
packages/
  agent/    Explorer, Generator, Triage, Healer, Chat — every LLM call
  runner/   Test execution, one plugin per test type, plus quality gates
  storage/  Artifact storage: S3-compatible, or local disk
  shared/   Types, zod schemas, constants, secret masking
```

Three decisions shape most of the code:

**Generated tests are standard Playwright, executed by the real Playwright
runner.** The runner writes each spec into a workspace and shells out to
`playwright test`, then parses the JSON reporter. A bespoke in-process harness
would have been simpler, and it would have made "no lock-in" a lie — the
generated code has to run under plain `npx playwright test` with QAAI
uninstalled, and this is the only way to be sure it does.

**Tenancy is enforced in a Prisma extension, not per query.** A request runs
inside `withTenant(orgId, …)` and every operation on an org-owned model is
rewritten to carry that org. Escaping is possible but has to be spelled
`unscoped(...)`, which is greppable. See `apps/api/src/lib/prisma.ts`.

**Triage never silently self-heals.** Every failure gets a verdict, a confidence
score, and evidence pointing at specific steps, requests, and history. The
Healer proposes a diff; a human approves it. The one exception the spec allows —
auto-approving a selector-only fix — re-derives the risk level from the diff
rather than trusting the model's self-report, and refuses anything touching an
`expect(`.

---

## Status

### Runs end to end, verified

| Area                       | Notes                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| Auth, orgs, RBAC, sessions | scrypt from `node:crypto`; no native build step                                 |
| Multi-tenancy              | Prisma extension; unique-lookup and unique-mutation paths both covered          |
| Secrets vault              | AES-256-GCM, AAD-bound to `(orgId, name)`, versioned key                        |
| Audit log                  | Append-only, CSV export helper, secret-masked metadata                          |
| Projects, environments     | Plan limits enforced server-side                                                |
| **Runner: E2E, Smoke**     | Real Playwright; steps, screenshot on failure, video, trace                     |
| **Runner: API**            | Native HTTP, chained requests, variable extraction, latency assertions          |
| **Runner: Accessibility**  | axe-core WCAG 2.1 AA; violations as first-class findings                        |
| **Runner: Security smoke** | Auth walls, IDOR probes, security headers, cookie flags                         |
| Quality gates              | Quarantined tests never block; a retry that passes counts as flaky              |
| Flake radar                | Rolling rate over the last 50 results; auto-quarantine above 20%                |
| Artifacts                  | Local disk or S3/MinIO; served behind the session check, never a raw bucket URL |
| Run queue                  | BullMQ, per-queue concurrency, idempotent job ids, graceful drain               |
| Live run events            | Worker → Redis → API → SSE → cockpit                                            |
| Cockpit                    | Three-pane: suite tree, step scrubber, evidence + verdict card                  |
| JUnit XML                  | `GET /runs/:id/junit.xml` for any CI                                            |
| Landing page               | Hero, verdict explainer, migration wedge, pricing                               |

### Built but not verified end to end

These are complete and typecheck, but every path through them needs an
`ANTHROPIC_API_KEY`, which was not available in the environment where this was
built. **Treat them as untested code.**

- **Explorer** — Playwright crawl → Flow Map → plain-English plan. The crawl half
  is LLM-free and deterministic; the plan half is one structured call.
- **Generator** — plan item → Playwright spec, given real locators with
  confidence scores. Low-confidence locators come back as review flags.
- **Triage** — verdict with evidence; escalates from the cheap model to the
  strong one when the first pass is under 0.75 confidence.
- **Healer** — unified diff, with the auto-approve safety check described above.
- **Chat copilot** — tool loop over flow map, tests, and run history.

Without a key the run queue still works: tests execute, artifacts are captured,
gates evaluate. Failures simply carry no verdict, and the cockpit says so rather
than pretending.

### Scaffolded, not implemented

Typed interfaces and database schema exist; the behaviour does not. The runner
registry names each gap explicitly (`packages/runner/src/registry.ts`), and a
run containing one of these records it as `SKIPPED` with the reason rather than
failing the suite.

Integration · Visual regression · Load/k6 · Unit-test generation ·
Cross-browser matrix · Localization · Email/OTP plugin (the SMTP catcher it
would drive **is** built and working)

### Absent

Named in the spec, no code here beyond schema: GitHub App and PR check runs ·
GitLab/Bitbucket/Jenkins · the `qaai` CLI · scheduling and synthetic monitoring
(schema and cron parser present, no sweeper) · Slack/Teams/Discord ·
Jira/Linear/GitHub Issues filing · signed outbound webhooks · OpenAPI spec at
`/api/docs` · suite import (Cypress, Selenium, …) and export · Stripe billing ·
the `/admin` panel · PostHog and Sentry · Docusaurus docs · TOTP enrolment
(login checks for it; there is no enrolment route) · OAuth providers.

---

## Deliberate deviations from the spec

**Auth is API-owned, not NextAuth.** With a separate Express API, NextAuth would
put two systems in charge of sessions with a shared secret between them. One
session table, one place a token is minted, and the CLI and cockpit authenticate
identically. OAuth providers slot in as extra routes on the same router.

**Next 16 / React 19 / Tailwind 4, not Next 14.** Next 14 is well past end of
life. The app router structure the spec asks for is unchanged.

**TypeScript is run with `tsx`, not precompiled.** `npm run build` typechecks;
the Docker images run the sources. Fine for this stage, wrong for production —
a real image should compile to `dist/` and ship runtime deps only.

**Prisma 7 moved the connection URL out of the schema** into `prisma.config.ts`
plus a driver adapter. Not a choice, but it is why the schema has no `url`.

---

## Things worth knowing before you extend this

- **`withTenant` and `unscoped` must wrap the awaited call, not return the
  promise.** Prisma promises are lazy; returning one from
  `AsyncLocalStorage.run()` executes the query _after_ the scope exits. Both
  helpers wrap the callback in an `async` function for exactly this reason.
- **The tenancy extension's ownership check needs `orgId` in the result.** A
  caller's `select` can omit it, so the extension adds it and strips it back
  out. Removing that makes every narrow `findUnique` return `null`.
- **Playwright's JSON reporter omits `category` on steps.** Filtering steps on
  `category === 'test.step'` silently drops every one of them.
- **Generated specs cannot run from `os.tmpdir()`** — there is no `node_modules`
  above it, so `@playwright/test` will not resolve. Workspaces are created
  beside the installed package instead.
- **The API and worker must agree on the local artifact root.** Both call
  `defaultLocalArtifactRoot()`; resolving `.artifacts` per-process means the
  worker writes somewhere the API cannot read.

---

## Commands

```bash
npm run typecheck              # every workspace
npm run db:migrate -w @qaai/api
npm run db:seed
npm run dev:api | dev:worker | dev:demo | dev:web
npm run format
```
