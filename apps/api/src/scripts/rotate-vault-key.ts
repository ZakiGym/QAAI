#!/usr/bin/env tsx
/**
 * THE VAULT KEY ROTATION TOOL. A loaded weapon, and the safety catches are
 * listed before anything else in this file.
 *
 * ─── SAFETY MEASURES, STATED FIRST BECAUSE THIS SCRIPT CAN DESTROY DATA ─────
 *
 *  1. DRY RUN BY DEFAULT. Every command reports counts and changes nothing
 *     unless `--confirm <database>` is supplied. There is no `--apply` flag
 *     whose absence is the only thing between an operator and a live database.
 *  2. IT REFUSES A DATABASE IT CANNOT IDENTIFY. `--confirm` takes the
 *     identity of the database it is about to write to — `host:port/name`,
 *     derived from `DATABASE_URL` and NEVER its credentials — and the value
 *     must match exactly. A copy-pasted command therefore cannot run against
 *     the wrong database, which is the mistake this repository has already
 *     paid for: `seed-plans-prod.js` wiped live plans because nothing made the
 *     operator name the target.
 *  3. IT PRINTS THE PLAN BEFORE IT ACTS. The keyring, the key states, the row
 *     counts per version and the sweep it will resume or start — all before
 *     the first write, in both dry-run and confirmed mode.
 *  4. THERE IS NO `--force`. Not undocumented, not hidden, not at all. Every
 *     refusal in this file is a refusal an operator fixes by changing the
 *     database or the command, never by overriding the tool.
 *  5. NO LONG TRANSACTION. One row is re-sealed per statement and progress is
 *     persisted per batch, so a killed process leaves a RESUMABLE sweep and
 *     never a half-committed one.
 *  6. A ROW IS NEVER LEFT READABLE BY NO KEY. `resealSecret` and
 *     `resealEnvelope` open the value they just sealed, under the key they just
 *     sealed it with, BEFORE this script replaces the old ciphertext. A row
 *     whose re-seal does not verify is counted `unopenable` and left exactly as
 *     it was.
 *  7. IT NEVER LOGS KEY MATERIAL, A PLAINTEXT, A NONCE OR A CIPHERTEXT. Every
 *     line it prints is a count, a version, a field name, a row id or a refusal
 *     name. `rotate-vault-key.test.ts` walks every refusal and asserts it.
 *  8. A COMPROMISED KEY IS NOT SWEPT. See {@link reEntryWorklist}: re-sealing a
 *     ciphertext a leaked key protected is security theatre, so the tool
 *     enumerates those rows for re-entry and refuses to sweep them.
 *
 * ─── WHAT IT IS FOR ────────────────────────────────────────────────────────
 *
 * `apps/api/src/lib/vault.ts` used to support exactly one key version, and its
 * own header described a lazy re-encrypt that did not exist. This is that
 * sweep. It is the production caller of `loadVaultKeyring`,
 * `installVaultKeyring`, `needsRotation` and `resealVerdictFor` — the last of
 * which replaces a `needsRotation` that had no caller at all.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────
 *
 *   plan                                      the keyring and what each field needs
 *   sweep --field <key> --from <n> --to <n>   dry run; add --confirm to apply
 *   compromise --version <n>                  the re-entry worklist; add --confirm to mark it
 *
 * `<key>` is one of `SEALED_FIELD_KEYS` in packages/shared/src/sealed.ts.
 */

import { fileURLToPath } from 'node:url';
import {
  VAULT_REFUSAL_REPORTS,
  installVaultKeyring,
  loadVaultKeyring,
  needsRotation,
  resealEnvelope,
  resealSecret,
  resealVerdictFor,
  resetVaultTallies,
  vaultTallies,
  wouldHaveRefusedVault,
} from '../lib/vault.js';
import type { VaultFailure, VaultKeyRow, VaultKeyring, VaultResult } from '../lib/vault.js';
/*
 * Reached by relative path for the reason ../lib/kms.ts records above its own
 * import: `packages/shared/src/sealed.ts` is not in
 * `packages/shared/src/index.ts`, so `@qaai/shared` does not publish these
 * names. One barrel line fixes it and that line is in needsFromOtherFiles.
 */
import {
  KEY_ROTATION_STATES,
  RESUMABLE_ROTATION_STATES,
  SEALED_FIELD_KEYS,
  SEALED_FIELD_RULES,
  isSealedFieldKey,
} from '../../../../packages/shared/src/sealed.js';
import type { KeyRotationState, SealedFieldKey } from '../../../../packages/shared/src/sealed.js';

/**
 * Rows per batch.
 *
 * Small enough that a killed process loses at most this many rows' worth of
 * re-reading on resume, and large enough that a big install is not one
 * statement per round trip. It is NOT a transaction size — there is no
 * transaction — so the number trades resume granularity against chattiness and
 * nothing else.
 */
export const BATCH_SIZE = 200;

// ─── Which format each sealed field stores ──────────────────────────────────

/** How one sealed field's value is laid out, which decides how it is re-sealed. */
export interface SealedFieldFormatRule {
  /**
   * LEGACY_SECRET is raw `iv|tag|ciphertext` base64 with the version in its own
   * column and the AAD composed as `${orgId}:${name}`. ENVELOPE is the `qs1`
   * envelope with the AAD from `aadFor` — model, row AND field.
   */
  readonly format: 'LEGACY_SECRET' | 'ENVELOPE';
  /** Why this field is in that format, including what is true of it today. */
  readonly why: string;
}

/**
 * THE FORMAT OF EVERY SEALED FIELD. A compiler-enforced presence record.
 *
 * A `Record<SealedFieldKey, …>` cannot be written without naming every member,
 * so a fourth sealed field is a type error here rather than a field this script
 * silently skips — and a field a rotation skips is a field that stays readable
 * under a compromised key for ever.
 *
 * The run-time half is in `rotate-vault-key.test.ts`, which asserts the keys of
 * this table and `SEALED_FIELD_KEYS` are the same set: one half without the
 * other passes while the two disagree.
 */
export const SEALED_FIELD_FORMATS = {
  'Secret.valueEnc': {
    format: 'LEGACY_SECRET',
    why:
      'Every secret in every customer database is already in this format, bound to ' +
      '`${orgId}:${name}`. Changing the binding is itself a rotation, so this field keeps its ' +
      'format until a sweep moves it.',
  },
  'User.totpSecretEnc': {
    format: 'ENVELOPE',
    why:
      'MEASURED, NOT ASSUMED: nothing in apps/api or apps/worker writes this column today — ' +
      'grep for `totpSecretEnc:` outside tests returns nothing — so there is no existing format ' +
      'to be compatible with, and a new writer should use the envelope. A sweep over this field ' +
      'therefore visits zero rows in every install, which is a count and not a claim of coverage. ' +
      'If the writer that lands for the second factor uses `seal()` instead, this entry becomes ' +
      'LEGACY_SECRET and `User` has no `orgId` to bind with, which is the reason it is not that ' +
      'today.',
  },
  'AuthProfile.storageState': {
    format: 'ENVELOPE',
    why:
      'Sealed from now on, in `storageStateSealed`, bound to the model, the row AND the field so ' +
      "a session lifted from one profile cannot open as another profile's.",
  },
} as const satisfies Record<SealedFieldKey, SealedFieldFormatRule>;

