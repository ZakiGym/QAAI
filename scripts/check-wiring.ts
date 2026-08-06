#!/usr/bin/env node
/**
 * check-wiring — the CI gate for this repo's characteristic defect.
 *
 * The bug class this exists to catch is NOT broken code. It is correct code
 * that is connected to nothing: a router nobody mounts, a queue nobody drains,
 * an env var nobody reads, a table nobody writes, a flag that gates nothing.
 * Every one of those typechecks, every one of those has passed review, and this
 * repo has shipped at least eight of them (seven unmounted routers, a /metrics
 * that 401'd because its router was never mounted, an IPv6 rate-limit key that
 * was unit tested and never wired in, two npm scripts pointing at files that did
 * not exist, a bisect queue with no consumer…).
 *
 * A one-off audit finds today's instances. Only a script CI runs stops the next
 * one, which is why this is a script and not a report.
 *
 *   npm run check:wiring
 *
 * ─── Design rules, each one a mistake this check could otherwise make ────────
 *
 * 1. PROVE IT BY EXECUTION WHERE EXECUTION IS POSSIBLE. Reading source tells you
 *    a router exists; only a request tells you it answers. Where a live
 *    dependency is available (API, Redis) this check uses it.
 *
 * 2. A MISSING TOOL OR CREDENTIAL IS A SKIP, NOT A FAILURE — with a sentence
 *    saying exactly what to start. A check that goes red on a laptop with no
 *    Redis is a check people delete.
 *
 * 3. THE AUTHENTICATED DIFFERENTIAL. A 401 is not proof a route exists here.
 *    Four routers mount at '/' and call requireAuth first, so an unmounted path
 *    401s exactly like a mounted one. Only a request carrying a real session
 *    separates them: then an unmounted path falls through to notFoundHandler,
 *    whose body says `No route for <METHOD> <path>` — a string no handler
 *    produces. That string, and nothing else, is the negative signal.
 *
 * 4. NEVER PROBE A DESTRUCTIVE PATH. Path params are filled with a token that
 *    cannot be an id, so a handler 404s before it does anything; a mutating
 *    route with no params is not probed at all (see UNSAFE_TO_PROBE), and says
 *    so in the output rather than being silently dropped.
 *
 * 5. DO NOT CRY WOLF. A deliberate public API export is not dead code. Findings
 *    that are real but out of this pass's scope live in KNOWN_GAPS, are printed
 *    in full on every run, and — this is the part that matters — a KNOWN_GAPS
 *    entry that stops reproducing FAILS the check, so the list can only shrink.
 *    It cannot rot into a permanent silencer the way a bare allowlist does.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ─── Findings ────────────────────────────────────────────────────────────────

type Severity = 'fail' | 'warn' | 'skip' | 'ok';

interface Finding {
  check: string;
  severity: Severity;
  /** Stable identity of the thing. KNOWN_GAPS matches on `check` + `what`. */
  what: string;
  detail: string;
  /** What a human should do about it. Required on fail/warn/skip. */
  fix: string;
}

const findings: Finding[] = [];
const add = (f: Finding): void => void findings.push(f);

/**
 * A green line, but only if the check that produced it found nothing.
 *
 * The first version of this file printed "ok — 19 types" next to nineteen
 * failures from the same check, which is the "never report success for work
 * that did not happen" rule broken by the tool built to enforce it.
 */
const okIfClean = (check: string, what: string, detail: string): void => {
  if (findings.some((f) => f.check === check && f.severity === 'fail')) return;
  add({ check, severity: 'ok', what, detail, fix: '' });
};

/**
 * Findings that are real, reproduce today, and are deliberately not fixed in
 * this pass. Each carries the reason and the remediation, and each is printed
 * on every run. A stale entry (one that no longer reproduces) fails the check.
 */
interface KnownGap {
  check: string;
  what: string;
  why: string;
  remediation: string;
}

const KNOWN_GAPS: KnownGap[] = [
  {
    check: 'prisma-models',
    what: 'OAuthAccount',
    why: 'No OAuth sign-in exists. Nothing reads or writes this table; the GOOGLE_/GITHUB_OAUTH_* env vars that would have fed it are gone (this pass removed them from .env.example).',
    remediation: 'Either implement OAuth sign-in on authRouter, or drop the model in a migration.',
  },
  /*
   * VerificationToken was here. It said "Email verification and password reset
   * were never built … nothing writes a token row", and that is no longer true:
   * POST /auth/password/forgot writes one and POST /auth/password/reset burns
   * it. The ratchet caught its own entry going stale and failed the build until
   * it was removed, which is the behaviour it exists for.
   *
   * Email VERIFICATION is still unbuilt — but that is a missing feature, not a
   * disconnected table, and this file is about the second thing. A gap entry
   * kept alive for a reason it no longer describes is how an allowlist starts.
   */
  {
    check: 'prisma-models',
    what: 'FeatureFlag',
    why: 'prisma/seed.ts writes four flag rows (visual-regression, load-testing, github-app, auto-heal-selectors) and NOTHING reads them. All four features are reachable today regardless of the row, so flipping `enabled` changes nothing.',
    remediation:
      'Delete the seed block and both flag models, or add a read path and gate the four features on it. Do not gate them silently — the seeded rows are all `enabled: false`, so wiring them as-is would switch four working features off.',
  },
  {
    check: 'prisma-models',
    what: 'FeatureFlagOverride',
    why: 'The per-org half of the dead flag system above. Zero references anywhere in the repo.',
    remediation: 'Goes with FeatureFlag — same decision, same migration.',
  },
  {
    check: 'feature-flags',
    what: 'the FeatureFlag store',
    why: 'The behavioural half of the same gap: four flags exist as rows and no request path consults them. Kept as its own entry because the tables could be dropped while the seed stayed, or the reverse, and each is a separate mistake.',
    remediation:
      'Same decision as the FeatureFlag model. Whichever way it goes, both entries clear together.',
  },
  {
    check: 'env-vars',
    what: 'SESSION_SECRET',
    why: 'apps/api/src/env.ts requires it (min 32 chars, boot fails without it) and NOTHING reads it afterwards. Sessions are looked up by sha256(token) via lib/crypto.ts hashToken(), which takes no key. deploy/.env.example tells operators it "signs session cookies"; it does not.',
    remediation:
      'Either key the session token hash with it — a session-only HMAC, NOT hashToken(), which also hashes API keys and would invalidate every issued key — or drop it from env.ts and correct the claim in deploy/.env.example. Do not just delete it quietly: installs already set it, and its removal silently changes what boots.',
  },
  /*
   * WebhookDelivery was here. It said "notify.ts and digest.ts record every
   * outbound delivery … and no endpoint or screen ever reads a row back", and
   * that is no longer true: the worker's retry path (processDelivery in
   * apps/worker/src/processors/notify.ts) reads each row back on every
   * attempt and dead-letters the ones that never land. The customer-facing
   * read — GET /integrations/:id/deliveries — is the remaining half, owned by
   * routes/integrations.ts.
   */
];

/** Params filled with this cannot resolve to a row, so a probed handler 404s. */
const PROBE_TOKEN = '__qaai_wiring_probe__';

/**
 * Paths this check refuses to send a request to, and why. Being explicit beats
 * a heuristic: the reason is printed, so nobody has to guess whether a path was
 * skipped on purpose or missed.
 */
const UNSAFE_TO_PROBE: Array<{ method: string; path: string; why: string }> = [
  {
    method: 'GET',
    path: '/export/org',
    why: 'streams a full organisation dump — expensive, and pointless to do once a minute in CI',
  },
  {
    method: 'POST',
    path: '/retention/sweep',
    why: 'deletes artifacts and rows; takes no path param, so there is no way to make the probe a no-op',
  },
];

