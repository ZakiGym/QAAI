import { describe, expect, it } from 'vitest';
import {
  EGRESS_CONTEXTS,
  EGRESS_CONTEXT_RULES,
  EGRESS_OUTCOMES,
  EGRESS_REFUSALS,
  EGRESS_REFUSAL_SENTENCE,
  HOSTED_EGRESS_POLICY,
  NEVER_PERMITTED_BY_DEFAULT,
  SELF_HOSTED_EGRESS_POLICY,
  SELF_HOSTED_EGRESS_WARNING,
  assertConnectingTo,
  countEgress,
  decideEgress,
  resolveEgressPolicy,
  tallyKey,
  wouldHaveRefused,
} from './egress';
import type {
  EgressAllowlistEntry,
  EgressDecision,
  EgressIo,
  EgressPolicy,
  EgressTally,
} from './egress';
import { classifyAddress, classifyHost } from './private-address';
import {
  CONTROL_MODES,
  EGRESS_DEPLOYMENT_MODES,
  SECURITY_CONTROLS,
  SECURITY_CONTROL_BRAKES,
  controlEnforces,
  controlMode,
} from './constants';

/**
 * The egress policy and the decision.
 *
 * NO NETWORK AND NO REAL DNS. Every test below injects its own `lookup`, and
 * `io.now` is injected too so a decision's `pinnedAt` is deterministic. The
 * real classifier IS used — `classifyHost` and `classifyAddress` from
 * private-address.ts are pure and have no I/O — because a fake classifier would
 * be a second opinion about which addresses are private, and the first thing a
 * second opinion does is diverge.
 */

const AT = new Date('2026-10-29T12:00:00.000Z');

function io(
  answers: Record<string, string[]> = {},
  options: { throws?: boolean } = {},
): EgressIo {
  return {
    classifyHost,
    classifyAddress,
    lookup: async (host) => {
      if (options.throws === true) throw new Error('resolver down');
      return (answers[host] ?? []).map((address) => ({ address }));
    },
    now: () => AT,
  };
}

function entry(overrides: Partial<EgressAllowlistEntry> = {}): EgressAllowlistEntry {
  return {
    host: 'app.internal',
    contexts: ['CRAWL'],
    ownerEmail: 'ops@example.com',
    reason: 'the staging app lives inside the VPN',
    expiresAt: null,
    ...overrides,
  };
}

const decide = (
  host: string,
  policy: EgressPolicy,
  answers?: Record<string, string[]>,
  context: EgressDecision['context'] = 'CRAWL',
  options?: { throws?: boolean },
): Promise<EgressDecision> =>
  decideEgress({ context, host, policy, io: io(answers, options) });

describe('the vocabularies have both halves', () => {
  it('names every context in the rule record', () => {
    // The compile-time half is the `satisfies Record<EgressContext, …>` in the
    // module; this is the run-time half. One without the other passes while the
    // two disagree.
    expect(Object.keys(EGRESS_CONTEXT_RULES).sort()).toEqual([...EGRESS_CONTEXTS].sort());
  });

  it('names every security control in the brake table', () => {
    expect(Object.keys(SECURITY_CONTROL_BRAKES).sort()).toEqual([...SECURITY_CONTROLS].sort());
  });

  it('lets no third-party context be widened by an allowlist', () => {
    // An operator who allowlists an internal host for webhook delivery has
    // built an SSRF with paperwork, and the paperwork is the part that makes it
    // survive review.
    for (const context of ['WEBHOOK_DELIVERY', 'TRACKER_CALL', 'SSO_METADATA', 'DOCUMENT_FETCH'] as const) {
      expect(EGRESS_CONTEXT_RULES[context].allowlistApplies, context).toBe(false);
      expect(EGRESS_CONTEXT_RULES[context].targetsApplicationUnderTest, context).toBe(false);
    }
  });

  it('keeps WOULD_REFUSE, which is what makes the brake armable', () => {
    expect([...EGRESS_OUTCOMES]).toEqual(['ALLOWED', 'REFUSED', 'WOULD_REFUSE']);
    expect([...CONTROL_MODES]).toEqual(['OBSERVE', 'ENFORCE']);
    expect([...EGRESS_DEPLOYMENT_MODES]).toEqual(['HOSTED', 'SELF_HOSTED']);
  });
});