// ─── What the script reads and writes ───────────────────────────────────────

/**
 * One row holding a sealed value.
 *
 * EVERY FIELD IS REQUIRED and a store must return all of them. A `select` that
 * dropped `keyVersion` would make every row look like it needed sweeping; one
 * that dropped `orgId` would make a legacy secret's binding wrong and every
 * re-seal fail as `CIPHER_REJECTED`. A hand-copied projection inside a function
 * is the same hazard as a select-blind fake, and this round has paid for it.
 */
export interface SealedRow {
  readonly id: string;
  /** Null for a GLOBAL field — `User.totpSecretEnc` has no tenant. */
  readonly orgId: string | null;
  /** The secret's name, for the legacy binding. Null for an envelope field. */
  readonly name: string | null;
  readonly stored: string;
  readonly keyVersion: number | null;
}

/** The reads and the one write a sweep makes against one sealed field. */
export interface SealedFieldStore {
  readonly fieldKey: SealedFieldKey;
  /** How many rows are sealed under this version. The denominator. */
  countAtVersion(version: number): Promise<number>;
  /**
   * One page, ordered by id so a cursor is stable. `afterId` is exclusive; null
   * starts at the beginning.
   */
  page(input: {
    readonly version: number;
    readonly afterId: string | null;
    readonly take: number;
  }): Promise<readonly SealedRow[]>;
  /**
   * Replace one row's sealed value and its version column, in one statement.
   *
   * BOTH COLUMNS TOGETHER. Writing the ciphertext and leaving the version would
   * make the row unopenable; writing the version and leaving the ciphertext
   * would make a sweep skip a row the old key is still the only thing that can
   * read. `hint` is deliberately NOT written: it is derived from the plaintext,
   * a re-seal does not change the plaintext, and recomputing it would need the
   * plaintext to escape the re-seal function.
   */
  write(input: {
    readonly id: string;
    readonly stored: string;
    readonly keyVersion: number;
  }): Promise<void>;
}

/** One `KeyRotationSweep` row, as this script needs it. */
export interface SweepRecord {
  readonly fieldKey: SealedFieldKey;
  readonly fromKeyVersion: number;
  readonly toKeyVersion: number;
  readonly state: KeyRotationState;
  readonly visited: number;
  readonly resealed: number;
  readonly unopenable: number;
  readonly skipped: number;
  readonly cursor: string | null;
  /** A refusal name and a row id. NEVER a ciphertext, a plaintext or a nonce. */
  readonly error: string | null;
}

/**
 * Everything this script touches outside its own process, as one narrow
 * interface — so every test runs against a fake and none needs a database, a
 * key or a clock.
 */
export interface RotateIo {
  /**
   * `host:port/name`, from `DATABASE_URL`, with the credentials dropped.
   *
   * Null when the URL is absent or unparseable, and that is a REFUSAL rather
   * than a default: a tool that will rewrite every sealed value in a database
   * must be able to say which database, and "the one in the environment" is not
   * an answer an operator can check.
   */
  databaseIdentity(): string | null;
  listVaultKeys(): Promise<readonly VaultKeyRow[]>;
  /** `Organization.securityControlModes`-shaped, or undefined for the default. */
  storedModes(): Promise<unknown>;
  stores(): Record<SealedFieldKey, SealedFieldStore>;
  loadSweep(input: {
    readonly fieldKey: SealedFieldKey;
    readonly fromKeyVersion: number;
    readonly toKeyVersion: number;
  }): Promise<SweepRecord | null>;
  saveSweep(record: SweepRecord): Promise<void>;
  markKeyCompromised(input: { readonly version: number; readonly at: Date }): Promise<void>;
  now(): Date;
  log(line: string): void;
}

// ─── The sweep ──────────────────────────────────────────────────────────────

/** What one run of the sweep did. The four counts, never a percentage. */
export interface SweepOutcome {
  readonly record: SweepRecord;
  /** True when this run wrote to the database. False for a dry run. */
  readonly applied: boolean;
  /** Set when the sweep could not start at all. The record is then unchanged. */
  readonly refusal: VaultFailure | null;
}

/**
 * CAN THIS PAIR OF VERSIONS BE SWEPT AT ALL?
 *
 * Checked before a single row is read, because every one of these is a reason
 * the sweep would otherwise do damage or waste a full table scan:
 *
 *   * the SOURCE key is COMPROMISED — re-sealing a ciphertext a leaked key
 *     protected is security theatre, and the honest deliverable is the re-entry
 *     worklist. Refused, with that said.
 *   * the SOURCE key is unknown to this deployment — nothing can open those
 *     rows, so a sweep would visit every one and count every one `unopenable`.
 *   * the TARGET key is not the single ACTIVE key — `resealSecret` seals with
 *     whatever is ACTIVE, so a sweep that claimed to target another version
 *     would write a version it did not name, and the sweep row would be a lie
 *     about what the rows now hold.
 *   * the two versions are equal — nothing to do, and a sweep row saying
 *     `1 → 1` would satisfy the unique constraint and then block the real one.
 */
export function canSweep(
  keyring: VaultKeyring,
  request: { readonly fromKeyVersion: number; readonly toKeyVersion: number },
): VaultResult<{ readonly from: VaultKeyRow; readonly to: VaultKeyRow }> {
  if (request.fromKeyVersion === request.toKeyVersion) {
    return {
      ok: false,
      refusal: 'DUPLICATE_KEY_VERSION',
      detail: `A sweep from version ${request.fromKeyVersion} to itself has nothing to do.`,
    };
  }
  const from = keyring.keys.find((key) => key.version === request.fromKeyVersion);
  const to = keyring.keys.find((key) => key.version === request.toKeyVersion);
  if (!from) {
    return {
      ok: false,
      refusal: 'UNKNOWN_KEY_VERSION',
      detail:
        `No vault key in this deployment has version ${request.fromKeyVersion}, so nothing sealed ` +
        'under it can be opened or re-sealed. Those values must be re-entered.',
    };
  }
  if (!to) {
    return {
      ok: false,
      refusal: 'UNKNOWN_KEY_VERSION',
      detail: `No vault key in this deployment has version ${request.toKeyVersion}.`,
    };
  }
  if (from.state === 'COMPROMISED') {
    return {
      ok: false,
      refusal: 'KEY_COMPROMISED',
      detail:
        `Vault key version ${from.version} is COMPROMISED, so this sweep was REFUSED. Every ` +
        'ciphertext that key protected must be considered disclosed; re-sealing it under a new ' +
        'key changes who can read it from now on and nothing about who has read it already. Run ' +
        '`compromise --version ' +
        String(from.version) +
        '` for the list of values that need re-entering.',
    };
  }
  if (to.state !== 'ACTIVE') {
    return {
      ok: false,
      refusal: 'NO_WRITABLE_KEY',
      detail:
        `Vault key version ${to.version} is ${to.state} and a re-seal writes with the single ` +
        'ACTIVE key. Targeting a version that is not ACTIVE would record a sweep to a version ' +
        'the rows do not end up under.',
    };
  }
  return { ok: true, value: { from, to } };
}