// ─── Small utilities ─────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Not source. `.artifacts` in particular holds Playwright trace output —
 * thousands of minified vendor bundles that are git-ignored, that no CI
 * checkout has, and that are full of strings shaped like environment variables.
 * Walking them is slow and every finding they produce is a phantom.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.git',
  'release',
  'test-results',
  'playwright-report',
  'coverage',
  '.artifacts',
  '.qaai-runs',
  '.generated',
  '__fixtures__',
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const CODE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

/** Every hand-written source file. Prisma's generated client is not ours. */
function sourceFiles(): string[] {
  return [
    ...walk(join(ROOT, 'apps')),
    ...walk(join(ROOT, 'packages')),
    ...walk(join(ROOT, 'scripts')),
    ...walk(join(ROOT, 'e2e')),
  ].filter((f) => CODE_EXT.test(f) && !f.includes(`${'generated'}/prisma`));
}

const isTestFile = (f: string): boolean => /\.(test|spec)\.[cm]?tsx?$/.test(f);

let SOURCES: Array<{ path: string; text: string; flat: string }> = [];

/**
 * `flat` is the file with every run of whitespace collapsed to one space.
 *
 * Load-bearing: prettier wraps `await prisma.webhookDelivery\n  .create({…})`
 * across lines, and a line-oriented grep for `prisma.webhookDelivery.create`
 * therefore reports a table as never written when it is written twice. That
 * exact false negative is why this file normalises before it searches.
 */
/*
 * `stripComments` (below) already existed and was used by the route scanner —
 * loadSources simply never called it, so every OTHER check read raw source.
 * That made the queue check blind to the most obvious way a consumer stops
 * existing: someone comments the `register(...)` line out. It counted as live
 * wiring — the exact defect this file exists to catch, inside the file that
 * catches it.
 */
function loadSources(): void {
  SOURCES = sourceFiles().map((path) => {
    const raw = read(path);
    const text = stripComments(raw);
    // Collapse whitespace, then close it up around dots and colons, so a
    // prettier-wrapped `prisma.webhookDelivery\n  .create({` reads as
    // `prisma.webhookDelivery.create({` — the form every search below expects.
    const flat = text.replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '.').replace(/:\s+/g, ': ');
    return { path, text, flat };
  });
}

const SELF = 'scripts/check-wiring.ts';

/**
 * Files that count as consumers: production code, not the tests of the code —
 * and not this file. A checker that names `prisma.webhookDelivery.create` in a
 * comment must not thereby count as the thing that writes the table. It did,
 * for one run, and reported itself as the writer.
 */
const productionSources = (): typeof SOURCES =>
  SOURCES.filter((s) => !isTestFile(s.path) && rel(s.path) !== SELF);

/**
 * Every file the repo imports, resolved to an absolute path.
 *
 * Resolution, not substring matching, is the point. The first version asked
 * "does any file mention `reports/junit-xml.js`?" and reported ten live report
 * parsers as dead, because their importer sits in the same directory and writes
 * `'./junit-xml.js'`. A relative specifier only means something relative to the
 * file it appears in.
 */
function importGraph(): { production: Set<string>; test: Set<string> } {
  const production = new Set<string>();
  const test = new Set<string>();

  for (const s of SOURCES) {
    const target = isTestFile(s.path) ? test : production;
    const dir = resolve(s.path, '..');
    for (const m of s.text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
      const spec = m[1]!;
      const base = resolve(dir, spec.replace(/\.js$/, ''));
      // NodeNext writes `.js` for a `.ts` source; a bare specifier may be a
      // directory. Record every form so the lookup never depends on which.
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
        target.add(candidate);
      }
    }
  }
  return { production, test };
}

const rel = (p: string): string => relative(ROOT, p);

/**
 * Blank out comments so commented-out code cannot be read as live wiring.
 * Replaced with spaces rather than removed, so line and column numbers survive.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

// ─── 1. Express routers: mounted, and answering ──────────────────────────────

interface DeclaredRoute {
  method: string;
  /** Path as mounted on the app, e.g. `/projects/:projectId/tests`. */
  path: string;
  routerFile: string;
  routerIdent: string;
}

function joinPath(prefix: string, sub: string): string {
  const a = prefix === '/' ? '' : prefix.replace(/\/$/, '');
  const b = sub === '/' ? '' : sub;
  const joined = `${a}${b.startsWith('/') ? '' : '/'}${b}`;
  return joined === '' ? '/' : joined;
}

/** `router.get('/x', …)` / `router.use('/x', sub)` declarations inside a file. */
function declaredIn(
  file: string,
  text: string,
  ident: string,
  prefix: string,
  seen: Set<string>,
): DeclaredRoute[] {
  const out: DeclaredRoute[] = [];
  if (seen.has(`${file}#${ident}`)) return out;
  seen.add(`${file}#${ident}`);

  const verb = new RegExp(
    `\\b${ident}\\.(get|post|put|patch|delete|all)\\(\\s*['\`]([^'\`]+)['\`]`,
    'g',
  );
  for (const m of text.matchAll(verb)) {
    out.push({
      method: m[1]!.toUpperCase(),
      path: joinPath(prefix, m[2]!),
      routerFile: file,
      routerIdent: ident,
    });
  }

  // A router mounted on another router in the same file (runners.ts does this
  // for its agent half). Recurse so the composed path is the real one.
  const mount = new RegExp(`\\b${ident}\\.use\\(\\s*['\`]([^'\`]+)['\`]\\s*,\\s*(\\w+)`, 'g');
  for (const m of text.matchAll(mount)) {
    out.push(...declaredIn(file, text, m[2]!, joinPath(prefix, m[1]!), seen));
  }
  return out;
}

interface RouterAudit {
  routes: DeclaredRoute[];
  /** Router idents that are exported by a routes/ file. */
  exported: Map<string, string>;
  mounted: Map<string, string[]>;
}

function auditRouters(): RouterAudit | null {
  const indexPath = join(ROOT, 'apps/api/src/index.ts');
  const routesDir = join(ROOT, 'apps/api/src/routes');
  if (!existsSync(indexPath) || !existsSync(routesDir)) {
    add({
      check: 'api-routers',
      severity: 'skip',
      what: 'apps/api',
      detail: 'apps/api/src/index.ts or apps/api/src/routes is missing',
      fix: 'Run this from the repo root; if the API moved, update the paths at the top of scripts/check-wiring.ts.',
    });
    return null;
  }

  // Comments stripped before parsing. A commented-out `// app.use('/coverage',
  // coverageRouter)` still contains the text of a mount, and the static half of
  // this check read it as one — verified by commenting that exact line out: only
  // the live probe caught it. Both halves have to be honest, because the live
  // probe is the half that gets skipped when there is no API to talk to.
  const indexSrc = stripComments(read(indexPath));

  // ident -> route file it was imported from
  const importedFrom = new Map<string, string>();
  for (const m of indexSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes\/([\w-]+)\.js'/g)) {
    const file = join(routesDir, `${m[2]!}.ts`);
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) importedFrom.set(name, file);
    }
  }

  // ident -> prefixes it is mounted at
  const mounted = new Map<string, string[]>();
  for (const m of indexSrc.matchAll(/app\.use\(\s*(?:'([^']*)'\s*,\s*)?([A-Za-z_$][\w$]*)\s*\)/g)) {
    const ident = m[2]!;
    if (!importedFrom.has(ident)) continue;
    const list = mounted.get(ident) ?? [];
    list.push(m[1] ?? '/');
    mounted.set(ident, list);
  }

  // Every router a routes/ file exports.
  const exported = new Map<string, string>();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || isTestFile(file)) continue;
    const full = join(routesDir, file);
    for (const m of read(full).matchAll(/export\s+const\s+(\w+)(?:\s*:\s*Router)?\s*=\s*Router\(/g)) {
      exported.set(m[1]!, full);
    }
  }

  const routes: DeclaredRoute[] = [];
  for (const [ident, file] of exported) {
    const prefixes = mounted.get(ident);
    if (!prefixes || prefixes.length === 0) {
      add({
        check: 'api-routers',
        severity: 'fail',
        what: ident,
        detail: `${rel(file)} exports ${ident}, and apps/api/src/index.ts never mounts it. Every path it declares is unreachable.`,
        fix: `Add app.use('/<prefix>', ${ident}) in apps/api/src/index.ts, or delete the router.`,
      });
      continue;
    }
    const text = read(file);
    for (const prefix of prefixes) {
      routes.push(...declaredIn(file, text, ident, prefix, new Set()));
    }
  }

  if (routes.length === 0) {
    add({
      check: 'api-routers',
      severity: 'fail',
      what: 'route table',
      detail: 'Parsed zero routes out of apps/api/src/routes — the parser, not the app, is broken.',
      fix: 'Check the router-declaration regexes in scripts/check-wiring.ts against the current style of apps/api/src/routes/*.ts.',
    });
    return null;
  }

  return { routes, exported, mounted };
}

