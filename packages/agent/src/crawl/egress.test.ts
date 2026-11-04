import { describe, expect, it } from 'vitest';
import {
  CrawlEgressGate,
  DEFAULT_PIN_TTL_MS,
  EGRESS_EXCLUSION_RULE,
  HOST_SAMPLE_CAP,
  WANTED_EXCLUSION_KIND,
} from './egress';
import type { CrawlEgressGuard, GuardAnswer } from './egress';
import { EXCLUSION_KINDS, exclusionsByRule } from '@qaai/shared';
import type { EgressDecision, GuardRefusal, GuardedTarget } from '@qaai/shared';
import type { AddressClass } from '@qaai/shared/private-address';

/**
 * The crawl's egress gate.
 *
 * NO NETWORK AND NO REAL DNS — the guard itself is the injected port, so these
 * tests never reach `decideEgress`, a resolver or a socket. The clock is
 * injected too, which is the only way a pin's TTL can be asserted rather than
 * waited for.
 *
 * What is NOT covered here, stated rather than left to be assumed: the guard's
 * own decisions — which class is private, what a redirect hop does, whether the
 * refusal sentence is uniform — are `packages/shared/src/egress-guard.test.ts`,
 * because they belong to the guard. These tests are about the GATE: that it
 * asks, that it records, that it counts, that it pins, and that a tenant learns
 * nothing from a refusal.
 */

/*
 * ─── THE FAKES ARE BUILT TO THE REAL TYPE, AND THAT IS LOAD-BEARING ────────
 *
 * These builders used to assemble the narrowest object the gate reads — a
 * `target` of host and origin, a `decision` of outcome and class, a `pinned` of
 * host and addresses. Every one of them type-checked, because the gate declared
 * its own width-subset copy of the guard's verdict.
 *
 * That copy is gone and these fakes now build `EgressGuardVerdict` itself, so
 * every field the real guard emits has to be named here. It changed a result:
 * `pinned` is non-nullable on the PINNED arm, so the test that built a PINNED
 * permit with a null pin was asserting a state the guard cannot represent, and
 * the gate arm it "covered" was unreachable. The hazard in a shape the type
 * DOES permit is an empty address list, which is what that test now builds.
 *
 * A fake that is wider than the thing it stands for makes a dead branch look
 * tested. This is the same defect as a select-blind Prisma fake, one layer up.
 */

/** Everything an `EgressDecision` needs, with the fields a test varies on top. */
function decision(
  host: string,
  over: Partial<EgressDecision> = {},
): EgressDecision {
  return {
    context: 'CRAWL',
    host,
    allowed: true,
    outcome: 'ALLOWED',
    refusal: null,
    decidedByClass: 'public',
    allowlistedBy: null,
    mode: 'ENFORCE',
    pinned: null,
    detail: `${host} resolved to a public address.`,
    warning: null,
    ...over,
  };
}

/** A `GuardedTarget`: scheme and port included, because the real type has them. */
function target(host: string, scheme: 'http:' | 'https:' = 'https:'): GuardedTarget {
  return { scheme, host, port: '', origin: `${scheme}//${host}` };
}

/** A permit for a public host, pinned. The ordinary case. */
function permit(
  host: string,
  addresses: readonly string[] = ['93.184.216.34'],
  addressClass: AddressClass = 'public',
): GuardAnswer {
  return {
    ok: true,
    permit: {
      kind: 'PINNED',
      context: 'CRAWL',
      target: target(host),
      pinned: {
        host,
        addresses: addresses.map((address) => ({ address, class: addressClass })),
        pinnedAt: '2026-10-29T12:00:00.000Z',
        fromLiteral: false,
      },
      wouldRefuse: null,
      decision: decision(host, { decidedByClass: addressClass }),
    },
  };
}

/**
 * A PINNED permit whose pin authorises NOTHING.
 *
 * The guard does not emit this; it is handled rather than asserted away because
 * an empty address list makes `chromiumHostResolverRules` map the host to
 * nothing and `pinnedLookup` answer with an empty array, and an empty success
 * is how a resolver falls back to the system one.
 */
function permitWithNoAddresses(host: string): GuardAnswer {
  return permit(host, []);
}

