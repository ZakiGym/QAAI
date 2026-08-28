/**
 * What the source pass is allowed to say, and what it must refuse to say.
 *
 * Two properties matter here, and only one of them is about correctness.
 *
 *   1. HONESTY. A plan item derived from a file tree must never read as though
 *      something was run. There is a test below that walks every generated
 *      item and fails on a rationale that claims observation, a rationale with
 *      no evidence file in it, and any journey proposal at all — because "add
 *      to cart, then check out" is a runtime fact and this pass has no runtime.
 *      That test is the point of the file; the rest support it.
 *
 *   2. RUNNABILITY. An approved item has to become a test the runner executes.
 *      The last section proves it the same way generate.test.ts does — by
 *      taking the FlowMap this pass synthesises, scaffolding a spec from it
 *      with @qaai/agent, and handing the result to THE TYPE'S OWN PLUGIN from
 *      @qaai/runner. A plan whose items cannot survive that round trip is a
 *      plan that wastes a human's approval.
 *
 * Fixtures are shaped like a small Next.js + Express app because that is what
 * the ingest pass will most often hand over: an app router with a guarded
 * account area, a couple of API handlers, a login form.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SURFACE_KINDS, analyseCodebase, planItemSchema } from '@qaai/shared';
import type { PlanItem, RepoFile, TestType } from '@qaai/shared';
import { canScaffoldWithoutModel, scaffoldSpec, specFilePathFor, specPointerCode } from '@qaai/agent';
import { pluginFor } from '@qaai/runner';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` is swapped per test through the proxy.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    generated: unknown[];
    apiKey: string;
  } => ({ prisma: {}, events: [], generated: [], apiKey: '' }),
);

vi.mock('../context.js', () => ({
  // Read through a getter so a test can flip the key without re-importing the
  // module under test — the no-key path and the with-key path differ only in
  // which items are queued for generation.
  config: {
    get anthropicApiKey() {
      return h.apiKey;
    },
  },
  connection: {},
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  publishEvent: (_orgId: string, event: Record<string, unknown>) => void h.events.push(event),
}));

vi.mock('../queues.js', () => ({
  ANALYZE_SOURCE_QUEUE: 'qaai.analyze-source',
  enqueueGenerate: (job: unknown) => {
    h.generated.push(job);
    return Promise.resolve();
  },
}));

const {
  AUTH_TITLES,
  DEFAULT_TEST_TYPES,
  MAX_PLAN_ITEMS,
  PROJECT_ANALYSIS_FIELDS,
  SOURCE_FLOW_MAP_REASON,
  STATIC_ONLY_SENTENCE,
  analysisFromProject,
  flowMapFromSource,
  parseCodebaseAnalysis,
  processAnalyzeSource,
  resolveTestTypeChoice,
  scenariosFromSource,
  summaryFromSource,
  testTypeChoiceFromProject,
} = await import('./analyze-source.js');

type CodebaseAnalysis = NonNullable<ReturnType<typeof parseCodebaseAnalysis>>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const loginForm = {
  name: 'Sign in',
  route: '/login',
  file: 'app/login/page.tsx',
  submitLabel: 'Sign in',
  fields: [
    { name: 'email', label: 'Email', inputType: 'email', required: true, semantic: 'email' },
    {
      name: 'password',
      label: 'Password',
      inputType: 'password',
      required: true,
      semantic: 'password',
    },
  ],
};

/** A small app: a public storefront, a guarded account area, two handlers. */
const rawAnalysis = {
  schema: 1,
  analyzedAt: '2026-08-01T09:00:00.000Z',
  frameworks: ['Next.js', 'Express'],
  routes: [
    { path: '/', file: 'app/page.tsx', behindAuth: false },
    { path: '/products', file: 'app/products/page.tsx', behindAuth: false },
    { path: '/products/:id', file: 'app/products/[id]/page.tsx', behindAuth: false },
    { path: '/login', file: 'app/login/page.tsx', behindAuth: false, forms: [loginForm] },
    {
      path: '/account',
      file: 'app/account/page.tsx',
      behindAuth: true,
      authEvidence: 'middleware.ts matcher /account/:path*',
      forms: [
        {
          name: 'Update profile',
          file: 'app/account/profile-form.tsx',
          submitLabel: 'Save',
          fields: [
            {
              name: 'displayName',
              label: 'Display name',
              inputType: 'text',
              required: true,
              semantic: 'person_name',
            },
            { name: 'bio', label: 'Bio', inputType: 'textarea', required: false, semantic: 'freeform' },
          ],
        },
      ],
    },
  ],
  endpoints: [
    { method: 'GET', path: '/api/products', file: 'server/routes/products.ts', behindAuth: false },
    {
      method: 'POST',
      path: '/api/orders',
      file: 'server/routes/orders.ts',
      behindAuth: true,
      authEvidence: 'requireSession middleware',
    },
  ],
  authSurfaces: [
    // Exactly what analyseCodebase emits: `path`, `from`, `evidence`, and a
    // kind from the shared vocabulary. The old fixture said `route: '/login'`
    // with `kind: 'SIGN_IN'` — neither of which the producer has ever written.
    {
      kind: 'LOGIN',
      path: '/login',
      from: 'route',
      file: 'app/login/page.tsx',
      evidence: 'the path segment names a sign-in',
      form: loginForm,
    },
  ],
  warnings: ['3 file(s) exceeded the size cap and were not parsed'],
};

const analysis = (): CodebaseAnalysis => parseCodebaseAnalysis(rawAnalysis)!;

const allTypes = (types: TestType[]) => resolveTestTypeChoice(types);

/** Everything the four derivation rules can produce, so honesty is checked over all of it. */
const everything = () =>
  scenariosFromSource(
    analysis(),
    allTypes(['SMOKE', 'API', 'E2E', 'ACCESSIBILITY', 'SECURITY_SMOKE']),
  );

// ─── 1. Reading what another process wrote ───────────────────────────────────

/**
 * The producer and this parser are in different packages, and they disagreed:
 * `analyseCodebase` writes `path` with one of seven kinds, and this file read
 * `route` against a hand-copied five. Only PASSWORD_RESET was in both, so real
 * repositories produced plans with no authentication tests in them at all.
 *
 * These run the REAL producer rather than a fixture. A fixture is a copy of the
 * contract, and a copy is what drifted — the only assertion that cannot rot is
 * one that calls `analyseCodebase` and feeds the output straight in.
 */
