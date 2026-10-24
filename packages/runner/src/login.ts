/**
 * Performing a login and capturing the session (§2 auth profiles).
 *
 * Everything downstream — the crawler, every run — already reads a cached
 * `storageState` to get past a login wall. Nothing ever produced one, so auth
 * profiles were configuration for a step that never happened, and any app
 * behind a login was effectively untestable.
 *
 * Credentials are read from the vault by name and never appear in a profile, a
 * log, or a stored artifact. What is persisted is the resulting session state,
 * which is what a browser would hold anyway.
 *
 * ── Which identity, and the defect that answers ─────────────────────────────
 *
 * A run had exactly ONE storage state: the first auth profile on the
 * environment, applied to every test in the suite. A plan item can name an
 * `authProfileId` (see `planItemSchema`), so a suite legitimately contains an
 * admin test and a member test — and under one session at most one of them was
 * running as the role it claims. The other was testing somebody else's
 * permissions and could not know it.
 *
 * This module owns half of that fix: {@link signInWithProfile} turns a profile
 * row into a session whatever its kind, which is what lets a RUN sign a profile
 * in rather than hoping a cached one is lying around. The other half — which
 * role a test asked for and which one the run actually supplied — lives in
 * `run-workspace.ts` beside the workspace channel, because it is a property of
 * the run context rather than of logging in, and because the Playwright harness
 * needs to compare the two without loading a browser driver to do it.
 */

import { chromium } from 'playwright';
import { authProfileConfigSchema } from '@qaai/shared';
import type { AuthProfileKind } from '@qaai/shared';

export interface LoginResult {
  ok: boolean;
  /** Playwright storageState — cookies and origin storage. */
  storageState: unknown | null;
  /** Safe to show a user; never contains a credential. */
  message: string;
  /** How long the captured session should be trusted. */
  expiresAt: Date | null;
}

export interface FormLoginConfig {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  usernameSecretName: string;
  passwordSecretName: string;
  /** A locator that only exists once login succeeded — the actual assertion. */
  successSelector: string;
}

export interface CookieInjectionConfig {
  cookiesSecretName: string;
  domain: string;
}

export interface SsoTokenConfig {
  tokenSecretName: string;
  header: string;
  valueTemplate: string;
}

/** Sessions are re-captured well before a typical expiry rather than on failure. */
const SESSION_TTL_HOURS = 8;

function expiry(): Date {
  return new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
}

/**
 * Drive a real login form.
 *
 * The success check is a locator the customer nominates, not an HTTP status: a
 * failed login very often returns 200 with an error banner, and treating that
 * as success would cache a logged-out session and make every later test fail
 * for the wrong reason.
 */
