/**
 * The broker publisher sends a vault-held token to a URL an org admin typed in.
 *
 * That is the precise shape of two security bugs this repo has already shipped:
 * a PAT that reached an attacker host read out of config, and a trailing-dot
 * FQDN that defeated every hostname guard at once. This suite exists so it is
 * not three.
 *
 * The lookalike case is the one that needed a new idea. Every other guard
 * refuses a host we can NAME as bad; none of them can refuse
 * `github.com.evil.com`, because a Pact broker is legitimately self-hosted and
 * that string is indistinguishable from `broker.mycompany.com`. So the token is
 * bound to a host by its own secret name, and repointing the URL fails closed.
 *
 * The CONTROL matters as much as the attacks: a publisher that refuses
 * everything passes an attack suite and does not work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPolicy } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  brokerHostFromSecretName,
  defaultBrokerEgressGuard,
  publishVerification,
} from './contract-broker.js';
import type { BrokerEgressGuard } from './contract-broker.js';

const TOKEN = 'pactflow-secret-token-DO-NOT-LEAK-42';
const BOUND = 'PACT_BROKER_TOKEN__broker_acme_com';

let sent: Array<{ url: string; auth: string | null }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  globalThis.fetch = vi.fn(async (input: unknown, init: { headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers ?? {});
    sent.push({
      url: typeof input === 'string' ? input : String((input as { url?: string }).url),
      auth: headers.get('authorization'),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = () =>
  ({
    secrets: { [BOUND]: TOKEN },
    logger: { step: () => {} },
    baseUrl: 'http://x',
    fixtures: {},
    signal: new AbortController().signal,
  }) as never;

const config = (brokerUrl: string) =>
  ({
    brokerUrl,
    pactVersion: 'deadbeefcafe',
    auth: { secretName: BOUND, scheme: 'bearer' },
  }) as never;

const input = () =>
  ({
    consumerName: 'fulfilment-dashboard',
    providerName: 'demo-store',
    success: true,
    results: [],
  }) as never;

const tokenLeaked = (): boolean => sent.some((r) => (r.auth ?? '').includes(TOKEN));

/**
 * A resolver that answers from a table and THROWS on anything else.
 *
 * NOTHING IN THIS FILE OPENS A SOCKET OR CONSULTS A REAL RESOLVER — the
 * decision logic is the shipped `guardUrl`, and only DNS, the clock and the
 * sleep are injected. Throwing on an undeclared host rather than answering
 * empty is the point: a fake that quietly resolves an unlisted name is a fake
 * that makes a deleted call site undetectable.
 */
function fakeIo(zone: Readonly<Record<string, readonly string[]>>): EgressGuardIo {
  return {
    classifyHost: (host) => classifyHost(host),
    classifyAddress: (address) => classifyAddress(address),
    lookup: async (host) => {
      const answers = zone[host];
      if (answers === undefined) {
        throw new Error(`fakeIo was asked to resolve ${host}, which this test never declared`);
      }
      return answers.map((address) => ({ address }));
    },
    now: () => new Date('2026-10-30T00:00:00.000Z'),
    monotonicMs: () => 0,
    // The 250ms refusal floor is `egress-guard`'s own test's business; a real
    // sleep per refusal would cost this file several seconds.
    delay: async () => {},
  };
}

/** The real guard over a fake zone. */
function guardWith(
  zone: Readonly<Record<string, readonly string[]>>,
  policy: EgressPolicy = resolveEgressPolicy(undefined),
): BrokerEgressGuard {
  const io = fakeIo(zone);
  return (url) => guardUrl({ url, context: 'TRACKER_CALL', policy, io });
}

/** The one zone in which `broker.acme.com` is a real, public broker. */
const PUBLIC_BROKER = { 'broker.acme.com': ['93.184.216.34'] } as const;

describe('a secret names the host it belongs to', () => {
  it('reads the host out of the secret name', () => {
    expect(brokerHostFromSecretName(BOUND)).toBe('broker.acme.com');
  });

  it('treats an unnamed secret as unbound, so existing setups keep working', () => {
    expect(brokerHostFromSecretName('PACT_BROKER_TOKEN')).toBeNull();
  });
});

describe('the token reaches a legitimate broker', () => {
  it('publishes when the bound host matches the URL', async () => {
    const out = await publishVerification(
      ctx(),
      config('https://broker.acme.com/pact'),
      input(),
      guardWith(PUBLIC_BROKER),
    );
    expect(out.status).toBe('PUBLISHED');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('broker.acme.com');
  });
});

