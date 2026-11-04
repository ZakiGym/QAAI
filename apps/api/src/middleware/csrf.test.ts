import { beforeEach, describe, expect, it } from 'vitest';
import {
  CSRF_REFUSALS,
  CSRF_REFUSAL_MESSAGE,
  csrfGuard,
  csrfObserved,
  csrfVerdict,
  parseOrigin,
  resetCsrfObserved,
} from './csrf.js';
import { SECURITY_CONTROL_BRAKES } from '@qaai/shared';

/**
 * THE CSRF CHECK THIS API DID NOT HAVE.
 *
 * The cockpit authenticates with the `qaai_session` cookie and `cors` runs with
 * `credentials: true`, so before this control any site a signed-in user visited
 * could make their browser POST here with the cookie attached. CORS does not
 * stop it — a preflight decides who may READ the response, and "delete this
 * project" does not need a readable response.
 *
 * These tests drive the decision directly. That is why the decision is a pure
 * function in its own module: `apps/api/src/index.ts` calls `app.listen` at
 * module scope and starts the Redis event relay, so a test that imported it
 * would bind a port.
 */

const WEB = 'https://app.qaai.dev';

/** Everything a decision needs, with the one field under test overridden. */
function ask(over: Partial<Parameters<typeof csrfVerdict>[0]> = {}) {
  return csrfVerdict({
    method: 'POST',
    cookieAuthenticated: true,
    origin: undefined,
    fetchSite: undefined,
    webOrigin: WEB,
    ...over,
  });
}

describe('the CSRF decision', () => {
  it('ALLOWS the cockpit’s own origin', () => {
    expect(ask({ origin: WEB }).ok).toBe(true);
    // A path on the Origin header is still the same origin.
    expect(ask({ origin: `${WEB}/projects` }).ok).toBe(true);
  });

  it('REFUSES A FOREIGN ORIGIN, which is the attack', () => {
    const verdict = ask({ origin: 'https://evil.example.net' });
    expect(verdict).toEqual({ ok: false, refusal: 'FOREIGN_ORIGIN' });
  });

  it('REFUSES A PREFIX MATCH, which is the classic hole', () => {
    /*
     * `https://app.qaai.dev.evil.net` STARTS WITH `https://app.qaai.dev`. A
     * `startsWith` comparison here would accept it, and the attacker registers
     * that name. The check compares parsed ORIGINS, so it does not.
     */
    expect(ask({ origin: 'https://app.qaai.dev.evil.net' })).toEqual({
      ok: false,
      refusal: 'FOREIGN_ORIGIN',
    });
  });

  it('REFUSES when NEITHER header is present — it fails closed', () => {
    // Every browser that can attach a cookie cross-site sends at least one of
    // the two, so their joint absence is not a browser. "We could not tell"
    // must never be the arm that allows.
    expect(ask()).toEqual({ ok: false, refusal: 'NO_ORIGIN' });
  });

  it('REFUSES `same-site`, because a subdomain is same-site and not same-origin', () => {
    /*
     * THE SUBTLE ONE. Accepting `same-site` would trust every host under the
     * registrable domain — including one an attacker got hold of, and including
     * a customer subdomain on a shared provider.
     */
    expect(ask({ fetchSite: 'same-site' })).toEqual({ ok: false, refusal: 'NO_ORIGIN' });
    expect(ask({ fetchSite: 'cross-site' })).toEqual({ ok: false, refusal: 'NO_ORIGIN' });
  });

  it('allows `same-origin` and `none` when no Origin was sent', () => {
    expect(ask({ fetchSite: 'same-origin' }).ok).toBe(true);
    // `none` is a user-initiated load — a typed URL or a bookmark — which no
    // other site caused.
    expect(ask({ fetchSite: 'none' }).ok).toBe(true);
  });

  it('REFUSES EVERYTHING when `WEB_PUBLIC_URL` could not be parsed', () => {
    // A misconfigured installation must not silently lose the control by
    // matching nothing against nothing.
    expect(ask({ origin: WEB, webOrigin: null })).toEqual({
      ok: false,
      refusal: 'FOREIGN_ORIGIN',
    });
  });

  it('EXEMPTS AN API KEY, because the caller attached that credential itself', () => {
    /*
     * A malicious page cannot read an API key, so it cannot attach one — which
     * is why this check does not apply. Checking it would break the CLI, the
     * Action and every CI integration for no gain, and that is how a control
     * gets switched off wholesale instead of narrowed.
     */
    expect(ask({ cookieAuthenticated: false, origin: 'https://evil.example.net' }).ok).toBe(true);
  });

  it('EXEMPTS SAFE METHODS, in any casing', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(ask({ method }).ok, method).toBe(true);
    }
  });

  it('CHECKS every mutating method, not just POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(ask({ method, origin: 'https://evil.example.net' }).ok, method).toBe(false);
    }
  });

  it('treats an opaque origin as absent rather than as a match', () => {
    // Browsers send the literal string `null` for a sandboxed iframe or a
    // `data:` document. It is not an origin, and it is not ours.
    expect(parseOrigin('null')).toBeNull();
    expect(ask({ origin: 'null' })).toEqual({ ok: false, refusal: 'NO_ORIGIN' });
    expect(parseOrigin('not a url')).toBeNull();
  });
});

// ─── The refusal says nothing ───────────────────────────────────────────────

