/**
 * Executes generated Playwright specs with the real Playwright test runner.
 *
 * Why shell out instead of driving `page` in-process: the tests QAAI writes are
 * standard `@playwright/test` files the customer owns and can run in their own
 * CI with no QAAI installed (§7 "no lock-in"). If we executed them through a
 * bespoke harness, that promise would be false — the code would only run here.
 * The cost is a subprocess and JSON-reporter parsing, which is what this file is.
 *
 * Everything the cockpit renders — steps, screenshots, video, trace, network,
 * console — comes out of the reporter and the artifacts directory below.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type {
  ConsoleEntry,
  ExecutableTest,
  Finding,
  FindingKind,
  FindingSeverity,
  NetworkEntry,
  RunContext,
  StepResult,
  TestExecution,
  TestResultStatus,
} from '@qaai/shared';
import {
  determinismRecord,
  planDeterminism,
  reproduceHint,
  resolveDeterminism,
  type DeterminismOptions,
  type DeterminismPlan,
} from './determinism.js';
import { childEnv } from './child-env.js';
import { authProfileRequired, declaredAuthProfileId, suppliedAuthProfileId } from './run-workspace.js';
import {
  botProtectionRemedy,
  environmentExtraHeaderSchema,
  reachabilityFromPolicy,
  SECRET_BEARING_HEADER_NAMES,
} from '@qaai/shared';
import type { BotBypassMode, BotProtectionProvider } from '@qaai/shared';

/** Hard ceiling for a whole spec file, independent of per-test timeouts. */
const PROCESS_TIMEOUT_MS = 10 * 60_000;

const localRequire = createRequire(import.meta.url);

/**
 * Where generated specs are written, and which Playwright binary runs them.
 *
 * Both are derived from the installed `@playwright/test`, not from `os.tmpdir()`
 * and not from `npx`. Two reasons, and the first one bites immediately:
 *
 *  - A workspace under /tmp has no `node_modules` above it, so the spec's
 *    `import { test } from '@playwright/test'` cannot resolve. Placing the
 *    workspace beside the installed package lets Node's normal upward lookup
 *    find it, with no NODE_PATH tricks.
 *  - `npx playwright` resolves against the npx cache and can silently fetch a
 *    *different* Playwright than the one whose browsers were installed. Running
 *    the local binary keeps the runner and its browsers in lockstep.
 */
function resolvePlaywrightLayout(): { runsRoot: string; cliPath: string } {
  const entry = localRequire.resolve('@playwright/test');
  const marker = `${sep}node_modules${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index === -1) {
    throw new Error('Could not locate node_modules for @playwright/test');
  }

  const nodeModulesDir = entry.slice(0, index + marker.length - 1);
  const installRoot = dirname(nodeModulesDir);

  return {
    runsRoot: join(installRoot, '.qaai-runs'),
    cliPath: join(nodeModulesDir, '.bin', 'playwright'),
  };
}

const { runsRoot, cliPath } = resolvePlaywrightLayout();

/** The Playwright binary the runner drives; record mode uses it too. */
export const playwrightCliPath = cliPath;

// ─── Playwright JSON reporter shapes (the subset we consume) ─────────────────

interface PwErrorish {
  message?: string;
  stack?: string;
  location?: { file: string; line: number; column: number };
}

interface PwStep {
  title: string;
  duration: number;
  error?: PwErrorish;
  steps?: PwStep[];
  /** 'test.step' for user steps; 'pw:api'/'hook'/'expect' for machinery. */
  category?: string;
  startTime?: string;
}

interface PwAttachment {
  name: string;
  path?: string;
  contentType: string;
}

interface PwResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  retry: number;
  steps?: PwStep[];
  errors?: PwErrorish[];
  attachments?: PwAttachment[];
  stdout?: Array<{ text?: string }>;
  stderr?: Array<{ text?: string }>;
}

interface PwTest {
  title: string;
  results: PwResult[];
}

interface PwSpec {
  title: string;
  tests: PwTest[];
}

interface PwSuite {
  title: string;
  specs: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites?: PwSuite[];
  errors?: PwErrorish[];
}

function flattenSpecs(suites: PwSuite[] | undefined): PwSpec[] {
  const out: PwSpec[] = [];
  for (const suite of suites ?? []) {
    out.push(...suite.specs);
    out.push(...flattenSpecs(suite.suites));
  }
  return out;
}

/**
 * Only user-authored `test.step()` calls become cockpit steps; auto-generated
 * `expect` and `pw:api` entries are machinery and would bury the timeline.
 *
 * The JSON reporter is inconsistent about `category`: it omits the field
 * entirely and already returns just the user steps at the top level, while the
 * richer in-process reporters do set it. Handle both — an absent category at
 * the root means "this is a user step", and a present one is trusted.
 */
function collectUserSteps(steps: PwStep[] | undefined, into: PwStep[] = []): PwStep[] {
  for (const step of steps ?? []) {
    if (step.category === undefined || step.category === 'test.step') into.push(step);
    else collectUserSteps(step.steps, into);
  }
  return into;
}

// ─── Workspace ───────────────────────────────────────────────────────────────

interface Workspace {
  dir: string;
  specPath: string;
  outputDir: string;
  reportPath: string;
  /**
   * Where this spec's session was written, or null when the test runs
   * anonymously. Named after the auth profile that produced it — see
   * {@link createWorkspace}.
   */
  storageStatePath: string | null;
  /**
   * Where the injected runtime observer writes its NDJSON, or null when no
   * observer was injected because the spec drives no browser. Inside the run
   * directory, so `cleanup` removes it with everything else — the observation
   * is read out before the workspace goes.
   */
  observeDir: string | null;
  cleanup: () => Promise<void>;
}

/**
 * Refuses any path that escapes the workspace. `test.filePath` originates from
 * the Generator (a model), so it is untrusted input that ends up as a real path.
 */
function safeSpecPath(dir: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const withExt = extname(cleaned) ? cleaned : `${cleaned}.spec.ts`;
  const full = resolve(join(dir, 'tests', withExt));
  const root = resolve(join(dir, 'tests'));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing to write test outside the workspace: ${filePath}`);
  }
  return full;
}

/**
 * Same guard for a fixture, resolved against the workspace root rather than
 * `tests/` — fixture paths already start with `fixtures/`, and a spec reads them
 * relative to the workspace it runs in.
 */
function safeFixturePath(dir: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const full = resolve(join(dir, cleaned));
  const root = resolve(dir);
  if (!full.startsWith(root + sep)) {
    throw new Error(`Refusing to write fixture outside the workspace: ${filePath}`);
  }
  return full;
}

/**
 * The file one profile's session is written to.
 *
 * Keyed by profile id so the mapping is a function of the identity and nothing
 * else: two tests on the same profile name the same file, two tests on
 * different profiles can never name the same one, and the identity behind a
 * verdict is visible in the workspace instead of being implied. A profile id is
 * a cuid, but it becomes a real filename, so it is sanitised like any other
 * untrusted path component.
 *
 * Exported for the test that pins exactly those three properties.
 */
