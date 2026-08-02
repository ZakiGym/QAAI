# The dogfood suite

QAAI's own cockpit is a web application. It has a login, forms, tables, empty
states, keyboard shortcuts and 29 screens, and until this directory existed
nothing tested any of it — while the product's entire pitch is that nobody
should ship a web app in that state.

This is that suite. It is a real Playwright project, it runs against the real
stack, and it is the strongest statement this codebase can make about its own
quality.

```bash
npm run test:e2e                         # everything
npm run test:e2e -- --project=guest      # only the signed-out journeys
npm run test:e2e -- triage.spec.ts       # one file
npm run test:e2e -- --ui                 # pick through it interactively
npx playwright show-report e2e/.artifacts/html
```

Typecheck it the way every other package in the repo is typechecked:

```bash
cd e2e && npx tsc --noEmit -p tsconfig.json
```

## Before you run it

The suite drives a **live** stack, because a cockpit tested against mocks proves
nothing about the product:

| what        | where                   |
| ----------- | ----------------------- |
| web         | `http://localhost:3000` |
| api         | `http://localhost:4000` |
| demo app    | `http://localhost:5050` |
| Postgres, Redis, worker | as `docker-compose.yml` sets them up |

`npm run dev` at the repo root brings all of it up, and `npm run db:seed` puts
the demo org, project and tests in place. If the web or API is not answering,
the setup step says so in a sentence and names the command to fix it rather
than letting every test fail with `ERR_CONNECTION_REFUSED`.

Everything is overridable, so this can be pointed at staging or at a container:

| variable            | default                        |
| ------------------- | ------------------------------ |
| `E2E_BASE_URL`      | `http://localhost:3000`        |
| `E2E_API_URL`       | `http://localhost:4000`        |
| `E2E_EMAIL`         | `owner@qaai.local`             |
| `E2E_PASSWORD`      | `qaai-demo-password-1`         |
| `E2E_DATABASE_URL`  | `DATABASE_URL`, else the repo's `.env` |

## What it covers

| file                | the journey                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `auth.spec.ts`      | signing in, a wrong password, signing out, and a signed-out visitor being sent to the login form |
| `runs.spec.ts`      | the runs list, the status filter, and pressing Run landing you in the cockpit |
| `cockpit.spec.ts`   | a real failure: the failing test, the step it died on, the message, the findings, the evidence rail |
| `triage.spec.ts`    | reading a verdict with its evidence, overriding it, and undoing a bulk decision |
| `editor.spec.ts`    | opening a test, editing it, saving with the button and with ⌘S, and being warned about unsaved work |
| `coverage.spec.ts`  | gaps rendering with the evidence for each claim, and the offer to turn them into a plan |
| `palette.spec.ts`   | ⌘K, ⌘P, ⌘\, ⌘/ and the shortcuts sheet                                  |
| `screens.spec.ts`   | every screen — including the id-addressed ones — loads and logs nothing at error level |

`screens.spec.ts` is the cheapest file here and probably the most valuable. On a
codebase whose characteristic defect is correct code wired to nothing, a screen
that renders but throws, calls an unmounted route, or reads a field the API
stopped sending shows up there and nowhere else.

## How these are written

The rules are the ones QAAI's own generator prompt hands the model, applied to
QAAI:

- **Role and label locators, never a CSS path.** `getByRole('button', { name: 'Agree' })`,
  not `.triage-panel > div:nth-child(3) button`.
- **No fixed sleeps.** Every wait is a web-first assertion on a state the user
  can see. The one exception is typing cadence, which is not a wait.
- **One behaviour per test**, named as a sentence about the product.
- **Assert the user-visible outcome.** Where a click has to reach the database
  to mean anything — a triage override — the suite also reads the row back,
  because a toast is a claim and a row is a fact. This repo has already shipped
  a "1 test queued" success message for a job that died in the worker.

Where following those rules against this app was hard, that is written down as a
finding rather than worked around quietly. Three examples, all live in the code
as comments:

- Neither `<nav>` in the app carries an accessible name, and the landing page
  has one of its own — so `getByRole('navigation')` cannot tell the app shell
  from marketing. The shell is identified by its collapse button instead.
- `StatusDot` puts `aria-label` on a bare `<span>`, where ARIA prohibits a name.
  Run and step status is colour plus a tooltip and is not announced at all, so
  the cockpit tests locate steps by index and title.
- The agent panel's prompt box has a placeholder and no label.

## Choices worth knowing about

**One worker.** Every test shares one Postgres and one demo application. Saving
a file, starting a run and overriding a verdict all mutate state another spec
can see, so parallel workers would manufacture exactly the order-dependent flake
this product exists to diagnose.

**Zero retries locally.** A dogfood suite that needs a retry to go green is
telling you something, and it should be legible as a flake and not hidden.

**It really starts a run.** `runs.spec.ts` presses Run for real: a row in
Postgres, a job on the queue, the worker driving the demo app. It does not wait
for the run to finish — what must never break is the hand-off, not the demo
app's pass rate.

**It seeds its own verdicts.** Triage verdicts are only ever written by the
triage pipeline, which needs `ANTHROPIC_API_KEY`, and this deployment has none.
So `triage.spec.ts` inserts two PENDING verdicts on already-failed results,
drives the screen against them, and deletes them again (`fixtures/db.ts`). With
no database reachable it **skips with a sentence saying what to do** — a missing
credential is skipped, never failed and never faked.

**Its scratch files clean themselves up.** `editor.spec.ts` writes into a test
file it created for the purpose and soft-deletes it afterwards, and the teardown
checks that the delete actually succeeded instead of firing and forgetting.

**Some tests skip themselves, on purpose.** A filter with nothing to filter, a
run with no failed step, an app that has never been crawled — each skips with a
sentence naming the command that would give it something to work with. A test
that silently passes against no data is worse than one that says it did not run.

## Known gaps

Named here rather than left for somebody to discover:

- **The agent panel, recording, and self-healing approvals are untested.** All
  three need a model, and there is no `ANTHROPIC_API_KEY` on this deployment.
- **Nothing waits for a run to finish**, so the streaming cockpit — the live
  step feed, the shard strip mid-flight — is only covered in its finished state.
- **Chromium only.** The cockpit is a desktop product; Firefox and WebKit are a
  deliberate later step, not an oversight.
- **No visual assertions.** QAAI has its own visual-diff test type; pointing it
  at QAAI is the obvious next move and is not done here.