describe('and never reaches anywhere else', () => {
  it.each([
    ['a lookalike host', 'https://github.com.evil.com/pact'],
    ['an unrelated attacker host', 'https://evil.example.net/'],
    ['a trailing-dot FQDN', 'https://localhost.:9292/'],
    ['credentials embedded in the URL', 'https://qa:hunter2@broker.acme.com/'],
    ['an internal cluster name', 'https://kubernetes.default.svc/'],
    ['a cloud metadata address', 'https://169.254.169.254/'],
    ['plain http', 'http://broker.acme.com/'],
  ])('refuses %s without sending the token', async (_label, url) => {
    /*
     * The guard is injected over a zone in which `broker.acme.com` is the ONLY
     * resolvable name, so the two lookalike hosts below that get past
     * `brokerOrigin` are refused by the resolver rather than by the network.
     */
    const out = await publishVerification(ctx(), config(url), input(), guardWith(PUBLIC_BROKER));
    expect(out.status).not.toBe('PUBLISHED');
    expect(tokenLeaked()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// And never reaches a host whose RECORDS point inside
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE HALF `brokerHostFromSecretName` DID NOT CLOSE.
 *
 * Binding the token to a host answers the LOOKALIKE attack:
 * `github.com.evil.com` is refused because no secret is bound to it. It says
 * nothing about a host the secret IS bound to whose A record points at
 * 169.254.169.254 — and a secret name is something the same org admin writes,
 * so binding is not a second party's consent.
 *
 * MEASURED before this change: `brokerOrigin('https://broker.attacker.test/')`
 * returned that origin unchanged, and the broker token went wherever the name
 * resolved. These prove it does not any more, in BOTH RECORD ORDERS — because
 * a positional read of the first address lets whoever runs the zone choose the
 * outcome by reordering their own answer.
 */
describe('the broker host is resolved before the token is sent', () => {
  /** A secret bound to the attacker's own host, so the binding check passes. */
  const boundTo = (host: string) =>
    ({
      brokerUrl: `https://${host}/pact`,
      pactVersion: 'deadbeefcafe',
      auth: { secretName: `PACT_BROKER_TOKEN__${host.replace(/\./g, '_')}`, scheme: 'bearer' },
    }) as never;

  const ctxFor = (host: string) =>
    ({
      secrets: { [`PACT_BROKER_TOKEN__${host.replace(/\./g, '_')}`]: TOKEN },
      logger: { step: () => {} },
      baseUrl: 'http://x',
      fixtures: {},
      signal: new AbortController().signal,
    }) as never;

  it.each([
    ['the cloud metadata address', ['169.254.169.254']],
    ['an RFC1918 address', ['10.0.0.5']],
    ['loopback', ['127.0.0.1']],
    ['a split answer, public record FIRST', ['93.184.216.34', '10.0.0.5']],
    ['a split answer, private record FIRST', ['10.0.0.5', '93.184.216.34']],
    ['no addresses at all', []],
  ])('refuses a bound broker host that resolves to %s', async (_label, addresses) => {
    const host = 'broker.attacker.test';
    const out = await publishVerification(
      ctxFor(host),
      boundTo(host),
      input(),
      guardWith({ [host]: addresses }),
    );

    expect(out.status).toBe('SKIPPED');
    // Nothing was sent at all. "Refused" has to mean the request never
    // happened, not that it happened and failed.
    expect(sent).toEqual([]);
    expect(tokenLeaked()).toBe(false);
  });

  it('refuses a bound broker host that does not resolve', async () => {
    const host = 'broker.attacker.test';
    const out = await publishVerification(ctxFor(host), boundTo(host), input(), guardWith({}));
    expect(out.status).toBe('SKIPPED');
    expect(sent).toEqual([]);
  });

  it('says the SAME sentence whatever the reason, so the step list is not a port scanner', async () => {
    const host = 'broker.attacker.test';
    const zones: Array<Record<string, readonly string[]>> = [
      { [host]: ['169.254.169.254'] },
      { [host]: ['10.0.0.5'] },
      { [host]: ['127.0.0.1'] },
      { [host]: [] },
      {},
    ];
    const details = new Set<string>();
    for (const zone of zones) {
      const out = await publishVerification(ctxFor(host), boundTo(host), input(), guardWith(zone));
      details.add(out.detail);
    }
    expect(details.size).toBe(1);
    expect([...details][0]).toContain(EGRESS_REFUSAL_SENTENCE);
    // And the operator's class/address detail never travels into the run's own
    // report, where the person who typed the URL would read it.
    expect([...details][0]).not.toMatch(/10\.0\.0\.5|169\.254|loopback|private|link-local/);
  });

  it('publishes to a bound broker host that resolves publicly — the product keeps working', async () => {
    // A guard that refuses everything passes an attack suite and does not work.
    const out = await publishVerification(
      ctx(),
      config('https://broker.acme.com/pact'),
      input(),
      guardWith(PUBLIC_BROKER),
    );
    expect(out.status).toBe('PUBLISHED');
    expect(sent).toHaveLength(1);
  });
});

describe('defaultBrokerEgressGuard — the guard production actually gets', () => {
  /*
   * IP LITERALS ONLY, deliberately: `classifyHost` answers `kind: 'address'`
   * for a literal and `decideEgress` consults no resolver at all, so these
   * exercise the REAL default guard — real policy, real classifier — with NO
   * DNS QUERY and no socket.
   */
  it('refuses private and link-local with no policy configured', async () => {
    const guard = await defaultBrokerEgressGuard();
    expect((await guard('https://169.254.169.254/p')).ok).toBe(false);
    expect((await guard('https://10.0.0.5/p')).ok).toBe(false);
    expect((await guard('https://127.0.0.1/p')).ok).toBe(false);
  });

  it('refuses a private address even on a SELF_HOSTED policy with an allowlist entry', async () => {
    /*
     * TRACKER_CALL may never reach a private address — not in any deployment
     * and not through the allowlist. A self-hosted install's INTERNAL broker is
     * already refused by `brokerOrigin` today, so this is the shipped behaviour
     * and not a new restriction.
     */
    const guard = await defaultBrokerEgressGuard({
      deployment: 'SELF_HOSTED',
      permittedClasses: ['public', 'private', 'loopback', 'reserved'],
      allowlist: [
        {
          host: '10.0.0.5',
          contexts: ['TRACKER_CALL'],
          ownerEmail: 'someone@acme.test',
          reason: 'our internal pact broker',
          expiresAt: null,
        },
      ],
    });
    expect((await guard('https://10.0.0.5/p')).ok).toBe(false);
  });

  it('permits a public address', async () => {
    const guard = await defaultBrokerEgressGuard();
    expect((await guard('https://93.184.216.34/p')).ok).toBe(true);
  });
});