describe('a refusal is not an oracle', () => {
  it('gives ONE message for both refusals', () => {
    /*
     * "You sent no Origin" and "you sent the wrong Origin" are two facts about
     * this installation's configuration, and the second would confirm to a
     * prober that they had reached a real deployment with a real cockpit
     * origin. The operator gets both facts in the observe counts; the caller
     * gets neither.
     */
    const res = captureResponse();
    const guard = csrfGuard({ webOrigin: WEB, log: () => {}, storedModes: { CSRF_TOKEN: 'ENFORCE' } });

    guard(requestWith({ origin: 'https://evil.example.net' }), res.res, () => {});
    const foreign = res.body;
    const second = captureResponse();
    guard(requestWith({}), second.res, () => {});

    expect(foreign).toEqual(second.body);
    expect(JSON.stringify(foreign)).toContain('CSRF_REFUSED');
    // It names no origin, ours or theirs.
    expect(JSON.stringify(foreign)).not.toContain('evil.example.net');
    expect(JSON.stringify(foreign)).not.toContain('qaai.dev');
    expect(foreign?.error?.message).toBe(CSRF_REFUSAL_MESSAGE);
  });
});

// ─── The brake ──────────────────────────────────────────────────────────────

describe('the rollout brake', () => {
  beforeEach(() => resetCsrfObserved());

  it('DEFAULTS TO ENFORCE, and the brake table says why that is safe', () => {
    // Derived from the shared table rather than restated, so the two cannot
    // drift: a test asserting 'ENFORCE' as a literal would still pass after
    // somebody changed the default.
    expect(SECURITY_CONTROL_BRAKES.CSRF_TOKEN.fallback).toBe('ENFORCE');

    const res = captureResponse();
    // No stored modes at all — the production mount passes none today.
    csrfGuard({ webOrigin: WEB, log: () => {} })(
      requestWith({ origin: 'https://evil.example.net' }),
      res.res,
      () => {
        throw new Error('next() must not be called on an enforced refusal');
      },
    );
    expect(res.status).toBe(403);
  });

  it('OBSERVE COUNTS what it would have refused, and lets it through', () => {
    // A mode that does not count is an off switch with a reassuring name.
    let proceeded = 0;
    const logged: Record<string, unknown>[] = [];
    const guard = csrfGuard({
      webOrigin: WEB,
      log: (fields) => logged.push(fields),
      storedModes: { CSRF_TOKEN: 'OBSERVE' },
    });
    const res = captureResponse();

    guard(requestWith({ origin: 'https://evil.example.net' }), res.res, () => {
      proceeded += 1;
    });
    guard(requestWith({}), res.res, () => {
      proceeded += 1;
    });

    expect(proceeded).toBe(2);
    expect(res.status).toBeNull();
    // Counted PER REASON, because a flood of NO_ORIGIN is a client that needs
    // an API key while a flood of FOREIGN_ORIGIN is a misconfiguration or an
    // attack — different facts, different remedies.
    expect(csrfObserved()).toEqual({ FOREIGN_ORIGIN: 1, NO_ORIGIN: 1 });
    expect(logged).toHaveLength(2);
  });

  it('NEVER LOGS THE FULL PATH, because a path carries ids and sometimes a token', () => {
    const logged: Record<string, unknown>[] = [];
    const guard = csrfGuard({
      webOrigin: WEB,
      log: (fields) => logged.push(fields),
      storedModes: { CSRF_TOKEN: 'OBSERVE' },
    });
    // Built with the path fields set, rather than assigned after: Express's
    // `Request.path` is a readonly getter on the real type.
    const req = requestWith({
      baseUrl: '/projects',
      path: '/projects/proj_secret_id/secrets/sec_abc',
    });

    guard(req, captureResponse().res, () => {});

    expect(logged[0]?.path).toBe('/projects');
    expect(JSON.stringify(logged[0])).not.toContain('proj_secret_id');
    expect(JSON.stringify(logged[0])).not.toContain('sec_abc');
  });

  it('falls back to ENFORCE for a malformed or unknown stored mode', () => {
    for (const stored of [{ CSRF_TOKEN: 'MAYBE' }, { CSRF_TOKEN: null }, 'nonsense', [], null]) {
      const res = captureResponse();
      csrfGuard({ webOrigin: WEB, log: () => {}, storedModes: stored })(
        requestWith({ origin: 'https://evil.example.net' }),
        res.res,
        () => {},
      );
      expect(res.status, JSON.stringify(stored)).toBe(403);
    }
  });

  it('names every refusal in the closed set, so a third cannot appear unlabelled', () => {
    expect([...CSRF_REFUSALS]).toEqual(['NO_ORIGIN', 'FOREIGN_ORIGIN']);
  });
});

// ─── Minimal Express doubles ────────────────────────────────────────────────

interface CapturedBody {
  error?: { code?: string; message?: string };
}

function captureResponse() {
  const state: { status: number | null; body: CapturedBody | null } = { status: null, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: CapturedBody) {
      state.body = payload;
      return res;
    },
  };
  return {
    res: res as unknown as Parameters<ReturnType<typeof csrfGuard>>[1],
    get status() {
      return state.status;
    },
    get body() {
      return state.body;
    },
  };
}

function requestWith(headers: {
  origin?: string;
  fetchSite?: string;
  baseUrl?: string;
  path?: string;
}) {
  const req = {
    method: 'POST',
    baseUrl: headers.baseUrl ?? '',
    path: headers.path ?? '/',
    // A session actor: no `apiKeyId`, so the browser attached the credential.
    actor: { apiKeyId: null },
    get(name: string): string | undefined {
      const key = name.toLowerCase();
      if (key === 'origin') return headers.origin;
      if (key === 'sec-fetch-site') return headers.fetchSite;
      return undefined;
    },
  };
  return req as unknown as Parameters<ReturnType<typeof csrfGuard>>[0];
}
