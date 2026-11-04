import { describe, expect, it } from 'vitest';
import {
  apiKeyScopeSchema,
  baseUrlEgressProblem,
  controlModeSchema,
  createApiKeySchema,
  createEnvironmentSchema,
  createProjectSchema,
  createRunSchema,
  createSessionSchema,
  egressAllowlistEntrySchema,
  egressContextSchema,
  egressOutcomeSchema,
  egressPolicySchema,
  egressRefusalSchema,
  issueVerificationTokenSchema,
  keyRotationStateSchema,
  loginAttemptOutcomeSchema,
  recordLoginAttemptSchema,
  registerVaultKeySchema,
  revokeSessionSchema,
  roleChangeSchema,
  rotateApiKeySchema,
  sealAlgorithmSchema,
  sealedFieldKeySchema,
  sealedValueSchema,
  sealRefusalSchema,
  secretScopeKindSchema,
  secretScopeSchema,
  securityControlModesSchema,
  securityControlSchema,
  sessionRevocationReasonSchema,
  startKeyRotationSchema,
  totpEnrolmentSchema,
  updateEnvironmentSchema,
  vaultKeyProviderSchema,
  vaultKeyStateSchema,
  verificationTokenPurposeSchema,
} from './schemas';
import {
  API_KEY_SCOPES,
  CONTROL_MODES,
  LOGIN_ATTEMPT_OUTCOMES,
  SECRET_SCOPE_KINDS,
  SECURITY_CONTROLS,
  SESSION_REVOCATION_REASONS,
  VERIFICATION_TOKEN_PURPOSES,
} from './constants';
import {
  EGRESS_CONTEXTS,
  EGRESS_OUTCOMES,
  EGRESS_REFUSALS,
  HOSTED_EGRESS_POLICY,
  SELF_HOSTED_EGRESS_POLICY,
} from './egress';
import {
  KEY_ROTATION_STATES,
  SEALED_FIELD_KEYS,
  SEAL_ALGORITHMS,
  SEAL_REFUSALS,
  SEAL_WRITE_ALGORITHM,
  VAULT_KEY_PROVIDERS,
  VAULT_KEY_STATES,
  serialiseEnvelope,
} from './sealed';
import { classifyHost } from './private-address';

/**
 * The write paths that refuse.
 *
 * Each `describe` below names the defect it closes. The parity block is the
 * RUN-TIME half of each closed union's guard — and it is honest about what that
 * buys: every schema here is `z.enum(SAME_ARRAY)`, so `.options` is DERIVED and
 * the two cannot disagree. What the derivation buys is the other direction, that
 * a member added to a list is instantly storable, which is the half the
 * `GateRule` defect was missing when eight kinds shipped unsaveable.
 */

const FAKE_PAYLOAD = ['not', 'a', 'real', 'payload'].join('');
const KEY_ID = ['vk', 'fake'].join('');

describe('every closed union is storable, member for member', () => {
  it('derives its options from the same arrays', () => {
    expect(controlModeSchema.options).toEqual([...CONTROL_MODES]);
    expect(securityControlSchema.options).toEqual([...SECURITY_CONTROLS]);
    expect(egressContextSchema.options).toEqual([...EGRESS_CONTEXTS]);
    expect(egressOutcomeSchema.options).toEqual([...EGRESS_OUTCOMES]);
    expect(egressRefusalSchema.options).toEqual([...EGRESS_REFUSALS]);
    expect(vaultKeyStateSchema.options).toEqual([...VAULT_KEY_STATES]);
    expect(vaultKeyProviderSchema.options).toEqual([...VAULT_KEY_PROVIDERS]);
    expect(keyRotationStateSchema.options).toEqual([...KEY_ROTATION_STATES]);
    expect(sealAlgorithmSchema.options).toEqual([...SEAL_ALGORITHMS]);
    expect(sealRefusalSchema.options).toEqual([...SEAL_REFUSALS]);
    expect(sealedFieldKeySchema.options).toEqual([...SEALED_FIELD_KEYS]);
    expect(secretScopeKindSchema.options).toEqual([...SECRET_SCOPE_KINDS]);
    expect(loginAttemptOutcomeSchema.options).toEqual([...LOGIN_ATTEMPT_OUTCOMES]);
    expect(sessionRevocationReasonSchema.options).toEqual([...SESSION_REVOCATION_REASONS]);
    expect(verificationTokenPurposeSchema.options).toEqual([...VERIFICATION_TOKEN_PURPOSES]);
    expect(apiKeyScopeSchema.options).toEqual([...API_KEY_SCOPES]);
  });

  it('does not let a key name the wildcard scope', () => {
    // `'*'` is the sentinel `requireScope` hands a SESSION actor, who is a
    // human with a role. A key able to name it is the empty array with extra
    // steps.
    expect(apiKeyScopeSchema.options).not.toContain('*');
    expect(apiKeyScopeSchema.safeParse('*').success).toBe(false);
  });
});

