/**
 * Cloud browser grids (§6) — running a test on someone else's browser farm.
 *
 * Playwright connects to every one of these the same way: a websocket endpoint
 * carrying credentials and a capabilities blob. So "support BrowserStack" is not
 * a new runner, it is a different `connectOptions.wsEndpoint` in the generated
 * config — the tests, the assertions, and the reporting are untouched.
 *
 * The endpoint embeds the access key, which makes it secret-bearing: it is built
 * at run time from the vault, handed to the worker in memory, and never logged,
 * audited, or written into an exported repo.
 */

import type { GridIntegrationKind } from '@qaai/shared';

export interface GridCredentials {
  /**
   * The provider's account identifier. NOT a secret for any provider, and for
   * Perfecto it is the cloud/tenant name that forms the hostname — which is why
   * `maskGridEndpoint` keeps the host and redacts only the query string.
   */
  username: string;
  /** The actual credential. Never appears in a log, an audit row, or an export. */
  accessKey: string;
}

export interface GridCapabilities {
  /** e.g. 'Windows 11', 'OS X Sonoma'. Provider-specific strings. */
  os?: string;
  browser?: string;
  browserVersion?: string;
  /** Shown in the provider's dashboard so a run is traceable back to QAAI. */
  buildName?: string;
  projectName?: string;
  sessionName?: string;
}

/**
 * Playwright's CDP-over-websocket entry point for each provider.
 *
 * Each expects its capabilities as a URL-encoded JSON blob on the query string;
 * only the key names differ. Kept in one place so adding a provider is a data
 * change rather than a code change.
 */
export function gridWsEndpoint(
  kind: GridIntegrationKind,
  creds: GridCredentials,
  caps: GridCapabilities,
): string {
  switch (kind) {
    case 'BROWSERSTACK': {
      const caps_ = {
        'browserstack.username': creds.username,
        'browserstack.accessKey': creds.accessKey,
        os: caps.os ?? 'Windows',
        os_version: '11',
        browser: caps.browser ?? 'chrome',
        browser_version: caps.browserVersion ?? 'latest',
        buildName: caps.buildName ?? 'QAAI',
        projectName: caps.projectName ?? 'QAAI',
        sessionName: caps.sessionName ?? 'QAAI run',
      };
      const q = encodeURIComponent(JSON.stringify(caps_));
      return `wss://cdp.browserstack.com/playwright?caps=${q}`;
    }
    case 'SAUCE_LABS': {
      const caps_ = {
        username: creds.username,
        accessKey: creds.accessKey,
        browserName: caps.browser ?? 'chrome',
        browserVersion: caps.browserVersion ?? 'latest',
        platformName: caps.os ?? 'Windows 11',
        'sauce:options': { build: caps.buildName ?? 'QAAI', name: caps.sessionName ?? 'QAAI run' },
      };
      const q = encodeURIComponent(JSON.stringify(caps_));
      return `wss://ondemand.saucelabs.com/playwright?caps=${q}`;
    }
    case 'LAMBDATEST': {
      const caps_ = {
        browserName: caps.browser ?? 'Chrome',
        browserVersion: caps.browserVersion ?? 'latest',
        'LT:Options': {
          platform: caps.os ?? 'Windows 11',
          build: caps.buildName ?? 'QAAI',
          name: caps.sessionName ?? 'QAAI run',
          user: creds.username,
          accessKey: creds.accessKey,
        },
      };
      const q = encodeURIComponent(JSON.stringify(caps_));
      return `wss://cdp.lambdatest.com/playwright?capabilities=${q}`;
    }
    case 'PERFECTO': {
      const caps_ = {
        securityToken: creds.accessKey,
        platformName: caps.os ?? 'Windows',
        browserName: caps.browser ?? 'Chrome',
        browserVersion: caps.browserVersion ?? 'latest',
      };
      const q = encodeURIComponent(JSON.stringify(caps_));
      // The cloud host is the customer's own subdomain, held as the username.
      return `wss://${creds.username}.perfectomobile.com/nexperience/playwright?caps=${q}`;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported grid ${String(exhaustive)}`);
    }
  }
}

/** Redacts the credential blob so an endpoint can appear in a log or an error. */
export function maskGridEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}?caps=[redacted]`;
  } catch {
    return '[grid endpoint]';
  }
}
