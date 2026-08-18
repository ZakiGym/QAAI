# Running QAAI in CI

QAAI is CI-native: a suite runs from the `qaai` CLI, exits nonzero when a test
fails or a quality gate blocks, and writes JUnit XML for your CI's own
reporting. Nothing about this is GitHub-specific — the same command works in
GitLab, Jenkins, CircleCI, or a bare shell.

The package is **`@qaai/cli`**; the command it installs is `qaai`. Always install
it by the scoped name. The unscoped `qaai` on npm is an unrelated project by
another author, so `npx qaai` fetches and runs somebody else's binary — in a
step where you have just put your API key in the environment.

## 1. Create an API key

Settings → API keys → **New key**. Copy it once — it is never shown again.
Store it as a CI secret named `QAAI_API_KEY`.

## 2. Find your environment id

Open the environment in the app; the id is in the URL, or copy it from the
project's environment list.

## 3. Run it

```bash
export QAAI_API_KEY=qaai_...
export QAAI_API_URL=https://your-qaai-host

npx @qaai/cli@0.1.0 run --env <environmentId> --junit results.xml
echo "exit code: $?"   # 0 = green, 1 = a test failed or a gate blocked
```

## GitHub Actions

```yaml
name: QA
on: [pull_request]

jobs:
  qaai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/qaai
        with:
          api-key: ${{ secrets.QAAI_API_KEY }}
          api-url: https://your-qaai-host
          environment-id: env_...
```

The action publishes per-test results to the Checks tab and fails the job on
any test failure or blocking gate.

## Post-deploy smoke + rollback

```bash
# After deploying to production:
qaai deploy-check --env <prodEnvironmentId> || ./scripts/rollback.sh
```

`deploy-check` runs the smoke suite and exits nonzero on failure, so a rollback
step keyed off `||` fires automatically.

## Command reference

Installed globally (`npm i -g @qaai/cli`) the command is `qaai`. Run without
installing with `npx @qaai/cli@<version> …`.

```
qaai run --env <id> [--suite <id>] [--commit <sha>] [--junit <path>]
                     [--no-wait] [--timeout <sec>]
qaai deploy-check --env <id> [--junit <path>]
qaai status <runId>

qaai backup create --out <dir>            Self-hosted operators; see deploy/backup.md
qaai backup verify --from <dir>
qaai backup restore --from <dir> --to <postgres-url>
qaai runner                               Run an on-prem runner agent

--json             Machine-readable output on stdout
--api-url <url>    Overrides $QAAI_API_URL
--api-key <key>    Overrides $QAAI_API_KEY
```
