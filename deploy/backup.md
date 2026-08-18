# Backup and restore

Two questions get asked in every self-hosting conversation: *how do I back it up*,
and *have you ever restored from one*. This document answers both, and the second
answer includes real numbers from a real restore.

---

## The one thing to read if you read nothing else

**`pg_dump` captures every secret ROW and not one usable secret VALUE.**

`Secret.valueEnc`, `Integration.configEnc`, `SsoConnection.oidcClientSecretEnc`,
`User.totpSecretEnc` and every other `*Enc` column are AES-256-GCM under
`VAULT_MASTER_KEY`. That key lives in your environment, **not in the database**.
That is the entire security value of the vault — someone who steals a dump gets
ciphertext — and it is also the trap:

> Restore a dump without the matching `VAULT_MASTER_KEY` and the platform comes
> back looking **completely healthy**. Orgs, projects, tests, runs, history, all
> of it. Every test that needs a credential then fails, permanently, and there is
> nothing in the backup that can recover the plaintext. You will not find out at
> restore time. You will find out during the incident you were restoring from.

So:

1. Store `VAULT_MASTER_KEY` in a secret manager, in a **different blast radius**
   from where the dumps live. A dump and its key in the same S3 bucket is one
   compromise, not two.
2. Verify you can actually retrieve it, on a schedule, *before* you need it. The
   manifest records a **fingerprint** of the key (a truncated domain-separated
   SHA-256 — not the key, and not reversible to it), so this is a one-command check:

   ```bash
   qaai backup verify --from /backups/2026-08-01
   # VAULT — OK: VAULT_MASTER_KEY here matches the key that sealed these 412 secret(s)
   ```

3. If you rotate the key, take a fresh backup immediately afterwards. Older
   backups remain readable only with the older key, and `keyVersionsInUse` in the
   manifest tells you which versions a given backup still needs.

`restore` **refuses** when it can prove the key is wrong, and says **CANNOT
VERIFY** — loudly — when it cannot prove either way. It never says OK on a guess.

---

## Taking a backup

The `qaai` command comes from the **`@qaai/cli`** package — `npm i -g @qaai/cli`.
Install it by the scoped name: the unscoped `qaai` on npm belongs to an unrelated
project, and these commands run against your production database.

```bash
export DATABASE_URL='postgresql://qaai:…@db:5432/qaai'
export VAULT_MASTER_KEY='…'   # only to fingerprint it; never written anywhere

qaai backup create --out /backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)
```

Produces two files:

| File | What it is |
|---|---|
| `qaai.dump` | `pg_dump --format=custom --no-owner --no-privileges` |
| `manifest.json` | Schema version, migration state, row counts, checksum, vault fingerprint, and **what is not in here** |

`create` **refuses to overwrite an existing dump.** The command that runs
unattended every night is the one that must never be able to destroy last night's
good copy.

### Credentials never reach the command line

Every child process (`pg_dump`, `pg_restore`, `psql`) gets its credentials
through `PGPASSWORD`/`PGUSER` in the environment, never as an argument. `argv` is
world-readable in `ps` on a shared host, and a database host is a shared host by
definition. Nothing in `manifest.json` contains a password — the `source` field is
`user@host:port/database` and is built by a function that is never given one.

### The worker schedules this for you

A backup command nobody runs is not a backup, so the worker runs it. Set

```bash
QAAI_BACKUP_DIR=/backups     # writable by the worker; different disk from Postgres
QAAI_BACKUP_KEEP=7           # how many nightly copies survive the prune
```

and `apps/worker/src/processors/backup.ts` calls the **same** `backupMain`
this document describes — imported in-process, not a reimplementation and not a
shell-out — once a day, into `qaai-backup-<UTC stamp>/` under that directory.
It is a BullMQ repeatable job de-duplicated by a fixed jobId, so worker
restarts cannot double-schedule it, and it survives as long as any worker does
(a plain `setInterval` would do neither). Daily cadence means the
recovery-point objective is **up to 24 hours of loss**; if that is too much for
your install, run the cron below on top — the two coexist, since `create`
refuses to collide with an existing directory.

