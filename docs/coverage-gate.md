# Coverage as a pull-request check

`qaai run` fails a build when a test fails. That answers "did what we wrote
pass?" It cannot answer "what did this pull request leave with no test at all?",
because a suite's results only ever mention the surfaces somebody already
thought to test.

The coverage gate answers the second question. It reads the share of your
application's **source-declared** surface — routes, API endpoints, forms, auth
surfaces, each with the file it is declared in — that has a test which has
actually run, fails the job below a floor you set, and writes the **named list**
of untested surfaces into the job summary.

The list is the point. A reviewer who reads `coverage 61%` learns nothing they
can act on. A reviewer who reads

> This pull request leaves `/admin/billing`, `POST /api/refunds` and 17 more
> with no test — 8 routes, 9 API endpoints, 2 forms.

can write the tests, or say out loud that they are not going to.

## Add it to a pull request

```yaml
name: QA
on: [pull_request]

jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/qaai-coverage
        with:
          api-key: ${{ secrets.QAAI_API_KEY }}
          api-url: https://your-qaai-host
          project: proj_...
          min-coverage: '70'

      # Keep the measurement. This file is how you check our arithmetic.
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: qaai-coverage
          path: qaai-coverage.json
```

The job needs no checkout of your application, no browser and no environment:
the gate is a read of an analysis the platform already holds, so it runs in
seconds alongside lint rather than behind a suite. That is why it is a separate
action from `./.github/actions/qaai` instead of another mode of it — the long
comment at the top of both files has the full reasoning.

Make it required in **Settings → Branches → Branch protection rules** to have it
block a merge rather than just report.

## Inputs

| Input          | Required | Default                 | What it does                                                                                                                                                            |
| -------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`      | yes      | —                       | A QAAI API key with the `tests:read` scope. Store it as a repository secret.                                                                                            |
| `project`      | yes      | —                       | The project to measure. Copy the id from the app.                                                                                                                       |
| `min-coverage` | yes      | —                       | The floor, 0–100. Below it, the job fails. It has no default on purpose: a floor we chose for you is either a number you never agreed to, or a `0` that can never fail. |
| `api-url`      | no       | `http://localhost:4000` | Your QAAI host.                                                                                                                                                         |
| `limit`        | no       | `100`                   | How many untested surfaces to **name** (1–1000). The counts are always complete; the summary says so when the list has been capped.                                     |
| `status`       | no       | `UNCOVERED`             | Which states to name. `UNCOVERED` is also the only setting the API returns worst-first. Every state's **count** is in the summary whatever this is set to.              |
| `kind`         | no       | all                     | Narrow the named list to `ROUTE`, `ENDPOINT`, `FORM`, `AUTH_SURFACE` (comma-separated).                                                                                 |
| `origin`       | no       | all                     | Narrow the named list to one of `SOURCE_ONLY`, `CRAWL_ONLY`, `BOTH`.                                                                                                    |
| `json-path`    | no       | `qaai-coverage.json`    | Where the measurement is written.                                                                                                                                       |
| `cli-version`  | no       | `0.1.0`                 | The pinned `@qaai/cli` version to run.                                                                                                                                  |

## Outputs

| Output        | Value                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `percent`     | The measured percentage to one decimal place, or **empty** when there was nothing to divide. Never `0` for an unmeasured project — that would be a different claim. |
| `state`       | `PASS`, `BELOW_FLOOR`, `NOT_MEASURED`, `UNREADABLE`, or `CLI_FAILED`.                                                                                               |
| `exit-code`   | The verdict as the CLI's exit code: `0`, `1`, `2`, `3`.                                                                                                             |
| `uncovered`   | How many surfaces have no test at all.                                                                                                                              |
| `denominator` | How many surfaces the percentage was measured over.                                                                                                                 |

