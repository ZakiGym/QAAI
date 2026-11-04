import { describe, expect, it } from 'vitest';
import {
  KEY_ROTATION_STATES,
  OpenedSecret,
  RESUMABLE_ROTATION_STATES,
  SEALED_FIELDS,
  SEALED_FIELD_KEYS,
  SEAL_ALGORITHMS,
  SEAL_ENVELOPE_PREFIX,
  SEAL_REFUSALS,
  SEAL_WRITE_ALGORITHM,
  VAULT_KEY_PROVIDERS,
  VAULT_KEY_STATES,
  VAULT_KEY_STATE_RULES,
  aadFor,
  envelopeMatchesVersionColumn,
  isSealedFieldKey,
  parseEnvelope,
  resealVerdict,
  revealSecret,
  selectOpeningKey,
  selectSealingKey,
  serialiseEnvelope,
  useSecret,
} from './sealed';
import type { SealedEnvelope, VaultKeyRef } from './sealed';
import { SECRET_MASK } from './constants';

/**
 * The sealed-value envelope, its key versions, and the type that refuses to be
 * logged.
 *
 * NO KEY MATERIAL AND NO KEY-SHAPED LITERAL APPEARS IN THIS FILE. The payloads
 * below are composed at run time from obviously-fake parts and are valid base64
 * only because the parser checks that; none of them is or resembles a key, a
 * token or a provider credential. A finished green commit was once rejected by
 * push protection for a literal inside the comment explaining its own removal.
 */

/** Valid base64 by the parser's alphabet, and obviously not a payload. */
const FAKE_PAYLOAD = ['not', 'a', 'real', 'payload'].join('');
const KEY_ID = ['vk', 'fake', 'one'].join('');

function envelope(overrides: Partial<SealedEnvelope> = {}): SealedEnvelope {
  return {
    keyId: KEY_ID,
    keyVersion: 1,
    alg: SEAL_WRITE_ALGORITHM,
    payload: FAKE_PAYLOAD,
    ...overrides,
  };
}

const keys = (
  ...rows: Array<[version: number, state: VaultKeyRef['state']]>
): VaultKeyRef[] => rows.map(([version, state]) => ({ keyId: `${KEY_ID}${version}`, version, state }));

describe('the key-state rules', () => {
  it('names every state, in both halves', () => {
    // The compile-time half is the `satisfies Record<VaultKeyState, …>` in the
    // module; this is the run-time half. One without the other passes while the
    // two disagree, which is how eight GateRule kinds shipped unsaveable.
    expect(Object.keys(VAULT_KEY_STATE_RULES).sort()).toEqual([...VAULT_KEY_STATES].sort());
  });

  it('makes EXACTLY ONE state writable, which is what makes rotation possible', () => {
    const writable = VAULT_KEY_STATES.filter((state) => VAULT_KEY_STATE_RULES[state].canSeal);
    expect(writable).toEqual(['ACTIVE']);
  });

  it('lets a rotated-out key keep READING, which is the whole mechanism', () => {
    // If READABLE could not open, rotation would be a flag day and every value
    // under the old key would be unreadable the moment the key changed — which
    // is precisely the state vault.ts is in today.
    expect(VAULT_KEY_STATE_RULES.READABLE.canOpen).toBe(true);
    expect(VAULT_KEY_STATE_RULES.READABLE.canSeal).toBe(false);
  });

  it('refuses to open under a RETIRED or COMPROMISED key', () => {
    expect(VAULT_KEY_STATE_RULES.RETIRED.canOpen).toBe(false);
    expect(VAULT_KEY_STATE_RULES.COMPROMISED.canOpen).toBe(false);
  });

  it('separates an incident from a retirement', () => {
    // One state for both would make "we rotated" and "we were breached" the
    // same fact, which is the fact an auditor is asking about.
    expect(VAULT_KEY_STATE_RULES.COMPROMISED.isIncident).toBe(true);
    expect(VAULT_KEY_STATE_RULES.RETIRED.isIncident).toBe(false);
  });

  it('keeps the two terminal rotation states out of the resumable list', () => {
    expect([...RESUMABLE_ROTATION_STATES]).not.toContain('COMPLETED');
    expect(RESUMABLE_ROTATION_STATES.every((s) => KEY_ROTATION_STATES.includes(s))).toBe(true);
    // FAILED is resumable on purpose: it keeps its cursor, which is the
    // difference between resuming a sweep and re-running one.
    expect([...RESUMABLE_ROTATION_STATES]).toContain('FAILED');
  });
});

