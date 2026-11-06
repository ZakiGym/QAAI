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
 *
 * ── WHAT THIS FILE PROVES ABOUT THE PIN, AND WHAT IT DOES NOT ───────────────
 *
 * The guard hands back a PINNED ADDRESS SET and this call site used to throw it
 * away and call global `fetch(url)` by name — a second resolution of the same
 * name, which an attacker who owns the nameserver answers differently. What is
 * proved HERE is that the permit reaches the transport, that the transport is
 * the pinned one by default, and that an observe-mode permit is handled
 * deliberately and counted. That the PIN IS HONOURED AT THE SOCKET is proved
 * against real loopback sockets with the name rebound, in
 * `contract-events.test.ts` and `packages/shared/src/pinned-request.test.ts` —
 * a pin tested only against a fake transport is a pin nobody has evidence for.
 *
 * TWO RECORDERS, ON PURPOSE. `byName` is global `fetch`, the transport that
 * resolves for itself; `pinned` is the injected one. Every assertion below says
 * which door a request went through, because "one request was made" was exactly
 * the sentence that hid this defect for four rounds.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPermit, EgressPolicy } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  brokerHostFromSecretName,
  defaultBrokerEgressGuard,
  publishVerification,
} from './contract-broker.js';
import type { BrokerEgressGuard, BrokerTransport } from './contract-broker.js';

const TOKEN = 'pactflow-secret-token-DO-NOT-LEAK-42';
const BOUND = 'PACT_BROKER_TOKEN__broker_acme_com';

/**
 * EVERY REQUEST THAT WENT OUT BY NAME, through global `fetch`.
 *
 * This is the transport that resolves the host for itself, which is the defect.
 * It stays stubbed rather than removed so it is a TRAP: a pinned path that
 * quietly fell back to it shows up here as a recorded request instead of as a
 * passing test. The ONE path that is supposed to use it is observe mode.
 */