Reading them from a failing step needs `continue-on-error: true` on this action,
as in [Never analysed](#never-analysed) below.

Two of the inputs are easy to misread, so they are worth stating plainly:

- **`kind` and `origin` narrow the list, not the percentage.** The percentage is
  always measured over the whole surface. A gate you could point at one axis
  would be a gate you could pass by pointing it somewhere flattering.
- **`cli-version` is pinned for a security reason, not a taste one.** The
  unscoped name `qaai` on npm belongs to an unrelated project, so the package is
  always installed by its scoped name and at a fixed version — see the comment
  in `.github/actions/qaai/action.yml`. Keep the pin in both actions moving
  together: two CLI versions in one pipeline means two vocabularies for
  "covered".

## Exit codes

The action's verdict is the CLI's, with one deliberate addition described under
[Never analysed](#never-analysed).

| Code | Meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| `0`  | At or above the floor.                                                                                             |
| `1`  | Below the floor. The summary names what has no test.                                                               |
| `2`  | The gate never ran: bad inputs, no API key, the API unreachable or unreadable.                                     |
| `3`  | **There was nothing to measure.** Distinct from `1` on purpose: your coverage did not drop, it was never computed. |

`2` and `3` are separate from `1` so that a team whose API key expired does not
spend an afternoon hunting a coverage regression that never happened.

## What the summary says

Beyond the percentage and the named list:

- **Every state, counted.** `covered`, `a test exists but has never run`,
  `no test`, `cannot tell`, `waived`. A test that exists but has never executed
  is **not** counted as covered — it has not been shown to pass, or to assert
  anything. `cannot tell` means static analysis could not resolve which surface
  a test reaches (usually a URL built at run time); it is never presented as a
  gap, and it stays in the denominator because the uncertainty is ours.
- **Per-axis rows**, with `nothing to divide` rather than `0%` for an axis with
  no items on it.
- **The axes QAAI does not measure**, by name. Eight have no extractor yet, and
  they are named rather than reported as `0%`: "0% of your component states are
  covered" would be a claim about your application, while "we do not measure
  component states" is a fact about ours, and only the second is true.
- **The caveats, next to the figure** — not behind a tooltip. If the crawl
  stopped at 60 pages, or a detector was blocked, or no source analysis has run,
  that belongs beside the number it produced.
- **Which commit it was measured against.** The gate measures the analysis QAAI
  holds for the project. When that was taken against a different commit than the
  pull request's head, the summary says so: surfaces your branch adds are not in
  the denominator until the repository is analysed again.
- **Its own cross-check.** The action re-derives the headline from the per-axis
  rows. If the two disagree, it says so in the summary and names both numbers.
  That is a defect in QAAI, and you should not have to be the one who finds it.

## Never analysed

A project with no measurable surface has **no percentage** — not `0%`, and not
`100%`. `percent` is null, and a gate that reads null as "not below the floor"
is a green tick on a repository that has never been looked at.

So the check fails with exit `3` and a summary that says what to do: connect the
repository, let an analysis finish (or `POST /surface/<projectId>/recompute`),
re-run. The action reaches that verdict from the figures itself, so it holds even
if the CLI ever exits `0` on a null percentage.

To let an unmeasured project through on purpose — a new repository, mid-rollout
— key on the state explicitly rather than widening the gate:

```yaml
- id: coverage
  continue-on-error: true
  uses: ./.github/actions/qaai-coverage
  with:
    api-key: ${{ secrets.QAAI_API_KEY }}
    project: proj_...
    min-coverage: '70'
- name: Tolerate "not measured yet", but nothing else
  if: steps.coverage.outcome == 'failure' && steps.coverage.outputs.state != 'NOT_MEASURED'
  run: exit 1
```

## Checking our arithmetic

A percentage a vendor computes in private is a marketing number. Everything the
gate used is in `qaai-coverage.json`, which is the CLI's `--json` payload: the
API's response verbatim, plus the gate's own verdict under `gate`. Upload it as
an artifact (see the workflow above) and you can re-derive our figure from the
same bytes we used.

**Level 1 — check the division.** The headline is `covered / denominator` over
the axes marked `measured`, to one decimal place, and null when the denominator
is zero:

```bash
jq '[.snapshot.totals.byKind[] | select(.measured)]
    | (map(.covered) | add) as $c
    | (map(.denominator) | add) as $d
    | if $d > 0 then (($c / $d) * 1000 | round) / 10 else "not measured yet" end' \
  qaai-coverage.json

jq '.snapshot.totals.percent' qaai-coverage.json   # must be the same number
```

If those two disagree, that is our bug. Send us the file.

**Level 2 — check the counts, not just the division.** `items` is a page, so
fetch every state at a high enough limit and count them yourself:

```bash
qaai coverage --project proj_... \
  --status COVERED,ASSERTED_NOT_RUN,UNCOVERED,UNKNOWN,WAIVED \
  --limit 1000 --json > all.json

# Your own per-axis tally, from the rows themselves.
jq -S '[.items[] | {kind: .item.kind, status: .status}]
       | group_by(.kind)
       | map({kind: .[0].kind, counts: (group_by(.status) | map({(.[0].status): length}) | add)})' all.json

# Ours, to compare against.
jq -S '.snapshot.totals.byKind' all.json

# And make sure nothing was held back.
jq '{returned: (.items | length), total, truncated}' all.json
```

Two things to hold on to while comparing:

- `denominator` excludes `waived` and nothing else. `unknown` stays in it
  deliberately: moving items we cannot reason about out of the denominator would
  raise the percentage every time our own extractor got worse.
- Every item carries `kind`, a stable `key`, the `file` and `line` it was
  declared in, its `origin` and the `evidence` sentence that justifies it. If an
  item should not be in your denominator, that is a waiver with a reason
  (`POST /surface/<projectId>/waivers`), not an argument about the total.

**Level 3 — re-derive the inventory.** The denominator comes from a source
analysis of your repository, and `snapshot.inputs.analysisId` identifies the one
used. Re-running the extraction over the same commit reproduces the same item
keys, which is the property that makes the number auditable rather than
asserted.

## Running it alongside the suite

They are independent jobs and want different triggers:

```yaml
jobs:
  # Every pull request, in seconds. No environment, no browser.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/qaai-coverage
        with:
          api-key: ${{ secrets.QAAI_API_KEY }}
          api-url: https://your-qaai-host
          project: proj_...
          min-coverage: '70'

  # The tests themselves, against a deployed environment.
  suite:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/qaai
        with:
          api-key: ${{ secrets.QAAI_API_KEY }}
          api-url: https://your-qaai-host
          environment-id: env_...
```

See `docs/ci.md` for the suite side, API keys and the rest of the CLI.

> **Dependency note.** `qaai coverage` is newer than the pinned
> `cli-version: 0.1.0`. Until the release carrying it is published on npm, point
> `cli-version` at that version explicitly; until then a run fails with exit `2`
> and a summary saying the pinned CLI predates the command, which is the right
> failure but is not the gate doing its job.
