/**
 * Mobile plugin tests.
 *
 * No device, emulator or simulator exists on this machine, and none is needed
 * for any of this. Three techniques cover everything that is not the device
 * itself:
 *
 *  1. **A real Appium server on a real socket.** The W3C protocol is JSON over
 *     HTTP, so a `node:http` server that answers like Appium exercises the whole
 *     driver — session creation, locator payloads, the actions gesture, the
 *     status mapping, session teardown — over a genuine connection. Same choice
 *     protocol.test.ts makes, for the same reason: a mocked transport would only
 *     prove that the mock was called.
 *  2. **Stub CLIs on PATH.** `maestro`, `gradle` and `xcodebuild` are shell
 *     scripts here that record their argv and print captured output. They cover
 *     this plugin's half of the contract — the command line it builds and the
 *     output it reads back — and nothing about a real device, which is the part
 *     that cannot run here anyway.
 *  3. **Pure functions, called directly.** Capability building, host pinning,
 *     protocol-dialect mapping and every environment-gap classifier.
 *
 * The skip paths get the most attention on purpose. "No device attached" is the
 * normal state of a CI worker, and reporting that as a failing app is the one
 * bug this plugin exists to avoid.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK, appiumMobileSpecSchema } from '@qaai/shared';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import {
  W3C_ELEMENT_KEY,
  appiumServerBase,
  buildCapabilities,
  classifySessionFailure,
  deviceFarmHub,
  elementIdOf,
  environmentGap,
  mergeReports,
  missingCapabilityHint,
  mobilePlugin,
  parseXcodebuildTests,
  sessionIdOf,
  webdriverErrorOf,
} from './mobile.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

/** A 1×1 transparent PNG, so a screenshot round-trip carries real bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Put {
  name: string;
  contentType: string;
  bytes: number;
}

function makeTest(spec: unknown, name = 'checkout on a phone'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    type: 'MOBILE',
    code: '',
    filePath: 'mobile/checkout.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

function makeCtx(
  secrets: Record<string, string> = {},
): RunContext & { puts: Put[]; logged: string[] } {
  const puts: Put[] = [];
  const logged: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://localhost:3000',
    secrets,
    storageState: null,
    artifacts: {
      put: async (name, body, contentType) => {
        puts.push({ name, contentType, bytes: body.byteLength });
        return `artifacts/${name}`;
      },
      putFile: async () => 'key',
      get: async () => null,
      putPersistent: async () => 'key',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: (event) => logged.push(`${event.status} ${event.title}`),
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    puts,
    logged,
  };
}

/** Titles + statuses, which is what the cockpit renders. */
function outline(execution: TestExecution): string[] {
  return execution.steps.map((step) => `${step.status} ${step.title}`);
}

// ─── A fake Appium server ────────────────────────────────────────────────────

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface Reply {
  status?: number;
  body: unknown;
}

interface FakeAppium {
  url: string;
  seen: Seen[];
  /** The last body sent to `path`, for asserting on request shaping. */
  bodyFor(method: string, path: string): Record<string, unknown> | undefined;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
    ),
  );
});

/** `{ value }`, which is how W3C wraps every successful result. */
function ok(value: unknown): Reply {
  return { status: 200, body: { value } };
}

/** A W3C error: a 4xx/5xx with the code and message inside `value`. */
function wdError(error: string, message: string, status = 404): Reply {
  return { status, body: { value: { error, message, stacktrace: '' } } };
}

async function fakeAppium(handler: (seen: Seen) => Reply | undefined): Promise<FakeAppium> {
  const seen: Seen[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = {};
      }
      const entry: Seen = { method: req.method ?? 'GET', path: req.url ?? '/', body };
      seen.push(entry);

      const reply = handler(entry) ?? wdError('unknown command', `no route for ${entry.path}`);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    bodyFor: (method, path) =>
      seen.filter((entry) => entry.method === method && entry.path === path).at(-1)?.body,
  };
}

/**
 * The routes a session needs to exist at all. A test overrides what it cares
 * about and inherits the rest, so each one reads as the thing it is testing.
 */
function baseRoutes(seen: Seen): Reply | undefined {
  if (seen.method === 'POST' && seen.path === '/session') {
    return ok({ sessionId: 's1', capabilities: { platformName: 'Android' } });
  }
  if (seen.method === 'DELETE' && seen.path === '/session/s1') return ok(null);
  if (seen.method === 'POST' && seen.path === '/session/s1/element') {
    return ok({ [W3C_ELEMENT_KEY]: 'e1' });
  }
  if (seen.method === 'GET' && seen.path === '/session/s1/screenshot') return ok(PNG_BASE64);
  return undefined;
}

/** A minimal spec that starts a session: one device capability, one app. */
function appiumSpec(serverUrl: string, steps: unknown[], extra: Record<string, unknown> = {}) {
  return {
    driver: 'APPIUM',
    platform: 'ANDROID',
    serverUrl,
    capabilities: { deviceName: 'Pixel 7', app: '/tmp/app.apk' },
    steps,
    ...extra,
  };
}

// ─── Protocol dialect mapping ────────────────────────────────────────────────

