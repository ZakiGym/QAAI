import { describe, expect, it } from 'vitest';
import {
  ALL_GUARD_REFUSALS,
  DEFAULT_REDIRECT_CAP,
  EGRESS_GUARD_REFUSALS,
  EGRESS_REFUSAL_FLOOR_MS,
  EGRESS_SCHEMES,
  GUARD_REFUSAL_RULES,
  assertConnectingTo,
  chromiumHostResolverRules,
  countGuard,
  guardRedirectChain,
  guardTallyKey,
  guardTotals,
  guardUrl,
  pinnedLookup,
  pinnedRequestTarget,
  refusalForCaller,
} from './egress-guard';
import type {
  EgressChain,
  EgressGuardIo,
  EgressPermit,
  GuardRefusal,
  GuardTally,
  GuardVerdict,
  PinnedLookupAddress,
  RedirectHop,
} from './egress-guard';
import {
  EGRESS_REFUSALS,
  EGRESS_REFUSAL_SENTENCE,
  HOSTED_EGRESS_POLICY,
  SELF_HOSTED_EGRESS_POLICY,
} from './egress';
import type { EgressPolicy } from './egress';
import { classifyAddress, classifyHost } from './private-address';

/**
 * The egress GUARD: the URL, the redirect chain, the pin and the clock.
 *
 * NO NETWORK, NO REAL DNS AND NO REAL MILLISECOND. Every test injects its own
 * `lookup`, its own `monotonicMs` and its own `delay`, and the delay is
 * RECORDED rather than awaited for real — which is the only way the timing
 * floor can be asserted instead of hoped for.
 *
 * The real classifier IS used. `classifyHost` and `classifyAddress` from
 * private-address.ts are pure, and a fake classifier would be a second opinion
 * about which addresses are private; the first thing a second opinion does is
 * diverge from the one that ships.
 */

const AT = new Date('2026-10-29T12:00:00.000Z');

/** The addresses the fake resolver answers with. Public, private, loopback, IMDS. */
const ANSWERS: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'public.example.com': ['93.184.216.34'],
  'second.example.com': ['93.184.216.35'],
  'third.example.com': ['93.184.216.36'],
  'fourth.example.com': ['93.184.216.37'],
  'fifth.example.com': ['93.184.216.38'],
  'sixth.example.com': ['93.184.216.39'],
  'seventh.example.com': ['93.184.216.40'],
  'rebind.example.com': ['93.184.216.34', '169.254.169.254'],
  'internal.example.com': ['10.0.0.5'],
  'home.example.com': ['127.0.0.1'],
  'metadata.example.com': ['169.254.169.254'],
  'app.internal': ['10.0.0.5'],
  'dual.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  /*
   * A SPLIT ANSWER WHOSE PRIVATE HALF IS SECOND, and a second copy with the
   * order reversed. The pair exists because the order is the attacker's to
   * choose: see 'KEEPS A THIRD-PARTY CONTEXT OFF A PRIVATE ADDRESS WHATEVER
   * ORDER THE RECORDS ARRIVE IN' below.
   */
  'split-public-first.example.com': ['93.184.216.34', '10.0.0.5'],
  'split-private-first.example.com': ['10.0.0.5', '93.184.216.34'],
};

interface Recorder {
  readonly io: EgressGuardIo;
  readonly delays: number[];
}

/**
 * The injected world.
 *
 * `monotonicMs` is scripted: it returns each value in `ticks` once and then
 * repeats the last, so a test can say "the policy decided in 0ms" and "the
 * resolver took 40ms" and then measure the pad that was requested.
 */