/**
 * RE-SEAL ONE FIELD, resumably and idempotently.
 *
 * ── Resumable ──────────────────────────────────────────────────────────────
 *
 * The cursor advances per SUCCESSFUL ROW in memory and is persisted at the end
 * of every batch and again on failure, so a process killed mid-batch resumes
 * after the last row it actually wrote. An existing sweep in a
 * `RESUMABLE_ROTATION_STATES` state is picked up at its cursor and its counters
 * are added to; a COMPLETED one is not restarted.
 *
 * ── Idempotent ─────────────────────────────────────────────────────────────
 *
 * A row already at the target version is counted `skipped` and not re-sealed,
 * separately from `resealed`, so a resumed sweep's figures stay honest about
 * what IT did. Running the whole command twice therefore sweeps nothing the
 * second time and says so.
 *
 * ── `visited` COUNTS READS AND MAY EXCEED THE ROW COUNT ────────────────────
 *
 * On a resume, the row whose write failed is read again, so a sweep over four
 * rows that was interrupted on the third reports `visited` 5 and `resealed` 4.
 * That is deliberate and it is the honest reading: `visited` is what the sweep
 * DID, and making it a count of distinct rows instead would put two different
 * facts in one field. `resealed` is the number an operator acts on when they
 * decide whether the old key may be retired.
 *
 * ── Safe against a half-rotated database ───────────────────────────────────
 *
 * A row is written only after its new ciphertext has been opened again under
 * the key that sealed it (see `resealSecret`), and the write replaces the
 * ciphertext and the version column in one statement. So at every instant every
 * row is readable by exactly one key: the old one or the new one, never
 * neither. A partial run is a resumable state, not a corrupt one.
 *
 * ── It cannot reach COMPLETED with rows it could not open ──────────────────
 *
 * `unopenable` is the count that must never be swallowed: those rows stay under
 * the source key, so retiring that key destroys them. A sweep that ends with a
 * non-zero `unopenable` is FAILED, which is what stops the key being retired on
 * the strength of a rotation that did not finish.
 */
export async function sweepField(input: {
  readonly keyring: VaultKeyring;
  readonly fieldKey: SealedFieldKey;
  readonly fromKeyVersion: number;
  readonly toKeyVersion: number;
  readonly store: SealedFieldStore;
  readonly io: Pick<RotateIo, 'loadSweep' | 'saveSweep' | 'now' | 'log'>;
  /** False for a dry run: rows are opened and verified, nothing is written. */
  readonly apply: boolean;
  readonly batchSize?: number;
}): Promise<SweepOutcome> {
  const { keyring, fieldKey, fromKeyVersion, toKeyVersion, store, io, apply } = input;
  const take = input.batchSize ?? BATCH_SIZE;

  const allowed = canSweep(keyring, { fromKeyVersion, toKeyVersion });
  if (!allowed.ok) {
    const existing = await io.loadSweep({ fieldKey, fromKeyVersion, toKeyVersion });
    return {
      record:
        existing ??
        blankSweep({ fieldKey, fromKeyVersion, toKeyVersion }),
      applied: false,
      refusal: allowed,
    };
  }

  const existing = await io.loadSweep({ fieldKey, fromKeyVersion, toKeyVersion });
  if (existing !== null && !RESUMABLE_ROTATION_STATES.includes(existing.state)) {
    io.log(
      `  ${fieldKey}: an existing sweep ${fromKeyVersion} → ${toKeyVersion} is ${existing.state}; ` +
        'not restarted.',
    );
    return { record: existing, applied: false, refusal: null };
  }

  let visited = existing?.visited ?? 0;
  let resealed = existing?.resealed ?? 0;
  let unopenable = existing?.unopenable ?? 0;
  let skipped = existing?.skipped ?? 0;
  let cursor = existing?.cursor ?? null;
  let error: string | null = null;

  const startedAt = io.now();
  if (apply) {
    await io.saveSweep({
      fieldKey,
      fromKeyVersion,
      toKeyVersion,
      state: 'RUNNING',
      visited,
      resealed,
      unopenable,
      skipped,
      cursor,
      error: null,
    });
  }

  let page = await store.page({ version: fromKeyVersion, afterId: cursor, take });
  while (page.length > 0) {
    for (const row of page) {
      visited += 1;
      if (row.keyVersion === toKeyVersion) {
        // Already under the target. Counted separately from `resealed` so a
        // resumed sweep's figures stay honest about what IT did.
        skipped += 1;
        cursor = row.id;
        continue;
      }
      const outcome = resealRow({ keyring, fieldKey, row, fromKeyVersion });
      if (!outcome.ok) {
        /*
         * COUNTED AND NOT SWALLOWED. The row is left exactly as it was — still
         * readable by the source key — and the sweep cannot reach COMPLETED
         * while this count is non-zero, which is what stops the source key
         * being retired while this row still needs it.
         *
         * The message carries the refusal NAME, the row id, and whether the
         * remedy is a re-seal or a NEW VALUE from the customer — the last of
         * which comes from `VAULT_REFUSAL_REPORTS` rather than from a judgement
         * made here, so there is one answer to "what does an operator do about
         * this refusal" and not one per caller.
         *
         * Not the refusal's `detail`, because a detail is operator prose that a
         * future refusal could widen; and not the value, ever.
         */
        unopenable += 1;
        const report = VAULT_REFUSAL_REPORTS[outcome.refusal];
        error =
          `${outcome.refusal} on ${fieldKey} row ${row.id} — ` +
          (report.reEntryRequired ? 'needs a NEW value' : 'needs a re-seal');
        cursor = row.id;
        continue;
      }
      if (apply) {
        try {
          await store.write({
            id: row.id,
            stored: outcome.value.stored,
            keyVersion: outcome.value.keyVersion,
          });
        } catch (err) {
          /*
           * The write failed. The cursor is NOT advanced past this row, so a
           * resume re-reads it and tries again; the row still holds its old
           * ciphertext and is still readable by the source key. The sweep is
           * saved FAILED with its cursor, which is the difference between
           * resumable and restartable.
           *
           * `err` is not interpolated: a driver error can quote the statement,
           * and the statement carries the ciphertext.
           */
          error = `WRITE_FAILED on ${fieldKey} row ${row.id} (${errorName(err)})`;
          await io.saveSweep({
            fieldKey,
            fromKeyVersion,
            toKeyVersion,
            state: 'FAILED',
            visited,
            resealed,
            unopenable,
            skipped,
            cursor,
            error,
          });
          io.log(`  ${fieldKey}: sweep FAILED and is resumable. ${error}`);
          return {
            record: {
              fieldKey,
              fromKeyVersion,
              toKeyVersion,
              state: 'FAILED',
              visited,
              resealed,
              unopenable,
              skipped,
              cursor,
              error,
            },
            applied: true,
            refusal: null,
          };
        }
      }
      resealed += 1;
      cursor = row.id;
    }

    if (apply) {
      await io.saveSweep({
        fieldKey,
        fromKeyVersion,
        toKeyVersion,
        state: 'RUNNING',
        visited,
        resealed,
        unopenable,
        skipped,
        cursor,
        error,
      });
    }
    if (!apply) {
      /*
       * A dry run cannot advance through the table the way a real one does: it
       * writes nothing, so the same page comes back for ever. It reports the
       * first page's findings and the total count instead, which is what
       * "report the counts" means for a tool that must not touch the rows.
       */
      break;
    }
    page = await store.page({ version: fromKeyVersion, afterId: cursor, take });
  }

  const state: KeyRotationState = unopenable > 0 ? 'FAILED' : 'COMPLETED';
  const record: SweepRecord = {
    fieldKey,
    fromKeyVersion,
    toKeyVersion,
    state,
    visited,
    resealed,
    unopenable,
    skipped,
    cursor,
    error:
      unopenable > 0
        ? error ??
          `${unopenable} row(s) could not be opened, so this sweep is not complete and version ` +
            `${fromKeyVersion} must not be retired.`
        : null,
  };
  if (apply) await io.saveSweep(record);
  io.log(
    `  ${fieldKey}: ${state} — visited ${visited}, re-sealed ${resealed}, unopenable ` +
      `${unopenable}, skipped ${skipped}` +
      (apply ? '' : ' (DRY RUN; nothing was written)') +
      ` in ${Math.max(0, io.now().getTime() - startedAt.getTime())}ms`,
  );
  return { record, applied: apply, refusal: null };
}