describe('the sealed-field vocabulary', () => {
  it('has the same keys in the tuple and in the object', () => {
    // A fourth sealed field added to one and not the other is a field no write
    // path can name — or, worse, a field no rotation sweep will ever visit,
    // which is a row that stays readable under a compromised key for ever.
    expect([...SEALED_FIELD_KEYS].sort()).toEqual(Object.keys(SEALED_FIELDS).sort());
  });

  it('names the session cache this round seals', () => {
    expect([...SEALED_FIELD_KEYS]).toContain('AuthProfile.storageState');
  });

  it('narrows, so a caller cannot guess a field key', () => {
    expect(isSealedFieldKey('AuthProfile.storageState')).toBe(true);
    expect(isSealedFieldKey('AuthProfile.config')).toBe(false);
    expect(isSealedFieldKey('__proto__')).toBe(false);
  });

  it('binds a ciphertext to the model, the row AND the field', () => {
    const a = aadFor({ fieldKey: 'AuthProfile.storageState', rowId: 'profile-a' });
    const b = aadFor({ fieldKey: 'AuthProfile.storageState', rowId: 'profile-b' });
    const c = aadFor({ fieldKey: 'User.totpSecretEnc', rowId: 'profile-a' });
    // THE MOVE THIS PREVENTS: one AuthProfile's session pasted onto another.
    expect(a).not.toBe(b);
    // And the other move: a seed pasted over a session on the same id.
    expect(a).not.toBe(c);
  });

  it('cannot compose two distinct bindings to the same string', () => {
    // `a:b` + `c` and `a` + `b:c` are the same AAD with a colon separator, and
    // "the same AAD" is exactly what must not happen by accident.
    const weird = aadFor({ fieldKey: 'Secret.valueEnc', rowId: 'x\u001fy' });
    const plain = aadFor({ fieldKey: 'Secret.valueEnc', rowId: 'x' });
    expect(weird).not.toBe(plain);
    expect(aadFor({ fieldKey: 'Secret.valueEnc', rowId: 'a' }).split('\u001f')).toHaveLength(3);
  });
});