describe('the analysis this parser reads is the analysis @qaai/shared writes', () => {
  const app: RepoFile[] = [
    {
      path: 'src/server.ts',
      content: [
        "import express from 'express';",
        'const app = express();',
        "app.get('/login', (req, res) => res.send('form'));",
        "app.post('/login', (req, res) => res.json({ ok: true }));",
        "app.post('/logout', (req, res) => res.json({ ok: true }));",
        "app.get('/products', (req, res) => res.json([]));",
      ].join('\n'),
    },
    { path: 'package.json', content: '{"dependencies":{"express":"^4.0.0"}}' },
  ];

  it('carries auth surfaces through the parser instead of dropping them', () => {
    const produced = analyseCodebase(app);
    expect(produced.authSurfaces.length).toBeGreaterThan(0);

    // Round-trip through JSON, because that is what the snapshot column does.
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)));
    expect(parsed).not.toBeNull();
    expect(parsed!.authSurfaces).toHaveLength(produced.authSurfaces.length);
  });

  it('agrees with the producer on every kind it can emit', () => {
    // Not a copy of the list: the shared constant IS the list. A kind added
    // there without a title here fails this rather than reaching a user as
    // `undefined` in the plan.
    for (const kind of AUTH_SURFACE_KINDS) {
      expect(AUTH_TITLES[kind]).toBeTruthy();
    }
  });

  it('proposes an authentication test for a repo that declares a login', () => {
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(analyseCodebase(app))))!;
    const items = scenariosFromSource(parsed, allTypes(['E2E'])).items;
    expect(items.some((i) => i.feature === 'Authentication')).toBe(true);
  });

  /**
   * The Express fixture above is exactly why a round-trip test was not enough.
   *
   * `analyseCodebase` writes an endpoint's URL under `path` and a PAGE's URL
   * under `route`, and an Express app declares no pages — so the only field
   * those tests ever exercised was the one field the two sides agreed on. Three
   * disagreements lived through it:
   *
   *   • `parseRoute` read `raw.path`, which a `PageRoute` does not have. Every
   *     page route was dropped: no SMOKE item, no ACCESSIBILITY item, and a
   *     FlowMap with no nodes at all. A pure-frontend app — the commonest thing
   *     an ingest is handed — produced a completely empty plan.
   *   • the producer publishes forms at the TOP LEVEL of the analysis; the
   *     parser looked for them nested inside each route and nowhere else, so
   *     every form-driven E2E item was lost and the plan summary said
   *     "0 form(s)" one screen after the ingest response had listed them.
   *   • an `AuthSurface` carries no fields, so a sign-in item had nothing to
   *     fill in until the credential form was matched back onto it.
   *
   * So this fixture is a Next.js App Router app with pages and a real form, and
   * every assertion below is written against `produced`'s own counts and fields.
   * A literal here would be a second copy of the contract, and a copy is what
   * drifted in the first place.
   */
  const nextApp: RepoFile[] = [
    { path: 'package.json', content: '{"dependencies":{"next":"^15.0.0","react":"^19.0.0"}}' },
    {
      path: 'app/page.tsx',
      content: 'export default function Home() {\n  return <main>Storefront</main>;\n}\n',
    },
    {
      path: 'app/products/page.tsx',
      content: 'export default function Products() {\n  return <ul />;\n}\n',
    },
    {
      path: 'app/products/[id]/page.tsx',
      content: 'export default function Product() {\n  return <article />;\n}\n',
    },
    {
      path: 'app/login/page.tsx',
      content: [
        'export default function LoginPage() {',
        '  return (',
        '    <form name="Sign in" method="post">',
        '      <label htmlFor="email">Email</label>',
        '      <input id="email" name="email" type="email" required />',
        '      <label htmlFor="password">Password</label>',
        '      <input id="password" name="password" type="password" required />',
        '      <button type="submit">Sign in</button>',
        '    </form>',
        '  );',
        '}',
      ].join('\n'),
    },
  ];

  /** The producer's output and the parser's reading of it, once, for one repo. */
  const roundTrip = () => {
    const produced = analyseCodebase(nextApp);
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)))!;
    return { produced, parsed };
  };

  it('keeps every page route a file-convention router declares', () => {
    const { produced, parsed } = roundTrip();
    // The fixture has to be worth running: a producer that found no pages would
    // let a parser that drops all of them pass silently.
    expect(produced.routes.length).toBeGreaterThan(0);
    expect(parsed.routes).toHaveLength(produced.routes.length);
    // The field, not just the count — `route` on one side, `path` on the other.
    expect(parsed.routes.map((r) => r.path)).toEqual(produced.routes.map((r) => r.route));
    expect(parsed.routes.map((r) => r.file)).toEqual(produced.routes.map((r) => r.file));
  });

  it('keeps every form the producer publishes, with its fields', () => {
    const { produced, parsed } = roundTrip();
    expect(produced.forms.length).toBeGreaterThan(0);
    expect(parsed.forms).toHaveLength(produced.forms.length);
    expect(parsed.forms.map((f) => f.file)).toEqual(produced.forms.map((f) => f.file));
    expect(parsed.forms.map((f) => f.name)).toEqual(produced.forms.map((f) => f.name));
    for (const [index, form] of produced.forms.entries()) {
      expect(parsed.forms[index]!.fields.map((f) => f.name)).toEqual(
        form.fields.map((f) => f.name),
      );
      expect(parsed.forms[index]!.fields.map((f) => f.semantic)).toEqual(
        form.fields.map((f) => f.semantic),
      );
    }
  });

  it('ties a top-level form to the route whose file declares it', () => {
    const { produced, parsed } = roundTrip();
    // The producer states a form's FILE and no route, because a `<form>` is
    // found by reading markup. A page file is a route, so this one resolves —
    // and resolving it is what puts the fields on the FlowMap node the E2E
    // scaffold reads.
    for (const form of produced.forms) {
      const owner = produced.routes.find((r) => r.file === form.file);
      if (!owner) continue;
      const attached = parsed.forms.find((f) => f.file === form.file);
      expect(attached?.route ?? null, `${form.file} reached no route`).toBe(owner.route);
    }
  });

  it('proposes one SMOKE item per declared route, and an axe scan over them', () => {
    const { produced, parsed } = roundTrip();
    const derived = scenariosFromSource(parsed, allTypes(['SMOKE', 'ACCESSIBILITY']));
    expect(derived.totals.routes).toBe(produced.routes.length);
    expect(derived.items.filter((i) => i.testType === 'SMOKE')).toHaveLength(
      produced.routes.length,
    );
    expect(derived.items.filter((i) => i.testType === 'ACCESSIBILITY')).toHaveLength(1);
  });

  it('counts the forms the ingest screen showed, on the plan and in its summary', () => {
    const { produced, parsed } = roundTrip();
    const derived = scenariosFromSource(parsed, allTypes(['E2E']));
    expect(derived.totals.forms).toBe(produced.forms.length);
    // The sentence the user reads. It said "0 form(s)" while the ingest
    // response listed them, which is one feature contradicting itself.
    expect(summaryFromSource(derived, parsed)).toContain(`${produced.forms.length} form(s)`);
    for (const form of produced.forms) {
      expect(derived.items.some((i) => i.rationale.includes(form.file))).toBe(true);
    }
  });

  it('reaches an authenticated scenario, with the credentials the source names', () => {
    const { produced, parsed } = roundTrip();
    const credentials = produced.forms.find((f) =>
      f.fields.some((field) => field.semantic === 'password'),
    )!;
    expect(credentials).toBeDefined();

    // An `AuthSurface` is kind/path/from/file/evidence and nothing else, so the
    // fields have to be matched back on. Without them the sign-in item read
    // "the source names no fields on it" for a repo whose login form had just
    // been parsed field by field, and the generated test had nothing to type.
    const surfaces = parsed.authSurfaces.filter((s) => s.file === credentials.file);
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      expect(
        surface.form?.fields.map((f) => f.name) ?? null,
        `${surface.kind} at ${surface.path} carries no credential form`,
      ).toEqual(credentials.fields.map((f) => f.name));
    }

    const derived = scenariosFromSource(parsed, allTypes(['E2E']));
    const signIn = derived.items.filter((i) => i.feature === 'Authentication');
    expect(signIn).toHaveLength(parsed.authSurfaces.length);
    for (const item of signIn) {
      expect(item.priority).toBe('CRITICAL_PATH');
      for (const field of credentials.fields) {
        expect(
          item.steps.some(
            (step) => step.includes(field.name) || (field.label !== null && step.includes(field.label)),
          ),
          `no step fills "${field.name}"`,
        ).toBe(true);
      }
    }
  });

  it('gives the Generator a FlowMap with the app in it', () => {
    const { produced, parsed } = roundTrip();
    const map = flowMapFromSource(parsed, ctx);
    expect(map.nodes.map((n) => n.route)).toEqual(produced.routes.map((r) => r.route));
    /*
     * Per-node forms are how a generated E2E test gets its fields, so a form
     * that resolved to a route has to arrive on that route's node too.
     *
     * Anchored to the PRODUCER, not to `parsed`. The first version of this
     * compared `map.nodes.flatMap(n => n.forms)` against
     * `parsed.forms.filter(f => f.route !== null)` — both sides downstream of
     * the parser, so dropping every form on the floor made both sides zero and
     * the assertion passed. That is the precise failure this whole describe
     * block exists to prevent, reproduced inside it.
     */
    const producedLoginForms = produced.forms.filter((f) =>
      produced.routes.some((r) => r.file === f.file),
    );
    expect(
      producedLoginForms.length,
      'the fixture must declare at least one form on a page route, or this asserts nothing',
    ).toBeGreaterThan(0);
    expect(map.nodes.flatMap((n) => n.forms)).toHaveLength(producedLoginForms.length);
    expect(map.nodes.flatMap((n) => n.forms.flatMap((f) => f.fields)).length).toBe(
      producedLoginForms.reduce((total, form) => total + form.fields.length, 0),
    );
  });

  it('carries the frameworks the producer named into the summary a person reads', () => {
    /*
     * The fourth disagreement on this boundary. `analyseCodebase` emits
     * `AppFrameworkSignal` objects; the parser read them as plain strings, so
     * `str(object)` was '' and every one was filtered away. Nothing failed —
     * the plan summary just quietly lost its "(Next.js, Express)" for every
     * repository ever analysed.
     */
    const { produced, parsed } = roundTrip();
    expect(produced.frameworks.length).toBeGreaterThan(0);
    expect(parsed.frameworks).toEqual(produced.frameworks.map((f) => f.framework));

    const summary = summaryFromSource(scenariosFromSource(parsed, allTypes(['E2E'])), parsed);
    for (const signal of produced.frameworks) {
      expect(summary).toContain(signal.framework);
    }
  });

  it('claims no guard the producer never expressed', () => {
    const { parsed } = roundTrip();
    // `PageRoute` and `HttpEndpoint` carry no guard field and no detector reads
    // one, so `behindAuth` is false for everything a real analysis produces.
    // The honest consequence is a SECURITY_SMOKE that is skipped WITH A REASON,
    // not an auth wall invented to fill the slot.
    expect(parsed.routes.some((r) => r.behindAuth)).toBe(false);
    const derived = scenariosFromSource(parsed, allTypes(['SECURITY_SMOKE']));
    expect(derived.items).toHaveLength(0);
    expect(derived.skipped.some((s) => s.why.includes('no auth wall to probe'))).toBe(true);
  });
});

