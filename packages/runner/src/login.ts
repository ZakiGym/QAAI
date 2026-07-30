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
 */

import { chromium } from 'playwright';

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
