import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BATCH_SIZE,
  EXIT,
  SEALED_FIELD_FORMATS,
  TERMINAL_ROTATION_STATES,
  canSweep,
  databaseIdentityFrom,
  main,
  parseArgs,
  prismaRotateIo,
  reEntryWorklist,
  sweepField,
} from './rotate-vault-key.js';
import type {
  PrismaForRotation,
  RotateIo,
  SealedFieldStore,
  SealedRow,
  SweepRecord,
} from './rotate-vault-key.js';
import {
  openWithKeyring,
  resetVaultKeyring,
  resetVaultTallies,
  sealWithKeyring,
} from '../lib/vault.js';
import type { VaultKeyRow, VaultKeyring } from '../lib/vault.js';
import { configureKeyProvider } from '../lib/kms.js';
import type { KeyProviderIo } from '../lib/kms.js';
import {
  KEY_ROTATION_STATES,
  RESUMABLE_ROTATION_STATES,
  SEALED_FIELD_KEYS,
} from '../../../../packages/shared/src/sealed.js';
import type { SealedFieldKey, VaultKeyState } from '../../../../packages/shared/src/sealed.js';

/** No key-shaped literal: the material is generated at run time. */
const MASTER = randomBytes(32).toString('base64');
const keyIo: KeyProviderIo = { localMasterKeyBase64: () => MASTER };
const ORG = 'org_fixture';
const DB = 'db.internal:5432/qaai';

afterEach(() => {
  resetVaultKeyring();
  resetVaultTallies();
});

function keyring(
  pairs: readonly [number, VaultKeyState][],
  mode: 'OBSERVE' | 'ENFORCE' = 'ENFORCE',
): VaultKeyring {
  const configured = configureKeyProvider('LOCAL', keyIo);
  if (!configured.ok) throw new Error('fixture');
  return {
    source: 'REGISTERED',
    mode,
    keys: pairs.map(([version, state]) => ({
      keyId: `k${version}`,
      version,
      state,
      provider: 'LOCAL' as const,
      providerRef: null,
    })),
    providers: new Map([['LOCAL', configured]]),
  };
}

/**
 * A keyring on THIS DEPLOYMENT'S OWN master key, for the tests that go through
 * {@link main}.
 *
 * `keyring()` above builds on a random `MASTER`, which is right for every test
 * that passes the keyring in itself. But `main` loads its own keyring through
 * `loadVaultKeyring`, which configures LOCAL with `DEFAULT_KEY_PROVIDER_IO` —
 * the real `VAULT_MASTER_KEY`. Fixtures sealed under the random key are
 * therefore `unopenable` to `main`, which silently turns "the sweep was
 * interrupted" into "no row could be opened" and makes an exit-code assertion
 * pass for a reason the test never named.
 */
function deploymentKeyring(pairs: readonly [number, VaultKeyState][]): VaultKeyring {
  const configured = configureKeyProvider('LOCAL');
  if (!configured.ok) throw new Error('fixture: no LOCAL provider');
  return {
    source: 'REGISTERED',
    mode: 'ENFORCE',
    keys: pairs.map(([version, state]) => ({
      keyId: `k${version}`,
      version,
      state,
      provider: 'LOCAL' as const,
      providerRef: null,
    })),
    providers: new Map([['LOCAL', configured]]),
  };
}

/**
 * An in-memory `Secret.valueEnc` store, holding REAL ciphertexts.
 *
 * Real ones and not placeholders, because the thing under test is that every
 * row ends up readable by exactly one key: {@link allRowsStillReadable} opens
 * every row afterwards, and a fake holding `'ciphertext'` strings would make
 * that assertion impossible to write and the sweep impossible to trust.
 */
function secretStore(
  rows: { id: string; name: string; plaintext: string }[],
  sealedUnder: VaultKeyring,
  options: { readonly failWriteOn?: string } = {},
): SealedFieldStore & {
  readonly rows: Map<string, SealedRow>;
  readonly writes: string[];
  readonly plaintexts: Map<string, string>;
} {
  const stored = new Map<string, SealedRow>();
  const plaintexts = new Map<string, string>();
  for (const row of rows) {
    const sealed = sealWithKeyring(sealedUnder, row.plaintext, ORG, row.name);
    if (!sealed.ok) throw new Error('fixture: could not seal');
    stored.set(row.id, {
      id: row.id,
      orgId: ORG,
      name: row.name,
      stored: sealed.value.ciphertext,
      keyVersion: sealed.value.keyVersion,
    });
    plaintexts.set(row.id, row.plaintext);
  }
  const writes: string[] = [];
  return {
    fieldKey: 'Secret.valueEnc',
    rows: stored,
    writes,
    plaintexts,
    countAtVersion: async (version) =>
      [...stored.values()].filter((row) => row.keyVersion === version).length,
    page: async ({ version, afterId, take }) =>
      [...stored.values()]
        .filter((row) => row.keyVersion === version)
        .filter((row) => afterId === null || row.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, take),
    write: async ({ id, stored: ciphertext, keyVersion }) => {
      if (options.failWriteOn === id) throw new Error('connection reset');
      const existing = stored.get(id);
      if (existing === undefined) throw new Error('fixture: no such row');
      // Both columns in one write, as the real store does.
      stored.set(id, { ...existing, stored: ciphertext, keyVersion });
      writes.push(id);
    },
  };
}

/** An empty store, for the two fields a Secret-only test does not exercise. */
function emptyStore(fieldKey: SealedFieldKey): SealedFieldStore {
  return {
    fieldKey,
    countAtVersion: async () => 0,
    page: async () => [],
    write: async () => {
      throw new Error('fixture: nothing should be written here');
    },
  };
}

/**
 * EVERY ROW IS STILL READABLE BY EXACTLY ONE KEY.
 *
 * The property a half-rotated database must preserve and the whole reason the
 * sweep verifies before it writes. Asserted after every sweep in this file,
 * including the interrupted one, because "the counts looked right" is not
 * evidence that the data survived.
 */