describe('parseCodebaseAnalysis', () => {
  it('reads a well-formed analysis whole', () => {
    const parsed = analysis();
    expect(parsed.routes).toHaveLength(5);
    expect(parsed.endpoints).toHaveLength(2);
    expect(parsed.authSurfaces).toHaveLength(1);
    expect(parsed.frameworks).toEqual(['Next.js', 'Express']);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 'routes', 42, ['/']]) {
      expect(parseCodebaseAnalysis(raw)).toBeNull();
    }
  });

  it('drops a route with no evidence file — the file IS the argument for the item', () => {
    const parsed = parseCodebaseAnalysis({ routes: [{ path: '/orphan' }] })!;
    expect(parsed.routes).toHaveLength(0);
  });

  it('drops an endpoint whose method is not an HTTP verb', () => {
    const parsed = parseCodebaseAnalysis({
      endpoints: [
        { method: 'SUBSCRIBE', path: '/x', file: 'a.ts' },
        { method: 'patch', path: '/y', file: 'b.ts' },
      ],
    })!;
    expect(parsed.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['PATCH /y']);
  });

  it('normalises paths so one route is not proposed twice', () => {
    const parsed = parseCodebaseAnalysis({
      routes: [
        { path: 'products/', file: 'a.tsx' },
        { path: '//products', file: 'b.tsx' },
      ],
    })!;
    expect(parsed.routes.map((r) => r.path)).toEqual(['/products']);
  });

  it('merges two files declaring one route rather than losing either fact', () => {
    // The layout carries the guard; the page carries the form. Dropping the
    // second would silently lose a real subject.
    const parsed = parseCodebaseAnalysis({
      routes: [
        { path: '/account', file: 'app/account/layout.tsx', behindAuth: true, authEvidence: 'auth()' },
        { path: '/account', file: 'app/account/page.tsx', forms: [{ name: 'Profile', file: 'p.tsx', fields: [] }] },
      ],
    })!;
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0]!.behindAuth).toBe(true);
    expect(parsed.routes[0]!.authEvidence).toBe('auth()');
    expect(parsed.routes[0]!.forms).toHaveLength(1);
  });

  it('coerces an unrecognised field semantic to unknown rather than trusting it', () => {
    const parsed = parseCodebaseAnalysis({
      routes: [
        {
          path: '/x',
          file: 'x.tsx',
          forms: [
            {
              name: 'f',
              file: 'x.tsx',
              fields: [{ name: 'iban', semantic: 'bank_account' }],
            },
          ],
        },
      ],
    })!;
    expect(parsed.routes[0]!.forms[0]!.fields[0]!.semantic).toBe('unknown');
  });

  it('finds the analysis on any accepted project column, and nothing otherwise', () => {
    for (const field of PROJECT_ANALYSIS_FIELDS) {
      expect(analysisFromProject({ [field]: rawAnalysis })).not.toBeNull();
    }
    expect(analysisFromProject({ somethingElse: rawAnalysis })).toBeNull();
    expect(analysisFromProject(null)).toBeNull();
  });
});

// ─── 2. The org's chosen test types ──────────────────────────────────────────