const API_URL = process.env.QAAI_API_URL ?? 'http://localhost:4000';
const PROBE_EMAIL = process.env.QAAI_PROBE_EMAIL ?? 'owner@qaai.local';
const PROBE_PASSWORD = process.env.QAAI_PROBE_PASSWORD ?? 'qaai-demo-password-1';

async function login(): Promise<{ cookie: string } | { skip: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PASSWORD }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return {
      skip: `No API answering at ${API_URL}. Start it with \`npm run dev\` (or point QAAI_API_URL at a running one) to prove the routes actually answer.`,
    };
  }
  if (!res.ok) {
    return {
      skip: `${API_URL} is up but rejected the probe login for ${PROBE_EMAIL} (HTTP ${res.status}). Seed the demo org with \`npm run db:seed\`, or set QAAI_PROBE_EMAIL / QAAI_PROBE_PASSWORD.`,
    };
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /qaai_session=([^;]+)/.exec(setCookie)?.[1];
  if (!token) {
    return {
      skip: `${API_URL} accepted the login but sent no qaai_session cookie, so no authenticated probe is possible.`,
    };
  }
  return { cookie: `qaai_session=${token}` };
}

/** The exact body notFoundHandler produces for a path no router claims. */
function isUnmountedResponse(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return typeof parsed.error?.message === 'string' && parsed.error.message.startsWith('No route for');
  } catch {
    return false;
  }
}