describe('Environment.baseUrl: the credential that was guaranteed to be written down', () => {
  const ok = { name: 'staging', kind: 'STAGING' as const, baseUrl: 'https://app.example.com' };

  it('REFUSES a base URL carrying a username and password', () => {
    // `baseUrlOverride` (the PER-RUN version of this field, added later) has
    // carried this refusal since it was written and the STORED field did not —
    // and the stored one is the one the worker logs, every reporter prints and
    // the runner receives on every nightly run.
    const result = createEnvironmentSchema.safeParse({
      ...ok,
      baseUrl: 'https://admin:hunter2@app.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('refuses it on the PATCH path too', () => {
    // A create-path rule a PATCH can bypass is decorative.
    expect(
      updateEnvironmentSchema.safeParse({ baseUrl: 'https://admin:hunter2@app.example.com' })
        .success,
    ).toBe(false);
  });

  it('bounds the length, as the per-run override already did', () => {
    const long = `https://app.example.com/${'a'.repeat(2100)}`;
    expect(createEnvironmentSchema.safeParse({ ...ok, baseUrl: long }).success).toBe(false);
  });

  it('still accepts the ordinary case', () => {
    expect(createEnvironmentSchema.safeParse(ok).success).toBe(true);
  });

  it('refuses a non-http scheme, which it always did', () => {
    expect(createEnvironmentSchema.safeParse({ ...ok, baseUrl: 'file:///etc/passwd' }).success).toBe(
      false,
    );
  });
});

describe('baseUrlEgressProblem: the class half, decided without a resolver', () => {
  it('refuses an IMDS literal under the hosted policy', () => {
    const problem = baseUrlEgressProblem(classifyHost('169.254.169.254'), HOSTED_EGRESS_POLICY);
    expect(problem).not.toBeNull();
    expect(problem?.path).toEqual(['baseUrl']);
    expect(problem?.message).toContain('link-local');
  });

  it('refuses loopback when hosted and permits it when self-hosted', () => {
    expect(baseUrlEgressProblem(classifyHost('127.0.0.1'), HOSTED_EGRESS_POLICY)).not.toBeNull();
    expect(baseUrlEgressProblem(classifyHost('127.0.0.1'), SELF_HOSTED_EGRESS_POLICY)).toBeNull();
  });

  it('refuses an ambiguous host exactly as it refuses loopback', () => {
    for (const host of ['0177.0.0.1', '0x7f.0.0.1', '2130706433']) {
      expect(baseUrlEgressProblem(classifyHost(host), SELF_HOSTED_EGRESS_POLICY), host).not.toBeNull();
    }
  });

  it('returns null for a NAME, because nothing is decidable without a resolver', () => {
    // The caller must not read this as "the host is safe". It means the
    // resolver's verdict is still owed, and `decideEgress` is what owes it.
    expect(baseUrlEgressProblem(classifyHost('app.example.com'), HOSTED_EGRESS_POLICY)).toBeNull();
  });

  it('honours an allowlist entry for the crawl context', () => {
    const policy = {
      ...HOSTED_EGRESS_POLICY,
      allowlist: [
        {
          host: '10.0.0.5',
          contexts: ['CRAWL'] as const,
          ownerEmail: 'ops@example.com',
          reason: 'the staging app lives inside the VPN',
          expiresAt: null,
        },
      ],
    };
    expect(baseUrlEgressProblem(classifyHost('10.0.0.5'), policy)).toBeNull();
    expect(baseUrlEgressProblem(classifyHost('10.0.0.6'), policy)).not.toBeNull();
  });
});

describe('an API key with an empty scope array', () => {
  it('IS REFUSED, because today an empty array is a wildcard', () => {
    // apps/api/src/middleware/auth.ts reads
    // `scopes: key.scopes.length > 0 ? key.scopes : ['*']`.
    const result = createApiKeySchema.safeParse({ name: 'ci', scopes: [], expiresAt: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['scopes']);
  });

  it('refuses a scope no route will ever check', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'ci', scopes: ['tests:delete'], expiresAt: null }).success,
    ).toBe(false);
  });

  it('refuses a duplicate scope', () => {
    expect(
      createApiKeySchema.safeParse({
        name: 'ci',
        scopes: ['tests:read', 'tests:read'],
        expiresAt: null,
      }).success,
    ).toBe(false);
  });

  it('requires the expiry question to be ANSWERED, even if the answer is null', () => {
    // `null` is a considered choice; `undefined` is a creator who never thought
    // about it, which is how a key from 2019 is still in a pipeline.
    expect(createApiKeySchema.safeParse({ name: 'ci', scopes: ['tests:read'] }).success).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: 'ci', scopes: ['tests:read'], expiresAt: null }).success,
    ).toBe(true);
  });

  it('bounds a rotation grace window rather than letting it be forever', () => {
    expect(rotateApiKeySchema.safeParse({ graceMinutes: 60 * 24 * 8 }).success).toBe(false);
    expect(rotateApiKeySchema.parse({}).graceMinutes).toBe(0);
  });
});