/** An OBSERVED permit: the brake let through what enforcement would refuse. */
function observed(host: string, refusal: GuardRefusal, addressClass: AddressClass): GuardAnswer {
  return {
    ok: true,
    permit: {
      kind: 'OBSERVED',
      context: 'CRAWL',
      target: target(host, 'http:'),
      pinned: null,
      wouldRefuse: refusal,
      decision: decision(host, {
        outcome: 'WOULD_REFUSE',
        refusal: 'CLASS_NOT_PERMITTED',
        decidedByClass: addressClass,
        mode: 'OBSERVE',
      }),
      observedBy: 'POLICY',
    },
  };
}

function refusal(
  host: string,
  refused: GuardRefusal,
  addressClass: AddressClass | null,
): GuardAnswer {
  return {
    ok: false,
    refusal: refused,
    operatorDetail: `Refusing ${host}: it resolves to a ${addressClass ?? 'unknown'} address.`,
    context: 'CRAWL',
    target: target(host, 'http:'),
    decision: decision(host, {
      allowed: false,
      outcome: 'REFUSED',
      refusal: 'CLASS_NOT_PERMITTED',
      decidedByClass: addressClass,
    }),
    paddedMs: 250,
  };
}

/** A guard scripted per URL, so one gate can see a mix of answers. */
function scripted(answers: Record<string, GuardAnswer>): { guard: CrawlEgressGuard; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    guard: async (url) => {
      asked.push(url);
      const answer = answers[url];
      if (answer === undefined) throw new Error(`the test script has no answer for ${url}`);
      return answer;
    },
  };
}

function clockFrom(start = 0): { clock: () => number; advance: (ms: number) => void } {
  let now = start;
  return { clock: () => now, advance: (ms) => void (now += ms) };
}

const gateWith = (
  guard: CrawlEgressGuard,
  clock: () => number = () => 0,
  pinTtlMs?: number,
): CrawlEgressGate =>
  new CrawlEgressGate({ guard, clock, ...(pinTtlMs === undefined ? {} : { pinTtlMs }) });

describe('every URL the crawl is about to visit goes through the guard', () => {
  it('asks the guard for the base URL and for every harvested URL', async () => {
    // `harvest.ts` widens the frontier from SITEMAPS, ROBOTS, MANIFESTS and
    // LINKS — documents the TARGET controls — so these are attacker-influenced
    // by definition and are exactly the ones a gate must not be skipped for.
    const harvested = [
      'https://app.example.com/',
      'https://app.example.com/from-sitemap',
      'https://app.example.com/from-robots',
      'https://app.example.com/from-manifest',
    ];
    const script = scripted(
      Object.fromEntries(harvested.map((url) => [url, permit('app.example.com')])),
    );
    const gate = gateWith(script.guard);
    for (const url of harvested) await gate.admit({ url });
    expect(script.asked).toEqual(harvested);
    expect(gate.summary().allowed).toBe(4);
  });

  it('hands the guard the WHOLE url, because the scheme and the port are its business', async () => {
    const url = 'http://app.example.com:8080/x?y=1';
    const script = scripted({ [url]: permit('app.example.com') });
    await gateWith(script.guard).admit({ url });
    expect(script.asked).toEqual([url]);
  });
});

