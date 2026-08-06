/**
 * Per-type generation strategies (§3.2) — what the Generator is allowed to emit
 * for each TestType, derived from what that type's runner plugin will parse.
 *
 * The bug this file exists to prevent: the Generator used to write Playwright
 * prose for EVERY type. E2E and SMOKE ran; the fourteen spec-driven types
 * stored their spec as null, the plugin's validate() rejected it, and the test
 * FAILED "invalid spec" on its first run — a test the product authored and the
 * product's own runner could never execute. The runnable truth is the plugin,
 * not the enum, so every strategy here names the plugin's own schema and the
 * scaffolds are held to plugin.validate() in
 * apps/worker/src/processors/generate.test.ts.
 *
 * Three modes:
 *   code    E2E/SMOKE/CROSS_BROWSER — the plugin executes `code`; the existing
 *           ecosystem-prompt path already produces it honestly.
 *   spec    the plugin executes `spec` and never reads `code`; the model is
 *           asked for JSON against the plugin's schema, and validated against
 *           that same schema before anything is stored.
 *   hybrid  UNIT_GEN and LOCALIZATION need BOTH: real source code plus a spec
 *           telling the plugin how to run it (a command, a locale matrix).
 *
 * Without a model, each spec strategy either scaffolds deterministically from
 * the crawl or refuses with the standing no-key sentence — the per-type choice
 * and its justification live on each entry below. The scaffold baselines are
 * `NEW_TEST_TEMPLATES` from @qaai/shared: the editor ships the same shapes and
 * packages/runner/src/plugins/new-test-templates.test.ts already holds them to
 * every plugin's validate(), so the Generator and the editor cannot drift apart.
 */

import { z } from 'zod';
import {
  NEW_TEST_TEMPLATES,
  TEST_TYPE_LABELS,
  accessibilityTestSpecSchema,
  apiTestSpecSchema,
  cliTestSpecSchema,
  contractTestSpecSchema,
  databaseTestSpecSchema,
  emailOtpSpecSchema,
  externalTestSpecSchema,
  loadTestSpecSchema,
  localizationSpecSchema,
  mobileTestSpecSchema,
  mutationTestSpecSchema,
  performanceTestSpecSchema,
  protocolTestSpecSchema,
  securitySmokeSpecSchema,
  testFileSlug,
  visualTestSpecSchema,
} from '@qaai/shared';
import type { FlowMap, PlanItem, TestType } from '@qaai/shared';

// ─── Strategy shapes ─────────────────────────────────────────────────────────

export interface SpecScaffold {
  spec: unknown;
  reviewFlags: string[];
}

export interface ScaffoldArgs {
  item: PlanItem;
  flowMap: FlowMap;
}

export interface CodeStrategy {
  mode: 'code';
  /**
   * Stored alongside the generated code without asking the model. Only
   * CROSS_BROWSER uses it: its plugin defaults a missing spec to all three
   * engines, and seeding the list makes that visible and editable.
   */
  seededSpec?: unknown;
  /** The plugin executes `code` through the Playwright harness regardless of the project's own ecosystem. */
  forcePlaywright?: boolean;
}

export interface SpecDrivenStrategy {
  mode: 'spec';
  /** The plugin's own spec schema — the model's output is validated against it. */
  schema: z.ZodType;
  /** Directory the generated file lands in; the suffix comes from the editor's template. */
  dir: string;
  /** One paragraph of type-specific prompt guidance, beyond the schema dump. */
  specNotes: string;
  /** Deterministic no-model path. Present only when the crawl genuinely supplies the content. */
  scaffold?: (args: ScaffoldArgs) => SpecScaffold;
  /** Why no scaffold exists, finishing the sentence "…cannot be scaffolded without a model because". */
  refuseBecause?: string;
}

export interface HybridStrategy {
  mode: 'hybrid';
  schema: z.ZodType;
  specNotes: string;
  forcePlaywright?: boolean;
  /** Hybrids always refuse without a model: the code half is model work. */
  refuseBecause: string;
}