describe('resolveTestTypeChoice', () => {
  it('falls back to the safe default set when the funnel stored nothing', () => {
    const choice = testTypeChoiceFromProject({ name: 'shop' });
    expect(choice.source).toBe('default');
    expect(choice.types).toEqual([...DEFAULT_TEST_TYPES]);
    expect(choice.refused).toHaveLength(0);
  });

  it('proposes only what the user asked for', () => {
    expect(resolveTestTypeChoice(['API']).types).toEqual(['API']);
    expect(resolveTestTypeChoice(['api', 'API']).types).toEqual(['API']);
  });

  it('reads the preference off any accepted project column, in either shape', () => {
    expect(testTypeChoiceFromProject({ testTypePreference: ['API'] }).types).toEqual(['API']);
    expect(testTypeChoiceFromProject({ preferredTestTypes: { testTypes: ['SMOKE'] } }).types).toEqual([
      'SMOKE',
    ]);
  });

  it('refuses a type whose runner plugin has no scaffold, with the reason', () => {
    // Every TestType outside CREATABLE_TEST_TYPES would mint a row the runner
    // cannot execute — the exact defect the test-type honesty wave closed.
    const choice = resolveTestTypeChoice(['E2E', 'HEALING']);
    expect(choice.types).toEqual(['E2E']);
    expect(choice.refused).toHaveLength(1);
    expect(choice.refused[0]!.why).toContain('not a test type');
  });

  it('refuses a runnable type that source cannot found, and says why', () => {
    // VISUAL and LOAD both run fine. Neither can be justified from a file tree
    // — a baseline and a load budget are judgements about a live app.
    const choice = resolveTestTypeChoice(['VISUAL', 'LOAD', 'SMOKE']);
    expect(choice.types).toEqual(['SMOKE']);
    expect(choice.refused.map((r) => r.what).sort()).toEqual(
      ['Load / performance', 'Visual regression'].sort(),
    );
    for (const refusal of choice.refused) expect(refusal.why.length).toBeGreaterThan(20);
  });

  it('does not overrule a user whose every choice was refused', () => {
    const choice = resolveTestTypeChoice(['VISUAL']);
    expect(choice.types).toEqual([]);
    expect(choice.source).toBe('stored');
  });
});

// ─── 3. Honesty: what a static pass is allowed to claim ──────────────────────