function allRowsStillReadable(
  store: { rows: Map<string, SealedRow>; plaintexts: Map<string, string> },
  ring: VaultKeyring,
): void {
  for (const row of store.rows.values()) {
    expect(row.keyVersion, `row ${row.id} has no key version`).not.toBeNull();
    const opened = openWithKeyring(
      ring,
      row.stored,
      row.keyVersion ?? -1,
      row.orgId ?? '',
      row.name ?? '',
    );
    expect(opened.ok, `row ${row.id} is readable by no key`).toBe(true);
    if (opened.ok) expect(opened.value).toBe(store.plaintexts.get(row.id));
  }
}

function sweepIo(options: { readonly existing?: SweepRecord } = {}): Pick<
  RotateIo,
  'loadSweep' | 'saveSweep' | 'now' | 'log'
> & { readonly saved: SweepRecord[]; readonly lines: string[] } {
  const saved: SweepRecord[] = options.existing === undefined ? [] : [options.existing];
  const lines: string[] = [];
  return {
    saved,
    lines,
    loadSweep: async () => saved[saved.length - 1] ?? null,
    saveSweep: async (record) => void saved.push(record),
    now: () => new Date('2026-10-29T00:00:00.000Z'),
    log: (line) => void lines.push(line),
  };
}

describe('every sealed field is named, in both halves', () => {
  it('has a format for every sealed field and no extras', () => {
    /*
     * The compile-time half is the `satisfies Record<SealedFieldKey, …>`. This
     * is the run-time half, and one without the other passes while the two
     * disagree — a field missing from the table is a field this script silently
     * skips, and a field a rotation skips stays readable under a compromised
     * key for ever.
     */
    expect(Object.keys(SEALED_FIELD_FORMATS).sort()).toEqual([...SEALED_FIELD_KEYS].sort());
  });

  it('derives the terminal states as the complement of the resumable ones', () => {
    for (const state of KEY_ROTATION_STATES) {
      expect(
        TERMINAL_ROTATION_STATES.includes(state) === !RESUMABLE_ROTATION_STATES.includes(state),
        state,
      ).toBe(true);
    }
    // FAILED keeps its cursor, which is the difference between a sweep that can
    // be resumed and one that has to be re-run.
    expect(RESUMABLE_ROTATION_STATES).toContain('FAILED');
    expect(TERMINAL_ROTATION_STATES).toContain('COMPLETED');
  });
});

describe('it refuses a database it cannot identify', () => {
  it('reads host:port/name out of a URL and NOTHING that is a credential', () => {
    /*
     * The operator pastes this into `--confirm`, so it goes into their shell
     * history. A user or a password in it would put a credential there.
     */
    const identity = databaseIdentityFrom('postgresql://user:hunter2@db.internal:6543/qaai?x=1');
    expect(identity).toBe('db.internal:6543/qaai');
    expect(identity).not.toContain('hunter2');
    expect(identity).not.toContain('user');
  });

  it('defaults the port rather than leaving the identity ambiguous', () => {
    expect(databaseIdentityFrom('postgresql://db.internal/qaai')).toBe('db.internal:5432/qaai');
  });

  it('returns null for an absent, unparseable or nameless URL', () => {
    expect(databaseIdentityFrom(undefined)).toBeNull();
    expect(databaseIdentityFrom('')).toBeNull();
    expect(databaseIdentityFrom('not a url')).toBeNull();
    expect(databaseIdentityFrom('postgresql://db.internal')).toBeNull();
  });

  it('REFUSES TO RUN AT ALL when it cannot name the database, and does nothing', async () => {
    /*
     * This repository lost live plans to a seeding script that did not make
     * anyone name the target. A tool that rewrites every sealed value in a
     * database must be able to say WHICH database.
     */
    const io = fullIo({ identity: null });
    const code = await main(['plan'], io.io);
    expect(code).toBe(EXIT.refused);
    expect(io.lines.join('\n')).toContain('cannot identify the database');
    expect(io.lines.join('\n')).toContain('Nothing was done');
  });

  it('refuses when --confirm names a DIFFERENT database', async () => {
    const io = fullIo({});
    const code = await main(
      ['sweep', '--from', '1', '--to', '2', '--confirm', 'localhost:5432/other'],
      io.io,
    );
    expect(code).toBe(EXIT.refused);
    expect(io.lines.join('\n')).toContain('Nothing was done');
  });
});

describe('the command line refuses what it does not understand', () => {
  it('has no --force, and says so when one is offered', () => {
    const result = parseArgs(['sweep', '--force']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('no --force');
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    // A tool that silently drops `--confrim` performs a dry run while the
    // operator believes it applied.
    expect(parseArgs(['sweep', '--confrim', DB]).ok).toBe(false);
  });

  it('requires a VALUE for --confirm', () => {
    expect(parseArgs(['sweep', '--confirm']).ok).toBe(false);
  });

  it('refuses a lenient version number', () => {
    // `Number.parseInt('1x')` is 1, and a key version is the one field where a
    // lenient parse selects a different key and still succeeds.
    expect(parseArgs(['sweep', '--from', '1x', '--to', '2']).ok).toBe(false);
    expect(parseArgs(['sweep', '--from', '0', '--to', '2']).ok).toBe(false);
    expect(parseArgs(['sweep', '--from', '-1', '--to', '2']).ok).toBe(false);
  });

  it('refuses a field that is not a sealed field, and lists the ones that are', () => {
    const result = parseArgs(['sweep', '--field', 'Secret.hint']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('Secret.valueEnc');
  });

  it('defaults to the read-only plan when no command is given', () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.command).toBe('plan');
  });
});