describe('the default is safe out of the box', () => {
  it('permits exactly one class when hosted, and it is public', () => {
    // THE FIELD THAT DECIDES WHETHER THE PRODUCT IS SAFE OUT OF THE BOX.
    expect(HOSTED_EGRESS_POLICY.permittedClasses).toEqual(['public']);
    expect(HOSTED_EGRESS_POLICY.allowlist).toEqual([]);
    expect(HOSTED_EGRESS_POLICY.mode).toBe('ENFORCE');
  });

  it('resolves an absent, malformed or hostile stored policy to the hosted default', () => {
    // An exception handler that falls through to "allow" is the defect pattern
    // this round hunts. A malformed JSON column must not be the way a
    // deployment becomes permissive.
    for (const raw of [null, undefined, 'SELF_HOSTED', 42, [], { deployment: 'OTHER' }]) {
      expect(resolveEgressPolicy(raw).permittedClasses, JSON.stringify(raw)).toEqual(['public']);
    }
  });

  it('READS OWN PROPERTIES ONLY, so a prototype cannot name the permissive deployment', () => {
    /*
     * `o.deployment` walks the prototype chain, and this function is the single
     * place the product decides whether a deployment is the permissive one.
     *
     * MEASURED before the fix: `Object.create({ deployment: 'SELF_HOSTED' })`
     * — an object whose `Object.keys` is `[]` and whose `JSON.stringify` is
     * `{}` — resolved to public + private + loopback + reserved. Recorded as
     * hardening rather than as a live hole, because `JSON.parse` keeps
     * `__proto__` as an OWN property and so a JSONB column cannot produce that
     * object; a class instance or an `Object.create`-based defaults merge can.
     */
    for (const raw of [
      Object.create({ deployment: 'SELF_HOSTED' }) as object,
      Object.create({
        deployment: 'SELF_HOSTED',
        permittedClasses: ['public', 'loopback'],
      }) as object,
      // A method on a class's PROTOTYPE, which is where class members live
      // unless they are field initialisers — see the next assertion for the
      // distinction, which this test got wrong on its first pass.
      Object.create(
        new (class {
          get deployment(): string {
            return 'SELF_HOSTED';
          }
        })(),
      ) as object,
      Object.create({ mode: 'OBSERVE' }) as object,
    ]) {
      const policy = resolveEgressPolicy(raw);
      expect(policy.deployment).toBe('HOSTED');
      expect(policy.permittedClasses).toEqual(['public']);
      // OBSERVE off a prototype would be a brake released by inheritance.
      expect(policy.mode).toBe('ENFORCE');
    }

    /*
     * And the OWN-property path still works, so this is hardening and not a
     * blanket refusal. A class FIELD INITIALISER belongs here and not above: it
     * defines an own property on the instance, so it is a stored policy saying
     * SELF_HOSTED and is honoured as one. The first version of this test
     * asserted the opposite and went red, which is the distinction worth
     * leaving written down.
     */
    expect(resolveEgressPolicy({ deployment: 'SELF_HOSTED' }).deployment).toBe('SELF_HOSTED');
    expect(resolveEgressPolicy({ mode: 'OBSERVE' }).mode).toBe('OBSERVE');
    expect(
      resolveEgressPolicy(
        new (class {
          deployment = 'SELF_HOSTED';
        })(),
      ).deployment,
    ).toBe('SELF_HOSTED');
  });

  it('lets a stored policy NARROW but never widen past its deployment mode', () => {
    const widened = resolveEgressPolicy({
      deployment: 'HOSTED',
      mode: 'ENFORCE',
      permittedClasses: ['public', 'loopback', 'link-local', 'private'],
      allowlist: [],
    });
    // A row written before `egressPolicySchema` existed does not get what it
    // asks for; the intersection is what stops it.
    expect(widened.permittedClasses).toEqual(['public']);
  });

  it('drops a stored allowlist entry with no owner or no reason', () => {
    const resolved = resolveEgressPolicy({
      deployment: 'SELF_HOSTED',
      mode: 'ENFORCE',
      permittedClasses: ['public', 'private'],
      allowlist: [
        { host: 'a.internal', contexts: ['CRAWL'], ownerEmail: '', reason: 'x' },
        { host: 'b.internal', contexts: ['CRAWL'], ownerEmail: 'o@example.com', reason: '' },
        entry(),
      ],
    });
    // A half-read entry is a hole somebody believes is documented.
    expect(resolved.allowlist.map((e) => e.host)).toEqual(['app.internal']);
  });

  it('refuses a policy that permits nothing, by name', async () => {
    // An empty permitted list is a policy that FAILED TO RESOLVE, not a
    // deliberate lockdown — every real policy permits at least `public`. Named
    // so it cannot be mistaken for something somebody would "fix" by widening.
    const decision = await decide(
      'example.com',
      { ...HOSTED_EGRESS_POLICY, permittedClasses: [] },
      { 'example.com': ['93.184.216.34'] },
    );
    expect(decision.outcome).toBe('REFUSED');
    expect(decision.refusal).toBe('POLICY_UNRESOLVED');
    expect(decision.detail).toContain('A missing policy is not an open one');
  });
});