function blankSweep(input: {
  fieldKey: SealedFieldKey;
  fromKeyVersion: number;
  toKeyVersion: number;
}): SweepRecord {
  return {
    fieldKey: input.fieldKey,
    fromKeyVersion: input.fromKeyVersion,
    toKeyVersion: input.toKeyVersion,
    state: 'PENDING',
    visited: 0,
    resealed: 0,
    unopenable: 0,
    skipped: 0,
    cursor: null,
    error: null,
  };
}

/**
 * The error's CONSTRUCTOR NAME and nothing else.
 *
 * A driver error's `message` can quote the failing statement, and the failing
 * statement carries the ciphertext this script exists to protect. So the only
 * thing taken from a caught value is its class name, which is a label.
 */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

/** Re-seal one row, picking the format from the compiler-enforced table. */
function resealRow(input: {
  readonly keyring: VaultKeyring;
  readonly fieldKey: SealedFieldKey;
  readonly row: SealedRow;
  readonly fromKeyVersion: number;
}): VaultResult<{ readonly stored: string; readonly keyVersion: number }> {
  const { keyring, fieldKey, row, fromKeyVersion } = input;
  const rule = SEALED_FIELD_FORMATS[fieldKey];

  if (rule.format === 'ENVELOPE') {
    const resealed = resealEnvelope(keyring, row.stored, { fieldKey, rowId: row.id }, row.keyVersion);
    if (!resealed.ok) return resealed;
    return { ok: true, value: { stored: resealed.value.stored, keyVersion: resealed.value.keyVersion } };
  }

  if (row.orgId === null || row.name === null) {
    /*
     * The legacy binding is `${orgId}:${name}`, so a row missing either cannot
     * be opened. Refused rather than opened with an empty part: an empty orgId
     * composes a binding that is wrong in a way GCM reports as a plain cipher
     * failure, and the operator would read "wrong key" for a projection bug.
     */
    return {
      ok: false,
      refusal: 'AAD_MISMATCH',
      detail:
        `${fieldKey} row ${row.id} is missing the org or the name that its binding is composed ` +
        'from, so it was NOT opened. The store returned an incomplete projection.',
    };
  }
  const resealed = resealSecret(keyring, row.stored, fromKeyVersion, row.orgId, row.name);
  if (!resealed.ok) return resealed;
  return {
    ok: true,
    value: { stored: resealed.value.ciphertext, keyVersion: resealed.value.keyVersion },
  };
}

// ─── Compromise response ────────────────────────────────────────────────────

/** One value that must be re-entered. A row id and a field name; never a value. */
export interface ReEntryRow {
  readonly fieldKey: SealedFieldKey;
  readonly rowId: string;
  readonly keyVersion: number;
  readonly why: string;
}

/**
 * EVERY VALUE A GIVEN KEY SEALED, AS A RE-ENTRY WORKLIST.
 *
 * ── Why this is a list and not a sweep ─────────────────────────────────────
 *
 * A COMPROMISED key means the ciphertext it protected must be considered
 * DISCLOSED. Whoever holds the key holds the plaintext, and that is already
 * true before anyone notices. Re-sealing those values under a new key is
 * SECURITY THEATRE: it changes who can read them from this moment on and
 * nothing whatever about who has read them already, while producing a green
 * sweep row that an operator would reasonably read as "handled".
 *
 * So the deliverable for a compromise is the blast radius in a form somebody
 * can act on — which field, which row, which version — and the action is the
 * customer entering a new value. {@link canSweep} refuses to sweep a
 * COMPROMISED source key and points here.
 *
 * `rowId` is a cuid and `fieldKey` is a column name. Neither is a secret, and
 * there is nothing else in this structure.
 */
export function reEntryWorklist(
  keyring: VaultKeyring,
  rows: readonly { readonly fieldKey: SealedFieldKey; readonly rowId: string; readonly keyVersion: number }[],
): readonly ReEntryRow[] {
  const out: ReEntryRow[] = [];
  for (const row of rows) {
    const verdict = resealVerdictFor(keyring, row.keyVersion);
    if (!verdict.reEntryRequired) continue;
    out.push({
      fieldKey: row.fieldKey,
      rowId: row.rowId,
      keyVersion: row.keyVersion,
      why: verdict.why,
    });
  }
  return out;
}

// ─── The command line ───────────────────────────────────────────────────────

export const ROTATE_COMMANDS = ['plan', 'sweep', 'compromise'] as const;
export type RotateCommand = (typeof ROTATE_COMMANDS)[number];

export interface ParsedArgs {
  readonly command: RotateCommand;
  readonly fieldKey: SealedFieldKey | null;
  readonly fromKeyVersion: number | null;
  readonly toKeyVersion: number | null;
  readonly version: number | null;
  /** The database the operator named. Null means dry run. */
  readonly confirm: string | null;
}

/**
 * Parse the command line, refusing anything it does not understand.
 *
 * REFUSES AN UNKNOWN FLAG rather than ignoring it. A tool that silently drops
 * `--confrim` is a tool that performs a dry run while the operator believes it
 * applied, or — far worse in a different arrangement — the reverse.
 *
 * There is no `--force`, and `--confirm` takes a VALUE. A bare `--confirm`
 * would be one keystroke away from a live rotation against whichever database
 * the shell happened to be pointing at.
 */