describe('a refusal is counted and written down, never dropped', () => {
  it('writes a ledger entry for a refused URL and reports the count', async () => {
    const url = 'http://169.254.169.254/latest/meta-data/';
    const gate = gateWith(scripted({ [url]: refusal('169.254.169.254', 'NOT_ALLOWLISTED', 'link-local') }).guard);
    const verdict = await gate.admit({ url, route: '/latest/meta-data', discoveredFrom: 'https://app.example.com/' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.exclusion.rule).toBe(EGRESS_EXCLUSION_RULE);
      expect(verdict.exclusion.discoveredFrom).toBe('https://app.example.com/');
    }
    expect(gate.exclusions()).toHaveLength(1);
    expect(gate.summary().refused).toBe(1);
    expect(gate.summary().sentence).toContain('1 URL(s) refused by egress policy');
  });

  it('counts one refused URL once however many pages linked to it', async () => {
    // `frontier.ts` keys its ledger by URL for the same reason and says so: the
    // count a report prints is "31 URLs refused", not "1,400 links ignored".
    const url = 'http://10.0.0.5/admin';
    const gate = gateWith(scripted({ [url]: refusal('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    for (const from of ['/a', '/b', '/c']) await gate.admit({ url, discoveredFrom: from });
    expect(gate.exclusions()).toHaveLength(1);
    // The DECISIONS are all counted — three were made — and the ledger holds
    // one URL. Two numbers, both true, neither standing in for the other.
    expect(gate.summary().refused).toBe(3);
    expect(gate.summary().sentence).toContain('1 URL(s) refused');
  });

  it('counts allowed connections too, so the refusal count has a denominator', async () => {
    const gate = gateWith(
      scripted({
        'https://app.example.com/a': permit('app.example.com'),
        'https://app.example.com/b': permit('app.example.com'),
        'http://127.0.0.1:5432/': refusal('127.0.0.1', 'CLASS_NOT_PERMITTED', 'loopback'),
      }).guard,
    );
    await gate.admit({ url: 'https://app.example.com/a' });
    await gate.admit({ url: 'https://app.example.com/b' });
    await gate.admit({ url: 'http://127.0.0.1:5432/' });
    expect(gate.summary()).toMatchObject({ allowed: 2, refused: 1, wouldRefuse: 0, total: 3 });
  });

  it('refuses when the guard itself THROWS, rather than treating it as permission', async () => {
    // A crawl that read an exception as permission would be a control that is
    // off for exactly as long as something is broken, which is when it is most
    // needed. FAIL CLOSED.
    const gate = gateWith(async () => {
      throw new Error('resolver down for app.internal at 10.0.0.5');
    });
    const verdict = await gate.admit({ url: 'https://app.example.com/' });
    expect(verdict.ok).toBe(false);
    expect(gate.summary().refused).toBe(1);
    // And nothing from the exception's message reaches the tenant's ledger.
    expect(JSON.stringify(gate.exclusions())).not.toContain('10.0.0.5');
    expect(JSON.stringify(gate.exclusions())).not.toContain('resolver down');
  });

  it('refuses a PINNED permit whose pin authorises NO ADDRESSES', async () => {
    /*
     * THIS TEST USED TO ASSERT A STATE THE GUARD CANNOT REPRESENT, and the
     * compiler is what found it. It built a PINNED permit with `pinned: null`
     * and passed — but only because this file's guard type was a local
     * width-subset copy in which `pinned` was nullable on both arms. Against
     * the real `EgressPermit` the PINNED arm guarantees a `PinnedResolution`,
     * so the gate's `permit.pinned === null` check narrowed to `never`: the arm
     * was unreachable and this test was covering nothing.
     *
     * An EMPTY ADDRESS LIST is the same hazard in a shape the type permits, and
     * it is the one worth refusing: `chromiumHostResolverRules` would map the
     * host to nothing and `pinnedLookup` would answer with an empty array,
     * which is exactly when a resolver falls back to the system one — the
     * rebinding window the pin exists to close, reopened by an empty success.
     */
    const gate = gateWith(
      scripted({ 'https://app.example.com/': permitWithNoAddresses('app.example.com') }).guard,
    );
    const verdict = await gate.admit({ url: 'https://app.example.com/' });
    expect(verdict.ok).toBe(false);
    expect(gate.operatorRows()[0]?.refusal).toBe('RESOLUTION_NOT_PINNED');
    // And nothing reaches the browser: an empty pin must not become a rule.
    expect(gate.hostResolverRules()).toBe('');
  });
});

describe('the tenant learns nothing from a refusal', () => {
  it('gives a refused host and an unresolvable host BYTE-IDENTICAL tenant output', async () => {
    // THE TEST THE BRIEF ASKS FOR. For a CRAWL the tenant is the adversary —
    // they chose the base URL — and "that is a link-local address" versus "that
    // host did not resolve" are two different facts about the inside of OUR
    // network.
    const inside = gateWith(
      scripted({ 'http://a.internal/': refusal('a.internal', 'CLASS_NOT_PERMITTED', 'private') }).guard,
    );
    const nowhere = gateWith(
      scripted({ 'http://a.internal/': refusal('a.internal', 'NO_ADDRESSES', null) }).guard,
    );
    const left = await inside.admit({ url: 'http://a.internal/' });
    const right = await nowhere.admit({ url: 'http://a.internal/' });

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(JSON.stringify(inside.exclusions())).toBe(JSON.stringify(nowhere.exclusions()));
    expect(inside.progressNote()).toBe(nowhere.progressNote());
    expect(JSON.stringify(inside.summary())).toBe(JSON.stringify(nowhere.summary()));
  });

  it('keeps a closed port and a refused host indistinguishable in a progress note', async () => {
    // The crawl's progress events are already a port-reachability oracle. This
    // one takes NO ARGUMENT, so there is nothing to branch on — one fewer edit
    // away from being an oracle than a function that is handed a verdict.
    const gate = gateWith(scripted({}).guard);
    expect(gate.progressNote()).toBe(EGRESS_EXCLUSION_RULE);
  });

  it('puts no address, no class and no refusal code in anything tenant-visible', async () => {
    const url = 'http://metadata.internal/';
    const gate = gateWith(scripted({ [url]: refusal('metadata.internal', 'NOT_ALLOWLISTED', 'link-local') }).guard);
    const verdict = await gate.admit({ url });
    const tenantVisible = JSON.stringify([
      verdict,
      gate.exclusions(),
      gate.progressNote(),
      gate.summary(),
    ]);
    expect(tenantVisible).not.toContain('link-local');
    expect(tenantVisible).not.toContain('NOT_ALLOWLISTED');
    expect(tenantVisible).not.toContain('169.254');
    expect(tenantVisible).not.toContain('resolves to');
  });

  it('groups every refusal under ONE rule, which is what makes it one count', async () => {
    // `exclusionsByRule` in @qaai/shared groups BY THE RULE STRING. One
    // constant means one group and one number — and a rule that varied by
    // reason would both leak and fragment the count.
    const urls = {
      'http://127.0.0.1/': refusal('127.0.0.1', 'CLASS_NOT_PERMITTED', 'loopback'),
      'http://10.0.0.5/': refusal('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private'),
      'http://169.254.169.254/': refusal('169.254.169.254', 'NOT_ALLOWLISTED', 'link-local'),
      'http://nowhere.test/': refusal('nowhere.test', 'NO_ADDRESSES', null),
    };
    const gate = gateWith(scripted(urls).guard);
    for (const url of Object.keys(urls)) await gate.admit({ url });

    const grouped = exclusionsByRule(
      gate.asExcludedPaths('POLICY_EXCLUDE').map((entry) => ({ ...entry })),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.count).toBe(4);
    expect(grouped[0]?.rule).toBe(EGRESS_EXCLUSION_RULE);
  });

  it('caps a discovered URL rather than trusting its length', async () => {
    const url = `http://10.0.0.5/${'a'.repeat(5_000)}`;
    const gate = gateWith(scripted({ [url]: refusal('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    await gate.admit({ url });
    expect(gate.exclusions()[0]?.url.length).toBe(2_000);
  });
});

describe('the operator sees what the tenant may not', () => {
  it('records the class, the refusal and the host for the install to read', async () => {
    const url = 'http://metadata.internal/';
    const gate = gateWith(scripted({ [url]: refusal('metadata.internal', 'NOT_ALLOWLISTED', 'link-local') }).guard);
    await gate.admit({ url });
    expect(gate.operatorRows()).toEqual([
      {
        outcome: 'REFUSED',
        addressClass: 'link-local',
        refusal: 'NOT_ALLOWLISTED',
        count: 1,
        hosts: ['metadata.internal'],
      },
    ]);
  });

  it('samples hosts to a cap and keeps the COUNT unbounded', async () => {
    // A truncated sample beside an exact count. Conflating the two is how a
    // partial list gets read as a complete one.
    const answers: Record<string, GuardAnswer> = {};
    for (let index = 0; index < HOST_SAMPLE_CAP + 7; index += 1) {
      const host = `h${index}.internal`;
      answers[`http://${host}/`] = refusal(host, 'CLASS_NOT_PERMITTED', 'private');
    }
    const gate = gateWith(scripted(answers).guard);
    for (const url of Object.keys(answers)) await gate.admit({ url });
    const row = gate.operatorRows()[0];
    expect(row?.count).toBe(HOST_SAMPLE_CAP + 7);
    expect(row?.hosts).toHaveLength(HOST_SAMPLE_CAP);
  });

  it('buckets on (outcome, class, refusal) and sorts the biggest first', async () => {
    const answers: Record<string, GuardAnswer> = {
      'http://a.internal/': refusal('a.internal', 'CLASS_NOT_PERMITTED', 'private'),
      'http://b.internal/': refusal('b.internal', 'CLASS_NOT_PERMITTED', 'private'),
      'http://169.254.169.254/': refusal('169.254.169.254', 'NOT_ALLOWLISTED', 'link-local'),
    };
    const gate = gateWith(scripted(answers).guard);
    for (const url of Object.keys(answers)) await gate.admit({ url });
    expect(gate.operatorRows().map((row) => [row.addressClass, row.count])).toEqual([
      ['private', 2],
      ['link-local', 1],
    ]);
  });
});

describe('the brake is visible, and it counts what it let through', () => {
  it('lets an OBSERVED permit through, pins NOTHING, and counts it as would-refuse', async () => {
    const url = 'http://10.0.0.5/';
    const gate = gateWith(scripted({ [url]: observed('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    const verdict = await gate.admit({ url });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.observed).toBe(true);
      // A caller in observe mode connects the way it did before this control
      // existed. Handing back a pin would claim a closed rebinding window for a
      // connection nobody authorised.
      expect(verdict.pinned).toBeNull();
    }
    expect(gate.summary()).toMatchObject({ wouldRefuse: 1, refused: 0, allowed: 0 });
    // And it contributes no browser rule, because it authorised no address.
    expect(gate.hostResolverRules()).toBe('');
  });

  it('says in the report how many MORE would have been refused', async () => {
    // A mode that does not count is an off switch with a reassuring name. The
    // sentence is what makes "we would have refused 1,204 connections"
    // answerable before anyone enforces.
    const answers: Record<string, GuardAnswer> = {
      'http://10.0.0.5/a': observed('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private'),
      'http://10.0.0.5/b': observed('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private'),
      'http://127.0.0.1/': refusal('127.0.0.1', 'CLASS_NOT_PERMITTED', 'loopback'),
    };
    const gate = gateWith(scripted(answers).guard);
    for (const url of Object.keys(answers)) await gate.admit({ url });
    expect(gate.summary().sentence).toBe(
      '1 URL(s) refused by egress policy; 2 more would have been refused if this environment’s ' +
        'egress policy were enforcing',
    );
  });

  it('says nothing about observing when nothing was observed', async () => {
    const url = 'http://10.0.0.5/';
    const gate = gateWith(scripted({ [url]: refusal('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    await gate.admit({ url });
    expect(gate.summary().sentence).toBe('1 URL(s) refused by egress policy');
  });

  it('never reports an observed refusal as allowed', async () => {
    // An observed refusal recorded as ALLOWED is a cap applied without being
    // counted, which is one of the lies this product cannot afford.
    const url = 'http://10.0.0.5/';
    const gate = gateWith(scripted({ [url]: observed('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    await gate.admit({ url });
    expect(gate.summary().allowed).toBe(0);
    expect(gate.operatorRows()[0]?.outcome).toBe('WOULD_REFUSE');
  });
});

describe('the pin is per host, because the browser is pinned at launch', () => {
  it('builds the --host-resolver-rules switch from the pins it took', async () => {
    const gate = gateWith(
      scripted({
        'https://app.example.com/': permit('app.example.com', ['93.184.216.34']),
        'https://api.example.com/': permit('api.example.com', ['93.184.216.35', '93.184.216.36']),
      }).guard,
    );
    await gate.admit({ url: 'https://app.example.com/' });
    await gate.admit({ url: 'https://api.example.com/' });
    expect(gate.hostResolverRules()).toBe(
      'MAP app.example.com 93.184.216.34,' +
        'MAP api.example.com 93.184.216.35,' +
        'MAP api.example.com 93.184.216.36',
    );
  });

  it('does not repeat a rule for a host visited many times', async () => {
    const script = scripted({
      'https://app.example.com/a': permit('app.example.com'),
      'https://app.example.com/b': permit('app.example.com'),
      'https://app.example.com/c': permit('app.example.com'),
    });
    const gate = gateWith(script.guard);
    for (const suffix of ['a', 'b', 'c']) {
      await gate.admit({ url: `https://app.example.com/${suffix}` });
    }
    expect(gate.hostResolverRules()).toBe('MAP app.example.com 93.184.216.34');
    // Every URL was still ASKED ABOUT. A launch argument is not a gate.
    expect(script.asked).toHaveLength(3);
  });

  it('reports a pin AGE rather than letting a stale pin look fresh', async () => {
    const { clock, advance } = clockFrom(1_000);
    const gate = gateWith(scripted({ 'https://app.example.com/': permit('app.example.com') }).guard, clock);
    await gate.admit({ url: 'https://app.example.com/' });
    advance(14 * 60 * 1_000);
    expect(gate.pins()).toEqual([
      { host: 'app.example.com', addresses: ['93.184.216.34'], ageMs: 14 * 60 * 1_000 },
    ]);
  });

  it('drops a pin past its TTL, so an expired map entry cannot reach the browser', async () => {
    const { clock, advance } = clockFrom();
    const gate = gateWith(scripted({ 'https://app.example.com/': permit('app.example.com') }).guard, clock);
    await gate.admit({ url: 'https://app.example.com/' });
    expect(gate.hostResolverRules()).not.toBe('');
    advance(DEFAULT_PIN_TTL_MS + 1);
    expect(gate.pins()).toEqual([]);
    expect(gate.hostResolverRules()).toBe('');
  });

  it('does not slide the TTL forward on every visit', async () => {
    // Refreshing on each admit would make the TTL never expire: the pin would
    // be as old as the crawl and `pins()` would report it as new.
    const { clock, advance } = clockFrom();
    const script = scripted({
      'https://app.example.com/a': permit('app.example.com'),
      'https://app.example.com/b': permit('app.example.com'),
    });
    const gate = gateWith(script.guard, clock, 10_000);
    await gate.admit({ url: 'https://app.example.com/a' });
    advance(9_000);
    await gate.admit({ url: 'https://app.example.com/b' });
    expect(gate.pins()[0]?.ageMs).toBe(9_000);
    advance(2_000);
    expect(gate.pins()).toEqual([]);
  });

  it('re-pins a host whose pin had expired, with the NEW addresses', async () => {
    const { clock, advance } = clockFrom();
    const gate = gateWith(
      scripted({
        'https://app.example.com/a': permit('app.example.com', ['93.184.216.34']),
        'https://app.example.com/b': permit('app.example.com', ['93.184.216.99']),
      }).guard,
      clock,
      10_000,
    );
    await gate.admit({ url: 'https://app.example.com/a' });
    advance(10_001);
    await gate.admit({ url: 'https://app.example.com/b' });
    expect(gate.hostResolverRules()).toBe('MAP app.example.com 93.184.216.99');
  });

  it('hands back the pinned addresses, not the name', async () => {
    const gate = gateWith(
      scripted({ 'https://app.example.com/': permit('app.example.com', ['93.184.216.34', '93.184.216.35']) }).guard,
    );
    const verdict = await gate.admit({ url: 'https://app.example.com/' });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.pinned).toEqual(['93.184.216.34', '93.184.216.35']);
  });
});

describe('the exclusion kind this ledger wants, and the one it has', () => {
  it('names a kind the shared vocabulary does not supply, so the caller must choose', async () => {
    // None of the seven existing kinds is true of an egress refusal, and a
    // label that lies about which rule fired is worse than no label — so
    // `asExcludedPaths` has NO DEFAULT. The handover carries the exact edit
    // that adds `EGRESS_REFUSED`, and once it lands this is the integration.
    //
    // Deliberately NOT asserting that EXCLUSION_KINDS lacks the member: a test
    // that asserts the absence of a thing breaks the round that adds it.
    expect(WANTED_EXCLUSION_KIND).toBe('EGRESS_REFUSED');
    expect(typeof WANTED_EXCLUSION_KIND).toBe('string');
  });

  it('carries whatever kind it is given, onto every row', async () => {
    const url = 'http://10.0.0.5/';
    const gate = gateWith(scripted({ [url]: refusal('10.0.0.5', 'CLASS_NOT_PERMITTED', 'private') }).guard);
    await gate.admit({ url });
    const rows = gate.asExcludedPaths('POLICY_EXCLUDE');
    expect(rows).toEqual([
      {
        url: 'http://10.0.0.5/',
        route: null,
        kind: 'POLICY_EXCLUDE',
        rule: EGRESS_EXCLUSION_RULE,
        discoveredFrom: null,
      },
    ]);
  });

  it('refuses a kind the panel could not render, even off the wire', async () => {
    // A row whose kind the panel cannot render is a refusal that disappears
    // from the report, which is the silent drop this whole file exists to stop.
    const gate = gateWith(scripted({}).guard);
    expect(() => gate.asExcludedPaths('NOT_A_KIND' as never)).toThrow(/exclusion kinds/);
    for (const kind of EXCLUSION_KINDS) {
      expect(() => gate.asExcludedPaths(kind), kind).not.toThrow();
    }
  });
});