describe('reading a WebDriver response', () => {
  it('takes the element id from either protocol dialect', () => {
    expect(elementIdOf({ [W3C_ELEMENT_KEY]: 'e-42' })).toBe('e-42');
    // Appium 1 and a few farm proxies still answer in the old shape.
    expect(elementIdOf({ ELEMENT: 'e-7' })).toBe('e-7');
    expect(elementIdOf({ somethingElse: 'e-7' })).toBeNull();
    expect(elementIdOf(null)).toBeNull();
  });

  it('takes the session id from either protocol dialect', () => {
    expect(sessionIdOf({ value: { sessionId: 'abc', capabilities: {} } })).toBe('abc');
    expect(sessionIdOf({ sessionId: 'legacy', value: { platformName: 'iOS' } })).toBe('legacy');
    // A proxy that answers 200 with no session is not a session.
    expect(sessionIdOf({ value: { capabilities: {} } })).toBeNull();
  });

  it('reads W3C errors, JSONWP statuses, and a bare HTTP failure', () => {
    expect(webdriverErrorOf(404, { value: { error: 'no such element', message: 'gone' } })).toEqual(
      {
        error: 'no such element',
        message: 'gone',
      },
    );
    expect(webdriverErrorOf(200, { status: 7, value: { message: 'element not found' } })).toEqual({
      error: 'status 7',
      message: 'element not found',
    });
    expect(webdriverErrorOf(502, { value: null })?.error).toBe('http 502');
    expect(webdriverErrorOf(200, { value: { text: 'fine' } })).toBeNull();
  });
});

// ─── Capabilities ────────────────────────────────────────────────────────────

describe('buildCapabilities', () => {
  const parse = (spec: Record<string, unknown>) =>
    appiumMobileSpecSchema.parse({
      driver: 'APPIUM',
      platform: 'ANDROID',
      steps: [{ action: 'PRESS_BACK', name: 'back' }],
      ...spec,
    });

  it('prefixes vendor capabilities and leaves standard and already-prefixed ones alone', () => {
    const caps = buildCapabilities(
      parse({
        capabilities: {
          deviceName: 'Pixel 7',
          'appium:automationName': 'UiAutomator2',
          browserName: 'Chrome',
        },
        app: '/builds/app.apk',
      }),
      {},
      null,
    );

    // The unprefixed vendor capability is the classic reason a W3C session is
    // refused outright, so it is fixed rather than forwarded.
    expect(caps['appium:deviceName']).toBe('Pixel 7');
    expect(caps['appium:automationName']).toBe('UiAutomator2');
    expect(caps.browserName).toBe('Chrome');
    expect(caps.deviceName).toBeUndefined();
    expect(caps.platformName).toBe('Android');
    expect(caps['appium:app']).toBe('/builds/app.apk');
  });

  it('interpolates {{NAME}} in capability values from the vault', () => {
    const caps = buildCapabilities(
      parse({ capabilities: { deviceName: 'Pixel 7', app: 'bs://{{APP_ID}}' } }),
      { APP_ID: 'deadbeef' },
      null,
    );
    expect(caps['appium:app']).toBe('bs://deadbeef');
  });

  it('puts BrowserStack credentials in the capabilities, merged with the spec’s options', () => {
    const caps = buildCapabilities(
      parse({
        capabilities: {
          deviceName: 'Pixel 7',
          app: 'bs://x',
          'bstack:options': { osVersion: '13' },
        },
      }),
      {},
      {
        config: {
          provider: 'BROWSERSTACK',
          usernameSecretName: 'DEVICE_FARM_USERNAME',
          accessKeySecretName: 'DEVICE_FARM_ACCESS_KEY',
          buildName: 'nightly',
          projectName: 'QAAI',
        },
        credentials: { username: 'acme_user', accessKey: 'key-123456' },
      },
    );

    expect(caps['bstack:options']).toEqual({
      osVersion: '13',
      userName: 'acme_user',
      accessKey: 'key-123456',
      buildName: 'nightly',
      projectName: 'QAAI',
    });
  });

  it('uses each other provider’s own options key', () => {
    const farm = (provider: 'SAUCE_LABS' | 'LAMBDATEST' | 'PERFECTO') => ({
      config: {
        provider,
        usernameSecretName: 'DEVICE_FARM_USERNAME',
        accessKeySecretName: 'DEVICE_FARM_ACCESS_KEY',
        buildName: 'QAAI',
        projectName: 'QAAI',
      },
      credentials: { username: 'acme', accessKey: 'key-123456' },
    });
    const base = { capabilities: { deviceName: 'Pixel 7', app: 'x' } };

    expect(buildCapabilities(parse(base), {}, farm('SAUCE_LABS'))['sauce:options']).toMatchObject({
      username: 'acme',
      accessKey: 'key-123456',
    });
    expect(buildCapabilities(parse(base), {}, farm('LAMBDATEST'))['lt:options']).toMatchObject({
      user: 'acme',
      accessKey: 'key-123456',
    });
    // Perfecto authenticates with the token alone — the username is its hostname.
    expect(buildCapabilities(parse(base), {}, farm('PERFECTO'))['perfecto:options']).toEqual({
      securityToken: 'key-123456',
    });
  });
});