function recorder(options: { ticks?: number[]; throws?: boolean } = {}): Recorder {
  const delays: number[] = [];
  const ticks = [...(options.ticks ?? [0, 0])];
  let last = 0;
  return {
    delays,
    io: {
      classifyHost,
      classifyAddress,
      lookup: async (host) => {
        if (options.throws === true) throw new Error('resolver down');
        return (ANSWERS[host] ?? []).map((address) => ({ address }));
      },
      now: () => AT,
      monotonicMs: () => {
        const next = ticks.shift();
        if (next !== undefined) last = next;
        return last;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    },
  };
}

const guard = (
  url: string,
  policy: EgressPolicy = HOSTED_EGRESS_POLICY,
  io: EgressGuardIo = recorder().io,
): Promise<GuardVerdict> => guardUrl({ url, context: 'CRAWL', policy, io });

/** A chain whose transport answers from a script of (status, location) pairs. */
function chain(
  url: string,
  script: readonly RedirectHop[],
  options: { policy?: EgressPolicy; cap?: number; context?: EgressPermit['context'] } = {},
): Promise<EgressChain> {
  let hop = 0;
  return guardRedirectChain({
    url,
    context: options.context ?? 'CRAWL',
    policy: options.policy ?? HOSTED_EGRESS_POLICY,
    io: recorder().io,
    hop: async () => {
      const step = script[hop];
      hop += 1;
      return step ?? { status: 200, location: null };
    },
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
}

const refused = (verdict: GuardVerdict): GuardRefusal => {
  if (verdict.ok) throw new Error('expected a refusal and the guard issued a permit');
  return verdict.refusal;
};

const permitOf = (verdict: GuardVerdict): EgressPermit => {
  if (!verdict.ok) throw new Error(`expected a permit and the guard refused: ${verdict.refusal}`);
  return verdict.permit;
};

describe('the refusal vocabulary has both halves', () => {
  it('names every refusal in the rule record, host-level and URL-level', () => {
    // The compile-time half is the `satisfies Record<GuardRefusal, …>` in the
    // module; this is the run-time half. One without the other passes while the
    // two disagree, which is how eight GateRule kinds shipped unsaveable.
    expect(Object.keys(GUARD_REFUSAL_RULES).sort()).toEqual(
      [...EGRESS_REFUSALS, ...EGRESS_GUARD_REFUSALS].sort(),
    );
  });

  it('nests the host-level union inside the guard union, so a tally stays readable', () => {
    // A `GuardTally.refusal` may hold either. Anything that understands the
    // narrower `EgressRefusal` must still be able to read the rows this file
    // writes for the nine host-level reasons.
    for (const refusal of EGRESS_REFUSALS) {
      expect(ALL_GUARD_REFUSALS, refusal).toContain(refusal);
      expect(GUARD_REFUSAL_RULES[refusal].urlLevel, refusal).toBe(false);
    }
    for (const refusal of EGRESS_GUARD_REFUSALS) {
      expect(GUARD_REFUSAL_RULES[refusal].urlLevel, refusal).toBe(true);
    }
    expect(ALL_GUARD_REFUSALS).toHaveLength(
      EGRESS_REFUSALS.length + EGRESS_GUARD_REFUSALS.length,
    );
  });

  it('fetches over exactly two schemes', () => {
    expect([...EGRESS_SCHEMES]).toEqual(['http:', 'https:']);
  });
});

describe('a URL is refused before a host is ever decided', () => {
  it('refuses a URL that does not parse', async () => {
    expect(refused(await guard('not a url'))).toBe('URL_UNPARSEABLE');
  });

  it('refuses a scheme that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/1', 'data:text/html,<b>']) {
      expect(refused(await guard(url)), url).toBe('SCHEME_NOT_PERMITTED');
    }
  });

  it('refuses userinfo, which is the oldest host confusion there is', async () => {
    // `http://trusted.example.com@169.254.169.254/` reads as a trusted host to
    // a human and to every log line, and the parser correctly calls the host
    // 169.254.169.254. Refusing the SHAPE means nobody downstream has to be
    // right about which half is the host.
    const verdict = await guard('http://trusted.example.com@169.254.169.254/latest/meta-data/');
    expect(refused(verdict)).toBe('CREDENTIALS_IN_URL');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.target).toBeNull();
  });

  it('refuses a password in the URL without putting it in the detail', async () => {
    const verdict = await guard('http://admin:hunter2@example.com/');
    expect(refused(verdict)).toBe('CREDENTIALS_IN_URL');
    if (!verdict.ok) {
      // NEVER LOG A SECRET. Not truncated, not hashed, not in an error path.
      expect(verdict.operatorDetail).not.toContain('hunter2');
      expect(verdict.operatorDetail).not.toContain('admin');
    }
  });
});

