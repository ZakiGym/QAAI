# Rotating the vault key

> **This document replaces a claim that was false.** Until this round, the
> vault's own header described rotation as "re-encrypting lazily instead of in
> one migration", while `keyForVersion` read `if (version === 1)` and threw for
> everything else, and `needsRotation()` had no caller. There was no sweeper,
> lazy or otherwise. The practical consequence was the sentence nobody wants in
> an incident review: **a compromise of the master key could not be remediated**
> — rotating it made every sealed secret in the install permanently unreadable,
> so the only available response to a leaked key was to keep using it.
>
> That is no longer true, and this page is what it is true of instead.

## What rotation now rests on

**Many keys readable, exactly one writable.** A sealed value is opened with the
key its own stored version names; a new value is sealed with the single `ACTIVE`
key. That is the whole mechanism, and it is why rotation does not need a flag
day: a key moved from `ACTIVE` to `READABLE` keeps opening everything it sealed
while new writes go to its replacement.

The four key states are in `packages/shared/src/sealed.ts`:

| State | Seals new values | Opens existing values |
| --- | --- | --- |
| `ACTIVE` | yes — and exactly one key may be `ACTIVE` | yes |
| `READABLE` | no | yes |
| `RETIRED` | no | no |
| `COMPROMISED` | no | no — and it is refused *by name*, distinctly from `RETIRED` |

`RETIRED` and `COMPROMISED` are deliberately separate. Both refuse, but an
operator who sees `KEY_COMPROMISED` in a log is being told something different
from `KEY_NOT_READABLE`, and collapsing the two would lose the one fact that
matters during an incident.

**An unknown key version is a named refusal, never a decrypt attempt.** If a row
names a version this deployment cannot identify — a value written by a newer
build, or by a key that was never registered — `selectOpeningKey` refuses with
`UNKNOWN_KEY_VERSION`. It does not try the other keys. Trying them would turn a
configuration mistake into a slow oracle.

## The state every existing install is in

**`VaultKey` is empty in every deployment that exists today**, and that is on
purpose. The sealing migration seeds no row — not even version 1 — because a
seeded row would be a migration asserting, about a database it cannot read, that
this deployment's `VAULT_MASTER_KEY` is the key that sealed its existing
secrets.

So with no rows, the vault uses an **implicit keyring**: one key, version 1,
state `ACTIVE`, provider `LOCAL`, backed by `VAULT_MASTER_KEY`. That is exactly
the behaviour the vault had before any of this, expressed in the new vocabulary.
Nothing to run, nothing to migrate, and `plan` will tell you so.

## Doing it

The tool is `apps/api/src/scripts/rotate-vault-key.ts`. It has three commands.

```
tsx apps/api/src/scripts/rotate-vault-key.ts plan
tsx apps/api/src/scripts/rotate-vault-key.ts sweep --field <field> --from <n> --to <n>
tsx apps/api/src/scripts/rotate-vault-key.ts compromise --version <n>
```

`<field>` is one of `Secret.valueEnc`, `User.totpSecretEnc`,
`AuthProfile.storageState`.

### The safety catches

Read these before running anything, because the tool can destroy data:

1. **Dry run by default.** Every command reports counts and changes nothing
   unless `--confirm <database>` is supplied. There is no `--apply` flag whose
   absence is the only thing between you and a live database.
2. **It refuses a database it cannot identify.** `--confirm` takes the identity
   of the database it is about to write to — `host:port/name`, derived from
   `DATABASE_URL` and never its credentials — and the value must match exactly.
   A copy-pasted command therefore cannot run against the wrong database. This
   repository has already paid for that mistake once.
3. **It prints the plan before it acts** — the keyring, the key states, the row
   counts per version, and the sweep it will resume or start — in both dry-run
   and confirmed mode.
4. **There is no `--force`.** Not undocumented, not hidden, not at all. Every
   refusal is one you fix by changing the database or the command.
5. **No long transaction.** One row is re-sealed per statement and progress is
   persisted per batch, so a killed process leaves a *resumable* sweep rather
   than a half-committed one.
6. **A row is never left readable by no key.** The new ciphertext is opened,
   under the key that just sealed it, *before* the old ciphertext is replaced.
7. **An unknown flag is refused rather than ignored.** A tool that silently
   drops `--confrim` performs a dry run while the operator believes it applied.

### A planned rotation

1. `plan` — read the keyring and the per-version row counts. With no `VaultKey`
   rows this reports the implicit keyring and that there is nothing to do.
2. Register the new key and make it `ACTIVE`; move the old one to `READABLE`.
   Exactly one key may be `ACTIVE`, and `selectSealingKey` refuses on **zero**
   as well as on **two** — a keyring with no writable key is not a keyring that
   writes to the old one.
3. `sweep --field … --from … --to …` for each sealed field, dry run first, then
   with `--confirm`. The sweep is resumable; a `cursor` is persisted per batch.
4. When `unopenable` is 0 for every field, move the old key to `RETIRED`.

