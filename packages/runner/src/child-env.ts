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
 * `ctx.secrets` is the deliberate exception to THIS list and is applied after
 * it — those are the tenant's own secrets, scoped to the tenant's own
 * environment, which is the one category of secret a test is supposed to see.
 * It is NOT an exception to {@link isInterpreterEnvKey} below; see that
 * function for the escalation that exception turned out to be.
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
 * Environment names that change HOW AN INTERPRETER LOADS CODE, or which binary
 * a bare command name resolves to.
 *
 * ── THE ESCALATION THIS CLOSES, REPRODUCED END TO END ──────────────────────
 *
 * This list used to live in `plugins/external.ts`, where `screenSpecEnv`
 * applies it to `spec.env` — the fix for defect (2) in that file's header:
 * "THE PATH OVERRIDE, which defeats [the bare-name allowlist] on its own and
 * was live … `env: { PATH: '<the workspace>' }` plus a planted file named
 * `vitest` turns an allowlisted bare name back into tenant code."
 *
 * The same attack was still live through the OTHER channel, because
 * `Secret.name` is `/^[A-Z][A-Z0-9_]*$/` (packages/shared/src/schemas.ts) — so
 * `PATH`, `NODE_OPTIONS` and `LD_PRELOAD` are all legal secret names, and
 * {@link childEnv} applied `secrets` LAST and unscreened, after the screened
 * extras. Measured, with a real spawn: `classifyExternalCommand('vitest run')`
 * ALLOWED, `screenSpecEnv({ PATH })` refused 1 and returned `{}`, and then
 * `childEnv({ secrets: { PATH: <planted dir> } })` handed back that PATH and
 * `spawnSync('vitest', ['run'], { env, shell: false })` printed the planted
 * script's output. A MEMBER needed one secret row.
 *
 * So the list belongs HERE, at the single point every spawn in this package
 * goes through, rather than in one plugin. `external.ts` re-exports it and
 * keeps applying it to `spec.env` as well, which is not redundant: the spec
 * screen REPORTS what it refused on the test result, and this one is the floor
 * under every other caller — `playwright-harness.ts`, `load.ts`, `desktop.ts`
 * and the rest all pass `secrets: ctx.secrets` straight through.
 *
 * ── Why this is an unconditional drop and not a mode ───────────────────────
 *
 * The same answer `FORBIDDEN_SUBSTRINGS` gives above, and the same one
 * `COMMAND_POLICY_DEFAULTS.specEnv` already gives for the spec half, where the
 * mode is ENFORCE by default with the stated reason "no documented workflow
 * sets PATH or NODE_OPTIONS in a spec". None of these names is a credential for
 * an application under test, so there is no legitimate traffic to brake: a
 * secret named `PATH` is not a customer workflow, it is this escalation. What
 * the drop owes instead is DISCLOSURE, which is {@link ChildEnvOptions.withheld}
 * — a caller that passes the sink can say on the result that it happened, and
 * `external.ts` does.
 *
 * Matched case-insensitively and, for the suffix forms, by suffix: the JVM and
 * JS ecosystems both use `…_OPTS` / `…_OPTIONS` to mean "flags nobody passed on
 * the command line", which is exactly the channel being closed.
 */
const INTERPRETER_ENV_NAMES = [
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONEXECUTABLE',
  'RUBYLIB',
  'RUBYOPT',
  'GEM_PATH',
  'GEM_HOME',
  'PERL5LIB',
  'PERL5OPT',
  'CLASSPATH',
  'BUNDLE_GEMFILE',
  'GOFLAGS',
  'GOPATH',
  'RUSTFLAGS',
] as const;

const INTERPRETER_ENV_SUFFIXES = ['_OPTIONS', '_OPTS'] as const;

/** True when a tenant-supplied variable would change how code is loaded. */
export function isInterpreterEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (INTERPRETER_ENV_NAMES.some((name) => name === upper)) return true;
  return INTERPRETER_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
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
   * The tenant's own secrets, from their environment's vault. Applied LAST, and
   * NOT screened against {@link isForbiddenChildEnvKey}: these are the
   * credentials the test is meant to use to log into the app under test, the
   * tenant already owns them, and that screen exists to stop the PLATFORM's
   * secrets leaking rather than the tenant's own. A secret legitimately named
   * `APP_PASSWORD` or `API_TOKEN` therefore still arrives.
   *
   * They ARE screened against {@link isInterpreterEnvKey}, which is a different
   * question: not "whose credential is this" but "does this name change which
   * code the child loads". See that function for the escalation.
   */
  secrets?: Record<string, string>;
  /**
   * A sink for the names {@link isInterpreterEnvKey} withheld from `extra` AND
   * from `secrets` — both channels reach the same env object, and for a while
   * only one of them was screened.
   *
   * Present so the drop is DISCLOSED rather than silent — a cap or a refusal
   * applied without being reported is the defect, not the refusal. Optional
   * because most callers have nowhere to put a note; `plugins/external.ts` has
   * a result to write one on and passes it.
   */
  withheld?: string[];
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
    /*
     * ── THE SCREEN APPLIES TO `extra` TOO, AND IT DID NOT ─────────────────────
     *
     * This header claims the interpreter list "belongs HERE, at the single point
     * every spawn in this package goes through" and is "the floor under every
     * other caller". It was applied to `secrets` only, so `extra` was an open
     * second channel into the same env object — and `extra` is where THREE
     * plugins put a tenant's `spec.env` verbatim: plugins/cli.ts, plugins/mobile.ts
     * and plugins/mutation.ts (twice) spread it raw, while only plugins/external.ts
     * runs it through `screenSpecEnv` first.
     *
     * MEASURED with a planted executable named `vitest`:
     * `childEnv({ extra: { PATH: <planted dir> } })` returned that PATH and
     * `spawnSync('vitest', ['run'], { env, shell: false })` ran the planted
     * script. LD_PRELOAD, DYLD_INSERT_LIBRARIES, PYTHONPATH, CLASSPATH, NODE_PATH
     * and NODE_OPTIONS all passed the same way. The escalation this file was
     * written to remove was live through the channel it did not screen.
     *
     * Screened here rather than in the three plugins for the reason the header
     * already gives: a per-plugin screen is one new plugin away from being
     * reopened, and the point of a floor is that there is one. `external.ts`
     * keeps its own `screenSpecEnv` because that one REPORTS what it refused on
     * the test result; this one is the floor under it.
     *
     * No legitimate caller is affected: performance.ts, playwright-harness.ts,
     * visual-services.ts and load.ts pass only `QAAI_*`, `CI` and `FORCE_COLOR`
     * through `extra`. A caller that needs the child to load different code must
     * say so by its command, not by an environment variable a tenant can set.
     */
    if (isInterpreterEnvKey(key)) {
      options.withheld?.push(key);
      continue;
    }
    env[key] = value;
  }

  /*
   * The tenant's own credentials, last so they win over anything above — EXCEPT
   * the names that decide which code the child loads. `PATH` is the one that
   * matters most: libuv resolves the executable using the PATH in the env
   * object it is handed, so letting a secret win here turns an allowlisted bare
   * command name back into tenant code. See `isInterpreterEnvKey`.
   */
  for (const [key, value] of Object.entries(options.secrets ?? {})) {
    if (isInterpreterEnvKey(key)) {
      options.withheld?.push(key);
      continue;
    }
    env[key] = value;
  }

  return env;
}