async function probeRoutes(audit: RouterAudit): Promise<void> {
  const session = await login();
  if ('skip' in session) {
    add({
      check: 'api-routes-answer',
      severity: 'skip',
      what: `${audit.routes.length} declared routes`,
      detail: session.skip,
      fix: session.skip,
    });
    return;
  }

  // One probe per (method, path). GET is free of side effects. A non-GET is
  // only probed when its path has a param to poison — see rule 4 in the header.
  const byRouter = new Map<string, DeclaredRoute[]>();
  for (const r of audit.routes) {
    const list = byRouter.get(r.routerIdent) ?? [];
    list.push(r);
    byRouter.set(r.routerIdent, list);
  }

  let probed = 0;
  const unprovable: string[] = [];

  for (const [ident, routes] of byRouter) {
    const candidates = routes.filter((r) => {
      if (UNSAFE_TO_PROBE.some((u) => u.method === r.method && u.path === r.path)) return false;
      if (r.method === 'GET') return true;
      return r.path.includes(':'); // poisonable, so the handler bails early
    });

    if (candidates.length === 0) {
      unprovable.push(ident);
      continue;
    }

    for (const route of candidates) {
      const url = API_URL + route.path.replace(/:([\w]+)/g, PROBE_TOKEN);
      let status = 0;
      let body = '';
      try {
        const res = await fetch(url, {
          method: route.method,
          headers: {
            cookie: session.cookie,
            'content-type': 'application/json',
            // Greppable in the API log, so a probe is never mistaken for traffic.
            'x-qaai-wiring-probe': '1',
          },
          ...(route.method === 'GET' ? {} : { body: '{}' }),
          signal: AbortSignal.timeout(20_000),
        });
        status = res.status;
        body = await res.text();
      } catch (err) {
        add({
          check: 'api-routes-answer',
          severity: 'warn',
          what: `${route.method} ${route.path}`,
          detail: `Probe threw: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Re-run with the API idle; a timeout here usually means the handler is slow, not missing.',
        });
        continue;
      }
      probed++;

      if (isUnmountedResponse(status, body)) {
        add({
          check: 'api-routes-answer',
          severity: 'fail',
          what: `${route.method} ${route.path}`,
          detail: `Declared in ${rel(route.routerFile)} on ${ident}, but the running API answers "No route for ${route.method} ${route.path}" to an AUTHENTICATED request — nothing is mounted there.`,
          fix: `Check the prefix ${ident} is mounted at in apps/api/src/index.ts against the path the router declares.`,
        });
      }
    }
  }

  for (const ident of unprovable) {
    add({
      check: 'api-routes-answer',
      severity: 'warn',
      what: ident,
      detail: `Every route on ${ident} is a mutating path with no parameter to poison, so probing it would have real side effects. Its mounting is proved statically only.`,
      fix: 'Give it one GET, or accept the static proof.',
    });
  }

  for (const u of UNSAFE_TO_PROBE) {
    if (!audit.routes.some((r) => r.method === u.method && r.path === u.path)) continue;
    add({
      check: 'api-routes-answer',
      severity: 'warn',
      what: `${u.method} ${u.path}`,
      detail: `Not probed on purpose: ${u.why}.`,
      fix: 'Verify this one by hand when you touch it.',
    });
  }

  okIfClean(
    'api-routes-answer',
    `${probed} routes`,
    `Answered a real authenticated request at ${API_URL}.`,
  );
}

// ─── 2. Queues: every producer has a consumer ────────────────────────────────

function queueNameConstants(): Map<string, string> {
  // ident (or QUEUE_NAMES.key) -> redis queue name
  const map = new Map<string, string>();

  const constants = join(ROOT, 'packages/shared/src/constants.ts');
  if (existsSync(constants)) {
    const block = /export const QUEUE_NAMES = \{([\s\S]*?)\} as const;/.exec(read(constants));
    for (const m of (block?.[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
      map.set(`QUEUE_NAMES.${m[1]!}`, m[2]!);
    }
  }

  // Queues declared outside QUEUE_NAMES — bisect and github checks both do this.
  for (const s of SOURCES) {
    for (const m of s.text.matchAll(/export const (\w*QUEUE\w*)\s*=\s*'([^']+)'/g)) {
      map.set(m[1]!, m[2]!);
    }
  }
  return map;
}

function checkQueues(): { names: Set<string>; consumers: Set<string> } {
  const constants = queueNameConstants();
  const resolveExpr = (expr: string): string | null => constants.get(expr.trim()) ?? null;

  const produced = new Map<string, string[]>();
  const consumed = new Map<string, string[]>();

  for (const s of productionSources()) {
    const isWorker = s.path.includes(`${'apps'}/worker/`);

    // Producers: enqueue('name'|IDENT, …) and new Queue(expr, …)
    for (const m of s.flat.matchAll(/\benqueue(?:Sharded)?\(\s*([^,)]+)/g)) {
      const name = resolveExpr(m[1]!) ?? literal(m[1]!);
      if (name) push(produced, name, s.path);
    }
    for (const m of s.flat.matchAll(/new Queue\(\s*([^,)]+)/g)) {
      const name = resolveExpr(m[1]!) ?? literal(m[1]!);
      if (name) push(produced, name, s.path);
    }

    if (!isWorker) continue;

    // Consumers: a BullMQ Worker, however it is wrapped. apps/worker/src/index.ts
    // wraps every registration in a local `register<T>(name, concurrency, fn)`,
    // so matching only `new Worker(` would report ten live queues as unconsumed.
    for (const m of s.flat.matchAll(/new Worker\(\s*([^,)]+)/g)) {
      const name = resolveExpr(m[1]!) ?? literal(m[1]!);
      if (name) push(consumed, name, s.path);
    }
    for (const m of s.flat.matchAll(/\bregister(?:<[^>]*>)?\(\s*([^,)]+)/g)) {
      const name = resolveExpr(m[1]!) ?? literal(m[1]!);
      if (name) push(consumed, name, s.path);
    }
  }

  const all = new Set<string>([...constants.values(), ...produced.keys(), ...consumed.keys()]);

  for (const name of all) {
    const hasProducer = produced.has(name);
    const hasConsumer = consumed.has(name);
    if (hasProducer && !hasConsumer) {
      add({
        check: 'queues',
        severity: 'fail',
        what: name,
        detail: `Enqueued by ${(produced.get(name) ?? []).map(rel).join(', ')} and no worker in apps/worker registers a consumer. Every job on it waits forever.`,
        fix: `Add a register(...) call for '${name}' in apps/worker/src/index.ts, or stop enqueuing to it.`,
      });
    } else if (!hasProducer && hasConsumer) {
      add({
        check: 'queues',
        severity: 'warn',
        what: name,
        detail: `A consumer is registered in ${(consumed.get(name) ?? []).map(rel).join(', ')} and nothing in the repo enqueues to it. Either it is fed from outside, or it is dead.`,
        fix: 'Confirm an external producer exists, or drop the worker registration.',
      });
    } else if (!hasProducer && !hasConsumer) {
      add({
        check: 'queues',
        severity: 'fail',
        what: name,
        detail: 'Declared as a queue name and neither produced to nor consumed from.',
        fix: 'Delete the constant, or wire both halves.',
      });
    }
  }

  return { names: all, consumers: new Set(consumed.keys()) };
}

function literal(expr: string): string | null {
  const m = /^\s*['"`]([^'"`]+)['"`]\s*$/.exec(expr);
  return m?.[1] ?? null;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

/**
 * The execution half of the queue check: ask Redis which queues actually have a
 * live BullMQ worker attached. Static registration proves the code exists;
 * `getWorkers()` proves the process is running and listening.
 */
async function probeQueueConsumers(names: Set<string>): Promise<void> {
  let Queue: typeof import('bullmq').Queue;
  let IORedis: typeof import('ioredis').default;
  try {
    ({ Queue } = await import('bullmq'));
    IORedis = (await import('ioredis')).default;
  } catch {
    add({
      check: 'queues-live',
      severity: 'skip',
      what: 'bullmq',
      detail: 'bullmq/ioredis are not installed at the repo root.',
      fix: 'Run `npm install` to let this check ask Redis which queues have a live consumer.',
    });
    return;
  }

  const url = process.env.REDIS_URL ?? envFileValue('REDIS_URL') ?? 'redis://localhost:6379';
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  connection.on('error', () => {});

  try {
    await connection.connect();
  } catch {
    add({
      check: 'queues-live',
      severity: 'skip',
      what: names.size + ' queues',
      detail: `No Redis at ${url}.`,
      fix: 'Start Redis (`docker compose up -d redis`) to prove each queue has a live consumer, not just a registration in source.',
    });
    connection.disconnect();
    return;
  }

  const dead: string[] = [];
  for (const name of [...names].sort()) {
    const queue = new Queue(name, { connection });
    try {
      const workers = await queue.getWorkers();
      if (workers.length === 0) dead.push(name);
    } finally {
      await queue.close().catch(() => {});
    }
  }
  connection.disconnect();

  if (dead.length === names.size) {
    // The worker process is simply not running. That is an environment fact,
    // not a wiring defect, and failing on it would make this check unrunnable
    // on a laptop.
    add({
      check: 'queues-live',
      severity: 'skip',
      what: `${names.size} queues`,
      detail: 'Redis is up and no queue has a live consumer — the worker process is not running.',
      fix: 'Start it with `npm run dev:worker` to prove consumers attach.',
    });
    return;
  }

  for (const name of dead) {
    add({
      check: 'queues-live',
      severity: 'fail',
      what: name,
      detail: `The worker is running and attached to ${names.size - dead.length} of ${names.size} queues, but NOT to '${name}'. Jobs enqueued here are never picked up.`,
      fix: `Register a consumer for '${name}' in apps/worker/src/index.ts.`,
    });
  }

  okIfClean(
    'queues-live',
    `${names.size - dead.length}/${names.size} queues`,
    'Have a live BullMQ consumer attached in Redis right now.',
  );
}

/** Reads a value out of the repo-root .env without pulling in dotenv. */
function envFileValue(key: string): string | null {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return null;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(read(file));
  return m?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
}

// ─── 3. Package exports: public API vs dead module ───────────────────────────

function checkPackageExports(): void {
  const pkgRoot = join(ROOT, 'packages');
  if (!existsSync(pkgRoot)) return;

  const graph = importGraph();

  for (const pkg of readdirSync(pkgRoot)) {
    const src = join(pkgRoot, pkg, 'src');
    const manifest = join(pkgRoot, pkg, 'package.json');
    if (!existsSync(src) || !existsSync(manifest)) continue;

    const json = JSON.parse(read(manifest)) as {
      main?: string;
      bin?: Record<string, string> | string;
      exports?: unknown;
    };

    // Entry points are roots by definition: a bin or a package main is consumed
    // from outside the repo, so "nothing imports it" says nothing about it.
    const roots = new Set<string>();
    const addRoot = (p?: string): void => {
      if (p) roots.add(resolve(join(pkgRoot, pkg), p));
    };
    addRoot(json.main);
    if (typeof json.bin === 'string') addRoot(json.bin);
    else if (json.bin) for (const v of Object.values(json.bin)) addRoot(v);
    addRoot(join('src', 'index.ts'));

    // The barrel is the package's declared public API.
    const barrel = join(src, 'index.ts');
    const reexported = new Set<string>();
    if (existsSync(barrel)) {
      for (const m of read(barrel).matchAll(/from\s*'\.\/([\w./-]+)\.js'/g)) {
        reexported.add(resolve(src, `${m[1]!}.ts`));
      }
    }

    for (const file of walk(src)) {
      if (!file.endsWith('.ts') || isTestFile(file)) continue;
      if (roots.has(file) || reexported.has(file)) continue;

      if (graph.production.has(file)) continue;

      add({
        check: 'package-exports',
        severity: 'fail',
        what: rel(file),
        detail: graph.test.has(file)
          ? 'Nothing but a test file imports it, and the package barrel does not re-export it — so it ships as tested, unreachable code.'
          : 'No production file imports it and the package barrel does not re-export it.',
        fix: `Either re-export it from ${rel(barrel)} (making it public API on purpose) or delete it.`,
      });
    }
  }
}

// ─── 4. npm scripts point at files that exist ────────────────────────────────

function manifests(): string[] {
  const out = [join(ROOT, 'package.json')];
  for (const group of ['packages', 'apps']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function checkNpmScripts(): void {
  const workspaceNames = new Map<string, string>(); // package name -> dir
  for (const m of manifests()) {
    const json = JSON.parse(read(m)) as { name?: string };
    if (json.name) workspaceNames.set(json.name, m);
  }

  for (const manifest of manifests()) {
    const dir = resolve(manifest, '..');
    const json = JSON.parse(read(manifest)) as { scripts?: Record<string, string> };
    for (const [name, command] of Object.entries(json.scripts ?? {})) {
      for (const target of scriptTargets(command)) {
        // `start` points into dist/, which exists only after `build`. A check
        // that failed on a clean tree would be telling the truth about the
        // filesystem and lying about the repo.
        if (/^\.?\/?(dist|build|out|\.next)\//.test(target)) continue;
        if (existsSync(resolve(dir, target))) continue;
        add({
          check: 'npm-scripts',
          severity: 'fail',
          what: `${rel(manifest)} → ${name}`,
          detail: `\`${command}\` refers to ${target}, which does not exist relative to ${rel(dir)}.`,
          fix: 'Create the file or fix the script. An advertised script that cannot run is the same thing as no script.',
        });
      }

      // `npm run x -w @scope/pkg` must name a workspace that has script x.
      const delegated = /npm run ([\w:-]+)\s+-w\s+(\S+)/.exec(command);
      if (delegated) {
        const targetManifest = workspaceNames.get(delegated[2]!);
        if (!targetManifest) {
          add({
            check: 'npm-scripts',
            severity: 'fail',
            what: `${rel(manifest)} → ${name}`,
            detail: `Delegates to workspace ${delegated[2]}, which is not a workspace in this repo.`,
            fix: 'Fix the -w target or remove the script.',
          });
        } else {
          const targetScripts = (JSON.parse(read(targetManifest)) as { scripts?: Record<string, string> })
            .scripts ?? {};
          if (!targetScripts[delegated[1]!]) {
            add({
              check: 'npm-scripts',
              severity: 'fail',
              what: `${rel(manifest)} → ${name}`,
              detail: `Delegates to \`${delegated[1]}\` in ${delegated[2]}, which has no such script.`,
              fix: `Add ${delegated[1]} to ${rel(targetManifest)} or drop the delegation.`,
            });
          }
        }
      }
    }
  }
}

/**
 * A workspace script that the repo-wide sweep never reaches.
 *
 * `npm run typecheck --workspaces --if-present` looks like it covers everything.
 * It does not, in two ways, and both are silent — the sweep still exits 0:
 *
 *   1. `--if-present` SKIPS a workspace with no such script. apps/desktop had no
 *      `typecheck`, so "all 10 workspaces are clean" was really 9.
 *   2. npm addresses workspaces by NAME, so two packages with the same name
 *      collapse into one. The root package and packages/cli were both `qaai`,
 *      and the CLI — the package customers install to run suites in their own
 *      CI — was excluded from every sweep in the repo.
 *
 * Neither failure prints anything. The only way to see them is to count what ran
 * against what exists, which is what this does.
 */
function checkWorkspaceSweeps(): void {
  const SWEPT = ['typecheck', 'test'];

  const byName = new Map<string, string[]>(); // package name -> manifests claiming it
  const own = new Map<string, { scripts: Record<string, string>; manifest: string }>();
  const rootManifest = join(ROOT, 'package.json');

  for (const m of manifests()) {
    const json = JSON.parse(read(m)) as { name?: string; scripts?: Record<string, string> };
    if (!json.name) continue;
    push(byName, json.name, rel(m));
    if (m !== rootManifest) own.set(rel(m), { scripts: json.scripts ?? {}, manifest: rel(m) });
  }

  for (const [name, claimants] of byName) {
    if (claimants.length < 2) continue;
    add({
      check: 'workspace-sweeps',
      severity: 'fail',
      what: `two packages named ${name}`,
      detail: `${claimants.join(' and ')} share a name, so \`npm run <script> --workspaces\` addresses only one of them. The other is silently excluded from every repo-wide sweep and the sweep still exits 0.`,
      fix: 'Rename one. The private root is the one whose name is cosmetic.',
    });
  }

  // Which workspaces the root sweeps, read from the root's own scripts rather
  // than assumed — if someone narrows the sweep with -w flags, this follows.
  const rootScripts = (JSON.parse(read(rootManifest)) as { scripts?: Record<string, string> })
    .scripts ?? {};

  for (const sweep of SWEPT) {
    const command = rootScripts[sweep];
    if (!command || !command.includes('--workspaces')) continue;

    for (const [path, { scripts }] of own) {
      if (scripts[sweep]) continue;
      // A workspace with nothing to check is fine — say why it is exempt rather
      // than requiring a no-op script for its own sake.
      const dir = join(ROOT, path, '..');
      const checkable = sourceFiles().some((f) => f.startsWith(dir + '/'));
      if (!checkable) continue;

      add({
        check: 'workspace-sweeps',
        severity: 'fail',
        what: `${path} has no ${sweep} script`,
        detail: `Root \`${sweep}\` runs \`${command}\`, and --if-present skips this workspace without a word. Its source is never ${sweep === 'test' ? 'tested' : 'checked'}, and the sweep reports success.`,
        fix: `Add a ${sweep} script that does whatever honestly applies to this workspace, even if that is \`node --check\`.`,
      });
    }
  }
}

/**
 * The desktop shell boots the backend by shelling out:
 *
 *   spawn('npm', ['run', 'dev', '-w', service.workspace])
 *
 * `service.workspace` is a variable, so the `-w` check above — which reads
 * package.json scripts and matches a literal `-w @scope/pkg` — cannot see it.
 * The names live in a SERVICES table instead, and nothing validated them:
 * renaming a workspace or dropping its `dev` script would leave the desktop app
 * spawning a command that fails, with the only symptom being a splash screen
 * that says "starting api…" until the 90s timeout and then an error dialog.
 *
 * Health paths get the same treatment. `{ port: 5050, healthPath: '/__health' }`
 * is a claim that the demo store serves that route; if it stops doing so, boot
 * hangs for 90 seconds and blames the wrong service.
 */
function checkDesktopServices(): void {
  const file = SOURCES.find((s) => rel(s.path) === 'apps/desktop/src/main.cjs');
  if (!file) return; // The app is optional; its absence is not a defect.

  const scriptsOf = new Map<string, Record<string, string>>();
  for (const m of manifests()) {
    const json = JSON.parse(read(m)) as { name?: string; scripts?: Record<string, string> };
    if (json.name) scriptsOf.set(json.name, json.scripts ?? {});
  }

  // The literal `npm run <script>` the shell spawns, read from the source rather
  // than assumed — if someone changes it to `start`, this check follows.
  const spawned = /\bspawn\(\s*'npm'\s*,\s*\[\s*'run'\s*,\s*'([\w:-]+)'/.exec(file.flat);
  const script = spawned?.[1] ?? 'dev';

  const services = [
    ...file.text.matchAll(
      /\{\s*name:\s*'([^']+)'\s*,\s*workspace:\s*'([^']+)'\s*,\s*port:\s*(\d+|null)\s*,\s*healthPath:\s*('[^']*'|null)/g,
    ),
  ];

  if (services.length === 0) {
    add({
      check: 'desktop',
      severity: 'fail',
      what: 'apps/desktop SERVICES',
      detail:
        'The SERVICES table could not be parsed, so none of the workspaces or health paths ' +
        'the desktop app boots are being validated.',
      fix: 'Either restore the table\'s shape or update checkDesktopServices. A check that silently matches nothing is worse than no check.',
    });
    return;
  }

  for (const [, name, workspace, port, healthPath] of services) {
    const target = scriptsOf.get(workspace!);
    if (!target) {
      add({
        check: 'desktop',
        severity: 'fail',
        what: `apps/desktop → ${name}`,
        detail: `Boots workspace ${workspace}, which is not a workspace in this repo.`,
        fix: 'Fix the name in SERVICES. The app spawns it on every launch and waits 90s for a port that will never open.',
      });
      continue;
    }
    if (!target[script]) {
      add({
        check: 'desktop',
        severity: 'fail',
        what: `apps/desktop → ${name}`,
        detail: `Runs \`npm run ${script} -w ${workspace}\`, but ${workspace} has no ${script} script.`,
        fix: `Add ${script} to ${workspace} or change what the desktop shell spawns.`,
      });
      continue;
    }

    // A health path is only checked for services that have a port to probe.
    if (port === 'null' || healthPath === 'null') continue;
    const route = healthPath!.slice(1, -1);
    if (route === '/') continue; // Any framework serves its own root.

    // The route has to be declared by whichever app owns that port. Matching on
    // the literal is enough: these are hand-written probe paths, not built ones.
    const owner = SOURCES.filter((s) => rel(s.path).startsWith(`apps/${name}/`));
    const served = owner.some((s) => s.flat.includes(`'${route}'`) || s.flat.includes(`"${route}"`));
    if (!served) {
      add({
        check: 'desktop',
        severity: 'fail',
        what: `apps/desktop → ${name} ${route}`,
        detail: `Waits on ${route} to decide ${name} is up, but no source file in apps/${name} declares that route.`,
        fix: 'Point healthPath at a route the service actually serves. Otherwise launch hangs for 90s and reports the wrong service as broken.',
      });
    }
  }
}

/** File paths a script command depends on. Only forms we can judge honestly. */
function scriptTargets(command: string): string[] {
  const out: string[] = [];
  for (const part of command.split(/\s*&&\s*/)) {
    const tsx = /(?:^|\s)(?:tsx|node|ts-node)(?:\s+watch)?\s+([^\s]+\.(?:ts|mjs|cjs|js))/.exec(part);
    if (tsx) out.push(tsx[1]!);
    const proj = /(?:tsc|vitest|eslint)[^&|]*?-p\s+([^\s]+\.json)/.exec(part);
    if (proj) out.push(proj[1]!);
    const config = /--config\s+([^\s]+\.(?:ts|js|mjs|json))/.exec(part);
    if (config) out.push(config[1]!);
    const schema = /--schema\s+([^\s]+\.prisma)/.exec(part);
    if (schema) out.push(schema[1]!);
  }
  return out;
}

// ─── 5. Every TestType has a plugin and can be created ───────────────────────

async function checkTestTypes(): Promise<void> {
  let TEST_TYPES: readonly string[];
  let createTestSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
  let pluginFor: (t: string) => unknown;

  try {
    const shared = (await import('@qaai/shared')) as unknown as {
      TEST_TYPES: readonly string[];
      createTestSchema: typeof createTestSchema;
    };
    TEST_TYPES = shared.TEST_TYPES;
    createTestSchema = shared.createTestSchema;
    const registry = (await import('../packages/runner/src/registry.js')) as unknown as {
      pluginFor: typeof pluginFor;
    };
    pluginFor = registry.pluginFor;
  } catch (err) {
    add({
      check: 'test-types',
      severity: 'skip',
      what: 'TEST_TYPES',
      detail: `Could not load @qaai/shared and the runner registry: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Run `npm install` at the repo root so the workspace packages resolve.',
    });
    return;
  }

  const prismaEnum = prismaEnumMembers('TestType');

  for (const type of TEST_TYPES) {
    if (pluginFor(type) == null) {
      add({
        check: 'test-types',
        severity: 'fail',
        what: type,
        detail: 'pluginFor() returns null, so every test of this type is recorded SKIPPED at run time.',
        fix: `Register a plugin for ${type} in packages/runner/src/registry.ts, or take it out of TEST_TYPES.`,
      });
    }
    // Creatable: the schema the create-test route parses must accept the type.
    // The other fields are the schema's own required minimum; only `type` is
    // under test, so they are held constant and valid across every iteration.
    const candidate = {
      name: 'wiring probe',
      type,
      code: '// wiring probe',
      filePath: 'tests/wiring-probe.spec.ts',
    };
    if (!createTestSchema.safeParse(candidate).success) {
      add({
        check: 'test-types',
        severity: 'fail',
        what: type,
        detail: 'createTestSchema rejects it, so nothing can create a test of this type through the API.',
        fix: 'Widen the type enum in packages/shared/src/schemas.ts.',
      });
    }
    if (prismaEnum && !prismaEnum.includes(type)) {
      add({
        check: 'test-types',
        severity: 'fail',
        what: type,
        detail: 'Missing from the Prisma TestType enum, so a row of this type cannot be stored.',
        fix: 'Add it to enum TestType in apps/api/prisma/schema.prisma and migrate.',
      });
    }
  }

  okIfClean(
    'test-types',
    `${TEST_TYPES.length} types`,
    'Each resolves to a plugin, is accepted by createTestSchema, and exists in the Prisma enum.',
  );
}

function schemaPrisma(): string | null {
  const p = join(ROOT, 'apps/api/prisma/schema.prisma');
  return existsSync(p) ? read(p) : null;
}

function prismaEnumMembers(name: string): string[] | null {
  const src = schemaPrisma();
  if (!src) return null;
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(src);
  if (!block) return null;
  return block[1]!
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z_][A-Z0-9_]*$/.test(l));
}

// ─── 6. Env vars: read means documented, documented means read ───────────────

/** Vars supplied by the platform, not by .env. Not config anyone sets here. */
const AMBIENT_ENV = new Set([
  'NODE_ENV',
  'CI',
  'PATH',
  'HOME',
  'PWD',
  'TERM',
  'TZ',
  'USER',
  'SHELL',
  'FORCE_COLOR',
  'NO_COLOR',
  'npm_config_user_agent',
  'npm_lifecycle_event',
  'PLAYWRIGHT_BROWSERS_PATH', // set by the Dockerfiles, never by an operator
  'HOSTNAME', // the container's own name, supplied by the runtime
  'NAME', // Dockerfile ARG interpolation, not a runtime read
]);

/**
 * Files that EMIT source code. A `process.env.X` inside one of these is a read
 * belonging to the repo QAAI generates for a customer, not a read QAAI performs
 * — so it must not be demanded of this repo's .env.example. Listed by name
 * rather than sniffed for, because guessing wrong in either direction here is
 * how a check starts crying wolf.
 */
const CODE_GENERATORS = new Set([
  'apps/api/src/lib/repo-export.ts',
  'packages/agent/src/ecosystem-prompts.ts',
  // This file: its own probe knobs are tooling config, not deployment config.
  'scripts/check-wiring.ts',
]);

function envKeysDocumented(file: string): Set<string> {
  const p = join(ROOT, file);
  if (!existsSync(p)) return new Set();
  return new Set(
    [...read(p).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  );
}

function checkEnvVars(): void {
  const rootExample = envKeysDocumented('.env.example');
  const deployExample = envKeysDocumented('deploy/.env.example');

  if (rootExample.size === 0) {
    add({
      check: 'env-vars',
      severity: 'skip',
      what: '.env.example',
      detail: 'No .env.example at the repo root, so there is nothing to check reads against.',
      fix: 'Create .env.example listing every variable the apps read.',
    });
    return;
  }

  // Where each var is read. A var read only by a test or a test fixture is not
  // operator-facing config and does not belong in .env.example.
  const readers = new Map<string, string[]>();
  for (const s of SOURCES) {
    if (CODE_GENERATORS.has(rel(s.path))) continue;
    const keys = new Set<string>();
    for (const m of s.text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]!);
    for (const m of s.text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) keys.add(m[1]!);
    // `import { env } from 'node:process'` — how packages/cli reads its config.
    // Missing this form is how QAAI_API_URL and QAAI_API_KEY stayed undocumented.
    if (/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*'node:process'/.test(s.text)) {
      for (const m of s.text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]!);
    }
    /*
     * Indirect reads: `envNumber('QAAI_RETENTION_BATCH_SIZE', 500)` wrapping a
     * `process.env[name]` lookup. Six real knobs — the browser pool's size and
     * idle timeout, four retention windows — are reachable ONLY this way, so a
     * scanner that knows just `process.env.X` calls all six undocumented and
     * then finds nothing when you go looking for them.
     *
     * The helper is IDENTIFIED first (a function whose body indexes
     * process.env), and only its own arguments are read as variable names. The
     * looser version of this — any uppercase literal in a file that mentions
     * process.env — demanded that PENDING, PROPOSED, GET, JWT and UNKNOWN be
     * added to .env.example. Enum members are not configuration.
     */
    // `(?!function)` matters: without it the lazy match starting at the FIRST
    // function in browser-pool.ts ran on into the body of the second one and
    // captured the wrong name, so envInt's two knobs were still reported
    // undocumented after they had been documented.
    for (const helper of s.text.matchAll(
      /function (\w+)\((?:(?!function)[\s\S]){0,240}?process\.env\[/g,
    )) {
      const call = new RegExp(`\\b${helper[1]!}\\(\\s*['"]([A-Z][A-Z0-9_]{2,})['"]`, 'g');
      for (const m of s.text.matchAll(call)) keys.add(m[1]!);
    }
    for (const key of keys) push(readers, key, s.path);
  }

  // The API's Zod env schema is a read of every key it declares.
  const apiEnv = join(ROOT, 'apps/api/src/env.ts');
  const schemaKeys = new Set<string>();
  if (existsSync(apiEnv)) {
    const block = /const schema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(read(apiEnv));
    for (const m of (block?.[1] ?? '').matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm)) {
      schemaKeys.add(m[1]!);
      push(readers, m[1]!, apiEnv);
    }
  }

  for (const [key, files] of readers) {
    if (AMBIENT_ENV.has(key)) continue;
    const productionReaders = files.filter((f) => !isTestFile(f) && !f.includes(`${'e2e'}/`));
    if (productionReaders.length === 0) continue; // test-only knob
    if (!rootExample.has(key)) {
      add({
        check: 'env-vars',
        severity: 'fail',
        what: key,
        detail: `Read by ${productionReaders.map(rel).join(', ')} and documented nowhere. Nobody deploying this can discover it.`,
        fix: `Add ${key} to .env.example with a comment saying what it does and what happens when it is unset.`,
      });
    }
  }

  /*
   * A key in the API's Zod env schema is a promise: this variable exists and
   * doing something with it changes something. Parsing it and never reading
   * `env.<KEY>` again breaks that promise silently — SLACK_WEBHOOK_URL,
   * LINEAR_API_KEY and SENTRY_DSN all sat here, all validated at boot, all
   * inert, and an operator who set SENTRY_DSN had every reason to believe
   * errors were being reported somewhere.
   *
   * Checked independently of .env.example, because deleting the documentation
   * line is not what makes an unread key honest.
   */
  for (const key of schemaKeys) {
    if (productionSources().some((s) => s.path !== apiEnv && s.flat.includes(`env.${key}`))) continue;
    add({
      check: 'env-vars',
      severity: 'fail',
      what: key,
      detail:
        'Declared in the Zod schema in apps/api/src/env.ts, validated at boot, and never read again. Setting it changes nothing.',
      fix: `Reference env.${key} where it is supposed to take effect, or remove it from the schema.`,
    });
  }

  // The other direction, and the one that produces silent no-ops: a variable an
  // operator can set that nothing in the code ever looks at.
  for (const key of rootExample) {
    if (AMBIENT_ENV.has(key)) continue;
    const files = (readers.get(key) ?? []).filter((f) => !isTestFile(f));
    const consumed = schemaKeys.has(key)
      ? // Being in the Zod schema is not consumption: env.SENTRY_DSN parsed and
        // never referenced again is exactly the defect this check is for.
        productionSources().some((s) => s.path !== apiEnv && s.flat.includes(`env.${key}`))
      : files.length > 0;
    if (!consumed) {
      add({
        check: 'env-vars',
        severity: 'fail',
        what: key,
        detail: `Documented in .env.example and read by nothing. Setting it changes no behaviour${schemaKeys.has(key) ? ' (it is parsed by apps/api/src/env.ts and then never referenced)' : ''}.`,
        fix: `Wire ${key} to the behaviour it promises, or delete it from .env.example${schemaKeys.has(key) ? ' and from the schema in apps/api/src/env.ts' : ''}.`,
      });
    }
  }

  // deploy/.env.example is a deliberate subset: docker-compose.yml supplies
  // DATABASE_URL, REDIS_URL and the S3 endpoint itself, so listing them again
  // would be noise. A var is only a deployment gap when NEITHER file mentions
  // it — checked against compose rather than guessed at from the name, because
  // a name-prefix heuristic reported eleven correctly-wired vars as gaps.
  const compose = ['docker-compose.yml', 'docker-compose.override.yml.example']
    .map((f) => join(ROOT, f))
    .filter(existsSync)
    .map(read)
    .join('\n');

  if (deployExample.size > 0) {
    for (const key of rootExample) {
      if (deployExample.has(key) || compose.includes(key)) continue;
      // Only the ones a production deployment genuinely has to supply. A dev
      // convenience left out of the deploy example is not a defect.
      if (!/^(SESSION_SECRET|VAULT_MASTER_KEY|STRIPE_|GITHUB_APP|GITHUB_WEBHOOK)/.test(key)) continue;
      add({
        check: 'env-vars',
        severity: 'warn',
        what: key,
        detail:
          'In .env.example, absent from deploy/.env.example, and never named in docker-compose.yml — so a docker deployment has no way to learn it exists.',
        fix: `Add ${key} to deploy/.env.example, or pass it through in docker-compose.yml.`,
      });
    }
  }
}

// ─── 7. Prisma models: read AND written ──────────────────────────────────────

function checkPrismaModels(): void {
  const src = schemaPrisma();
  if (!src) {
    add({
      check: 'prisma-models',
      severity: 'skip',
      what: 'schema.prisma',
      detail: 'apps/api/prisma/schema.prisma not found.',
      fix: 'Run this from the repo root.',
    });
    return;
  }

  const models = new Map<string, string>();
  for (const m of src.matchAll(/\nmodel (\w+) \{([\s\S]*?)\n\}/g)) models.set(m[1]!, m[2]!);

  // Relation field names pointing at each model, so a nested write
  // (`items: { create: … }`) or a nested read (`items: { select: … }`) counts.
  const relationFields = new Map<string, Set<string>>();
  for (const [, body] of models) {
    for (const line of body.split('\n')) {
      const m = /^\s*(\w+)\s+(\w+)(\[\])?\s*(\?)?\s*(@relation|$)/.exec(line.replace(/\/\/.*/, ''));
      if (!m) continue;
      const [, field, type] = m;
      if (!models.has(type!)) continue;
      const set = relationFields.get(type!) ?? new Set<string>();
      set.add(field!);
      relationFields.set(type!, set);
    }
  }

  /**
   * Tables whose reader is the database, not the application.
   *
   * SsoAssertionSeen is a replay guard: routes/sso.ts INSERTs the assertion id
   * and lets the unique index reject the second one. There is no SELECT and
   * there must not be one — a read-then-write would reintroduce exactly the race
   * the table exists to close. The check would otherwise report the one correct
   * implementation of replay protection as dead weight.
   */
  const READ_BY_CONSTRAINT = new Map<string, string>([
    ['SsoAssertionSeen', 'a unique-index replay guard; the INSERT is the read'],
  ]);

  const READ_OPS = ['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'];
  const WRITE_OPS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];

  for (const model of models.keys()) {
    const accessor = model[0]!.toLowerCase() + model.slice(1);
    const sources = productionSources();

    const hits = (ops: string[]): string[] =>
      sources
        .filter((s) => ops.some((op) => s.flat.includes(`.${accessor}.${op}`)))
        .map((s) => s.path);

    let reads = hits(READ_OPS);
    let writes = hits(WRITE_OPS);

    for (const field of relationFields.get(model) ?? []) {
      if (writes.length === 0) {
        const nested = sources.filter((s) =>
          ['create', 'createMany', 'connectOrCreate', 'upsert'].some((op) =>
            s.flat.includes(`${field}: { ${op}`),
          ),
        );
        if (nested.length) writes = nested.map((s) => s.path);
      }
      if (reads.length === 0) {
        const nested = sources.filter(
          (s) => s.flat.includes(`${field}: { select:`) || s.flat.includes(`${field}: true`),
        );
        if (nested.length) reads = nested.map((s) => s.path);
      }
    }

    if (reads.length === 0 && writes.length === 0) {
      add({
        check: 'prisma-models',
        severity: 'fail',
        what: model,
        detail: 'Nothing in the repo reads or writes this table. It is a schema entry for a feature that does not exist.',
        fix: `Build the feature, or drop model ${model} in a migration.`,
      });
    } else if (writes.length === 0) {
      add({
        check: 'prisma-models',
        severity: 'fail',
        what: model,
        detail: `Read by ${reads.map(rel).slice(0, 3).join(', ')} and written by nothing — every read returns an empty set forever.`,
        fix: `Find who was supposed to write ${model} rows, or drop the model and its reads.`,
      });
    } else if (reads.length === 0) {
      const exempt = READ_BY_CONSTRAINT.get(model);
      if (exempt) {
        add({
          check: 'prisma-models',
          severity: 'ok',
          what: model,
          detail: `Written and never selected, on purpose: ${exempt}.`,
          fix: '',
        });
        continue;
      }
      add({
        check: 'prisma-models',
        severity: 'fail',
        what: model,
        detail: `Written by ${writes.map(rel).slice(0, 3).join(', ')} and read by nothing — the rows pile up and no code path can ever surface them.`,
        fix: `Add the read path (an endpoint or a screen), or stop writing ${model} rows.`,
      });
    }
  }
}

// ─── 8. Feature flags gate something ─────────────────────────────────────────

function checkFeatureFlags(): void {
  const seed = join(ROOT, 'apps/api/prisma/seed.ts');
  if (!existsSync(seed)) return;

  const block = /featureFlag\.createMany\(\{([\s\S]*?)\}\);/.exec(read(seed));
  if (!block) return;

  const keys = [...block[1]!.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]!);
  if (keys.length === 0) return;

  // A flag is real only if something reads the flag store at request time.
  const readsFlags = productionSources().some(
    (s) =>
      s.flat.includes('.featureFlag.find') ||
      s.flat.includes('.featureFlagOverride.find') ||
      /\bisFlagEnabled\b|\bflagEnabled\b/.test(s.flat),
  );

  if (!readsFlags) {
    add({
      check: 'feature-flags',
      severity: 'fail',
      // Stable identity so the ratchet can name it; the keys go in the detail.
      what: 'the FeatureFlag store',
      detail: `prisma/seed.ts writes ${keys.length} FeatureFlag rows and no code path reads the flag store, so toggling any of them changes nothing.`,
      fix: 'Add a read path and gate the named features on it, or delete the seed block and the models.',
    });
  }
}

// ─── Ratchet + reporting ─────────────────────────────────────────────────────

function applyKnownGaps(): { suppressed: KnownGap[]; stale: KnownGap[] } {
  const suppressed: KnownGap[] = [];
  const stale: KnownGap[] = [];

  for (const gap of KNOWN_GAPS) {
    // Every matching finding, not the first: two checks can reach the same
    // disconnection from different directions (SESSION_SECRET is both an unread
    // schema key and an undocumented-behaviour env var), and downgrading one of
    // them would leave the ratchet looking applied while the build stayed red.
    const matches = findings.filter(
      (f) => f.check === gap.check && f.what === gap.what && f.severity === 'fail',
    );
    if (matches.length > 0) {
      for (const m of matches) m.severity = 'warn';
      suppressed.push(gap);
    } else {
      stale.push(gap);
    }
  }

  // One line per thing, however many checks found it.
  const seen = new Set<string>();
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i]!;
    const key = `${f.check}|${f.what}|${f.severity}`;
    if (seen.has(key)) findings.splice(i, 1);
    else seen.add(key);
  }

  return { suppressed, stale };
}

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const YELLOW = '[33m';
const BLUE = '[34m';
const GREEN = '[32m';
const OFF = '[0m';

const paint = (color: string, s: string): string => (process.stdout.isTTY ? color + s + OFF : s);

function report(suppressed: KnownGap[], stale: KnownGap[]): number {
  const fails = findings.filter((f) => f.severity === 'fail');
  const warns = findings.filter((f) => f.severity === 'warn');
  const skips = findings.filter((f) => f.severity === 'skip');
  const oks = findings.filter((f) => f.severity === 'ok');

  console.log(`\n${paint(BOLD, 'check-wiring')} — is anything in this repo connected to nothing?\n`);

  for (const f of oks) {
    console.log(`${paint(GREEN, '  ok  ')} ${paint(DIM, f.check.padEnd(18))} ${f.what} — ${f.detail}`);
  }

  if (skips.length) {
    console.log(`\n${paint(BLUE, 'SKIPPED')} — could not be proved here, and that is not a failure:`);
    for (const f of skips) {
      console.log(`  ${paint(DIM, f.check)} ${paint(BOLD, f.what)}`);
      console.log(`      ${f.detail}`);
      // Some skips carry the same sentence twice because the reason IS the fix.
      if (f.fix && f.fix !== f.detail) console.log(`      ${paint(BLUE, '→')} ${f.fix}`);
    }
  }

  if (warns.length) {
    console.log(`\n${paint(YELLOW, 'WARNINGS')}:`);
    for (const f of warns) {
      const gap = suppressed.find((g) => g.check === f.check && g.what === f.what);
      console.log(`  ${paint(DIM, f.check)} ${paint(BOLD, f.what)}`);
      console.log(`      ${f.detail}`);
      if (gap) {
        console.log(`      ${paint(YELLOW, 'KNOWN GAP')} ${gap.why}`);
        console.log(`      ${paint(YELLOW, '→')} ${gap.remediation}`);
      } else if (f.fix) {
        console.log(`      ${paint(YELLOW, '→')} ${f.fix}`);
      }
    }
  }

  for (const gap of stale) {
    console.log(
      `\n${paint(RED, 'STALE KNOWN_GAPS ENTRY')} ${gap.check}/${gap.what} no longer reproduces.`,
    );
    console.log(`      Delete it from KNOWN_GAPS in scripts/check-wiring.ts — a ratchet that only`);
    console.log(`      grows is an allowlist, and an allowlist is how this defect class hides.`);
  }

  if (fails.length) {
    console.log(`\n${paint(RED, 'DISCONNECTED')}:`);
    for (const f of fails) {
      console.log(`  ${paint(DIM, f.check)} ${paint(BOLD, f.what)}`);
      console.log(`      ${f.detail}`);
      console.log(`      ${paint(RED, '→')} ${f.fix}`);
    }
  }

  const failed = fails.length + stale.length;
  console.log(
    `\n${paint(BOLD, 'summary')}  ${fails.length} disconnected · ${stale.length} stale ratchet · ` +
      `${warns.length} warnings (${suppressed.length} known gaps) · ${skips.length} skipped\n`,
  );

  if (failed === 0 && suppressed.length > 0) {
    console.log(
      paint(DIM, `  ${suppressed.length} known gaps are listed above in full. They are not fixed;\n` +
        `  they are recorded. Each one fails this check the moment it stops reproducing.\n`),
    );
  }

  return failed === 0 ? 0 : 1;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadSources();

  const audit = auditRouters();
  if (audit) await probeRoutes(audit);

  const { names } = checkQueues();
  await probeQueueConsumers(names);

  checkPackageExports();
  checkNpmScripts();
  checkWorkspaceSweeps();
  checkDesktopServices();
  await checkTestTypes();
  checkEnvVars();
  checkPrismaModels();
  checkFeatureFlags();

  const { suppressed, stale } = applyKnownGaps();
  const code = report(suppressed, stale);

  // Importing the runner registry pulls in Playwright, which keeps handles open.
  // An explicit exit is the difference between a check that finishes and a CI
  // job that hangs for its whole timeout.
  process.exit(code);
}

void main().catch((err) => {
  console.error('check-wiring itself failed:', err);
  // A crashed check is a failed check. Never a silent pass.
  process.exit(2);
});