describe('the four SSRF probes that were accepted', () => {
  it('refuses the metadata address as a literal', async () => {
    const verdict = await guard('http://169.254.169.254/latest/meta-data/iam/');
    expect(refused(verdict)).toBe('NOT_ALLOWLISTED');
    if (!verdict.ok) expect(verdict.decision?.decidedByClass).toBe('link-local');
  });

  it('refuses a name that RESOLVES to the metadata address', async () => {
    // The literal is the probe people block. The NAME is the one that gets in,
    // and it is one A record away from being free.
    expect(refused(await guard('http://metadata.example.com/'))).toBe('NOT_ALLOWLISTED');
  });

  it('refuses loopback and RFC1918 to a hosted crawl', async () => {
    expect(refused(await guard('http://127.0.0.1:5432/'))).toBe('CLASS_NOT_PERMITTED');
    expect(refused(await guard('http://10.0.0.5/'))).toBe('CLASS_NOT_PERMITTED');
    expect(refused(await guard('http://home.example.com/'))).toBe('CLASS_NOT_PERMITTED');
    expect(refused(await guard('http://internal.example.com/'))).toBe('CLASS_NOT_PERMITTED');
  });

  it('refuses a record set that mixes one public address with the metadata address', async () => {
    // EVERY address, not the first and not any. A mixed record set is not a
    // misconfiguration, it is the attack written down.
    expect(refused(await guard('http://rebind.example.com/'))).toBe('NOT_ALLOWLISTED');
  });

  it('KEEPS A THIRD-PARTY CONTEXT OFF A PRIVATE ADDRESS WHATEVER ORDER THE RECORDS ARRIVE IN', async () => {
    /*
     * THE PROBE THAT FOUND THIS, AND WHY IT IS A REAL ONE.
     *
     * The rule above this test says the four third-party contexts "may never
     * reach a private address — not in any deployment and not through the
     * allowlist", and it is enforced here in `guardUrl` by branching on
     * `decision.decidedByClass`. While `decidePinned` set that field from
     * `pinned.addresses[0]`, the branch was switchable from outside: the
     * attacker owns the zone, so the attacker chooses which record is first.
     *
     * MEASURED on SELF_HOSTED (which permits `private`, so nothing in the
     * policy objects): public-first answered class `public`, the rule did not
     * fire, the verdict was ALLOW PINNED, and the pin it handed back INCLUDED
     * 10.0.0.5 — `assertConnectingTo(decision, '10.0.0.5')` returned ok and
     * `pinnedLookup` offered the address to the transport. Private-first was
     * refused. Same host, same policy, same two addresses, opposite outcome.
     *
     * Both orders are asserted on purpose: a fix that only looked at the last
     * address would pass one of them and ship the same hole mirrored.
     */
    for (const host of ['split-public-first.example.com', 'split-private-first.example.com']) {
      for (const context of [
        'WEBHOOK_DELIVERY',
        'TRACKER_CALL',
        'SSO_METADATA',
        'DOCUMENT_FETCH',
      ] as const) {
        const verdict = await guardUrl({
          url: `http://${host}/hooks/token-in-this-path`,
          context,
          policy: SELF_HOSTED_EGRESS_POLICY,
          io: recorder().io,
        });
        expect(refused(verdict), `${host} / ${context}`).toBe('CONTEXT_NOT_PERMITTED');
      }
    }
  });

  it('still lets the APPLICATION-UNDER-TEST contexts reach a split answer when self-hosted', async () => {
    // The other side of the rule, so the fix above cannot quietly become a
    // blanket refusal: CRAWL, LOGIN and PLUGIN_HTTP legitimately reach a
    // self-hosted customer's own internal application, and that is the whole
    // reason SELF_HOSTED permits `private` at all.
    for (const context of ['CRAWL', 'LOGIN', 'PLUGIN_HTTP'] as const) {
      const verdict = await guardUrl({
        url: 'http://split-public-first.example.com/',
        context,
        policy: SELF_HOSTED_EGRESS_POLICY,
        io: recorder().io,
      });
      const permit = permitOf(verdict);
      expect(permit.kind, context).toBe('PINNED');
      expect(permit.decision.decidedByClass, context).toBe('private');
    }
  });

  it('refuses an ambiguous literal rather than handing it to a resolver', async () => {
    // A bare host string, which is the caller that has no normaliser in front
    // of it. `new URL()` would have normalised `0177.0.0.1` to `127.0.0.1`.
    const io = recorder().io;
    const verdict = await guardUrl({
      url: 'http://0x7f.0.0.1/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io,
    });
    // Either reading is a refusal; what must never happen is a permit.
    expect(verdict.ok).toBe(false);
  });
});