export async function performFormLogin(
  config: FormLoginConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
): Promise<LoginResult> {
  const username = secrets[config.usernameSecretName];
  const password = secrets[config.passwordSecretName];

  if (!username || !password) {
    const missing = [
      !username ? config.usernameSecretName : null,
      !password ? config.passwordSecretName : null,
    ].filter(Boolean);
    return {
      ok: false,
      storageState: null,
      message: `Missing secret(s): ${missing.join(', ')}. Add them to this environment.`,
      expiresAt: null,
    };
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const url = /^https?:\/\//i.test(config.loginUrl)
      ? config.loginUrl
      : new URL(config.loginUrl, baseUrl).toString();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.fill(config.usernameSelector, username, { timeout: 15_000 });
    await page.fill(config.passwordSelector, password, { timeout: 15_000 });
    await page.click(config.submitSelector, { timeout: 15_000 });

    try {
      await page.waitForSelector(config.successSelector, { timeout: 20_000, state: 'visible' });
    } catch {
      // Report what the page says, not the credentials we sent.
      const title = await page.title().catch(() => '');
      return {
        ok: false,
        storageState: null,
        message:
          `Logged in but "${config.successSelector}" never appeared` +
          (title ? ` (page title: "${title}")` : '') +
          '. Either the credentials are wrong or the success locator is.',
        expiresAt: null,
      };
    }

    const storageState = await context.storageState();
    return {
      ok: true,
      storageState,
      message: `Signed in and captured the session (${storageState.cookies.length} cookie(s)).`,
      expiresAt: expiry(),
    };
  } catch (err) {
    return {
      ok: false,
      storageState: null,
      message: err instanceof Error ? err.message.slice(0, 300) : 'The login could not be driven',
      expiresAt: null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Cookie injection — no browser needed. The secret holds a JSON cookie array
 * exported from a real session.
 */
export function performCookieInjection(
  config: CookieInjectionConfig,
  secrets: Readonly<Record<string, string>>,
): LoginResult {
  const raw = secrets[config.cookiesSecretName];
  if (!raw) {
    return {
      ok: false,
      storageState: null,
      message: `Missing secret: ${config.cookiesSecretName}`,
      expiresAt: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const cookies = (Array.isArray(parsed) ? parsed : []).map((c) => ({
      ...(c as Record<string, unknown>),
      domain: (c as { domain?: string }).domain ?? config.domain,
      path: (c as { path?: string }).path ?? '/',
    }));
    if (cookies.length === 0) {
      return {
        ok: false,
        storageState: null,
        message: 'The secret parsed but contained no cookies.',
        expiresAt: null,
      };
    }
    return {
      ok: true,
      storageState: { cookies, origins: [] },
      message: `Injected ${cookies.length} cookie(s) for ${config.domain}.`,
      expiresAt: expiry(),
    };
  } catch {
    return {
      ok: false,
      storageState: null,
      message: `${config.cookiesSecretName} is not valid JSON — it should be a Playwright cookie array.`,
      expiresAt: null,
    };
  }
}

/**
 * An SSO bypass token is a header, not a session, so there is no storageState
 * to capture — it is validated for presence and reported honestly.
 */
export function performSsoToken(
  config: SsoTokenConfig,
  secrets: Readonly<Record<string, string>>,
): LoginResult {
  const token = secrets[config.tokenSecretName];
  if (!token) {
    return {
      ok: false,
      storageState: null,
      message: `Missing secret: ${config.tokenSecretName}`,
      expiresAt: null,
    };
  }
  return {
    ok: true,
    storageState: null,
    message: `Token present. It is sent as the ${config.header} header on every request.`,
    expiresAt: expiry(),
  };
}

// ─── One profile, one session ────────────────────────────────────────────────

/** The columns of an `AuthProfile` row a sign-in actually needs. */
export interface AuthProfileRef {
  id: string;
  name: string;
  kind: AuthProfileKind;
  /** Non-secret config; validated per kind before anything is driven. */
  config: unknown;
}

/**
 * Sign in as one profile, whatever its kind.
 *
 * The per-kind branch used to exist only in the API's "test this profile"
 * route, which is why a RUN could not log in at all — it had no way to turn a
 * profile row into a session and had to hope a cached one was lying around.
 * Keeping the branch next to the three functions it dispatches to means the
 * run and the "Sign in" button in the cockpit cannot drift about what a profile
 * of a given kind does.
 *
 * The config is re-validated rather than trusted: a profile may predate the
 * per-kind schema, and driving a browser with a half-formed config fails in a
 * way nobody can read. A kind QAAI cannot perform yet comes back `ok: false`
 * with the thing to use instead — never `ok: true` with no session, which is
 * how a logged-out browser gets handed to a test that needs a role.
 */
export async function signInWithProfile(
  profile: AuthProfileRef,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
): Promise<LoginResult> {
  const shape = authProfileConfigSchema[profile.kind];
  const parsed = shape.safeParse(profile.config);
  if (!parsed.success) {
    return {
      ok: false,
      storageState: null,
      message: `The "${profile.name}" ${profile.kind} profile is incomplete: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
      expiresAt: null,
    };
  }

  switch (profile.kind) {
    case 'FORM_LOGIN':
      return performFormLogin(parsed.data as FormLoginConfig, secrets, baseUrl);
    case 'COOKIE_INJECTION':
      return performCookieInjection(parsed.data as CookieInjectionConfig, secrets);
    case 'SSO_BYPASS_TOKEN':
      return performSsoToken(parsed.data as SsoTokenConfig, secrets);
    default:
      return {
        ok: false,
        storageState: null,
        message:
          `${profile.kind} needs the mail catcher / TOTP support that is not built yet, so ` +
          `"${profile.name}" cannot be signed in — use FORM_LOGIN, COOKIE_INJECTION or SSO_BYPASS_TOKEN.`,
        expiresAt: null,
      };
  }
}