export function storageStateFileName(profileId: string | null): string {
  if (!profileId) return 'storage-state.json';
  return `storage-state-${profileId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** Playwright's device preset for a browser engine. */
function deviceFor(browserName: string): string {
  switch (browserName) {
    case 'firefox':
      return 'Desktop Firefox';
    case 'webkit':
      return 'Desktop Safari';
    default:
      return 'Desktop Chrome';
  }
}

// ─── Bot protection, and the only legitimate ways past it ────────────────────

/**
 * An application behind reCAPTCHA, hCaptcha, Turnstile or a WAF cannot be
 * signed into by ANY auth profile kind, so its whole authenticated surface is
 * unenumerable — and the zero that produces reads as a testing failure instead
 * of an access problem. This section is the half of that defect this harness
 * owns: carrying the customer's own way in, and refusing to execute when there
 * is not one.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * No solver. No challenge-token replay. No fingerprint shim, no stealth flags,
 * no retry-until-it-lets-us-through. A challenge is a system owner saying "not
 * automated traffic", and the right answer is to ask the owner, not to look
 * less automated. Every route below is something the OWNER of the environment
 * did on their own system:
 *
 *   PROVIDER_TEST_KEYS       they configured their own NON-PRODUCTION site with
 *                            the provider's published test keys, so the widget
 *                            self-resolves. Nothing is sent from here — this
 *                            harness does not even learn the keys, which is
 *                            exactly right.
 *   SIGNED_BYPASS_HEADER     they issue a header their own edge accepts. We
 *                            send it. We do not mint it and could not: the
 *                            value is a vault REFERENCE resolved out of their
 *                            own environment secrets.
 *   ALLOWLISTED_BY_CUSTOMER  they allowlisted us at the edge. Nothing is sent.
 *
 * With none of them configured the answer is UNREACHABLE_BEHIND_BOT_PROTECTION
 * plus the remedy. That decision is `reachabilityFromPolicy`'s in @qaai/shared
 * and is READ here rather than re-made, so the API, the cockpit and the runner
 * cannot disagree about whether an environment is reachable.
 */
export interface EnvironmentAccessPolicy {
  provider: BotProtectionProvider;
  bypassMode: BotBypassMode;
  /** The header name the customer's edge accepts. SIGNED_BYPASS_HEADER only. */
  bypassHeaderName?: string | null;
  /** A `Secret.name` reference into `ctx.secrets`. NEVER a value. */
  bypassSecretName?: string | null;
  /**
   * `EnvironmentAccess.extraHeaders` verbatim, straight off the Json column.
   *
   * `unknown` on purpose: parsing happens HERE, per entry, so a row written by
   * an older shape cannot throw inside a run and cannot cost the entries beside
   * it. A caller that pre-parsed would be a second parser of the same column.
   */
  extraHeaders?: unknown;
}

/**
 * Why one configured header was not sent.
 *
 * Every one of these is DISCLOSED rather than dropped. A header that silently
 * went missing is the worst available outcome: every request is then challenged
 * or unauthorised, the spec fails on an assertion, and the failure is reported
 * as a defect in the customer's application.
 */
export const HEADER_REFUSAL_REASONS = [
  /** The vault entry the header names is not in this environment. */
  'MISSING_SECRET',
  /** A credential-bearing header name carried an inline value. */
  'INLINE_CREDENTIAL',
  /** Two configured headers claim the same name, case-insensitively. */
  'DUPLICATE_NAME',
  /** SIGNED_BYPASS_HEADER with no header name or no secret name. */
  'BYPASS_INCOMPLETE',
  /** The stored shape did not parse, or the name is not a legal header name. */
  'UNREADABLE',
] as const;
export type HeaderRefusalReason = (typeof HEADER_REFUSAL_REASONS)[number];

/** One refused header. Carries NAMES only — never a value, not even truncated. */
export interface HeaderRefusal {
  reason: HeaderRefusalReason;
  /** The header name, or `(all)` when the whole list was unreadable. */
  header: string;
  /** The vault entry that was named, when one was. A name, never a value. */
  secretName: string | null;
  /** The sentence shown to a customer. Safe by construction: no values reach it. */
  detail: string;
  /**
   * True when this refusal removed the ONLY configured way past a challenge.
   *
   * The field exists because the two cases are opposite facts. A missing
   * `X-Environment: staging` header is a nuisance; a missing bypass credential
   * means the run is about to measure a challenge page and call it the
   * application, so it is promoted to a refusal to execute at all.
   */
  removesTheBypass: boolean;
}

export interface ResolvedEnvironmentHeaders {
  /** Name → value, for a caller that needs the resolved map. */
  headers: Record<string, string>;
  refusals: HeaderRefusal[];
  /** The names that will be sent, for the disclosure line. Never the values. */
  names: string[];
  /**
   * WHERE each header's value comes from, which is what the generated config is
   * built out of.
   *
   * A `literal` is a value `environmentExtraHeaderSchema` has already
   * guaranteed carries no credential — it refuses an inline value for every
   * name that holds one by definition — so inlining it in the config is safe.
   * A `secretName` is a vault reference, and the generated config reads it out
   * of the CHILD'S OWN ENVIRONMENT, which `childEnv` already fills with
   * `ctx.secrets` for every run. So a bypass credential is never written to a
   * file, and no new environment variable exists: the only name read is the
   * customer's own vault entry, which was already there.
   */
  entries: Array<{ name: string; literal: string | null; secretName: string | null }>;
}

/**
 * HTTP header names are a restricted token grammar, and these names end up
 * inside a GENERATED TypeScript file and a child process's environment. The
 * same regex `environmentExtraHeaderSchema` applies on write is applied here on
 * read, because `EnvironmentAccess.bypassHeaderName` is a plain column that a
 * row written outside that schema could hold anything in — and a name with a
 * newline or a quote in it would either break the generated config or, worse,
 * not break it.
 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Turn a stored access policy into the headers a run may actually send.
 *
 * ── ORDER MATTERS: THE BYPASS IS CLAIMED FIRST ──────────────────────────────
 *
 * The bypass header takes its name before the customer's own extra headers are
 * considered, so an extra header spelled the same way is REFUSED rather than
 * overwriting it. The other order compiles and is a disaster: a stray
 * `Authorization: ...` entry would shadow the bypass, every request would be
 * challenged, and the report would blame the customer's login form.
 */
export function resolveEnvironmentHeaders(
  policy: EnvironmentAccessPolicy,
  secrets: Readonly<Record<string, string>>,
): ResolvedEnvironmentHeaders {
  const headers: Record<string, string> = {};
  const refusals: HeaderRefusal[] = [];
  const entries: ResolvedEnvironmentHeaders['entries'] = [];
  const claimed = new Set<string>();

  const put = (
    name: string,
    value: string,
    from: { literal: string | null; secretName: string | null },
  ): void => {
    headers[name] = value;
    entries.push({ name, ...from });
    claimed.add(name.toLowerCase());
  };

  if (policy.bypassMode === 'SIGNED_BYPASS_HEADER') {
    const name = (policy.bypassHeaderName ?? '').trim();
    const secretName = (policy.bypassSecretName ?? '').trim();
    if (!name || !secretName) {
      refusals.push({
        reason: 'BYPASS_INCOMPLETE',
        header: name || '(all)',
        secretName: secretName || null,
        detail:
          'This environment claims a signed bypass header and does not say ' +
          (name
            ? 'which vault entry holds its value'
            : 'which header name your edge accepts') +
          ', so there is nothing to send.',
        removesTheBypass: true,
      });
    } else if (!HEADER_NAME_RE.test(name)) {
      refusals.push({
        reason: 'UNREADABLE',
        header: name,
        secretName,
        detail: `"${name}" is not a legal HTTP header name, so the signed bypass could not be sent.`,
        removesTheBypass: true,
      });
    } else {
      const value = secrets[secretName];
      if (value === undefined || value === '') {
        refusals.push({
          reason: 'MISSING_SECRET',
          header: name,
          secretName,
          detail:
            `The signed bypass header ${name} names the vault entry "${secretName}", ` +
            'which this environment does not hold.',
          removesTheBypass: true,
        });
      } else {
        put(name, value, { literal: null, secretName });
      }
    }
  }

  const stored = policy.extraHeaders ?? [];
  if (!Array.isArray(stored)) {
    refusals.push({
      reason: 'UNREADABLE',
      header: '(all)',
      secretName: null,
      detail:
        "This environment's stored extra headers are not a list, so none of them were sent. " +
        'Re-save them under Environment → Access.',
      removesTheBypass: false,
    });
    return { headers, refusals, names: Object.keys(headers), entries };
  }

  /*
   * PER ENTRY, and not one parse of the whole array. `environmentExtraHeaders
   * Schema` is an array schema and one bad entry fails all of them, which would
   * cost a customer every working header because of one typo — and the
   * disclosure would name none of them.
   */
  for (const entry of stored) {
    const parsed = environmentExtraHeaderSchema.safeParse(entry);
    if (!parsed.success) {
      const name = typeof (entry as { name?: unknown })?.name === 'string'
        ? (entry as { name: string }).name
        : '(all)';
      /*
       * The schema's own refinement already refuses an inline value on a
       * credential-bearing name, so this branch is where that refusal is TOLD
       * APART from a shape error. Two reasons rather than one because the
       * remedies differ: one is "move it to the vault", the other is "this row
       * is malformed".
       */
      const inlineCredential =
        typeof (entry as { value?: unknown })?.value === 'string' &&
        (SECRET_BEARING_HEADER_NAMES as readonly string[]).includes(name.toLowerCase());
      refusals.push({
        reason: inlineCredential ? 'INLINE_CREDENTIAL' : 'UNREADABLE',
        header: name,
        secretName: null,
        detail: inlineCredential
          ? `${name} carries a credential by definition, so an inline value is refused. ` +
            'Store it in this environment’s vault and name it in secretName.'
          : `The stored header ${name === '(all)' ? 'entry' : name} does not parse, so it was not sent.`,
        removesTheBypass: false,
      });
      continue;
    }

    const header = parsed.data;
    const lower = header.name.toLowerCase();
    if (claimed.has(lower)) {
      refusals.push({
        reason: 'DUPLICATE_NAME',
        header: header.name,
        secretName: header.secretName ?? null,
        detail:
          `${header.name} is configured twice on this environment (header names are ` +
          'case-insensitive). The first one was sent and this one was not.',
        removesTheBypass: false,
      });
      continue;
    }

    if (header.secretName !== undefined) {
      const value = secrets[header.secretName];
      if (value === undefined || value === '') {
        refusals.push({
          reason: 'MISSING_SECRET',
          header: header.name,
          secretName: header.secretName,
          detail:
            `${header.name} names the vault entry "${header.secretName}", which this ` +
            'environment does not hold.',
          removesTheBypass: false,
        });
        continue;
      }
      put(header.name, value, { literal: null, secretName: header.secretName });
      continue;
    }

    /*
     * The second half of the credential guard. `environmentExtraHeaderSchema`
     * already rejects this combination, so reaching here means the schema was
     * loosened — and the thing it was guarding is a bearer token written into a
     * generated file. Kept as a live check rather than a comment for exactly
     * that reason; `header.value` is defined because the schema's refinement
     * requires exactly one of the two.
     */
    if ((SECRET_BEARING_HEADER_NAMES as readonly string[]).includes(lower)) {
      refusals.push({
        reason: 'INLINE_CREDENTIAL',
        header: header.name,
        secretName: null,
        detail:
          `${header.name} carries a credential by definition, so an inline value is ` +
          'refused. Store it in this environment’s vault and name it in secretName.',
        removesTheBypass: false,
      });
      continue;
    }
    put(header.name, header.value ?? '', { literal: header.value ?? '', secretName: null });
  }

  return { headers, refusals, names: Object.keys(headers), entries };
}

/**
 * The `extraHTTPHeaders` object literal, as TypeScript source for the generated
 * config.
 *
 * ── WHY A CREDENTIAL IS NOT IN THE STRING THIS RETURNS ──────────────────────
 *
 * A literal is inlined; a vault-backed value becomes
 * `process.env[<the vault entry's name>]`, read in the child process that
 * `childEnv` has already filled with `ctx.secrets`. Two things follow, and both
 * are the point:
 *
 *   · no bypass credential is ever written to a file, so it cannot survive in a
 *     crash dump, a copied workspace or anything that reads the run directory
 *     before `cleanup()`;
 *   · NO NEW ENVIRONMENT VARIABLE EXISTS. The only name read is the customer's
 *     own vault entry, which the child already received. An extra header
 *     belongs on a customer-owned row, and this is the whole way down from that
 *     row to the request.
 *
 * Every name goes through `JSON.stringify`, because a header name and a vault
 * entry name are both customer-controlled strings that become source code here.
 * The header name is additionally validated against `HEADER_NAME_RE` upstream;
 * a vault entry name is not constrained at all, which is exactly why it is
 * quoted rather than interpolated bare.
 */
export function extraHttpHeadersSource(
  entries: ResolvedEnvironmentHeaders['entries'],
): string {
  const pairs = entries.map((entry) => {
    const key = JSON.stringify(entry.name);
    if (entry.secretName !== null) {
      return `${key}: process.env[${JSON.stringify(entry.secretName)}]`;
    }
    return `${key}: ${JSON.stringify(entry.literal ?? '')}`;
  });
  return `{ ${pairs.join(', ')} }`;
}

/** A run that will not be executed because the environment cannot be reached. */
export interface BotProtectionRefusal {
  provider: BotProtectionProvider;
  /** What the environment's owner has to do, from @qaai/shared. */
  remedy: string;
  /** The whole sentence, for `TestExecution.errorMessage`. */
  message: string;
}

/**
 * Should this run be refused before a browser is launched?
 *
 * TWO WAYS TO GET HERE, and they are not the same fact:
 *
 *   NOTHING CONFIGURED   `reachabilityFromPolicy` says
 *                        UNREACHABLE_BEHIND_BOT_PROTECTION. The customer has
 *                        named a provider and no legitimate route past it.
 *   CONFIGURED, UNUSABLE a bypass mode is set and the header could not be
 *                        assembled — a missing vault entry, an illegal name.
 *                        The same wall, with a different remedy, and the one
 *                        case a naive implementation turns into "we ran it and
 *                        your app failed".
 *
 * NULL when the run may proceed. Null is not a claim that the environment is
 * reachable: `reachabilityFromPolicy` never returns REACHABLE from
 * configuration alone, and neither does this.
 */
export function botProtectionRefusal(
  policy: EnvironmentAccessPolicy,
  refusals: readonly HeaderRefusal[] = [],
): BotProtectionRefusal | null {
  const lostBypass = refusals.find((refusal) => refusal.removesTheBypass);
  if (lostBypass) {
    const remedy = botProtectionRemedy(policy.provider);
    return {
      provider: policy.provider,
      remedy,
      /*
       * Phrased without naming the provider, deliberately. A row can say
       * SIGNED_BYPASS_HEADER with provider NONE — an inconsistent row a customer
       * can save — and "sitting behind no bot protection with a signed bypass"
       * is a sentence that contradicts itself. What is true for every provider
       * is that a header this environment asked us to send could not be
       * assembled.
       */
      message:
        `${lostBypass.detail} This environment is configured to send a signed bypass header ` +
        'and that header could not be assembled, so the spec was NOT executed: every request ' +
        'would have gone out without it, and the failure would have been reported as a defect ' +
        'in your application. Nothing was measured. ' +
        remedy,
    };
  }

  const { reachability, remedy } = reachabilityFromPolicy({
    provider: policy.provider,
    bypassMode: policy.bypassMode,
  });
  if (reachability !== 'UNREACHABLE_BEHIND_BOT_PROTECTION' || !remedy) return null;

  return {
    provider: policy.provider,
    remedy,
    message:
      `This environment is behind ${policy.provider === 'UNKNOWN' ? 'a bot defence we could not attribute' : policy.provider} ` +
      'and no test keys, signed bypass header or allowlist is configured for it, so the ' +
      'spec was NOT executed. Nothing was measured — this is an access problem, not a ' +
      'result about your application, and it is NOT a statement that the surface behind ' +
      'the wall is empty. ' +
      remedy,
  };
}

/**
 * Challenge markers, for ATTRIBUTION ONLY.
 *
 * Each entry is a string the provider itself puts on the wire or in its widget
 * URL, documented by that provider. The list exists so a run that was actually
 * measuring a challenge page says so with evidence, instead of reporting
 * REJECTED and blaming our credentials — which is the wrong fault on the wrong
 * party, the exact attribution error `LOGIN_FAILURE_FAULT` was written for.
 *
 * NOTHING HERE DEFEATS A CHALLENGE. There is no entry that is a solver
 * endpoint, a token format or a cookie to forge; recognising a wall is not
 * climbing it. The markers are deliberately narrow and literal — a generic
 * phrase like "access denied" would attribute a WAF to every 403 in the world
 * and a false attribution is worse than an unattributed one.
 */
export const CHALLENGE_SIGNALS: ReadonlyArray<{
  provider: BotProtectionProvider;
  /** The literal shown as evidence. */
  signal: string;
}> = [
  { provider: 'TURNSTILE', signal: 'challenges.cloudflare.com' },
  { provider: 'TURNSTILE', signal: 'cf-mitigated' },
  { provider: 'RECAPTCHA', signal: 'recaptcha/api2' },
  { provider: 'RECAPTCHA', signal: 'www.google.com/recaptcha' },
  { provider: 'HCAPTCHA', signal: 'js.hcaptcha.com' },
  { provider: 'HCAPTCHA', signal: 'hcaptcha.com/captcha' },
  { provider: 'WAF', signal: 'x-amzn-waf-action' },
  { provider: 'WAF', signal: 'awswaf.com' },
];

/**
 * The first documented challenge marker in some run output, or null.
 *
 * Null means NO MARKER WAS SEEN — not "there was no challenge". The function
 * reads a failure message and a process's stdout, which is a narrow keyhole: a
 * challenge that renders without naming its provider leaves nothing to match,
 * and a detector that guessed in that case would be the lie this is written to
 * avoid. Challenge CLASSIFICATION proper belongs to the crawl's observer, which
 * can see response headers; this is the harness reporting what it happened to
 * have in front of it.
 */
export function challengeSignalIn(
  text: string,
): { provider: BotProtectionProvider; signal: string } | null {
  const haystack = text.toLowerCase();
  for (const candidate of CHALLENGE_SIGNALS) {
    if (haystack.includes(candidate.signal.toLowerCase())) {
      return { provider: candidate.provider, signal: candidate.signal };
    }
  }
  return null;
}

/**
 * The disclosure appended to a failure whose output carried a challenge marker.
 *
 * APPENDED, never substituted: the test really did fail, and the assertion that
 * failed is still the most useful line in the report. What this adds is that
 * the thing being asserted on may have been a challenge page rather than the
 * application — with the marker quoted, so a reader can check the claim.
 */
export function challengeNote(seen: {
  provider: BotProtectionProvider;
  signal: string;
}): string {
  return (
    `A ${seen.provider} challenge marker ("${seen.signal}") appeared in this run's output, so ` +
    'the assertions above may have been evaluated against a challenge page rather than ' +
    'your application. Treat this result as UNDETERMINED until the environment is ' +
    `reachable. ${botProtectionRemedy(seen.provider)}`
  );
}

const CONFIG_TEMPLATE = (opts: {
  baseUrl: string;
  timeoutMs: number;
  retryOnce: boolean;
  outputDir: string;
  /** Cloud grid websocket endpoint. Credential-bearing — never logged. */
  gridWsEndpoint?: string | null;
  /**
   * One Playwright project per browser or locale. Cross-browser and
   * localisation are the same mechanism — run the identical spec under a
   * different `use` block — so they share this rather than forking the harness.
   */
  projects?: Array<{ name: string; browserName?: string; locale?: string; timezoneId?: string }>;
  /**
   * Determinism's timezone/locale pinning. It goes in the top-level `use` block
   * rather than into every project, so a localisation matrix that names its own
   * locale still wins — Playwright merges project `use` over the root, and a
   * run that deliberately varies locale must not be flattened by a knob whose
   * job is only to stop the *ambient* machine leaking in.
   */
  timezoneId?: string | null;
  locale?: string | null;
  /**
   * The per-environment headers, as the source {@link extraHttpHeadersSource}
   * built. A vault-backed value is a `process.env[...]` reference in it and
   * never the value, so no credential reaches this file.
   */
  extraHttpHeaders?: string | null;
}) => `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  // One retry, always — but a retry that passes is reported as FLAKY, never as
  // a pass (§5). The gate treats it accordingly.
  retries: ${opts.retryOnce ? 1 : 0},
  workers: 1,
  reporter: [['json', { outputFile: 'report.json' }]],
  timeout: ${opts.timeoutMs},
  outputDir: ${JSON.stringify(opts.outputDir)},${
    opts.projects?.length
      ? `
  projects: [
${opts.projects
  .map(
    (p) =>
      `    { name: ${JSON.stringify(p.name)}, use: { ${[
        p.browserName ? `...devices[${JSON.stringify(deviceFor(p.browserName))}]` : null,
        p.locale ? `locale: ${JSON.stringify(p.locale)}` : null,
        p.timezoneId ? `timezoneId: ${JSON.stringify(p.timezoneId)}` : null,
      ]
        .filter(Boolean)
        .join(', ')} } },`,
  )
  .join('\n')}
  ],`
      : ''
  }
  use: {
    baseURL: ${JSON.stringify(opts.baseUrl)},${
      opts.timezoneId
        ? `
    // Pinned by the determinism kit — the worker's own zone must not decide
    // whether a date rolls over mid-suite.
    timezoneId: ${JSON.stringify(opts.timezoneId)},`
        : ''
    }${
      opts.locale
        ? `
    locale: ${JSON.stringify(opts.locale)},`
        : ''
    }${
      opts.gridWsEndpoint
        ? `
    // Runs on a cloud grid instead of this machine's browser (§6).
    connectOptions: { wsEndpoint: ${JSON.stringify(opts.gridWsEndpoint)} },`
        : ''
    }
${
      opts.extraHttpHeaders
        ? `
    // Per-environment headers — the customer's own, plus the signed bypass
    // header their own edge issues. A credential-bearing value is read from
    // this process's environment by the name of the vault entry holding it;
    // nothing about a challenge is solved, replayed or evaded here.
    extraHTTPHeaders: ${opts.extraHttpHeaders},`
        : ''
    }
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});
`;

async function createWorkspace(
  ctx: RunContext,
  test: ExecutableTest,
  plan: DeterminismPlan,
  projects?: HarnessOptions['projects'],
  extraHttpHeaders: string | null = null,
): Promise<Workspace> {
  await mkdir(runsRoot, { recursive: true });
  const dir = await mkdtemp(join(runsRoot, 'run-'));
  const outputDir = join(dir, 'artifacts');
  await mkdir(join(dir, 'tests'), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const specPath = safeSpecPath(dir, test.filePath);
  await mkdir(dirname(specPath), { recursive: true });

  /*
   * The runtime observer is appended LAST, after determinism has had its turn
   * at the code: `plan.code` is `test.code` verbatim unless the run asked for
   * determinism, and the observer must watch whatever is actually going to run.
   *
   * A spec that drives no browser is left byte-identical. The epilogue
   * destructures the `page` fixture, and requesting `page` LAUNCHES A BROWSER —
   * so injecting it into an API-only spec would add a browser launch the test
   * never asked for, and would fail it outright on a worker with no Chromium.
   */
  let observeDir: string | null = null;
  if (specUsesBrowser(plan.code)) {
    observeDir = join(dir, 'observations');
    await mkdir(observeDir, { recursive: true });
  }
  await writeFile(
    specPath,
    observeDir === null ? plan.code : `${plan.code}${runtimeObserverEpilogue(observeDir)}`,
    'utf8',
  );

  await writeFile(
    join(dir, 'playwright.config.ts'),
    CONFIG_TEMPLATE({
      baseUrl: ctx.baseUrl,
      timeoutMs: test.timeoutMs,
      retryOnce: ctx.determinism.retryOnce,
      outputDir,
      gridWsEndpoint: ctx.grid?.wsEndpoint ?? null,
      projects,
      timezoneId: plan.determinism.timezoneId,
      locale: plan.determinism.locale,
      extraHttpHeaders,
    }),
    'utf8',
  );

  // Test data, so a spec can read `fixtures/users.json` off disk. Written into
  // every workspace: each run gets a fresh temp dir holding only its own spec,
  // so a fixture that is not copied in simply would not exist at run time.
  for (const [fixturePath, content] of Object.entries(ctx.fixtures ?? {})) {
    const target = safeFixturePath(dir, fixturePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /*
   * The session this spec runs under (§2), named after the auth profile that
   * produced it.
   *
   * There used to be one file called `storage-state.json` holding the one
   * session a run had. Tests now carry their own `authProfileId` and the worker
   * resolves a session per profile, so the file is keyed by profile id: two
   * tests on the same profile write identical bytes under the same name, two
   * tests on different profiles can never write the same name, and the identity
   * a verdict was produced under is visible in the workspace and in the child's
   * environment rather than being implied. The id is a cuid, but it becomes a
   * real filename, so it is sanitised like any other untrusted path component.
   */
  let storageStatePath: string | null = null;
  if (ctx.storageState) {
    storageStatePath = join(dir, storageStateFileName(suppliedAuthProfileId(ctx)));
    await writeFile(storageStatePath, JSON.stringify(ctx.storageState), 'utf8');
  }

  return {
    dir,
    specPath,
    outputDir,
    reportPath: join(dir, 'report.json'),
    storageStatePath,
    observeDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ─── Execution ───────────────────────────────────────────────────────────────

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runPlaywright(
  ws: Workspace,
  ctx: RunContext,
  plan: DeterminismPlan,
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const d = plan.determinism;
    const child = spawn(cliPath, ['test', '--config', 'playwright.config.ts'], {
      cwd: ws.dir,
      // Allowlisted, not inherited. A generated spec is tenant-authored code and
      // this worker holds VAULT_MASTER_KEY, SESSION_SECRET and DATABASE_URL —
      // spreading process.env here handed every customer's keys to every test.
      // See child-env.ts.
      env: childEnv({
        extra: {
          QAAI_BASE_URL: ctx.baseUrl,
          QAAI_RUN_ID: ctx.runId,
          QAAI_STORAGE_STATE: ws.storageStatePath ?? '',
          // Which identity this spec is running as. A spec does not need it,
          // but a failure that reads "403 Forbidden" is a different bug
          // depending on the answer, and it is otherwise unrecoverable from the
          // artifacts.
          QAAI_AUTH_PROFILE: suppliedAuthProfileId(ctx) ?? '',
          // The seed the run actually used, so a spec that generates its own data
          // reads the same number that decided the test order.
          QAAI_SEED: String(d.seed),
          QAAI_DETERMINISM_SEED: String(d.seed),
          ...(d.clockAtIso ? { QAAI_FROZEN_CLOCK: d.clockAtIso } : {}),
          // Node reads TZ at startup, and the test process formats dates too —
          // pinning only the browser would leave the assertions in a different
          // zone from the page they are asserting on.
          ...(d.timezoneId ? { TZ: d.timezoneId } : {}),
          CI: '1',
        },
        // Secrets reach the test process as env vars — never inlined into the
        // generated source, which gets committed to the customer's repo.
        secrets: ctx.secrets,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROCESS_TIMEOUT_MS);

    // Cooperative cancellation from the queue (§5).
    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

/** Uploads everything Playwright dropped in the output dir and returns the keys. */
async function uploadArtifacts(
  ws: Workspace,
  ctx: RunContext,
  testId: string,
): Promise<{ videoKey: string | null; traceKey: string | null; screenshotKeys: string[] }> {
  let videoKey: string | null = null;
  let traceKey: string | null = null;
  const screenshotKeys: string[] = [];

  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else files.push(full);
    }
    return files;
  };

  for (const file of await walk(ws.outputDir)) {
    const rel = relative(ws.outputDir, file).replace(/[/\\]/g, '_');
    const name = `${testId}_${rel}`;
    try {
      if (file.endsWith('.webm')) {
        videoKey = await ctx.artifacts.putFile(name, file, 'video/webm');
      } else if (file.endsWith('.zip')) {
        traceKey = await ctx.artifacts.putFile(name, file, 'application/zip');
      } else if (file.endsWith('.png')) {
        screenshotKeys.push(await ctx.artifacts.putFile(name, file, 'image/png'));
      }
    } catch (err) {
      ctx.logger.warn('artifact upload failed', { file, err: String(err) });
    }
  }

  return { videoKey, traceKey, screenshotKeys };
}

/**
 * One test's verdict: its final attempt, and whether it needed a retry to pass.
 *
 * `retry` is per TEST in Playwright's report, and a spec file holds many tests.
 * Flattening every result in the file into one list and asking "did the last one
 * pass after an earlier one failed" answers a different question — with two
 * tests where the FIRST fails and the second passes, that list is
 * [failed, passed] and the run is reported FLAKY. A real, deterministic,
 * repeatable failure downgraded to a flake, which is precisely the signal §5
 * exists to protect. Order randomisation makes it routine: shuffling only means
 * anything in a file with several tests, and it moves the failing one off the
 * end on purpose.
 */
interface TestOutcome {
  final: PwResult | undefined;
  retriedAndPassed: boolean;
}

function outcomeFor(test: PwTest): TestOutcome {
  const results = test.results;
  const final = results[results.length - 1];
  return {
    final,
    // §5: a retry that passes is a flake candidate, not a pass.
    retriedAndPassed:
      results.length > 1 &&
      final?.status === 'passed' &&
      results.some((r) => r.status === 'failed' || r.status === 'timedOut'),
  };
}

/** Worst-wins, so one failing test is never masked by the ones that passed. */
const STATUS_SEVERITY: Record<TestResultStatus, number> = {
  TIMED_OUT: 4,
  FAILED: 3,
  FLAKY: 2,
  PASSED: 1,
  SKIPPED: 0,
};

function mapStatus(result: PwResult | undefined, retriedAndPassed: boolean): TestResultStatus {
  if (retriedAndPassed) return 'FLAKY';
  switch (result?.status) {
    case 'passed':
      return 'PASSED';
    case 'timedOut':
      return 'TIMED_OUT';
    case 'skipped':
      return 'SKIPPED';
    case 'interrupted':
    case 'failed':
      return 'FAILED';
    default:
      return 'FAILED';
  }
}

function toStepResults(
  steps: PwStep[],
  screenshotKeys: string[],
  failingIndex: number | null,
): StepResult[] {
  return steps.map((step, index) => {
    const failed = Boolean(step.error);
    return {
      index,
      title: step.title,
      status: failed ? 'FAILED' : 'PASSED',
      startedAt: step.startTime ?? new Date().toISOString(),
      durationMs: Math.round(step.duration ?? 0),
      // Playwright only screenshots on failure, so the one capture we have
      // belongs to the failing step. Full per-step frames live in the trace.
      screenshotKey: index === failingIndex ? (screenshotKeys[0] ?? null) : null,
      error: failed ? parseStepError(step.error!) : null,
    };
  });
}

/**
 * Pulls expected/actual and the failing locator out of Playwright's error text.
 * These feed the Triage prompt, which is far more accurate when it can see what
 * the test wanted versus what it got instead of just a stack trace.
 */
function parseStepError(err: PwErrorish): NonNullable<StepResult['error']> {
  const message = stripAnsi(err.message ?? 'Step failed');
  return {
    message,
    stack: err.stack ? stripAnsi(err.stack) : null,
    selector: /(?:locator|getBy\w+)\((.*?)\)/.exec(message)?.[0] ?? null,
    expected: /Expected(?: string| value| pattern)?:\s*(.+)/.exec(message)?.[1]?.trim() ?? null,
    actual: /Received(?: string| value)?:\s*(.+)/.exec(message)?.[1]?.trim() ?? null,
  };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex -- stripping terminal colour codes
  return input.replace(/\[[0-9;]*m/g, '');
}

/**
 * Playwright writes console and network into the trace, not the JSON report.
 * Rather than unzip the trace on every run, we surface stdout/stderr the test
 * produced and leave the full record to the embedded trace viewer.
 */
function toConsoleEntries(result: PwResult | undefined): ConsoleEntry[] {
  const at = new Date().toISOString();
  const out: ConsoleEntry[] = [];
  for (const line of result?.stdout ?? []) {
    if (line.text?.trim()) out.push({ level: 'log', text: stripAnsi(line.text).trim(), at });
  }
  for (const line of result?.stderr ?? []) {
    if (line.text?.trim()) out.push({ level: 'error', text: stripAnsi(line.text).trim(), at });
  }
  return out;
}

// ─── Runtime observation: what the test ACTUALLY did ─────────────────────────

/*
 * THE DEFECT THIS SECTION EXISTS TO REMOVE.
 *
 * Until this existed, `TestExecution.network` was filled with `[]` on every one
 * of this harness's paths and `findings` with `[]` on all three — so the only
 * question the product could answer was "which crawled surface does a test
 * MENTION", a regex over test source. "A test mentions /checkout" and "a test
 * reached /checkout and called POST /api/pay" are different claims, and only the
 * second one is coverage. Four separate confirmed defects traced back to those
 * two empty arrays.
 *
 * It also removes a quieter one: a GREEN test over a THROWING application was
 * reported as covered and healthy. The assertions passed; the page threw a
 * TypeError, logged four console errors and got a 500 from POST /api/pay, and
 * nothing in the product knew. Those signals are free — the browser already
 * emits them — and this section turns them into Findings whether the test
 * passed or failed.
 *
 * ── HOW IT OBSERVES, and why not the other three ways ───────────────────────
 *
 * This harness shells out to the real Playwright CLI (see the file header), so
 * it holds no `page` of its own. Three sources were measured against a live
 * Chromium before this was written, and two of them do not work:
 *
 *  - THE JSON REPORT carries no page events and, measured on Playwright 1.62,
 *    NO `pw:api` STEPS AT ALL: a spec that calls `page.goto`, `click` and
 *    `fill` produces `results[0].steps === []`. So locators cannot come from
 *    the reporter, which is why `collectUserSteps` is left exactly as it was.
 *  - THE TRACE has everything, and is a zip this package has no reader for, and
 *    `trace: 'retain-on-failure'` deletes it on the runs requirement 2 cares
 *    about most — the ones that PASSED.
 *  - `recordHar` in `contextOptions` writes ONE path per config, and a spec file
 *    holds many tests, each with its own context. Last-test-wins silently loses
 *    every other test's network, which is worse than not measuring.
 *
 * So observation is an EPILOGUE appended to the spec inside the throwaway run
 * workspace — the same mechanism `har.ts` already uses for hermetic replay, and
 * for the same reason: it is the only place with a `page`. The spec QAAI stores
 * and exports stays a plain Playwright spec with no QAAI import in it.
 *
 * ── THE SPLIT THAT KEEPS THIS TESTABLE ──────────────────────────────────────
 *
 * The injected code is DUMB on purpose: it forwards raw events as NDJSON and
 * counts what it dropped. Every classification decision — what is a finding,
 * what is a duplicate, what is a deliberate 403, what a URL template is — lives
 * in the pure functions below and is unit-tested against fake NDJSON with no
 * browser and no network. {@link RuntimeObservationSource} is the one seam that
 * touches the disk, and a fake satisfies it in one line.
 *
 * ── WHAT IS NEVER RECORDED ──────────────────────────────────────────────────
 *
 * No request body, no response body, no header value, no cookie, and no value
 * passed to `fill`/`type` — the ACTION and the LOCATOR are recorded, never the
 * keystrokes, because a login test types a password. Query strings are stripped
 * from every URL before it is written, because a reset link is a credential.
 * `observationCarriesNoSecrets` asserts this over a hostile record set rather
 * than trusting the reader of this comment.
 */

/** Stamped into the injected source so a compile error in it is attributable. */
export const RUNTIME_OBSERVER_MARKER = 'qaai-runtime-observer';

/**
 * Per-test ceilings, applied INSIDE the browser process.
 *
 * A chatty single-page app emits thousands of console errors from one render
 * loop. Without a cap the NDJSON grows without bound and the finding list
 * becomes unreadable; with an UNDISCLOSED cap, QAAI would silently truncate a
 * defect list, which is the one thing a defect list may never do. So every cap
 * that BIT is reported as a count and a reason — see {@link ObservedCap} — and
 * the counts come from the browser process, which is the only place that knows
 * how many it threw away.
 */
export const RUNTIME_OBSERVATION_CAPS = {
  /** Document navigations recorded per test. */
  nav: 50,
  /** Requests recorded per test, before dedupe. */
  req: 400,
  /** Control interactions recorded per test. */
  ctl: 200,
  /** Browser console entries recorded per test. */
  console: 100,
} as const;

export type ObservationCapKind = keyof typeof RUNTIME_OBSERVATION_CAPS;

/**
 * Findings per invariant, applied harness-side AFTER dedupe.
 *
 * Separate from the browser-side caps above because they measure different
 * things: those bound what was recorded, this bounds what is reported. Both are
 * disclosed; a reader who sees twenty `runtime.console-error` findings needs to
 * know whether that was all of them.
 */
export const RUNTIME_FINDING_CAP = 20;

/** The eight runtime invariants every browser test is checked against. */
export const RUNTIME_INVARIANTS = [
  'PAGE_ERROR',
  'UNHANDLED_REJECTION',
  'CONSOLE_ERROR',
  'REQUEST_FAILED',
  'HTTP_CLIENT_ERROR',
  'HTTP_SERVER_ERROR',
  'MIXED_CONTENT',
  'CSP_VIOLATION',
] as const;
export type RuntimeInvariant = (typeof RUNTIME_INVARIANTS)[number];

/**
 * Compiler-enforced presence: a ninth invariant that forgets its severity, its
 * kind or its code does not compile.
 *
 * This is the pattern this codebase enforces for any vocabulary with a write
 * path, and it is here because eight GateRule kinds once shipped unsaveable for
 * two slices with only half of it in place. The run-time half — that these four
 * records and the array agree, member for member — is
 * `every runtime invariant is declared once, in all four places` in the tests.
 */
const RUNTIME_INVARIANT_PRESENT: Record<RuntimeInvariant, true> = {
  PAGE_ERROR: true,
  UNHANDLED_REJECTION: true,
  CONSOLE_ERROR: true,
  REQUEST_FAILED: true,
  HTTP_CLIENT_ERROR: true,
  HTTP_SERVER_ERROR: true,
  MIXED_CONTENT: true,
  CSP_VIOLATION: true,
};

/** Stable dedupe ids. `runtime.` prefixed so a gate can filter the family. */
const RUNTIME_INVARIANT_CODE: Record<RuntimeInvariant, string> = {
  PAGE_ERROR: 'runtime.page-error',
  UNHANDLED_REJECTION: 'runtime.unhandled-rejection',
  CONSOLE_ERROR: 'runtime.console-error',
  REQUEST_FAILED: 'runtime.request-failed',
  HTTP_CLIENT_ERROR: 'runtime.http-4xx',
  HTTP_SERVER_ERROR: 'runtime.http-5xx',
  MIXED_CONTENT: 'runtime.mixed-content',
  CSP_VIOLATION: 'runtime.csp-violation',
};

const RUNTIME_INVARIANT_SEVERITY: Record<RuntimeInvariant, FindingSeverity> = {
  // An uncaught exception is a defect whether or not the assertions noticed.
  PAGE_ERROR: 'SERIOUS',
  UNHANDLED_REJECTION: 'SERIOUS',
  // A console error is often a symptom rather than the defect, so it ranks
  // below the exception that may have caused it.
  CONSOLE_ERROR: 'MODERATE',
  REQUEST_FAILED: 'MODERATE',
  // A 4xx is frequently the application behaving correctly about a bad request,
  // which is why this one is MODERATE and why the deliberate-assertion filter
  // below exists at all. A 5xx is never correct.
  HTTP_CLIENT_ERROR: 'MODERATE',
  HTTP_SERVER_ERROR: 'SERIOUS',
  MIXED_CONTENT: 'SERIOUS',
  CSP_VIOLATION: 'SERIOUS',
};

/**
 * KNOWN TAXONOMY GAP, stated here rather than hidden in the mapping.
 *
 * `FINDING_KINDS` has five members — ACCESSIBILITY, SECURITY, PERFORMANCE,
 * LOCALIZATION, VISUAL — and the Prisma `FindingKind` enum has the same five.
 * NONE of them means "the application threw, logged an error or returned a 500
 * while a test drove it". CSP and mixed content are genuinely SECURITY. The
 * other six are carried under SECURITY because a `Finding` must name a kind and
 * there is no honest one yet; their `code` is `runtime.*` so they remain
 * filterable, and a `RUNTIME` member is in this round's handover. When it lands,
 * only this record changes.
 *
 * Written as a per-member map and not a default so that the compromise is
 * visible at every one of the six sites rather than implied once.
 */
const RUNTIME_INVARIANT_KIND: Record<RuntimeInvariant, FindingKind> = {
  PAGE_ERROR: 'SECURITY',
  UNHANDLED_REJECTION: 'SECURITY',
  CONSOLE_ERROR: 'SECURITY',
  REQUEST_FAILED: 'SECURITY',
  HTTP_CLIENT_ERROR: 'SECURITY',
  HTTP_SERVER_ERROR: 'SECURITY',
  MIXED_CONTENT: 'SECURITY',
  CSP_VIOLATION: 'SECURITY',
};

/**
 * Whether this test's runtime behaviour was observed, and when it was not, WHY.
 *
 * `UNAVAILABLE` is the state that matters: it is what an absent observer must
 * report, and it must never collapse into "nothing happened". A test whose app
 * threw four exceptions and a test QAAI could not watch look identical from the
 * outside — zero findings — and only this field tells them apart.
 */
export const OBSERVATION_STATES = [
  'OBSERVED',
  'PARTIAL',
  'UNAVAILABLE',
  'NOT_APPLICABLE',
] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

const OBSERVATION_STATE_PRESENT: Record<ObservationState, true> = {
  OBSERVED: true,
  PARTIAL: true,
  UNAVAILABLE: true,
  NOT_APPLICABLE: true,
};

export interface ObservationAvailability {
  state: ObservationState;
  /** A sentence a reader can act on. Never null unless the state is OBSERVED. */
  reason: string | null;
}

/** A ceiling that BIT, as a count and a reason. Never one without the other. */
export interface ObservedCap {
  kind: ObservationCapKind | 'finding' | 'query' | 'malformed' | 'unreadable';
  /** The ceiling, or null for `query`/`malformed`, which drop rather than cap. */
  limit: number | null;
  dropped: number;
  reason: string;
}

/** Which identity produced an observation: the test, and the project variant. */
export interface ObservationAttribution {
  test: string;
  /** The Playwright project. `default` when the run declared no projects. */
  variant: string;
}

export interface ObservedNavigation extends ObservationAttribution {
  /** Every hop before the final one, in order. Empty when nothing redirected. */
  redirectChain: string[];
  /** Where the browser settled, as a template. */
  finalUrl: string;
  status: number | null;
}

export const OBSERVED_TRANSPORTS = [
  'DOCUMENT',
  'XHR',
  'FETCH',
  'WEBSOCKET',
  'SSE',
  'OTHER',
] as const;
export type ObservedTransport = (typeof OBSERVED_TRANSPORTS)[number];

export interface ObservedRequest extends ObservationAttribution {
  method: string;
  /** `/orders/:id`, never `/orders/8f21?token=…`. See {@link urlTemplate}. */
  template: string;
  status: number | null;
  transport: ObservedTransport;
  /**
   * How long the request took, or NULL when the browser had no timing for it.
   * Null and not zero: see {@link positiveMs}.
   */
  ms: number | null;
  /** How many times this test hit this method+template+status triple. */
  count: number;
}

export interface ObservedControl extends ObservationAttribution {
  /** The Playwright action that ran: `click`, `fill`, `selectOption`. */
  action: string;
  /**
   * The locator that resolved it, verbatim from Playwright's own
   * `Locator.toString()` — `getByRole('button', { name: 'Pay' })`. Never the
   * value typed into it.
   */
  locator: string;
  count: number;
}

/** One test's runtime-observed surface. The evidence under RUNTIME coverage. */
export interface RuntimeObservation {
  testId: string;
  availability: ObservationAvailability;
  /** Every (test, variant) pair that reported. Empty when nothing did. */
  attribution: ObservationAttribution[];
  navigations: ObservedNavigation[];
  requests: ObservedRequest[];
  controls: ObservedControl[];
  /** Every cap that bit. Empty means none did, not "we did not check". */
  caps: ObservedCap[];
}

// ─── The NDJSON the injected observer writes ─────────────────────────────────

/**
 * Deliberately narrow and deliberately short-keyed: these lines are written one
 * `appendFileSync` at a time from inside a test, and the shape is ours on both
 * ends. Parsed structurally rather than with zod because a malformed line must
 * be COUNTED and skipped, never thrown — losing a whole test's observation to
 * one bad line is a worse outcome than reporting nine records and one drop.
 */
interface ObsAttach {
  t: 'attach';
  test: string;
  variant: string;
}
interface ObsNav {
  t: 'nav';
  url: string;
}
interface ObsReq {
  t: 'req';
  method: string;
  url: string;
  status: number | null;
  rt: string;
  nav: boolean;
  chain: string[];
  /** The document URL the request was made from, for the mixed-content check. */
  from: string;
}

/**
 * How long a request took, as a record of its own.
 *
 * MEASURED, not guessed — and measured on the only event that has it. At the
 * `response` event `request.timing().responseEnd` is -1 and only `responseStart`
 * is populated; `responseEnd` lands at `requestfinished`. (Measured against
 * Chromium 1.62, not inferred from the docs.) Reporting `responseStart` as a
 * duration would have labelled time-to-first-byte as the whole request, so the
 * timing comes from the later event and is correlated back by method+template.
 *
 * A request that never finished — still in flight when the context closed, or
 * failed outright — emits no `requestfinished` and therefore no record here,
 * which is how its duration stays NULL instead of becoming 0.
 */
interface ObsTiming {
  t: 'timing';
  method: string;
  url: string;
  ms: number;
}
interface ObsReqFail {
  t: 'reqfail';
  method: string;
  url: string;
  err: string;
  from: string;
}
interface ObsConsole {
  t: 'console';
  level: string;
  text: string;
  from: string;
}
interface ObsPageError {
  t: 'pageerror';
  name: string;
  message: string;
  from: string;
}
interface ObsWebSocket {
  t: 'ws';
  url: string;
}
interface ObsControl {
  t: 'ctl';
  action: string;
  locator: string;
}
interface ObsCap {
  t: 'cap';
  k: string;
  limit: number;
  dropped: number;
}
/**
 * An observation file that EXISTED and could not be read.
 *
 * Written by the reader, not by the browser, and it is the only record here
 * that QAAI produces about itself. Without it an unreadable file contributed
 * zero lines, the parser counted zero malformed, and the result came back
 * OBSERVED with no requests and no caps — a test whose application threw four
 * exceptions looking identical to one whose evidence QAAI dropped on the floor.
 * Measured: the file source returned an empty array and the availability read
 * OBSERVED. That is the pass that means we did not check, inside the very
 * section built to remove it.
 */
interface ObsUnreadable {
  t: 'unreadable';
  file: string;
}

type ObsRecord =
  | ObsAttach
  | ObsNav
  | ObsReq
  | ObsReqFail
  | ObsConsole
  | ObsPageError
  | ObsWebSocket
  | ObsControl
  | ObsTiming
  | ObsCap
  | ObsUnreadable;

/** One record plus the attribution in force when it was written. */
export interface StampedRecord {
  record: ObsRecord;
  who: ObservationAttribution;
}

/** The attribution used for records that arrived before any `attach` line. */
const UNATTRIBUTED: ObservationAttribution = { test: '(unattributed)', variant: 'default' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A duration, or null.
 *
 * Playwright reports -1 for a timing it does not have, and -1 must not become a
 * duration and must not become 0 either: "not measured" is null here and stays
 * null all the way to the disclosure in {@link observedNetworkEntries}.
 */
function positiveMs(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null || parsed < 0 ? null : Math.round(parsed);
}

/**
 * NDJSON in, stamped records out, with every line we could not read counted.
 *
 * `malformed` is returned rather than logged because it is the difference
 * between "this test made no requests" and "this test's observation file was
 * truncated", and a reader of the result has to be able to tell.
 */
export function parseObservationLines(lines: readonly string[]): {
  records: StampedRecord[];
  malformed: number;
} {
  const records: StampedRecord[] = [];
  let malformed = 0;
  let who = UNATTRIBUTED;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isObject(parsed)) {
      malformed += 1;
      continue;
    }

    const t = parsed['t'];
    switch (t) {
      case 'attach': {
        // Attribution is positional: every record after this line belongs to
        // this test until the next `attach`. A worker runs one test at a time,
        // which is what makes that sound — `workers: 1` in CONFIG_TEMPLATE, and
        // one file per process so two workers cannot interleave into one file.
        who = {
          test: str(parsed['test'], UNATTRIBUTED.test),
          variant: str(parsed['variant']) || 'default',
        };
        records.push({ record: { t: 'attach', ...who }, who });
        break;
      }
      case 'nav':
        records.push({ record: { t: 'nav', url: str(parsed['url']) }, who });
        break;
      case 'req':
        records.push({
          record: {
            t: 'req',
            method: str(parsed['method'], 'GET'),
            url: str(parsed['url']),
            status: num(parsed['status']),
            rt: str(parsed['rt']),
            nav: parsed['nav'] === true,
            chain: strList(parsed['chain']),
            from: str(parsed['from']),
          },
          who,
        });
        break;
      case 'reqfail':
        records.push({
          record: {
            t: 'reqfail',
            method: str(parsed['method'], 'GET'),
            url: str(parsed['url']),
            err: str(parsed['err']),
            from: str(parsed['from']),
          },
          who,
        });
        break;
      case 'console':
        records.push({
          record: {
            t: 'console',
            level: str(parsed['level']),
            text: str(parsed['text']),
            from: str(parsed['from']),
          },
          who,
        });
        break;
      case 'pageerror':
        records.push({
          record: {
            t: 'pageerror',
            name: str(parsed['name'], 'Error'),
            message: str(parsed['message']),
            from: str(parsed['from']),
          },
          who,
        });
        break;
      case 'ws':
        records.push({ record: { t: 'ws', url: str(parsed['url']) }, who });
        break;
      case 'timing': {
        const ms = positiveMs(parsed['ms']);
        if (ms === null) {
          // -1 is Playwright for "no timing". It is dropped rather than stored,
          // so nothing downstream can mistake it for a duration.
          malformed += 1;
          break;
        }
        records.push({
          record: { t: 'timing', method: str(parsed['method'], 'GET'), url: str(parsed['url']), ms },
          who,
        });
        break;
      }
      case 'ctl':
        records.push({
          record: { t: 'ctl', action: str(parsed['action']), locator: str(parsed['locator']) },
          who,
        });
        break;
      case 'unreadable':
        records.push({ record: { t: 'unreadable', file: str(parsed['file']) }, who });
        break;
      case 'cap': {
        const limit = num(parsed['limit']);
        const dropped = num(parsed['dropped']);
        if (limit === null || dropped === null) {
          malformed += 1;
          break;
        }
        records.push({ record: { t: 'cap', k: str(parsed['k']), limit, dropped }, who });
        break;
      }
      default:
        malformed += 1;
    }
  }

  return { records, malformed };
}

// ─── URL templates ───────────────────────────────────────────────────────────

/**
 * Is this path segment an identifier rather than a route?
 *
 * Deliberately CONSERVATIVE. Over-eager matching collapses `/checkout` and
 * `/settings` into `:id` and the whole runtime surface becomes one route, which
 * would make the coverage denominator look complete because the extractor got
 * worse — precisely the failure mode the UNKNOWN rule exists to prevent. So
 * only shapes that cannot be a hand-written route match: digits, a uuid, hex of
 * 24 characters or more, a cuid, and a long mixed-case token.
 *
 * What that LEAVES is the known cost, and it is the cost in the safe direction:
 * a short opaque id like `/receipt/8f21` is not collapsed, so one route per
 * receipt reaches the surface instead of one `/receipt/:id`. Over-eager
 * matching would be the expensive mistake — it collapses `/checkout` and
 * `/settings` into `:id` and makes the denominator look complete because the
 * extractor got worse.
 */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{24,}$/i.test(segment)) return true;
  if (/^c[a-z0-9]{24,}$/.test(segment)) return true;
  if (segment.length >= 16 && /\d/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment))
    return true;
  return false;
}

/**
 * A URL as a stable template, with the query string GONE.
 *
 * The query is not truncated or masked, it is dropped, and the drop is counted
 * and disclosed: a password-reset link, a signed download, an OAuth code and a
 * session token all live in query strings, and this value is written to an
 * artifact, stored on the execution and rendered in the cockpit. The path is
 * what the surface denominator is keyed on anyway.
 *
 * Same-origin URLs become a path (`/orders/:id`); cross-origin keeps its host
 * (`https://api.stripe.com/v1/charges`), because "this test called Stripe" is a
 * different and more interesting fact than "this test called /v1/charges".
 */
export function urlTemplate(raw: string, baseUrl: string): { template: string; hadQuery: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw, baseUrl || undefined);
  } catch {
    // Not a URL we can read. Returned verbatim but truncated, and never with a
    // `?` left on it — an unparseable string is the one case where dropping the
    // query cannot be done structurally.
    const cut = raw.split('?')[0] ?? raw;
    return { template: cut.slice(0, 300), hadQuery: cut.length !== raw.length };
  }

  /*
   * A scheme with no host has an OPAQUE origin, which `URL` reports as the
   * literal string "null" — so `about:blank` came out of here as "nullblank",
   * a template that is not a URL, not a route and not anything a reader could
   * act on. Those schemes are returned as themselves instead: `about:blank` is
   * where every browser context starts, and the caller filters it by name.
   */
  if (!/^(?:https?|wss?):$/.test(parsed.protocol))
    return {
      template: `${parsed.protocol}${parsed.pathname}`.slice(0, 300),
      hadQuery: parsed.search !== '' || parsed.hash !== '',
    };

  const hadQuery = parsed.search !== '' || parsed.hash !== '';
  const path =
    parsed.pathname
      .split('/')
      .map((segment) => (isIdSegment(segment) ? ':id' : segment))
      .join('/') || '/';

  let sameOrigin = false;
  try {
    sameOrigin = baseUrl !== '' && new URL(baseUrl).origin === parsed.origin;
  } catch {
    sameOrigin = false;
  }

  return { template: (sameOrigin ? path : `${parsed.origin}${path}`).slice(0, 300), hadQuery };
}

// ─── Building the observed surface ───────────────────────────────────────────

function transportFor(resourceType: string): ObservedTransport {
  switch (resourceType) {
    case 'document':
      return 'DOCUMENT';
    case 'xhr':
      return 'XHR';
    case 'fetch':
      return 'FETCH';
    case 'websocket':
      return 'WEBSOCKET';
    case 'eventsource':
      return 'SSE';
    default:
      return 'OTHER';
  }
}

/** A key that keeps two tests', and two variants', observations apart. */
function whoKey(who: ObservationAttribution): string {
  return `${who.test}\u0000${who.variant}`;
}

/**
 * The records for one test, folded into navigations, requests and controls.
 *
 * ── THE REDIRECT FOLD ──────────────────────────────────────────────────────
 *
 * Playwright reports a redirected navigation TWICE: once as the 302 for
 * `/start`, and again as the 200 for `/checkout` carrying `/start` in its
 * `redirectedFrom()` chain. Counting both would report two navigations where
 * the test performed one, and would put an intermediate hop in the surface as
 * if the test had landed there. So a 3xx document request is folded away — but
 * only when its URL actually appears in another request's chain. A redirect to
 * an origin the browser never loaded (an off-site hand-off) appears in no
 * chain, and dropping it would lose the last thing the test did.
 */
export function observedSurface(
  stamped: readonly StampedRecord[],
  options: {
    testId: string;
    baseUrl: string;
    malformed: number;
    availability: ObservationAvailability;
  },
): RuntimeObservation {
  const attribution: ObservationAttribution[] = [];
  const seenWho = new Set<string>();
  const navigations = new Map<string, ObservedNavigation>();
  const requests = new Map<string, ObservedRequest>();
  const controls = new Map<string, ObservedControl>();
  /* Summed per kind, not appended per record: a spec file holds many tests and
   * each one writes its own cap line, so appending would report the same
   * ceiling four times with four partial counts instead of once with the
   * total. */
  const browserCaps = new Map<ObservationCapKind, { limit: number; dropped: number }>();
  const caps: ObservedCap[] = [];
  const unreadable: string[] = [];
  let queryDropped = 0;
  let navDropped = 0;
  let reqDropped = 0;
  let ctlDropped = 0;

  const tpl = (raw: string): string => {
    const { template, hadQuery } = urlTemplate(raw, options.baseUrl);
    if (hadQuery) queryDropped += 1;
    return template;
  };

  // Every URL that is an intermediate hop of some other request, so the fold
  // described above can tell a swallowed 302 from a terminal one.
  const hops = new Set<string>();
  for (const { record } of stamped) {
    if (record.t === 'req') for (const url of record.chain) hops.add(url);
  }

  /* `framenavigated` URLs, kept until the end: an SPA route change emits one
   * with no document request behind it, and that is a navigation the test
   * really performed. Folded in last so a client-side hop never displaces the
   * HTTP-backed record of the same URL, which carries a status. */
  const clientNavs: Array<{ url: string; who: ObservationAttribution }> = [];

  /* Durations, keyed by who+method+template, first one wins. Correlated rather
   * than carried on the request record because the only event that HAS the
   * duration fires after the one that has the status. */
  const timings = new Map<string, number>();

  const addRequest = (
    who: ObservationAttribution,
    entry: Omit<ObservedRequest, 'test' | 'variant' | 'count'>,
    discriminator: string,
  ): void => {
    const key = `${whoKey(who)}\u0000${entry.method}\u0000${entry.template}\u0000${discriminator}`;
    const existing = requests.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (requests.size >= RUNTIME_OBSERVATION_CAPS.req) {
      reqDropped += 1;
      return;
    }
    requests.set(key, { ...who, ...entry, count: 1 });
  };

  for (const { record, who } of stamped) {
    // `cap` and `unreadable` are QAAI talking about itself, not a test
    // reporting. Attributing them would invent a test/variant pair.
    if (record.t !== 'cap' && record.t !== 'unreadable' && !seenWho.has(whoKey(who))) {
      seenWho.add(whoKey(who));
      attribution.push(who);
    }

    switch (record.t) {
      case 'req': {
        const transport = transportFor(record.rt);
        const template = tpl(record.url);

        /* An intermediate 3xx is folded away ONLY when another request names it
         * as a hop. A redirect the browser never followed to a loaded page —
         * an off-site hand-off — appears in no chain, and dropping it would
         * lose the last thing the test did. */
        const swallowed =
          record.status !== null &&
          record.status >= 300 &&
          record.status < 400 &&
          hops.has(record.url);

        if (record.nav && transport === 'DOCUMENT' && !swallowed) {
          const key = `${whoKey(who)}\u0000${template}`;
          if (!navigations.has(key)) {
            if (navigations.size >= RUNTIME_OBSERVATION_CAPS.nav) navDropped += 1;
            else
              navigations.set(key, {
                ...who,
                redirectChain: record.chain.map(tpl),
                finalUrl: template,
                status: record.status,
              });
          }
        }

        addRequest(
          who,
          { method: record.method, template, status: record.status, transport, ms: null },
          String(record.status ?? 'null'),
        );
        break;
      }
      case 'reqfail':
        // A failed request has no status and no timing, and null is the honest
        // value for both: zero would say the server answered instantly with
        // status zero.
        addRequest(
          who,
          {
            method: record.method,
            template: tpl(record.url),
            status: null,
            transport: 'OTHER',
            ms: null,
          },
          'failed',
        );
        break;
      case 'ws':
        addRequest(
          who,
          {
            method: 'GET',
            template: tpl(record.url),
            // The handshake's 101 is not on this channel, so it is not claimed.
            status: null,
            transport: 'WEBSOCKET',
            ms: null,
          },
          'ws',
        );
        break;
      case 'nav':
        clientNavs.push({ url: record.url, who });
        break;
      case 'timing': {
        const key = `${whoKey(who)}\u0000${record.method}\u0000${tpl(record.url)}`;
        if (!timings.has(key)) timings.set(key, record.ms);
        break;
      }
      case 'ctl': {
        const locator = record.locator.slice(0, 300);
        const key = `${whoKey(who)}\u0000${record.action}\u0000${locator}`;
        const existing = controls.get(key);
        if (existing) existing.count += 1;
        else if (controls.size >= RUNTIME_OBSERVATION_CAPS.ctl) ctlDropped += 1;
        else controls.set(key, { ...who, action: record.action, locator, count: 1 });
        break;
      }
      case 'unreadable':
        unreadable.push(record.file);
        break;
      case 'cap': {
        if (!isCapKind(record.k)) break;
        const running = browserCaps.get(record.k) ?? { limit: record.limit, dropped: 0 };
        running.dropped += record.dropped;
        browserCaps.set(record.k, running);
        break;
      }
      default:
        break;
    }
  }

  /*
   * Durations attached only where a RESPONSE was observed. A failed request and
   * a WebSocket both have `status: null` and neither emits `requestfinished`,
   * so neither has a duration — and borrowing one from a same-URL request that
   * did succeed would invent a measurement for a request that never completed.
   */
  for (const request of requests.values()) {
    if (request.ms !== null || request.status === null) continue;
    const found = timings.get(
      `${whoKey({ test: request.test, variant: request.variant })}\u0000${request.method}\u0000${request.template}`,
    );
    if (found !== undefined) request.ms = found;
  }

  for (const { url, who } of clientNavs) {
    const template = tpl(url);
    // `about:blank` is where every context starts; it is not a surface.
    if (template === '' || template.startsWith('about:')) continue;
    const key = `${whoKey(who)}\u0000${template}`;
    if (navigations.has(key)) continue;
    if (navigations.size >= RUNTIME_OBSERVATION_CAPS.nav) {
      navDropped += 1;
      continue;
    }
    navigations.set(key, {
      ...who,
      redirectChain: [],
      finalUrl: template,
      // A client-side route change has no HTTP response of its own. NULL says
      // "no status was observed"; any number here would be invented.
      status: null,
    });
  }

  for (const [kind, { limit, dropped }] of browserCaps) {
    if (dropped > 0)
      caps.push({
        kind,
        limit,
        dropped,
        reason: `the browser-side ${kind} ceiling of ${limit} per test was reached, so ${dropped} further ${kind} record(s) were never written`,
      });
  }
  const harnessSide: Array<[ObservationCapKind, number]> = [
    ['nav', navDropped],
    ['req', reqDropped],
    ['ctl', ctlDropped],
  ];
  for (const [kind, dropped] of harnessSide) {
    if (dropped > 0)
      caps.push({
        kind,
        limit: RUNTIME_OBSERVATION_CAPS[kind],
        dropped,
        reason: `${dropped} distinct ${kind} observation(s) are missing from this surface; the ceiling is ${RUNTIME_OBSERVATION_CAPS[kind]} per test`,
      });
  }

  if (queryDropped > 0)
    caps.push({
      kind: 'query',
      limit: null,
      dropped: queryDropped,
      reason: `${queryDropped} observed URL(s) carried a query string or fragment, which was dropped before recording because it can hold a token, a reset link or a session id`,
    });

  if (options.malformed > 0)
    caps.push({
      kind: 'malformed',
      limit: null,
      dropped: options.malformed,
      reason: `${options.malformed} observation line(s) could not be read and were skipped, so this surface is incomplete`,
    });

  if (unreadable.length > 0)
    caps.push({
      kind: 'unreadable',
      limit: null,
      dropped: unreadable.length,
      reason: `${unreadable.length} observation file(s) were written by the observer and could NOT be read back (${unreadable.slice(0, 3).join(', ')}): whatever this test did while they were being written is not in this surface, and its absence here is not evidence that it did nothing`,
    });

  /*
   * PARTIAL for an unreadable FILE as well as an unreadable LINE. The state is
   * the only thing that tells a reader "this is incomplete", and a lost file
   * loses strictly more than a lost line.
   */
  const incomplete = options.malformed + unreadable.length;

  return {
    testId: options.testId,
    availability:
      incomplete > 0 && options.availability.state === 'OBSERVED'
        ? {
            state: 'PARTIAL',
            reason:
              [
                options.malformed > 0 ? `${options.malformed} observation line(s)` : null,
                unreadable.length > 0
                  ? `${unreadable.length} whole observation file(s)`
                  : null,
              ]
                .filter((part): part is string => part !== null)
                .join(' and ') +
              ' were unreadable; what is reported here is only what parsed',
          }
        : options.availability,
    attribution,
    navigations: [...navigations.values()],
    requests: [...requests.values()],
    controls: [...controls.values()],
    caps,
  };
}

function isCapKind(value: string): value is ObservationCapKind {
  return Object.prototype.hasOwnProperty.call(RUNTIME_OBSERVATION_CAPS, value);
}

// ─── Runtime-invariant findings ──────────────────────────────────────────────

/**
 * Status codes this spec appears to ASSERT ON, and whether we could look.
 *
 * ── THE FALSE FINDING THIS PREVENTS ────────────────────────────────────────
 *
 * A negative test — "a member cannot delete another member's booking" — drives
 * the app until it gets a 403 and then asserts on it. The 403 is the PASS
 * CONDITION. Reporting it as a defect on a green test is how a team learns to
 * ignore everything QAAI says, so it is the one false positive this file is
 * most careful about.
 *
 * The signal is the spec's own source: any 4xx/5xx literal in it. Deliberately
 * crude in the SAFE direction — it suppresses a 403 finding whenever `403`
 * appears anywhere in the test, including in a comment. Missing a real finding
 * costs one defect; a confident false one costs the product's credibility.
 *
 * `readable: false` means there was no source to look at, and the caller then
 * reports LOW CONFIDENCE rather than a finding it cannot stand behind.
 *
 * Note what does NOT need suppressing: a status asserted through
 * `request.get()` on Playwright's APIRequestContext never reaches `page`'s
 * events at all, so those negative tests were never a source of false findings.
 */
export function assertedStatuses(specCode: string): {
  statuses: ReadonlySet<number>;
  readable: boolean;
} {
  if (specCode.trim() === '') return { statuses: new Set(), readable: false };
  const statuses = new Set<number>();
  for (const match of specCode.matchAll(/\b([45]\d{2})\b/g)) {
    const code = Number(match[1]);
    if (code >= 400 && code <= 599) statuses.add(code);
  }
  return { statuses, readable: true };
}

/**
 * A console error that is the browser narrating a network event we already
 * recorded.
 *
 * Chromium logs `Failed to load resource: the server responded with a status of
 * 500 (Internal Server Error)` for every non-2xx subresource — measured, not
 * assumed. Emitting both that and the 500 itself reports one defect twice and
 * doubles the apparent finding count of any app with a flaky endpoint.
 */
function isNetworkEcho(text: string): boolean {
  return /^Failed to load resource/i.test(text);
}

/**
 * Which invariant a console error text is, when it is more specific than
 * "console error".
 *
 * CSP violations and mixed-content blocks reach the harness ONLY as console
 * text — `securitypolicyviolation` would need a binding injected into the page
 * under test, and this file refuses to add an observable global to a customer's
 * application to measure it. Unhandled rejections are the same story in
 * reverse: Playwright delivers them through `pageerror` with no marker
 * distinguishing them from an uncaught throw, so the only honest label comes
 * from the text when the text carries one.
 */
function invariantFromConsoleText(text: string): RuntimeInvariant {
  if (/content security policy|refused to (?:load|execute|connect|frame)/i.test(text))
    return 'CSP_VIOLATION';
  if (/mixed content/i.test(text)) return 'MIXED_CONTENT';
  if (/unhandled (?:promise )?rejection|uncaught \(in promise\)/i.test(text))
    return 'UNHANDLED_REJECTION';
  return 'CONSOLE_ERROR';
}

interface FindingDraft {
  invariant: RuntimeInvariant;
  location: string;
  detail: string;
  /** False when the deliberate-assertion filter could not be applied. */
  confident: boolean;
}

export interface RuntimeFindingResult {
  findings: Finding[];
  /** Capped families and suppressed signals, as counts with reasons. */
  caps: ObservedCap[];
  /** Console errors worth putting on the result, after echo removal. */
  console: ConsoleEntry[];
}

/**
 * Every runtime invariant this test's browser broke, whether it passed or not.
 *
 * A finding here is NOT a verdict on the test: `status` is untouched, exactly as
 * `leaks.ts` leaves it. A green test over a throwing app now carries SERIOUS
 * findings and still reports PASSED, because the assertions really did pass and
 * the exception really did happen — two facts, both reported.
 */
export function runtimeFindings(
  stamped: readonly StampedRecord[],
  options: { baseUrl: string; specCode: string },
): RuntimeFindingResult {
  const { statuses: asserted, readable } = assertedStatuses(options.specCode);
  const drafts: FindingDraft[] = [];
  const consoleOut: ConsoleEntry[] = [];
  const caps: ObservedCap[] = [];
  let suppressedByAssertion = 0;
  let suppressedEcho = 0;
  let consoleDropped = 0;

  const tpl = (raw: string): string => urlTemplate(raw, options.baseUrl).template;

  for (const { record } of stamped) {
    switch (record.t) {
      case 'pageerror':
        drafts.push({
          // `message` is the only place a rejection is ever labelled; see
          // `invariantFromConsoleText`.
          invariant: invariantFromConsoleText(record.message) === 'UNHANDLED_REJECTION'
            ? 'UNHANDLED_REJECTION'
            : 'PAGE_ERROR',
          location: tpl(record.from),
          detail: `${record.name}: ${record.message}`.slice(0, 500),
          confident: true,
        });
        break;
      case 'console': {
        if (record.level !== 'error') break;
        if (isNetworkEcho(record.text)) {
          suppressedEcho += 1;
          break;
        }
        if (consoleOut.length < RUNTIME_OBSERVATION_CAPS.console)
          consoleOut.push({
            level: 'error',
            text: `Browser console error at ${tpl(record.from)}: ${record.text.slice(0, 500)}`,
            at: new Date().toISOString(),
          });
        else consoleDropped += 1;
        drafts.push({
          invariant: invariantFromConsoleText(record.text),
          location: tpl(record.from),
          detail: record.text.slice(0, 500),
          confident: true,
        });
        break;
      }
      case 'reqfail':
        drafts.push({
          invariant: 'REQUEST_FAILED',
          location: `${record.method} ${tpl(record.url)}`,
          detail: `the request did not complete (${record.err})`,
          confident: true,
        });
        break;
      case 'req': {
        const status = record.status;
        if (status === null || status < 400) {
          // A plain http:// subresource loaded from an https:// document is
          // mixed content whatever the status was, and this is the structural
          // check rather than the console-text one — it fires even when the
          // browser logged nothing.
          if (isMixedContent(record.from, record.url))
            drafts.push({
              invariant: 'MIXED_CONTENT',
              location: `${record.method} ${tpl(record.url)}`,
              detail: `loaded over http:// from the https:// document at ${tpl(record.from)}`,
              confident: true,
            });
          break;
        }
        if (asserted.has(status)) {
          suppressedByAssertion += 1;
          break;
        }
        drafts.push({
          invariant: status >= 500 ? 'HTTP_SERVER_ERROR' : 'HTTP_CLIENT_ERROR',
          location: `${record.method} ${tpl(record.url)}`,
          detail: `responded ${status}`,
          // The whole basis for calling a 4xx/5xx unintended is that the spec
          // did not mention it. With no spec to read, that basis is gone.
          confident: readable,
        });
        break;
      }
      default:
        break;
    }
  }

  if (suppressedByAssertion > 0)
    caps.push({
      kind: 'finding',
      limit: null,
      dropped: suppressedByAssertion,
      reason: `${suppressedByAssertion} 4xx/5xx response(s) were NOT reported because this spec's source names that status (${[...asserted].sort((a, b) => a - b).join(', ')}), so the test appears to assert on it deliberately`,
    });
  if (suppressedEcho > 0)
    caps.push({
      kind: 'finding',
      limit: null,
      dropped: suppressedEcho,
      reason: `${suppressedEcho} console error(s) were the browser restating a response status already reported above, and were not counted twice`,
    });
  if (consoleDropped > 0)
    caps.push({
      kind: 'console',
      limit: RUNTIME_OBSERVATION_CAPS.console,
      dropped: consoleDropped,
      reason: `${consoleDropped} further browser console error(s) are not listed on this result; the ceiling is ${RUNTIME_OBSERVATION_CAPS.console} per test`,
    });

  return { findings: foldFindings(drafts, caps), caps, console: consoleOut };
}

/** `http://` pulled into an `https://` document. */
function isMixedContent(documentUrl: string, requestUrl: string): boolean {
  return /^https:\/\//i.test(documentUrl) && /^http:\/\//i.test(requestUrl);
}

/**
 * Drafts folded into findings: deduped on invariant+location+detail, counted,
 * and capped per invariant with the overflow disclosed.
 *
 * A low-confidence draft is not dropped and is not reported as a confident
 * finding either — it is reported one severity step down with the reason in the
 * message, which is the whole of the instruction "report low confidence rather
 * than a false finding".
 */
function foldFindings(drafts: readonly FindingDraft[], caps: ObservedCap[]): Finding[] {
  const grouped = new Map<string, { draft: FindingDraft; count: number }>();
  for (const draft of drafts) {
    const key = `${draft.invariant}\u0000${draft.location}\u0000${draft.detail}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { draft, count: 1 });
  }

  const perInvariant = new Map<RuntimeInvariant, number>();
  const findings: Finding[] = [];
  let dropped = 0;

  for (const { draft, count } of grouped.values()) {
    const seen = perInvariant.get(draft.invariant) ?? 0;
    if (seen >= RUNTIME_FINDING_CAP) {
      dropped += 1;
      continue;
    }
    perInvariant.set(draft.invariant, seen + 1);

    const severity = RUNTIME_INVARIANT_SEVERITY[draft.invariant];
    findings.push({
      kind: RUNTIME_INVARIANT_KIND[draft.invariant],
      // One step down, never out: MINOR is the floor.
      severity: draft.confident ? severity : 'MINOR',
      code: RUNTIME_INVARIANT_CODE[draft.invariant],
      message:
        `${draft.detail}${count > 1 ? ` (seen ${count}×)` : ''}` +
        (draft.confident
          ? ''
          : ' — LOW CONFIDENCE: this spec’s source was not available, so QAAI could not tell whether the test asserts on this status deliberately'),
      location: draft.location,
      helpUrl: null,
    });
  }

  if (dropped > 0)
    caps.push({
      kind: 'finding',
      limit: RUNTIME_FINDING_CAP,
      dropped,
      reason: `${dropped} further distinct runtime finding(s) are not listed; the ceiling is ${RUNTIME_FINDING_CAP} per invariant per test`,
    });

  return findings;
}

/**
 * The observed requests, as the cockpit's network pane reads them.
 *
 * `NetworkEntry.durationMs` is a non-nullable `number`, and this observer does
 * not always have one — a cached response and a request still in flight when
 * the context closed both report -1 from `request.timing()`. Zero would be a
 * measurement claim ("instantaneous"), so the unmeasured ones are COUNTED and
 * the count is returned for disclosure rather than quietly rendered as 0. The
 * type wants widening to `number | null`; that edit is in this round's handover.
 *
 * `responseBodySnippet` is always null, because no body is ever captured.
 */
export function observedNetworkEntries(observation: RuntimeObservation): {
  entries: NetworkEntry[];
  untimed: number;
} {
  let untimed = 0;
  const entries = observation.requests.map((request) => {
    if (request.ms === null) untimed += 1;
    return {
      method: request.method,
      url: request.template,
      status: request.status,
      durationMs: request.ms ?? 0,
      responseBodySnippet: null,
    };
  });
  return { entries, untimed };
}

/**
 * The observed network, plus the one disclosure it owes.
 *
 * Kept together because the entries and the count of UNTIMED entries must never
 * be reported apart: `durationMs` reads 0 for a request the browser gave no
 * timing for, and a 0 nobody explained is exactly the "null that became 0" this
 * product cannot ship.
 */
function observedNetwork(
  observation: RuntimeObservation,
  existing: NetworkEntry[] | undefined,
): { network: NetworkEntry[]; disclosures: ConsoleEntry[] } {
  const { entries, untimed } = observedNetworkEntries(observation);
  return {
    network: [...(existing ?? []), ...entries],
    disclosures:
      untimed > 0
        ? [
            {
              level: 'warn',
              text: `Observation cap (timing): ${untimed} observed request(s) have NO measured duration — a failed request, a WebSocket, or one still in flight when the context closed emits no completion event to measure. Their durationMs reads 0 because the field cannot hold null; it is NOT a measurement.`,
              at: new Date().toISOString(),
            },
          ]
        : [],
  };
}

/** Caps and availability, said out loud on the result's console pane. */
export function observationDisclosures(
  observation: RuntimeObservation,
  extra: readonly ObservedCap[] = [],
): ConsoleEntry[] {
  const at = new Date().toISOString();
  const out: ConsoleEntry[] = [];

  if (observation.availability.state !== 'OBSERVED')
    out.push({
      level: 'warn',
      text: `Runtime observation ${observation.availability.state}: ${observation.availability.reason ?? 'no reason recorded'}`,
      at,
    });
  else
    out.push({
      level: 'log',
      text: `Runtime observation: ${observation.navigations.length} navigation(s), ${observation.requests.length} request(s), ${observation.controls.length} control interaction(s) across ${observation.attribution.length} test/variant pair(s).`,
      at,
    });

  for (const cap of [...observation.caps, ...extra])
    out.push({ level: 'warn', text: `Observation cap (${cap.kind}): ${cap.reason}`, at });

  return out;
}

// ─── The injected observer ───────────────────────────────────────────────────

/**
 * Does this spec drive a browser at all?
 *
 * Asked because the epilogue destructures the `page` fixture, and requesting
 * `page` LAUNCHES A BROWSER. An API-only Playwright spec that uses only
 * `request` would gain a browser launch it never asked for — slower, and able
 * to fail on a worker with no Chromium installed. So a spec with no browser in
 * it is left completely alone and reports NOT_APPLICABLE, which is not a gap.
 */
export function specUsesBrowser(code: string): boolean {
  return /\b(?:page|context|browser)\b/.test(code);
}

/**
 * The source appended to the spec inside the run workspace.
 *
 * Three rules it obeys, each one a defect it would otherwise cause:
 *
 *  1. IT CANNOT FAIL THE TEST. Every listener body and the writer are wrapped,
 *     and a throw from the observer would be a QAAI bug reported as a defect in
 *     the customer's application.
 *  2. IT RECORDS NO VALUE. `fill` and `type` record the action and the locator
 *     and never the arguments — a login test types a password.
 *  3. IT CAPS ITSELF AND SAYS WHAT IT DROPPED. The `cap` line is written in
 *     `afterEach` whether or not anything was dropped above zero, so a reader
 *     can never mistake a truncated list for a complete one.
 *
 * The locator instrumentation patches the prototype reached through the PUBLIC
 * api — `Object.getPrototypeOf(page.locator('html'))` — not an internal
 * `playwright-core/lib/...` path, and calls through to the original every time.
 * It is the only way to learn WHICH locator resolved a click: Playwright emits
 * no event for an action, and the JSON reporter on 1.62 emits no `pw:api` steps
 * at all. It runs in the throwaway spawned process and nothing else loads from
 * that workspace.
 */
export function runtimeObserverEpilogue(dir: string): string {
  const caps = JSON.stringify(RUNTIME_OBSERVATION_CAPS);
  return `

/* ── injected by QAAI: runtime observation (${RUNTIME_OBSERVER_MARKER}) ──────
 * Not part of your test. This block exists only inside the temporary run
 * workspace — the spec QAAI stores and exports stays a plain Playwright spec
 * with no QAAI import in it. It records what the test DID (navigations,
 * requests, control interactions) and what the application did wrong while it
 * did it (page errors, console errors, failed requests, 4xx/5xx). It never
 * records a body, a header, a cookie or a typed value, and it never throws.
 */
import { test as __qaaiObserveTest } from '@playwright/test';
import { appendFileSync as __qaaiAppend } from 'node:fs';
import { join as __qaaiJoin } from 'node:path';

const __qaaiObs = {
  dir: ${JSON.stringify(dir)},
  caps: ${caps},
  file: null,
  counts: { nav: 0, req: 0, ctl: 0, console: 0 },
  dropped: { nav: 0, req: 0, ctl: 0, console: 0 },
  timed: Object.create(null),
  patched: false,
};

function __qaaiWrite(record) {
  try {
    if (__qaaiObs.file === null) {
      // One file per process: Playwright loads this spec in the collection
      // process as well as in every worker, and two writers on one path
      // interleave half-lines. Created lazily so the collection process, which
      // runs no hooks, leaves no empty file behind.
      __qaaiObs.file = __qaaiJoin(__qaaiObs.dir, 'obs-' + process.pid + '-' + Date.now() + '.ndjson');
    }
    __qaaiAppend(__qaaiObs.file, JSON.stringify(record) + '\\n');
  } catch {
    /* Observation must never fail a customer's test. */
  }
}

function __qaaiTake(kind) {
  if (__qaaiObs.counts[kind] >= __qaaiObs.caps[kind]) {
    __qaaiObs.dropped[kind] += 1;
    return false;
  }
  __qaaiObs.counts[kind] += 1;
  return true;
}

/* Query strings are dropped HERE, before anything is written, so a token in one
 * never reaches disk even if the run crashes before the harness reads it. */
function __qaaiSafeUrl(url) {
  try {
    const text = String(url);
    const cut = text.indexOf('?');
    const hash = text.indexOf('#');
    const end = cut === -1 ? hash : hash === -1 ? cut : Math.min(cut, hash);
    return (end === -1 ? text : text.slice(0, end)).slice(0, 300);
  } catch {
    return '';
  }
}

function __qaaiAttachPage(page) {
  try {
    const where = () => __qaaiSafeUrl(page.url());

    page.on('console', (message) => {
      try {
        if (message.type() !== 'error') return;
        if (!__qaaiTake('console')) return;
        __qaaiWrite({ t: 'console', level: 'error', text: String(message.text()).slice(0, 2000), from: where() });
      } catch {}
    });

    page.on('pageerror', (error) => {
      try {
        __qaaiWrite({
          t: 'pageerror',
          name: String(error && error.name ? error.name : 'Error'),
          message: String(error && error.message ? error.message : error).slice(0, 2000),
          from: where(),
        });
      } catch {}
    });

    page.on('requestfailed', (request) => {
      try {
        if (!__qaaiTake('req')) return;
        const failure = request.failure();
        __qaaiWrite({
          t: 'reqfail',
          method: request.method(),
          url: __qaaiSafeUrl(request.url()),
          err: failure && failure.errorText ? String(failure.errorText).slice(0, 200) : 'unknown',
          from: where(),
        });
      } catch {}
    });

    page.on('response', (response) => {
      try {
        const request = response.request();
        const navigation = request.isNavigationRequest();
        if (!__qaaiTake(navigation ? 'nav' : 'req')) return;
        /* The redirect chain, oldest hop first. Playwright reports the 302 as
         * its own response AND as this request's redirectedFrom(); the harness
         * folds the duplicate away, it is not dropped here, because a redirect
         * the browser never followed to a loaded page is still a real hop. */
        const chain = [];
        for (let hop = request.redirectedFrom(); hop; hop = hop.redirectedFrom()) {
          chain.unshift(__qaaiSafeUrl(hop.url()));
          if (chain.length >= 20) break;
        }
        const url = __qaaiSafeUrl(request.url());
        /* Remembered so the requestfinished listener only writes a duration
         * for a request whose response we actually recorded. That bounds the
         * timing lines by the request cap without spending the cap on them. */
        __qaaiObs.timed[request.method() + ' ' + url] = true;
        __qaaiWrite({
          t: 'req',
          method: request.method(),
          url,
          status: response.status(),
          rt: request.resourceType(),
          nav: navigation,
          chain,
          from: where(),
        });
      } catch {}
    });

    /* The ONLY event with a complete duration on it: at the response event
     * timing().responseEnd is -1 and only responseStart (time to first byte)
     * is set. Measured against Chromium, not read off the docs. A request that
     * never finishes never arrives here, which is how its duration stays
     * null rather than becoming zero. */
    page.on('requestfinished', (request) => {
      try {
        const url = __qaaiSafeUrl(request.url());
        if (!__qaaiObs.timed[request.method() + ' ' + url]) return;
        let ms = -1;
        try {
          ms = request.timing().responseEnd;
        } catch {}
        /* -1 is "no timing". It is not written at all, rather than written as a
         * number that would read as a measurement. */
        if (!(ms >= 0)) return;
        __qaaiWrite({ t: 'timing', method: request.method(), url, ms });
      } catch {}
    });

    page.on('framenavigated', (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        __qaaiWrite({ t: 'nav', url: __qaaiSafeUrl(frame.url()) });
      } catch {}
    });

    page.on('websocket', (socket) => {
      try {
        if (!__qaaiTake('req')) return;
        __qaaiWrite({ t: 'ws', url: __qaaiSafeUrl(socket.url()) });
      } catch {}
    });
  } catch {}
}

const __QAAI_ACTIONS = [
  'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'check', 'uncheck',
  'selectOption', 'setInputFiles', 'hover', 'tap', 'type', 'clear', 'dragTo',
  'selectText', 'focus',
];

function __qaaiPatchLocators(page) {
  if (__qaaiObs.patched) return;
  __qaaiObs.patched = true;
  try {
    const proto = Object.getPrototypeOf(page.locator('html'));
    for (const action of __QAAI_ACTIONS) {
      const original = proto[action];
      if (typeof original !== 'function') continue;
      proto[action] = function (...args) {
        try {
          /* The locator, never the arguments: args[0] of fill() is the value. */
          if (__qaaiTake('ctl')) {
            __qaaiWrite({ t: 'ctl', action: action, locator: String(this).slice(0, 300) });
          }
        } catch {}
        return original.apply(this, args);
      };
    }
  } catch {}
}

__qaaiObserveTest.beforeEach(async ({ page, context }, testInfo) => {
  try {
    /* Per TEST, not per file. A spec file holds many tests and each one writes
     * its own cap line in afterEach; without this reset the second test would
     * report the first one's drops again and the harness would sum the same
     * truncation twice. */
    __qaaiObs.counts = { nav: 0, req: 0, ctl: 0, console: 0 };
    __qaaiObs.dropped = { nav: 0, req: 0, ctl: 0, console: 0 };
    __qaaiObs.timed = Object.create(null);
    __qaaiWrite({
      t: 'attach',
      test: testInfo.titlePath.join(' › '),
      variant: testInfo.project.name,
    });
    __qaaiPatchLocators(page);
    __qaaiAttachPage(page);
    /* A test that opens a second tab or a popup gets it observed too. */
    context.on('page', __qaaiAttachPage);
  } catch {}
});

__qaaiObserveTest.afterEach(async () => {
  try {
    for (const kind of Object.keys(__qaaiObs.dropped)) {
      __qaaiWrite({ t: 'cap', k: kind, limit: __qaaiObs.caps[kind], dropped: __qaaiObs.dropped[kind] });
    }
  } catch {}
});
`;
}

/**
 * The one seam that touches the disk.
 *
 * Returns null for UNAVAILABLE — the observer never ran, or wrote nothing — and
 * an array (possibly empty, meaning "it ran and saw nothing") otherwise. That
 * distinction is the whole point of the interface: `[]` and `null` are
 * different claims and only one of them is "we did not measure".
 */
export interface RuntimeObservationSource {
  read(dir: string): Promise<readonly string[] | null>;
}

/** The real adapter: NDJSON files the injected observer left in the workspace. */
export const fileObservationSource: RuntimeObservationSource = {
  async read(dir) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
    } catch {
      return null;
    }
    if (names.length === 0) return null;
    // Sorted so two workers' files fold in a stable order, which keeps the
    // observation byte-identical across reruns of the same run.
    names.sort();
    const lines: string[] = [];
    for (const name of names) {
      try {
        lines.push(...(await readFile(join(dir, name), 'utf8')).split('\n'));
      } catch {
        /*
         * A file that EXISTED and could not be read is reported as such, in the
         * one channel this interface has: a line the parser turns into an
         * `unreadable` record, which becomes a disclosed cap and a PARTIAL
         * state. It used to be swallowed by this catch with a comment claiming
         * the parser would notice — the parser cannot notice a file it was
         * never handed, and the result came back OBSERVED with nothing in it.
         */
        lines.push(JSON.stringify({ t: 'unreadable', file: name }));
      }
    }
    return lines;
  },
};

/** An observation that measured nothing, and says which of the reasons applies. */
function unobserved(testId: string, state: ObservationState, reason: string): RuntimeObservation {
  return {
    testId,
    availability: { state, reason },
    attribution: [],
    navigations: [],
    requests: [],
    controls: [],
    caps: [],
  };
}

/**
 * Read the workspace's observation dir and fold it into one test's surface.
 *
 * Never throws: an observation problem must not change a test's verdict, so
 * every failure becomes an UNAVAILABLE with its reason instead.
 */
export async function collectRuntimeObservation(options: {
  testId: string;
  dir: string | null;
  baseUrl: string;
  specCode: string;
  source: RuntimeObservationSource;
  /** Why the observer was never injected, when it was not. */
  notApplicable?: string | null;
}): Promise<{ observation: RuntimeObservation; findings: Finding[]; console: ConsoleEntry[] }> {
  /*
   * EVERY un-observed return carries its disclosure. Returning the reason on
   * the observation and an EMPTY console was the shape this function shipped
   * with for exactly one test run: the reason then existed only in an artifact
   * nobody opens, and the result said `findings: []` with nothing beside it to
   * stop that reading as "no defects found". That is the "pass that means we
   * did not check", so `silent` does not exist as a code path here.
   */
  const unwatched = (state: ObservationState, reason: string) => {
    const observation = unobserved(options.testId, state, reason);
    return { observation, findings: [], console: observationDisclosures(observation) };
  };

  if (options.notApplicable) return unwatched('NOT_APPLICABLE', options.notApplicable);

  if (options.dir === null)
    return unwatched(
      'UNAVAILABLE',
      'QAAI could not create the observation directory for this run, so nothing was watched.',
    );

  let lines: readonly string[] | null;
  try {
    lines = await options.source.read(options.dir);
  } catch (err) {
    lines = null;
    void err;
  }

  if (lines === null)
    return unwatched(
      'UNAVAILABLE',
      'The runtime observer wrote nothing. Either no browser test ran in this spec, or the injected observer did not load — this is NOT a statement that the application behaved correctly.',
    );

  const { records, malformed } = parseObservationLines(lines);
  const observation = observedSurface(records, {
    testId: options.testId,
    baseUrl: options.baseUrl,
    malformed,
    availability: { state: 'OBSERVED', reason: null },
  });
  const result = runtimeFindings(records, {
    baseUrl: options.baseUrl,
    specCode: options.specCode,
  });

  return {
    observation,
    findings: result.findings,
    console: [...result.console, ...observationDisclosures(observation, result.caps)],
  };
}

/**
 * Writes the observed surface where it will outlive the run.
 *
 * The same shape as `recordDeterminism`, and wrapped for the same reason: a
 * reporting problem must never lose a run. This is the WRITE PATH for the
 * runtime surface; the read path is the artifact store, and the typed seam on
 * `TestExecution` that the coverage pipeline wants is in this round's handover.
 */
async function recordObservation(
  ctx: RunContext,
  test: ExecutableTest,
  observation: RuntimeObservation,
): Promise<void> {
  /*
   * NOT_APPLICABLE writes no artifact. A spec that drives no browser — an
   * API-only Playwright spec, or the order-dependence specs in
   * determinism.test.ts — has no runtime surface to store, and a file per such
   * test saying "this spec has no browser" is noise in the artifact store that
   * nobody will ever open. Nothing is hidden by the skip: the state and its
   * reason are already on the result's own console pane, where the reader is,
   * via `observationDisclosures`. Every other state DOES get its artifact,
   * UNAVAILABLE included — "we could not watch" is a fact worth keeping.
   */
  if (observation.availability.state === 'NOT_APPLICABLE') {
    ctx.logger.debug('runtime observation not applicable', {
      testId: test.id,
      reason: observation.availability.reason,
    });
    return;
  }

  ctx.logger.info('runtime observation', {
    testId: test.id,
    state: observation.availability.state,
    navigations: observation.navigations.length,
    requests: observation.requests.length,
    controls: observation.controls.length,
    caps: observation.caps.length,
  });
  try {
    await ctx.artifacts.put(
      `${test.id}_runtime-surface.json`,
      Buffer.from(`${JSON.stringify(observation, null, 2)}\n`, 'utf8'),
      'application/json',
    );
  } catch (err) {
    ctx.logger.warn('runtime observation upload failed', { testId: test.id, err: String(err) });
  }
}

/** Pins the four vocabularies to their arrays; see the records' own comments. */
export const RUNTIME_VOCABULARY_PRESENCE = {
  invariants: RUNTIME_INVARIANT_PRESENT,
  states: OBSERVATION_STATE_PRESENT,
} as const;

export interface HarnessOptions {
  /** Reported on the TestExecution; lets smoke reuse this harness verbatim. */
  network?: NetworkEntry[];
  /** Run the spec once per entry — a browser matrix, or a locale matrix. */
  projects?: Array<{ name: string; browserName?: string; locale?: string; timezoneId?: string }>;
  /**
   * Build determinism controls — order randomisation, clock, seeded randomness,
   * timezone/locale. Every knob is off unless named here, because each one
   * changes what the suite exercises and that is the run owner's decision.
   */
  determinism?: DeterminismOptions;
  /**
   * This environment's access row — bot protection, and the headers every
   * request carries.
   *
   * Absent means NOT PROBED, never "nothing is in the way": an environment with
   * no `EnvironmentAccess` row is one nobody has looked at, and the harness
   * behaves exactly as it did before this field existed. Passing a policy is
   * what makes UNREACHABLE_BEHIND_BOT_PROTECTION reachable, and the worker is
   * the only caller positioned to read the row.
   */
  access?: EnvironmentAccessPolicy | null;
  /**
   * Where the runtime observation is read back from. Defaults to the real
   * workspace reader; a test injects a fake and exercises every classification
   * rule with no browser and no network.
   */
  observationSource?: RuntimeObservationSource;
}

/**
 * Writes the seed, and the order it produced, somewhere it will outlive the run
 * log — a shuffled failure is only actionable if the order can be replayed, and
 * a seed that exists solely in a log line is a seed nobody will find.
 *
 * Wrapped, because a reporting problem must never lose a run: if the artifact
 * store is unavailable the test result still stands, and the seed is still in
 * the failure message and the log.
 */
async function recordDeterminism(
  ctx: RunContext,
  test: ExecutableTest,
  plan: DeterminismPlan,
): Promise<void> {
  const record = determinismRecord(plan);
  ctx.logger.info('determinism', { testId: test.id, ...record });
  try {
    await ctx.artifacts.put(
      `${test.id}_determinism.json`,
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      'application/json',
    );
  } catch (err) {
    ctx.logger.warn('determinism record upload failed', { testId: test.id, err: String(err) });
  }
}

/**
 * The one condition this harness refuses to execute under.
 *
 * A test that names an `authProfileId` is a test about a ROLE: "an admin can
 * delete a member", "a member cannot". If the run could not produce that
 * profile's session — the login failed, the credentials are gone, the profile
 * is a header token no browser can carry — then running the spec anyway runs it
 * ANONYMOUSLY, and an anonymous browser hitting an admin page gets a login
 * redirect that an assertion on "no error banner" cheerfully passes. That green
 * tick is the defect the per-test profile was added to remove, wearing a
 * different costume, so it is refused here instead.
 *
 * FAILED rather than SKIPPED on purpose: a skip does not block a gate, and a
 * suite whose permission tests quietly stopped running is exactly the thing
 * nobody notices. The worker resolves sessions before it gets here and fails
 * the test with the login's own message; this is the backstop for every other
 * route into the harness.
 *
 * Exported so all four combinations can be pinned without launching a browser.
 */
export function missingRoleSession(
  ctx: RunContext,
  test: ExecutableTest,
): { declared: string | null; supplied: string | null } | null {
  const declared = declaredAuthProfileId(test);
  const supplied = suppliedAuthProfileId(ctx);

  if (declared) {
    // The profile has to be THIS profile, and it has to have produced a
    // session — an SSO bypass token signs in "successfully" and produces none.
    if (supplied === declared && ctx.storageState) return null;
    return { declared, supplied };
  }

  /*
   * No binding, but the test still says it is meaningless signed out: its
   * profile was deleted (`onDelete: SetNull` nulls the binding and leaves the
   * intent). There is nothing to check against, so the session itself is the
   * question, and an absent one is a refusal.
   */
  if (authProfileRequired(test) && !ctx.storageState) return { declared: null, supplied };
  return null;
}

/**
 * Every configured header, said out loud on the result.
 *
 * Both halves are reported: the names that WERE sent, and every one that was
 * not with the reason. A header that quietly went missing is the worst outcome
 * available here — the run then fails on an assertion and the failure is read
 * as a defect in the customer's application — so the absence is a line in the
 * report rather than nothing at all.
 *
 * NAMES ONLY. No value, no vault contents, not even truncated: this text is
 * stored on the TestExecution, exported, and rendered in the cockpit.
 */
function headerDisclosures(resolved: ResolvedEnvironmentHeaders): ConsoleEntry[] {
  const at = new Date().toISOString();
  const out: ConsoleEntry[] = [];
  if (resolved.names.length > 0) {
    out.push({
      level: 'log',
      text: `Environment headers sent with every request: ${resolved.names.join(', ')} (values withheld).`,
      at,
    });
  }
  for (const refusal of resolved.refusals) {
    out.push({ level: 'warn', text: `Header refused (${refusal.reason}): ${refusal.detail}`, at });
  }
  return out;
}

/** Runs one generated spec file and maps the result into QAAI's shape. */
export async function runPlaywrightSpec(
  ctx: RunContext,
  test: ExecutableTest,
  options: HarnessOptions = {},
): Promise<TestExecution> {
  const startedWithoutRole = Date.now();
  const roleGap = missingRoleSession(ctx, test);
  if (roleGap) {
    return {
      testId: test.id,
      status: 'FAILED',
      durationMs: Date.now() - startedWithoutRole,
      steps: [],
      network: options.network ?? [],
      /*
       * The spec was never executed, so `findings: []` below has to be read as
       * "nothing was watched" and not as "the application behaved". That is
       * what this line says, on the result, where the reader is.
       */
      console: observationDisclosures(
        unobserved(
          test.id,
          'NOT_APPLICABLE',
          'The spec was not executed (no session for the role it runs as), so no runtime behaviour was observed and no finding below is a statement about the application.',
        ),
      ),
      videoKey: null,
      traceKey: null,
      errorMessage:
        (roleGap.declared
          ? `"${test.name}" runs as auth profile ${roleGap.declared}, and this run has no session ` +
            `for it${roleGap.supplied ? ` (it supplied ${roleGap.supplied} instead)` : ''}. `
          : `"${test.name}" is marked as requiring a signed-in role, and the profile it was ` +
            'bound to no longer exists. ') +
        'The spec was NOT executed anonymously: a logged-out browser would have been redirected ' +
        'to the login page and most assertions would have passed, which is worse than a failure. ' +
        (roleGap.declared
          ? 'Sign the profile in from Project settings → Environments → Auth profiles and re-run.'
          : 'Re-bind the test to an auth profile in the test editor and re-run.'),
      retriedAndPassed: false,
      findings: [],
    };
  }

  /*
   * ── THE ENVIRONMENT'S OWN WALL, BEFORE A BROWSER IS LAUNCHED ──────────────
   *
   * Resolved first so a missing bypass credential is known BEFORE the refusal
   * is decided: a bypass that is configured and unusable is the same wall as
   * one that was never configured, and the naive implementation runs the spec
   * anyway and reports the challenge page as a defect in the application.
   *
   * No policy at all is NOT_PROBED and changes nothing — `access` absent is the
   * behaviour this harness had before the field existed.
   */
  const access = options.access ?? null;
  const resolvedHeaders: ResolvedEnvironmentHeaders = access
    ? resolveEnvironmentHeaders(access, ctx.secrets)
    : { headers: {}, refusals: [], names: [], entries: [] };
  const blocked = access ? botProtectionRefusal(access, resolvedHeaders.refusals) : null;
  if (blocked) {
    return {
      testId: test.id,
      /*
       * SKIPPED, with the reason — the same call the missing-browser branch
       * below makes, and for the same reason. FAILED would say the customer's
       * application is broken; what is true is that we never reached it. A
       * SKIPPED result does not count as a pass anywhere, so nothing is
       * inflated by it.
       */
      status: 'SKIPPED',
      durationMs: Date.now() - startedWithoutRole,
      steps: [],
      network: options.network ?? [],
      console: [
        ...headerDisclosures(resolvedHeaders),
        ...observationDisclosures(
          unobserved(
            test.id,
            'NOT_APPLICABLE',
            'The environment was never reached, so no runtime behaviour was observed and no finding below is a statement about the application.',
          ),
        ),
      ],
      videoKey: null,
      traceKey: null,
      errorMessage: blocked.message,
      retriedAndPassed: false,
      findings: [],
    };
  }

  const plan = planDeterminism(
    test.code,
    resolveDeterminism(ctx.determinism, options.determinism),
  );
  const hint = reproduceHint(plan);

  /**
   * Determinism metadata rides on the console pane rather than a new field on
   * TestExecution: the reader looking at a red run needs the seed in front of
   * them, and this is the channel that already reaches them. Notes appear even
   * on a pass, because "the shuffle declined and why" is exactly the thing that
   * would otherwise be silent.
   */
  const determinismConsole: ConsoleEntry[] = plan.determinism.enabled
    ? [
        ...(hint ? [{ level: 'log' as const, text: hint, at: new Date().toISOString() }] : []),
        ...plan.notes.map((text) => ({
          level: 'warn' as const,
          text: `Determinism: ${text}`,
          at: new Date().toISOString(),
        })),
      ]
    : [];

  const accessConsole = headerDisclosures(resolvedHeaders);
  const ws = await createWorkspace(
    ctx,
    test,
    plan,
    options.projects,
    resolvedHeaders.entries.length > 0
      ? extraHttpHeadersSource(resolvedHeaders.entries)
      : null,
  );
  const startedAt = Date.now();

  /**
   * The runtime observation for this run, read out of the workspace before it
   * is removed.
   *
   * Called on every path that got as far as spawning Playwright, including the
   * one where no report came back: a run that crashed halfway still observed
   * what it did before it crashed, and throwing that away is throwing away the
   * most useful evidence available about why it crashed.
   */
  const readObservation = () =>
    collectRuntimeObservation({
      testId: test.id,
      dir: ws.observeDir,
      baseUrl: ctx.baseUrl,
      // The CUSTOMER's source, not `plan.code` — the deliberate-4xx filter asks
      // "does this test assert on a 403", and the injected epilogue is not the
      // test.
      specCode: test.code,
      source: options.observationSource ?? fileObservationSource,
      notApplicable:
        ws.observeDir === null
          ? `"${test.name}" references no Playwright page, context or browser, so no browser was launched and none was observed. This is not a gap in the application.`
          : null,
    });

  /** Appends the seed to whatever the failure already said, never replacing it. */
  const withHint = (message: string | null): string | null => {
    if (!hint) return message;
    return message ? `${message}\n\n${hint}` : hint;
  };

  try {
    if (plan.determinism.enabled) await recordDeterminism(ctx, test, plan);
    ctx.logger.info('running spec', { testId: test.id, file: test.filePath });
    const outcome = await runPlaywright(ws, ctx, plan);

    let report: PwReport | null = null;
    try {
      report = JSON.parse(await readFile(ws.reportPath, 'utf8')) as PwReport;
    } catch {
      report = null;
    }

    const { videoKey, traceKey, screenshotKeys } = await uploadArtifacts(ws, ctx, test.id);

    /**
     * A browser engine that was never installed is an environment gap, not a
     * failing test. Reporting it as FAILED would say the customer's app is
     * broken when the truth is `npx playwright install` was never run — the
     * same distinction k6 makes when its binary is missing.
     */
    const combinedOutput = `${outcome.stderr}\n${outcome.stdout}`;
    if (/Executable doesn't exist at|browserType\.launch: Executable/.test(combinedOutput)) {
      const engine = /(chromium|firefox|webkit)-\d+/.exec(combinedOutput)?.[1] ?? 'a browser';
      return {
        testId: test.id,
        status: 'SKIPPED',
        durationMs: Date.now() - startedAt,
        steps: [],
        network: options.network ?? [],
        console: [
          ...accessConsole,
          ...determinismConsole,
          /*
           * UNAVAILABLE and not NOT_APPLICABLE: the spec asked for a browser
           * and the browser was missing. That is a capability this worker does
           * not have, which is a different sentence from "there was nothing to
           * observe".
           */
          ...observationDisclosures(
            unobserved(
              test.id,
              'UNAVAILABLE',
              `${engine} is not installed on this worker, so nothing was executed and nothing was observed.`,
            ),
          ),
        ],
        videoKey,
        traceKey,
        // No determinism hint here on purpose: nothing was evaluated, so a seed
        // would be inviting someone to "reproduce" a missing browser.
        errorMessage:
          `${engine} is not installed on this worker, so the test was not evaluated. ` +
          `Run \`npx playwright install ${engine === 'a browser' ? '' : engine}\`.`,
        retriedAndPassed: false,
        findings: [],
      };
    }

    // No report at all means the spec did not compile or Playwright itself
    // failed — an ENV_ISSUE in triage terms, not a test failure.
    if (!report) {
      // Partial observation is the point here: a spec that timed out mid-flight
      // still named the routes it reached and the 500 it got, and that is the
      // most useful evidence there is about a run with no report.
      const crashed = await readObservation();
      await recordObservation(ctx, test, crashed.observation);
      const observedCrash = observedNetwork(crashed.observation, options.network);
      return {
        testId: test.id,
        status: outcome.timedOut ? 'TIMED_OUT' : 'FAILED',
        durationMs: Date.now() - startedAt,
        steps: [],
        network: observedCrash.network,
        console: [
          ...accessConsole,
          ...determinismConsole,
          ...crashed.console,
          ...observedCrash.disclosures,
        ],
        videoKey,
        traceKey,
        errorMessage: withHint(
          outcome.timedOut
            ? `Playwright did not finish within ${PROCESS_TIMEOUT_MS / 1000}s`
            : `Playwright produced no report.\n${stripAnsi(outcome.stderr || outcome.stdout).slice(0, 4000)}`,
        ),
        retriedAndPassed: false,
        findings: crashed.findings,
      };
    }

    const specs = flattenSpecs(report.suites);
    const outcomes = specs.flatMap((s) => s.tests).map(outcomeFor);

    // The reported test is the worst one in the file, not the last one to run.
    // Steps, error and screenshot all come from it, so the cockpit opens on the
    // thing that broke rather than on whatever happened to finish last.
    let worst: TestOutcome | undefined = outcomes[0];
    let status: TestResultStatus = mapStatus(worst?.final, worst?.retriedAndPassed ?? false);
    for (const candidate of outcomes.slice(1)) {
      const candidateStatus = mapStatus(candidate.final, candidate.retriedAndPassed);
      if (STATUS_SEVERITY[candidateStatus] > STATUS_SEVERITY[status]) {
        worst = candidate;
        status = candidateStatus;
      }
    }

    const last = worst?.final;
    // Reported for the whole file: a retry that passed anywhere in it is still
    // a flake candidate, even when another test failed outright.
    const retriedAndPassed = outcomes.some((o) => o.retriedAndPassed);

    const userSteps = collectUserSteps(last?.steps);
    const failingIndex = userSteps.findIndex((s) => Boolean(s.error));

    const topLevelError =
      last?.errors?.[0]?.message ??
      report.errors?.[0]?.message ??
      (last?.status === 'failed' && userSteps.every((s) => !s.error)
        ? stripAnsi(outcome.stderr || outcome.stdout).slice(0, 2000)
        : undefined);

    const errorMessage = topLevelError ? stripAnsi(topLevelError) : null;

    /*
     * Did we spend this run asserting on a challenge page?
     *
     * Only asked of a run that did NOT pass, and only ever APPENDED: the
     * assertion that failed is still the most useful line in the report, and a
     * marker is evidence about what was on screen rather than a replacement
     * verdict. `challengeSignalIn` returns null when it saw no documented
     * marker, which is "we did not see one" and not "there was no challenge" —
     * the keyhole here is a failure message and a process's stdout.
     */
    const seenChallenge =
      status === 'PASSED'
        ? null
        : challengeSignalIn(`${errorMessage ?? ''}\n${combinedOutput}`);
    const withChallenge = (message: string | null): string | null => {
      if (!seenChallenge) return message;
      const note = challengeNote(seenChallenge);
      return message ? `${message}\n\n${note}` : note;
    };

    /*
     * A GREEN TEST OVER A THROWING APPLICATION. These findings are attached
     * whatever `status` says and `status` is not touched by them — the
     * assertions really did pass and the page really did throw, and those are
     * two facts, both of which get reported. Same rule leaks.ts follows.
     */
    const runtime = await readObservation();
    await recordObservation(ctx, test, runtime.observation);
    const observedRun = observedNetwork(runtime.observation, options.network);

    return {
      testId: test.id,
      status,
      durationMs: Date.now() - startedAt,
      steps: toStepResults(userSteps, screenshotKeys, failingIndex === -1 ? null : failingIndex),
      network: observedRun.network,
      console: [
        ...accessConsole,
        ...determinismConsole,
        ...toConsoleEntries(last),
        ...runtime.console,
        ...observedRun.disclosures,
      ],
      videoKey,
      traceKey,
      // "Your suite fails in THIS order, here is the seed" is the whole feature.
      // A green run does not need it; a red one is useless without it.
      errorMessage: status === 'PASSED' ? errorMessage : withChallenge(withHint(errorMessage)),
      retriedAndPassed,
      findings: runtime.findings,
    };
  } finally {
    await ws.cleanup();
  }
}