With `QAAI_BACKUP_DIR` unset, **no backup runs and the worker says so** — one
warn-level log line per day naming the variable to set. An unconfigured backup
is loud on purpose; the silent version of that state is how installs discover
their backup posture during the incident.

A failed nightly backup marks the BullMQ job FAILED and prunes nothing.

### A cron that behaves (if you schedule it yourself)

```bash
#!/usr/bin/env bash
set -euo pipefail
OUT=/backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)

qaai backup create --out "$OUT"
status=$?
case $status in
  0) ;;                                    # done
  3) echo "SKIPPED: postgresql-client missing" >&2; exit 0 ;;
  *) echo "BACKUP FAILED ($status)" >&2; exit $status ;;
esac
```

Exit codes: **0** done · **1** refused for a safety reason · **2** a bug ·
**3** skipped, a required tool is not installed. `3` is deliberately not a
failure: nothing was attempted, and the message names the package to install.
Alerting on it as a broken backup means alerting on a broken *package list*.

### Rotation and pruning

The CLI **never deletes a backup.** Deleting the wrong one is unrecoverable and
the tool cannot know which one you are mid-incident on.

The worker's scheduled sweep **does** prune — that division is deliberate. A
human runs the CLI mid-incident, when deleting anything is the wrong reflex; a
scheduler that never deletes fills the disk at day N, and a disk that fills is
a backup system that killed the database it protected. So after — and only
after — a night's backup succeeds, the sweep keeps the newest
`QAAI_BACKUP_KEEP` directories matching `qaai-backup-*` and removes the rest,
oldest first. Anything else in the directory (your own dumps, notes, a
prefix-matching *file*) is structurally invisible to it. A night the backup
fails deletes nothing: the old copies matter most on exactly that night.

Still keep at least one copy elsewhere whose deletion requires a second pair of
hands — the prune protects the disk, not against the disk.

---

## What is NOT in the backup

`manifest.json` carries this list, with reasoning, in every backup. Summarised:

### Artifacts — excluded, deliberately

Screenshots, videos, traces and HAR files are **not** in the dump. The `Artifact`
rows are, so the restored database knows exactly which object keys it expects.

Why not include them:

- They are typically **100–1000×** the size of the database. Copying them into
  every nightly dump turns a 30-second backup into a multi-hour one, and the
  backup you stop taking is worse than the one that omits a screenshot.
- They already live in object storage, immutable once written, **with a lifecycle
  policy on the bucket**. A second copy inside the dump would have a *different*
  retention clock from the one that enforces your customers' retention promise —
  which is how artifacts outlive the promise made about them.
- They are reproducible in the way that matters: a run's verdict, findings and
  history are in the database. The screenshot is evidence for a decision that is
  already recorded.

**What you must do instead:** back the bucket up *as a bucket* — versioning plus
cross-region replication, or a scheduled sync. And know the consequence: after a
restore, artifacts for runs older than your bucket lifecycle will 404. The run
history is intact; the screenshots for expired runs are gone. That is the trade,
stated out loud.

### Also excluded

| Not included | Why | What to do |
|---|---|---|
| `VAULT_MASTER_KEY`, `SESSION_SECRET`, the rest of `.env` | Deliberate — see above | Separate secret manager, different blast radius |
| Redis: queues, in-flight run state, rate limits | Not durable state; replaying a mid-flight job against restored rows produces duplicates | Nothing. After a restore, reconcile stale `RUNNING`/`QUEUED` runs to `CANCELLED` |
| Roles, `GRANT`s, ownership | Dumped `--no-owner --no-privileges` so it restores into a differently-named role, which is what a real recovery looks like | Create the target owned by your API's role; capture roles with `pg_dumpall --roles-only` |
| Other databases in the cluster | Single-database dump by design | Run once per database |

---

## Restoring

```bash
createdb -h db -U qaai qaai_restore          # the tool will not create it for you
qaai backup restore --from /backups/2026-08-01 \
                    --to postgresql://qaai:…@db:5432/qaai_restore \
                    --migrations apps/api/prisma/migrations
```

`restore` runs every check first, reports **all** blocking problems at once, and
writes nothing unless every one of them passes. Reporting blockers one at a time
trains an operator to clear each with the override flag the message helpfully
names, until it goes through — which is what these gates exist to prevent.

### The gates