let byName: Array<{ url: string; auth: string | null }>;
/** Every request handed to the injected pinned transport, with its permit. */
let pinned: Array<{ permit: EgressPermit; url: string; auth: string | undefined }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  byName = [];
  pinned = [];
  globalThis.fetch = vi.fn(async (input: unknown, init: { headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers ?? {});
    byName.push({
      url: typeof input === 'string' ? input : String((input as { url?: string }).url),
      auth: headers.get('authorization'),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A transport that records what it was asked to send and answers `status`.
 *
 * It opens NO SOCKET, which is the point: these tests are about the product
 * rules (published, skipped, which sentence, no token anywhere) and about the
 * permit arriving intact. A permit the real guard issues pins a PUBLIC address,
 * so a test that used the real transport would open a connection to a real
 * host on the internet — see the measured note in the header.
 */
function fakeTransport(status = 200, text = '{}'): BrokerTransport {
  return async (permit, url, headers, body) => {
    pinned.push({ permit, url, auth: headers['authorization'] });
    // The body is recorded only as a length: it is the verification payload and
    // has no business being echoed into a test failure message.
    expect(body.length).toBeGreaterThan(0);
    return { ok: true, status, headers: {}, text, truncated: false, durationMs: 1 };
  };
}

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

/**
 * Did the token leave through EITHER door?
 *
 * Both, deliberately. A check that only read `byName` would have gone green the
 * moment this module moved to the pinned transport, which is the shape of the
 * false negative this whole round is about.
 */
const tokenLeaked = (): boolean =>
  byName.some((r) => (r.auth ?? '').includes(TOKEN)) ||
  pinned.some((r) => (r.auth ?? '').includes(TOKEN));

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
      fakeTransport(),
    );
    expect(out.status).toBe('PUBLISHED');
    // Through the PINNED door, and the name-resolving one was never touched.
    expect(pinned).toHaveLength(1);
    expect(byName).toEqual([]);
    expect(pinned[0]!.url).toContain('broker.acme.com');
    expect(out.pin).toBe('ENFORCED');
  });

  it('hands the transport the GUARD\u2019S OWN permit, addresses and all', async () => {
    /*
     * THE WHOLE DEFECT IN ONE ASSERTION. The guard resolved and classified
     * `93.184.216.34`; the call site used to read `verdict.ok` and discard the
     * rest, so nothing downstream knew which address had been approved. If the
     * permit stops travelling, this is what goes red.
     */
    await publishVerification(
      ctx(),
      config('https://broker.acme.com/pact'),
      input(),
      guardWith(PUBLIC_BROKER),
      fakeTransport(),
    );

    const permit = pinned[0]!.permit;
    expect(permit.kind).toBe('PINNED');
    if (permit.kind !== 'PINNED') return;
    expect(permit.pinned.host).toBe('broker.acme.com');
    expect(permit.pinned.addresses.map((pin) => pin.address)).toEqual(['93.184.216.34']);
    // And the credential really is the one in flight, so "the permit arrived"
    // is a fact about the request that carries the token and not about some
    // other call.
    expect(pinned[0]!.auth).toBe(`Bearer ${TOKEN}`);
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
    const out = await publishVerification(
      ctx(),
      config(url),
      input(),
      guardWith(PUBLIC_BROKER),
      fakeTransport(),
    );
    expect(out.status).not.toBe('PUBLISHED');
    expect(tokenLeaked()).toBe(false);
    // Neither door opened at all: refused means the request never happened.
    expect(byName).toEqual([]);
    expect(pinned).toEqual([]);
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
      fakeTransport(),
    );

    expect(out.status).toBe('SKIPPED');
    // Nothing was sent at all, through either door. "Refused" has to mean the
    // request never happened, not that it happened and failed.
    expect(byName).toEqual([]);
    expect(pinned).toEqual([]);
    expect(tokenLeaked()).toBe(false);
    // No connection was attempted, so there is no pin fact to report. Absent
    // rather than a cheerful 'ENFORCED' for a request that never happened.
    expect(out.pin).toBeUndefined();
  });

  it('refuses a bound broker host that does not resolve', async () => {
    const host = 'broker.attacker.test';
    const out = await publishVerification(
      ctxFor(host),
      boundTo(host),
      input(),
      guardWith({}),
      fakeTransport(),
    );
    expect(out.status).toBe('SKIPPED');
    expect(byName).toEqual([]);
    expect(pinned).toEqual([]);
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
      const out = await publishVerification(
        ctxFor(host),
        boundTo(host),
        input(),
        guardWith(zone),
        fakeTransport(),
      );
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
      fakeTransport(),
    );
    expect(out.status).toBe('PUBLISHED');
    expect(pinned).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The permit is carried to the socket instead of being discarded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THESE RUN WITH NO TRANSPORT INJECTED, so the code under test is the one
 * production gets: `sendPinned` -> `pinnedRequest` -> a real `http.Agent` with
 * the permit's own `lookup`. They open REAL SOCKETS to 127.0.0.1, which is not
 * "network": nothing leaves the machine and no name is resolved by the system
 * resolver, which is the whole claim.
 *
 * ── WHY THE DISCRIMINATOR RUNS THIS WAY ROUND HERE ──────────────────────────
 *
 * The rebind test — pin a public address, point the URL at `localhost`, prove
 * the loopback server gets ZERO hits — CANNOT be written at this layer, and that
 * is a measured fact about `brokerOrigin` rather than a shortcut: it refuses
 * `http`, refuses a single-label host and refuses every private-network name, so
 * `localhost` never survives to become a broker URL (the suite above asserts
 * that). `localhost` is the only name that resolves to 127.0.0.1 without the
 * system resolver, so the rebind evidence lives one layer down, against
 * `sendPinned` itself, in `contract-events.test.ts`.
 *
 * What IS provable here is the other direction, and it is just as load-bearing:
 * the socket goes TO THE PINNED ADDRESS even though the NAME resolves nowhere at
 * all. A transport that ignored the pin would resolve `broker.acme.test`, get
 * nothing, and reach no server — so "exactly one connection arrived on
 * 127.0.0.1" is a fact only a honoured pin can produce.
 */
describe('the publish goes to the pinned address, through the pinned transport', () => {
  let server: Server;
  let port: number;
  /** TCP accepts, which is the layer a pin decides. */
  let connections: number;
  /** Completed HTTP requests. A TLS client against a plain server makes none. */
  let requests: Array<{ path: string; auth: string | undefined }>;

  beforeEach(async () => {
    connections = 0;
    requests = [];
    server = createServer((req, res) => {
      requests.push({ path: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    server.on('connection', () => {
      connections += 1;
    });
    // A TLS ClientHello arriving at a plain HTTP server is a parse error, not a
    // crash. Swallowed so the socket closes quietly instead of becoming an
    // unhandled error that fails an unrelated test.
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  /**
   * A PINNED permit built by hand, because what is under test is the
   * TRANSPORT's obedience and not the policy that issues one — and because the
   * real guard will never pin 127.0.0.1 for TRACKER_CALL in any deployment,
   * which the suite above asserts twice. Same construction as
   * `pinned-request.test.ts`.
   */
  const permitFor = (host: string, addresses: readonly string[]): EgressPermit =>
    ({
      kind: 'PINNED',
      context: 'TRACKER_CALL',
      target: { host, scheme: 'https:', port: String(port), origin: `https://${host}:${port}` },
      decision: { allowed: true },
      pinned: {
        host,
        addresses: addresses.map((address) => ({
          address,
          class: address.startsWith('127.') ? 'loopback' : 'public',
        })),
      },
      wouldRefuse: null,
    }) as unknown as EgressPermit;

  const guardReturning = (permit: EgressPermit): BrokerEgressGuard => async () => ({
    ok: true,
    permit,
  });

  const brokerAt = (host: string) =>
    ({
      brokerUrl: `https://${host}:${port}/pact`,
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

  it('opens the socket to the PINNED address, for a name that resolves nowhere', async () => {
    const host = 'broker.acme.test';
    const out = await publishVerification(
      ctxFor(host),
      brokerAt(host),
      input(),
      guardReturning(permitFor(host, ['127.0.0.1'])),
    );

    /*
     * ONE CONNECTION ARRIVED ON 127.0.0.1. `broker.acme.test` has no records
     * anywhere — a transport that resolved the name instead of honouring the
     * pin would have reached nothing, and this count would be 0. That is the
     * assertion: the pin decided the address.
     */
    expect(connections).toBe(1);
    // And it is the pinned transport, not global `fetch`.
    expect(byName).toEqual([]);
    /*
     * NO HTTP REQUEST COMPLETED and therefore NO TOKEN ARRIVED: the URL is
     * https (brokerOrigin refuses anything else) and the server speaks plain
     * HTTP, so the TLS handshake fails before a byte of the request is written.
     * That is the honest limit of this test and the reason the 200 path above
     * uses a fake transport rather than a self-signed certificate.
     */
    expect(requests).toEqual([]);
    expect(tokenLeaked()).toBe(false);
    expect(out.status).toBe('SKIPPED');
    expect(out.pin).toBe('ENFORCED');
    // The product rule survives a transport failure, as it always did.
    expect(out.detail).toContain('unaffected');
  });

  it('refuses a PINNED permit that authorised no address, without opening a socket', async () => {
    /*
     * A pin that authorises nothing is as dangerous as no pin and reads like a
     * success. `pinnedLookup` does fail closed on it — an Error, never an empty
     * answer that Node would satisfy from the system resolver — and `sendPinned`
     * refuses it before that, which is why this asserts ZERO connections rather
     * than a failed one.
     */
    const host = 'broker.acme.test';
    const out = await publishVerification(
      ctxFor(host),
      brokerAt(host),
      input(),
      guardReturning(permitFor(host, [])),
    );

    expect(connections).toBe(0);
    expect(byName).toEqual([]);
    expect(tokenLeaked()).toBe(false);
    expect(out.status).toBe('SKIPPED');
    // Refused by us, so it says the guard's ONE CONSTANT — not a fourth
    // sentence, and nothing about an address or a class.
    expect(out.detail).toContain(EGRESS_REFUSAL_SENTENCE);
    expect(out.detail).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it('does not open a credentialed request on a run that is already cancelled', async () => {
    const host = 'broker.acme.test';
    const cancelled = new AbortController();
    cancelled.abort();
    const out = await publishVerification(
      {
        ...(ctxFor(host) as object),
        signal: cancelled.signal,
      } as never,
      brokerAt(host),
      input(),
      guardReturning(permitFor(host, ['127.0.0.1'])),
    );

    expect(connections).toBe(0);
    expect(byName).toEqual([]);
    expect(tokenLeaked()).toBe(false);
    expect(out.status).toBe('SKIPPED');
    // A sentence that is TRUE. "Unreachable" would have been a guess about a
    // host nobody asked, and this one says nothing about the network at all.
    expect(out.detail).toContain('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observe mode: the brake, and the fact that it is counted
// ─────────────────────────────────────────────────────────────────────────────

describe('an OBSERVE-mode permit connects by name, and says so', () => {
  /**
   * OBSERVE is the rollout brake: the policy WOULD have refused, the mode says
   * count it instead, and the connection then happens exactly as it did before
   * any of this existed — BY NAME, with the token, rebinding window open.
   * `login.ts` makes the identical choice for the identical reason.
   *
   * SO THIS TEST ASSERTS A TOKEN GOING OUT TO A HOST THE POLICY DISLIKES, on
   * purpose. That is what the operator armed. What must never be true is that it
   * happens SILENTLY: `pin` is the counted fact, and a permit that authorised no
   * address may not be read as a pin.
   */
  const OBSERVING = resolveEgressPolicy({ mode: 'OBSERVE' });

  it('publishes by name and records OBSERVE_BY_NAME', async () => {
    const host = 'broker.acme.com';
    const out = await publishVerification(
      ctx(),
      config(`https://${host}/pact`),
      input(),
      // 10.0.0.5 is refused for TRACKER_CALL in every deployment, so ENFORCE
      // would refuse this outright; the mode is what turns it into a permit.
      guardWith({ [host]: ['10.0.0.5'] }, OBSERVING),
      fakeTransport(),
    );

    expect(out.status).toBe('PUBLISHED');
    expect(out.pin).toBe('OBSERVE_BY_NAME');
    // By NAME, through global fetch — and NOT through the pinned transport,
    // which would have had to invent a pin nobody issued.
    expect(byName).toHaveLength(1);
    expect(pinned).toEqual([]);
    // Today's behaviour, unchanged, which is the entire point of the brake.
    expect(byName[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('is ENFORCED, not observed, when no mode was configured', async () => {
    // The default is ENFORCE — an absent policy must never be an open one — so
    // the arm above is only reachable where somebody set the mode on purpose.
    const out = await publishVerification(
      ctx(),
      config('https://broker.acme.com/pact'),
      input(),
      guardWith(PUBLIC_BROKER),
      fakeTransport(),
    );
    expect(out.pin).toBe('ENFORCED');
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