export function parseArgs(argv: readonly string[]): VaultResult<ParsedArgs> {
  const [commandRaw, ...rest] = argv;
  const command = commandRaw ?? 'plan';
  if (!(ROTATE_COMMANDS as readonly string[]).includes(command)) {
    return {
      ok: false,
      refusal: 'NOT_A_SEALED_FIELD',
      detail: `Unknown command "${command}". One of: ${ROTATE_COMMANDS.join(', ')}.`,
    };
  }

  let fieldKey: SealedFieldKey | null = null;
  let fromKeyVersion: number | null = null;
  let toKeyVersion: number | null = null;
  let version: number | null = null;
  let confirm: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--field') {
      if (value === undefined || !isSealedFieldKey(value)) {
        return {
          ok: false,
          refusal: 'NOT_A_SEALED_FIELD',
          detail: `--field takes one of: ${SEALED_FIELD_KEYS.join(', ')}.`,
        };
      }
      fieldKey = value;
      index += 1;
      continue;
    }
    if (flag === '--from' || flag === '--to' || flag === '--version') {
      const parsed = value === undefined ? null : positiveInteger(value);
      if (parsed === null) {
        return {
          ok: false,
          refusal: 'UNKNOWN_KEY_VERSION',
          detail: `${flag} takes a positive integer key version.`,
        };
      }
      if (flag === '--from') fromKeyVersion = parsed;
      else if (flag === '--to') toKeyVersion = parsed;
      else version = parsed;
      index += 1;
      continue;
    }
    if (flag === '--confirm') {
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          refusal: 'MATERIAL_UNAVAILABLE',
          detail:
            '--confirm takes the database this is about to write to, as host:port/name. Run the ' +
            'plan command first; it prints the identity to use.',
        };
      }
      confirm = value;
      index += 1;
      continue;
    }
    return {
      ok: false,
      refusal: 'NOT_A_SEALED_FIELD',
      detail: `Unknown flag "${String(flag)}". This tool has no --force and ignores nothing.`,
    };
  }

  return {
    ok: true,
    value: {
      command: command as RotateCommand,
      fieldKey,
      fromKeyVersion,
      toKeyVersion,
      version,
      confirm,
    },
  };
}

/**
 * A positive integer, with no lenient parse.
 *
 * Not `Number.parseInt`, which reads `1x` as 1 — and a key version is the one
 * field where a lenient parse selects a different key and still succeeds.
 */
function positiveInteger(raw: string): number | null {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The database identity from a connection URL, WITHOUT its credentials.
 *
 * `host:port/name`. The password is never read and the user is not included: an
 * operator pastes this value into `--confirm` and it goes into their shell
 * history, so it may contain nothing that is a credential.
 *
 * Returns null for an absent or unparseable URL, which this script treats as a
 * refusal — see {@link RotateIo.databaseIdentity}.
 */
export function databaseIdentityFrom(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.length === 0) return null;
  const name = parsed.pathname.replace(/^\//, '');
  if (name.length === 0) return null;
  const port = parsed.port.length > 0 ? parsed.port : '5432';
  return `${parsed.hostname}:${port}/${name}`;
}

// ─── The entry point ────────────────────────────────────────────────────────

/**
 * Exit codes. Named, because a script that exits 1 for both "you typed the
 * flag wrong" and "the rotation left rows under the old key" cannot be used in
 * a runbook.
 */
export const EXIT = {
  ok: 0,
  usage: 2,
  refused: 3,
  incomplete: 4,
} as const;

/**
 * RUN THE TOOL.
 *
 * Takes its whole world as `io`, so `rotate-vault-key.test.ts` drives every
 * path — including the interrupted sweep and the refusal to run against an
 * unidentifiable database — with no database, no key and no clock.
 */
export async function main(argv: readonly string[], io: RotateIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    /*
     * ANY thrown IO failure becomes a named refusal, and ONLY the error's class
     * name is printed.
     *
     * Not its message, and this is not caution for its own sake: a Prisma error
     * quotes the invocation that failed, and the invocation that failed may be
     * the UPDATE carrying a ciphertext. Letting one escape as an unhandled
     * rejection printed exactly that — several frames of it — the first time
     * this script was pointed at a database whose migration was unapplied.
     *
     * The arm RETURNS A REFUSAL CODE and never falls through to success: an
     * exception handler that ends in "carry on" is the defect pattern this
     * whole round is arranged against, and here it would mean reporting a
     * rotation that did not happen.
     */
    io.log(
      `REFUSED: the database refused a query (${errorName(err)}). Nothing further was attempted. ` +
        'The error text is deliberately not printed: a driver error quotes the statement, and the ' +
        'statement carries the sealed value.',
    );
    return EXIT.refused;
  }
}

async function run(argv: readonly string[], io: RotateIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.log(`REFUSED (${args.refusal}): ${args.detail}`);
    return EXIT.usage;
  }

  const identity = io.databaseIdentity();
  if (identity === null) {
    /*
     * SAFETY MEASURE 2. A tool that will rewrite every sealed value in a
     * database must be able to say which database. "The one in the
     * environment" is not an answer an operator can check, and this repository
     * has already lost live data to a script that did not make anyone name the
     * target.
     */
    io.log(
      'REFUSED: this tool cannot identify the database it would write to. DATABASE_URL is absent ' +
        'or not a URL it can read. Nothing was done.',
    );
    return EXIT.refused;
  }

  const keyringResult = await loadVaultKeyring(
    { listVaultKeys: () => io.listVaultKeys() },
    { storedModes: await io.storedModes() },
  );
  if (!keyringResult.ok) {
    io.log(`REFUSED (${keyringResult.refusal}): ${keyringResult.detail}`);
    return EXIT.refused;
  }
  const keyring = keyringResult.value;
  installVaultKeyring(keyring);
  resetVaultTallies();

  const apply = args.value.confirm !== null;
  if (apply && args.value.confirm !== identity) {
    io.log(
      `REFUSED: --confirm named "${args.value.confirm}" and this process is connected to ` +
        `"${identity}". Nothing was done.`,
    );
    return EXIT.refused;
  }

  io.log(`database        ${identity}`);
  io.log(`keyring         ${keyring.source}, VAULT_KEY_ROTATION mode ${keyring.mode}`);
  io.log(
    `                default mode is ${
      keyring.source === 'IMPLICIT'
        ? 'ENFORCE; nothing is registered, so version 1 is this deployment’s master key'
        : 'ENFORCE'
    }`,
  );
  for (const key of [...keyring.keys].sort((a, b) => a.version - b.version)) {
    io.log(
      `  key v${key.version}  ${key.state.padEnd(11)} ${key.provider.padEnd(5)} id=${key.keyId}` +
        (key.providerRef === null ? '' : ' ref=<set>'),
    );
  }
  io.log(apply ? 'mode            APPLY (rows will be written)' : 'mode            DRY RUN');

  if (args.value.command === 'plan') return await plan(keyring, io);
  if (args.value.command === 'compromise') {
    return await compromise(keyring, io, args.value, apply);
  }
  return await sweep(keyring, io, args.value, apply);
}

/** Read-only. What every field needs, and what a sweep would visit. */
async function plan(keyring: VaultKeyring, io: RotateIo): Promise<number> {
  const stores = io.stores();
  io.log('plan            (read only)');
  for (const fieldKey of SEALED_FIELD_KEYS) {
    const rule = SEALED_FIELD_RULES[fieldKey];
    const store = stores[fieldKey];
    io.log(`  ${fieldKey}  [${SEALED_FIELD_FORMATS[fieldKey].format}, ${rule.scope}]`);
    for (const key of [...keyring.keys].sort((a, b) => a.version - b.version)) {
      const count = await store.countAtVersion(key.version);
      /*
       * `needsRotation` finally has a caller, and this is it. It used to
       * compare a stored version against a module constant and answer FALSE for
       * a version from a newer build; it now asks the deployment's own keys.
       */
      const verdict = resealVerdictFor(keyring, key.version);
      const flag = needsRotation(key.version)
        ? verdict.reEntryRequired
          ? 'NEEDS RE-ENTRY'
          : verdict.urgent
            ? 'NEEDS RE-SEAL (urgent)'
            : 'needs re-seal'
        : 'current';
      io.log(`    v${key.version}: ${count} row(s) — ${flag}. ${verdict.why}`);
    }
  }
  return EXIT.ok;
}