describe('the boundary of a static pass', () => {
  /**
   * Phrases that assert something only a running app could have shown us. If
   * one of these ever appears in generated prose, the product is claiming
   * knowledge it does not have — which is the failure this whole pass is built
   * to avoid, and it is worth failing a build over.
   */
  const FORBIDDEN = [
    'the crawl',
    'we observed',
    'the crawler',
    'was rendered',
    'currently returns',
    'as seen',
    'the screenshot',
  ];

  it('never claims observation, in any item, in any field', () => {
    for (const item of everything().items) {
      const prose = [item.title, item.rationale, ...item.steps, ...item.assertions]
        .join(' ')
        // The standing disclaimer is subtracted first: it uses the vocabulary
        // of running things precisely in order to deny it, and leaving it in
        // would make the honest sentence trip the honesty check.
        .split(STATIC_ONLY_SENTENCE)
        .join(' ')
        .toLowerCase();
      for (const phrase of FORBIDDEN) {
        expect(prose, `${item.id} claims runtime knowledge: "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('every rationale names the file it was read from and marks its own limit', () => {
    for (const item of everything().items) {
      expect(item.rationale, `${item.id} has no evidence file`).toMatch(/`[^`]+\.[a-z]+`|route\(s\)/);
      expect(item.rationale, `${item.id} does not state its limit`).toContain(
        'nothing was rendered or requested',
      );
    }
  });

  it('proposes no journeys at all — a path through an app is a runtime fact', () => {
    for (const item of everything().items) expect(item.journeyId).toBeNull();
  });

  it('says so on the plan summary rather than only in the code', () => {
    const derived = everything();
    const summary = summaryFromSource(derived, analysis());
    expect(summary).toContain('Nothing was rendered and no request was sent');
    expect(summary).toContain('No journeys are proposed');
    expect(summary).toContain('without a model');
  });

  it('every proposal survives the schema the plan endpoint enforces', () => {
    // Titles clamp at 160 and rationales at 1000; an item that violates those
    // is one POST /plans would reject at the very last moment.
    for (const item of everything().items) {
      const parsed = planItemSchema.safeParse(item);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});

// ─── 4. The four derivation rules ────────────────────────────────────────────

const byId = (items: PlanItem[], id: string): PlanItem => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id} in ${items.map((i) => i.id).join(', ')}`);
  return found;
};

describe('routes become smoke items', () => {
  it('one per declared route, and nothing else when only SMOKE is asked for', () => {
    const derived = scenariosFromSource(analysis(), allTypes(['SMOKE']));
    expect(derived.items).toHaveLength(5);
    expect(new Set(derived.items.map((i) => i.testType))).toEqual(new Set(['SMOKE']));
    expect(derived.items.map((i) => i.id)).toContain('source:smoke:products-id');
  });

  it('the root route is critical path; a dynamic one is not, and says why', () => {
    const items = scenariosFromSource(analysis(), allTypes(['SMOKE'])).items;
    // `/` slugs to nothing, so its handle is named rather than generic —
    // `source:smoke:item` was both unreadable and a collision waiting to happen.
    expect(byId(items, 'source:smoke:root').priority).toBe('CRITICAL_PATH');

    const dynamic = byId(items, 'source:smoke:products-id');
    expect(dynamic.priority).toBe('NICE_TO_HAVE');
    expect(dynamic.steps.join(' ')).toContain('Obtain a real value');
    expect(dynamic.rationale).toContain('no value it takes');
  });

  it('a guarded route carries the guard, its evidence, and the signed-out case', () => {
    const item = byId(scenariosFromSource(analysis(), allTypes(['SMOKE'])).items, 'source:smoke:account');
    expect(item.rationale).toContain('middleware.ts matcher /account/:path*');
    expect(item.steps[0]).toContain('Sign in');
    expect(item.assertions.join(' ')).toContain('Signed out');
  });
});

describe('endpoints become API items', () => {
  it('one per method+path, with the expectation on the assertion', () => {
    const derived = scenariosFromSource(analysis(), allTypes(['API']));
    expect(derived.items).toHaveLength(2);
    const read = byId(derived.items, 'source:api:get-api-products');
    expect(read.assertions[0]).toContain('answers 200');
    expect(read.rationale).toContain('`server/routes/products.ts`');
  });

  it('a guarded write endpoint covers the REFUSAL, never a guessed payload', () => {
    // The source names a handler. It does not name a body the handler accepts,
    // so asserting "POST /api/orders returns 201" would be asking a human to
    // approve a guess.
    const item = byId(
      scenariosFromSource(analysis(), allTypes(['API'])).items,
      'source:api:post-api-orders',
    );
    expect(item.priority).toBe('CRITICAL_PATH');
    expect(item.steps.join(' ')).toContain('no session and no credentials');
    expect(item.assertions[0]).toContain('401 or 403');
    expect(item.assertions.join(' ')).toContain('leaks nothing');
    expect(item.assertions.join(' ')).not.toContain('201');
  });

  it('an unguarded write endpoint covers the malformed body instead', () => {
    const parsed = parseCodebaseAnalysis({
      endpoints: [{ method: 'POST', path: '/api/subscribe', file: 'api.ts' }],
    })!;
    const item = scenariosFromSource(parsed, allTypes(['API'])).items[0]!;
    expect(item.assertions[0]).toContain('4xx');
    expect(item.assertions[0]).toContain('never a 500');
  });
});

describe('forms and auth surfaces become E2E items', () => {
  it('one item per form, walking the fields the source declares', () => {
    const derived = scenariosFromSource(analysis(), allTypes(['E2E']));
    const item = byId(derived.items, 'source:form:account-update-profile');
    expect(item.steps[0]).toContain('Sign in');
    expect(item.steps.join(' ')).toContain('Fill "Display name" with a valid person name value');
    expect(item.steps.join(' ')).toContain('(the source marks it required)');
    expect(item.steps.join(' ')).toContain('Submit with "Save"');
    expect(item.assertions.join(' ')).toContain('Leaving "Display name" empty is refused');
  });

  it('warns that the locators came from source, not from rendered markup', () => {
    const item = byId(
      scenariosFromSource(analysis(), allTypes(['E2E'])).items,
      'source:form:login-sign-in',
    );
    expect(item.steps.join(' ')).toContain('never saw the rendered markup');
  });

  it('the sign-in surface is critical path and covers the wrong credential', () => {
    const item = byId(
      scenariosFromSource(analysis(), allTypes(['E2E'])).items,
      'source:auth:login-login',
    );
    expect(item.priority).toBe('CRITICAL_PATH');
    expect(item.feature).toBe('Authentication');
    expect(item.steps.join(' ')).toContain('deliberately wrong credential');
    expect(item.assertions.join(' ')).toContain('does not reveal which half was wrong');
  });
});

describe('the two opt-in types the source can genuinely found', () => {
  it('ACCESSIBILITY scans only what the source says is public', () => {
    const item = scenariosFromSource(analysis(), allTypes(['ACCESSIBILITY'])).items[0]!;
    // 5 routes, minus /account (guarded) and /products/:id (dynamic).
    expect(item.steps[0]).toContain('3 public route(s)');
    expect(item.assertions.join(' ')).toContain('Routes behind a guard are covered separately');
  });

  it('SECURITY_SMOKE probes the guarded paths and quotes the guard', () => {
    const item = scenariosFromSource(analysis(), allTypes(['SECURITY_SMOKE'])).items[0]!;
    expect(item.steps[0]).toContain('2 guarded path(s)');
    expect(item.rationale).toContain('middleware.ts matcher');
    expect(item.assertions[0]).toContain('a 200 does not');
  });

  it('refuses to invent an auth wall when the source declares none', () => {
    const parsed = parseCodebaseAnalysis({ routes: [{ path: '/', file: 'app/page.tsx' }] })!;
    const derived = scenariosFromSource(parsed, allTypes(['SECURITY_SMOKE']));
    expect(derived.items).toHaveLength(0);
    expect(derived.skipped[0]!.why).toContain('no guarded route or endpoint');
    // And it does not overclaim: absence in the files read is not absence in
    // the app.
    expect(derived.skipped[0]!.why).toContain('not a statement that the app has no auth');
  });
});

describe('bounds and ordering', () => {
  it('caps the plan and names every deferred item rather than dropping it', () => {
    const many = parseCodebaseAnalysis({
      routes: Array.from({ length: MAX_PLAN_ITEMS + 5 }, (_, i) => ({
        path: `/page-${i}`,
        file: `app/page-${i}/page.tsx`,
      })),
    })!;
    const derived = scenariosFromSource(many, allTypes(['SMOKE']));
    expect(derived.items).toHaveLength(MAX_PLAN_ITEMS);
    expect(derived.skipped).toHaveLength(5);
    for (const entry of derived.skipped) expect(entry.why).toContain(`top ${MAX_PLAN_ITEMS}`);
  });

  it('puts critical path first and is stable on an unchanged repository', () => {
    const first = everything().items.map((i) => i.id);
    const second = everything().items.map((i) => i.id);
    expect(first).toEqual(second);
    const priorities = everything().items.map((i) => i.priority);
    expect(priorities.indexOf('CRITICAL_PATH')).toBe(0);
    expect(priorities.lastIndexOf('CRITICAL_PATH')).toBeLessThan(priorities.indexOf('IMPORTANT'));
  });

  it('carries the ingest pass’s own warnings onto the plan', () => {
    const derived = everything();
    expect(derived.skipped.map((s) => s.why)).toContain(
      '3 file(s) exceeded the size cap and were not parsed',
    );
  });

  it('records a requested type the repository gave nothing to found', () => {
    const empty = parseCodebaseAnalysis({ endpoints: [{ method: 'GET', path: '/x', file: 'a.ts' }] })!;
    const derived = scenariosFromSource(empty, allTypes(['API', 'E2E']));
    expect(derived.items.map((i) => i.testType)).toEqual(['API']);
    expect(derived.skipped.map((s) => s.what)).toContain('E2E / UI');
  });
});

// ─── 5. The FlowMap, and the tests it makes possible ─────────────────────────

const ctx = { projectId: 'p1', environmentId: 'e1', version: 1, baseUrl: 'https://shop.example' };

describe('flowMapFromSource', () => {
  it('states on the row itself that it is not a crawl', () => {
    const map = flowMapFromSource(analysis(), ctx);
    expect(map.truncatedReason).toBe(SOURCE_FLOW_MAP_REASON);
    expect(map.truncatedReason).toContain('not from a crawl');
  });

  it('fills every runtime-only field with "not observed", never a plausible value', () => {
    const map = flowMapFromSource(analysis(), ctx);
    expect(map.edges).toEqual([]); // no import graph, so no transition is knowable
    expect(map.journeys).toEqual([]);
    for (const node of map.nodes) {
      expect(node.stateKey).toBe('source');
      expect(node.screenshotKey).toBeNull();
      expect(node.affordances).toEqual([]);
      expect(node.title).toBe(node.route); // no <title> was ever read
    }
  });

  it('mints selectors below the review threshold, because it never saw the markup', () => {
    const map = flowMapFromSource(analysis(), ctx);
    const fields = map.nodes.flatMap((n) => n.forms.flatMap((f) => f.fields));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      // The Generator flags anything under 0.6 for review — that flag is the
      // honest signal for a locator derived from source alone.
      expect(field.selector.confidence).toBeLessThan(0.6);
    }
    expect(fields.find((f) => f.name === 'email')!.selector.strategy).toBe('LABEL');
  });

  it('carries the guard through, which is what the security scaffold reads', () => {
    const map = flowMapFromSource(analysis(), ctx);
    expect(map.nodes.filter((n) => n.behindAuth).map((n) => n.route)).toEqual(['/account']);
    expect(map.features.map((f) => f.name).sort()).toEqual(
      ['Account', 'Login', 'Products', 'Root'].sort(),
    );
  });
});

describe('an approved item becomes a test that runs', () => {
  const flowMap = flowMapFromSource(analysis(), ctx);

  /** Exactly the row the worker would store, seen through the plugin's eyes. */
  const executable = (type: TestType, spec: unknown) => ({
    id: 'generated-under-test',
    name: 'from source',
    type,
    code: specPointerCode(type),
    filePath: specFilePathFor(type, 'from source'),
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [] as string[],
  });

  it('scaffolds the opt-in types straight off the source-derived flow map', () => {
    // This is the whole payoff of translating the analysis into a FlowMap: on a
    // deployment with NO ANTHROPIC_API_KEY, these two produce plugin-valid
    // specs built from the customer's own route list.
    for (const type of ['ACCESSIBILITY', 'SECURITY_SMOKE', 'API'] as const) {
      const item = everything().items.find((i) => i.testType === type)!;
      expect(item, `no ${type} item to scaffold`).toBeDefined();
      expect(canScaffoldWithoutModel(type)).toBe(true);
      const scaffold = scaffoldSpec(type, { item, flowMap })!;
      expect(scaffold).not.toBeNull();
      expect(() => pluginFor(type)!.validate(executable(type, scaffold.spec))).not.toThrow();
    }
  });

  it('the a11y scan lists the routes the SOURCE declared public', () => {
    const item = everything().items.find((i) => i.testType === 'ACCESSIBILITY')!;
    const spec = scaffoldSpec('ACCESSIBILITY', { item, flowMap })!.spec as { routes: string[] };
    expect(spec.routes).toEqual(['/', '/products', '/login']);
  });

  it('the security probe lists exactly the routes the SOURCE guards', () => {
    const item = everything().items.find((i) => i.testType === 'SECURITY_SMOKE')!;
    const spec = scaffoldSpec('SECURITY_SMOKE', { item, flowMap })!.spec as {
      authRequiredPaths: string[];
    };
    expect(spec.authRequiredPaths).toEqual(['/account']);
  });

  it('E2E and SMOKE items are honestly marked as needing a model', () => {
    // They are not scaffoldable, and this pass must not pretend otherwise: the
    // processor leaves them APPROVED and waiting rather than failing the job.
    expect(canScaffoldWithoutModel('E2E')).toBe(false);
    expect(canScaffoldWithoutModel('SMOKE')).toBe(false);
  });
});

// ─── 6. The processor ────────────────────────────────────────────────────────

interface Recorded {
  plans: unknown[];
  audits: unknown[];
  flowMaps: unknown[];
  approvals: unknown[];
}

function stubPrisma(
  projectRow: Record<string, unknown> | null,
  environment: { id: string; baseUrl: string } | null,
  /**
   * The ingest's snapshot — the processor's REAL input. Defaults to none so
   * every existing case still exercises the project-column fallback.
   */
  snapshot: { analysis: unknown } | null = null,
): Recorded {
  const recorded: Recorded = { plans: [], audits: [], flowMaps: [], approvals: [] };
  const tx = {
    testPlan: {
      create: (args: { data: { items: { create: unknown[] } } }) => {
        recorded.plans.push(args.data);
        return Promise.resolve({
          id: 'plan1',
          items: args.data.items.create.map((item, i) => ({
            id: `item${i}`,
            testType: (item as { testType: TestType }).testType,
          })),
        });
      },
    },
    auditLog: {
      // `void x || y` reads as always-falsy to TS and is a confusing way to
      // write "record it, then resolve". Two statements say it plainly.
      create: (args: unknown) => {
        recorded.audits.push(args);
        return Promise.resolve({});
      },
    },
  };

  h.prisma = {
    project: { findFirst: () => Promise.resolve(projectRow) },
    environment: { findFirst: () => Promise.resolve(environment) },
    codebaseSnapshot: { findFirst: () => Promise.resolve(snapshot) },
    flowMap: {
      findFirst: () => Promise.resolve(null),
      create: (args: unknown) => {
        recorded.flowMaps.push(args);
        return Promise.resolve({ id: 'fm1' });
      },
    },
    planItem: {
      updateMany: (args: unknown) => {
        recorded.approvals.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return recorded;
}

const job = (over: Record<string, unknown> = {}) => ({
  orgId: 'org1',
  projectId: 'p1',
  requestedBy: 'user1',
  ...over,
}) as Parameters<typeof processAnalyzeSource>[0];

describe('processAnalyzeSource', () => {
  beforeEach(() => {
    h.events = [];
    h.generated = [];
    h.apiKey = '';
  });

  it('fails loudly, naming every place it looked, when no analysis is stored', async () => {
    stubPrisma({ id: 'p1', name: 'shop' }, { id: 'e1', baseUrl: 'https://shop.example' });
    // Each name, not the punctuation joining them — the point is that a person
    // reading the failure can find every place the input was expected.
    const message = await processAnalyzeSource(job()).then(
      () => '',
      (err: unknown) => (err as Error).message,
    );
    for (const field of PROJECT_ANALYSIS_FIELDS) expect(message).toContain(field);
    expect(message).toContain('CodebaseSnapshot');
  });

  it('fails rather than writing an empty plan when the analysis found nothing', async () => {
    stubPrisma(
      { id: 'p1', codebaseAnalysis: { routes: [], warnings: ['the upload was truncated'] } },
      null,
    );
    await expect(processAnalyzeSource(job())).rejects.toThrow('the upload was truncated');
  });

  it('writes the plan and its audit row in one transaction', async () => {
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job());

    expect(recorded.plans).toHaveLength(1);
    expect(recorded.audits).toHaveLength(1);
    const audit = recorded.audits[0] as { data: { action: string; metadata: Record<string, unknown> } };
    expect(audit.data.action).toBe('plan.from-source');
    expect(audit.data.metadata.writtenByModel).toBe(false);
    expect(audit.data.metadata.testTypeSource).toBe('default');
    expect(audit.data.metadata.routes).toBe(5);
  });

  it('stores a flow map marked as source-derived, with no edges or journeys', async () => {
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job());

    const stored = recorded.flowMaps[0] as { data: Record<string, unknown> };
    expect(stored.data.version).toBe(1);
    expect(stored.data.edgeCount).toBe(0);
    expect(stored.data.journeyCount).toBe(0);
    expect(stored.data.truncatedReason).toBe(SOURCE_FLOW_MAP_REASON);
  });

  it('still writes an approvable plan when the project has no environment', async () => {
    const recorded = stubPrisma({ id: 'p1', codebaseAnalysis: rawAnalysis }, null);
    await processAnalyzeSource(job({ autoApprove: true }));

    expect(recorded.flowMaps).toHaveLength(0);
    expect(recorded.plans).toHaveLength(1);
    const plan = recorded.plans[0] as { skipped: Array<{ what: string; why: string }> };
    expect(plan.skipped.map((s) => s.what)).toContain('Turning these into test files');
    // Approved, because the human's decision is still worth recording — but
    // nothing was queued, because there is no URL to generate against.
    expect(recorded.approvals).toHaveLength(1);
    expect(h.generated).toHaveLength(0);
  });

  it('respects a stored preference instead of the default set', async () => {
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis, testTypePreference: ['API'] },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job());

    const plan = recorded.plans[0] as { items: { create: Array<{ testType: string }> } };
    expect(new Set(plan.items.create.map((i) => i.testType))).toEqual(new Set(['API']));
  });

  it('without a key, queues only the items that scaffold and says so', async () => {
    stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job({ autoApprove: true }));

    expect(h.generated).toHaveLength(1);
    const enqueued = h.generated[0] as { planItemIds: string[] };
    // The default set is SMOKE + API + E2E; only API scaffolds without a model,
    // so strictly fewer items are queued than the plan holds — and the rest are
    // left approved rather than failed.
    expect(enqueued.planItemIds.length).toBeGreaterThan(0);
    expect(enqueued.planItemIds.length).toBeLessThan(defaultPlanSize());
    const messages = h.events.map((e) => JSON.stringify(e.data)).join(' ');
    expect(messages).toContain('ANTHROPIC_API_KEY');
    expect(messages).toContain('They stay approved');
  });

  it('with a key, queues every approved item', async () => {
    h.apiKey = 'sk-test';
    stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job({ autoApprove: true }));

    const enqueued = h.generated[0] as { planItemIds: string[] };
    expect(enqueued.planItemIds.length).toBe(defaultPlanSize());
  });

  it('does not approve anything unless the job asks for it', async () => {
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job());
    expect(recorded.approvals).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });

  it('reports on the channel the onboarding screen already listens to', async () => {
    stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
    );
    await processAnalyzeSource(job());
    expect(h.events.every((e) => e.runId === 'explore:p1')).toBe(true);
    expect(h.events.some((e) => e.type === 'run.finished')).toBe(true);
  });

  /*
   * These two exist because the halves of this wave shipped disagreeing about
   * where the analysis lives: `POST /projects/:id/source` writes a
   * CodebaseSnapshot, and this processor was reading a Project column that the
   * ingest never created. Every real job failed. The first test is the one that
   * would have caught it.
   */
  it('reads the analysis out of the snapshot the ingest actually writes', async () => {
    // No `codebaseAnalysis` anywhere on the project row — the snapshot is the
    // only source, exactly as it is in production.
    const recorded = stubPrisma({ id: 'p1' }, { id: 'e1', baseUrl: 'https://shop.example' }, {
      analysis: rawAnalysis,
    });
    await processAnalyzeSource(job());
    expect(recorded.plans).toHaveLength(1);
  });

  it('prefers the newest snapshot over a stale project column', async () => {
    const stale = { ...(rawAnalysis as Record<string, unknown>), routes: [] };
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: stale },
      { id: 'e1', baseUrl: 'https://shop.example' },
      { analysis: rawAnalysis },
    );
    await processAnalyzeSource(job());
    // The stale column has no routes; a plan built from it would be smaller.
    expect(recorded.plans[0]).toBeDefined();
    const items = (recorded.plans[0] as { items: { create: unknown[] } }).items.create;
    expect(items.length).toBe(defaultPlanSize());
  });

  it('names the snapshot, not just a column, when there is no analysis at all', async () => {
    stubPrisma({ id: 'p1' }, { id: 'e1', baseUrl: 'https://shop.example' }, null);
    await expect(processAnalyzeSource(job())).rejects.toThrow(/CodebaseSnapshot/);
  });

  it('lets a test supply the project row instead of the database', async () => {
    stubPrisma(null, null);
    const recorded = stubPrisma(null, { id: 'e1', baseUrl: 'https://x.example' });
    await processAnalyzeSource(job(), {
      loadProjectRow: () => Promise.resolve({ codebaseAnalysis: rawAnalysis }),
    });
    expect(recorded.plans).toHaveLength(1);
  });
});

/** How many items the fixture yields under the funnel's default type set. */
function defaultPlanSize(): number {
  return scenariosFromSource(analysis(), testTypeChoiceFromProject({})).items.length;
}

// ─── 6. Auth surfaces: the kind must be true, and the title must be its own ──

/**
 * Both halves of this section come from one run of the real product against a
 * real 1245-file React Router application, and neither was visible on the
 * seeded demo data.
 *
 * The plan contained FOUR rows reading, verbatim, "A session outlives a reload,
 * and ends when it should". The rationale under each named a different file, but
 * the title is what a person reads while ticking approval boxes, and four
 * identical rows is a list nobody can act on. The four files were
 * `src/pages/auth/{AcceptInvite,ForgotPassword,RegisterGym,ResetPassword}.tsx`:
 * two password flows, a signup and an invite acceptance, none of them a session.
 *
 * The cause was two-fold and both parts are pinned below. The vocabulary matched
 * whole path SEGMENTS, so a route read off a filename — `/auth/ForgotPassword` —
 * matched nothing in it; and `auth` sat in the SESSION vocabulary, so everything
 * that matched nothing else matched that. Filenames are the realistic case, not
 * the exotic one, so the fixtures here use those files' real names.
 */
describe('auth surfaces are named for what they are', () => {
  /** The subject repo's own auth page names, under a tree Next.js owns. */
  const nextAuthPages = (): RepoFile[] => [
    { path: 'package.json', content: '{"dependencies":{"next":"^15.0.0"}}' },
    { path: 'pages/auth/AcceptInvite.tsx', content: 'export default function AcceptInvite() {}' },
    { path: 'pages/auth/ForgotPassword.tsx', content: 'export default function ForgotPassword() {}' },
    { path: 'pages/auth/RegisterGym.tsx', content: 'export default function RegisterGym() {}' },
    { path: 'pages/auth/ResetPassword.tsx', content: 'export default function ResetPassword() {}' },
    { path: 'pages/auth/SignUp.tsx', content: 'export default function SignUp() {}' },
    { path: 'pages/auth/login.tsx', content: 'export default function Login() {}' },
  ];

  /** kind by the file it was read from — the two facts the defect got wrong. */
  const kindsByFile = (files: RepoFile[]): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const surface of analyseCodebase(files).authSurfaces) {
      (out[surface.file] ??= []).push(surface.kind);
    }
    return out;
  };

  it('reads a camelCased filename as the words in it, not as one opaque segment', () => {
    const kinds = kindsByFile(nextAuthPages());
    expect(kinds['pages/auth/ForgotPassword.tsx']).toEqual(['PASSWORD_RESET']);
    expect(kinds['pages/auth/ResetPassword.tsx']).toEqual(['PASSWORD_RESET']);
    expect(kinds['pages/auth/RegisterGym.tsx']).toEqual(['SIGNUP']);
    expect(kinds['pages/auth/SignUp.tsx']).toEqual(['SIGNUP']);
    expect(kinds['pages/auth/login.tsx']).toEqual(['LOGIN']);
  });

  it('claims no surface at all for the one it cannot honestly name', () => {
    // Invite acceptance has no kind in the vocabulary. A wrong kind produces a
    // wrongly-titled item with wrong steps, which is worse than no item: the
    // honest outcome is silence.
    expect(kindsByFile(nextAuthPages())['pages/auth/AcceptInvite.tsx']).toBeUndefined();
  });

  it('never calls a file a SESSION merely for sitting under auth/', () => {
    const surfaces = analyseCodebase(nextAuthPages()).authSurfaces;
    expect(surfaces.map((s) => s.kind)).not.toContain('SESSION');

    // The directory on its own is a directory, not a surface.
    const bare = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"next":"^15.0.0"}}' },
      { path: 'pages/auth/index.tsx', content: 'export default function Auth() {}' },
    ]).authSurfaces;
    expect(bare).toEqual([]);
  });

  it('still reports a SESSION where one is actually declared', () => {
    // Dropping `auth` from the vocabulary must not cost the kind its real hits:
    // a token exchange names itself and is still found.
    const surfaces = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"express":"^4.0.0"}}' },
      {
        path: 'src/server.ts',
        content: [
          "import express from 'express';",
          'const app = express();',
          "app.post('/api/auth/session', (req, res) => res.json({}));",
          "app.post('/api/auth/refresh', (req, res) => res.json({}));",
        ].join('\n'),
      },
    ]).authSurfaces;
    expect(surfaces.map((s) => `${s.kind} ${s.path}`).sort()).toEqual([
      'SESSION /api/auth/refresh',
      'SESSION /api/auth/session',
    ]);
  });

  it('reads a URL parameter as a value, not as vocabulary', () => {
    // `/accept-invite/:token` is an invite code in a URL. Read as words it says
    // "token", and the first fix here turned it into a SESSION — trading one
    // wrong answer for another on the very file that started this.
    const surfaces = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"express":"^4.0.0"}}' },
      {
        path: 'src/server.ts',
        content: [
          "import express from 'express';",
          'const app = express();',
          "app.get('/accept-invite/:token', (req, res) => res.send('x'));",
        ].join('\n'),
      },
    ]).authSurfaces;
    expect(surfaces).toEqual([]);
  });

  it('keeps common English out of names that merely contain it', () => {
    // `reset`, `confirm` and `callback` are auth words only as a whole segment.
    // Splitting segments into words would otherwise make a settings page a
    // password test and an order page a verification test.
    const surfaces = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"express":"^4.0.0"}}' },
      {
        path: 'src/server.ts',
        content: [
          "import express from 'express';",
          'const app = express();',
          "app.get('/settings/reset-onboarding', (req, res) => res.send('x'));",
          "app.get('/orders/ConfirmOrder', (req, res) => res.send('x'));",
          "app.get('/billing/PaymentCallback', (req, res) => res.send('x'));",
          "app.get('/reset', (req, res) => res.send('x'));",
        ].join('\n'),
      },
    ]).authSurfaces;
    expect(surfaces.map((s) => `${s.kind} ${s.path}`)).toEqual(['PASSWORD_RESET /reset']);
  });

  it('lets the filename overrule the field-shape guess, but not the form action', () => {
    // A password plus a confirmation is the SHAPE of a sign-up and is not a
    // sign-up on `ResetPassword.tsx`. The shape rule exists for repos that name
    // nothing, so a name that says something wins — read off the FILE, because
    // a sign-in form's action is `/api/auth/session` and that is where it posts,
    // not what it is.
    const reset = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"react":"^19.0.0"}}' },
      {
        path: 'src/pages/auth/ResetPassword.tsx',
        content:
          '<form><input name="password" type="password" />' +
          '<input name="confirmPassword" type="password" /><button>Reset</button></form>',
      },
    ]).authSurfaces;
    // Filtered to the form reading: the pages tree also yields a route surface
    // for the same file, and collapsing that pair is the consumer's job below.
    expect(reset.filter((s) => s.from === 'form').map((s) => s.kind)).toEqual(['PASSWORD_RESET']);
    expect(reset.map((s) => s.kind)).not.toContain('SIGNUP');

    const login = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"react":"^19.0.0"}}' },
      {
        path: 'src/components/SignInPanel.tsx',
        content:
          '<form action="/api/auth/session"><input name="email" type="email" />' +
          '<input name="password" type="password" /><button>Sign in</button></form>',
      },
    ]).authSurfaces;
    expect(login.map((s) => s.kind)).toEqual(['LOGIN']);
  });

  it('falls back to the field shape when the filename says nothing', () => {
    // `AdminProfile.tsx` is a real file in the subject repo with a password and
    // a confirmation on it. Nothing in its name is auth vocabulary, so the guess
    // is all there is — and the guess must still run.
    const surfaces = analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"react":"^19.0.0"}}' },
      {
        path: 'src/pages/admin/AdminProfile.tsx',
        content:
          '<form><input name="password" type="password" />' +
          '<input name="confirmPassword" type="password" /><button>Save</button></form>',
      },
    ]).authSurfaces;
    expect(surfaces.map((s) => `${s.kind} ${s.from}`)).toEqual(['SIGNUP form']);
  });
});

describe('no two auth items on the approval screen carry the same title', () => {
  const authItems = (surfaces: unknown[]): PlanItem[] => {
    const parsed = parseCodebaseAnalysis({ ...rawAnalysis, authSurfaces: surfaces })!;
    return scenariosFromSource(parsed, allTypes(['E2E'])).items.filter(
      (i) => i.feature === 'Authentication',
    );
  };

  const surface = (kind: string, path: string, file: string) => ({
    kind,
    path,
    from: 'route',
    file,
    evidence: `${path} — the path names it`,
  });

  /** The subject repo's real password pages: three of them, one kind. */
  const passwordPages = [
    surface('PASSWORD_RESET', '/change-password', 'src/App.tsx'),
    surface('PASSWORD_RESET', '/forgot-password', 'src/App.tsx'),
    surface('PASSWORD_RESET', '/reset-password', 'src/App.tsx'),
    surface('PASSWORD_RESET', '/trainer/change-password', 'src/pages/trainer/change-password.tsx'),
  ];

  it('distinguishes rows a person has to tell apart, by the path already on them', () => {
    const titles = authItems(passwordPages).map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toEqual([
      'Request a password reset and complete it — /change-password',
      'Request a password reset and complete it — /forgot-password',
      'Request a password reset and complete it — /reset-password',
      'Request a password reset and complete it — /trainer/change-password',
    ]);
  });

  it('leaves the sentence alone when the kind occurs once', () => {
    // The suffix is a cost, not a feature: "Sign in with valid credentials, and
    // fail with invalid ones" is the whole title when nothing collides with it.
    const titles = authItems([
      surface('LOGIN', '/login', 'src/App.tsx'),
      ...passwordPages,
    ]).map((i) => i.title);
    expect(titles).toContain(AUTH_TITLES.LOGIN);
  });

  it('keeps every title inside the plan cap, sentence first', () => {
    const deep = '/' + Array.from({ length: 12 }, (_, i) => `segment-number-${i}`).join('/');
    const items = authItems([
      surface('PASSWORD_RESET', `${deep}/forgot-password`, 'src/a.tsx'),
      surface('PASSWORD_RESET', `${deep}/reset-password`, 'src/b.tsx'),
    ]);
    const titles = items.map((i) => i.title);
    expect(new Set(titles).size).toBe(2);
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(160);
      // The sentence is the part a narrow column shows first, so it survives
      // whole and the PATH is what gets trimmed.
      expect(title.startsWith(AUTH_TITLES.PASSWORD_RESET)).toBe(true);
      expect(title).toMatch(/…\//);
    }
  });

  it('reads a route and the form on it as one surface, not two rows', () => {
    // The producer reports both: `/auth/login` from the route detector and
    // `src/pages/auth/login.tsx` from the form detector, because a form in an
    // SPA declares no action and falls back to its own file. That is one sign-in
    // page, and it reached the approval screen as two rows saying the same thing.
    const items = authItems([
      surface('LOGIN', '/auth/login', 'src/pages/auth/login.tsx'),
      { ...surface('LOGIN', 'src/pages/auth/login.tsx', 'src/pages/auth/login.tsx'), from: 'form' },
    ]);
    expect(items.map((i) => i.title)).toEqual([AUTH_TITLES.LOGIN]);
  });

  it('keeps a form-shaped surface the route detector never saw', () => {
    // The collapse above must not become "drop every form surface": a form on a
    // page no route detector claimed is the only reading there is.
    const items = authItems([
      surface('LOGIN', '/auth/login', 'src/pages/auth/login.tsx'),
      { ...surface('SIGNUP', 'src/pages/admin/AdminProfile.tsx', 'src/pages/admin/AdminProfile.tsx'), from: 'form' },
    ]);
    expect(items).toHaveLength(2);
  });

  it('carries the credential fields onto the surface that survives the collapse', () => {
    // `formForSurface` matches on the file, so the route-shaped survivor
    // inherits the fields of the form-shaped reading folded into it. Without
    // that, collapsing would cost the generated test everything to fill in.
    const items = authItems([
      surface('LOGIN', '/login', 'app/login/page.tsx'),
      { ...surface('LOGIN', 'app/login/page.tsx', 'app/login/page.tsx'), from: 'form' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.steps.join(' ')).toContain('"Email"');
    expect(items[0]!.steps.join(' ')).toContain('"Password"');
  });
});
