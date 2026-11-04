/**
 * CSRF, for an API whose cockpit authenticates with a cookie.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * This API had NO CSRF protection of any kind. The cockpit authenticates with
 * the `qaai_session` cookie and `cors` is configured `credentials: true`, so
 * until this module existed any site a signed-in user visited could make their
 * browser POST here with that cookie attached. CORS does not prevent it: a
 * preflight decides whether the attacker may READ the response, and for
 * "delete this project", "invite this member" or "write this egress allowlist
 * entry" the attacker does not care what the response says.
 *
 * ── WHY THE DECISION IS A PURE FUNCTION ─────────────────────────────────────
 *
 * It lives here, apart from `apps/api/src/index.ts`, for one reason that is
 * about testability and nothing else: `index.ts` calls `app.listen` at module
 * scope and starts the worker event relay, so importing it from a test binds a
 * port and dials Redis. A control whose decision cannot be driven by a test is
 * a control nobody can trust, and this one has six branches worth asserting.
 * {@link csrfVerdict} takes plain values and returns a verdict; the Express
 * middleware is the thin shell around it.
 */

import type { NextFunction, Request, Response } from 'express';
import { controlEnforces, controlMode } from '@qaai/shared';

/** Methods that cannot change state, so cannot be worth forging. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Why a request was refused, as a closed set.
 *
 * Two members and they are deliberately NOT collapsed into one, because they
 * are different facts for the OPERATOR reading the observe-mode counts: a flood
 * of NO_ORIGIN is a non-browser client that should be holding an API key, and a
 * flood of FOREIGN_ORIGIN is either a misconfigured `WEB_PUBLIC_URL` or an
 * actual attack. The CALLER is told neither — see {@link CSRF_REFUSAL_MESSAGE}.
 */
export const CSRF_REFUSALS = ['NO_ORIGIN', 'FOREIGN_ORIGIN'] as const;
export type CsrfRefusal = (typeof CSRF_REFUSALS)[number];

/**
 * THE ONE SENTENCE A REFUSED CALLER GETS. The same for both refusals.
 *
 * "You sent no Origin" and "you sent the wrong Origin" are two facts about this
 * installation's configuration, and the second one would confirm to a prober
 * that they had reached a real deployment with a real cockpit origin. The
 * refusal names the remedy instead, which is useful to a legitimate caller and
 * tells an attacker nothing.
 */
export const CSRF_REFUSAL_MESSAGE =
  'This request was refused because it was not made from this installation’s own cockpit. ' +
  'Programmatic callers should authenticate with an API key.';

export type CsrfVerdict = { readonly ok: true } | { readonly ok: false; readonly refusal: CsrfRefusal };

/**
 * MAY THIS REQUEST PROCEED?
 *
 * ── Why an Origin check rather than a double-submit token ──────────────────
 *
 * A token needs the cockpit to read a cookie and set a header on every mutating
 * call, and a control that needs a coordinated client change ships late and
 * partially. `Origin` and `Sec-Fetch-Site` are set BY THE BROWSER and cannot be
 * forged by page JavaScript — the same property a token relies on, with nothing
 * to deploy. The cost is real and stated: a cookie-authenticated NON-browser
 * client is refused, and its remedy is an API key, which is what it should have
 * been using.
 *
 * ── Why only cookie-authenticated requests ────────────────────────────────
 *
 * `SECURITY_CONTROL_BRAKES.CSRF_TOKEN` states it: "a CSRF check only applies
 * where the browser attaches the credential by itself." An API key or bearer
 * token is put on the request deliberately by the caller, and a malicious page
 * has no way to read one. Checking those would break the CLI, the Action and
 * every CI integration for no gain, which is how a control gets disabled
 * wholesale rather than narrowed.
 *
 * ── FAILS CLOSED ──────────────────────────────────────────────────────────
 *
 * Neither header present is a REFUSAL. Every browser that can attach a cookie
 * cross-site sends at least one of the two, so their joint absence is not a
 * browser — and "we could not tell" must never be the arm that allows.
 */