/** The re-entry worklist for one key, and — with --confirm — the state change. */
async function compromise(
  keyring: VaultKeyring,
  io: RotateIo,
  args: ParsedArgs,
  apply: boolean,
): Promise<number> {
  if (args.version === null) {
    io.log('REFUSED: compromise needs --version <n>.');
    return EXIT.usage;
  }
  const key = keyring.keys.find((candidate) => candidate.version === args.version);
  if (!key) {
    io.log(`REFUSED: no vault key in this deployment has version ${args.version}.`);
    return EXIT.refused;
  }

  io.log(`compromise      key v${key.version} (${key.state} → COMPROMISED)`);
  io.log(
    '                A COMPROMISED key opens nothing, and every value it sealed must be ' +
      'considered DISCLOSED. Those values are listed for RE-ENTRY and are deliberately NOT ' +
      're-sealed: re-encrypting a ciphertext whose key has leaked changes who can read it from ' +
      'now on and nothing about who has read it already.',
  );

  const stores = io.stores();
  const affected: { fieldKey: SealedFieldKey; rowId: string; keyVersion: number }[] = [];
  for (const fieldKey of SEALED_FIELD_KEYS) {
    const store = stores[fieldKey];
    let cursor: string | null = null;
    for (;;) {
      const page = await store.page({ version: key.version, afterId: cursor, take: BATCH_SIZE });
      if (page.length === 0) break;
      for (const row of page) {
        affected.push({ fieldKey, rowId: row.id, keyVersion: key.version });
        cursor = row.id;
      }
      if (page.length < BATCH_SIZE) break;
    }
  }

  /*
   * The worklist is computed against a keyring in which the key IS compromised,
   * so `reEntryRequired` is true for exactly these rows. Computing it against
   * the pre-transition keyring would list nothing, which is the shape of bug
   * that makes an incident tool report an empty blast radius.
   */
  const asCompromised: VaultKeyring = {
    ...keyring,
    keys: keyring.keys.map((candidate) =>
      candidate.version === key.version ? { ...candidate, state: 'COMPROMISED' as const } : candidate,
    ),
  };
  const worklist = reEntryWorklist(asCompromised, affected);

  io.log(`                ${worklist.length} value(s) need re-entering:`);
  io.log(`                ${VAULT_REFUSAL_REPORTS.KEY_COMPROMISED.why}`);
  for (const item of worklist) {
    io.log(`  ${item.fieldKey}  row ${item.rowId}  (sealed under v${item.keyVersion})`);
  }

  if (!apply) {
    io.log('                DRY RUN; the key state was NOT changed.');
    return EXIT.ok;
  }
  await io.markKeyCompromised({ version: key.version, at: io.now() });
  io.log(`                key v${key.version} is now COMPROMISED and opens nothing.`);
  return EXIT.ok;
}

/** One field's sweep, or every field when --field is omitted. */
async function sweep(
  keyring: VaultKeyring,
  io: RotateIo,
  args: ParsedArgs,
  apply: boolean,
): Promise<number> {
  if (args.fromKeyVersion === null || args.toKeyVersion === null) {
    io.log('REFUSED: sweep needs --from <n> and --to <n>. Neither is inferred.');
    return EXIT.usage;
  }
  const fields = args.fieldKey === null ? SEALED_FIELD_KEYS : [args.fieldKey];
  const stores = io.stores();

  io.log(
    `sweep           ${args.fromKeyVersion} → ${args.toKeyVersion} over ${fields.length} field(s)`,
  );
  for (const fieldKey of fields) {
    const store = stores[fieldKey];
    const total = await store.countAtVersion(args.fromKeyVersion);
    io.log(`  ${fieldKey}: ${total} row(s) sealed under v${args.fromKeyVersion}`);
  }

  let worst: number = EXIT.ok;
  for (const fieldKey of fields) {
    const outcome = await sweepField({
      keyring,
      fieldKey,
      fromKeyVersion: args.fromKeyVersion,
      toKeyVersion: args.toKeyVersion,
      store: stores[fieldKey],
      io,
      apply,
    });
    if (outcome.refusal !== null) {
      io.log(`  ${fieldKey}: REFUSED (${outcome.refusal.refusal}) ${outcome.refusal.detail}`);
      worst = Math.max(worst, EXIT.refused);
      continue;
    }
    if (outcome.record.unopenable > 0) {
      io.log(
        `  ${fieldKey}: ${outcome.record.unopenable} row(s) could not be opened, so this sweep is ` +
          `NOT complete and key v${args.fromKeyVersion} MUST NOT be retired.`,
      );
      worst = Math.max(worst, EXIT.incomplete);
    }
    /*
     * ── ANY STATE THAT IS NOT COMPLETED IS A NON-ZERO EXIT ──────────────────
     *
     * THE DEFECT THIS CLOSES, measured: a sweep interrupted by a failed write
     * returns early from `sweepField` with `state: 'FAILED'`, `refusal: null`
     * and `unopenable: 0` — so neither arm above fired and `worst` stayed
     * `EXIT.ok`. The tool logged "sweep FAILED and is resumable", left rows
     * under the SOURCE key, and exited 0.
     *
     * Exit 0 is the one thing a runbook reads. The documented sequence is
     * `plan`, then `sweep`, then `compromise --version <from>` — so a runbook
     * or CI step gated on `$?` would mark the source key COMPROMISED while
     * rows were still sealed under it, and a COMPROMISED key opens nothing.
     * That turns a RESUMABLE sweep into rows readable by NO KEY, which is
     * exactly the outcome safety measure 6 in this file's header exists to
     * prevent — reached through the exit code instead of through the writes.
     *
     * Checked on `state` rather than on `error`, because `state` is the field
     * the sweep row itself is read by, and a future state (`RUNNING` left
     * behind by a killed process) must not be a success either. COMPLETED is
     * the only success, named positively so a new state is non-zero by
     * default.
     */
    if (outcome.record.state !== 'COMPLETED') {
      io.log(
        `  ${fieldKey}: sweep state is ${outcome.record.state} and NOT COMPLETED, so key ` +
          `v${args.fromKeyVersion} MUST NOT be retired or marked compromised yet. Re-run this ` +
          'command to resume from the saved cursor.',
      );
      worst = Math.max(worst, EXIT.incomplete);
    }

    /*
     * ── COMPLETED IS A CLAIM, AND THIS IS THE ONE FACT THAT CHECKS IT ───────
     *
     * THE DEFECT THIS CLOSES, measured twice on this tree:
     *
     *   1. A sweep row for this (field, from, to) that is already COMPLETED is
     *      "not restarted" — `sweepField` returns the stored record untouched,
     *      `unopenable` 0 and `state` COMPLETED, so neither arm above fired.
     *      Re-running `sweep --from 1 --to 2` after the API has written new
     *      secrets under v1 therefore exited 0 with two rows still at v1.
     *   2. A RESUMABLE row whose `cursor` is past every remaining id reads one
     *      empty page, visits nothing, and reaches COMPLETED the same way. The
     *      line two above printed `3 row(s) sealed under v1` and the line below
     *      it printed `COMPLETED — visited 0`, and the tool exited 0.
     *
     * Exit 0 is the one thing a runbook reads, and the documented sequence is
     * `plan`, then `sweep`, then `compromise --version <from>`. So both shapes
     * marked the source key COMPROMISED while rows were still sealed under it,
     * and a COMPROMISED key opens nothing — rows readable by NO KEY, which is
     * what safety measure 6 in this file's header exists to prevent, reached
     * through the exit code rather than through the writes. That is the same
     * shape as the FAILED-write defect recorded above, in the one arm where
     * COMPLETED is not evidence of anything.
     *
     * The denominator is RE-READ rather than compared against the `total`
     * printed above, because a sweep that really did its work changes it, and
     * the question here is what is left NOW.
     *
     * ── WHAT THIS COUNT CANNOT SEE, stated so it is not read as a guarantee ─
     *
     * `countAtVersion` filters on the row's integer key-version column, so a
     * row whose column is NULL beside a non-null sealed value is counted under
     * NO version — not here, not by `page`, and not by `plan`. Those rows are
     * invisible to the whole tool and this check does not change that. It
     * answers exactly one question: are there rows the store CAN see at the
     * source version after a sweep that reported success.
     *
     * Only when `apply` is true: a dry run writes nothing, so rows remaining at
     * the source version is its correct result and not a failure.
     */
    if (apply) {
      const remaining = await stores[fieldKey].countAtVersion(args.fromKeyVersion);
      if (remaining > 0 && outcome.record.state === 'COMPLETED') {
        io.log(
          `  ${fieldKey}: this sweep reported COMPLETED and ${remaining} row(s) are STILL sealed ` +
            `under v${args.fromKeyVersion}. The sweep row records ${outcome.record.visited} ` +
            'visit(s), which may be from an earlier run and not from this one. Key ' +
            `v${args.fromKeyVersion} MUST NOT be retired or marked compromised. A sweep row for ` +
            'this pair that is already COMPLETED is not restarted, and a saved cursor past the ' +
            'last remaining id reads one empty page; either way COMPLETED is a claim about a ' +
            'previous run and not about these rows.',
        );
        worst = Math.max(worst, EXIT.incomplete);
      }
    }
  }

  const counted = wouldHaveRefusedVault(vaultTallies());
  io.log(
    `counted         ${counted.total} vault decision(s): ${counted.allowed} allowed, ` +
      `${counted.refused} refused, ${counted.wouldRefuse} would have been refused under ENFORCE`,
  );
  return worst;
}