describe('missingCapabilityHint', () => {
  it('passes capabilities that name a device and an app', () => {
    expect(
      missingCapabilityHint({ 'appium:deviceName': 'Pixel 7', 'appium:app': '/a.apk' }),
    ).toBeNull();
    // A farm puts the device inside its own options blob.
    expect(
      missingCapabilityHint({
        'appium:app': 'bs://x',
        'bstack:options': { deviceName: 'Google Pixel 7' },
      }),
    ).toBeNull();
  });

  it('names exactly what is missing', () => {
    expect(missingCapabilityHint({ 'appium:app': '/a.apk' })).toContain('appium:deviceName');
    expect(missingCapabilityHint({ 'appium:deviceName': 'Pixel 7' })).toContain('appium:app');
    const both = missingCapabilityHint({ platformName: 'Android' });
    expect(both).toContain('appium:deviceName');
    expect(both).toContain('appium:app');
  });
});

// ─── Host pinning ────────────────────────────────────────────────────────────

describe('deviceFarmHub', () => {
  it('pins each provider to its own hub', () => {
    expect(deviceFarmHub('BROWSERSTACK', 'acme')).toBe('https://hub-cloud.browserstack.com/wd/hub');
    expect(deviceFarmHub('SAUCE_LABS', 'acme')).toContain('saucelabs.com');
    expect(deviceFarmHub('LAMBDATEST', 'acme')).toContain('lambdatest.com');
  });

  it('builds Perfecto’s per-customer host from the cloud name', () => {
    expect(deviceFarmHub('PERFECTO', 'acme')).toBe(
      'https://acme.perfectomobile.com/nexperience/perfectomobile/wd/hub',
    );
  });

  it('refuses a cloud name that would move the endpoint off the pinned domain', () => {
    // Each of these would send the security token somewhere else entirely.
    for (const hostile of ['acme.evil.com', 'evil.com/', 'a@b', 'acme:8080', '', '../acme']) {
      expect(() => deviceFarmHub('PERFECTO', hostile)).toThrow(/valid Perfecto cloud name/);
    }
  });
});

describe('appiumServerBase', () => {
  it('normalises a server URL', () => {
    expect(appiumServerBase('http://127.0.0.1:4723/')).toBe('http://127.0.0.1:4723');
    expect(appiumServerBase('https://appium.internal/wd/hub/')).toBe(
      'https://appium.internal/wd/hub',
    );
  });

  it('refuses credentials in the URL, which is how an access key gets committed', () => {
    expect(() => appiumServerBase('https://user:key@hub.example.com/wd/hub')).toThrow(
      /Remove the credentials/,
    );
  });

  it('refuses a non-http scheme and a non-URL', () => {
    expect(() => appiumServerBase('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => appiumServerBase('not a url')).toThrow(/not a valid Appium server URL/);
  });
});

// ─── Session failure classification ──────────────────────────────────────────

describe('classifySessionFailure', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['session not created', 'Could not find a connected Android device in 20000ms', /adb devices/],
    [
      'session not created',
      'Unable to find an active device or simulator with UDID 1234',
      /xcrun simctl/,
    ],
    [
      'session not created',
      "Could not find a driver for automationName 'UiAutomator2'",
      /appium driver install/,
    ],
    [
      'session not created',
      "The application at '/builds/app.apk' does not exist or is not accessible",
      /Build or download it/,
    ],
    [
      'invalid argument',
      'The following required capabilities were not provided: platformVersion',
      /capabilities/,
    ],
    ['session not created', 'Unauthorized: invalid username or access key', /device farm rejected/],
  ];

  it.each(cases)('skips rather than fails on %s: %s', (error, message, expected) => {
    const verdict = classifySessionFailure({ error, message });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.message).toMatch(expected);
    // The server's own words are kept, so the reader can confirm the diagnosis.
    expect(verdict.message).toContain(message.slice(0, 20));
  });

  it('fails when the app itself is implicated, rather than guessing', () => {
    const verdict = classifySessionFailure({
      error: 'session not created',
      message: 'An unknown server-side error occurred: the app crashed during launch',
    });
    expect(verdict.status).toBe('FAILED');
    expect(verdict.message).toContain('crashed during launch');
  });
});

// ─── Environment gaps in CLI output ──────────────────────────────────────────