export type GenerationStrategy = CodeStrategy | SpecDrivenStrategy | HybridStrategy;

// ─── Crawl helpers for the deterministic scaffolds ───────────────────────────

/**
 * Distinct public routes, most-crawled-first order preserved. Dynamic segments
 * (`/orders/:id`) are excluded because a scaffold has no real id to substitute
 * — a literal ":id" request is a test that fails on every run.
 */
function publicRoutes(flowMap: FlowMap, cap: number): string[] {
  const seen = new Set<string>();
  const routes: string[] = [];
  for (const node of flowMap.nodes) {
    if (node.behindAuth || node.route.includes(':') || seen.has(node.route)) continue;
    seen.add(node.route);
    routes.push(node.route);
    if (routes.length >= cap) break;
  }
  // '/' is the one route every web app answers; an empty crawl still scaffolds.
  return routes.length > 0 ? routes : ['/'];
}

/** Routes the crawler hit an auth wall on — exactly what a security spec wants listed. */
function authWalledRoutes(flowMap: FlowMap, cap: number): string[] {
  const seen = new Set<string>();
  const routes: string[] = [];
  for (const node of flowMap.nodes) {
    if (!node.behindAuth || node.route.includes(':') || seen.has(node.route)) continue;
    seen.add(node.route);
    routes.push(node.route);
    if (routes.length >= cap) break;
  }
  return routes;
}

const SCAFFOLD_PREFIX = 'Scaffolded without a model (no ANTHROPIC_API_KEY):';

/** Every scaffold says what it deliberately did not express, so the plan's intent is not lost. */
function intentFlag(item: PlanItem): string {
  return `The plan item's own steps and assertions are not expressed here — intended assertions: ${item.assertions.join('; ')}`;
}

// ─── The table ───────────────────────────────────────────────────────────────

