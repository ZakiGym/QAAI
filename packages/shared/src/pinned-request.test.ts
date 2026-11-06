/**
 * THE PIN, TESTED AGAINST A REAL SOCKET AND A REAL REBIND.
 *
 * These tests start loopback HTTP servers and make real connections to them.
 * That is not a violation of "no network in tests": nothing leaves the machine,
 * no name is resolved by the system resolver (the lookup is the thing under
 * test), and a pin that is only tested against a fake transport is a pin nobody
 * has evidence for. The whole defect this closes was a guard that LOOKED right
 * against a fake and resolved the name twice in production.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { pinnedRequest } from './pinned-request';
import type { EgressPermit } from './egress-guard';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A loopback server that records the Host header it was given. */
async function listen(
  handler: (received: { host: string | undefined; path: string; auth: string | undefined }) => {
    status: number;
    body: string;
  },
): Promise<{ port: number; hits: Array<{ host: string | undefined; path: string }> }> {
  const hits: Array<{ host: string | undefined; path: string }> = [];
  const server = createServer((req, res) => {
    hits.push({ host: req.headers.host, path: req.url ?? '' });
    const answer = handler({
      host: req.headers.host,
      path: req.url ?? '',
      auth: req.headers.authorization,
    });
    res.writeHead(answer.status, { 'content-type': 'text/plain' });
    res.end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, hits };
}

/**
 * A PINNED permit for `host`, pinning exactly `addresses`.
 *
 * Built by hand rather than through `guardUrl`, because what is under test here
 * is the TRANSPORT's obedience to a permit, not the policy that produced one.
 * The fields `pinnedRequest` reads are `kind`, `pinned.host` and
 * `pinned.addresses`; the rest is the shape the type requires.
 */
function permitFor(host: string, addresses: string[], port: number): EgressPermit {
  return {
    kind: 'PINNED',
    context: 'TRACKER_CALL',
    target: { host, scheme: 'http:', port: String(port) },
    decision: { allowed: true },
    pinned: {
      host,
      addresses: addresses.map((address) => ({
        address,
        class: address.startsWith('127.') ? 'loopback' : 'public',
      })),
    },
    wouldRefuse: null,
  } as unknown as EgressPermit;
}

const INIT = { method: 'GET' as const, timeoutMs: 2_000, maxBytes: 64_000 };

describe('pinnedRequest connects to the pinned address and keeps the name', () => {
  it('reaches the pinned address while sending the pinned NAME as Host', async () => {
    const server = await listen(() => ({ status: 200, body: 'answered' }));
    /*
     * The name is one that cannot resolve — `.invalid` is reserved by RFC 2606
     * for exactly this — so if the pin were ignored and the system resolver
     * consulted, this request could not connect at all. It connecting IS the
     * evidence.
     */
    const result = await pinnedRequest(
      permitFor('pin-target.invalid', ['127.0.0.1'], server.port),
      `http://pin-target.invalid:${server.port}/rest/api/2/issue`,
      INIT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(200);
    expect(result.response.text).toBe('answered');
    // The NAME survived: Host, and therefore SNI and the certificate check on
    // the https path, are the name and not the address.
    expect(server.hits[0]?.host).toBe(`pin-target.invalid:${server.port}`);
    expect(server.hits[0]?.path).toBe('/rest/api/2/issue');
  });

  it('REFUSES when the name is rebound between the guard and the socket', async () => {
    /*
     * ── THE DEFECT, REPRODUCED AND THEN CLOSED ────────────────────────────────
     *
     * An adversary measured the old behaviour end to end: the guard resolved a
     * name to a public address and approved it, the transport resolved the SAME
     * name again, and an attacker who owns the nameserver answered the second
     * query with 127.0.0.1 — producing, on a loopback server:
     *
     *   INTERNAL SERVER RECEIVED: POST /rest/api/2/issue
     *   host: jira.attacker.test | authorization present: true
     *
     * Two queries, no cache between them, 100% reliable. Here the permit pins a
     * PUBLIC address and the loopback server is the "internal" one: a transport
     * that re-resolved would reach it, and one that honours the pin cannot.
     */
    const internal = await listen(() => ({ status: 200, body: 'INTERNAL SERVER REACHED' }));

    /*
     * THE HOST NAME HERE IS `localhost` ON PURPOSE, and an earlier version of
     * this test used a `.invalid` name and was VACUOUS because of it.
     *
     * A `.invalid` name never resolves, so the request failed whether the pin
     * was honoured or not — the test passed with no pin at all, which a
     * mutation proved. `localhost` DOES resolve, to 127.0.0.1, everywhere. So
     * this is a real discriminator: the permit pins a PUBLIC address that routes
     * nowhere (192.0.2.1, RFC 5737 TEST-NET-1), and the loopback server is the
     * "internal" one the attacker's second DNS answer would point at. A
     * transport that re-resolves reaches it. One that honours the pin cannot.
     */
    const result = await pinnedRequest(
      permitFor('localhost', ['192.0.2.1'], internal.port),
      `http://localhost:${internal.port}/rest/api/2/issue`,
      { ...INIT, method: 'POST', body: '{}', headers: { authorization: 'Bearer fake-for-test' }, timeoutMs: 1_500 },
    );

    // It must not have reached the internal server at all.
    expect(internal.hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either the connection to the pinned address failed or it timed out —
    // both are refusals. What must never happen is `ok: true`.
    expect(['TRANSPORT_FAILED', 'TIMED_OUT']).toContain(result.refusal);
  });

  it('refuses a URL whose host is not the one the permit decided about', async () => {
    // A caller that pinned `a` and passed a URL for `b` would otherwise send
    // b's path to a's addresses under b's Host header — worse than no pin.
    const server = await listen(() => ({ status: 200, body: 'answered' }));
    const result = await pinnedRequest(
      permitFor('a.invalid', ['127.0.0.1'], server.port),
      `http://b.invalid:${server.port}/`,
      INIT,
    );

    expect(server.hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('HOST_NOT_THE_PINNED_ONE');
    // The operator detail may name hosts; it is not for the caller to render.
    expect(result.operatorDetail).toContain('a.invalid');
  });

  it('refuses an OBSERVED permit rather than borrowing a pin it was not given', async () => {
    const server = await listen(() => ({ status: 200, body: 'answered' }));
    const observed = {
      kind: 'OBSERVED',
      context: 'TRACKER_CALL',
      target: { host: 'obs.invalid', scheme: 'http:', port: String(server.port) },
      decision: { allowed: null },
      pinned: null,
      wouldRefuse: 'CLASS_NOT_PERMITTED',
    } as unknown as EgressPermit;

    const result = await pinnedRequest(observed, `http://obs.invalid:${server.port}/`, INIT);

    expect(server.hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A caller in OBSERVE mode connects the way it did before this control
    // existed. That is the CALLER's decision, which is why this refuses rather
    // than quietly falling back for it.
    expect(result.refusal).toBe('NOT_PINNED');
  });

  it('does NOT follow a redirect, so a credential cannot be re-sent elsewhere', async () => {
    /*
     * Following one would re-send the body, the authorization header and — for a
     * webhook — the token in the path to whatever `Location` names, which is a
     * host nothing classified. The 3xx comes back as a 3xx and the caller
     * decides.
     */
    const server = await listen(() => ({ status: 302, body: '' }));
    const result = await pinnedRequest(
      permitFor('redir.invalid', ['127.0.0.1'], server.port),
      `http://redir.invalid:${server.port}/`,
      INIT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(302);
    // One request. A followed redirect would be two.
    expect(server.hits).toHaveLength(1);
  });

  it('caps the body and SAYS it capped, rather than reporting a floor as the whole answer', async () => {
    /*
     * ── THIS TEST WAS VACUOUS AND GREEN, AND IT HID A CRITICAL ────────────────
     *
     * It served `'x'.repeat(5_000)` against `maxBytes: 100`. A 5 KiB body is
     * fully parsed before `res.destroy()` runs, so `end` still fired and the
     * promise settled — while any body too large to sit in the socket receive
     * buffer never settled at all, because `end` does not fire after a destroy.
     * The one test covering the cap passed for a reason that had nothing to do
     * with the cap, which is why a dedicated transport suite did not find it.
     *
     * 256 KiB is over any loopback receive buffer, so this arrives in several
     * segments and `destroy()` runs mid-stream — the production shape. Paired
     * with the small-body case below, because the two settle through DIFFERENT
     * paths now (the cap's own settle, and `end`) and a test that only exercised
     * one would leave the other unguarded.
     */
    const server = await listen(() => ({ status: 200, body: 'x'.repeat(256 * 1024) }));
    const result = await pinnedRequest(
      permitFor('big.invalid', ['127.0.0.1'], server.port),
      `http://big.invalid:${server.port}/`,
      { ...INIT, maxBytes: 8_192 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.truncated).toBe(true);
    expect(result.response.text.length).toBe(8_192);
  });

  it('caps a body that DOES fit the socket buffer, which settles by a different path', async () => {
    // The small case still goes out through `end`, so both arms are covered.
    const server = await listen(() => ({ status: 200, body: 'x'.repeat(5_000) }));
    const result = await pinnedRequest(
      permitFor('small.invalid', ['127.0.0.1'], server.port),
      `http://small.invalid:${server.port}/`,
      { ...INIT, maxBytes: 100 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.truncated).toBe(true);
    expect(result.response.text.length).toBeLessThanOrEqual(100);
  });

  it('settles a 1 MiB answer in milliseconds instead of never', async () => {
    /*
     * The regression this guards, stated as a DEADLINE and not just a value: the
     * orphaned promise wedged an Express handler and a worker processor for the
     * life of the process, and every caller plain-`await`s this. A test that
     * only checked `truncated` would pass on a build that took 30 seconds to
     * get there, so the elapsed time is the assertion.
     */
    const server = await listen(() => ({ status: 200, body: 'x'.repeat(1024 * 1024) }));
    const started = Date.now();
    const result = await pinnedRequest(
      permitFor('huge.invalid', ['127.0.0.1'], server.port),
      `http://huge.invalid:${server.port}/`,
      { ...INIT, maxBytes: 8_192, timeoutMs: 5_000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.truncated).toBe(true);
    // Well inside `timeoutMs`, so this cannot pass by timing out instead.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('TIMES OUT ON ELAPSED TIME, not merely on idleness between reads', async () => {
    /*
     * `RequestOptions.timeout` is Node's SOCKET timeout and measures IDLENESS.
     * MEASURED with only that bound: a server trickling 20 bytes every 400ms
     * against `timeoutMs: 1200` returned SUCCESSFULLY after 12,840ms, because no
     * single gap reached the limit. The `fetch` calls these paths replaced used
     * `AbortSignal.timeout`, which is a real deadline — so shipping without one
     * would have removed a bound while every caller's prose still promised it.
     */
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let ticks = 0;
      const timer = setInterval(() => {
        if (ticks++ > 40) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write('x'.repeat(20));
      }, 150);
      res.on('close', () => clearInterval(timer));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const started = Date.now();
    const result = await pinnedRequest(
      permitFor('trickle.invalid', ['127.0.0.1'], address.port),
      `http://trickle.invalid:${address.port}/`,
      { ...INIT, maxBytes: 64_000, timeoutMs: 600 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('TIMED_OUT');
    // The deadline was honoured as ELAPSED time: every read gap here is 150ms,
    // well under the 600ms limit, so an idleness-only bound would never fire.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers the pinned address for both lookup arities', async () => {
    /*
     * Node calls `lookup` with `all: true` from some paths and without it from
     * others. A lookup that answered only one arity would silently fall back to
     * the system resolver for the other — the pin not applying, which is the
     * failure the adapter exists to prevent. Driving a real request exercises
     * whichever arity this Node uses; both are asserted directly in
     * egress-guard.test.ts.
     */
    const server = await listen(() => ({ status: 200, body: 'ok' }));
    const result = await pinnedRequest(
      permitFor('arity.invalid', ['127.0.0.1'], server.port),
      `http://arity.invalid:${server.port}/`,
      INIT,
    );
    expect(result.ok).toBe(true);
  });

  it('times out rather than hanging on a server that never answers', async () => {
    const server = createServer(() => {
      // Accept and say nothing, ever.
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const result = await pinnedRequest(
      permitFor('slow.invalid', ['127.0.0.1'], address.port),
      `http://slow.invalid:${address.port}/`,
      { ...INIT, timeoutMs: 250 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('TIMED_OUT');
    // The deadline is reported as a deadline, not as whatever socket error
    // destroying the request produced.
    expect(result.operatorDetail).toContain('250ms');
  });
});