describe('canSweep refuses before a single row is read', () => {
  it('REFUSES A COMPROMISED SOURCE KEY and points at the re-entry list', () => {
    /*
     * Re-sealing a ciphertext a leaked key protected is security theatre: it
     * changes who can read it from now on and nothing about who has read it
     * already, while producing a green sweep row an operator would reasonably
     * read as "handled".
     */
    const result = canSweep(
      keyring([
        [1, 'COMPROMISED'],
        [2, 'ACTIVE'],
      ]),
      { fromKeyVersion: 1, toKeyVersion: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('KEY_COMPROMISED');
      expect(result.detail).toContain('compromise --version 1');
      expect(result.detail).toContain('re-entering');
    }
  });

  it('refuses a target that is not the single ACTIVE key', () => {
    // A re-seal writes with whatever is ACTIVE, so a sweep claiming another
    // target would record a version the rows do not end up under.
    const result = canSweep(
      keyring([
        [1, 'ACTIVE'],
        [2, 'READABLE'],
      ]),
      { fromKeyVersion: 1, toKeyVersion: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('NO_WRITABLE_KEY');
  });

  it('refuses a source version this deployment does not have', () => {
    const result = canSweep(keyring([[2, 'ACTIVE']]), { fromKeyVersion: 1, toKeyVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('UNKNOWN_KEY_VERSION');
  });

  it('refuses a sweep from a version to itself', () => {
    const result = canSweep(keyring([[1, 'ACTIVE']]), { fromKeyVersion: 1, toKeyVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('DUPLICATE_KEY_VERSION');
  });
});

describe('the sweep', () => {
  const ROWS = [
    { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
    { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
    { id: 'sec_3', name: 'C_TOKEN', plaintext: 'value-three-003' },
    { id: 'sec_4', name: 'D_TOKEN', plaintext: 'value-four-0004' },
  ];

  it('re-seals every row under the new key and reports four counts, not a percentage', async () => {
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const io = sweepIo();

    const outcome = await sweepField({
      keyring: after,
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io,
      apply: true,
      batchSize: 2,
    });

    expect(outcome.record.state).toBe('COMPLETED');
    expect(outcome.record.visited).toBe(4);
    expect(outcome.record.resealed).toBe(4);
    expect(outcome.record.unopenable).toBe(0);
    expect(outcome.record.skipped).toBe(0);
    expect(store.writes.sort()).toEqual(['sec_1', 'sec_2', 'sec_3', 'sec_4']);
    for (const row of store.rows.values()) expect(row.keyVersion).toBe(2);
    allRowsStillReadable(store, after);
  });

  it('writes nothing in a dry run, and still reports what it would do', async () => {
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const io = sweepIo();
    const outcome = await sweepField({
      keyring: keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io,
      apply: false,
      batchSize: 10,
    });
    expect(store.writes).toEqual([]);
    expect(io.saved).toEqual([]);
    expect(outcome.applied).toBe(false);
    expect(outcome.record.visited).toBe(4);
    expect(io.lines.join('\n')).toContain('DRY RUN');
  });

  it('SURVIVES AN INTERRUPTION: a killed write leaves a resumable sweep, not a corrupt one', async () => {
    /*
     * THE TEST THIS WHOLE DESIGN EXISTS FOR. The write to `sec_3` fails, as a
     * dropped connection or a killed process would. Three things must hold
     * afterwards:
     *
     *   1. the sweep is FAILED and keeps its CURSOR, so it resumes rather than
     *      restarting from the top of the table;
     *   2. the cursor is NOT past the row that failed, so that row is retried;
     *   3. EVERY row is still readable — the two that were re-sealed under the
     *      new key, and the two that were not under the old one. A row readable
     *      by no key is a value SQL cannot get back.
     */
    const before = keyring([[1, 'ACTIVE']]);
    const store = secretStore(ROWS, before, { failWriteOn: 'sec_3' });
    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const io = sweepIo();

    const interrupted = await sweepField({
      keyring: after,
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io,
      apply: true,
      batchSize: 2,
    });

    expect(interrupted.record.state).toBe('FAILED');
    expect(interrupted.record.cursor).toBe('sec_2');
    expect(interrupted.record.resealed).toBe(2);
    expect(store.writes).toEqual(['sec_1', 'sec_2']);
    expect(store.rows.get('sec_3')?.keyVersion).toBe(1);
    // Nothing is lost at the halfway point.
    allRowsStillReadable(store, after);

    // The failure is reported with a refusal name and a row id, never a value.
    expect(interrupted.record.error).toContain('sec_3');
    for (const row of ROWS) {
      expect(interrupted.record.error ?? '').not.toContain(row.plaintext);
    }

    // ── Now resume. The write works this time. ──
    const resumable = secretStore(ROWS, before);
    for (const [id, row] of store.rows) resumable.rows.set(id, row);
    const resumeIo = sweepIo({ existing: interrupted.record });

    const resumed = await sweepField({
      keyring: after,
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store: resumable,
      io: resumeIo,
      apply: true,
      batchSize: 2,
    });

    expect(resumed.record.state).toBe('COMPLETED');
    // It re-read only what was left — from the cursor, not from the top of the
    // table — so it wrote exactly the two rows the first run had not.
    expect(resumable.writes).toEqual(['sec_3', 'sec_4']);
    /*
     * `visited` IS 5 OVER A 4-ROW TABLE, AND THAT IS THE HONEST NUMBER rather
     * than a bug this test is tolerating. It counts rows READ, and `sec_3` was
     * read twice: once by the run that failed to write it and once by the run
     * that succeeded. The alternative — not counting a read whose write failed
     * — would make `visited` a count of distinct rows, which is a DIFFERENT
     * FACT from "what this sweep did", and the two would then be one field
     * carrying both. `resealed` is the count that must be exactly 4, because
     * that is the claim an operator acts on when they retire the old key.
     */
    expect(resumed.record.visited).toBe(5);
    expect(resumed.record.resealed).toBe(4);
    expect(resumable.rows.size).toBe(4);
    for (const row of resumable.rows.values()) expect(row.keyVersion).toBe(2);
    allRowsStillReadable(resumable, after);
  });

  it('is idempotent: running it again sweeps nothing and says so', async () => {
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const first = sweepIo();
    await sweepField({
      keyring: after,
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io: first,
      apply: true,
    });
    const writesAfterFirst = store.writes.length;

    // A COMPLETED sweep is not restarted. That is what stops a second run
    // re-reading the whole table and reporting a different set of figures for
    // one rotation.
    const second = await sweepField({
      keyring: after,
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io: sweepIo({ existing: first.saved[first.saved.length - 1] }),
      apply: true,
    });
    expect(second.record.state).toBe('COMPLETED');
    expect(store.writes.length).toBe(writesAfterFirst);
  });

  it('counts a row it already moved as SKIPPED and not as re-sealed', async () => {
    /*
     * Counted separately so a resumed sweep's figures stay honest about what IT
     * did, and so running the command twice is a no-op rather than a second
     * re-seal of every row.
     *
     * The page below returns a row that is ALREADY at the target version, which
     * is the race a resumed sweep sees: the write landed, the progress save did
     * not, and the row comes back inside the next page. The store deliberately
     * ignores the version filter to produce it, because the thing under test is
     * the sweep's own per-row check and not the query's WHERE clause.
     */
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const alreadyMoved = store.rows.get('sec_1');
    if (alreadyMoved === undefined) throw new Error('fixture');
    store.rows.set('sec_1', { ...alreadyMoved, keyVersion: 2 });

    const ignoresVersion: SealedFieldStore = {
      ...store,
      page: async ({ afterId, take }) =>
        [...store.rows.values()]
          .filter((row) => afterId === null || row.id > afterId)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, take),
    };

    const outcome = await sweepField({
      keyring: keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store: ignoresVersion,
      io: sweepIo(),
      apply: true,
      batchSize: 4,
    });

    expect(outcome.record.skipped).toBe(1);
    expect(outcome.record.resealed).toBe(3);
    expect(outcome.record.visited).toBe(4);
    // The already-moved row was NOT written again.
    expect(store.writes).not.toContain('sec_1');
    expect(store.writes.sort()).toEqual(['sec_2', 'sec_3', 'sec_4']);
  });

  it('refuses a sweep from a version to itself before it reads anything', async () => {
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const outcome = await sweepField({
      keyring: keyring([[2, 'ACTIVE']]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 2,
      toKeyVersion: 2,
      store,
      io: sweepIo(),
      apply: true,
    });
    expect(outcome.refusal?.refusal).toBe('DUPLICATE_KEY_VERSION');
    expect(store.writes).toEqual([]);
  });

  it('CANNOT REACH COMPLETED with a row it could not open', async () => {
    /*
     * `unopenable` is the count that must never be swallowed: those rows stay
     * under the source key, so retiring that key destroys them. A sweep that
     * ends with a non-zero count is FAILED, and that is what stops the key
     * being retired on the strength of a rotation that did not finish.
     */
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const broken = store.rows.get('sec_2');
    if (broken === undefined) throw new Error('fixture');
    store.rows.set('sec_2', { ...broken, stored: randomBytes(48).toString('base64') });

    const outcome = await sweepField({
      keyring: keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io: sweepIo(),
      apply: true,
    });

    expect(outcome.record.state).toBe('FAILED');
    expect(outcome.record.unopenable).toBe(1);
    expect(outcome.record.resealed).toBe(3);
    // The row is left exactly as it was, still under the source key.
    expect(store.rows.get('sec_2')?.keyVersion).toBe(1);
    expect(store.writes).not.toContain('sec_2');
  });

  it('says per unopenable row whether the remedy is a re-seal or a NEW value', async () => {
    /*
     * The remedy comes from `VAULT_REFUSAL_REPORTS` and not from a judgement
     * made at this call site, so there is one answer to "what does an operator
     * do about this refusal" rather than one per caller. It is the difference
     * between "run the sweep again" and "ask the customer for a new
     * credential", and getting it wrong in either direction is expensive.
     */
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const broken = store.rows.get('sec_2');
    if (broken === undefined) throw new Error('fixture');
    store.rows.set('sec_2', { ...broken, stored: randomBytes(48).toString('base64') });

    const outcome = await sweepField({
      keyring: keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io: sweepIo(),
      apply: true,
    });
    // CIPHER_REJECTED is reEntryRequired: the stored bytes cannot be recovered.
    expect(outcome.record.error).toContain('needs a NEW value');
    expect(outcome.record.error).toContain('CIPHER_REJECTED');
  });

  it('refuses an incomplete projection rather than composing a binding from nothing', async () => {
    /*
     * A legacy secret's binding is `${orgId}:${name}`. A store that dropped
     * either would compose a binding that is wrong in a way GCM reports as a
     * plain cipher failure, and the operator would read "wrong key" for what is
     * actually a select-blind query.
     */
    const store = secretStore(ROWS, keyring([[1, 'ACTIVE']]));
    const row = store.rows.get('sec_1');
    if (row === undefined) throw new Error('fixture');
    store.rows.set('sec_1', { ...row, name: null });

    const outcome = await sweepField({
      keyring: keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      store,
      io: sweepIo(),
      apply: true,
    });
    expect(outcome.record.unopenable).toBe(1);
    expect(outcome.record.error).toContain('AAD_MISMATCH');
  });
});

describe('the compromise response', () => {
  it('lists every value a compromised key sealed, and does NOT re-seal any of them', async () => {
    /*
     * Item 4 of this round: a compromised key means the ciphertext it protected
     * must be considered disclosed, and silently re-sealing it would be
     * security theatre. So the deliverable is an enumerable worklist and the
     * write path is never touched.
     */
    const store = secretStore(
      [
        { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
        { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
      ],
      keyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });

    const code = await main(['compromise', '--version', '1', '--confirm', DB], io.io);
    expect(code).toBe(EXIT.ok);

    const printed = io.lines.join('\n');
    expect(printed).toContain('2 value(s) need re-entering');
    expect(printed).toContain('sec_1');
    expect(printed).toContain('sec_2');
    expect(printed).toContain('considered DISCLOSED');
    // Nothing was re-sealed.
    expect(store.writes).toEqual([]);
    // And the key state transition is explicit, with its timestamp.
    expect(io.compromised).toEqual([1]);
  });

  it('changes nothing in a dry run, while still printing the blast radius', async () => {
    const store = secretStore(
      [{ id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' }],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    const code = await main(['compromise', '--version', '1'], io.io);
    expect(code).toBe(EXIT.ok);
    expect(io.lines.join('\n')).toContain('sec_1');
    expect(io.compromised).toEqual([]);
    expect(io.lines.join('\n')).toContain('key state was NOT changed');
  });

  it('lists nothing — and no row ids — for a key that is merely superseded', () => {
    /*
     * `reEntryRequired` is not a synonym for "needs a re-seal". A READABLE key
     * that has been rotated out is a backlog; its values are re-sealed, not
     * re-entered, and listing them for re-entry would send a customer round
     * every credential they own for no reason.
     */
    const worklist = reEntryWorklist(
      keyring([
        [1, 'READABLE'],
        [2, 'ACTIVE'],
      ]),
      [{ fieldKey: 'Secret.valueEnc', rowId: 'sec_1', keyVersion: 1 }],
    );
    expect(worklist).toEqual([]);
  });

  it('carries a row id and a field name, and structurally nothing else', () => {
    const worklist = reEntryWorklist(
      keyring([
        [1, 'COMPROMISED'],
        [2, 'ACTIVE'],
      ]),
      [{ fieldKey: 'Secret.valueEnc', rowId: 'sec_1', keyVersion: 1 }],
    );
    expect(worklist).toHaveLength(1);
    expect(Object.keys(worklist[0] ?? {}).sort()).toEqual([
      'fieldKey',
      'keyVersion',
      'rowId',
      'why',
    ]);
  });
});

describe('the plan, and what the tool prints', () => {
  it('prints the keyring, the states and the per-version counts before anything else', async () => {
    const store = secretStore(
      [{ id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' }],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({ secretStore: store });
    const code = await main(['plan'], io.io);
    expect(code).toBe(EXIT.ok);

    const printed = io.lines.join('\n');
    expect(printed).toContain(`database        ${DB}`);
    expect(printed).toContain('VAULT_KEY_ROTATION mode ENFORCE');
    expect(printed).toContain('key v1');
    expect(printed).toContain('DRY RUN');
    expect(printed).toContain('Secret.valueEnc  [LEGACY_SECRET');
    expect(printed).toContain('1 row(s)');
  });

  it('reports the implicit keyring as such when nothing is registered', async () => {
    const io = fullIo({ keys: [] });
    await main(['plan'], io.io);
    expect(io.lines.join('\n')).toContain('IMPLICIT');
    expect(io.lines.join('\n')).toContain('nothing is registered');
  });

  it('exits with its own code when a sweep leaves rows under the old key', async () => {
    const store = secretStore(
      [
        { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
        { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
      ],
      keyring([[1, 'ACTIVE']]),
    );
    const broken = store.rows.get('sec_2');
    if (broken === undefined) throw new Error('fixture');
    store.rows.set('sec_2', { ...broken, stored: randomBytes(48).toString('base64') });

    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    const code = await main(
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB],
      io.io,
    );
    /*
     * A distinct exit code, because a runbook cannot act on a script that exits
     * 1 for both "you typed the flag wrong" and "the rotation left rows the old
     * key is still the only thing that can read".
     */
    expect(code).toBe(EXIT.incomplete);
    expect(io.lines.join('\n')).toContain('MUST NOT be retired');
    // And the refusals are counted and reported, not merely applied.
    expect(io.lines.join('\n')).toContain('vault decision(s)');
  });

  it('EXITS NON-ZERO WHEN AN INTERRUPTED SWEEP IS RESUMABLE BUT NOT COMPLETE', async () => {
    /*
     * THE DEFECT THIS PINS, measured on the whole tool rather than on
     * `sweepField`. "SURVIVES AN INTERRUPTION" above calls `sweepField`
     * directly, so it proved the RECORD was resumable and never looked at the
     * process exit code. Through `main`, a killed write returned early with
     * `state: 'FAILED'`, `refusal: null` and `unopenable: 0` — so neither arm
     * in `sweep()` fired, `worst` stayed `EXIT.ok`, and the tool printed
     * "sweep FAILED and is resumable" and then exited 0.
     *
     * Exit 0 is the one thing a runbook reads, and the sequence this file's
     * own usage block documents is sweep, then `compromise --version <from>`.
     * A step gated on `$?` would therefore mark the SOURCE key COMPROMISED
     * with rows still sealed under it, and a COMPROMISED key opens nothing —
     * turning a resumable sweep into rows readable by NO KEY, which is the
     * outcome safety measure 6 exists to prevent.
     */
    const store = secretStore(
      [
        { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
        { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
      ],
      deploymentKeyring([[1, 'ACTIVE']]),
      { failWriteOn: 'sec_2' },
    );
    const after = deploymentKeyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });

    const code = await main(
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB],
      io.io,
    );

    expect(code).toBe(EXIT.incomplete);
    // The sweep really was interrupted half-way, and really is resumable.
    expect(store.writes).toEqual(['sec_1']);
    expect(store.rows.get('sec_2')?.keyVersion).toBe(1);
    // Said out loud, because a non-zero code with no sentence is unreadable.
    expect(io.lines.join('\n')).toContain('NOT COMPLETED');
    expect(io.lines.join('\n')).toContain('MUST NOT be retired or marked compromised yet');
    // And nothing was lost at the halfway point.
    allRowsStillReadable(store, after);
  });

  it('still exits 0 for a sweep that COMPLETED, so the new code is not a blanket failure', async () => {
    /*
     * The other half of the pair. A check written as `state !== 'COMPLETED'`
     * is only a control if COMPLETED still exits 0 — otherwise it is an exit
     * code nobody can distinguish from the one it replaced.
     */
    const store = secretStore(
      [{ id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' }],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    const code = await main(
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB],
      io.io,
    );
    expect(code).toBe(EXIT.ok);
    expect(store.writes).toEqual(['sec_1']);
    expect(io.lines.join('\n')).not.toContain('NOT COMPLETED');
  });

  it('EXITS NON-ZERO WHEN A COMPLETED SWEEP ROW IS REUSED OVER ROWS IT NEVER SAW', async () => {
    /*
     * THE DEFECT THIS PINS, and it is the arm the check above does not cover.
     * `state !== 'COMPLETED'` is a control over a sweep that RAN; it says
     * nothing about a sweep that did not.
     *
     * MEASURED: sweep 1 → 2 completes and exits 0. The API then writes new
     * secrets, and it writes them under v1 — `seal()` uses the keyring
     * installed in ITS process, and nothing in apps/api or apps/worker calls
     * `installVaultKeyring`, so the running API is on the implicit keyring
     * whatever `VaultKey` says. Re-running the SAME pair then hits
     * `sweepField`'s "an existing sweep … is COMPLETED; not restarted" arm,
     * which returns the STORED record: `state` COMPLETED, `unopenable` 0,
     * `visited` 0. Neither arm above fired and the tool exited 0 with two rows
     * still sealed under v1.
     *
     * Exit 0 is the one thing a runbook reads, and the documented sequence is
     * sweep then `compromise --version <from>`. So a step gated on `$?` marks
     * the source key COMPROMISED while rows are still under it, and a
     * COMPROMISED key opens nothing — rows readable by NO KEY, which is the
     * outcome safety measure 6 exists to prevent, reached through the exit
     * code rather than through the writes.
     *
     * The tool had the fact in hand both times: the line it prints before the
     * sweep is `countAtVersion(from)`, and it printed `2 row(s) sealed under
     * v1` two lines above `COMPLETED — visited 0`. The two were never
     * compared.
     */
    const store = secretStore(
      [{ id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' }],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    const argv = ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB];

    // The real rotation, which really does finish.
    expect(await main(argv, io.io)).toBe(EXIT.ok);
    expect(store.rows.get('sec_1')?.keyVersion).toBe(2);

    /*
     * Two secrets written afterwards by a process on the implicit keyring.
     * Sealed with the v1 material and stamped v1, which is what `seal()`
     * produces there. The ids straddle the cursor the first sweep left, so
     * this is not a test about id ordering.
     */
    for (const [id, name] of [
      ['aaa_after', 'C_TOKEN'],
      ['zzz_after', 'D_TOKEN'],
    ] as const) {
      const sealed = sealWithKeyring(deploymentKeyring([[1, 'ACTIVE']]), `${id}-0003`, ORG, name);
      if (!sealed.ok) throw new Error('fixture: could not seal');
      store.rows.set(id, {
        id,
        orgId: ORG,
        name,
        stored: sealed.value.ciphertext,
        keyVersion: 1,
      });
      store.plaintexts.set(id, `${id}-0003`);
    }

    const code = await main(argv, io.io);

    expect(code).toBe(EXIT.incomplete);
    // The two new rows really were skipped, and really are still under v1.
    expect(store.rows.get('aaa_after')?.keyVersion).toBe(1);
    expect(store.rows.get('zzz_after')?.keyVersion).toBe(1);
    expect(store.writes).toEqual(['sec_1']);
    // Said out loud, with the count, because a non-zero code with no number is
    // a refusal an operator cannot act on.
    const said = io.lines.join('\n');
    expect(said).toContain('reported COMPLETED and 2 row(s) are STILL sealed under v1');
    expect(said).toContain('MUST NOT be retired or marked compromised');
    allRowsStillReadable(store, deploymentKeyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]));
  });

  it('EXITS NON-ZERO WHEN A SAVED CURSOR IS PAST EVERY REMAINING ROW', async () => {
    /*
     * The same lie reached a second way, and the reason the check is on the
     * row count rather than on the "not restarted" branch.
     *
     * A RESUMABLE record (`FAILED` keeps its cursor — that is the whole point
     * of it) whose cursor sorts after every id still at the source version
     * reads ONE empty page, runs the loop zero times, and falls through to
     * `unopenable > 0 ? 'FAILED' : 'COMPLETED'` with `unopenable` 0. So a
     * sweep that touched nothing reports COMPLETED.
     *
     * MEASURED before the fix: `3 row(s) sealed under v1`, then
     * `COMPLETED — visited 0, re-sealed 0`, then exit 0.
     */
    const store = secretStore(
      [
        { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
        { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
      ],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    // A sweep that died after its last write, with the cursor it had reached.
    await io.io.saveSweep({
      fieldKey: 'Secret.valueEnc',
      fromKeyVersion: 1,
      toKeyVersion: 2,
      state: 'FAILED',
      visited: 0,
      resealed: 0,
      unopenable: 0,
      skipped: 0,
      cursor: 'zzzz_past_everything',
      error: 'WRITE_FAILED on Secret.valueEnc row sec_9 (PrismaClientKnownRequestError)',
    });

    const code = await main(
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB],
      io.io,
    );

    expect(code).toBe(EXIT.incomplete);
    expect(store.writes).toEqual([]);
    expect(store.rows.get('sec_1')?.keyVersion).toBe(1);
    expect(store.rows.get('sec_2')?.keyVersion).toBe(1);
    expect(io.lines.join('\n')).toContain(
      'reported COMPLETED and 2 row(s) are STILL sealed under v1',
    );
    allRowsStillReadable(store, deploymentKeyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]));
  });

  it('a DRY RUN still exits 0, because leaving the rows alone is what it is for', async () => {
    /*
     * The other half of the pair above. The new check is gated on `apply` for
     * one reason: a dry run writes nothing, so rows remaining at the source
     * version is its CORRECT result. Without the gate the check would make
     * every dry run exit non-zero, which is an exit code nobody can read.
     */
    const store = secretStore(
      [{ id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' }],
      deploymentKeyring([[1, 'ACTIVE']]),
    );
    const io = fullIo({
      keys: [
        { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
        { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      ],
      secretStore: store,
    });
    const code = await main(
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2'],
      io.io,
    );
    expect(code).toBe(EXIT.ok);
    expect(store.writes).toEqual([]);
    expect(store.rows.get('sec_1')?.keyVersion).toBe(1);
    expect(io.lines.join('\n')).toContain('DRY RUN');
    expect(io.lines.join('\n')).not.toContain('are STILL sealed under');
  });

  it('NEVER PRINTS A PLAINTEXT, A CIPHERTEXT OR THE MASTER KEY', async () => {
    /*
     * Rule 11 over the whole tool rather than one function: every line this
     * script emits across a plan, a dry run, an applied sweep with a bad row,
     * and a compromise, checked against the actual values in play.
     */
    const rows = [
      { id: 'sec_1', name: 'A_TOKEN', plaintext: 'value-one-0001' },
      { id: 'sec_2', name: 'B_TOKEN', plaintext: 'value-two-0002' },
    ];
    const store = secretStore(rows, keyring([[1, 'ACTIVE']]));
    const ciphertexts = [...store.rows.values()].map((row) => row.stored);
    const keys: VaultKeyRow[] = [
      { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
      { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
    ];

    const lines: string[] = [];
    for (const argv of [
      ['plan'],
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2'],
      ['sweep', '--field', 'Secret.valueEnc', '--from', '1', '--to', '2', '--confirm', DB],
      ['compromise', '--version', '1'],
    ]) {
      const io = fullIo({ keys, secretStore: secretStore(rows, keyring([[1, 'ACTIVE']])) });
      await main(argv, io.io);
      lines.push(...io.lines);
    }

    const printed = lines.join('\n');
    expect(printed.length).toBeGreaterThan(100);
    for (const row of rows) expect(printed).not.toContain(row.plaintext);
    for (const ciphertext of ciphertexts) {
      expect(printed).not.toContain(ciphertext);
      // Not truncated: part of a ciphertext is a ciphertext.
      expect(printed).not.toContain(ciphertext.slice(0, 16));
    }
    expect(printed).not.toContain(MASTER);
    expect(printed).not.toContain(MASTER.slice(0, 8));
    expect(printed).not.toContain(Buffer.from(MASTER, 'base64').toString('hex'));
  });
});

describe('a thrown database error is a named refusal that quotes nothing', () => {
  it('prints the error CLASS and not its message, because the message quotes the statement', async () => {
    /*
     * REPRODUCED, NOT HYPOTHETICAL. Running this tool against a database whose
     * migration was unapplied threw a `PrismaClientKnownRequestError` whose
     * message carries the failing invocation — and for the UPDATE that replaces
     * a sealed value, the failing invocation carries the ciphertext. So the
     * handler takes the error's class name, which is a label, and nothing else.
     *
     * The fake's message below is the shape of that error: a sealed value
     * inside the text of a driver failure.
     */
    const secret = 'qs1.k1.1.AES_256_GCM.VGhpc0lzVGhlU2VhbGVkVmFsdWU';
    const io = fullIo({});
    const throwing: RotateIo = {
      ...io.io,
      listVaultKeys: async () => {
        throw new Error(`Invalid \`prisma.secret.update()\`: data: { valueEnc: "${secret}" }`);
      },
    };

    const code = await main(['plan'], throwing);
    expect(code).toBe(EXIT.refused);
    const printed = io.lines.join('\n');
    expect(printed).toContain('the database refused a query (Error)');
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(secret.slice(0, 16));
    expect(printed).not.toContain('valueEnc');
  });

  it('does not fall through to success when the database refuses', async () => {
    // An exception handler that ends in "carry on" would report a rotation that
    // did not happen.
    const io = fullIo({});
    const throwing: RotateIo = {
      ...io.io,
      stores: () => {
        throw new TypeError('pool exhausted');
      },
    };
    expect(await main(['plan'], throwing)).toBe(EXIT.refused);
    expect(io.lines.join('\n')).toContain('TypeError');
  });
});

describe('the production adapter asks for every column it needs', () => {
  it('reads a complete SealedRow through a fake that HONOURS select', async () => {
    /*
     * RULE 9, AND IT IS THE REASON THIS FAKE EXISTS. The fake below returns
     * ONLY the fields the query selected, so dropping `keyVersion` or `orgId`
     * from the real `select` makes this test fail — where a select-blind fake
     * would keep passing and two defects would survive the slice, as they have
     * before.
     */
    const prisma = selectHonouringPrisma();
    const io = prismaRotateIo({
      prisma,
      unscoped: async (fn) => fn(),
      databaseUrl: 'postgresql://u:p@db.internal:5432/qaai',
      log: () => undefined,
      now: () => new Date('2026-10-29T00:00:00.000Z'),
    });

    const page = await io.stores()['Secret.valueEnc'].page({
      version: 1,
      afterId: null,
      take: BATCH_SIZE,
    });
    expect(page).toHaveLength(1);
    const row = page[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row).toEqual({
      id: 'sec_1',
      orgId: ORG,
      name: 'A_TOKEN',
      stored: 'ciphertext-1',
      keyVersion: 1,
    });
  });

  it('orders by id and honours the cursor, or a sweep would skip rows', async () => {
    const prisma = selectHonouringPrisma();
    const io = prismaRotateIo({
      prisma,
      unscoped: async (fn) => fn(),
      databaseUrl: 'postgresql://u:p@db.internal:5432/qaai',
      log: () => undefined,
    });
    expect(prisma.lastSecretQuery?.orderBy).toEqual(undefined);
    await io.stores()['Secret.valueEnc'].page({ version: 1, afterId: 'sec_0', take: 7 });
    /*
     * The cursor is a row id, so a page with no stable order would skip rows and
     * repeat others — and a sweep would report COMPLETED over a table it had not
     * finished. Asserted on the query the adapter actually issued.
     */
    expect(prisma.lastSecretQuery?.orderBy).toEqual({ id: 'asc' });
    expect(prisma.lastSecretQuery?.take).toBe(7);
    expect(prisma.lastSecretQuery?.where).toMatchObject({ id: { gt: 'sec_0' } });
  });

  it('clears the re-seal flag in the SAME statement that writes the new ciphertext', async () => {
    /*
     * Two writes would leave a window in which the row is sealed under the new
     * key and still marked as needing a re-seal, and a later sweep would re-do
     * it. The flag, the ciphertext and the version move together.
     */
    const prisma = selectHonouringPrisma();
    const io = prismaRotateIo({
      prisma,
      unscoped: async (fn) => fn(),
      databaseUrl: 'postgresql://u:p@db.internal:5432/qaai',
      log: () => undefined,
      now: () => new Date('2026-10-29T00:00:00.000Z'),
    });
    await io.stores()['AuthProfile.storageState'].write({
      id: 'prof_1',
      stored: 'qs1.k2.2.AES_256_GCM.AAAA',
      keyVersion: 2,
    });
    expect(prisma.lastProfileUpdate).toEqual({
      storageStateSealed: 'qs1.k2.2.AES_256_GCM.AAAA',
      storageStateKeyVersion: 2,
      storageStateSealedAt: new Date('2026-10-29T00:00:00.000Z'),
      storageStateNeedsReseal: false,
    });
  });

  it('marks a compromised key and its timestamp together', async () => {
    const prisma = selectHonouringPrisma();
    const io = prismaRotateIo({
      prisma,
      unscoped: async (fn) => fn(),
      databaseUrl: 'postgresql://u:p@db.internal:5432/qaai',
      log: () => undefined,
    });
    const at = new Date('2026-10-29T12:00:00.000Z');
    await io.markKeyCompromised({ version: 3, at });
    /*
     * The pair (state COMPROMISED, compromisedAt null) can only arise from a bug
     * in this path, and the schema says so above the column. Writing one without
     * the other would be that bug.
     */
    expect(prisma.lastVaultKeyUpdate).toEqual({ state: 'COMPROMISED', compromisedAt: at });
  });
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** A whole-tool IO, with the three stores and a recorded log. */
function fullIo(options: {
  readonly identity?: string | null;
  readonly keys?: readonly VaultKeyRow[];
  readonly secretStore?: SealedFieldStore;
}): { readonly io: RotateIo; readonly lines: string[]; readonly compromised: number[] } {
  const lines: string[] = [];
  const compromised: number[] = [];
  const sweeps = new Map<string, SweepRecord>();
  const stores: Record<SealedFieldKey, SealedFieldStore> = {
    'Secret.valueEnc': options.secretStore ?? emptyStore('Secret.valueEnc'),
    'User.totpSecretEnc': emptyStore('User.totpSecretEnc'),
    'AuthProfile.storageState': emptyStore('AuthProfile.storageState'),
  };
  return {
    lines,
    compromised,
    io: {
      databaseIdentity: () => (options.identity === undefined ? DB : options.identity),
      listVaultKeys: async () =>
        options.keys ?? [
          { keyId: 'k1', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
        ],
      storedModes: async () => undefined,
      stores: () => stores,
      loadSweep: async ({ fieldKey, fromKeyVersion, toKeyVersion }) =>
        sweeps.get(`${fieldKey}|${fromKeyVersion}|${toKeyVersion}`) ?? null,
      saveSweep: async (record) => {
        sweeps.set(
          `${record.fieldKey}|${record.fromKeyVersion}|${record.toKeyVersion}`,
          record,
        );
      },
      markKeyCompromised: async ({ version }) => void compromised.push(version),
      now: () => new Date('2026-10-29T00:00:00.000Z'),
      log: (line) => void lines.push(line),
    },
  };
}

/**
 * A Prisma fake that PROJECTS THROUGH `select`.
 *
 * It returns only the keys the query asked for, so a field dropped from the
 * real `select` comes back `undefined` and the assertion fails. A fake that
 * ignored `select` would make that change undetectable, which is how two
 * defects survived a whole slice.
 */
function selectHonouringPrisma(): PrismaForRotation & {
  lastSecretQuery?: { where: Record<string, unknown>; orderBy: unknown; take: number };
  lastProfileUpdate?: Record<string, unknown>;
  lastVaultKeyUpdate?: Record<string, unknown>;
} {
  const project = <T extends Record<string, unknown>>(
    row: T,
    select: Record<string, true>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const field of Object.keys(select)) out[field] = row[field];
    return out;
  };
  const secretRows = [
    {
      id: 'sec_1',
      orgId: ORG,
      name: 'A_TOKEN',
      valueEnc: 'ciphertext-1',
      keyVersion: 1,
      hint: 'eve1',
    },
  ];
  const fake: PrismaForRotation & {
    lastSecretQuery?: { where: Record<string, unknown>; orderBy: unknown; take: number };
    lastProfileUpdate?: Record<string, unknown>;
    lastVaultKeyUpdate?: Record<string, unknown>;
  } = {
    vaultKey: {
      findMany: async ({ select }) =>
        [
          {
            keyId: 'k1',
            version: 1,
            state: 'ACTIVE' as const,
            provider: 'LOCAL' as const,
            providerRef: null,
          },
        ].map((row) => project(row, select)) as unknown as VaultKeyRow[],
      update: async ({ data }) => {
        fake.lastVaultKeyUpdate = data;
        return null;
      },
    },
    keyRotationSweep: {
      findUnique: async () => null,
      upsert: async () => null,
    },
    secret: {
      count: async () => secretRows.length,
      findMany: async ({ where, select, orderBy, take }) => {
        fake.lastSecretQuery = { where, orderBy, take };
        return secretRows.map((row) => project(row, select)) as unknown as {
          id: string;
          orgId: string;
          name: string;
          valueEnc: string;
          keyVersion: number;
        }[];
      },
      update: async () => null,
    },
    user: {
      count: async () => 0,
      findMany: async () => [],
      update: async () => null,
    },
    authProfile: {
      count: async () => 0,
      findMany: async () => [],
      update: async ({ data }) => {
        fake.lastProfileUpdate = data;
        return null;
      },
    },
  };
  return fake;
}
