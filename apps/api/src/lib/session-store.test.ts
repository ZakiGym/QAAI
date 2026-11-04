/**
 * Tests for the session store.
 *
 * ── WHAT THIS FILE IS ACTUALLY DEFENDING ────────────────────────────────────
 *
 * Two different failures, and almost every test here is about the second one
 * because it is the one that was shipping:
 *
 *   1. LIVE CUSTOMER SESSION COOKIES IN A PLAIN JSON COLUMN. The seal tests
 *      prove the column can hold a sealed envelope, that a ciphertext cannot be
 *      moved between profiles, and — the part that is easy to leave out — that
 *      every failure on the way is REPORTABLE WITHOUT QUOTING THE SECRET.
 *
 *   2. THE SILENT DEGRADE. An expired session became `null`, `null` became
 *      `{ ok: true, storageState: null }`, and the run executed anonymously and
 *      reported a pass. So the headline test in this file is
 *      "an unopenable session is a typed NOT_RUN and never an anonymous run",
 *      and the gate invariant beside it is what stops a ninth state arriving
 *      with no answer.
 *
 * ── NO NETWORK, NO DNS, NO KEY ON DISK ─────────────────────────────────────
 *
 * The cipher is injected. Half of these tests use a FAKE cipher that records
 * what it was asked to do, because that is how an AAD can be asserted exactly;
 * the other half use the REAL AES-256-GCM one, over a key generated in-process,
 * because a round trip that only ever ran against a fake proves nothing about
 * the envelope the database will hold. No test reads an environment variable.
 */

import { createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SESSION_FIELD_KEY,
  SESSION_REFRESH_LEAD_MS,
  SESSION_REFUSALS,
  SESSION_ROW_SELECT,
  SESSION_GATE_OUTCOMES,
  SESSION_STATES,
  SESSION_STATE_RULES,
  VAULT_KEY_SELECT,
  countSessionGate,
  localSessionCipher,
  masterKeyResolver,
  openSession,
  readVaultKeys,
  sealSession,
  sessionDegradation,
  sessionGate,
  sessionStateOf,
  sessionTallyKey,
  useSessionState,
  vaultKeysFrom,
} from './session-store.js';
import type {
  SealedSessionRow,
  SessionCipher,
  SessionDegradationTally,
  SessionState,
} from './session-store.js';
import { OpenedSecret, aadFor } from '../../../../packages/shared/src/sealed.js';
import type { VaultKeyRef } from '../../../../packages/shared/src/sealed.js';
import { SECRET_MASK } from '@qaai/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-29T12:00:00.000Z');
const HOUR = 3_600_000;

/**
 * The thing being protected, composed at run time.
 *
 * Assembled from parts rather than written as one literal, because rule 19 is
 * absolute about credential-shaped literals in this repository and a session
 * cookie is the most credential-shaped value the product holds. Every leak
 * assertion below greps output for this string, so it has to be distinctive and
 * it must not be anything a scanner would flag.
 */
const COOKIE_VALUE = ['qaai', 'fake', 'session', 'cookie'].join('-') + '-00000000';

const SESSION = {
  cookies: [{ name: 'sid', value: COOKIE_VALUE, domain: 'app.example.com', path: '/' }],
  origins: [],
};

const ACTIVE_KEY: VaultKeyRef = { keyId: 'local-1', version: 1, state: 'ACTIVE' };

/** A 32-byte key, generated in this process. Never a literal, never on disk. */
const realCipher = (): SessionCipher =>
  localSessionCipher(masterKeyResolver(randomBytes(32).toString('base64')));

/** A row with no session at all. Each test spoils exactly one thing. */
const row = (over: Partial<SealedSessionRow> = {}): SealedSessionRow => ({
  id: 'prof1',
  storageState: null,
  storageStateExpiresAt: null,
  storageStateSealed: null,
  storageStateKeyVersion: null,
  storageStateNeedsReseal: false,
  ...over,
});