| Gate | Refuses when | Override |
|---|---|---|
| Checksum | `qaai.dump` does not match the manifest's SHA-256 | none — this one is absolute |
| Same database | `--to` names the database the backup was taken *from* | `--overwrite` |
| Non-empty target | The target already has tables | `--overwrite` |
| **Schema version** | The backup is from a **newer** schema than the code you are restoring into | `--allow-newer-schema` |
| Schema divergence | The two histories each have migrations the other lacks | **none** |
| **Vault key** | `VAULT_MASTER_KEY` provably differs from the one that sealed these secrets | `--allow-key-mismatch` |

Use `--dry-run` to run every gate and write nothing.

#### Why the schema gate refuses rather than warns

Restoring a **newer** dump into an **older** deployment does not fail loudly. It
succeeds: `pg_restore` happily recreates the newer tables, the older application
does not know about them, and Prisma's next `migrate deploy` finds migration rows
it has no files for. What follows is schema drift resolved by hand, under time
pressure, on what is by then the only copy of the data. Refusing costs a deploy;
proceeding costs the data.

The **older** direction is the ordinary case and is allowed with a note: restore,
then run `prisma migrate deploy` before starting the API.

Divergence has no override on purpose. `--allow-newer-schema` means "I know this
backup is ahead of the target", which is a claim nobody can make about two
branches that each contain migrations the other lacks.

### Atomicity

The restore runs inside `--single-transaction` with `--exit-on-error`, so it
either lands completely or leaves the target untouched. `--jobs <n>` restores in
parallel and **gives that up** — a failure then leaves a partially restored
database. The tool says so at the time. Use it for a large recovery where you are
restoring into a scratch database anyway.

### Every destructive restore is recorded

`--overwrite` drops and recreates every table in the target. Before it does, the
tool counts what is there, and afterwards it appends to `restores.jsonl` **in the
backup directory**:

```json
{"startedAt":"…","finishedAt":"…","target":"qaai@db:5432/qaai_restore",
 "overwrite":true,"destroyed":{"tables":54,"rows":2737},"pgRestoreExit":0,
 "schemaCheck":"Schema matches exactly (11 migrations).",
 "vaultCheck":"VAULT — OK: …","dumpSha256":"…"}
```

Beside the dump, not in a log file elsewhere, because the question this answers
later — *was this backup ever restored, where, and did it destroy anything* — is
asked of the backup, and the backup is the artifact guaranteed to still exist.

### The restore proves itself

After `pg_restore` returns 0, the tool re-counts every table in the target and
compares against the manifest. A restore that is **short** on any table exits
non-zero, regardless of what `pg_restore` said.

Note the asymmetry: **more** rows than the backup is fine, **fewer** is an
incident. The manifest's counts are read after the dump completes, from a source
that is still taking writes, so a busy database will legitimately show a few extra
rows. A check that failed on that would cry wolf until somebody added `--force` to
the cron.

---

## Proof: an actual restore

Run against the live development database on 2026-08-02. Not a fixture.

```
$ qaai backup create --out /tmp/bk1
Dumping qaai@localhost:5432/qaai → /tmp/bk1/qaai.dump
  qaai.dump       240.7 KiB  sha256 bbbebbad7d21b697…
  manifest.json   54 tables · 2736 rows · schema 20260801050000_performance_test_type

$ createdb qaai_restore_proof
$ qaai backup restore --from /tmp/bk1 --to postgresql://…/qaai_restore_proof --all-tables
```

| | backup | restored | delta |
|---|---:|---:|---:|
| Step | 946 | 946 | 0 |
| Finding | 665 | 665 | 0 |
| TestResult | 410 | 410 | 0 |
| Artifact | 305 | 305 | 0 |
| AuditLog | 144 | 144 | 0 |
| Run | 90 | 90 | 0 |
| Session | 56 | 56 | 0 |
| RunShard | 48 | 48 | 0 |
| Test / TestVersion | 11 / 11 | 11 / 11 | 0 |
| `_prisma_migrations` | 11 | 11 | 0 |
| **54 tables** | **2736** | **2736** | **0** |

Row counts are the weakest possible check, so content was compared too:

```
                    source                            restored
Run       md5   a16c15e4859ebab9e216bab5ec472957   a16c15e4859ebab9e216bab5ec472957
Step      md5   9162c8e3489f0649ae4a788217e75f4e   9162c8e3489f0649ae4a788217e75f4e
indexes         176                                176
constraints     123                                123
enum types      26                                 26
```

`AuditLog` was the one table whose digest differed — because the source kept
writing during the test (144 rows at dump time, 147 by the time of the comparison).
Restricting both sides to rows at or before the dump's newest row gives an
identical digest, `c84da46710334a2782e3330200835645`, on both. That is the
"advisory counts" caveat above, observed in practice.

### The vault trap, demonstrated

A secret was sealed with the platform's own vault code, backed up, and restored
under a **different** `VAULT_MASTER_KEY`:

```
$ qaai backup restore --from /tmp/bk2 --to …/qaai_vault_proof
VAULT — MISMATCH: these 1 secret(s) were sealed under key 6ab0381bc89c9388;
the key in this environment is 25804ab700df83b4.

REFUSING to restore — 1 problem(s):
  1. VAULT_MASTER_KEY in this environment is a DIFFERENT key … Find the matching
     key before you restore. If you genuinely intend to restore the data and
     re-enter every secret by hand, pass --allow-key-mismatch.
Nothing was written to the target.
```

Forced through with `--allow-key-mismatch`, the restore reports complete success —
`54 tables compared · 2737 rows in backup · 2737 rows restored`, every table
matched — and the secret is gone forever:

```
with the WRONG key: UNDECRYPTABLE — wrong key or tampered ciphertext
with the RIGHT key: DECRYPTED: sk_live_the_real_plaintext_value
```

That is the failure this whole document exists to prevent: **a backup that looks
complete and is not.**

---

## Per-org export (GDPR / portability)

Different question, different safe answer.

```
GET /export/org           → everything one org owns, as JSON
GET /export/org/preview   → counts and the exclusion list, without the data
```

`OWNER` only, audited as `org.export`, streamed.

**Secrets are excluded, and that is the design.** A backup holds ciphertext, which
is safe because the key lives elsewhere. An export is decrypted by definition — it
is JSON, handed to a human, over HTTP, usually because they asked in a support
ticket. An export containing decrypted secrets is a credential breach with a
delivery mechanism attached. The response says so in its own body, so the
recipient knows what is missing and why:

```json
{ "secretsIncluded": false,
  "droppedColumns": ["hint", "keyHash", "valueEnc"],
  "excluded": [ { "what": "Secret values …", "why": "…", "whatYouGetInstead": "…" } ] }
```

Exclusion is enforced by **shape, not by a list**: any column whose name says it
carries credential material (`*Enc`, `*Hash`, `storageState`, `signature`, `hint`)
is dropped. A sealed column added to the schema next month is excluded the day it
is added. The sharpest one is `AuthProfile.storageState` — a plain JSON column
with an innocuous name that holds **live, unexpired session cookies for your own
application**.

You get the secret's name, environment, key version and timestamps. You do not get
the value.

A truncated export is machine-detectable: the document ends with
`"QAAI_EXPORT_INCOMPLETE"` and the connection is destroyed, so an HTTP client sees
a partial response rather than a clean 200 over half a file.

---

## Wiring

All three entry points are mounted (this section used to be a to-do list; each
item below was verified against the source, not remembered):

1. **`qaai backup`** — `packages/cli/src/index.ts` dispatches `backup` (and the
   `restore` alias) to `backupMain`.
2. **`GET /export/org`** — `apps/api/src/index.ts` mounts `exportOrgRouter` at
   `/export`.
3. **The nightly schedule** — `apps/worker/src/index.ts` registers a consumer
   for the `qaai.backup` queue and arms the daily repeatable job on boot. See
   [The worker schedules this for you](#the-worker-schedules-this-for-you).

## Docker

`docker info` fails on this machine — the Docker CLI is not installed — so nothing
here has been containerised or tested in a container. The commands above assume
PostgreSQL 17 client tools on the host (`brew install postgresql@17`,
`apt-get install postgresql-client-17`). If backups are run from a container, it
needs a client whose major version is **>= the server's**; `create` refuses
outright when `pg_dump` is older, because an old client silently omits what the
newer server added.