describe('the envelope round-trips, and refuses everything else', () => {
  it('serialises and parses the same values back', () => {
    const parsed = parseEnvelope(serialiseEnvelope(envelope()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(envelope());
  });

  it('refuses a value from a FUTURE build by name, rather than guessing', () => {
    // A downgrade is the normal shape of a rollback, and a rollback must fail
    // loudly: handing a future layout to a cipher produces bytes, not an error.
    const future = serialiseEnvelope(envelope()).replace(SEAL_ENVELOPE_PREFIX, 'qs2');
    const parsed = parseEnvelope(future);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal).toBe('UNKNOWN_ENVELOPE_VERSION');
  });

  it('refuses a cipher it does not have WITHOUT attempting it', () => {
    const parsed = parseEnvelope(
      serialiseEnvelope(envelope()).replace(SEAL_WRITE_ALGORITHM, 'ROT13'),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal).toBe('UNKNOWN_ALGORITHM');
      expect(parsed.detail).toContain('NOT attempted');
    }
  });

  it('refuses a key version that a lenient parser would read as a number', () => {
    // `Number.parseInt('1x')` is 1, and a key version is the one field where a
    // lenient parse selects the WRONG key and still succeeds.
    for (const bad of ['1x', '01', '0', '-1', '1.5', '']) {
      const parsed = parseEnvelope(
        [SEAL_ENVELOPE_PREFIX, KEY_ID, bad, SEAL_WRITE_ALGORITHM, FAKE_PAYLOAD].join('.'),
      );
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it('refuses a non-string, an empty string and the wrong number of parts', () => {
    for (const bad of [undefined, null, 42, {}, '', 'qs1.a.b', `${SEAL_ENVELOPE_PREFIX}.a.1.x.y.z`]) {
      expect(parseEnvelope(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('NEVER QUOTES THE PAYLOAD IN A REFUSAL, on any path', () => {
    // An error about a secret must be reportable without quoting any part of
    // it. Not truncated, not hashed, not in an error path. This asserts it for
    // every refusal the parser can produce, including the AAD-shaped ones.
    const payload = ['zzz', 'secretish', 'zzz'].join('');
    const candidates = [
      `qs2.${KEY_ID}.1.${SEAL_WRITE_ALGORITHM}.${payload}`,
      `${SEAL_ENVELOPE_PREFIX}.${KEY_ID}.1.ROT13.${payload}`,
      `${SEAL_ENVELOPE_PREFIX}.${KEY_ID}.0.${SEAL_WRITE_ALGORITHM}.${payload}`,
      `${SEAL_ENVELOPE_PREFIX}.${KEY_ID}.1.${SEAL_WRITE_ALGORITHM}.not!base64`,
      `${SEAL_ENVELOPE_PREFIX}.not a key id.1.${SEAL_WRITE_ALGORITHM}.${payload}`,
    ];
    for (const candidate of candidates) {
      const parsed = parseEnvelope(candidate);
      expect(parsed.ok, candidate).toBe(false);
      if (!parsed.ok) {
        expect(parsed.detail, candidate).not.toContain(payload);
        expect(parsed.detail, candidate).not.toContain('secretish');
      }
    }
  });

  it('catches the denormalised version column drifting ahead of the envelope', () => {
    // The dangerous direction: a row whose column says 2 while its envelope
    // says 1 is a row a sweep SKIPS and a compromised key keeps opening.
    expect(envelopeMatchesVersionColumn(envelope({ keyVersion: 1 }), 2)).toBe(false);
    expect(envelopeMatchesVersionColumn(envelope({ keyVersion: 1 }), null)).toBe(false);
    expect(envelopeMatchesVersionColumn(envelope({ keyVersion: 1 }), 1)).toBe(true);
  });

  it('declares one algorithm today, and it is the one it writes', () => {
    expect([...SEAL_ALGORITHMS]).toContain(SEAL_WRITE_ALGORITHM);
    expect([...VAULT_KEY_PROVIDERS]).toEqual(['LOCAL', 'KMS']);
  });
});

describe('choosing a key fails closed', () => {
  it('REFUSES an unknown key version instead of trying another key', () => {
    // THE fail-closed heart of the file. vault.ts today throws
    // `No vault key registered for version N` from inside the decrypt path;
    // this refuses before anything is attempted and says so.
    const result = selectOpeningKey(envelope({ keyVersion: 7 }), keys([1, 'ACTIVE']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('UNKNOWN_KEY_VERSION');
      expect(result.detail).toContain('NOT');
    }
  });

  it('reports a COMPROMISED key separately from an unreadable one', () => {
    const compromised = selectOpeningKey(envelope(), keys([1, 'COMPROMISED']));
    const retired = selectOpeningKey(envelope(), keys([1, 'RETIRED']));
    expect(compromised.ok).toBe(false);
    expect(retired.ok).toBe(false);
    if (!compromised.ok) expect(compromised.refusal).toBe('KEY_COMPROMISED');
    // Collapsing these two would make the difference between a mistake and a
    // breach a matter of inference.
    if (!retired.ok) expect(retired.refusal).toBe('KEY_NOT_READABLE');
  });

  it('opens under a READABLE key, which is rotation working', () => {
    const result = selectOpeningKey(envelope({ keyVersion: 1 }), keys([1, 'READABLE'], [2, 'ACTIVE']));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(1);
  });

  it('refuses to seal when nothing is ACTIVE, and does NOT fall back', () => {
    const result = selectSealingKey(keys([1, 'READABLE'], [2, 'RETIRED']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('NO_WRITABLE_KEY');
  });

  it('refuses to seal when TWO keys are ACTIVE', () => {
    // Half the rows written today would be openable only by one of them and
    // nobody could say which half.
    const result = selectSealingKey(keys([1, 'ACTIVE'], [2, 'ACTIVE']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('MORE_THAN_ONE_WRITABLE_KEY');
  });

  it('refuses to seal with no keys at all', () => {
    expect(selectSealingKey([]).ok).toBe(false);
  });

  it('has a refusal for every documented failure, with no UNKNOWN member', () => {
    expect([...SEAL_REFUSALS]).not.toContain('UNKNOWN');
    expect(new Set(SEAL_REFUSALS).size).toBe(SEAL_REFUSALS.length);
  });
});

describe('the re-seal verdict carries two facts, not one', () => {
  it('calls a compromised key URGENT and a superseded one merely needed', () => {
    // `verified` was once true for a heal that left the test red; both readings
    // were defensible and the field still lied. A sweep that cannot put the
    // incident first is a sweep that re-seals the backlog while the breach
    // waits.
    const compromised = resealVerdict(envelope({ keyVersion: 1 }), keys([1, 'COMPROMISED'], [2, 'ACTIVE']));
    const superseded = resealVerdict(envelope({ keyVersion: 1 }), keys([1, 'READABLE'], [2, 'ACTIVE']));
    expect(compromised).toMatchObject({ needed: true, urgent: true });
    expect(superseded).toMatchObject({ needed: true, urgent: false });
  });

  it('says a value under the ACTIVE key needs nothing', () => {
    expect(resealVerdict(envelope({ keyVersion: 2 }), keys([1, 'READABLE'], [2, 'ACTIVE']))).toMatchObject({
      needed: false,
      urgent: false,
    });
  });

  it('calls a value under a key this deployment does not have unrecoverable', () => {
    const verdict = resealVerdict(envelope({ keyVersion: 9 }), keys([1, 'ACTIVE']));
    expect(verdict).toMatchObject({ needed: true, urgent: true });
    expect(verdict.why).toContain('re-created');
  });
});

describe('an opened secret resists being written down', () => {
  const PLAINTEXT = ['this', 'is', 'the', 'plaintext'].join('-');
  const opened = new OpenedSecret(PLAINTEXT, {
    fieldKey: 'AuthProfile.storageState',
    rowId: 'profile-1',
  });

  it('masks a template literal and string concatenation', () => {
    expect(`${opened}`).toBe(SECRET_MASK);
    expect(`session=${opened}`).not.toContain(PLAINTEXT);
  });

  it('masks JSON.stringify, which is what most structured loggers are', () => {
    const json = JSON.stringify({ profile: opened });
    expect(json).not.toContain(PLAINTEXT);
    expect(json).toContain(SECRET_MASK);
  });

  it('masks a spread and Object.keys, so a log line cannot pick it up', () => {
    // THE STRUCTURAL HALF. The plaintext is not a property of the object, so
    // there is nothing for a spread to copy. A `#private` field would stop this
    // and not util.inspect; a masked getter would stop neither.
    expect(JSON.stringify({ ...opened })).not.toContain(PLAINTEXT);
    expect(Object.values(opened as unknown as Record<string, unknown>)).not.toContain(PLAINTEXT);
  });

  it("masks Node's inspect hook, which does not go through toJSON", () => {
    // `console.log` and `util.inspect` do not call `toJSON`, so without this
    // hook they would print the object's own shape.
    const hook = (opened as unknown as { [key: symbol]: unknown })[
      Symbol.for('nodejs.util.inspect.custom')
    ];
    expect(typeof hook).toBe('function');
    expect((hook as () => string).call(opened)).not.toContain(PLAINTEXT);
  });

  it('still reports enough to make a refusal actionable', () => {
    // An error about a secret must be reportable without quoting any part of it.
    expect(opened.fieldKey).toBe('AuthProfile.storageState');
    expect(opened.rowId).toBe('profile-1');
    expect(opened.bytes).toBe(PLAINTEXT.length);
  });

  it('hands the plaintext out of exactly two named functions', () => {
    expect(useSecret(opened, (value) => value)).toBe(PLAINTEXT);
    expect(revealSecret(opened)).toBe(PLAINTEXT);
  });

  it('does not swallow an exception thrown inside useSecret', () => {
    // Swallowing it would make a failure INSIDE a secret-using block look like
    // a failure to obtain the secret.
    expect(() =>
      useSecret(opened, () => {
        throw new Error('the block failed');
      }),
    ).toThrow('the block failed');
  });

  it('fails closed, and without quoting anything, once it has been serialised', () => {
    const revived = JSON.parse(JSON.stringify(opened)) as OpenedSecret;
    expect(() => useSecret(revived, (value) => value)).toThrow(/carries no plaintext/);
    try {
      useSecret(revived, (value) => value);
    } catch (err) {
      expect((err as Error).message).not.toContain(PLAINTEXT);
    }
  });
});