describe('the permit carries the pinned address set, not the name', () => {
  it('pins the resolved addresses on an allowed name', async () => {
    const permit = permitOf(await guard('https://example.com/orders?token=abc'));
    expect(permit.kind).toBe('PINNED');
    expect(permit.pinned?.addresses.map((a) => a.address)).toEqual(['93.184.216.34']);
    expect(permit.pinned?.fromLiteral).toBe(false);
    expect(permit.target.host).toBe('example.com');
  });

  it('refuses a connection to an address nobody classified', () => {
    // The half that turns a check into a pin. Everything above it is defeated
    // by a second DNS lookup.
    const pinned = {
      host: 'example.com',
      addresses: [{ address: '93.184.216.34', class: 'public' as const }],
      pinnedAt: AT.toISOString(),
      fromLiteral: false,
    };
    const verdict = assertConnectingTo(
      {
        context: 'CRAWL',
        host: 'example.com',
        allowed: true,
        outcome: 'ALLOWED',
        refusal: null,
        decidedByClass: 'public',
        allowlistedBy: null,
        mode: 'ENFORCE',
        pinned,
        detail: '',
        warning: null,
      },
      '169.254.169.254',
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe('PINNED_SET_CHANGED');
  });

  it('never puts a URL PATH or QUERY in a target, a permit or a detail', async () => {
    // For a webhook the path IS the bearer credential, and a redirect to an
    // identity provider carries a state token in its query string.
    const permit = permitOf(await guard('https://example.com/webhooks/s3cr3t-token?key=v'));
    expect(JSON.stringify(permit)).not.toContain('s3cr3t');
    expect(JSON.stringify(permit)).not.toContain('key=v');
    expect(permit.target.origin).toBe('https://example.com');

    const verdict = await guard('http://metadata.example.com/latest/meta-data/iam/s3cr3t');
    if (!verdict.ok) {
      expect(verdict.operatorDetail).not.toContain('s3cr3t');
      expect(verdict.operatorDetail).not.toContain('meta-data');
    }
  });

  it('rebuilds the origin from the normalised host, trailing dot and all', async () => {
    // `URL.origin` keeps the trailing dot, and the chain's loop detector keys
    // on this string: taking the parser's spelling would let a redirect
    // alternate between `example.com` and `example.com.` forever.
    const permit = permitOf(await guard('https://EXAMPLE.com./a'));
    expect(permit.target.host).toBe('example.com');
    expect(permit.target.origin).toBe('https://example.com');
  });
});

describe('the brake is visible and it counts', () => {
  const observing: EgressPolicy = { ...HOSTED_EGRESS_POLICY, mode: 'OBSERVE' };

  it('lets an observed refusal through, names what would have refused it, and pins NOTHING', async () => {
    const permit = permitOf(await guard('http://metadata.example.com/', observing));
    expect(permit.kind).toBe('OBSERVED');
    expect(permit.wouldRefuse).toBe('NOT_ALLOWLISTED');
    // A caller in observe mode connects the way it did before this control
    // existed. Handing back a pin would claim a closed window for a connection
    // nobody authorised.
    expect(permit.pinned).toBeNull();
  });

  it('counts an observed refusal as WOULD_REFUSE and never as ALLOWED', async () => {
    const tallies = new Map<string, GuardTally>();
    countGuard(tallies, await guard('http://metadata.example.com/', observing));
    countGuard(tallies, await guard('http://127.0.0.1/', observing));
    countGuard(tallies, await guard('https://example.com/', observing));
    const totals = guardTotals(tallies.values());
    // An observed refusal recorded as ALLOWED is a cap applied without being
    // counted, which is one of the lies this product cannot afford.
    expect(totals).toEqual({ wouldRefuse: 2, refused: 0, allowed: 1, total: 3 });
  });

  it('counts EVERY decision, so the refusal count has a denominator', async () => {
    const tallies = new Map<string, GuardTally>();
    for (const url of [
      'https://example.com/a',
      'https://example.com/b',
      'http://169.254.169.254/',
      'not a url',
    ]) {
      countGuard(tallies, await guard(url));
    }
    expect(guardTotals(tallies.values())).toEqual({
      wouldRefuse: 0,
      refused: 2,
      allowed: 2,
      total: 4,
    });
  });

  it('buckets on (context, outcome, class, refusal) and nothing finer', () => {
    // A row per connection would be an inventory of every internal hostname a
    // crawl touched — unbounded, and the thing an attacker most wants to read.
    const key = guardTallyKey({
      context: 'CRAWL',
      outcome: 'REFUSED',
      addressClass: 'link-local',
      refusal: 'NOT_ALLOWLISTED',
    });
    expect(key).not.toContain('example.com');
    expect(key.split('\u001f')).toEqual([
      'CRAWL',
      'REFUSED',
      'link-local',
      'NOT_ALLOWLISTED',
    ]);
  });

  it('counts a URL-level refusal as REFUSED in observe mode too', async () => {
    // There is no "observe" reading of a URL that does not parse, and dressing
    // one up as a mode decision would make the brake look like it covered more
    // than it does.
    const tallies = new Map<string, GuardTally>();
    countGuard(tallies, await guard('file:///etc/passwd', observing));
    expect(guardTotals(tallies.values())).toEqual({
      wouldRefuse: 0,
      refused: 1,
      allowed: 0,
      total: 1,
    });
  });
});

describe('no control may be an oracle', () => {
  it('shows ONE sentence for every one of the seventeen refusals', async () => {
    // Identical for a loopback address, an unresolvable name, a redirect cap
    // and a URL that did not parse. The moment it varies it becomes a map of
    // the inside of a network.
    const expected = { sentence: EGRESS_REFUSAL_SENTENCE };
    for (const refusal of ALL_GUARD_REFUSALS) {
      const verdict: GuardVerdict = {
        ok: false,
        refusal,
        operatorDetail: `internal detail naming ${refusal}`,
        context: 'CRAWL',
        decision: null,
        target: null,
        paddedMs: 0,
      };
      expect(refusalForCaller(verdict), refusal).toEqual(expected);
    }
  });

  it('gives a caller NOTHING but the sentence — no code, no host, no class', async () => {
    const policyRefusal = await guard('http://metadata.example.com/');
    const doesNotResolve = await guard('http://nowhere.example.com/');
    // The two refusals are DIFFERENT facts about the inside of a network and
    // the caller-facing projection must not tell them apart.
    expect(refused(policyRefusal)).toBe('NOT_ALLOWLISTED');
    expect(refused(doesNotResolve)).toBe('NO_ADDRESSES');
    expect(refusalForCaller(policyRefusal)).toEqual(refusalForCaller(doesNotResolve));
    expect(Object.keys(refusalForCaller(policyRefusal))).toEqual(['sentence']);
  });

  it('pads a policy refusal and an unresolvable name to the SAME floor', async () => {
    // A refusal that happens in 0.2ms when the policy decides and in 90ms when
    // the resolver answers tells an attacker whether an internal name exists,
    // whatever the message says.
    const fast = recorder({ ticks: [0, 0] });
    await guardUrl({
      url: 'http://169.254.169.254/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: fast.io,
    });

    const slow = recorder({ ticks: [0, 40] });
    await guardUrl({
      url: 'http://nowhere.example.com/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: slow.io,
    });

    expect(fast.delays).toEqual([EGRESS_REFUSAL_FLOOR_MS]);
    expect(slow.delays).toEqual([EGRESS_REFUSAL_FLOOR_MS - 40]);
    // The measured fact: both land on the floor.
    expect(fast.delays[0]! + 0).toBe(EGRESS_REFUSAL_FLOOR_MS);
    expect(slow.delays[0]! + 40).toBe(EGRESS_REFUSAL_FLOOR_MS);
  });

  it('OVER-pads rather than skipping the pad when the clock steps backwards', async () => {
    // Measured, and it is the opposite of what the obvious guess says. An NTP
    // step backwards makes the elapsed interval NEGATIVE, so the pad comes out
    // LARGER than the floor — 250 - (-90) = 340 — not negative. That direction
    // is the safe one: a refusal that waited too long leaks nothing, whereas a
    // refusal that skipped its pad is the oracle this is here to close. Stated
    // as the measurement because the first version of this test asserted
    // `>= 0`, which was true for the wrong reason and let the clamp below be
    // deleted without a single test going red.
    const back = recorder({ ticks: [100, 10] });
    const verdict = await guardUrl({
      url: 'http://169.254.169.254/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: back.io,
    });
    expect(back.delays).toEqual([EGRESS_REFUSAL_FLOOR_MS + 90]);
    if (!verdict.ok) expect(verdict.paddedMs).toBe(EGRESS_REFUSAL_FLOOR_MS + 90);
  });

  it('does not pad an ALLOWED connection', async () => {
    // Deliberate, and the module says so: an attacker who is allowed through
    // learns that from the response body. The leak worth closing is the one
    // BETWEEN TWO REFUSALS, and padding every success would make the product
    // slower for nothing.
    const allowed = recorder();
    await guardUrl({
      url: 'https://example.com/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: allowed.io,
    });
    expect(allowed.delays).toEqual([]);
  });

  it('pads a refusal that took longer than the floor by nothing, rather than speeding it up', async () => {
    const late = recorder({ ticks: [0, 9_000] });
    await guardUrl({
      url: 'http://nowhere.example.com/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: late.io,
    });
    // Honest limitation, asserted rather than claimed away: this is a FLOOR and
    // not constant time. A nine-second resolver timeout still stands out, and
    // the remedy belongs to whoever owns the resolver timeout.
    expect(late.delays).toEqual([]);
    // And `paddedMs` is REPORTED as zero rather than as the negative number the
    // arithmetic produces. A verdict saying it was "padded by -8,750ms" would
    // be a measured value that was never measured, in the field an operator
    // reads to check the floor is working. This is the assertion that holds the
    // clamp in `padFor`: without it, deleting the clamp passed every test.
    const verdict = await guardUrl({
      url: 'http://nowhere.example.com/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: recorder({ ticks: [0, 9_000] }).io,
    });
    if (!verdict.ok) expect(verdict.paddedMs).toBe(0);
  });
});

describe('every redirect hop is a NEW egress decision', () => {
  it('refuses public → private at the hop', async () => {
    const result = await chain('https://example.com/', [
      { status: 302, location: 'http://internal.example.com/' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('CLASS_NOT_PERMITTED');
    // Hop 0 was permitted, which is the whole point: guarding the first URL and
    // following the rest is not a weaker version of this control.
    expect(result.hops[0]?.permit?.kind).toBe('PINNED');
    expect(result.hops[0]?.redirectedTo).toBe('http://internal.example.com');
  });

  it('refuses public → loopback at the hop', async () => {
    const result = await chain('https://example.com/', [
      { status: 307, location: 'http://127.0.0.1:5432/' },
    ]);
    expect(result.refusal).toBe('CLASS_NOT_PERMITTED');
  });

  it('refuses public → IMDS at the hop, which is how most real SSRF gets in', async () => {
    // It needs no control over DNS and no race — just a page on the public
    // internet answering `Location: http://169.254.169.254/`.
    const result = await chain('https://example.com/', [
      { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    ]);
    expect(result.refusal).toBe('NOT_ALLOWLISTED');
    expect(result.final).toBeNull();
  });

  it('refuses a relative Location that lands on a private host after two hops', async () => {
    const result = await chain('https://example.com/', [
      { status: 302, location: 'https://second.example.com/next' },
      { status: 302, location: '//metadata.example.com/' },
    ]);
    expect(result.refusal).toBe('NOT_ALLOWLISTED');
    expect(result.hops).toHaveLength(3);
  });

  it('refuses a loop by name rather than letting the cap take the blame', async () => {
    const result = await chain('https://example.com/a', [
      { status: 302, location: 'https://second.example.com/b' },
      { status: 302, location: 'https://example.com/c' },
    ]);
    expect(result.refusal).toBe('REDIRECT_LOOP');
    // A loop reported as a cap is a cap that did not bite.
    expect(result.cappedAtHop).toBeNull();
  });

  it('follows a redirect to a DIFFERENT PORT and issues a FRESH pin for it', async () => {
    // Measured behaviour, stated rather than implied: a port is not an address
    // class, so the policy does not decide on it. What the guard DOES do is
    // decide again and pin again, which is the correct treatment.
    const result = await chain(
      'http://app.internal/',
      [{ status: 302, location: 'http://app.internal:5432/' }],
      { policy: SELF_HOSTED_EGRESS_POLICY },
    );
    expect(result.ok).toBe(true);
    expect(result.hops).toHaveLength(2);
    expect(result.hops[1]?.origin).toBe('http://app.internal:5432');
    expect(result.hops[1]?.permit?.pinned).not.toBe(result.hops[0]?.permit?.pinned);
    expect(result.hops[1]?.permit?.pinned?.addresses.map((a) => a.address)).toEqual(['10.0.0.5']);
  });

  it('follows an http → https UPGRADE', async () => {
    const result = await chain('http://example.com/', [
      { status: 301, location: 'https://example.com/' },
    ]);
    // The origin changes, so the loop detector does not fire, and the scheme
    // rule only refuses the other direction.
    expect(result.ok).toBe(true);
    expect(result.final?.target.scheme).toBe('https:');
  });

  it('refuses an https → http DOWNGRADE, for every context', async () => {
    for (const context of ['CRAWL', 'LOGIN', 'DOCUMENT_FETCH'] as const) {
      const result = await chain(
        'https://example.com/',
        [{ status: 302, location: 'http://second.example.com/' }],
        { context },
      );
      expect(result.refusal, context).toBe('SCHEME_DOWNGRADE');
    }
  });

  it('caps the chain AND REPORTS the cap', async () => {
    const script: RedirectHop[] = [
      { status: 302, location: 'https://second.example.com/' },
      { status: 302, location: 'https://third.example.com/' },
      { status: 302, location: 'https://fourth.example.com/' },
      { status: 302, location: 'https://fifth.example.com/' },
      { status: 302, location: 'https://sixth.example.com/' },
      { status: 302, location: 'https://seventh.example.com/' },
      { status: 302, location: 'https://example.com/' },
    ];
    const result = await chain('https://public.example.com/', script, { cap: 3 });
    expect(result.refusal).toBe('REDIRECT_CAP');
    // A cap applied without being counted and reported is one of the lies this
    // product cannot afford. Both facts, because they are two facts.
    expect(result.cap).toBe(3);
    expect(result.cappedAtHop).toBe(4);
    expect(result.tallies.some((t) => t.refusal === 'REDIRECT_CAP')).toBe(true);
  });

  it('defaults the cap to five and reports it even when it did not bite', async () => {
    const result = await chain('https://example.com/', [{ status: 200, location: null }]);
    expect(result.cap).toBe(DEFAULT_REDIRECT_CAP);
    expect(result.cappedAtHop).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('refuses a 3xx with no Location rather than guessing where it meant', async () => {
    const result = await chain('https://example.com/', [{ status: 302, location: null }]);
    expect(result.refusal).toBe('REDIRECT_NO_LOCATION');
  });

  it('refuses a Location that will not resolve', async () => {
    const result = await chain('https://example.com/', [
      { status: 302, location: 'http://[not-an-address' },
    ]);
    // Either reading — unresolvable or unparseable — is a refusal. What may
    // never happen is a chain that carries on.
    expect(result.ok).toBe(false);
    expect(['REDIRECT_UNRESOLVABLE', 'URL_UNPARSEABLE']).toContain(result.refusal);
  });

  it('counts every hop, allowed hops included', async () => {
    const result = await chain('https://example.com/', [
      { status: 302, location: 'https://second.example.com/' },
      { status: 302, location: 'http://169.254.169.254/' },
    ]);
    const totals = guardTotals(result.tallies);
    expect(totals.allowed).toBe(2);
    expect(totals.refused).toBe(1);
    expect(totals.total).toBe(3);
  });

  it('hands the transport a PERMIT and never a URL string', async () => {
    // The ergonomic half of the control. A caller holding a permit has the
    // pinned addresses right there; a caller handed a URL would have to go out
    // of its way to pin, and the thing nobody does is the extra step.
    const seen: EgressPermit[] = [];
    await guardRedirectChain({
      url: 'https://example.com/',
      context: 'CRAWL',
      policy: HOSTED_EGRESS_POLICY,
      io: recorder().io,
      hop: async (permit) => {
        seen.push(permit);
        return { status: 200, location: null };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pinned?.addresses.map((a) => a.address)).toEqual(['93.184.216.34']);
  });
});

describe('the pinned-connect adapters are the easy path', () => {
  const permitFor = async (url: string, policy = HOSTED_EGRESS_POLICY): Promise<EgressPermit> =>
    permitOf(await guard(url, policy));

  it('answers a Node lookup with the pinned addresses in the array form', async () => {
    const permit = await permitFor('https://dual.example.com/');
    let answers: readonly PinnedLookupAddress[] | undefined;
    pinnedLookup(permit)('dual.example.com', { all: true }, (err, value) => {
      expect(err).toBeNull();
      answers = value as readonly PinnedLookupAddress[];
    });
    expect(answers).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  it('answers the single-address form too, because Node calls both', async () => {
    // A lookup that answered only one arity would silently fall back to the
    // system resolver for the other, which is the pin not applying.
    const permit = await permitFor('https://example.com/');
    let address: string | undefined;
    let family: number | undefined;
    pinnedLookup(permit)('example.com', {}, (err, value, fam) => {
      expect(err).toBeNull();
      address = value as string;
      family = fam;
    });
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('REFUSES an OBSERVED permit rather than borrowing a pin it was not given', async () => {
    const permit = await permitFor('http://metadata.example.com/', {
      ...HOSTED_EGRESS_POLICY,
      mode: 'OBSERVE',
    });
    expect(permit.kind).toBe('OBSERVED');
    let err: Error | null = null;
    pinnedLookup(permit)('metadata.example.com', { all: true }, (error) => {
      err = error;
    });
    expect(err).toBeInstanceOf(Error);
    expect(chromiumHostResolverRules([permit])).toBe('');
    expect(pinnedRequestTarget(permit, 'http://metadata.example.com/')).toBeNull();
  });

  it('refuses a hostname the permit did not decide about', async () => {
    // An agent reused across two hosts would otherwise pin the second to the
    // first's addresses.
    const permit = await permitFor('https://example.com/');
    let err: Error | null = null;
    pinnedLookup(permit)('metadata.example.com', { all: true }, (error) => {
      err = error;
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('errors rather than answering empty when the family cannot be satisfied', async () => {
    // An empty answer from a lookup is a connection that silently does not
    // happen in one Node version and falls back in another.
    const permit = await permitFor('https://example.com/');
    let err: Error | null = null;
    pinnedLookup(permit)('example.com', { all: true, family: 6 }, (error) => {
      err = error;
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('builds the browser switch that pins Chromium, which has its own resolver', async () => {
    const first = await permitFor('https://example.com/');
    const second = await permitFor('https://dual.example.com/');
    expect(chromiumHostResolverRules([first, second])).toBe(
      'MAP example.com 93.184.216.34,' +
        'MAP dual.example.com 93.184.216.34,' +
        'MAP dual.example.com 2606:2800:220:1:248:1893:25c8:1946',
    );
  });

  it('does not repeat a rule when the same host is permitted twice', async () => {
    const permit = await permitFor('https://example.com/a');
    const again = await permitFor('https://example.com/b');
    expect(chromiumHostResolverRules([permit, again])).toBe('MAP example.com 93.184.216.34');
  });

  it('rewrites an http URL to the pinned address and keeps the Host header', async () => {
    const permit = await permitFor('http://example.com/orders?page=2');
    const target = pinnedRequestTarget(permit, 'http://example.com/orders?page=2');
    expect(target).toEqual({
      url: 'http://93.184.216.34/orders?page=2',
      hostHeader: 'example.com',
    });
  });

  it('keeps the PORT in the Host header, because a vhost on one is addressed by name:port', async () => {
    const permit = await permitFor('http://example.com:8080/x');
    expect(pinnedRequestTarget(permit, 'http://example.com:8080/x')?.hostHeader).toBe(
      'example.com:8080',
    );
  });

  it('REFUSES to rewrite an https URL, and the null is the honest answer', async () => {
    // Rewriting the host changes the SNI name, so the peer presents a
    // certificate for an address nobody has one for; the request fails, and the
    // next person "fixes" it by turning verification off — trading an SSRF for
    // a MITM on every request the product makes.
    const permit = await permitFor('https://example.com/');
    expect(pinnedRequestTarget(permit, 'https://example.com/')).toBeNull();
  });

  it('refuses to rewrite a URL for a host the permit did not decide about', async () => {
    const permit = await permitFor('http://example.com/');
    expect(pinnedRequestTarget(permit, 'http://second.example.com/')).toBeNull();
  });
});

describe('the self-hosted escape is a policy, never an off switch', () => {
  it('permits the customer\'s own private app in SELF_HOSTED, with the skipped check NAMED', async () => {
    const permit = permitOf(await guard('http://app.internal/', SELF_HOSTED_EGRESS_POLICY));
    expect(permit.kind).toBe('PINNED');
    // A guard that passes silently in the one mode where it does nothing is
    // indistinguishable from a guard that ran.
    expect(permit.decision.warning).not.toBeNull();
  });

  it('still refuses the metadata address in SELF_HOSTED, which is stricter than permissive', async () => {
    expect(refused(await guard('http://169.254.169.254/', SELF_HOSTED_EGRESS_POLICY))).toBe(
      'NOT_ALLOWLISTED',
    );
    expect(refused(await guard('http://metadata.example.com/', SELF_HOSTED_EGRESS_POLICY))).toBe(
      'NOT_ALLOWLISTED',
    );
  });

  it('refuses a private target for a THIRD-PARTY context in every deployment', async () => {
    // An operator who allowlists an internal host for webhook delivery has
    // built an SSRF with paperwork.
    //
    // THIS IS THE TEST FOR THE HOLE THE GUARD CLOSES. `decideEgress` ALLOWS all
    // four of these in SELF_HOSTED — probed at HEAD 37498c1 — because
    // `decidePinned` reaches the context rule only when the class is already
    // outside `permittedClasses`, and SELF_HOSTED permits `private`. The
    // keystone's own `EGRESS_CONTEXT_RULES` comment promises the opposite. The
    // guard is what makes the comment true; see its arm for the measurement.
    for (const context of ['WEBHOOK_DELIVERY', 'TRACKER_CALL', 'SSO_METADATA', 'DOCUMENT_FETCH'] as const) {
      const verdict = await guardUrl({
        url: 'http://app.internal/hook',
        context,
        policy: SELF_HOSTED_EGRESS_POLICY,
        io: recorder().io,
      });
      expect(refused(verdict), context).toBe('CONTEXT_NOT_PERMITTED');
    }
  });

  it('names THE POLICY as the decider that would have refused, in every order', async () => {
    /*
     * THE TEST THAT THE STRUCTURAL FIX IS STRUCTURAL.
     *
     * This assertion used to read `observedBy: 'GUARD'` and
     * `decision.outcome: 'ALLOWED'`, and it was correct: the POLICY permitted a
     * private address for a webhook — SELF_HOSTED permits `private` — and this
     * file's own rule was the only thing refusing it. That is a compensating
     * control, and it held for exactly the callers that went through
     * `guardUrl`.
     *
     * `decidePinned` now applies the rule, so the policy itself answers
     * WOULD_REFUSE with `CONTEXT_NOT_PERMITTED` and the guard's copy is never
     * reached. Asserting POLICY here is what goes red if that moves back into
     * this file, which is the whole point of recording which decider refused
     * rather than inferring it.
     *
     * Both record orders and all four contexts, because the previous fix in
     * this area passed one order and shipped the same hole mirrored.
     */
    for (const host of ['app.internal', 'split-public-first.example.com', 'split-private-first.example.com']) {
      for (const context of [
        'WEBHOOK_DELIVERY',
        'TRACKER_CALL',
        'SSO_METADATA',
        'DOCUMENT_FETCH',
      ] as const) {
        const where = `${host} / ${context}`;
        const permit = permitOf(
          await guardUrl({
            url: `http://${host}/hook`,
            context,
            policy: { ...SELF_HOSTED_EGRESS_POLICY, mode: 'OBSERVE' },
            io: recorder().io,
          }),
        );
        expect(permit.kind, where).toBe('OBSERVED');
        expect(permit.decision.outcome, where).toBe('WOULD_REFUSE');
        expect(permit.decision.refusal, where).toBe('CONTEXT_NOT_PERMITTED');
        expect(permit.wouldRefuse, where).toBe('CONTEXT_NOT_PERMITTED');
        if (permit.kind === 'OBSERVED') expect(permit.observedBy, where).toBe('POLICY');
        // Still no pin, because nothing was authorised. An observed refusal
        // that handed back a pin would claim the rebinding window was closed
        // for a connection nobody authorised.
        expect(permit.pinned, where).toBeNull();
      }
    }
  });

  it('counts a guard-decided observation as WOULD_REFUSE, like a policy-decided one', async () => {
    // A mode that does not count is an off switch with a reassuring name, and
    // that applies to the guard's own rule exactly as it does to the policy's.
    const tallies = new Map<string, GuardTally>();
    countGuard(
      tallies,
      await guardUrl({
        url: 'http://app.internal/hook',
        context: 'WEBHOOK_DELIVERY',
        policy: { ...SELF_HOSTED_EGRESS_POLICY, mode: 'OBSERVE' },
        io: recorder().io,
      }),
    );
    expect(guardTotals(tallies.values())).toEqual({
      wouldRefuse: 1,
      refused: 0,
      allowed: 0,
      total: 1,
    });
  });

  it('leaves a CRAWL to the same private host permitted, which is the product working', async () => {
    // The rule is about the four contexts aimed at a third party. A self-hosted
    // QAAI exists precisely to crawl `app.internal`, and a guard that refused
    // that would have broken the install for every customer behind a firewall.
    const permit = permitOf(
      await guardUrl({
        url: 'http://app.internal/',
        context: 'CRAWL',
        policy: SELF_HOSTED_EGRESS_POLICY,
        io: recorder().io,
      }),
    );
    expect(permit.kind).toBe('PINNED');
  });

  it('refuses everything when no policy could be resolved', async () => {
    // A missing policy is not an open one. An exception handler that falls
    // through to "allow" is the defect pattern this round hunts.
    expect(
      refused(await guard('https://example.com/', { ...HOSTED_EGRESS_POLICY, permittedClasses: [] })),
    ).toBe('POLICY_UNRESOLVED');
  });

  it('refuses when the resolver throws', async () => {
    const io = recorder({ throws: true }).io;
    expect(refused(await guard('https://example.com/', HOSTED_EGRESS_POLICY, io))).toBe(
      'UNRESOLVED',
    );
  });
});