const STRATEGIES: Record<TestType, GenerationStrategy> = {
  E2E: { mode: 'code' },
  SMOKE: { mode: 'code' },

  CROSS_BROWSER: {
    mode: 'code',
    // Null would also be valid (the plugin defaults to all three engines), but
    // an explicit list is one a person can edit down without reading the plugin.
    seededSpec: NEW_TEST_TEMPLATES.CROSS_BROWSER?.spec,
    forcePlaywright: true,
  },

  API: {
    mode: 'spec',
    schema: apiTestSpecSchema,
    dir: 'api',
    specNotes:
      'Write the request chain the plan describes: each step is one HTTP request with ' +
      'assertions on status, latency, and body content. `path` is relative to the base URL. ' +
      'Use {{variables}} and per-step `extract` to thread values (ids, tokens) between steps. ' +
      'Reference secrets by {{NAME}}, never by value.',
    // Scaffold: a GET on a crawled route asserting it serves. Thin but REAL —
    // it runs, it can fail, and its flags say exactly what to replace. The
    // routes are the one thing the crawl actually knows about this API.
    scaffold: ({ item, flowMap }) => ({
      spec: {
        variables: {},
        steps: [
          {
            name: `TODO: replace with the real request chain for "${item.title}"`,
            method: 'GET',
            path: publicRoutes(flowMap, 1)[0],
            headers: {},
            assertions: { status: 200, maxLatencyMs: 2000 },
            extract: {},
          },
        ],
      },
      reviewFlags: [
        `${SCAFFOLD_PREFIX} a single GET asserting the route serves. Replace it with the requests and body assertions the plan item describes.`,
        intentFlag(item),
      ],
    }),
  },

  ACCESSIBILITY: {
    mode: 'spec',
    schema: accessibilityTestSpecSchema,
    dir: 'a11y',
    specNotes:
      'List the routes worth an axe scan — the ones the plan names, drawn from the crawled ' +
      'pages. Omit `tags` unless the plan asks for a different bar than WCAG 2.1 AA.',
    // Scaffold: the crawl IS the information an a11y spec needs (which routes
    // exist), so the no-model scaffold is close to what a model would write.
    scaffold: ({ item, flowMap }) => ({
      spec: { routes: publicRoutes(flowMap, 5) },
      reviewFlags: [
        `${SCAFFOLD_PREFIX} an axe WCAG 2.1 AA scan over routes read off the crawl. Add or remove routes as the plan intends.`,
        intentFlag(item),
      ],
    }),
  },

  SECURITY_SMOKE: {
    mode: 'spec',
    schema: securitySmokeSpecSchema,
    dir: 'security',
    specNotes:
      'Three independent check lists; fill the ones the plan calls for. `authRequiredPaths` ' +
      'are paths that must NOT serve without a session (the crawl marks these "behind auth"). ' +
      '`idorProbes` fetch object ids anonymously through a `{id}` template. `headerPaths` get ' +
      'their security headers inspected.',
    // Scaffold: the crawler already recorded which routes sat behind an auth
    // wall — that list is the test. Header checks run against any app, so the
    // spec is never empty. IDOR probes need real object ids we do not have.
    scaffold: ({ item, flowMap }) => {
      const authRequiredPaths = authWalledRoutes(flowMap, 10);
      return {
        spec: {
          authRequiredPaths,
          idorProbes: [],
          headerPaths: publicRoutes(flowMap, 3),
        },
        reviewFlags: [
          `${SCAFFOLD_PREFIX} auth-wall checks for the ${authRequiredPaths.length} route(s) the crawler saw behind auth, plus security-header checks. Add idorProbes with real object ids — those cannot be guessed.`,
          intentFlag(item),
        ],
      };
    },
  },

  VISUAL: {
    mode: 'spec',
    schema: visualTestSpecSchema,
    dir: 'visual',
    specNotes:
      'One route (or element, via `selector`) captured and diffed against a stored baseline. ' +
      'Add `ignoreRegions` for parts that legitimately change — clocks, avatars, ad slots.',
    // Scaffold: a visual spec is configuration, not judgement — a crawled route
    // plus the defaults is a complete, runnable test whose first run records
    // the baseline.
    scaffold: ({ item, flowMap }) => ({
      spec: { path: publicRoutes(flowMap, 1)[0], fullPage: true },
      reviewFlags: [
        `${SCAFFOLD_PREFIX} a full-page capture of a crawled route. The first run records the baseline; add ignoreRegions for anything that changes by design.`,
        intentFlag(item),
      ],
    }),
  },

  PERFORMANCE: {
    mode: 'spec',
    schema: performanceTestSpecSchema,
    dir: 'performance',
    specNotes:
      'Core Web Vitals for one route, gated on the median of several loads. Set `budgets` ' +
      'the plan can defend (Lighthouse’s classic bar is lcpMs 2500, clsScore 0.1) and add ' +
      '`interactions` so INP has real events to measure.',
    // Scaffold: like VISUAL, this is configuration over a crawled route. The
    // budgets are Lighthouse's published thresholds rather than nothing,
    // because a perf test with no gate always passes and teaches nothing.
    scaffold: ({ item, flowMap }) => ({
      spec: {
        path: publicRoutes(flowMap, 1)[0],
        iterations: 5,
        budgets: { lcpMs: 2500, clsScore: 0.1 },
      },
      reviewFlags: [
        `${SCAFFOLD_PREFIX} Core Web Vitals for a crawled route against Lighthouse's classic budgets (LCP 2500ms, CLS 0.1). Tune the budgets to what this page actually promises.`,
        intentFlag(item),
      ],
    }),
  },

  LOAD: {
    mode: 'spec',
    schema: loadTestSpecSchema,
    dir: 'load',
    specNotes:
      'A k6 scenario — path, virtual users, duration — gated on p95 latency and error rate. ' +
      'Prefer `scenario` over a hand-written `script` unless the plan demands custom stages.',
    // Scaffold: a small, bounded scenario (5 VUs, 30s) against a crawled
    // route. Deliberately gentle — a scaffold must never be the thing that
    // hammers an environment. Needs k6 on the runner, which the flag says.
    scaffold: ({ item, flowMap }) => ({
      spec: {
        scenario: {
          path: publicRoutes(flowMap, 1)[0],
          method: 'GET',
          vus: 5,
          durationSeconds: 30,
        },
        thresholds: { p95Ms: 800, errorRate: 0.01 },
      },
      reviewFlags: [
        `${SCAFFOLD_PREFIX} a deliberately small scenario (5 VUs for 30s). Size it to the plan's real question before trusting the thresholds. Needs k6 installed on the runner.`,
        intentFlag(item),
      ],
    }),
  },

  INTEGRATION: {
    mode: 'spec',
    schema: externalTestSpecSchema,
    dir: 'integration',
    specNotes:
      'An external command that runs the project’s OWN test tool in the exported repository ' +
      'workspace and the report it writes (JUnit XML is the safe default: `--reporter=junit` ' +
      'or the tool’s equivalent). Choose the command from the project’s ecosystem; flag it ' +
      'for review, because whether that tool is installed is a fact about their repo.',
    // No scaffold: the command that runs their suite is a fact about their
    // repository this deployment cannot see, and a guessed command is a test
    // that fails on every run — worse than an honest refusal.
    refuseBecause:
      'the command that runs your own test tool is a fact about your repository; a guessed command is a test that fails on every run',
  },

  UNIT_GEN: {
    mode: 'hybrid',
    schema: externalTestSpecSchema,
    specNotes:
      'Besides the code, return `spec`: an external-command spec whose command runs EXACTLY ' +
      'the file at filePath with the ecosystem’s own unit runner, writing a machine-readable ' +
      'report (e.g. command "npx", args ["vitest", "run", "<filePath>", "--reporter=junit", ' +
      '"--outputFile=report.xml"], reportFormat "junit-xml"). The command executes in the ' +
      'exported repository workspace.',
    refuseBecause:
      'both the unit test body and the command that runs it need authoring against your source code',
  },

  LOCALIZATION: {
    mode: 'hybrid',
    schema: localizationSpecSchema,
    forcePlaywright: true,
    specNotes:
      'Besides the code, return `spec`: {"locales": [{"tag", "timezone"?}]} — the BCP-47 ' +
      'locales (and IANA timezones, where date or currency formatting matters) the plan ' +
      'calls for. When the plan names none, en-US plus one non-English locale is the useful ' +
      'minimum. The runner executes the code once per locale.',
    refuseBecause: 'the journey to repeat per locale is code only a model (or a human in the editor) can write',
  },

  EMAIL_OTP: {
    mode: 'spec',
    schema: emailOtpSpecSchema,
    dir: 'auth',
    specNotes:
      'A real email-code sign-in: request form selectors, a mail sink URL (`/__mail`-shaped: ' +
      'MailHog, Mailpit, Mailosaur), the code pattern, and the selector proving success. Take ' +
      'the selectors from the crawled login form fields — do not invent them.',
    // No scaffold: every required selector is specific to their login form,
    // and a guessed selector makes a test that can never pass.
    refuseBecause:
      'the login and mailbox selectors are specific to your app, and guessed selectors make a test that can never pass',
  },

  DATABASE: {
    mode: 'spec',
    schema: databaseTestSpecSchema,
    dir: 'db',
    specNotes:
      'SQL steps against Postgres, run in a transaction that is rolled back. The connection ' +
      'is named via `connectionSecretName` (a vault secret), NEVER an inline DSN. `constraint` ' +
      'steps assert a violation is rejected; `migration` steps apply up and down.',
    // No scaffold: the SQL worth asserting on is a fact about their schema,
    // which a UI crawl does not see.
    refuseBecause: 'the SQL worth asserting on is a fact about your schema, which a UI crawl does not see',
  },

  CLI: {
    mode: 'spec',
    schema: cliTestSpecSchema,
    dir: 'cli',
    specNotes:
      'Spawn one command (never through a shell) and assert on exit code, stdout and stderr. ' +
      'Set `installHint` so a missing binary fails with the fix in the message.',
    refuseBecause: 'the binary and its expected output are facts about your product, not the crawled UI',
  },

  PROTOCOL: {
    mode: 'spec',
    schema: protocolTestSpecSchema,
    dir: 'protocol',
    specNotes:
      'Discriminated on `protocol`: GRAPHQL (operations), WEBSOCKET (a SEND/EXPECT ' +
      'conversation), SSE (event expectations) or GRPC (calls). Pick the one the plan names ' +
      'and only that shape’s fields.',
    refuseBecause: 'the endpoint, operations and expected payloads are facts about your API the crawl does not capture',
  },

  CONTRACT: {
    mode: 'spec',
    schema: contractTestSpecSchema,
    dir: 'contract',
    specNotes:
      'Either `kind: "pact"` with the pact file to verify the provider against, or ' +
      '`kind: "openapi"` with the document whose operations are called and checked. Document ' +
      'refs are workspace-relative paths or https URLs.',
    refuseBecause: 'it needs the path to your pact or OpenAPI document, which only you know',
  },

  MUTATION: {
    mode: 'spec',
    schema: mutationTestSpecSchema,
    dir: 'mutation',
    specNotes:
      'Runs the ecosystem’s mutation tool (Stryker, PIT, mutmut…) and gates on the score. ' +
      'Scope it — an unscoped mutation run on a real repo takes hours.',
    // No scaffold even though `{}` would parse: whether a mutation tool is
    // installed and configured in their repo is unknowable here, and the
    // default command would fail on most repos most of the time.
    refuseBecause: 'whether a mutation tool is installed and configured in your repo is not knowable from a crawl',
  },

  MOBILE: {
    mode: 'spec',
    schema: mobileTestSpecSchema,
    dir: 'mobile',
    specNotes:
      'Discriminated on `driver`: MAESTRO (a flow file), APPIUM (capabilities and steps), ' +
      'DETOX (a .detoxrc configuration), ESPRESSO (a Gradle task) or XCUITEST (a scheme). ' +
      'Pick the one the plan names and only that shape’s fields.',
    refuseBecause: 'it needs your app binary, flow files or build scheme — none of which a web crawl sees',
  },
};