describe('an ADMIN demoting an OWNER', () => {
  const base = { actorIsTarget: false };

  it('IS REFUSED', () => {
    // `requireRole('ADMIN')` guards the route and nothing compares the actor
    // against the TARGET, so an ADMIN could demote an OWNER and then be the
    // most senior member left.
    const result = roleChangeSchema.safeParse({
      ...base,
      actorRole: 'ADMIN',
      targetCurrentRole: 'OWNER',
      nextRole: 'VIEWER',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['targetCurrentRole']);
  });

  it('refuses a LATERAL change between two ADMINs', () => {
    // Strictly-exceeds, not at-least: an ADMIN demoting another ADMIN is
    // lateral, and lateral is the shape of one compromised account removing the
    // only check on it.
    expect(
      roleChangeSchema.safeParse({
        ...base,
        actorRole: 'ADMIN',
        targetCurrentRole: 'ADMIN',
        nextRole: 'MEMBER',
      }).success,
    ).toBe(false);
  });

  it('refuses granting a role at or above the actor’s own', () => {
    expect(
      roleChangeSchema.safeParse({
        ...base,
        actorRole: 'ADMIN',
        targetCurrentRole: 'MEMBER',
        nextRole: 'ADMIN',
      }).success,
    ).toBe(false);
    expect(
      roleChangeSchema.safeParse({
        ...base,
        actorRole: 'ADMIN',
        targetCurrentRole: 'MEMBER',
        nextRole: 'OWNER',
      }).success,
    ).toBe(false);
  });

  it('refuses a self-change outright, before the rank rule', () => {
    const result = roleChangeSchema.safeParse({
      actorIsTarget: true,
      actorRole: 'OWNER',
      targetCurrentRole: 'OWNER',
      nextRole: 'ADMIN',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('their own role');
  });

  it('permits an OWNER demoting an ADMIN, which is the legitimate case', () => {
    expect(
      roleChangeSchema.safeParse({
        ...base,
        actorRole: 'OWNER',
        targetCurrentRole: 'ADMIN',
        nextRole: 'MEMBER',
      }).success,
    ).toBe(true);
  });
});

describe('a TOTP enrolment marked confirmed with no verified code', () => {
  it('IS REFUSED', () => {
    // apps/api/src/routes/auth.ts reads
    // `if (user.totpEnabledAt && !input.totpCode) throw` and never looks at the
    // code again: presence is checked, the value is not.
    const result = totpEnrolmentSchema.safeParse({ confirmed: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['code']);
  });

  it('accepts a confirmation that carries a code', () => {
    expect(totpEnrolmentSchema.safeParse({ confirmed: true, code: '123456' }).success).toBe(true);
  });

  it('NEVER ECHOES THE CODE in the message for a malformed one', () => {
    // A zod message quotes the offending value, and a six-digit code heading
    // for a log is still a credential for thirty seconds. Report a PATH.
    const result = totpEnrolmentSchema.safeParse({ confirmed: false, code: '9991117' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = JSON.stringify(result.error.issues);
      expect(joined).not.toContain('9991117');
      expect(joined).toContain('code');
    }
  });

  it('mints at least eight recovery codes, because zero is a lockout', () => {
    expect(totpEnrolmentSchema.safeParse({ confirmed: false, recoveryCodeCount: 0 }).success).toBe(
      false,
    );
    expect(totpEnrolmentSchema.parse({ confirmed: false }).recoveryCodeCount).toBe(10);
  });
});

describe('a sealed value with an unknown key version', () => {
  const keys = [{ keyId: KEY_ID, version: 1, state: 'ACTIVE' as const }];
  const schema = sealedValueSchema(keys);
  const sealed = (version: number): string =>
    serialiseEnvelope({
      keyId: KEY_ID,
      keyVersion: version,
      alg: SEAL_WRITE_ALGORITHM,
      payload: FAKE_PAYLOAD,
    });

  it('IS REFUSED rather than stored', () => {
    // A row written under a version this deployment cannot name is a row
    // nothing will ever open and nothing will ever report — the only symptom is
    // a decrypt failure months later.
    const result = schema.safeParse({
      fieldKey: 'AuthProfile.storageState',
      rowId: 'profile-1',
      sealed: sealed(9),
      keyVersion: 9,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['keyVersion']);
  });

  it('refuses a version column that disagrees with the envelope', () => {
    const result = schema.safeParse({
      fieldKey: 'AuthProfile.storageState',
      rowId: 'profile-1',
      sealed: sealed(1),
      keyVersion: 2,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a field key that is not a sealed field', () => {
    expect(
      schema.safeParse({
        fieldKey: 'AuthProfile.config',
        rowId: 'profile-1',
        sealed: sealed(1),
        keyVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('never quotes the payload in any issue it raises', () => {
    const payload = ['zzz', 'looks', 'secret', 'zzz'].join('');
    const result = schema.safeParse({
      fieldKey: 'AuthProfile.storageState',
      rowId: 'profile-1',
      sealed: `qs2.${KEY_ID}.1.${SEAL_WRITE_ALGORITHM}.${payload}`,
      keyVersion: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain(payload);
  });

  it('accepts the ordinary case', () => {
    expect(
      schema.safeParse({
        fieldKey: 'AuthProfile.storageState',
        rowId: 'profile-1',
        sealed: sealed(1),
        keyVersion: 1,
      }).success,
    ).toBe(true);
  });
});

describe('an egress allowlist entry with no owner and no reason', () => {
  const ok = {
    host: 'app.internal',
    contexts: ['CRAWL'],
    ownerEmail: 'ops@example.com',
    reason: 'the staging app lives inside the VPN',
    expiresAt: null,
  };

  it('IS REFUSED', () => {
    expect(egressAllowlistEntrySchema.safeParse({ ...ok, ownerEmail: '' }).success).toBe(false);
    expect(egressAllowlistEntrySchema.safeParse({ ...ok, reason: 'because' }).success).toBe(false);
  });

  it('REFUSES AN EMPTY CONTEXT LIST, so it can never come to mean every context', () => {
    // The API-key scope defect transplanted into the egress control would turn
    // the narrowest-looking entry into the broadest.
    const result = egressAllowlistEntrySchema.safeParse({ ...ok, contexts: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['contexts']);
  });

  it('refuses a wildcard host', () => {
    expect(egressAllowlistEntrySchema.safeParse({ ...ok, host: '*.internal' }).success).toBe(false);
  });

  it('refuses a URL where a host belongs', () => {
    expect(
      egressAllowlistEntrySchema.safeParse({ ...ok, host: 'https://app.internal/x' }).success,
    ).toBe(false);
  });

  it('normalises the host so one spelling cannot miss the other', () => {
    // `localhost.` resolves exactly like `localhost`.
    const parsed = egressAllowlistEntrySchema.parse({ ...ok, host: 'APP.Internal.' });
    expect(parsed.host).toBe('app.internal');
  });

  it('refuses widening a third-party context', () => {
    const result = egressAllowlistEntrySchema.safeParse({ ...ok, contexts: ['WEBHOOK_DELIVERY'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['contexts', 0]);
  });
});

describe('the stored egress policy', () => {
  it('refuses a class no deployment permits by default', () => {
    const result = egressPolicySchema.safeParse({
      deployment: 'SELF_HOSTED',
      mode: 'ENFORCE',
      permittedClasses: ['public', 'link-local'],
      allowlist: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['permittedClasses', 1]);
  });

  it('refuses an empty class list, which is an unresolved policy', () => {
    expect(
      egressPolicySchema.safeParse({
        deployment: 'HOSTED',
        mode: 'ENFORCE',
        permittedClasses: [],
        allowlist: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a per-control mode map and refuses an unknown control', () => {
    expect(securityControlModesSchema.safeParse({ EGRESS_CLASSIFICATION: 'OBSERVE' }).success).toBe(
      true,
    );
    expect(securityControlModesSchema.safeParse({ NOT_A_CONTROL: 'OBSERVE' }).success).toBe(false);
    expect(
      securityControlModesSchema.safeParse({ EGRESS_CLASSIFICATION: 'OFF' }).success,
    ).toBe(false);
  });
});

describe('a session with no expiry', () => {
  it('IS REFUSED', () => {
    expect(createSessionSchema.safeParse({ deviceLabel: null }).success).toBe(false);
  });

  it('accepts one with an expiry and a device label', () => {
    const parsed = createSessionSchema.parse({
      expiresAt: '2026-11-01T00:00:00.000Z',
      deviceLabel: "Ahmad's laptop",
    });
    expect(parsed.expiresAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('requires a revocation reason from the vocabulary', () => {
    expect(revokeSessionSchema.safeParse({ reason: 'USER_REVOKED_DEVICE' }).success).toBe(true);
    expect(revokeSessionSchema.safeParse({ reason: 'because' }).success).toBe(false);
  });
});

describe('secret scoping defaults to deny, structurally', () => {
  it('requires a reason for the three broad kinds and not for a single test', () => {
    expect(
      secretScopeSchema.safeParse({ kind: 'TEST', value: 'test-1', reason: null }).success,
    ).toBe(true);
    for (const kind of ['TEST_TYPE', 'AUTH_PROFILE', 'ENVIRONMENT_WIDE'] as const) {
      const value = kind === 'ENVIRONMENT_WIDE' ? null : 'x';
      const result = secretScopeSchema.safeParse({ kind, value, reason: null });
      expect(result.success, kind).toBe(false);
    }
  });

  it('refuses ENVIRONMENT_WIDE naming something, and the others naming nothing', () => {
    expect(
      secretScopeSchema.safeParse({ kind: 'ENVIRONMENT_WIDE', value: 'x', reason: 'a good reason' })
        .success,
    ).toBe(false);
    expect(
      secretScopeSchema.safeParse({ kind: 'SUITE', value: null, reason: null }).success,
    ).toBe(false);
  });

  it('accepts the broadest kind only with somebody willing to say why', () => {
    expect(
      secretScopeSchema.safeParse({
        kind: 'ENVIRONMENT_WIDE',
        value: null,
        reason: 'the shared base URL token every suite needs',
      }).success,
    ).toBe(true);
  });
});

describe('the key-rotation and key-registration write paths', () => {
  it('refuses a rotation that moves rows BACKWARD', () => {
    expect(
      startKeyRotationSchema.safeParse({
        fromKeyVersion: 2,
        toKeyVersion: 1,
        fieldKey: 'Secret.valueEnc',
      }).success,
    ).toBe(false);
  });

  it('refuses a KMS key that names nothing the provider holds', () => {
    const result = registerVaultKeySchema.safeParse({
      keyId: KEY_ID,
      version: 2,
      state: 'ACTIVE',
      provider: 'KMS',
      providerRef: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['providerRef']);
  });

  it('refuses a LOCAL key that carries a provider reference at all', () => {
    // The field must never become a place to put key material.
    expect(
      registerVaultKeySchema.safeParse({
        keyId: KEY_ID,
        version: 2,
        state: 'ACTIVE',
        provider: 'LOCAL',
        providerRef: 'anything',
      }).success,
    ).toBe(false);
  });

  it('accepts the two ordinary registrations', () => {
    expect(
      registerVaultKeySchema.safeParse({
        keyId: KEY_ID,
        version: 1,
        state: 'ACTIVE',
        provider: 'LOCAL',
        providerRef: null,
      }).success,
    ).toBe(true);
    expect(
      registerVaultKeySchema.safeParse({
        keyId: `${KEY_ID}2`,
        version: 2,
        state: 'READABLE',
        provider: 'KMS',
        providerRef: 'alias/qaai-vault',
      }).success,
    ).toBe(true);
  });
});

describe('the login-attempt and verification write paths', () => {
  it('takes a hash and refuses an identifier', () => {
    expect(
      recordLoginAttemptSchema.safeParse({
        identifierHash: 'a'.repeat(64),
        outcome: 'BAD_TOTP',
        ip: null,
        userAgent: null,
      }).success,
    ).toBe(true);
    // A plaintext column would accumulate whatever list an attacker is walking.
    expect(
      recordLoginAttemptSchema.safeParse({
        identifierHash: 'someone@example.com',
        outcome: 'BAD_PASSWORD',
        ip: null,
        userAgent: null,
      }).success,
    ).toBe(false);
  });

  it('refuses a verification purpose nothing will ever redeem', () => {
    expect(
      issueVerificationTokenSchema.safeParse({
        email: 'a@example.com',
        purpose: 'EMAIL_VERIFY',
        expiresAt: '2026-11-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      issueVerificationTokenSchema.safeParse({
        email: 'a@example.com',
        purpose: 'EMAIL_CONFIRM',
        expiresAt: '2026-11-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

/**
 * `safeParse` MUST NOT THROW — the one function whose contract is that it does
 * not, and the one an Express route relies on to turn bad input into a 400.
 *
 * `z.string().url()` validates by PATTERN and `new URL()` by the WHATWG parser.
 * They disagree, and zod v4 does NOT short-circuit: a failed `.url()` check
 * does not stop the `.refine()` after it from running. So every field built on
 * `httpUrl` used to throw `TypeError: Invalid URL` out of `safeParse` for a
 * host the pattern accepts and the parser rejects — MEASURED at HEAD 1544943,
 * `POST /projects/:projectId/environments` answered 500 rather than 400 for
 * `http://[::1%25lo0]/`, which is an unhandled exception on an attacker-chosen
 * host and a response an attacker can tell apart from the refusal beside it.
 *
 * The hosts below are the ones where the two validators disagree: an IPv6
 * literal carrying a zone id. `%25` is a percent-encoded `%`, which is how a
 * zone id is written in a URL, and the parser refuses it in an authority.
 */
describe('URL schemas refuse a parser-hostile host instead of throwing out of safeParse', () => {
  const PARSER_HOSTILE = [
    'http://[::1%25lo0]/',
    'http://[fe80::1%25eth0]/',
    'https://[fe80::1%251]/',
    'http://[::ffff:127.0.0.1%25lo0]/',
  ];

  for (const baseUrl of PARSER_HOSTILE) {
    it(`createEnvironmentSchema refuses ${baseUrl} without throwing`, () => {
      let result: { success: boolean };
      // Not `expect(...).not.toThrow()`: the assertion has to be that a
      // REFUSAL came back, because a throw and a pass are both wrong here.
      expect(() => {
        result = createEnvironmentSchema.safeParse({ name: 'x', kind: 'STAGING', baseUrl });
      }).not.toThrow();
      expect(result!.success).toBe(false);
    });

    it(`updateEnvironmentSchema refuses ${baseUrl} without throwing`, () => {
      let result: { success: boolean };
      expect(() => {
        result = updateEnvironmentSchema.safeParse({ baseUrl });
      }).not.toThrow();
      expect(result!.success).toBe(false);
    });

    it(`createRunSchema refuses baseUrlOverride ${baseUrl} without throwing`, () => {
      let result: { success: boolean };
      expect(() => {
        result = createRunSchema.safeParse({ baseUrlOverride: baseUrl });
      }).not.toThrow();
      expect(result!.success).toBe(false);
    });

    it(`createProjectSchema refuses repoUrl ${baseUrl} without throwing`, () => {
      let result: { success: boolean };
      expect(() => {
        result = createProjectSchema.safeParse({ name: 'p', repoUrl: baseUrl });
      }).not.toThrow();
      expect(result!.success).toBe(false);
    });
  }

  it('still ACCEPTS the ordinary http(s) base URLs it accepted before', () => {
    for (const baseUrl of [
      'https://staging.example.com',
      'http://localhost:5050',
      'https://app.example.com:8443/path',
      'http://[::1]/',
      'http://[2606:2800:220:1:248:1893:25c8:1946]/',
    ]) {
      expect(
        createEnvironmentSchema.safeParse({ name: 'x', kind: 'STAGING', baseUrl }).success,
      ).toBe(true);
    }
  });

  it('still REFUSES the non-http schemes and the userinfo form', () => {
    for (const baseUrl of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'gopher://example.com/',
      'https://user:pw@example.com/',
    ]) {
      expect(
        createEnvironmentSchema.safeParse({ name: 'x', kind: 'STAGING', baseUrl }).success,
      ).toBe(false);
    }
  });
});