// ─── The production adapter ─────────────────────────────────────────────────

/**
 * THE REAL IO: Prisma, the three sealed fields, and `DATABASE_URL`.
 *
 * ── Every read names every column it needs ─────────────────────────────────
 *
 * The three `select` clauses below are the reason {@link SealedRow} requires
 * all five of its fields. A projection that dropped `keyVersion` would make
 * every row look like it needed sweeping; one that dropped `orgId` would make
 * the legacy binding wrong and report a projection bug as `CIPHER_REJECTED`.
 * `rotate-vault-key.test.ts` drives these paths through a fake that HONOURS
 * `select`, because a select-blind fake makes deleting a field from a query
 * undetectable.
 *
 * ── Unscoped, deliberately ─────────────────────────────────────────────────
 *
 * `VaultKey` and `KeyRotationSweep` are global tables and this tool runs
 * outside any request, so there is no tenant to scope by; `Secret` and
 * `AuthProfile` are tenanted and a rotation must cross every tenant, which is
 * precisely what a per-request scope exists to prevent. So every query goes
 * through `unscoped`, which is the documented escape, and the rotation is the
 * one job that legitimately needs it.
 *
 * ── `orderBy: { id: 'asc' }` is load-bearing ───────────────────────────────
 *
 * The cursor is a row id, so a page with no stable order would skip rows and
 * repeat others, and a sweep would report COMPLETED over a table it had not
 * finished. It is in all three `page` queries and the test asserts the cursor
 * is respected rather than assuming it.
 */