describe('environmentGap', () => {
  it('recognises a missing device for every CLI driver', () => {
    expect(environmentGap('MAESTRO', 'Error: No devices found')).toMatch(/emulator -avd/);
    expect(environmentGap('DETOX', 'Error: Could not find a device by type = "iPhone 15"')).toMatch(
      /applesimutils/,
    );
    expect(
      environmentGap(
        'ESPRESSO',
        'com.android.builder.testing.api.DeviceException: No connected devices!',
      ),
    ).toMatch(/adb devices/);
    expect(
      environmentGap('XCUITEST', 'xcodebuild: error: Unable to find a destination matching…'),
    ).toMatch(/xcrun simctl list devices/);
  });

  it('recognises the other setup gaps each tool reports', () => {
    expect(
      environmentGap('DETOX', 'Failed to run: cannot find app binary at ios/build/App.app'),
    ).toMatch(/detox build/);
    expect(environmentGap('ESPRESSO', 'SDK location not found. Define ANDROID_HOME')).toMatch(
      /ANDROID_HOME/,
    );
    expect(
      environmentGap('XCUITEST', "xcode-select: error: tool 'xcodebuild' requires Xcode"),
    ).toMatch(/xcode-select/);
  });

  it('says nothing about output that describes a real test failure', () => {
    expect(
      environmentGap('ESPRESSO', 'com.acme.CheckoutTest > applePay FAILED\n2 tests, 1 failure'),
    ).toBeNull();
    expect(
      environmentGap('MAESTRO', '[Failed] tapping on "Buy now" did not change the screen'),
    ).toBeNull();
  });
});

// ─── xcodebuild output ───────────────────────────────────────────────────────

describe('parseXcodebuildTests', () => {
  it('reads both name shapes, the duration, and the assertion that failed', () => {
    const tests = parseXcodebuildTests(
      [
        'Test Suite CheckoutUITests started',
        "Test Case '-[CheckoutUITests testAddToCart]' passed (3.412 seconds).",
        '/repo/CheckoutUITests.swift:42: error: -[CheckoutUITests testApplePay] : XCTAssertEqual failed: ("2") is not equal to ("1")',
        "Test Case 'CheckoutUITests.testApplePay()' failed (1.002 seconds).",
        "Test Case '-[CheckoutUITests testGiftCard]' skipped (0.001 seconds).",
      ].join('\n'),
    );

    expect(tests.map((t) => `${t.status} ${t.suite}.${t.name}`)).toEqual([
      'passed CheckoutUITests.testAddToCart',
      'failed CheckoutUITests.testApplePay',
      'skipped CheckoutUITests.testGiftCard',
    ]);
    expect(tests[0]?.durationMs).toBe(3412);
    expect(tests[1]?.failureMessage).toContain('XCTAssertEqual failed');
  });

  it('reads nothing out of output that has no test cases', () => {
    expect(
      parseXcodebuildTests('** BUILD FAILED **\nThe following build commands failed:'),
    ).toEqual([]);
  });
});

describe('mergeReports', () => {
  it('sums the per-device reports a multi-device run writes', () => {
    const one = mergeReports([
      {
        format: 'junit-xml',
        presence: 'ok',
        suiteName: 'pixel',
        tests: [
          {
            suite: 'a',
            name: 'one',
            status: 'passed',
            durationMs: 10,
            failureMessage: null,
            stack: null,
          },
        ],
        totals: { tests: 1, passed: 1, failed: 0, skipped: 0, durationMs: 10 },
        truncated: false,
        diagnostics: [],
      },
      {
        format: 'junit-xml',
        presence: 'ok',
        suiteName: 'nexus',
        tests: [
          {
            suite: 'a',
            name: 'two',
            status: 'failed',
            durationMs: 5,
            failureMessage: 'boom',
            stack: null,
          },
        ],
        totals: { tests: 1, passed: 0, failed: 1, skipped: 0, durationMs: 5 },
        truncated: false,
        diagnostics: [],
      },
    ]);

    expect(one.totals).toEqual({ tests: 2, passed: 1, failed: 1, skipped: 0, durationMs: 15 });
  });
});

// ─── validate() ──────────────────────────────────────────────────────────────

describe('mobile plugin — validate', () => {
  it('names the five drivers when the discriminator is wrong', () => {
    expect(() => mobilePlugin.validate(makeTest({ driver: 'ROBOTIUM' }))).toThrow(
      /must set "driver" to one of APPIUM, MAESTRO, DETOX, ESPRESSO, XCUITEST/,
    );
    expect(() => mobilePlugin.validate(makeTest({}))).toThrow(/must set "driver"/);
  });

  it('rejects a device farm and a self-hosted server at once', () => {
    expect(() =>
      mobilePlugin.validate(
        makeTest({
          driver: 'APPIUM',
          platform: 'IOS',
          serverUrl: 'http://127.0.0.1:4723',
          deviceFarm: { provider: 'BROWSERSTACK' },
          steps: [{ action: 'PRESS_BACK', name: 'back' }],
        }),
      ),
    ).toThrow(/serverUrl/);
  });

  it('rejects an xcodebuild spec that names both a project and a workspace', () => {
    expect(() =>
      mobilePlugin.validate(
        makeTest({
          driver: 'XCUITEST',
          scheme: 'App',
          project: 'App.xcodeproj',
          workspace: 'App.xcworkspace',
        }),
      ),
    ).toThrow(/not both/);
  });

  it('accepts a spec that is actually runnable', () => {
    expect(() =>
      mobilePlugin.validate(
        makeTest(
          appiumSpec('http://127.0.0.1:4723', [
            { action: 'TAP', name: 'buy', selector: { value: 'buy-now' } },
          ]),
        ),
      ),
    ).not.toThrow();
  });
});