// ─── The API the generator and the routes consume ────────────────────────────

export function generationStrategyFor(type: TestType): GenerationStrategy {
  return STRATEGIES[type];
}

/**
 * True when approving this type without a key still produces a runnable test.
 * The approve route and the auto-approve path queue exactly these; everything
 * else stays APPROVED with the no-key sentence instead of a dead job.
 */
export function canScaffoldWithoutModel(type: TestType): boolean {
  const strategy = STRATEGIES[type];
  return strategy.mode === 'spec' && strategy.scaffold !== undefined;
}

/** The deterministic scaffold, or null where the honest answer is refusal. */
export function scaffoldSpec(type: TestType, args: ScaffoldArgs): SpecScaffold | null {
  const strategy = STRATEGIES[type];
  if (strategy.mode !== 'spec' || !strategy.scaffold) return null;
  return strategy.scaffold(args);
}

/**
 * Where a generated spec file lands: `api/checkout-total.api.json`. The
 * directory mirrors the seed data's layout; the suffix is the editor
 * template's, so hand-written and generated files of one type sort together.
 */
export function specFilePathFor(type: TestType, title: string): string {
  const strategy = STRATEGIES[type];
  const dir = strategy.mode === 'spec' ? strategy.dir : 'generated';
  const suffix = NEW_TEST_TEMPLATES[type]?.fileSuffix ?? '.json';
  return `${dir}/${testFileSlug(title)}${suffix}`;
}

/** The stored `code` for a spec-driven test — a pointer, in the seed data's voice. */
export function specPointerCode(type: TestType): string {
  return (
    NEW_TEST_TEMPLATES[type]?.code ??
    `// ${TEST_TYPE_LABELS[type]} tests are driven by \`spec\`, not source code.\n`
  );
}

/**
 * The plugin's schema as JSON Schema, for the prompt. The structured-output
 * engine constrains the response separately; stating the schema in the prompt
 * as well is what lets the model REASON about the shape it is filling.
 */
export function specSchemaText(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }), null, 2);
}