Both versions are named explicitly rather than "rotate to the newest", because
a sweep is resumable and an operator resuming one must be able to see which pair
of versions it was for.

### A compromised key

`compromise --version <n>` marks a key `COMPROMISED`. It stops sealing **and**
stops opening immediately — which will break reads of any row still under that
version, and that is the correct trade when the key is known to be in someone
else's hands. Run `plan` first to see how many rows that is, then sweep them to
the new key, then mark the old one compromised.

## What a sweep reports, and why it is four numbers

`KeyRotationSweep` records `visited`, `resealed`, `unopenable` and `skipped` as
four separate columns rather than a percentage. A percentage would hide the one
number that matters: `unopenable` is the count of rows this deployment **cannot
read with any key it has**, and it is not an error the sweep retries — it is a
fact about the database that an operator has to decide about. A sweep that
reported "98% complete" would be describing those rows as 2% of nothing.

## The AAD, which is two answers and not one

A sealed value is bound to where it lives, so a ciphertext moved to a row the
binding does not cover fails to open rather than decrypting into somebody else's
record. There are **two bindings in use**, they cover different amounts, and the
split is deliberate:

- **`Secret.valueEnc` uses `(orgId, name)`** — the binding it has always had.
  This is load-bearing: changing it would make every secret already in every
  install unopenable without re-sealing all of them, which is the precise
  failure this round existed to end.

  **`environmentId` IS NOT IN THAT BINDING, and the consequence is measured
  rather than inferred.** Two `Secret` rows in the same organisation with the
  same `name` in different environments are bound identically, so a ciphertext
  lifted from the staging row into the production row (or the reverse) **opens
  cleanly** — a staging value sealed as `postgres://staging/db` was read back
  through the production row's binding and returned that string. A different
  `orgId` and a different `name` are both refused (`CIPHER_REJECTED`), so the
  binding does the two things it names; it simply does not name the
  environment. That is as much separation as `(orgId, name)` can give, and the
  only way to add the environment is the separate, explicit re-seal described
  above — not a side effect of a key rotation.
- **Everything sealed since uses `aadFor(model, rowId, field)`** —
  `User.totpSecretEnc` and `AuthProfile.storageState` — with a unit separator,
  so no two distinct bindings compose to the same string.

**A sweep re-seals under the binding the field already uses and does not migrate
one to the other.** That is measured, not assumed: `resealSecret` calls
`sealWithKeyring`, which composes `legacySecretAad(orgId, name)`. If moving
`Secret.valueEnc` to the new binding ever becomes worth doing it is a separate,
explicit re-seal, not a side effect of a key rotation — and it would need its
own verification pass, because a row whose AAD changed is a row no previous key
can open.

## Where the key material lives

`VaultKey.providerRef` is a **reference and never key material**. For
`provider: LOCAL` the material comes from `VAULT_MASTER_KEY`; for
`provider: KMS` the row names the key and the material is fetched through
`apps/api/src/lib/kms.ts`.

### What a LOCAL-to-LOCAL rotation does NOT achieve

This page opens by saying a master-key compromise "could not be remediated" and
that it no longer cannot. Read that precisely, because the strongest statement
this mechanism supports is narrower than the header sounds, and
`apps/api/src/lib/kms.ts` is the only file that says so today:

**Every LOCAL key version in one deployment is backed by the same bytes.**
`VaultKey` has no column for wrapped material and `registerVaultKeySchema`
refuses a LOCAL `providerRef`, both so that table can never hold key bytes. So
registering a second LOCAL version and sweeping to it re-seals rows under a new
*binding* and moves them off a version you intend to `RETIRE` — which is real,
and is the mechanism every other rotation needs — but it **does not give those
rows different bytes, and therefore does not remediate a leaked
`VAULT_MASTER_KEY`.** Re-sealing a ciphertext under a key derived from the same
leaked bytes is security theatre, and `LOCAL_KEY_PROVIDER.what` says so in the
provider table a cockpit lists.

**`KMS` is a declared seam with `implemented: false`**, refused by name at
registration. So LOCAL-to-LOCAL is the only rotation available today, in every
deployment.

The remediation that *does* exist for a leaked master key is the sequence
`compromise` implements, and it is a different shape from a sweep: mark the key
`COMPROMISED`, take the re-entry worklist it prints, replace `VAULT_MASTER_KEY`,
and have the values **re-entered**. What this round ended is the state where
rotating the key made every sealed secret permanently unreadable and the
worklist did not exist — not the need for re-entry.

**The KMS seam adds no environment variable.** `DEFAULT_KEY_PROVIDER_IO` reads
the local master key from the existing `VAULT_MASTER_KEY` and a KMS-backed key
is identified by its row, not by process configuration — because a customer's
credential belongs on a model row they own rather than in the environment of a
process they share.

## What is not here

- **`prisma migrate deploy` is not run by this tool**, and the rotation
  migration is applied the same way as any other.
- **Rotating `SESSION_SECRET` is a different thing** and is not covered here: it
  signs sessions rather than sealing stored values, so changing it signs
  everyone out and loses nothing.