// ─── Appium, against a real socket ───────────────────────────────────────────

describe('mobile plugin — APPIUM', () => {
  it('drives a session end to end and always closes it', async () => {
    const server = await fakeAppium((seen) => {
      const base = baseRoutes(seen);
      if (base) return base;
      if (seen.method === 'POST' && seen.path === '/session/s1/element/e1/click') return ok(null);
      if (seen.method === 'POST' && seen.path === '/session/s1/element/e1/clear') return ok(null);
      if (seen.method === 'POST' && seen.path === '/session/s1/element/e1/value') return ok(null);
      if (seen.method === 'GET' && seen.path === '/session/s1/element/e1/text') {
        return ok('Order confirmed');
      }
      return undefined;
    });

    const ctx = makeCtx({ CHECKOUT_PIN: 'pin-987654' });
    const execution = await mobilePlugin.execute(
      ctx,
      makeTest(
        appiumSpec(server.url, [
          { action: 'TAP', name: 'buy now', selector: { value: 'buy-now' } },
          {
            action: 'TYPE',
            name: 'enter the pin',
            selector: { using: 'id', value: 'pin' },
            text: '{{CHECKOUT_PIN}}',
          },
          {
            action: 'ASSERT_TEXT',
            name: 'confirmation',
            selector: { value: 'status' },
            equals: 'Order confirmed',
          },
          { action: 'SCREENSHOT', name: 'receipt' },
        ]),
      ),
    );

    expect(execution.status).toBe('PASSED');
    expect(outline(execution)).toEqual([
      'PASSED Start the ANDROID session',
      'PASSED buy now — tap accessibility id=buy-now',
      'PASSED enter the pin — type into id=pin',
      'PASSED confirmation — text of accessibility id=status',
      'PASSED receipt — screenshot',
    ]);

    // The screenshot became an artifact, and the step points at it.
    expect(ctx.puts).toEqual([{ name: 'mobile-receipt.png', contentType: 'image/png', bytes: 70 }]);
    expect(execution.steps.at(-1)?.screenshotKey).toBe('artifacts/mobile-receipt.png');

    // Request shaping: the W3C capabilities envelope, the locator payload, and
    // both spellings of the text field older drivers disagree about.
    expect(server.bodyFor('POST', '/session')).toEqual({
      capabilities: {
        alwaysMatch: {
          platformName: 'Android',
          'appium:deviceName': 'Pixel 7',
          'appium:app': '/tmp/app.apk',
        },
        firstMatch: [{}],
      },
    });
    expect(server.seen.filter((s) => s.path === '/session/s1/element').map((s) => s.body)).toEqual([
      { using: 'accessibility id', value: 'buy-now' },
      { using: 'id', value: 'pin' },
      { using: 'accessibility id', value: 'status' },
    ]);
    expect(server.bodyFor('POST', '/session/s1/element/e1/value')).toEqual({
      text: 'pin-987654',
      value: [...'pin-987654'],
    });

    // The session is a real device slot; it is never left open.
    expect(server.seen.some((s) => s.method === 'DELETE' && s.path === '/session/s1')).toBe(true);
  });

  it('speaks the older dialect a farm proxy may answer in', async () => {
    const server = await fakeAppium((seen) => {
      if (seen.method === 'POST' && seen.path === '/session') {
        return { status: 200, body: { sessionId: 'legacy1', value: { platformName: 'Android' } } };
      }
      if (seen.method === 'POST' && seen.path === '/session/legacy1/element') {
        return { status: 200, body: { status: 0, value: { ELEMENT: '17' } } };
      }
      if (seen.method === 'POST' && seen.path === '/session/legacy1/element/17/click') {
        return ok(null);
      }
      if (seen.method === 'DELETE' && seen.path === '/session/legacy1') return ok(null);
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec(server.url, [{ action: 'TAP', name: 'buy', selector: { value: 'buy-now' } }]),
      ),
    );

    expect(execution.status).toBe('PASSED');
  });

  it('fails the assertion that broke, skips the rest, and screenshots the moment', async () => {
    const server = await fakeAppium((seen) => {
      const base = baseRoutes(seen);
      if (base) return base;
      if (seen.method === 'GET' && seen.path === '/session/s1/element/e1/text') {
        return ok('Payment declined');
      }
      if (seen.method === 'POST' && seen.path === '/session/s1/element/e1/click') return ok(null);
      return undefined;
    });

    const ctx = makeCtx();
    const execution = await mobilePlugin.execute(
      ctx,
      makeTest(
        appiumSpec(server.url, [
          {
            action: 'ASSERT_TEXT',
            name: 'confirmation',
            selector: { value: 'status' },
            equals: 'Order confirmed',
          },
          { action: 'TAP', name: 'view receipt', selector: { value: 'receipt' } },
        ]),
      ),
    );

    expect(execution.status).toBe('FAILED');
    const failed = execution.steps[1];
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.expected).toBe('Order confirmed');
    expect(failed?.error?.actual).toBe('Payment declined');
    // The screen at the moment of failure, captured before the session ends.
    expect(failed?.screenshotKey).toBe('artifacts/mobile-failure-1.png');
    // Everything after a failed step measures an unknown screen.
    expect(execution.steps[2]?.status).toBe('SKIPPED');
    expect(execution.steps[2]?.title).toContain('unknown screen');
    expect(server.seen.some((s) => s.method === 'DELETE')).toBe(true);
  });

  it('reports an element that never appears as a failure naming the locator', async () => {
    const server = await fakeAppium((seen) => {
      if (seen.method === 'POST' && seen.path === '/session') {
        return ok({ sessionId: 's1', capabilities: {} });
      }
      if (seen.method === 'POST' && seen.path === '/session/s1/element') {
        return wdError('no such element', 'An element could not be located on the page');
      }
      if (seen.method === 'DELETE' && seen.path === '/session/s1') return ok(null);
      if (seen.method === 'GET' && seen.path === '/session/s1/screenshot') return ok(PNG_BASE64);
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec(server.url, [
          {
            action: 'TAP',
            name: 'buy now',
            selector: { using: 'xpath', value: '//button[@id="buy"]' },
            timeoutMs: 400,
          },
        ]),
      ),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('//button[@id="buy"]');
    expect(execution.errorMessage).toContain('400ms');
    // It kept looking rather than giving up on the first miss.
    expect(server.seen.filter((s) => s.path === '/session/s1/element').length).toBeGreaterThan(1);
  });

  it('converts a swipe into W3C pointer actions in device pixels', async () => {
    const server = await fakeAppium((seen) => {
      const base = baseRoutes(seen);
      if (base) return base;
      if (seen.method === 'GET' && seen.path === '/session/s1/window/rect') {
        return ok({ x: 0, y: 0, width: 400, height: 800 });
      }
      if (seen.method === 'POST' && seen.path === '/session/s1/actions') return ok(null);
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec(server.url, [
          { action: 'SWIPE', name: 'scroll the list', fromY: 0.75, toY: 0.25, durationMs: 500 },
        ]),
      ),
    );

    expect(execution.status).toBe('PASSED');
    const actions = server.bodyFor('POST', '/session/s1/actions') as {
      actions: Array<{
        type: string;
        parameters: unknown;
        actions: Array<Record<string, unknown>>;
      }>;
    };
    expect(actions.actions[0]?.parameters).toEqual({ pointerType: 'touch' });
    expect(actions.actions[0]?.actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 200, y: 600 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration: 500, x: 200, y: 200 },
      { type: 'pointerUp', button: 0 },
    ]);
  });

  it('masks a vault secret that comes back on the screen', async () => {
    const server = await fakeAppium((seen) => {
      const base = baseRoutes(seen);
      if (base) return base;
      if (seen.method === 'GET' && seen.path === '/session/s1/element/e1/text') {
        return ok('signed in as token-abcdef123456');
      }
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx({ SESSION_TOKEN: 'token-abcdef123456' }),
      makeTest(
        appiumSpec(server.url, [
          {
            action: 'ASSERT_TEXT',
            name: 'welcome banner',
            selector: { value: 'banner' },
            equals: 'signed in',
          },
        ]),
      ),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.steps[1]?.error?.actual).toBe(`signed in as ${SECRET_MASK}`);
    expect(JSON.stringify(execution)).not.toContain('token-abcdef123456');
  });

  // ─ Skip paths ───────────────────────────────────────────────────────────────

  it('skips when no Appium server is listening, and says how to start one', async () => {
    // A port nothing is bound to: the honest CI-worker default.
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec('http://127.0.0.1:1', [
          { action: 'TAP', name: 'buy', selector: { value: 'buy-now' } },
        ]),
      ),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('No Appium server answered at http://127.0.0.1:1');
    expect(execution.errorMessage).toContain('npx appium');
    expect(execution.steps.some((step) => step.status === 'FAILED')).toBe(false);
  });

  it('skips when the server has no device, quoting what it said', async () => {
    const server = await fakeAppium((seen) => {
      if (seen.method === 'POST' && seen.path === '/session') {
        return wdError(
          'session not created',
          'Could not find a connected Android device in 20000ms',
          500,
        );
      }
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec(server.url, [{ action: 'TAP', name: 'buy', selector: { value: 'buy-now' } }]),
      ),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('adb devices');
    expect(execution.errorMessage).toContain('Could not find a connected Android device');
  });

  it('still FAILS when the session was refused for a reason the app owns', async () => {
    const server = await fakeAppium((seen) => {
      if (seen.method === 'POST' && seen.path === '/session') {
        return wdError(
          'session not created',
          'An unknown server-side error occurred: the app crashed during launch',
          500,
        );
      }
      return undefined;
    });

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec(server.url, [{ action: 'TAP', name: 'buy', selector: { value: 'buy-now' } }]),
      ),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('crashed during launch');
  });

  it('skips before contacting anything when the capabilities name no device', async () => {
    const server = await fakeAppium(() => ok(null));

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'APPIUM',
        platform: 'ANDROID',
        serverUrl: server.url,
        capabilities: { app: '/tmp/app.apk' },
        steps: [{ action: 'TAP', name: 'buy', selector: { value: 'buy-now' } }],
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('appium:deviceName');
    // Nothing was started, so nothing was asked of the server.
    expect(server.seen).toEqual([]);
  });

  it('skips when the device-farm credentials are not in the vault', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx({ DEVICE_FARM_USERNAME: 'acme' }),
      makeTest({
        driver: 'APPIUM',
        platform: 'IOS',
        deviceFarm: { provider: 'BROWSERSTACK' },
        capabilities: { deviceName: 'iPhone 15', app: 'bs://abc' },
        steps: [{ action: 'TAP', name: 'buy', selector: { value: 'buy-now' } }],
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('DEVICE_FARM_ACCESS_KEY');
    expect(execution.errorMessage).toContain('No session was started');
  });

  it('skips a serverUrl carrying credentials rather than sending them', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest(
        appiumSpec('https://user:key123456@hub.example.com/wd/hub', [
          { action: 'TAP', name: 'buy', selector: { value: 'buy-now' } },
        ]),
      ),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('Remove the credentials');
  });
});