describe('the metadata service is refused in BOTH modes', () => {
  it('refuses 169.254.169.254 to a hosted crawl', async () => {
    const decision = await decide('169.254.169.254', HOSTED_EGRESS_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.decidedByClass).toBe('link-local');
    expect(decision.refusal).toBe('NOT_ALLOWLISTED');
  });

  it('refuses it to a SELF_HOSTED crawl too, which is stricter than permissive', async () => {
    // Stricter than the brief's "permissive with a warning", and on purpose:
    // 169.254.169.254 is the cloud metadata service on AWS, GCP and Azure
    // alike. It is never an application under test in anybody's deployment, and
    // a self-hosted QAAI on an EC2 instance has an instance role worth stealing
    // exactly like ours does.
    const decision = await decide('169.254.169.254', SELF_HOSTED_EGRESS_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('NOT_ALLOWLISTED');
  });

  it('refuses the IPv4-carrying IPv6 encodings of it, through the real classifier', async () => {
    // `::ffff:169.254.169.254` and the 6to4 form `2002:a9fe:a9fe::` both carry
    // the IPv4 metadata address and both classify link-local, so both are
    // refused in both modes. `classifyIpv6` is doing this work, not a string
    // comparison, which is why an alternate spelling cannot get past it.
    for (const host of ['[::ffff:169.254.169.254]', '[2002:a9fe:a9fe::]']) {
      for (const policy of [HOSTED_EGRESS_POLICY, SELF_HOSTED_EGRESS_POLICY]) {
        const decision = await decide(host, policy);
        expect(decision.allowed, `${host} ${policy.deployment}`).toBe(false);
      }
    }
  });

  it('MEASURED: the IPv6 metadata address is private-class, so SELF_HOSTED reaches it', async () => {
    // NOT a claim that this is fine — it is the measured behaviour, recorded so
    // nobody reads the paragraph above as "no metadata endpoint is reachable".
    // `fd00:ec2::254` is fc00::/7 unique-local, i.e. the same class as the
    // 10.0.0.5 a self-hosted customer's internal app legitimately has, and the
    // module header explains why the two available patches are both worse than
    // saying so.
    expect(classifyAddress('fd00:ec2::254')).toBe('private');
    const hosted = await decide('[fd00:ec2::254]', HOSTED_EGRESS_POLICY);
    expect(hosted.allowed).toBe(false);
    const selfHosted = await decide('[fd00:ec2::254]', SELF_HOSTED_EGRESS_POLICY);
    expect(selfHosted.allowed).toBe(true);
    expect(selfHosted.warning).toBe(SELF_HOSTED_EGRESS_WARNING);
  });

  it('and NARROWING the class list is the remedy a self-hosted operator has', async () => {
    // Narrowing is the one direction a stored policy may always move, so an
    // operator who does not need RFC1918 can close this today.
    const narrowed = resolveEgressPolicy({
      deployment: 'SELF_HOSTED',
      mode: 'ENFORCE',
      permittedClasses: ['public', 'loopback'],
      allowlist: [],
    });
    expect(narrowed.permittedClasses).toEqual(['public', 'loopback']);
    expect((await decide('[fd00:ec2::254]', narrowed)).allowed).toBe(false);
    // And localhost still works, which is the thing self-hosting is for.
    expect((await decide('127.0.0.1', narrowed)).allowed).toBe(true);
  });

  it('keeps the four never-permitted classes out of both base policies', async () => {
    for (const cls of NEVER_PERMITTED_BY_DEFAULT) {
      expect(HOSTED_EGRESS_POLICY.permittedClasses, cls).not.toContain(cls);
      expect(SELF_HOSTED_EGRESS_POLICY.permittedClasses, cls).not.toContain(cls);
    }
  });
});

describe('the self-hosted customer can test their own app, and is told what was skipped', () => {
  it('permits localhost and says the public-address check did not run', async () => {
    // A self-hosted QAAI exists precisely to test http://localhost:3000.
    // Refusing it would break the install for every customer behind their own
    // firewall — they are not attacking themselves.
    const decision = await decide('127.0.0.1', SELF_HOSTED_EGRESS_POLICY);
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe('ALLOWED');
    // A guard that passes SILENTLY in the one mode where it does nothing is
    // indistinguishable from a guard that ran.
    expect(decision.warning).toBe(SELF_HOSTED_EGRESS_WARNING);
  });

  it('does not warn when the target was public anyway', async () => {
    const decision = await decide('example.com', SELF_HOSTED_EGRESS_POLICY, {
      'example.com': ['93.184.216.34'],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBeNull();
  });

  it('refuses localhost to a HOSTED crawl', async () => {
    const decision = await decide('127.0.0.1', HOSTED_EGRESS_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('CLASS_NOT_PERMITTED');
  });
});

describe('the allowlist is the only way to widen, and only for the right contexts', () => {
  const policy: EgressPolicy = { ...HOSTED_EGRESS_POLICY, allowlist: [entry()] };

  it('permits an allowlisted internal host for a crawl', async () => {
    const decision = await decide('app.internal', policy, { 'app.internal': ['10.0.0.5'] });
    expect(decision.allowed).toBe(true);
    expect(decision.allowlistedBy).toBe('app.internal');
    expect(decision.detail).toContain('ops@example.com');
  });

  it('matches the host EXACTLY and never as a suffix', async () => {
    // `*.internal` would be a wildcard over a namespace somebody else can
    // register names in — the property that makes an exact-key mute safe.
    const decision = await decide('evil.app.internal', policy, {
      'evil.app.internal': ['10.0.0.5'],
    });
    expect(decision.allowed).toBe(false);
  });

  it('ignores an expired entry', async () => {
    const expired: EgressPolicy = {
      ...HOSTED_EGRESS_POLICY,
      allowlist: [entry({ expiresAt: '2026-01-01T00:00:00.000Z' })],
    };
    const decision = await decide('app.internal', expired, { 'app.internal': ['10.0.0.5'] });
    expect(decision.allowed).toBe(false);
  });

  it('ignores an entry for a different context', async () => {
    const decision = await decide('app.internal', policy, { 'app.internal': ['10.0.0.5'] }, 'PLUGIN_HTTP');
    expect(decision.allowed).toBe(false);
  });

  it('REFUSES A THIRD-PARTY CONTEXT IN THE POLICY ITSELF, NOT ONLY IN guardUrl', async () => {
    /*
     * THE STRUCTURAL HALF OF A CRITICAL THAT WAS ONLY PATCHED AT ITS
     * COMPENSATING CONTROL.
     *
     * `EGRESS_CONTEXT_RULES` promises of the four third-party contexts that
     * "there is no deployment in which they legitimately reach a private
     * address, and they are refused in both modes". MEASURED at HEAD 37498c1,
     * `decideEgress` did not do it: `decidePinned` looked for an address
     * OUTSIDE `permittedClasses` and consulted the context only then, and
     * SELF_HOSTED permits `private`, so there was no offending address, the
     * context rule was never reached, and all four came back ALLOWED with a pin
     * that INCLUDED `10.0.0.5`. `guardUrl` was the only enforcing caller.
     *
     * Both record ORDERS, because the order belongs to whoever runs the zone
     * and the previous fix in this area passed one of them.
     */
    for (const addresses of [
      ['10.0.0.5'],
      ['93.184.216.34', '10.0.0.5'],
      ['10.0.0.5', '93.184.216.34'],
    ]) {
      for (const context of [
        'WEBHOOK_DELIVERY',
        'TRACKER_CALL',
        'SSO_METADATA',
        'DOCUMENT_FETCH',
      ] as const) {
        const where = `${context} ${addresses.join()}`;
        const decision = await decide(
          'hook.internal',
          SELF_HOSTED_EGRESS_POLICY,
          { 'hook.internal': addresses },
          context,
        );
        expect(decision.allowed, where).toBe(false);
        expect(decision.outcome, where).toBe('REFUSED');
        expect(decision.refusal, where).toBe('CONTEXT_NOT_PERMITTED');
        expect(decision.decidedByClass, where).toBe('private');
        // And the pin is the part that matters: an ALLOWED decision used to
        // hand the caller 10.0.0.5 to connect to.
        expect(decision.pinned, where).toBeNull();
        expect(assertConnectingTo(decision, '10.0.0.5').ok, where).toBe(false);
      }
    }
  });

  it('leaves the APPLICATION-UNDER-TEST contexts alone, which is the product working', async () => {
    // The other side of the rule, so the fix above cannot quietly become a
    // blanket refusal: a self-hosted QAAI exists precisely to crawl
    // `app.internal` and to type vault plaintext into its login form.
    for (const context of ['CRAWL', 'LOGIN', 'PLUGIN_HTTP'] as const) {
      const decision = await decide(
        'app.internal',
        SELF_HOSTED_EGRESS_POLICY,
        { 'app.internal': ['93.184.216.34', '10.0.0.5'] },
        context,
      );
      expect(decision.allowed, context).toBe(true);
      expect(decision.outcome, context).toBe('ALLOWED');
      expect(decision.warning, context).toBe(SELF_HOSTED_EGRESS_WARNING);
      expect(assertConnectingTo(decision, '10.0.0.5').ok, context).toBe(true);
    }
  });

  it('COUNTS a third-party refusal instead of applying it when the brake is OBSERVE', async () => {
    // A brake that does not brake is worse than no brake: an operator who sets
    // OBSERVE believes today's behaviour continues, and a self-hosted install
    // delivering a webhook to an internal endpoint is behaviour that works
    // today. The mode gates the REFUSAL, and OBSERVE still counts it.
    const observing: EgressPolicy = { ...SELF_HOSTED_EGRESS_POLICY, mode: 'OBSERVE' };
    const decision = await decide(
      'hook.internal',
      observing,
      { 'hook.internal': ['10.0.0.5'] },
      'WEBHOOK_DELIVERY',
    );
    expect(decision.outcome).toBe('WOULD_REFUSE');
    expect(decision.refusal).toBe('CONTEXT_NOT_PERMITTED');
    expect(decision.allowed).toBe(true);
    // Counted under its own refusal, so "we would have refused N webhook
    // deliveries to internal addresses" is a `GROUP BY` and not a guess.
    expect(wouldHaveRefused(countEgress(new Map(), decision).values()).wouldRefuse).toBe(1);
    // And still no pin, so the caller cannot claim a closed rebinding window.
    expect(decision.pinned).toBeNull();
  });

  it('refuses a third-party context ahead of NOT_ALLOWLISTED, with different advice', async () => {
    const wide: EgressPolicy = {
      ...HOSTED_EGRESS_POLICY,
      allowlist: [entry({ contexts: [...EGRESS_CONTEXTS] })],
    };
    const decision = await decide(
      'app.internal',
      wide,
      { 'app.internal': ['10.0.0.5'] },
      'WEBHOOK_DELIVERY',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('CONTEXT_NOT_PERMITTED');
    expect(decision.detail).toContain('not through the allowlist');
  });
});

describe('the allowlist ROWS are what make a host reachable', () => {
  /**
   * One `EgressAllowlistEntry` row as the OWNER-only route stores it and as
   * Prisma hands it back — a cuid, a `Date` expiry, the audit columns — rather
   * than as the shape this module's own type declares. A test that passed the
   * declared shape would prove nothing about the one thing this parameter is
   * for.
   */
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'cl_egress_entry_1',
    orgId: 'org_1',
    environmentId: 'env_1',
    host: 'app.internal',
    contexts: ['CRAWL', 'LOGIN'],
    ownerEmail: 'ops@example.com',
    reason: 'the staging app lives inside the VPN',
    expiresAt: null,
    createdBy: 'usr_1',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  });

  it('WIDENS A HOSTED POLICY FOR THE NAMED HOST, which the stored column could never do', async () => {
    /*
     * THE DEFECT THIS PARAMETER EXISTS FOR.
     *
     * `Environment.egressPolicy` has NO WRITER anywhere, so the column is NULL
     * in every install and the allowlist this function could see was always
     * empty. The OWNER-only route writes ROWS instead, and the only reader of
     * those rows listed them back to the page. So the product answered 201,
     * rendered the entry with its owner and its reason, and the host stayed
     * refused: a grant recorded without being applied.
     *
     * NULL is passed as the policy on purpose — that is what production holds.
     */
    const refused = await decide('app.internal', resolveEgressPolicy(null), {
      'app.internal': ['10.0.0.5'],
    });
    expect(refused.allowed).toBe(false);
    expect(refused.refusal).toBe('CLASS_NOT_PERMITTED');

    const allowed = await decide('app.internal', resolveEgressPolicy(null, [row()]), {
      'app.internal': ['10.0.0.5'],
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.outcome).toBe('ALLOWED');
    expect(allowed.allowlistedBy).toBe('app.internal');
    // The operator's copy names who signed for it, which is the paperwork that
    // makes an SSRF-shaped grant survive review.
    expect(allowed.detail).toContain('ops@example.com');
    // And the permit is a PIN on the address that was classified.
    expect(assertConnectingTo(allowed, '10.0.0.5').ok).toBe(true);
  });

  it('is byte-identical to the old behaviour when no rows are supplied', () => {
    // Fails safe today and must keep failing safe: a call site that has not
    // read the rows cannot accidentally be the one that widens.
    for (const raw of [null, undefined, 'SELF_HOSTED', 42, [], { deployment: 'OTHER' }]) {
      expect(resolveEgressPolicy(raw, [])).toEqual(resolveEgressPolicy(raw));
      expect(resolveEgressPolicy(raw).allowlist).toEqual([]);
    }
    // Including the identity of the shared constant, so nothing that compares
    // policies by reference changes meaning.
    expect(resolveEgressPolicy(null)).toBe(HOSTED_EGRESS_POLICY);
    expect(resolveEgressPolicy(null, [])).toBe(HOSTED_EGRESS_POLICY);
  });

  it('keeps the ROW out of the policy when it names a different host or context', async () => {
    const policy = resolveEgressPolicy(null, [row()]);
    // EXACT host, never a suffix: `*.internal` would be a wildcard over a
    // namespace somebody else can register names in.
    expect((await decide('evil.app.internal', policy, { 'evil.app.internal': ['10.0.0.5'] })).allowed).toBe(
      false,
    );
    // And a row for CRAWL/LOGIN does not widen PLUGIN_HTTP.
    expect(
      (await decide('app.internal', policy, { 'app.internal': ['10.0.0.5'] }, 'PLUGIN_HTTP')).allowed,
    ).toBe(false);
  });

  it('reads an expiry Prisma hands back as a Date, and honours it', async () => {
    // `AT` is 2026-10-29; the column is a `DateTime?`, so the value that
    // arrives here is a `Date` and not the ISO string this module's type
    // declares. A reader that only accepted the string would drop the row and
    // re-create the inert allowlist in the other direction.
    const live = resolveEgressPolicy(null, [row({ expiresAt: new Date('2027-01-01T00:00:00.000Z') })]);
    expect((await decide('app.internal', live, { 'app.internal': ['10.0.0.5'] })).allowed).toBe(true);

    const expired = resolveEgressPolicy(null, [row({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })]);
    expect((await decide('app.internal', expired, { 'app.internal': ['10.0.0.5'] })).allowed).toBe(
      false,
    );
  });

  it('DROPS A ROW WHOSE EXPIRY CANNOT BE READ, rather than treating it as permanent', async () => {
    /*
     * The fail-open this hardening closes. `allowlistEntryFor` compares
     * `new Date(entry.expiresAt).getTime() <= now`, and `new Date('soon')` is
     * NaN, so `NaN <= now` is false and the entry never expired. An entry is a
     * permanent hole in the one control between a customer-supplied string and
     * our own network; "we could not read the expiry, so it is still valid" is
     * the arm that must not allow.
     */
    for (const expiresAt of ['soon', '', 1767225600000, {}, [], true]) {
      const policy = resolveEgressPolicy(null, [row({ expiresAt })]);
      expect(policy.allowlist, JSON.stringify(expiresAt)).toEqual([]);
      expect(
        (await decide('app.internal', policy, { 'app.internal': ['10.0.0.5'] })).allowed,
        JSON.stringify(expiresAt),
      ).toBe(false);
    }
  });

  it('drops a row with no owner, no reason or no host, exactly as the column’s list is dropped', () => {
    const policy = resolveEgressPolicy(null, [
      row({ ownerEmail: '' }),
      row({ reason: '' }),
      row({ host: '' }),
      row({ contexts: 'CRAWL' }),
      'not an object',
      null,
      row({ host: 'kept.internal' }),
    ]);
    // A half-read entry is a hole somebody believes is documented.
    expect(policy.allowlist.map((entry) => entry.host)).toEqual(['kept.internal']);
  });

  it('merges the column’s list with the rows, column first', () => {
    const policy = resolveEgressPolicy(
      {
        deployment: 'SELF_HOSTED',
        mode: 'ENFORCE',
        allowlist: [entry({ host: 'from-column.internal' })],
      },
      [row({ host: 'from-row.internal' })],
    );
    // Both stores are read, and the column keeps precedence so adding the rows
    // cannot change which entry an existing install reports as the permitter.
    expect(policy.allowlist.map((e) => e.host)).toEqual(['from-column.internal', 'from-row.internal']);
  });

  it('keeps an unknown context string out of a row’s list, so it widens nothing', () => {
    // `contexts: ['*']` is not a wildcard. It is a list naming no context,
    // which is what an empty list means too: NOTHING.
    const policy = resolveEgressPolicy(null, [row({ contexts: ['*', 'CRAWL', 'NOT_A_CONTEXT'] })]);
    expect(policy.allowlist[0]?.contexts).toEqual(['CRAWL']);
  });

  it('cannot widen a THIRD-PARTY context however the row is written', async () => {
    // An operator who allowlists an internal host for webhook delivery has
    // built an SSRF with paperwork. The row is read; it just does not apply.
    const policy = resolveEgressPolicy(null, [row({ contexts: [...EGRESS_CONTEXTS] })]);
    expect(policy.allowlist[0]?.contexts).toEqual([...EGRESS_CONTEXTS]);
    for (const context of ['WEBHOOK_DELIVERY', 'TRACKER_CALL', 'SSO_METADATA', 'DOCUMENT_FETCH'] as const) {
      const decision = await decide('app.internal', policy, { 'app.internal': ['10.0.0.5'] }, context);
      expect(decision.allowed, context).toBe(false);
      expect(decision.refusal, context).toBe('CONTEXT_NOT_PERMITTED');
    }
  });
});

describe('it fails closed on every path', () => {
  it('refuses an ambiguous host exactly as it refuses loopback', async () => {
    for (const host of ['0177.0.0.1', '0x7f.0.0.1', '2130706433', '127.1']) {
      const decision = await decide(host, SELF_HOSTED_EGRESS_POLICY);
      expect(decision.allowed, host).toBe(false);
      expect(decision.refusal, host).toBe('AMBIGUOUS_HOST');
    }
  });

  it('refuses a name that does not resolve', async () => {
    const decision = await decide('nope.example.com', HOSTED_EGRESS_POLICY, {}, 'CRAWL', {
      throws: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('UNRESOLVED');
  });

  it('refuses a name that resolves to nothing', async () => {
    const decision = await decide('void.example.com', HOSTED_EGRESS_POLICY, {
      'void.example.com': [],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('NO_ADDRESSES');
  });

  it('refuses a split-horizon answer on the PRIVATE address, not the first one', async () => {
    // A record set mixing one routable address with 169.254.169.254 is not a
    // misconfiguration, it is the attack written down.
    const decision = await decide('split.example.com', HOSTED_EGRESS_POLICY, {
      'split.example.com': ['93.184.216.34', '169.254.169.254'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.decidedByClass).toBe('link-local');
  });

  it('REPORTS THE LEAST PUBLIC CLASS IN A PERMITTED SET, NOT WHICHEVER ANSWER CAME FIRST', async () => {
    /*
     * The record ORDER is chosen by whoever runs the zone, so a field that
     * reports address zero is a field the target controls.
     *
     * This is not cosmetic. `guardUrl`'s third-party-context rule — the one
     * that keeps WEBHOOK_DELIVERY, TRACKER_CALL, SSO_METADATA and
     * DOCUMENT_FETCH off private addresses in EVERY deployment — branches on
     * `decidedByClass`. While this read `addresses[0].class`, a SELF_HOSTED
     * policy (which permits `private`) answered `public` for the set below, the
     * rule did not fire, and the permit's pin INCLUDED 10.0.0.5. Reversing the
     * two records refused it. See the companion test in egress-guard.test.ts,
     * which probes the whole guard rather than this one field.
     */
    for (const addresses of [
      ['93.184.216.34', '10.0.0.5'],
      ['10.0.0.5', '93.184.216.34'],
    ]) {
      const decision = await decide('split.internal', SELF_HOSTED_EGRESS_POLICY, {
        'split.internal': addresses,
      });
      expect(decision.allowed, addresses.join()).toBe(true);
      expect(decision.decidedByClass, addresses.join()).toBe('private');
      // The three fields that describe one decision now agree with each other.
      expect(decision.detail, addresses.join()).toContain('10.0.0.5');
      expect(decision.warning, addresses.join()).toBe(SELF_HOSTED_EGRESS_WARNING);
    }
  });

  it('still reports `public` when every address in the set is public', async () => {
    // The other half of the fix above: `decidedByClass` must not become "the
    // most alarming class we can find" for a set that holds nothing alarming.
    const decision = await decide('all-public.example.com', HOSTED_EGRESS_POLICY, {
      'all-public.example.com': ['93.184.216.34', '93.184.216.35'],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.decidedByClass).toBe('public');
    expect(decision.warning).toBeNull();
  });

  it('has no arm that allows on an exception', async () => {
    const decision = await decideEgress({
      context: 'CRAWL',
      host: 'boom.example.com',
      policy: HOSTED_EGRESS_POLICY,
      io: {
        classifyHost,
        classifyAddress: () => {
          throw new Error('classifier exploded');
        },
        lookup: async () => [{ address: '93.184.216.34' }],
        now: () => AT,
      },
    }).catch((err: unknown) => err);
    // It propagates rather than being caught and read as "allow". A thrown
    // classifier is our bug, and swallowing it would turn it into their SSRF.
    expect(decision).toBeInstanceOf(Error);
  });
});

describe('a check is not a pin: the rebinding rule', () => {
  it('hands back the addresses that were classified, not the name', async () => {
    const decision = await decide('example.com', HOSTED_EGRESS_POLICY, {
      'example.com': ['93.184.216.34', '93.184.216.35'],
    });
    expect(decision.pinned?.addresses.map((a) => a.address)).toEqual([
      '93.184.216.34',
      '93.184.216.35',
    ]);
    expect(decision.pinned?.fromLiteral).toBe(false);
    expect(decision.pinned?.pinnedAt).toBe(AT.toISOString());
  });

  it('marks a literal pin as a literal, because its rebinding risk is absent', async () => {
    const decision = await decide('93.184.216.34', HOSTED_EGRESS_POLICY);
    expect(decision.pinned?.fromLiteral).toBe(true);
  });

  it('REFUSES A CONNECTION TO AN ADDRESS NOBODY CLASSIFIED', async () => {
    // The whole control collapses to a logging statement without this. A host
    // that resolves public at check time and private at connect time defeats
    // everything above it.
    const decision = await decide('example.com', HOSTED_EGRESS_POLICY, {
      'example.com': ['93.184.216.34'],
    });
    const rebound = assertConnectingTo(decision, '169.254.169.254');
    expect(rebound.ok).toBe(false);
    if (!rebound.ok) expect(rebound.refusal).toBe('PINNED_SET_CHANGED');
    expect(assertConnectingTo(decision, '93.184.216.34').ok).toBe(true);
  });

  it('refuses a connection on a decision that pinned nothing', async () => {
    const refused = await decide('127.0.0.1', HOSTED_EGRESS_POLICY);
    const check = assertConnectingTo(refused, '127.0.0.1');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.refusal).toBe('RESOLUTION_NOT_PINNED');
  });

  it('pins NOTHING on an OBSERVED refusal, so the caller cannot claim a closed window', async () => {
    // An observed refusal lets the connection happen and the caller connects by
    // name, the way it did before this control existed. Handing back a pin here
    // would claim the rebinding window was closed for a connection nobody
    // authorised — a worse lie than the hole OBSERVE deliberately leaves.
    const observing: EgressPolicy = { ...HOSTED_EGRESS_POLICY, mode: 'OBSERVE' };
    const decision = await decide('127.0.0.1', observing);
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe('WOULD_REFUSE');
    expect(decision.pinned).toBeNull();
    expect(assertConnectingTo(decision, '127.0.0.1').ok).toBe(false);
  });
});

describe('the brake counts what it would have refused', () => {
  it('turns a refusal into WOULD_REFUSE in OBSERVE and lets it through', async () => {
    const observing: EgressPolicy = { ...HOSTED_EGRESS_POLICY, mode: 'OBSERVE' };
    const decision = await decide('169.254.169.254', observing);
    expect(decision.outcome).toBe('WOULD_REFUSE');
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('OBSERVE');
  });

  it('answers "we would have refused N connections, out of M"', async () => {
    const observing: EgressPolicy = { ...HOSTED_EGRESS_POLICY, mode: 'OBSERVE' };
    const into = new Map<string, EgressTally>();
    for (const host of ['127.0.0.1', '127.0.0.1', '10.0.0.1']) {
      countEgress(into, await decide(host, observing));
    }
    countEgress(into, await decide('example.com', observing, { 'example.com': ['93.184.216.34'] }));
    // A count of refusals with no denominator is the kind of number that gets
    // quoted at a customer and cannot be defended.
    expect(wouldHaveRefused(into.values())).toEqual({
      wouldRefuse: 3,
      refused: 0,
      allowed: 1,
      total: 4,
    });
  });

  it('buckets by context, outcome, class and refusal — and nothing finer', async () => {
    const a = await decide('127.0.0.1', HOSTED_EGRESS_POLICY);
    const b = await decide('127.0.0.2', HOSTED_EGRESS_POLICY);
    // Two different loopback hosts share a bucket: a row per connection would
    // be an inventory of every internal hostname a crawl touched.
    expect(tallyKey(a)).toBe(tallyKey(b));
    const c = await decide('169.254.169.254', HOSTED_EGRESS_POLICY);
    expect(tallyKey(a)).not.toBe(tallyKey(c));
  });

  it('counts the allowed decisions too', async () => {
    const into = new Map<string, EgressTally>();
    countEgress(
      into,
      await decide('example.com', HOSTED_EGRESS_POLICY, { 'example.com': ['93.184.216.34'] }),
    );
    expect(wouldHaveRefused(into.values()).allowed).toBe(1);
  });
});

describe('no control may be an oracle', () => {
  it('shows ONE sentence for every refusal, whatever the reason', () => {
    // "That is a loopback address", "that host did not resolve" and "that host
    // is not on the allowlist" are three different facts about the inside of a
    // network, handed to whoever typed the URL.
    expect(typeof EGRESS_REFUSAL_SENTENCE).toBe('string');
    expect(EGRESS_REFUSAL_SENTENCE).not.toMatch(/loopback|private|link-local|resolve|metadata/);
    expect(new Set(EGRESS_REFUSALS).size).toBe(EGRESS_REFUSALS.length);
  });

  it('keeps the class and the address in `detail` and never in the public sentence', async () => {
    const decision = await decide('split.example.com', HOSTED_EGRESS_POLICY, {
      'split.example.com': ['93.184.216.34', '10.1.2.3'],
    });
    // The operator is entitled to know, inside their own tenant.
    expect(decision.detail).toContain('10.1.2.3');
    // And nobody else is.
    expect(EGRESS_REFUSAL_SENTENCE).not.toContain('10.1.2.3');
  });

  it('never puts a URL PATH in a decision', async () => {
    // For a webhook the path IS the bearer credential, which is why
    // `resolvesPublicly` refuses to name one either.
    const decision = await decide('example.com', HOSTED_EGRESS_POLICY, {
      'example.com': ['10.0.0.1'],
    });
    expect(decision.host).toBe('example.com');
    expect(decision.detail).not.toContain('/');
  });
});

describe('the rollout brakes are discoverable and default safely', () => {
  it('defaults the three dangerous controls to OBSERVE and the rest to ENFORCE', () => {
    const observing = SECURITY_CONTROLS.filter(
      (control) => SECURITY_CONTROL_BRAKES[control].fallback === 'OBSERVE',
    );
    // Named, not counted. A count would be satisfied by swapping one for
    // another, and which three they are is the whole judgement.
    expect([...observing].sort()).toEqual([
      'CONTENT_SECURITY_POLICY',
      'EMAIL_VERIFICATION',
      'SECRET_TEST_SCOPING',
    ]);
  });

  it('makes every control say what enforcing breaks and what observing counts', () => {
    // A mode with no counter is an off switch with a reassuring name.
    for (const control of SECURITY_CONTROLS) {
      const brake = SECURITY_CONTROL_BRAKES[control];
      expect(brake.enforcingBreaks.length, control).toBeGreaterThan(20);
      expect(brake.observeCounts.length, control).toBeGreaterThan(20);
    }
  });

  it('falls back safely for an absent, malformed or unknown stored mode', () => {
    expect(controlMode('EGRESS_CLASSIFICATION', null)).toBe('ENFORCE');
    expect(controlMode('EGRESS_CLASSIFICATION', 'ENFORCE')).toBe('ENFORCE');
    expect(controlMode('EGRESS_CLASSIFICATION', { EGRESS_CLASSIFICATION: 'off' })).toBe('ENFORCE');
    expect(controlMode('EGRESS_CLASSIFICATION', { EGRESS_CLASSIFICATION: 'OBSERVE' })).toBe('OBSERVE');
    // The dangerous one keeps ITS default when the row is unreadable, which is
    // OBSERVE — the fallback is per control, not one answer for all thirteen.
    expect(controlMode('SECRET_TEST_SCOPING', [])).toBe('OBSERVE');
  });

  it('has exactly one mode that enforces', () => {
    expect(CONTROL_MODES.filter(controlEnforces)).toEqual(['ENFORCE']);
  });
});
