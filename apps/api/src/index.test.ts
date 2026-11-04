import { realpathSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_CONTROL_BRAKES } from '@qaai/shared';

/**
 * THE COMPOSITION ROOT, DRIVEN BY REAL REQUESTS.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * `index.ts` is where the security headers are set, and a header is set by a
 * MOUNT: there is no pure function to test instead, because the mount IS the
 * control. `middleware/csrf.ts`'s header records what that cost — "a control
 * whose decision cannot be driven by a test is a control nobody can trust" —
 * and it escaped by moving its decision into its own module. The headers could
 * not escape, so `index.ts` keeps its two side effects (`app.listen` and the
 * Redis event relay) behind a NODE_ENV guard and exports the app instead.
 *
 * ── NO NETWORK, NO REDIS, NO DATABASE ──────────────────────────────────────
 *
 * `ioredis` is replaced by a class that connects to nothing, because
 * `lib/queues.ts` constructs a client at module scope. No socket is bound: the
 * app is an ordinary request handler, so a request is a hand-built
 * `IncomingMessage` and `ServerResponse` pair handed straight to it.
 *
 * The Prisma client is a PROXY over the real one that answers three models and
 * passes everything else through, and the `organization` fake HONOURS `select`
 * and THROWS on a `where` it does not implement. That is deliberate and it is
 * the point of writing it that way: a fake that returned a whole row would make
 * "stop selecting `securityControlModes`" undetectable, which is the shape of
 * defect that let a fix ship unreachable in an earlier round.
 */

const ORG_ID = 'org_for_the_header_test';
const USER_ID = 'usr_for_the_header_test';
/**
 * The cookie value the fake session table answers to. Not a credential: it is
 * hashed with the real `hashToken` and compared, so the fake honours the filter
 * `attachActor` actually sends rather than answering any cookie at all.
 */
const SESSION_COOKIE_VALUE = 'a-value-this-test-made-up';