export function csrfVerdict(input: {
  readonly method: string;
  /** True only when the credential was attached by the browser, not the caller. */
  readonly cookieAuthenticated: boolean;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
  /** This installation's cockpit origin, or null when it could not be parsed. */
  readonly webOrigin: string | null;
}): CsrfVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (!input.cookieAuthenticated) return { ok: true };

  const sent = parseOrigin(input.origin);
  if (sent !== null) {
    /*
     * A parsed Origin is compared as an ORIGIN and never as a prefix. A
     * `startsWith` here is the classic hole: `https://app.qaai.dev.evil.net`
     * starts with `https://app.qaai.dev`. An unparseable `webOrigin` refuses
     * everything rather than matching nothing-against-nothing, because a
     * misconfigured installation must not silently lose the control.
     */
    return input.webOrigin !== null && sent === input.webOrigin
      ? { ok: true }
      : { ok: false, refusal: 'FOREIGN_ORIGIN' };
  }

  /*
   * No Origin. `Sec-Fetch-Site` is the fallback and only two of its four values
   * are acceptable:
   *
   *   same-origin  the cockpit itself.
   *   none         a user-initiated load — a typed URL, a bookmark — which no
   *                other site caused.
   *
   * `same-site` is REFUSED, and that is the subtle one: a subdomain is
   * same-site and not same-origin, so accepting it would trust every host under
   * the registrable domain, including one an attacker got hold of. `cross-site`
   * is the attack itself.
   */
  if (input.fetchSite === 'same-origin' || input.fetchSite === 'none') return { ok: true };
  return { ok: false, refusal: 'NO_ORIGIN' };
}

/** Parse an `Origin` header to a bare origin, or null when there is not one. */
export function parseOrigin(value: string | undefined): string | null {
  // `'null'` is the literal string browsers send for an opaque origin (a
  // sandboxed iframe, a `data:` document). It is not an origin we match.
  if (value === undefined || value === '' || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * OBSERVE-MODE COUNTS, per reason.
 *
 * In memory and per process, which is the honest limit: a restart loses them
 * and two API replicas each hold their own. It is for reading the blast radius
 * before arming the brake, not an audit trail — the log line beside each
 * increment is what survives a restart. Exported so a test can read it and so
 * the health surface could, rather than being a closure nobody can see into.
 */
const observed = new Map<CsrfRefusal, number>();

export function csrfObserved(): Readonly<Record<CsrfRefusal, number>> {
  return {
    NO_ORIGIN: observed.get('NO_ORIGIN') ?? 0,
    FOREIGN_ORIGIN: observed.get('FOREIGN_ORIGIN') ?? 0,
  };
}

/** Test-only reset, so one test's counts cannot leak into the next. */
export function resetCsrfObserved(): void {
  observed.clear();
}

/**
 * The Express shell. It decides nothing — {@link csrfVerdict} does — and its
 * only jobs are reading the request, applying the mode, and refusing uniformly.
 */
export function csrfGuard(input: {
  readonly webOrigin: string | null;
  readonly log: (fields: Record<string, unknown>, message: string) => void;
  /** `Organization.securityControlModes`, when a caller has one to hand. */
  readonly storedModes?: unknown;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.actor;
    const verdict = csrfVerdict({
      method: req.method,
      /*
       * An actor with no `apiKeyId` authenticated with the session cookie. An
       * absent actor is an unauthenticated request: there is no credential for
       * another site to borrow, so a CSRF check adds nothing. Login CSRF —
       * forcing a victim to sign in AS THE ATTACKER — is a real but much milder
       * issue and is NOT addressed here; named rather than left to be noticed.
       */
      cookieAuthenticated: actor !== undefined && actor.apiKeyId === null,
      origin: req.get('origin'),
      fetchSite: req.get('sec-fetch-site'),
      webOrigin: input.webOrigin,
    });

    if (verdict.ok) {
      next();
      return;
    }

    const mode = controlMode('CSRF_TOKEN', input.storedModes ?? null);
    if (!controlEnforces(mode)) {
      observed.set(verdict.refusal, (observed.get(verdict.refusal) ?? 0) + 1);
      input.log(
        {
          control: 'CSRF_TOKEN',
          refusal: verdict.refusal,
          method: req.method,
          /*
           * The MOUNTED PREFIX, never the full path. A path carries ids and
           * occasionally a token, and this line goes to the install's logs.
           * `req.route` is not populated this early in the stack.
           */
          path: req.baseUrl === '' ? '/' : req.baseUrl,
          observed: observed.get(verdict.refusal),
        },
        'a cookie-authenticated mutating request would have been refused by the CSRF check',
      );
      next();
      return;
    }

    res.status(403).json({ error: { code: 'CSRF_REFUSED', message: CSRF_REFUSAL_MESSAGE } });
  };
}
