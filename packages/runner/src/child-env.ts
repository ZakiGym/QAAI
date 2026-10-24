/**
 * Builds the environment for every child process the runner spawns.
 *
 * WHY THIS FILE EXISTS
 *
 * Every spawn site in this package used to start from `...process.env`. The
 * processes being spawned run TENANT-AUTHORED CODE: a generated Playwright
 * spec, a customer's own CLI under test, a `command` an org MEMBER declared in
 * a test spec. The worker that spawns them holds, among other things,
 * VAULT_MASTER_KEY (which decrypts every customer's stored credentials),
 * SESSION_SECRET (which mints sessions and API keys), DATABASE_URL,
 * S3_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, GITHUB_WEBHOOK_SECRET and
 * SMTP_PASSWORD.
 *
 * So `console.log(process.env)` inside a test — or a single line in a spawned
 * binary — read the whole platform's keys, across every tenant. One customer
 * could decrypt every other customer's vault. That is the entire blast radius
 * of the product in one object spread.
 *
 * An allowlist is the only shape that is safe by default here. A denylist fails
 * the moment someone adds an env var and forgets to deny it, and the cost of
 * forgetting is total. So: nothing reaches a child unless it is named below,
 * and `child-env.test.ts` asserts that every variable the API's own env schema
 * declares is absent from the result. Add a secret to the schema and forget to
 * think about it, and that test is what tells you.
 *
 * WHAT A CHILD ACTUALLY NEEDS
 *
 * Less than you would think. A Playwright subprocess needs to find binaries
 * (PATH), a home for its browser cache (HOME), somewhere to write temp files,
 * and the locale and proxy settings of the host. It does not need to know how
 * to reach the database.
 */

/**
 * Variables passed through from the parent when present.
 *
 * Each one is here because a child breaks without it, not because it seemed
 * harmless. Keep that bar: the question for a new entry is "what fails if this
 * is absent", and if the answer is "nothing", it does not belong.
 */
const PASSTHROUGH = [
  // Binary resolution. Without PATH a child cannot find node, npx or a browser.
  'PATH',
  'Path', // Windows casing; Node normalises reads but not an explicit env object.

  // Tool caches live under HOME — Playwright's browser download, npm's cache.
  'HOME',
  'USERPROFILE', // Windows equivalent.

  // Temp directories. Playwright writes traces and videos through these.
  'TMPDIR',
  'TMP',
  'TEMP',

  // Node itself refuses to start on Windows without these two.
  'SystemRoot',
  'windir',
  'COMSPEC',

  // Locale. A test asserting on a formatted date needs the host's collation,
  // and determinism overrides these explicitly where it cares.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_NUMERIC',
  'LC_TIME',

  // Egress. A self-hosted runner behind a corporate proxy cannot reach the app
  // under test without them.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',

  // Headed runs on a Linux host need a display to attach to.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',

  // Where Playwright's browsers were installed, when not the default location.
  // A container image that pre-installs browsers elsewhere sets this, and
  // without it every run re-downloads Chromium or fails closed.
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  'PLAYWRIGHT_SKIP_BROWSER_GC',

  // Chromium needs these to run as root in a container, which is how most
  // self-hosted runners are deployed.
  'CHROME_DEVEL_SANDBOX',
  'CHROMIUM_FLAGS',
] as const;

/**
 * Variables that must NEVER reach a child, whatever else happens.
 *
 * The allowlist above already excludes these — this is the second lock, for the
 * case where a caller passes its own `extra` map built from something wider
 * than it realised (a config blob, a merged object, a future refactor). The
 * names are matched case-insensitively, and by substring for the generic ones,
 * because a leak through `MY_APP_SECRET_KEY` is the same leak.
 *
 * `ctx.secrets` is the deliberate exception and is applied by the caller AFTER
 * this guard runs — those are the tenant's own secrets, scoped to the tenant's
 * own environment, which is the one category of secret a test is supposed to
 * see.
 */
const FORBIDDEN_SUBSTRINGS = [
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'TOKEN',
  'APIKEY',
  'API_KEY',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'CREDENTIAL',
  'MASTER_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'DSN',
  'SESSION',
  'ANTHROPIC',
  'STRIPE',
  'AWS_',
  'S3_',
  'SMTP_',
  'GITHUB_',
  'NPM_',
] as const;

/** True when a variable name is one no child process may ever receive. */
export function isForbiddenChildEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return FORBIDDEN_SUBSTRINGS.some((bad) => upper.includes(bad));
}

/**
 * Test scaffolding, and only under a test runner.
 *
 * `protocol.test.ts` and `mobile.test.ts` exercise their plugins against STUB
 * binaries placed on PATH — a fake `grpcurl`, a fake `gradlew`. The stub needs
 * to be told where to record the argv it was called with and which outcome to
 * simulate, and it is a shell script, so an env var is the only channel.
 *
 * Those variables are QAAI's own, carry no secret, and are still screened by
 * `isForbiddenChildEnvKey`. The gate matters anyway: without it this would be a
 * standing hole in the allowlist that a production deployment could be talked
 * into opening by setting one variable. With it, the names only pass when a
 * test runner is the thing spawning.
 */
const TEST_STUB_PREFIX = 'QAAI_STUB_';

function underTestRunner(): boolean {
  // NODE_ENV only. Vitest sets it to 'test', and keying off VITEST as well
  // would add an environment variable nobody deploying this could discover —
  // which `check:wiring` correctly refuses.
  return process.env.NODE_ENV === 'test';
}

export interface ChildEnvOptions {
  /**
   * Extra variables for this child — QAAI_* wiring, CI flags, determinism
   * pins. Screened against {@link isForbiddenChildEnvKey}, so a caller cannot
   * accidentally widen the allowlist by passing a merged object through.
   */
  extra?: Record<string, string | undefined>;
  /**
   * The tenant's own secrets, from their environment's vault. Applied LAST and
   * deliberately NOT screened: these are the credentials the test is meant to
   * use to log into the app under test. The tenant already owns them, so there
   * is nothing to protect them from — the screening above exists to stop the
   * PLATFORM's secrets leaking, not the tenant's own.
   */
  secrets?: Record<string, string>;
}

/**
 * The environment for a spawned child: the passthrough allowlist, then screened
 * extras, then the tenant's own secrets.
 *
 * Every `spawn()` in this package goes through here. If you are writing a new
 * one and reach for `...process.env`, that is the bug this file was written to
 * remove.
 */
export function childEnv(options: ChildEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  if (underTestRunner()) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(TEST_STUB_PREFIX)) continue;
      if (value === undefined || isForbiddenChildEnvKey(key)) continue;
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) continue;
    // A caller that tries to pass a platform secret through `extra` is a bug in
    // the caller, and a silent drop would hide it. But throwing would take down
    // a run for something the tenant did not do, so: drop it and leave the
    // assertion to the test suite, which covers every name in the env schema.
    if (isForbiddenChildEnvKey(key)) continue;
    env[key] = value;
  }

  // The tenant's own credentials, last so they win over anything above.
  for (const [key, value] of Object.entries(options.secrets ?? {})) {
    env[key] = value;
  }

  return env;
}