export function prismaRotateIo(deps: {
  readonly prisma: PrismaForRotation;
  readonly unscoped: <T>(fn: () => T | Promise<T>) => Promise<T>;
  readonly databaseUrl: string | undefined;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}): RotateIo {
  const { prisma, unscoped: run } = deps;
  const log = deps.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = deps.now ?? ((): Date => new Date());

  const stores: Record<SealedFieldKey, SealedFieldStore> = {
    'Secret.valueEnc': {
      fieldKey: 'Secret.valueEnc',
      countAtVersion: (version) => run(() => prisma.secret.count({ where: { keyVersion: version } })),
      page: async ({ version, afterId, take }) => {
        const rows = await run(() =>
          prisma.secret.findMany({
            where: { keyVersion: version, ...(afterId === null ? {} : { id: { gt: afterId } }) },
            select: { id: true, orgId: true, name: true, valueEnc: true, keyVersion: true },
            orderBy: { id: 'asc' },
            take,
          }),
        );
        return rows.map((row) => ({
          id: row.id,
          orgId: row.orgId,
          name: row.name,
          stored: row.valueEnc,
          keyVersion: row.keyVersion,
        }));
      },
      write: async ({ id, stored, keyVersion }) => {
        await run(() =>
          prisma.secret.update({ where: { id }, data: { valueEnc: stored, keyVersion } }),
        );
      },
    },
    'User.totpSecretEnc': {
      fieldKey: 'User.totpSecretEnc',
      countAtVersion: (version) =>
        run(() => prisma.user.count({ where: { totpSecretKeyVersion: version } })),
      page: async ({ version, afterId, take }) => {
        const rows = await run(() =>
          prisma.user.findMany({
            where: {
              totpSecretKeyVersion: version,
              totpSecretEnc: { not: null },
              ...(afterId === null ? {} : { id: { gt: afterId } }),
            },
            select: { id: true, totpSecretEnc: true, totpSecretKeyVersion: true },
            orderBy: { id: 'asc' },
            take,
          }),
        );
        return rows
          .filter((row): row is typeof row & { totpSecretEnc: string } => row.totpSecretEnc !== null)
          .map((row) => ({
            id: row.id,
            // GLOBAL: a User has no orgId, which is why this field is ENVELOPE —
            // the legacy binding has no tenant to compose from.
            orgId: null,
            name: null,
            stored: row.totpSecretEnc,
            keyVersion: row.totpSecretKeyVersion,
          }));
      },
      write: async ({ id, stored, keyVersion }) => {
        await run(() =>
          prisma.user.update({
            where: { id },
            data: { totpSecretEnc: stored, totpSecretKeyVersion: keyVersion },
          }),
        );
      },
    },
    'AuthProfile.storageState': {
      fieldKey: 'AuthProfile.storageState',
      countAtVersion: (version) =>
        run(() => prisma.authProfile.count({ where: { storageStateKeyVersion: version } })),
      page: async ({ version, afterId, take }) => {
        const rows = await run(() =>
          prisma.authProfile.findMany({
            where: {
              storageStateKeyVersion: version,
              storageStateSealed: { not: null },
              ...(afterId === null ? {} : { id: { gt: afterId } }),
            },
            select: {
              id: true,
              orgId: true,
              storageStateSealed: true,
              storageStateKeyVersion: true,
            },
            orderBy: { id: 'asc' },
            take,
          }),
        );
        return rows
          .filter(
            (row): row is typeof row & { storageStateSealed: string } =>
              row.storageStateSealed !== null,
          )
          .map((row) => ({
            id: row.id,
            orgId: row.orgId,
            name: null,
            stored: row.storageStateSealed,
            keyVersion: row.storageStateKeyVersion,
          }));
      },
      write: async ({ id, stored, keyVersion }) => {
        await run(() =>
          prisma.authProfile.update({
            where: { id },
            data: {
              storageStateSealed: stored,
              storageStateKeyVersion: keyVersion,
              storageStateSealedAt: now(),
              // The row has been re-sealed under a key this deployment holds, so
              // the re-seal flag is cleared in the SAME statement. Clearing it in
              // a second write would leave a window in which the row is sealed
              // and still marked as needing it, and a later sweep would re-do it.
              storageStateNeedsReseal: false,
            },
          }),
        );
      },
    },
  };

  return {
    databaseIdentity: () => databaseIdentityFrom(deps.databaseUrl),
    listVaultKeys: async () => {
      const rows = await run(() =>
        prisma.vaultKey.findMany({
          select: { keyId: true, version: true, state: true, provider: true, providerRef: true },
          orderBy: { version: 'asc' },
        }),
      );
      return rows;
    },
    // A GLOBAL control on a GLOBAL table: there is no org whose stored modes
    // would be the right ones to read, so the brake table's own default
    // (ENFORCE) applies. `controlMode` resolves undefined to exactly that.
    storedModes: async () => undefined,
    stores: () => stores,
    loadSweep: async ({ fieldKey, fromKeyVersion, toKeyVersion }) => {
      const row = await run(() =>
        prisma.keyRotationSweep.findUnique({
          where: { fieldKey_fromKeyVersion_toKeyVersion: { fieldKey, fromKeyVersion, toKeyVersion } },
          select: {
            fieldKey: true,
            fromKeyVersion: true,
            toKeyVersion: true,
            state: true,
            visited: true,
            resealed: true,
            unopenable: true,
            skipped: true,
            cursor: true,
            error: true,
          },
        }),
      );
      if (row === null) return null;
      if (!isSealedFieldKey(row.fieldKey)) {
        /*
         * The column is TEXT with the domain at the producer, so a row written
         * by a build that knew a fourth sealed field is possible. Refused by
         * returning null — which starts a fresh sweep rather than resuming one
         * whose field this build cannot address.
         */
        return null;
      }
      return { ...row, fieldKey: row.fieldKey, state: row.state as KeyRotationState };
    },
    saveSweep: async (record) => {
      await run(() =>
        prisma.keyRotationSweep.upsert({
          where: {
            fieldKey_fromKeyVersion_toKeyVersion: {
              fieldKey: record.fieldKey,
              fromKeyVersion: record.fromKeyVersion,
              toKeyVersion: record.toKeyVersion,
            },
          },
          create: {
            fieldKey: record.fieldKey,
            fromKeyVersion: record.fromKeyVersion,
            toKeyVersion: record.toKeyVersion,
            state: record.state,
            visited: record.visited,
            resealed: record.resealed,
            unopenable: record.unopenable,
            skipped: record.skipped,
            cursor: record.cursor,
            error: record.error,
            startedAt: now(),
            finishedAt: TERMINAL_ROTATION_STATES.includes(record.state) ? now() : null,
          },
          update: {
            state: record.state,
            visited: record.visited,
            resealed: record.resealed,
            unopenable: record.unopenable,
            skipped: record.skipped,
            cursor: record.cursor,
            error: record.error,
            finishedAt: TERMINAL_ROTATION_STATES.includes(record.state) ? now() : null,
          },
        }),
      );
    },
    markKeyCompromised: async ({ version, at }) => {
      await run(() =>
        prisma.vaultKey.update({
          where: { version },
          // Both columns together. The pair (state COMPROMISED, compromisedAt
          // null) can only arise from a bug in this path, and the schema says so
          // above the column; writing one without the other would be that bug.
          data: { state: 'COMPROMISED', compromisedAt: at },
        }),
      );
    },
    now,
    log,
  };
}

/**
 * The states a sweep does not come back from.
 *
 * DERIVED as the complement of `RESUMABLE_ROTATION_STATES`, and this comment
 * says it is derived rather than implying it guards anything: the thing that
 * must not drift is the resumable list, which is in sealed.ts beside the enum,
 * and a sixth state appears here automatically.
 */
export const TERMINAL_ROTATION_STATES: readonly KeyRotationState[] = KEY_ROTATION_STATES.filter(
  (state) => !RESUMABLE_ROTATION_STATES.includes(state),
);

/**
 * The slice of the Prisma client this tool uses.
 *
 * A structural type and not `PrismaClient`, so the test's fake satisfies the
 * compiler and a `select` it ignores is a type error rather than a silent
 * difference between the fake and the real query.
 */
export interface PrismaForRotation {
  readonly vaultKey: {
    findMany(args: {
      select: Record<string, true>;
      orderBy: { version: 'asc' };
    }): Promise<VaultKeyRow[]>;
    update(args: { where: { version: number }; data: Record<string, unknown> }): Promise<unknown>;
  };
  readonly keyRotationSweep: {
    findUnique(args: {
      where: { fieldKey_fromKeyVersion_toKeyVersion: Record<string, unknown> };
      select: Record<string, true>;
    }): Promise<(Omit<SweepRecord, 'fieldKey' | 'state'> & { fieldKey: string; state: string }) | null>;
    upsert(args: {
      where: { fieldKey_fromKeyVersion_toKeyVersion: Record<string, unknown> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  readonly secret: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
      orderBy: { id: 'asc' };
      take: number;
    }): Promise<{ id: string; orgId: string; name: string; valueEnc: string; keyVersion: number }[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  readonly user: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
      orderBy: { id: 'asc' };
      take: number;
    }): Promise<{ id: string; totpSecretEnc: string | null; totpSecretKeyVersion: number | null }[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  readonly authProfile: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
      orderBy: { id: 'asc' };
      take: number;
    }): Promise<
      {
        id: string;
        orgId: string;
        storageStateSealed: string | null;
        storageStateKeyVersion: number | null;
      }[]
    >;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

/*
 * Run only when invoked directly, so the test file can import `main` without
 * the module connecting to anything.
 */
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { prisma, unscoped } = await import('../lib/prisma.js');
  const { env } = await import('../env.js');
  process.exitCode = await main(
    process.argv.slice(2),
    prismaRotateIo({
      prisma: prisma as unknown as PrismaForRotation,
      unscoped,
      databaseUrl: env.DATABASE_URL,
    }),
  );
  // Prisma holds the pool open, so an operator's shell would otherwise hang on
  // a tool that has finished and printed its plan.
  await prisma.$disconnect();
}
