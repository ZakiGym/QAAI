/**
 * Security smoke plugin (§4).
 *
 * This is a smoke test, not a pentest — the spec says to label it that way and
 * the UI does. Four checks, each chosen because it is cheap, deterministic, and
 * catches a class of mistake that ships regularly:
 *
 *   1. auth-wall     — a page that should require login is served logged out
 *   2. idor          — an id in the URL can be swapped for another user's
 *   3. headers       — missing baseline security response headers
 *   4. cookie-flags  — session cookies without HttpOnly / SameSite / Secure
 *
 * Every probe is a plain unauthenticated GET. Nothing here mutates state, and
 * the IDOR probe only walks ids the caller explicitly listed.
 */

import type {
  ExecutableTest,
  Finding,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

interface SecuritySpec {
  /** Paths that must NOT be reachable without a session. */
  authRequiredPaths?: string[];
  /**
   * IDOR probes. `template` contains `{id}`; each id is fetched anonymously and
   * a 2xx with `mustNotContain` present in the body is reported.
   */
  idorProbes?: Array<{ template: string; ids: string[]; mustNotContain?: string }>;
  /** Paths whose response headers and cookies are inspected. */
  headerPaths?: string[];
}

/** Headers we expect on any page a browser renders. */
const EXPECTED_HEADERS: Array<{ name: string; why: string; severity: Finding['severity'] }> = [
  { name: 'x-content-type-options', why: 'allows MIME sniffing', severity: 'MODERATE' },
  { name: 'x-frame-options', why: 'page can be framed (clickjacking)', severity: 'MODERATE' },
  { name: 'content-security-policy', why: 'no CSP to limit injected script', severity: 'SERIOUS' },
  { name: 'strict-transport-security', why: 'no HSTS', severity: 'MODERATE' },
  { name: 'referrer-policy', why: 'full URLs leak to third parties', severity: 'MINOR' },
];

function parseSpec(test: ExecutableTest): SecuritySpec {
  const spec = (test.spec ?? {}) as SecuritySpec;
  const total =
    (spec.authRequiredPaths?.length ?? 0) +
    (spec.idorProbes?.length ?? 0) +
    (spec.headerPaths?.length ?? 0);
  if (total === 0) {
    throw new Error(`Security test "${test.name}" defines no checks`);
  }
  return spec;
}

/** A 2xx on a protected path means it was served; 3xx to a login page is correct. */
function isReachable(status: number): boolean {
  return status >= 200 && status < 300;
}

export const securitySmokePlugin: RunnerPlugin = {
  type: 'SECURITY_SMOKE',

  validate(test: ExecutableTest): void {
    parseSpec(test);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = parseSpec(test);
    const startedAt = Date.now();
    const steps: StepResult[] = [];
    const network: NetworkEntry[] = [];
    const findings: Finding[] = [];
    let index = 0;

    const probe = async (
      path: string,
    ): Promise<{ status: number; body: string; headers: Headers } | null> => {
      const url = new URL(path, ctx.baseUrl).toString();
      const started = Date.now();
      try {
        // No credentials, no redirect following — we want to see the raw answer
        // the server gives an anonymous caller.
        const response = await fetch(url, {
          redirect: 'manual',
          signal: ctx.signal,
          headers: { 'user-agent': 'QAAI-security-smoke' },
        });
        const body = await response.text();
        network.push({
          method: 'GET',
          url,
          status: response.status,
          durationMs: Date.now() - started,
          responseBodySnippet: null,
        });
        return { status: response.status, body, headers: response.headers };
      } catch {
        network.push({
          method: 'GET',
          url,
          status: null,
          durationMs: Date.now() - started,
          responseBodySnippet: null,
        });
        return null;
      }
    };

    const record = (title: string, failed: boolean, detail: string | null, started: number) => {
      ctx.logger.step({
        testId: test.id,
        index,
        title,
        status: failed ? 'FAILED' : 'PASSED',
      });
      steps.push({
        index: index++,
        title,
        status: failed ? 'FAILED' : 'PASSED',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        screenshotKey: null,
        error: failed
          ? { message: detail ?? title, stack: null, selector: null, expected: null, actual: null }
          : null,
      });
    };

    // 1. Auth wall
    for (const path of spec.authRequiredPaths ?? []) {
      const started = Date.now();
      const result = await probe(path);
      const leaked = result !== null && isReachable(result.status);
      if (leaked) {
        findings.push({
          kind: 'SECURITY',
          severity: 'CRITICAL',
          code: 'auth-wall-bypass',
          message: `${path} returned ${result.status} to an unauthenticated request; it should redirect to sign-in or return 401/403`,
          location: path,
          helpUrl: null,
        });
      }
      record(
        `Auth required: ${path}`,
        leaked,
        leaked ? `Served ${result!.status} without a session` : null,
        started,
      );
    }

    // 2. IDOR
    for (const idor of spec.idorProbes ?? []) {
      for (const id of idor.ids) {
        const started = Date.now();
        const path = idor.template.replace('{id}', encodeURIComponent(id));
        const result = await probe(path);
        const exposed =
          result !== null &&
          isReachable(result.status) &&
          (idor.mustNotContain ? result.body.includes(idor.mustNotContain) : true);

        if (exposed) {
          findings.push({
            kind: 'SECURITY',
            severity: 'SERIOUS',
            code: 'idor',
            message:
              `${path} returned ${result.status} to an anonymous caller` +
              (idor.mustNotContain
                ? `, and the body contained "${idor.mustNotContain}" — another user's record is readable by guessing the id`
                : ' — object ids appear not to be ownership-checked'),
            location: path,
            helpUrl: null,
          });
        }
        record(
          `IDOR probe: ${path}`,
          exposed,
          exposed ? 'Object readable anonymously' : null,
          started,
        );
      }
    }

    // 3 & 4. Headers and cookie flags
    for (const path of spec.headerPaths ?? []) {
      const started = Date.now();
      const result = await probe(path);
      const problems: string[] = [];

      if (result) {
        for (const expected of EXPECTED_HEADERS) {
          if (!result.headers.get(expected.name)) {
            problems.push(`missing ${expected.name}`);
            findings.push({
              kind: 'SECURITY',
              severity: expected.severity,
              code: `missing-header-${expected.name}`,
              message: `${path} does not send ${expected.name} — ${expected.why}`,
              location: path,
              helpUrl: null,
            });
          }
        }

        // `getSetCookie` keeps multiple Set-Cookie headers separate, which a
        // plain `get()` would join into one unparseable string.
        for (const cookie of result.headers.getSetCookie?.() ?? []) {
          const name = cookie.split('=')[0]?.trim() ?? 'cookie';
          const lower = cookie.toLowerCase();
          const missing = [
            !lower.includes('httponly') && 'HttpOnly',
            !lower.includes('samesite') && 'SameSite',
            !lower.includes('secure') && 'Secure',
          ].filter(Boolean) as string[];

          if (missing.length > 0) {
            problems.push(`${name} missing ${missing.join('/')}`);
            findings.push({
              kind: 'SECURITY',
              // Secure alone is expected to be absent over plain http in local
              // and preview environments, so it alone is not worth a SERIOUS.
              severity: missing.includes('HttpOnly') ? 'SERIOUS' : 'MINOR',
              code: 'weak-cookie-flags',
              message: `Cookie "${name}" set by ${path} is missing ${missing.join(', ')}`,
              location: path,
              helpUrl: null,
            });
          }
        }
      } else {
        problems.push('request failed');
      }

      record(
        `Headers and cookies: ${path}`,
        problems.length > 0,
        problems.length > 0 ? problems.join('; ') : null,
        started,
      );
    }

    const blocking = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'SERIOUS');

    return {
      testId: test.id,
      status: blocking.length > 0 ? 'FAILED' : 'PASSED',
      durationMs: Date.now() - startedAt,
      steps,
      network,
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: blocking.length
        ? `${blocking.length} security finding(s): ${[...new Set(blocking.map((f) => f.code))].join(', ')}`
        : null,
      retriedAndPassed: false,
      findings,
    };
  },
};