// ─── The CLI drivers ─────────────────────────────────────────────────────────

/**
 * These run against STUB binaries on PATH and a scratch workspace. They cover
 * the command line this plugin builds and the output it reads back — the half of
 * the contract that does not need a device. The device half cannot be tested
 * anywhere without one.
 */
describe('mobile plugin — CLI drivers', () => {
  const originalPath = process.env.PATH;
  const originalCwd = process.cwd();
  let binDir = '';
  let workDir = '';
  let workName = '';
  let argsFile = '';

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'qaai-mobile-bin-'));
    argsFile = join(binDir, 'argv.txt');

    // The scratch workspace lives under the run's cwd because every spec path is
    // workspace-relative and may not escape it — which is the rule under test.
    workDir = await mkdtemp(join(originalCwd, '.qaai-mobile-test-'));
    workName = basename(workDir);

    const stub = `#!/bin/sh
printf '%s\\n' "$@" > "$QAAI_STUB_ARGS"
[ -n "$QAAI_STUB_OUT" ] && printf '%s\\n' "$QAAI_STUB_OUT"
exit "\${QAAI_STUB_EXIT:-0}"
`;
    for (const name of ['maestro', 'gradle', 'xcodebuild', 'detox']) {
      await writeFile(join(binDir, name), stub, { mode: 0o755 });
    }

    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.QAAI_STUB_ARGS = argsFile;
    process.env.QAAI_STUB_EXIT = '0';
    delete process.env.QAAI_STUB_OUT;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.QAAI_STUB_ARGS;
    delete process.env.QAAI_STUB_EXIT;
    delete process.env.QAAI_STUB_OUT;
    await rm(binDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  const junit = (cases: Array<{ name: string; failure?: string }>): string =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuite name="checkout" tests="${cases.length}">`,
      ...cases.map((c) =>
        c.failure
          ? `<testcase classname="checkout" name="${c.name}" time="1.5"><failure message="${c.failure}"/></testcase>`
          : `<testcase classname="checkout" name="${c.name}" time="1.5"/>`,
      ),
      '</testsuite>',
    ].join('\n');

  it('runs a Maestro flow and reads its JUnit report', async () => {
    await writeFile(join(workDir, 'report.xml'), junit([{ name: 'buy a bike' }]));
    await writeFile(join(workDir, 'checkout.yaml'), 'appId: com.acme\n---\n- launchApp\n');

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'MAESTRO',
        flowPath: `${workName}/checkout.yaml`,
        reportPath: `${workName}/report.xml`,
        deviceId: 'emulator-5554',
        flowEnv: { USERNAME: 'ada' },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(outline(execution)).toEqual(['PASSED checkout › buy a bike']);

    const argv = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
    expect(argv).toEqual([
      '--device',
      'emulator-5554',
      'test',
      '--format',
      'junit',
      '--output',
      join(workDir, 'report.xml'),
      '-e',
      'USERNAME=ada',
      join(workDir, 'checkout.yaml'),
    ]);
  });

  it('skips — never fails — when Gradle reports no connected device', async () => {
    process.env.QAAI_STUB_OUT =
      'com.android.builder.testing.api.DeviceException: No connected devices!';
    // Gradle exits non-zero for this, which is exactly the trap: the exit code
    // says "failed" and the truth is "there was nothing to run on".
    process.env.QAAI_STUB_EXIT = '1';

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({ driver: 'ESPRESSO', reportPath: `${workName}/results` }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('emulator -avd');
    expect(execution.errorMessage).toContain('was not evaluated');
    expect(execution.steps.some((step) => step.status === 'FAILED')).toBe(false);
  });

  it('merges the per-device JUnit files Gradle writes into one directory', async () => {
    const results = join(workDir, 'results');
    await mkdir(join(results, 'debug'), { recursive: true });
    await writeFile(join(results, 'TEST-pixel.xml'), junit([{ name: 'adds to cart' }]));
    await writeFile(
      join(results, 'debug', 'TEST-nexus.xml'),
      junit([{ name: 'pays with a card', failure: 'expected 1 got 2' }]),
    );
    process.env.QAAI_STUB_EXIT = '1';

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'ESPRESSO',
        module: ':app',
        testClass: 'com.acme.CheckoutTest',
        reportPath: `${workName}/results`,
      }),
    );

    expect(execution.status).toBe('FAILED');
    // Both device directories were read, in path order.
    expect(outline(execution)).toEqual([
      'PASSED checkout › adds to cart',
      'FAILED checkout › pays with a card',
    ]);

    const argv = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
    expect(argv).toEqual([
      ':app:connectedAndroidTest',
      '-Pandroid.testInstrumentationRunnerArguments.class=com.acme.CheckoutTest',
      '--console=plain',
    ]);
  });

  it('reads xcodebuild’s own log when the project emits no report', async () => {
    process.env.QAAI_STUB_OUT = [
      "Test Case '-[CheckoutUITests testAddToCart]' passed (3.412 seconds).",
      '/repo/CheckoutUITests.swift:42: error: -[CheckoutUITests testApplePay] : XCTAssertEqual failed',
      "Test Case '-[CheckoutUITests testApplePay]' failed (1.002 seconds).",
    ].join('\n');
    process.env.QAAI_STUB_EXIT = '65';

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'XCUITEST',
        scheme: 'Checkout',
        workspace: 'Checkout.xcworkspace',
        onlyTesting: ['CheckoutUITests/testApplePay'],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(outline(execution)).toEqual([
      'PASSED CheckoutUITests › testAddToCart',
      'FAILED CheckoutUITests › testApplePay',
    ]);

    const argv = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
    expect(argv).toEqual([
      'test',
      '-workspace',
      'Checkout.xcworkspace',
      '-scheme',
      'Checkout',
      '-destination',
      'platform=iOS Simulator,name=iPhone 15,OS=latest',
      '-only-testing:CheckoutUITests/testApplePay',
    ]);
  });

  it('skips when no simulator matches the destination', async () => {
    process.env.QAAI_STUB_OUT =
      'xcodebuild: error: Unable to find a destination matching the provided destination specifier';
    process.env.QAAI_STUB_EXIT = '70';

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({ driver: 'XCUITEST', scheme: 'Checkout' }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('xcrun simctl list devices');
  });

  it('skips when Detox has no app binary, naming the build command', async () => {
    process.env.QAAI_STUB_OUT = 'Error: cannot find app binary at ios/build/Build/App.app';
    process.env.QAAI_STUB_EXIT = '1';

    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({ driver: 'DETOX', configuration: 'ios.sim.release' }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('detox build');
  });

  it('takes Detox’s exit code as the verdict when the project writes no report', async () => {
    const passed = await mobilePlugin.execute(
      makeCtx(),
      makeTest({ driver: 'DETOX', configuration: 'ios.sim.debug' }),
    );
    expect(passed.status).toBe('PASSED');

    // Detox exits non-zero on a real test failure, and nothing in that output
    // looks like a setup gap — so it stays a failure.
    process.env.QAAI_STUB_OUT = '2 failing\n  1) checkout adds to cart: expected true to be false';
    process.env.QAAI_STUB_EXIT = '1';
    const failed = await mobilePlugin.execute(
      makeCtx(),
      makeTest({ driver: 'DETOX', configuration: 'ios.sim.debug' }),
    );
    expect(failed.status).toBe('FAILED');
    expect(failed.errorMessage).toContain('expected true to be false');
  });

  it('skips an uninstalled CLI with the command that installs it', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'MAESTRO',
        flowPath: `${workName}/checkout.yaml`,
        reportPath: `${workName}/report.xml`,
        command: 'qaai-maestro-that-is-not-installed',
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('is not installed on this worker');
    expect(execution.errorMessage).toContain('get.maestro.mobile.dev');
    expect(execution.steps.some((step) => step.status === 'FAILED')).toBe(false);
  });

  it('skips when a secret the tool needs is not on the environment', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'DETOX',
        configuration: 'ios.sim.debug',
        secretNames: ['TEST_USER_PASSWORD'],
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('TEST_USER_PASSWORD');
  });

  it('refuses a report path that climbs out of the workspace', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'ESPRESSO',
        reportPath: `${workName}/results`,
        cwd: '.',
      }),
    );
    // Sanity: the legitimate path runs. The traversal one is refused by the
    // schema before it ever reaches the plugin.
    expect(execution.status).not.toBe('FAILED');
    expect(() =>
      mobilePlugin.validate(makeTest({ driver: 'ESPRESSO', reportPath: '../../etc/passwd' })),
    ).toThrow(/relative path inside the workspace/);
  });

  it('says so honestly when a tool exits clean and writes no report', async () => {
    const execution = await mobilePlugin.execute(
      makeCtx(),
      makeTest({
        driver: 'MAESTRO',
        flowPath: `${workName}/checkout.yaml`,
        reportPath: `${workName}/nothing-here.xml`,
      }),
    );

    // A clean exit with no results is not a pass. It is a run that reported
    // nothing, and it says exactly that.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('wrote no report');
  });
});