/** Seal `SESSION` for `profileId` and return the row it would be written to. */
async function sealedRow(
  profileId: string,
  cipher: SessionCipher,
  expiresAt = new Date(NOW.getTime() + 8 * HOUR),
): Promise<SealedSessionRow> {
  const sealed = await sealSession({
    profileId,
    storageState: SESSION,
    expiresAt,
    keys: [ACTIVE_KEY],
    cipher,
    now: NOW,
  });
  if (!sealed.ok) throw new Error(`fixture could not seal: ${sealed.refusal}`);
  return row({
    id: profileId,
    storageStateSealed: sealed.value.storageStateSealed,
    storageStateKeyVersion: sealed.value.storageStateKeyVersion,
    storageStateExpiresAt: sealed.value.storageStateExpiresAt,
  });
}

/**
 * A `vaultKey.findMany` fake that HONOURS `select`.
 *
 * Rule 9, and it is not theoretical here: production code reads `state` to
 * decide which key may seal, so a fake that returned whole rows regardless of
 * the projection would make deleting `state: true` from the real query
 * undetectable — and an unreadable state must never be read as permissive.
 * This fake projects exactly the selected keys, so the select-blind test below
 * can prove the production read asks for all three.
 */
const vaultKeyDb = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  vaultKey: {
    findMany: async (args: {
      select: typeof VAULT_KEY_SELECT;
      orderBy: { version: 'asc' };
    }): Promise<ReadonlyArray<Record<string, unknown>>> => {
      const keys = Object.keys(args.select);
      const projected = rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = r[key];
        return out;
      });
      return [...projected].sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('sealing and opening a session', () => {
  it('seals a session and opens it again, through a real cipher', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);

    const opened = await openSession({ row: stored, keys: [ACTIVE_KEY], cipher });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const names = useSessionState(opened.value, (state) =>
      (state as typeof SESSION).cookies.map((c) => c.name),
    );
    expect(names).toEqual(['sid']);
  });

  it('writes an envelope the keystone can parse, under the ACTIVE key', async () => {
    const stored = await sealedRow('prof1', realCipher());
    expect(stored.storageStateSealed?.startsWith('qs1.local-1.1.AES_256_GCM.')).toBe(true);
    expect(stored.storageStateKeyVersion).toBe(1);
  });

  /*
   * THE WRITE THAT CLEANS UP AFTER THE OLD ONE.
   *
   * `storageState: null` is in the write object on every path, which is what
   * makes the schema's "WRITE NOTHING HERE EVER AGAIN" a property of the code.
   * A caller spreading this into `data` cannot leave a plaintext session beside
   * a sealed one, and a profile that an un-migrated writer wrote plaintext into
   * is cleaned by its next successful refresh rather than by a second sweep.
   */
  it('nulls the legacy plaintext column on every write, and moves the expiry with it', async () => {
    const expiresAt = new Date(NOW.getTime() + 8 * HOUR);
    const sealed = await sealSession({
      profileId: 'prof1',
      storageState: SESSION,
      expiresAt,
      keys: [ACTIVE_KEY],
      cipher: realCipher(),
      now: NOW,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value.storageState).toBeNull();
    expect(sealed.value.storageStateExpiresAt).toEqual(expiresAt);
    expect(sealed.value.storageStateNeedsReseal).toBe(false);
    expect(sealed.value.storageStateSealedAt).toEqual(NOW);
  });

  /*
   * THE LAYOUT CLAIM, CHECKED.
   *
   * `localSessionCipher` says in its own comment that the payload is
   * `iv | tag | ciphertext` base64, byte-identical to what
   * apps/api/src/lib/vault.ts writes — which is what lets one key-rotation
   * sweep read `Secret.valueEnc` and `AuthProfile.storageStateSealed` without
   * knowing which field it is looking at. A doc comment that contradicts the
   * code under it is the worst kind of defect in a security file, so the claim
   * is decoded here by hand with the documented offsets rather than asserted.
   */
  it('writes the iv|tag|ciphertext layout the existing vault reads', async () => {
    const key = randomBytes(32);
    const cipher = localSessionCipher(() => key);
    const aad = 'org1\u001frow1\u001ffield';
    const payload = await cipher.encrypt({ plaintext: 'hello', keyVersion: 1, aad });

    const raw = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    expect(out).toBe('hello');
  });

  it('refuses to seal a login that produced no session, instead of sealing a null', async () => {
    const sealed = await sealSession({
      profileId: 'prof1',
      storageState: null,
      expiresAt: new Date(NOW.getTime() + HOUR),
      keys: [ACTIVE_KEY],
      cipher: realCipher(),
      now: NOW,
    });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.refusal).toBe('NOT_SERIALISABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The AAD — a ciphertext that cannot be moved
// ─────────────────────────────────────────────────────────────────────────────

describe('the binding to the row', () => {
  it('binds the AAD to the field and THIS profile id', async () => {
    const seen: string[] = [];
    const cipher: SessionCipher = {
      encrypt: async ({ aad }) => {
        seen.push(aad);
        return Buffer.from('x').toString('base64');
      },
      decrypt: async () => JSON.stringify(SESSION),
    };
    await sealSession({
      profileId: 'prof-abc',
      storageState: SESSION,
      expiresAt: new Date(NOW.getTime() + HOUR),
      keys: [ACTIVE_KEY],
      cipher,
      now: NOW,
    });
    expect(seen).toEqual([aadFor({ fieldKey: SESSION_FIELD_KEY, rowId: 'prof-abc' })]);
  });

  /*
   * THE TEST THIS WHOLE BINDING EXISTS FOR. Someone with write access to the
   * column copies a working session onto a profile they can run — an admin
   * session onto a profile bound to a member test — and the AAD is what turns
   * that from a privilege escalation into a row that will not open.
   */
  it('REFUSES A SESSION LIFTED FROM ANOTHER PROFILE, rather than opening it', async () => {
    const cipher = realCipher();
    const mine = await sealedRow('prof-victim', cipher);

    const pasted: SealedSessionRow = { ...mine, id: 'prof-attacker' };
    const opened = await openSession({ row: pasted, keys: [ACTIVE_KEY], cipher });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.refusal).toBe('AAD_MISMATCH');
  });

  /*
   * NO ORACLE. "The ciphertext is valid, it just belongs to another row" tells
   * whoever read the column that they hold a usable session and need only the
   * right row id. Wrong key, tampered bytes and a foreign row therefore all
   * produce one refusal with one sentence.
   */
  it('answers a wrong key, a tampered payload and a foreign row identically', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);

    const foreign = await openSession({
      row: { ...stored, id: 'other' },
      keys: [ACTIVE_KEY],
      cipher,
    });
    const otherKeyCipher = realCipher();
    const wrongKey = await openSession({ row: stored, keys: [ACTIVE_KEY], cipher: otherKeyCipher });
    const head = stored.storageStateSealed!.split('.').slice(0, 4).join('.');
    const payload = stored.storageStateSealed!.split('.')[4]!;
    const flipped = `${head}.${payload.slice(0, -4)}AAAA`;
    const tampered = await openSession({
      row: { ...stored, storageStateSealed: flipped },
      keys: [ACTIVE_KEY],
      cipher,
    });

    for (const result of [foreign, wrongKey, tampered]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe('AAD_MISMATCH');
      expect(result.detail).toBe(
        'The sealed session did not open: the key, the ciphertext and the row it is bound to do ' +
          'not agree. Which of the three is wrong is deliberately not reported.',
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Never logging what it protects
// ─────────────────────────────────────────────────────────────────────────────

describe('reporting a failure without quoting the secret', () => {
  it('returns an OpenedSecret whose plaintext survives no serialisation', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);
    const opened = await openSession({ row: stored, keys: [ACTIVE_KEY], cipher });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.value).toBeInstanceOf(OpenedSecret);
    const written = [
      JSON.stringify(opened),
      JSON.stringify({ ...opened.value }),
      String(opened.value),
      `${opened.value}`,
      Object.values(opened.value).join(' '),
    ].join('\n');
    expect(written).not.toContain(COOKIE_VALUE);
    expect(written).toContain(SECRET_MASK);
  });

  /*
   * EVERY refusal this module can produce, each one checked for the plaintext
   * AND for the envelope payload. The payload is ciphertext, which is not a
   * plaintext — and it is still the thing an attacker wants out of a log,
   * because it is half of a session that only needs a key.
   */
  it('quotes neither the session nor the ciphertext in ANY refusal detail', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);
    const payload = stored.storageStateSealed!.split('.')[4]!;

    const refusals = [
      await openSession({ row: row(), keys: [ACTIVE_KEY], cipher }),
      await openSession({
        row: { ...stored, storageStateSealed: 'not-an-envelope' },
        keys: [ACTIVE_KEY],
        cipher,
      }),
      await openSession({
        row: { ...stored, storageStateKeyVersion: 2 },
        keys: [ACTIVE_KEY],
        cipher,
      }),
      await openSession({ row: stored, keys: [], cipher }),
      await openSession({
        row: stored,
        keys: [{ ...ACTIVE_KEY, state: 'COMPROMISED' }],
        cipher,
      }),
      await openSession({ row: stored, keys: [{ ...ACTIVE_KEY, state: 'RETIRED' }], cipher }),
      await openSession({ row: { ...stored, id: 'elsewhere' }, keys: [ACTIVE_KEY], cipher }),
      await sealSession({
        profileId: 'prof1',
        storageState: SESSION,
        expiresAt: NOW,
        keys: [],
        cipher,
        now: NOW,
      }),
      await sealSession({
        profileId: 'prof1',
        storageState: SESSION,
        expiresAt: NOW,
        keys: [ACTIVE_KEY, { keyId: 'local-2', version: 2, state: 'ACTIVE' }],
        cipher,
        now: NOW,
      }),
    ];

    for (const result of refusals) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.detail).not.toContain(COOKIE_VALUE);
      expect(result.detail).not.toContain(payload);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports a decrypted value that is not a session by LENGTH and nothing else', async () => {
    const notASession = `the-plaintext-${COOKIE_VALUE}`;
    const cipher: SessionCipher = {
      encrypt: async () => Buffer.from('x').toString('base64'),
      decrypt: async () => notASession,
    };
    const stored = await sealedRow('prof1', cipher);
    const opened = await openSession({ row: stored, keys: [ACTIVE_KEY], cipher });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.refusal).toBe('NOT_A_SESSION');
    expect(opened.detail).not.toContain(COOKIE_VALUE);
    expect(opened.detail).toContain(String(notASession.length));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The eight states
// ─────────────────────────────────────────────────────────────────────────────

describe('what a stored session is', () => {
  it('names every state with a rule, in both directions', () => {
    expect([...SESSION_STATES].sort()).toEqual(Object.keys(SESSION_STATE_RULES).sort());
    for (const state of SESSION_STATES) {
      expect(SESSION_STATE_RULES[state].why.length).toBeGreaterThan(20);
    }
  });

  it('reads a null expiry as unusable, NOT as valid forever', () => {
    // The defect verbatim: every old reader spelt `!expiresAt || expiresAt > now`.
    const state = sessionStateOf(
      row({ storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: 1 }),
      NOW,
    );
    expect(state).toBe('SEALED_NO_EXPIRY');
    expect(SESSION_STATE_RULES[state].usable).toBe(false);
  });

  it('separates expired, expiring and fresh on the refresh lead', () => {
    const sealed = { storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: 1 };
    const at = (ms: number): SessionState =>
      sessionStateOf(row({ ...sealed, storageStateExpiresAt: new Date(NOW.getTime() + ms) }), NOW);

    expect(at(-1)).toBe('SEALED_EXPIRED');
    expect(at(0)).toBe('SEALED_EXPIRED');
    expect(at(SESSION_REFRESH_LEAD_MS)).toBe('SEALED_EXPIRING');
    expect(at(SESSION_REFRESH_LEAD_MS + 1)).toBe('SEALED_FRESH');
  });

  /*
   * PRECEDENCE, AND WHY PLAINTEXT WINS.
   *
   * The sealing migration nulled every plaintext column, so a non-null value
   * means a writer from before this slice has run since — which makes the
   * plaintext the NEWER session and the sealed one stale. Refusing both and
   * refreshing is the only answer that neither reads the plaintext nor carries
   * a session we already know is out of date.
   */
  it('reports LEGACY_PLAINTEXT even when a perfectly good sealed session sits beside it', async () => {
    const stored = await sealedRow('prof1', realCipher());
    expect(sessionStateOf(stored, NOW)).toBe('SEALED_FRESH');
    expect(sessionStateOf({ ...stored, storageState: SESSION }, NOW)).toBe('LEGACY_PLAINTEXT');
  });

  it('puts needsReseal ahead of a sealed value, so a marked row is never used', async () => {
    const stored = await sealedRow('prof1', realCipher());
    expect(sessionStateOf({ ...stored, storageStateNeedsReseal: true }, NOW)).toBe('NEEDS_RESEAL');
  });

  it('refuses a sealed row whose key-version column is null, which a sweep would skip', async () => {
    const stored = await sealedRow('prof1', realCipher());
    expect(sessionStateOf({ ...stored, storageStateKeyVersion: null }, NOW)).toBe(
      'SEALED_UNVERSIONED',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE — the headline
// ─────────────────────────────────────────────────────────────────────────────

describe('the gate', () => {
  /*
   * ── THE TEST THAT STOPS THE DEFECT COMING BACK ──────────────────────────
   *
   * This is the one to read. Before this slice, an expired session produced
   * `null`, `null` produced `{ ok: true, storageState: null }`, and the run
   * went ANONYMOUS and reported a pass — so every auth-gated route it touched
   * looked covered by a test that was never signed in.
   */
  it('reports a typed NOT_RUN for an expired session and NEVER permits an anonymous run', () => {
    const expired = row({
      storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
      storageStateKeyVersion: 1,
      storageStateExpiresAt: new Date(NOW.getTime() - 1),
    });
    const gate = sessionGate(expired, { now: NOW, mode: 'ENFORCE' });

    expect(gate.state).toBe('SEALED_EXPIRED');
    expect(gate.usable).toBe(false);
    expect(gate.anonymousPermitted).toBe(false);
    expect(gate.notRun).not.toBeNull();
    expect(gate.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(gate.notRun?.why).toContain('NOT RUN');
    expect(gate.refreshDue).toBe(true);
  });

  /*
   * The coverage half of the same defect, asserted as the property a
   * denominator depends on: BLOCKED_BY_ENV is the kind NOT_RUN_KINDS says must
   * be EXCLUDED from a pass rate and a coverage denominator. Every unusable
   * state reports it, so there is no state for which an un-run auth-gated test
   * can be scored as evidence about the application.
   */
  it('reports BLOCKED_BY_ENV for every unusable state, so no un-run test enters a denominator', () => {
    const cases: Array<[SessionState, SealedSessionRow]> = [
      ['LEGACY_PLAINTEXT', row({ storageState: SESSION })],
      ['NEEDS_RESEAL', row({ storageStateNeedsReseal: true })],
      ['ABSENT', row()],
      [
        'SEALED_UNVERSIONED',
        row({ storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: null }),
      ],
      [
        'SEALED_NO_EXPIRY',
        row({ storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: 1 }),
      ],
      [
        'SEALED_EXPIRED',
        row({
          storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
          storageStateKeyVersion: 1,
          storageStateExpiresAt: new Date(NOW.getTime() - 1),
        }),
      ],
    ];
    for (const [expected, candidate] of cases) {
      const gate = sessionGate(candidate, { now: NOW, mode: 'ENFORCE' });
      expect(gate.state).toBe(expected);
      expect(gate.usable).toBe(false);
      expect(gate.notRun?.kind).toBe('BLOCKED_BY_ENV');
      expect(gate.anonymousPermitted).toBe(false);
    }

    /*
     * The table above covers every unusable state, checked against the rules
     * rather than against a count — so a ninth unusable state is a failure
     * here instead of a state nobody asserted. A loop over SESSION_STATES that
     * built the same row each time would have passed while proving one case.
     */
    const unusable = SESSION_STATES.filter((state) => !SESSION_STATE_RULES[state].usable);
    expect(cases.map(([state]) => state).sort()).toEqual([...unusable].sort());
  });

  it('uses a session that is expiring inside the lead rather than refusing it', () => {
    const expiring = row({
      storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
      storageStateKeyVersion: 1,
      storageStateExpiresAt: new Date(NOW.getTime() + SESSION_REFRESH_LEAD_MS - 1),
    });
    const gate = sessionGate(expiring, { now: NOW, mode: 'ENFORCE' });
    expect(gate.state).toBe('SEALED_EXPIRING');
    expect(gate.usable).toBe(true);
    expect(gate.refreshDue).toBe(true);
    expect(gate.notRun).toBeNull();
  });

  /*
   * THE INVARIANT. Across every state and both modes, exactly one of the three
   * answers is operative. A ninth state added with no rule is a compile error;
   * a ninth state added with a rule that says both "usable" and "not run" is
   * this test.
   */
  it('gives exactly one operative answer for every state in every mode', () => {
    const rows: SealedSessionRow[] = [
      row(),
      row({ storageState: SESSION }),
      row({ storageStateNeedsReseal: true }),
      row({ storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: null }),
      row({ storageStateSealed: 'qs1.a.1.AES_256_GCM.AA', storageStateKeyVersion: 1 }),
      row({
        storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
        storageStateKeyVersion: 1,
        storageStateExpiresAt: new Date(NOW.getTime() - 1),
      }),
      row({
        storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
        storageStateKeyVersion: 1,
        storageStateExpiresAt: new Date(NOW.getTime() + 10),
      }),
      row({
        storageStateSealed: 'qs1.a.1.AES_256_GCM.AA',
        storageStateKeyVersion: 1,
        storageStateExpiresAt: new Date(NOW.getTime() + 10 * HOUR),
      }),
    ];
    const seen = new Set<SessionState>();
    for (const candidate of rows) {
      for (const mode of ['ENFORCE', 'OBSERVE'] as const) {
        const gate = sessionGate(candidate, { now: NOW, mode });
        seen.add(gate.state);
        const answers = [gate.usable, gate.notRun !== null, gate.anonymousPermitted];
        expect(answers.filter(Boolean)).toHaveLength(1);
        expect(gate.fault === null).toBe(gate.usable);
      }
    }
    // Every state is actually exercised, so the invariant is not vacuous.
    expect([...seen].sort()).toEqual([...SESSION_STATES].sort());
  });

  /*
   * THE BRAKE. OBSERVE is the mode that lets a working deployment keep running
   * while the count is read, and `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL`
   * promises that count: "every run that would have been reported NOT_RUN and
   * instead went anonymous, per profile".
   */
  it('permits the anonymous run under OBSERVE, and reports no NOT_RUN for it', () => {
    const gate = sessionGate(row(), { now: NOW, mode: 'OBSERVE' });
    expect(gate.anonymousPermitted).toBe(true);
    expect(gate.notRun).toBeNull();
    expect(gate.usable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The count
// ─────────────────────────────────────────────────────────────────────────────

describe('counting what the brake let through', () => {
  it('counts degradations, blocks and uses per profile and per state, with a denominator', async () => {
    const tallies = new Map<string, SessionDegradationTally>();
    const fresh = await sealedRow('prof1', realCipher());

    countSessionGate(tallies, 'prof1', sessionGate(row(), { now: NOW, mode: 'OBSERVE' }), 'ANONYMOUS');
    countSessionGate(tallies, 'prof1', sessionGate(row(), { now: NOW, mode: 'OBSERVE' }), 'ANONYMOUS');
    countSessionGate(tallies, 'prof1', sessionGate(row(), { now: NOW, mode: 'ENFORCE' }), 'REFUSED');
    countSessionGate(tallies, 'prof1', sessionGate(fresh, { now: NOW, mode: 'ENFORCE' }), 'USED');
    countSessionGate(
      tallies,
      'prof2',
      sessionGate(row({ storageState: SESSION }), { now: NOW, mode: 'OBSERVE' }),
      'USED',
    );

    expect(tallies.get(sessionTallyKey('prof1', 'ABSENT'))).toEqual({
      profileId: 'prof1',
      state: 'ABSENT',
      degraded: 2,
      blocked: 1,
      used: 0,
      signedIn: 0,
      wouldSeal: 0,
    });
    expect(sessionDegradation(tallies.values())).toEqual({
      degraded: 2,
      blocked: 1,
      used: 2,
      signedIn: 0,
      wouldSeal: 0,
      total: 5,
    });
  });

  /**
   * THE DEFECT THIS PARAMETER EXISTS FOR, PINNED.
   *
   * The outcome used to be DERIVED from the gate: `used` from `gate.usable`,
   * `blocked` from `gate.notRun !== null`. MEASURED on this tree, a
   * `LEGACY_PLAINTEXT` row under ENFORCE is CARRIED by `openCachedSession` and
   * the run goes ahead signed in as the identity, while that derivation tallied
   * `{degraded: 0, blocked: 1, used: 0}` — a run reported as REFUSED that ran.
   *
   * An operator reads `blocked` to decide whether arming the brake will break
   * anything. Those runs are precisely the ones that keep working in both
   * modes, so the number said the opposite of the truth about itself.
   */
  it('counts a CARRIED legacy session as USED even though the gate reports notRun', () => {
    const legacy = row({
      storageState: SESSION,
      storageStateExpiresAt: new Date(NOW.getTime() + 4 * HOUR),
    });
    const gate = sessionGate(legacy, { now: NOW, mode: 'ENFORCE' });

    // The gate's own verdict, unchanged: it refuses to VOUCH for the row.
    expect(gate.usable).toBe(false);
    expect(gate.notRun?.kind).toBe('BLOCKED_BY_ENV');

    // What the consumer did with it, which is what the tally reports.
    const tallies = new Map<string, SessionDegradationTally>();
    countSessionGate(tallies, 'prof1', gate, 'USED');
    expect(sessionDegradation(tallies.values())).toMatchObject({
      used: 1,
      blocked: 0,
      degraded: 0,
    });
  });

  /**
   * The sweep's worklist is NOT the run-side anonymous count.
   *
   * Both went into `degraded`, so one field meant "runs that went anonymous" in
   * run.ts and explore.ts and "profiles a seal would replace" in
   * auth-refresh.ts — two facts in one number, read by the same operator.
   */
  it('keeps the sweep worklist in its own bucket, out of `degraded`', () => {
    const tallies = new Map<string, SessionDegradationTally>();
    const gate = sessionGate(row({ storageState: SESSION }), { now: NOW, mode: 'OBSERVE' });

    countSessionGate(tallies, 'prof1', gate, 'WOULD_SEAL');

    const totals = sessionDegradation(tallies.values());
    expect(totals.wouldSeal).toBe(1);
    expect(totals.degraded).toBe(0);
    // And it is still in the denominator: a worklist with no "out of how many"
    // is the kind of number that cannot be defended.
    expect(totals.total).toBe(1);
  });

  /**
   * EVERY MEMBER LANDS IN EXACTLY ONE BUCKET, so the denominator is the number
   * of decisions made. A member added to the vocabulary and not to the counter
   * would silently vanish from `total` and inflate every ratio read off it.
   */
  it('puts every outcome in exactly one bucket and loses none from the total', () => {
    for (const outcome of SESSION_GATE_OUTCOMES) {
      const tallies = new Map<string, SessionDegradationTally>();
      countSessionGate(tallies, 'prof1', sessionGate(row(), { now: NOW, mode: 'ENFORCE' }), outcome);
      const totals = sessionDegradation(tallies.values());
      expect(totals.total).toBe(1);
      const buckets = [totals.degraded, totals.blocked, totals.used, totals.signedIn, totals.wouldSeal];
      expect(buckets.filter((n) => n === 1)).toHaveLength(1);
    }
  });

  it('keys a tally on the profile and the state and nothing finer', () => {
    expect(sessionTallyKey('prof1', 'ABSENT')).not.toBe(sessionTallyKey('prof1', 'NEEDS_RESEAL'));
    expect(sessionTallyKey('prof1', 'ABSENT')).not.toBe(sessionTallyKey('prof2', 'ABSENT'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The keys
// ─────────────────────────────────────────────────────────────────────────────

describe('reading the key table', () => {
  it('reads keys through a select that names every field the decision needs', async () => {
    const read = await readVaultKeys(
      vaultKeyDb([
        { keyId: 'local-2', version: 2, state: 'ACTIVE', note: 'rotated in' },
        { keyId: 'local-1', version: 1, state: 'READABLE', note: 'rotated out' },
      ]),
    );
    expect(read.keys).toEqual([
      { keyId: 'local-1', version: 1, state: 'READABLE' },
      { keyId: 'local-2', version: 2, state: 'ACTIVE' },
    ]);
    expect(read.unreadableVersions).toEqual([]);
  });

  /*
   * A SELECT-BLIND READ MUST NOT BECOME A PERMISSIVE ONE.
   *
   * The fake honours `select`, so dropping `state: true` from the production
   * query produces rows with no state here — and the rule is that a key whose
   * permissions cannot be read seals nothing and opens nothing. The failure
   * direction is what matters: `undefined` treated as truthy would have made a
   * COMPROMISED key work.
   */
  it('excludes a key whose state it cannot read, and REPORTS the version it excluded', () => {
    const read = vaultKeysFrom([
      { keyId: 'local-1', version: 1 },
      { keyId: 'local-2', version: 2, state: 'NOT_A_STATE' },
      { keyId: 'local-3', version: 3, state: 'ACTIVE' },
    ]);
    expect(read.keys).toEqual([{ keyId: 'local-3', version: 3, state: 'ACTIVE' }]);
    expect(read.unreadableVersions).toEqual([1, 2]);
  });

  it('refuses to seal when the only key has an unreadable state, rather than guessing', async () => {
    const read = vaultKeysFrom([{ keyId: 'local-1', version: 1, state: 'not-a-state' }]);
    const sealed = await sealSession({
      profileId: 'prof1',
      storageState: SESSION,
      expiresAt: NOW,
      keys: read.keys,
      cipher: realCipher(),
      now: NOW,
    });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.refusal).toBe('NO_WRITABLE_KEY');
  });

  /*
   * THE DENORMALISED COLUMN AND THE ENVELOPE MUST AGREE.
   *
   * The integer column is how a rotation sweep finds rows, so the direction of
   * a drift decides the damage: a row whose column says 2 while its envelope
   * says 1 is a row the sweep SKIPS and a compromised key goes on opening. The
   * envelope alone would have been enough to decrypt it, which is exactly why
   * this has to be a refusal rather than a preference for one of the numbers.
   */
  it('REFUSES a row whose key-version column disagrees with its envelope', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);
    const drifted = await openSession({
      row: { ...stored, storageStateKeyVersion: 2 },
      keys: [ACTIVE_KEY, { keyId: 'local-2', version: 2, state: 'READABLE' }],
      cipher,
    });
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.refusal).toBe('VERSION_COLUMN_DISAGREES');
    expect(drifted.detail).toContain('version 1');
  });

  it('opens a value under a READABLE key, which is what makes rotation possible', async () => {
    const cipher = realCipher();
    const stored = await sealedRow('prof1', cipher);
    const opened = await openSession({
      row: stored,
      keys: [
        { keyId: 'local-1', version: 1, state: 'READABLE' },
        { keyId: 'local-2', version: 2, state: 'ACTIVE' },
      ],
      cipher,
    });
    expect(opened.ok).toBe(true);
  });

  it('refuses a key version this process holds no material for, by name', async () => {
    const cipher = localSessionCipher(() => null);
    const sealed = await sealSession({
      profileId: 'prof1',
      storageState: SESSION,
      expiresAt: NOW,
      keys: [ACTIVE_KEY],
      cipher,
      now: NOW,
    });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.refusal).toBe('UNKNOWN_KEY_VERSION');
    expect(sealed.detail).toContain('version 1');
  });

  it('refuses a master key that is not 32 bytes, at construction', () => {
    expect(() => masterKeyResolver(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The projections
// ─────────────────────────────────────────────────────────────────────────────

describe('the projections', () => {
  /*
   * A HAND-COPIED PROJECTION INSIDE A FUNCTION IS THE SAME HAZARD AS A
   * SELECT-BLIND FAKE, and it is the one that shipped: an internal map typed
   * `{ key, status, label }` re-listed those three fields and dropped the
   * fourth. The `satisfies` in the source is the compile-time half; this is the
   * run-time half, so a field added to the row type and not to the select
   * cannot pass both.
   */
  it('selects every field of the row the gate decides on', () => {
    const fields: Array<keyof SealedSessionRow> = [
      'id',
      'storageState',
      'storageStateExpiresAt',
      'storageStateSealed',
      'storageStateKeyVersion',
      'storageStateNeedsReseal',
    ];
    expect(Object.keys(SESSION_ROW_SELECT).sort()).toEqual([...fields].sort());
    expect(Object.values(SESSION_ROW_SELECT).every((v) => v === true)).toBe(true);
  });

  it('selects every field of a key the sealing decision needs', () => {
    const fields: Array<keyof VaultKeyRef> = ['keyId', 'version', 'state'];
    expect(Object.keys(VAULT_KEY_SELECT).sort()).toEqual([...fields].sort());
  });

  it('names a distinct refusal for each row-level failure', () => {
    expect(new Set(SESSION_REFUSALS).size).toBe(SESSION_REFUSALS.length);
  });
});