vi.mock('ioredis', () => {
  class FakeRedis {
    on(): this {
      return this;
    }
    subscribe(): this {
      return this;
    }
    quit(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { default: FakeRedis };
});

/** What `Organization.securityControlModes` holds for {@link ORG_ID}. */
let storedModes: unknown = null;
/** Every `organization.findUnique` the request path made, with its projection. */
let organizationReads: { readonly id: unknown; readonly columns: readonly string[] }[] = [];

vi.mock('./lib/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/prisma.js')>();
  const { hashToken } = await import('./lib/crypto.js');

  /** Return exactly the columns the query asked for, and nothing else. */
  const project = (row: Record<string, unknown>, select: unknown): Record<string, unknown> => {
    if (typeof select !== 'object' || select === null) {
      throw new Error('this fake requires an explicit `select`, so a dropped column is visible');
    }
    const out: Record<string, unknown> = {};
    for (const [column, wanted] of Object.entries(select as Record<string, unknown>)) {
      if (wanted !== true) continue;
      if (!(column in row)) throw new Error(`the fake row has no column ${column}`);
      out[column] = row[column];
    }
    return out;
  };

  const fakes = {
    session: {
      findUnique: async (args: { where?: { tokenHash?: unknown }; select?: unknown }) => {
        const tokenHash = args.where?.tokenHash;
        if (typeof tokenHash !== 'string') {
          throw new Error('the fake session table only answers a lookup by tokenHash');
        }
        if (tokenHash !== hashToken(SESSION_COOKIE_VALUE)) return null;
        return project(
          {
            userId: USER_ID,
            activeOrgId: ORG_ID,
            expiresAt: new Date(Date.now() + 3_600_000),
            revokedAt: null,
          },
          args.select,
        );
      },
    },
    membership: {
      findUnique: async (args: { where?: unknown; select?: unknown }) => {
        const where = args.where as { orgId_userId?: { orgId?: unknown; userId?: unknown } };
        if (where?.orgId_userId?.orgId !== ORG_ID || where.orgId_userId.userId !== USER_ID) {
          throw new Error('the fake membership table only answers for this test’s org and user');
        }
        return project({ orgId: ORG_ID, role: 'OWNER' }, args.select);
      },
    },
    organization: {
      findUnique: async (args: { where?: { id?: unknown }; select?: unknown }) => {
        const id = args.where?.id;
        organizationReads.push({
          id,
          columns: Object.keys((args.select ?? {})),
        });
        if (id !== ORG_ID) {
          throw new Error('the fake organization table only answers for this test’s org');
        }
        return project({ id: ORG_ID, name: 'fake', securityControlModes: storedModes }, args.select);
      },
    },
  } as const;

  const prisma = new Proxy(actual.prisma, {
    get(target, property, receiver) {
      if (property === 'session' || property === 'membership' || property === 'organization') {
        return fakes[property];
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  return { ...actual, prisma };
});

/*
 * STATIC, not a dynamic import inside a test: transforming sixty routers takes
 * seconds, and paying that inside the first `it` put it within range of the
 * default five-second timeout. Measured: the same assertions flaked roughly one
 * run in four with a dynamic import and have not since.
 */
import {
  app,
  cspObserved,
  CSP_DIRECTIVE_OVERFLOW,
  resetCspObserved,
  resetSecurityModeCache,
  securityHeaders,
} from './index.js';

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | number | string[] | undefined>;
  readonly body: string;
}

/**
 * One request through the WHOLE stack: request context, helmet, cors, the body
 * parsers, the limiter, `attachActor`, the CSRF guard, the headers and the
 * routers. No socket is bound — an Express app is a request handler, and this
 * is the pair of objects Node would have handed it.
 */
/**
 * A socket-shaped duplex that is connected to nothing.
 *
 * An object literal is NOT enough and the reason is worth writing down, because
 * it cost an hour: `body-parser` skips a request `onFinished.isFinished()`
 * reports as finished, and that helper reads `!socket.readable` — which is true
 * for any object without the property. The body then arrives as `undefined`
 * with no error anywhere, so `/csp-report` counted every report as `unknown`
 * and the test looked like a product defect. A real duplex is readable,
 * writable, and destroyable, which is all the http machinery asks of it.
 */
function fakeSocket(): Socket {
  class FakeSocket extends Duplex {
    override _read(): void {
      /* nothing arrives from a socket nobody connected */
    }
    override _write(_chunk: unknown, _encoding: unknown, done: () => void): void {
      done();
    }
    setTimeout(): this {
      return this;
    }
  }
  const socket = new FakeSocket();
  return Object.assign(socket, {
    remoteAddress: '203.0.113.9',
    remoteFamily: 'IPv4',
    encrypted: false,
  }) as unknown as Socket;
}

async function request(options: {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): Promise<Answer> {
  const socket = fakeSocket();
  const req = new IncomingMessage(socket);
  req.method = options.method;
  req.url = options.url;
  req.headers = { host: 'api.test', ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    req.headers['content-length'] = String(Buffer.byteLength(options.body));
    req.push(options.body);
  }
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: string[] = [];
  const finished = new Promise<void>((resolve) => {
    const write = (chunk: unknown): void => {
      if (typeof chunk === 'string') chunks.push(chunk);
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString('utf8'));
    };
    res.write = ((chunk: unknown) => {
      write(chunk);
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown) => {
      write(chunk);
      resolve();
      return res;
    }) as typeof res.end;
  });

  (app as unknown as (r: IncomingMessage, s: ServerResponse) => void)(req, res);
  await finished;
  return { status: res.statusCode, headers: res.getHeaders(), body: chunks.join('') };
}

/** The same request, signed in as a member of {@link ORG_ID} by cookie. */
const asMember = (over: Parameters<typeof request>[0]): Promise<Answer> =>
  request({
    ...over,
    headers: { cookie: `qaai_session=${SESSION_COOKIE_VALUE}`, ...(over.headers ?? {}) },
  });

beforeEach(() => {
  storedModes = null;
  organizationReads = [];
  resetSecurityModeCache();
  resetCspObserved();
});

afterEach(() => {
  resetSecurityModeCache();
  resetCspObserved();
});

describe('importing the composition root starts nothing', () => {
  it('is IMPORTED and not run, which is the whole reason no port is bound', () => {
    /*
     * `index.ts` calls `app.listen` only when it is the process entrypoint, and
     * this is the alarm for the day that stops being true: if a runner ever
     * invokes this file directly, the guard would start a real server in the
     * middle of the suite and bind `API_PORT`. Asserting the mechanism rather
     * than the symptom, because the symptom is an EADDRINUSE in an unrelated
     * file.
     *
     * Two candidates were rejected before this one and both are worth knowing
     * about: `NODE_ENV !== 'test'` breaks the CI dogfood job, which sets
     * `NODE_ENV: test` for the whole job and then starts the real stack, and
     * `process.env.VITEST` is refused by `scripts/check-wiring.ts` as an env
     * var no deployment can discover.
     */
    const entry = process.argv[1];
    expect(entry).toBeDefined();
    expect(realpathSync(String(entry))).not.toBe(fileURLToPath(import.meta.url));
  });
});

describe('the content security policy, and the brake nobody could arm', () => {
  it('sends the policy REPORT-ONLY to an anonymous request, which is the default mode', async () => {
    const answer = await request({ method: 'GET', url: '/nope' });

    // Derived from the shared table rather than restated: a literal 'OBSERVE'
    // here would still pass after somebody changed the default.
    expect(SECURITY_CONTROL_BRAKES.CONTENT_SECURITY_POLICY.fallback).toBe('OBSERVE');
    expect(answer.headers['content-security-policy-report-only']).toContain("default-src 'none'");
    // And NOT the enforcing header, which is the whole difference between the
    // two modes. A deployment that sent both would be enforcing.
    expect(answer.headers['content-security-policy']).toBeUndefined();
    // No org was in hand, and that is the honest reason — not a failure.
    expect(organizationReads).toEqual([]);
  });

  it('ARMS FROM THE ORG’S STORED MODE, which a hardcoded null could never reach', async () => {
    /*
     * THE DOOR THIS ITEM IS ABOUT.
     *
     * The read was `controlMode('CONTENT_SECURITY_POLICY', null)` with the null
     * written in, so the only value the control could ever have was its own
     * default: there was no path from OBSERVE to ENFORCE short of editing the
     * table, while the paragraph above the code named the consequence of
     * leaving it at OBSERVE as stored XSS against this origin.
     *
     * This request is the path: a real cookie, through the real `attachActor`,
     * which resolves the session and the membership and puts the org on the
     * request — and the header middleware is mounted after it for exactly this
     * reason.
     */
    storedModes = { CONTENT_SECURITY_POLICY: 'ENFORCE' };
    const answer = await asMember({ method: 'GET', url: '/nope' });

    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.headers['content-security-policy-report-only']).toBeUndefined();
    // The actor's org, read by primary key, asking for the one column. The
    // fake honours `select`, so dropping it from the query fails this.
    expect(organizationReads).toEqual([{ id: ORG_ID, columns: ['securityControlModes'] }]);
  });

  it('keeps REPORT-ONLY for an org that stored OBSERVE, and for one that stored nonsense', async () => {
    storedModes = { CONTENT_SECURITY_POLICY: 'OBSERVE' };
    const observing = await asMember({ method: 'GET', url: '/nope' });
    expect(observing.headers['content-security-policy-report-only']).toBeDefined();
    expect(observing.headers['content-security-policy']).toBeUndefined();

    // An unparseable or unknown stored value resolves to the control's own
    // fallback, which for this one is OBSERVE. A malformed settings row must
    // not be the way a tenant's API starts enforcing a policy they did not
    // choose, and it must not be the way one stops.
    for (const stored of [{ CONTENT_SECURITY_POLICY: 'MAYBE' }, 'nonsense', [], null, {}]) {
      storedModes = stored;
      resetSecurityModeCache();
      const answer = await asMember({ method: 'GET', url: '/nope' });
      expect(answer.headers['content-security-policy-report-only'], JSON.stringify(stored)).toBeDefined();
      expect(answer.headers['content-security-policy'], JSON.stringify(stored)).toBeUndefined();
    }
  });

  it('reads one org row per TTL rather than one per response', async () => {
    // A header is set on every response, and a database round trip per response
    // for a brake that changes a few times a year is a cost nobody would
    // accept. The limit that buys is stated where the cache is.
    storedModes = { CONTENT_SECURITY_POLICY: 'ENFORCE' };
    for (let i = 0; i < 3; i += 1) {
      const answer = await asMember({ method: 'GET', url: '/nope' });
      expect(answer.headers['content-security-policy']).toBeDefined();
    }
    expect(organizationReads).toHaveLength(1);
  });

  it('FALLS BACK TO THE CONTROL’S OWN DEFAULT when the lookup throws, never to enforcing', async () => {
    /*
     * An exception handler that falls through to the permissive answer is the
     * defect pattern this round hunts, and the mirror image — an exception that
     * falls through to the STRICTEST answer — is just as bad here: a database
     * blip would start enforcing a policy on every tenant at once and break the
     * HTML surfaces this origin serves. The fallback is the one the brake table
     * chose, which is what `controlMode` does for a value it cannot parse.
     *
     * Driven through the exported factory rather than the app, because the
     * failure being injected is the lookup itself.
     */
    const headers = new Map<string, unknown>();
    const res = {
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
      },
    } as unknown as Parameters<ReturnType<typeof securityHeaders>>[1];
    let proceeded = 0;

    await securityHeaders({
      modesFor: () => Promise.reject(new Error('the database is unreachable')),
    })({ actor: { orgId: ORG_ID } } as unknown as Parameters<ReturnType<typeof securityHeaders>>[0], res, () => {
      proceeded += 1;
    });

    expect(headers.get('content-security-policy-report-only')).toContain("default-src 'none'");
    expect(headers.has('content-security-policy')).toBe(false);
    // And the request is served. A header this process could not decide must
    // not become an outage.
    expect(proceeded).toBe(1);
  });

  it('permits nothing at all, and names the endpoint it reports to', async () => {
    const answer = await request({ method: 'GET', url: '/nope' });
    const policy = String(answer.headers['content-security-policy-report-only']);
    for (const directive of [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(policy, directive).toContain(directive);
    }
    /*
     * The report endpoint named in the header must be the one this process
     * serves, or OBSERVE is a promise with nowhere to land. Asserted by DRIVING
     * the URL out of the header rather than by repeating the string.
     */
    const reportUri = /report-uri (\S+)/.exec(policy)?.[1];
    expect(reportUri).toBe('/csp-report');
    const reported = await request({
      method: 'POST',
      url: String(reportUri),
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'style-src-elem' } }),
    });
    expect(reported.status).toBe(204);
  });

  it('sends the three unconditional headers to everyone, because none can break a client', async () => {
    const answer = await request({ method: 'GET', url: '/nope' });
    expect(answer.headers['x-frame-options']).toBe('DENY');
    // A referrer carries the path, and a path can carry an id or a token.
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(answer.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});

describe('the violation reports are COUNTED, which is what makes OBSERVE a measurement', () => {
  it('counts per directive and answers 204 with no body', async () => {
    // `observeCounts` promises "every violation report, by directive, so the
    // policy can be tightened on evidence". A mode with no counter is an off
    // switch with a reassuring name.
    expect(SECURITY_CONTROL_BRAKES.CONTENT_SECURITY_POLICY.observeCounts).toContain('directive');

    for (const directive of ['style-src-elem', 'style-src-elem', 'script-src-elem']) {
      const answer = await request({
        method: 'POST',
        url: '/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': directive } }),
      });
      expect(answer.status).toBe(204);
      // Fire and forget: a reporter must learn nothing from the answer.
      expect(answer.body).toBe('');
    }

    expect(cspObserved()).toEqual({ 'style-src-elem': 2, 'script-src-elem': 1 });
  });

  it('keeps the blocked URI and the document URI OUT of the count and the log', async () => {
    // A report carries a page's full URLs, and those are the thing a log must
    // not accumulate — for a share link or a signed artifact URL the path IS
    // the credential.
    await request({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'violated-directive': 'img-src',
          'blocked-uri': 'https://evil.example.net/pixel?token=abc',
          'document-uri': 'https://api.test/share/tok_secret',
        },
      }),
    });
    expect(Object.keys(cspObserved())).toEqual(['img-src']);
    expect(JSON.stringify(cspObserved())).not.toContain('tok_secret');
    expect(JSON.stringify(cspObserved())).not.toContain('evil.example.net');
  });

  it('CAPS THE DISTINCT DIRECTIVES, because the key comes out of a request body', async () => {
    /*
     * A map keyed on a string a reporter chose is a memory leak with a
     * security-sounding name. Past the cap everything lands in one bucket, so
     * the total is never understated — a cap that bit without being counted is
     * one of the lies this product cannot afford.
     */
    for (let i = 0; i < 50; i += 1) {
      await request({
        method: 'POST',
        url: '/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': `made-up-${i}` } }),
      });
    }
    const counted = cspObserved();
    expect(Object.keys(counted).length).toBeLessThanOrEqual(33);
    expect(counted[CSP_DIRECTIVE_OVERFLOW]).toBeGreaterThan(0);
    // Every report is in the total, whichever bucket it landed in.
    expect(Object.values(counted).reduce((sum, n) => sum + n, 0)).toBe(50);
  });

  it('counts a report with no directive under one name rather than dropping it', async () => {
    await request({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': {} }),
    });
    // "We received a report we could not read" is a different fact from "we
    // received none", and only one of the two is true.
    expect(cspObserved()).toEqual({ unknown: 1 });
  });
});
