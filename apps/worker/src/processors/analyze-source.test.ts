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
import type { AuthProfileChoice } from '@qaai/agent';
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
  MAX_UNIT_ITEMS,
  PROJECT_ANALYSIS_FIELDS,
  SOURCE_FLOW_MAP_REASON,
  STATIC_ONLY_SENTENCE,
  UNIT_RISK_FACETS,
  UNIT_RISK_FACET_LIST,
  analysisFromProject,
  flowMapFromSource,
  identifierWords,
  likelyTestPaths,
  parameterNames,
  parseCodebaseAnalysis,
  processAnalyzeSource,
  rankUnitSubjects,
  resolveTestTypeChoice,
  riskFacetsFor,
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
  /*
   * The component inventory, in the shape `analyseCodebase` writes it — so the
   * honesty walk below covers UNIT_GEN items too. It was the absence of this
   * key from the fixture AND from the parser that let a whole test type be
   * unreachable while 106 tests passed.
   *
   * Two entries, chosen to exercise both halves: a money utility, which ranks,
   * and a page, which must be kept off this axis because its route is already
   * proposed as its own test.
   */
  components: [
    {
      modulePath: 'src/billing/pricing.ts',
      exportName: 'priceCart',
      kind: 'UTILITY',
      propsSummary: 'props: items, taxRate',
      hasCatalogueEntry: null,
      catalogueRef: null,
      evidence: 'src/billing/pricing.ts exports priceCart — classified UTILITY',
      line: 12,
      states: [],
    },
    {
      modulePath: 'app/account/page.tsx',
      exportName: 'default',
      kind: 'PAGE',
      propsSummary: null,
      hasCatalogueEntry: null,
      catalogueRef: null,
      evidence: 'app/account/page.tsx exports default (the default export) — classified PAGE',
      line: 1,
      states: [],
    },
  ],
  warnings: ['3 file(s) exceeded the size cap and were not parsed'],
};

const analysis = (): CodebaseAnalysis => parseCodebaseAnalysis(rawAnalysis)!;

const allTypes = (types: TestType[]) => resolveTestTypeChoice(types);

/**
 * Everything the derivation rules can produce, so honesty is checked over all
 * of it — UNIT_GEN included.
 *
 * It is the walk over THIS that matters, not the per-producer tests: a new
 * producer added without being listed here gets none of the five honesty
 * assertions applied to it, and that is exactly how a unit item could have
 * shipped claiming to have read a function body.
 */
const everything = () =>
  scenariosFromSource(
    analysis(),
    allTypes(['SMOKE', 'API', 'E2E', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'UNIT_GEN']),
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

  /**
   * THE SAME DEFECT AS THE AUTH SURFACES ABOVE, AND IT SHIPPED THE SAME WAY.
   *
   * `detectForms` in packages/shared/src/codebase.ts reads six declared
   * constraints off the markup — `maxlength`, `minlength`, `min`, `max`, `step`,
   * `pattern` — and `FormFieldSummary` in packages/agent/src/coverage.ts has a
   * slot for every one. For a whole round the link between them threw them
   * away: `parseField` never read the six keys and `negativeExpansionFor`
   * hard-coded them absent. So the producer read them, the consumer could have
   * used them, and the ten constraint-governed equivalence classes stayed
   * unreachable on this path — not because the value was missing, but because
   * this file dropped it.
   *
   * 104 tests passed with the carry removed, which is why this one exists.
   */
  it('carries the six declared CONSTRAINTS through the parser instead of dropping them', () => {
    const produced = analyseCodebase([
      {
        path: 'signup.html',
        content: `<form name="signup">
             <input type="text" name="zip" maxlength="5" minlength="5" pattern="[0-9]{5}" required>
             <input type="number" name="qty" min="1" max="99" step="1" required>
           </form>`,
      },
    ]);
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)));
    expect(parsed).not.toBeNull();

    const fields = new Map(
      (parsed!.forms[0]?.fields ?? []).map((field) => [field.name, field] as const),
    );
    const zip = fields.get('zip');
    const qty = fields.get('qty');
    expect(zip, 'the producer found a zip field').toBeDefined();
    expect(qty, 'the producer found a qty field').toBeDefined();

    // READ: the number and the regex the markup declares, not a re-derivation.
    expect(zip!.maxLength).toBe(5);
    expect(zip!.minLength).toBe(5);
    expect(zip!.pattern).toBe('[0-9]{5}');
    expect(qty!.min).toBe('1');
    expect(qty!.max).toBe('99');
    expect(qty!.step).toBe('1');

    /*
     * DECLARED_ABSENT stays NULL and does not collapse to "nobody looked".
     * Only this state licenses the unbounded classes, so a `?? undefined`
     * anywhere on the path would cost a real test on every literal form.
     */
    expect(zip!.min).toBeNull();
    expect(zip!.step).toBeNull();
    expect(qty!.pattern).toBeNull();
  });

  /**
   * And the end of the chain: a carried constraint has to become a CASE.
   *
   * Asserted on the plan item's steps rather than on the field shape, because
   * the step is the artefact a human approves — and because the projection in
   * `negativeExpansionFor` is a second place the six can be dropped, which the
   * test above would not notice.
   */
  it('turns a declared constraint into a boundary case a human can read', () => {
    const produced = analyseCodebase([
      {
        path: 'signup.html',
        content: `<form name="signup">
             <input type="number" name="qty" min="1" max="99" step="1" required>
           </form>`,
      },
    ]);
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)))!;
    const steps = scenariosFromSource(parsed, allTypes(['E2E']))
      .items.flatMap((item) => item.steps)
      .join('\n');

    // The classes that are arithmetic over a declared bound. Unreachable by
    // construction until the bound arrived here.
    expect(steps).toContain('[at-min]');
    expect(steps).toContain('[under-min]');
    expect(steps).toContain('[at-max]');
    expect(steps).toContain('[over-max]');
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

  /*
   * The walk is only worth anything if it HAS an item of each producer's type.
   * `everything()` is capped at MAX_PLAN_ITEMS, so a producer whose items all
   * fall below the cap would be walked zero times and every assertion below
   * would pass vacuously about it. Asserted rather than assumed.
   */
  it('actually walks an item from every producer, so the assertions are not vacuous', () => {
    const types = new Set(everything().items.map((item) => item.testType));
    for (const type of ['SMOKE', 'API', 'E2E', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'UNIT_GEN']) {
      expect(types, `nothing of type ${type} reached the honesty walk`).toContain(type);
    }
  });

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
  });

  /**
   * THE DEFECT, SECOND INSTANCE — the one this file carried.
   *
   * `formItem` ended on a single negative assertion built from
   * `required[0]`: `Leaving "<first required field>" empty is refused`. Two
   * fields, one of them a textarea with no limit of any kind, and the plan
   * proposed the one negative fact nearly every form in the world already gets
   * right. Fixing the crawl path in packages/agent would have left this
   * standing, because the defect is in the mechanism and the mechanism was
   * copied.
   */
  describe('a form item enumerates the classes, not just the first required field', () => {
    const profileForm = () =>
      byId(
        scenariosFromSource(analysis(), allTypes(['E2E'])).items,
        'source:form:account-update-profile',
      );

    it('no longer collapses the negative half into one empty-first-field assertion', () => {
      const assertions = profileForm().assertions.join(' ');
      // The literal sentence the old code produced. Its absence is the fix.
      expect(assertions).not.toContain('Leaving "Display name" empty is refused');
      // Empty is still COVERED — it is now one row of a table rather than the
      // whole table, and it names the same field.
      expect(assertions).toContain('[empty] "Display name"');
    });

    it('covers the classes a static read CAN reach, one representative each', () => {
      const assertions = profileForm().assertions.join(' ');
      for (const klass of [
        'empty',
        'whitespace-only',
        'unbounded-length',
        'injection-like',
        'unicode-emoji',
      ]) {
        expect(assertions, `no case for ${klass}`).toContain(`[${klass}]`);
      }
      // One invalid field per row, and "Bio" is not required — so it gets the
      // length and escaping classes and not the required-ness ones.
      expect(assertions).toContain('[unbounded-length] "Bio"');
      expect(assertions).not.toContain('[empty] "Bio"');
    });

    it('claims NO class that needs an attribute the source never read', () => {
      /*
       * The honest half. `detectForms` in packages/shared reads `required`,
       * `type`, the label and a select's literal options — and no `maxlength`,
       * `minlength`, `min`, `max`, `step` or `pattern`. So the ten classes that
       * need one of those cannot be built, and the item must not pretend
       * otherwise by, say, guessing a limit.
       */
      const item = profileForm();
      const prose = [...item.steps, ...item.assertions].join(' ');
      for (const klass of [
        'at-max-length',
        'over-max-length',
        'at-min-length',
        'under-min-length',
        'at-min',
        'under-min',
        'at-max',
        'over-max',
        'step-misaligned',
        'pattern-violating',
      ]) {
        expect(prose, `invented a ${klass} case with no attribute to found it on`).not.toContain(
          `[${klass}]`,
        );
      }
    });

    it('says WHY those ten are missing — for want of input, not for want of a limit', () => {
      const disclosure = profileForm().assertions.find((a) => a.includes('NOT COVERED'))!;
      expect(disclosure).toContain('step-misaligned');
      expect(disclosure).toContain('pattern-violating');
      // The distinction that matters: the attributes were never captured. The
      // alternative reading — that the form declares no limits — is a claim
      // about the customer's markup made without reading it.
      expect(disclosure).toContain('absent for want of input rather than because the form declares nothing');
      expect(disclosure).toContain('Do not read a pass here as proof');
    });

    it('asks for ONE parameterised test over the rows, not one test per row', () => {
      // Every ecosystem fragment in @qaai/agent's ecosystem-prompts already
      // tells the model to prefer an input table over a loop; the plan item has
      // to be shaped like the thing those prompts can write.
      const steps = profileForm().steps.join(' ');
      expect(steps).toContain('ONE parameterised test');
      expect(steps).toContain('not one test per row');
      expect(steps).toMatch(/changing exactly ONE field each time/);
    });

    it('reaches not-in-options when the markup writes the options out', () => {
      /*
       * `parseField` dropped `options`, which the producer has always written,
       * and that loss cost a whole class: a value outside a select cannot be
       * typed and can trivially be POSTed, which is where
       * authorisation-by-dropdown fails.
       */
      const withSelect = parseCodebaseAnalysis({
        ...rawAnalysis,
        forms: [
          {
            name: 'Membership',
            route: '/join',
            file: 'app/join/page.tsx',
            submitLabel: 'Join',
            fields: [
              {
                name: 'tier',
                label: 'Tier',
                inputType: 'select',
                required: true,
                semantic: 'unknown',
                options: ['Basic', 'Premium'],
              },
            ],
          },
        ],
      })!;
      const membership = withSelect.forms.find((f) => f.name === 'Membership')!;
      expect(membership.fields[0]!.options).toEqual(['Basic', 'Premium']);
      const item = byId(
        scenariosFromSource(withSelect, allTypes(['E2E'])).items,
        'source:form:join-membership',
      );
      expect(item.assertions.join(' ')).toContain('[not-in-options] "Tier"');
    });

    it('stays deterministic, so an unchanged repository proposes the same table', () => {
      const once = profileForm();
      const twice = profileForm();
      expect(twice.steps).toEqual(once.steps);
      expect(twice.assertions).toEqual(once.assertions);
    });

    it('stays inside the plan schema it has to survive', () => {
      // The budget is tight by construction: see MAX_FILL_STEPS. A step list
      // that overflowed would be silently truncated by the `.slice(0, 40)`,
      // taking the parameterisation instruction with it.
      for (const item of everything().items) {
        expect(item.steps.length, `${item.id} steps`).toBeLessThanOrEqual(40);
        expect(item.assertions.length, `${item.id} assertions`).toBeLessThanOrEqual(20);
        expect(planItemSchema.safeParse(item).success, item.id).toBe(true);
      }
    });
  });

  it('expands the credential form too, instead of one wrong password', () => {
    const item = byId(
      scenariosFromSource(analysis(), allTypes(['E2E'])).items,
      'source:auth:login-login',
    );
    const assertions = item.assertions.join(' ');
    // The sign-in form is the one that most deserves the expansion, and it had
    // exactly one negative step: "Repeat with a deliberately wrong credential".
    expect(assertions).toContain('[empty] "Email"');
    expect(assertions).toContain('[wrong-type] "Email"');
    expect(assertions).toContain('[whitespace-only] "Password"');
    expect(assertions).toContain('No rejected attempt leaves a session behind');
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

// ─── 4b. The role a guarded item runs as ─────────────────────────────────────

/**
 * Six producers in this file wrote `authProfileId: null`, unconditionally, and
 * four of them were RIGHT to. The defect was that all six were the same
 * literal, so there was no way to tell a considered null from a forgotten one —
 * and the two that were forgotten proposed a test that said "Sign in" in prose
 * and then ran as nobody, asserting that a guarded page "answers with a
 * successful status" against whatever its login redirect returns.
 *
 * What the evidence supports here is narrow and worth being precise about.
 * `chooseAuthProfile`'s strongest rule reads the roles the APPLICATION declared
 * (`requiresRoles`), and a static pass records that a route is guarded and
 * never by whom — so rule 1 can never fire on this path and only the weaker
 * two can: a word shared between the path and a profile name, or there being
 * exactly one profile to choose.
 */
describe('a guarded source item names the role it runs as', () => {
  const ACCOUNT: AuthProfileChoice = { id: 'prof_account', name: 'Account holder', kind: 'FORM_LOGIN' };
  const ADMIN: AuthProfileChoice = { id: 'prof_admin', name: 'Admin', kind: 'FORM_LOGIN' };

  const derive = (profiles: AuthProfileChoice[]) =>
    scenariosFromSource(
      analysis(),
      allTypes(['SMOKE', 'API', 'E2E', 'ACCESSIBILITY', 'SECURITY_SMOKE']),
      profiles,
    ).items;

  it('binds the only profile there is to the guarded route and the form on it', () => {
    const items = derive([ACCOUNT]);
    expect(byId(items, 'source:smoke:account').authProfileId).toBe('prof_account');
    expect(byId(items, 'source:form:account-update-profile').authProfileId).toBe('prof_account');
  });

  it('says in the test itself that the runner delivers the session', () => {
    const steps = byId(derive([ACCOUNT]), 'source:smoke:account').steps.join(' ');
    expect(steps).toContain('Sign in as the "Account holder" auth profile');
    // A test that also hand-rolls a login form walks a redirect the item does
    // not contain, and then asserts against the wrong page.
    expect(steps).toContain('do NOT write a login form');
  });

  it('matches on a word the route and a profile name share', () => {
    // `/account` and "Account holder" — rule 2, the only inference available
    // without a declared role.
    const items = derive([ADMIN, ACCOUNT]);
    expect(byId(items, 'source:smoke:account').authProfileId).toBe('prof_account');
  });

  it('REFUSES rather than guessing between profiles that match nothing', () => {
    /*
     * The case that must stay null. A wrong role does not fail loudly — it
     * signs in successfully as the wrong person and asserts whatever that
     * person can see — so picking "the first" would be the original defect in
     * a better disguise.
     */
    const items = derive([
      { id: 'prof_a', name: 'Alice', kind: 'FORM_LOGIN' },
      { id: 'prof_b', name: 'Bob', kind: 'FORM_LOGIN' },
    ]);
    expect(byId(items, 'source:smoke:account').authProfileId).toBeNull();
    expect(byId(items, 'source:form:account-update-profile').authProfileId).toBeNull();
  });

  it('leaves an unguarded route unbound — nothing to sign in as, nothing needed', () => {
    const items = derive([ACCOUNT]);
    expect(byId(items, 'source:smoke:products').authProfileId).toBeNull();
    expect(byId(items, 'source:form:login-sign-in').authProfileId).toBeNull();
  });

  it('keeps the four anonymous-by-design producers anonymous, profile or not', () => {
    /*
     * Each of these asserts something only an UNAUTHENTICATED (or public)
     * request can establish, so a bound session would make it fail against a
     * correct application — or pass while proving the opposite:
     *
     *   security   — "every guarded path refuses an anonymous request"
     *   api        — a guarded endpoint's item sends no session on purpose
     *   auth       — this IS the sign-in test; an injected session skips it
     *   a11y       — scans only the routes the source says are public
     */
    const items = derive([ACCOUNT, ADMIN]);
    for (const id of [
      'source:security:guarded-routes',
      'source:api:post-api-orders',
      'source:auth:login-login',
      'source:a11y:declared-routes',
    ]) {
      expect(byId(items, id).authProfileId, id).toBeNull();
    }
  });

  it('states on the plan that a guarded item is running unbound, and only then', () => {
    const unbound = scenariosFromSource(analysis(), allTypes(['SMOKE', 'E2E']), []);
    const bound = scenariosFromSource(analysis(), allTypes(['SMOKE', 'E2E']), [ACCOUNT]);
    expect(unbound.skipped.map((s) => s.what).join(' ')).toMatch(/Running \d+ item\(s\) as a real user/);
    expect(unbound.skipped.map((s) => s.why).join(' ')).toContain('no auth profile configured');
    expect(bound.skipped.map((s) => s.what).join(' ')).not.toMatch(/as a real user/);
  });

  it('explains the limit honestly when profiles exist but none can be matched', () => {
    const derived = scenariosFromSource(analysis(), allTypes(['SMOKE', 'E2E']), [
      { id: 'prof_a', name: 'Alice', kind: 'FORM_LOGIN' },
      { id: 'prof_b', name: 'Bob', kind: 'FORM_LOGIN' },
    ]);
    const why = derived.skipped.map((s) => s.why).join(' ');
    // The reason has to name the actual limitation of a static pass, not blame
    // the customer's naming: the analysis records that a route is guarded and
    // never by whom, so there is no declared role to match against.
    expect(why).toContain('never by whom');
    expect(why).toContain('cover the wall rather than the page');
  });

  it('keeps the signed-out leg, and says it cannot share the bound session', () => {
    const bound = byId(derive([ACCOUNT]), 'source:smoke:account').assertions.join(' ');
    expect(bound).toContain('With the session removed');
    const unbound = byId(derive([]), 'source:smoke:account').assertions.join(' ');
    expect(unbound).toContain('Signed out, /account refuses or redirects');
  });

  it('is stable: the same analysis and profiles always bind the same role', () => {
    const once = derive([ADMIN, ACCOUNT]).map((i) => `${i.id}:${i.authProfileId}`);
    const twice = derive([ACCOUNT, ADMIN]).map((i) => `${i.id}:${i.authProfileId}`);
    // Order of the profile list must not change the binding; `chooseAuthProfile`
    // sorts by name so a gap id and the role behind it stay stable together.
    expect(twice).toEqual(once);
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
  /*
   * `paths` is the sibling column `defaultLoadAnalysedPaths` reads. Optional,
   * so every existing case still stubs a snapshot with no path list — which is
   * the production state for a project ingested before it was populated, and
   * the state the "nobody looked" disclosure depends on.
   */
  snapshot: { analysis: unknown; paths?: unknown } | null = null,
  /**
   * Auth profiles on that environment. Defaults to NONE, which is the honest
   * default for a project that arrived as a repository and has configured no
   * role — and keeps every case written before the plan could name one
   * exercising the unbound path.
   */
  profiles: Array<{ id: string; name: string; kind: string }> = [],
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
    authProfile: { findMany: () => Promise.resolve(profiles) },
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

  it('writes the bound role onto the PlanItem row, not just into the prose', async () => {
    /*
     * The end of the wire. `authProfileId` was a hard-coded null in six
     * producers, so the column existed, the Generator was handed it, and no
     * source-derived item ever carried a role — the test signed in in prose and
     * ran as nobody. This asserts the id survives all the way to the row.
     */
    const recorded = stubPrisma(
      { id: 'p1', codebaseAnalysis: rawAnalysis },
      { id: 'e1', baseUrl: 'https://shop.example' },
      null,
      [{ id: 'prof_account', name: 'Account holder', kind: 'FORM_LOGIN' }],
    );
    await processAnalyzeSource(job());

    const plan = recorded.plans[0] as {
      items: { create: Array<{ title: string; authProfileId: string | null }> };
    };
    const guarded = plan.items.create.filter((i) => i.title.includes('/account'));
    expect(guarded.length).toBeGreaterThan(0);
    for (const item of guarded) expect(item.authProfileId, item.title).toBe('prof_account');
    /*
     * And the anonymous-by-design items are untouched by a profile existing.
     * The guarded API item is the sharpest case: its own step sends the request
     * with no session, so a bound profile would have the runner inject one, the
     * endpoint would answer 200, and the test would fail against an application
     * whose auth is working.
     */
    const guardedApi = plan.items.create.find((i) => i.title.includes('POST /api/orders'));
    expect(guardedApi).toBeDefined();
    expect(guardedApi!.authProfileId).toBeNull();
    const signIn = plan.items.create.find((i) => i.title.includes('Sign in with valid credentials'));
    expect(signIn).toBeDefined();
    expect(signIn!.authProfileId).toBeNull();
  });

  it('reads no auth profile at all when the project has no environment', async () => {
    // The profiles hang off the environment, so there is nothing to read and
    // the guarded items stay unbound — with the reason on the plan.
    const recorded = stubPrisma({ id: 'p1', codebaseAnalysis: rawAnalysis }, null);
    await processAnalyzeSource(job());

    const plan = recorded.plans[0] as {
      skipped: Array<{ what: string; why: string }>;
      items: { create: Array<{ authProfileId: string | null }> };
    };
    expect(plan.items.create.every((i) => i.authProfileId === null)).toBe(true);
    expect(plan.skipped.map((s) => s.what).join(' ')).toMatch(/as a real user/);
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

// ─── UNIT_GEN: the logic half of the application ─────────────────────────────

/**
 * THE DEFECT THESE EXIST TO HOLD SHUT, and it was four breaks deep.
 *
 * `TEST_TYPE_DECLARATIONS.UNIT_GEN` recorded `producers: ['NONE']` — nothing
 * anywhere could put a unit test into a plan — and the reason turned out to be
 * one line upstream of every theory about it: `CodebaseAnalysis` in this file
 * declared no `components` field, so `parseCodebaseAnalysis` dropped
 * `analysis.components` on the floor. `analyseCodebase` ALWAYS sets it. A
 * repository with four hundred exported functions arrived at the only pass that
 * could have ranked them as a list of routes and forms.
 *
 * So the first test here is the contract-parity one, in the shape the auth
 * surfaces and the six form constraints already taught this file to write: run
 * the REAL producer, round-trip through JSON the way the snapshot column does,
 * and assert the value SURVIVES. A fixture is a copy of the contract, and a
 * copy is what drifts.
 *
 * The rest hold the line this producer must not cross. It knows a module path,
 * an export name and PARAMETER NAMES; it does not know a body, a type or a
 * return. An item that claimed otherwise would be the agent's imagination
 * wearing a rationale's clothes, on the one subject where a plausible wrong
 * assertion is hardest to spot.
 */

const moneyComponent = {
  modulePath: 'src/billing/pricing.ts',
  exportName: 'priceCart',
  // `as const` so the fixture is assignable to `SourceComponentExport` where
  // `riskFacetsFor` is called directly; a widened `string` would make every
  // classifier test take `unknown` and stop checking the shape at all.
  kind: 'UTILITY' as const,
  propsSummary: 'props: items, discountCode, taxRate',
  hasCatalogueEntry: null,
  catalogueRef: null,
  evidence: 'src/billing/pricing.ts exports priceCart — classified UTILITY',
  line: 12,
  states: [],
};

const withComponents = (components: unknown[]): CodebaseAnalysis =>
  parseCodebaseAnalysis({ ...rawAnalysis, components })!;

describe('the component inventory reaches this parser instead of being dropped', () => {
  it('carries components through the parser, from the real producer', () => {
    const produced = analyseCodebase([
      {
        path: 'src/pricing.ts',
        content: [
          'export function priceCart({ items, taxRate }) {',
          '  return items.length * taxRate;',
          '}',
        ].join('\n'),
      },
      { path: 'package.json', content: '{}' },
    ]);
    expect(produced.components?.length, 'the producer found an export').toBeGreaterThan(0);

    // Round-trip through JSON, because that is what the snapshot column does.
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)));
    expect(parsed).not.toBeNull();
    // The whole defect: this was 0 while the line above was > 0.
    expect(parsed!.components).toHaveLength(produced.components!.length);
    expect(parsed!.components.map((c) => c.exportName)).toContain('priceCart');
  });

  it('turns a carried component into a UNIT_GEN item a plugin would accept', () => {
    // And the end of the chain: a carried component has to become an ITEM.
    const produced = analyseCodebase([
      {
        path: 'src/pricing.ts',
        content: 'export function priceCart({ items, taxRate }) { return 0; }',
      },
      { path: 'package.json', content: '{}' },
    ]);
    const parsed = parseCodebaseAnalysis(JSON.parse(JSON.stringify(produced)))!;
    const items = scenariosFromSource(parsed, allTypes(['UNIT_GEN'])).items;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.testType === 'UNIT_GEN')).toBe(true);
    // The plan's own schema, so an item that cannot be stored fails here rather
    // than at the approval screen.
    for (const item of items) expect(planItemSchema.safeParse(item).success).toBe(true);
  });

  it('drops an entry with no evidence rather than defaulting it', () => {
    const parsed = withComponents([
      { ...moneyComponent, modulePath: '' },
      { ...moneyComponent, exportName: '' },
      // A kind from a newer producer. Guessing UTILITY would put an unknown
      // thing into the ranking under a label nobody wrote.
      { ...moneyComponent, kind: 'SAGA' },
      moneyComponent,
    ]);
    expect(parsed.components).toHaveLength(1);
  });

  it('treats (module, exportName) as the identity, so two readers are one subject', () => {
    const parsed = withComponents([
      moneyComponent,
      { ...moneyComponent, evidence: 'found again by a second detector' },
      { ...moneyComponent, exportName: 'priceOrder' },
    ]);
    expect(parsed.components).toHaveLength(2);
  });
});

describe('identifier classification', () => {
  it('splits camelCase and snake_case before matching', () => {
    expect(identifierWords('getTaxAmount_v2')).toEqual(['get', 'tax', 'amount', 'v2']);
    expect(identifierWords('HTTPRetryPolicy')).toEqual(['http', 'retry', 'policy']);
  });

  it('matches words, not substrings — which is the difference between a classifier and a coincidence', () => {
    // Every one of these hits on a substring search and means nothing: `tax` in
    // `taxonomy`, `can` in `cancel`, `age` in `message`, `lock` in `blockquote`.
    for (const name of ['getTaxonomy', 'cancelOrder', 'renderMessage', 'parseBlockquote']) {
      const hits = riskFacetsFor({ ...moneyComponent, modulePath: 'src/ui.ts', exportName: name, propsSummary: null }).hits;
      const coincidental = hits.filter((hit) => hit.where === 'EXPORT_NAME');
      // `parseBlockquote` legitimately matches VALIDATION on `parse`; what must
      // not appear is a match on the substring.
      expect(coincidental.map((hit) => hit.word)).not.toContain('tax');
      expect(coincidental.map((hit) => hit.word)).not.toContain('can');
      expect(coincidental.map((hit) => hit.word)).not.toContain('age');
      expect(coincidental.map((hit) => hit.word)).not.toContain('lock');
    }
  });

  it('counts each facet ONCE however many of its words hit', () => {
    // Otherwise a wordy name outranks an important one for being wordy.
    const wordy = riskFacetsFor({
      ...moneyComponent,
      exportName: 'applyDiscountToInvoiceTotalPriceAmount',
      modulePath: 'src/x.ts',
      propsSummary: null,
    });
    const terse = riskFacetsFor({
      ...moneyComponent,
      exportName: 'chargeCard',
      modulePath: 'src/x.ts',
      propsSummary: null,
    });
    expect(wordy.score).toBe(terse.score);
    expect(wordy.hits.length).toBeGreaterThan(terse.hits.length);
  });

  it('reads the MODULE PATH, which is how an unnamed function is caught at all', () => {
    // `apply` in `src/billing/discounts.ts` is money code and its name says
    // nothing. This is the function a name-only classifier misses.
    const hit = riskFacetsFor({
      ...moneyComponent,
      exportName: 'apply',
      modulePath: 'src/billing/discounts.ts',
      propsSummary: null,
    });
    expect(hit.leadFacet).toBe('MONEY');
    expect(hit.hits.some((h) => h.where === 'MODULE_PATH')).toBe(true);
  });

  it('reads PARAMETER names, so a neutral name with a money argument still ranks', () => {
    const hit = riskFacetsFor({
      ...moneyComponent,
      exportName: 'apply',
      modulePath: 'src/util.ts',
      propsSummary: 'props: subtotal, rate',
    });
    expect(hit.hits.some((h) => h.where === 'PARAMETER' && h.word === 'subtotal')).toBe(true);
  });

  it('ranks money and permission above the other three', () => {
    const score = (exportName: string): number =>
      riskFacetsFor({ ...moneyComponent, exportName, modulePath: 'src/x.ts', propsSummary: null })
        .score;
    // Silent defects outrank loud ones: a wrong total is charged and a wrong
    // permission is granted, and neither raises anything.
    expect(score('priceCart')).toBeGreaterThan(score('validateInput'));
    expect(score('canEditOrder')).toBeGreaterThan(score('validateInput'));
    expect(score('validateInput')).toBeGreaterThan(score('nextRenewalDate'));
  });

  it('breaks a tie by the declared facet order, not by iteration order', () => {
    // A function on both MONEY and DATE_MATH is titled after MONEY, every time,
    // because the lead facet is a function of the vocabulary.
    const hit = riskFacetsFor({
      ...moneyComponent,
      exportName: 'invoiceDueDate',
      modulePath: 'src/x.ts',
      propsSummary: null,
    });
    expect(hit.leadFacet).toBe('MONEY');
  });

  it('derives its facet list from the declaration rather than restating it', () => {
    expect([...UNIT_RISK_FACET_LIST].sort()).toEqual([...UNIT_RISK_FACETS].sort());
  });

  it('reads parameter names off the one-line summary, and nothing else', () => {
    expect(parameterNames('props: items, discountCode, taxRate')).toEqual([
      'items',
      'discountCode',
      'taxRate',
    ]);
    // Null is a real answer and must not become a fabricated parameter.
    expect(parameterNames(null)).toEqual([]);
    expect(parameterNames('props: ')).toEqual([]);
  });
});

describe('ranking the inventory', () => {
  const ranked = (components: unknown[], paths: string[] = []) =>
    rankUnitSubjects(withComponents(components), paths);

  it('is byte-identical for the same analysis, twice', () => {
    // Distinct parameter lists on purpose: the shared `taxRate` on
    // `moneyComponent` would put MONEY on all three and make this test about
    // the fixture rather than about the ranking.
    const components = [
      { ...moneyComponent, exportName: 'priceCart', modulePath: 'src/b.ts', propsSummary: 'props: items' },
      { ...moneyComponent, exportName: 'canEdit', modulePath: 'src/a.ts', propsSummary: 'props: actor' },
      { ...moneyComponent, exportName: 'validateZip', modulePath: 'src/c.ts', propsSummary: 'props: zip' },
    ];
    // No clock, no Math.random: re-analysing an unchanged repository has to
    // propose the same functions in the same order or the approval screen
    // reshuffles between runs.
    const a = JSON.stringify(ranked(components).subjects.map((s) => s.component.exportName));
    const b = JSON.stringify(ranked(components).subjects.map((s) => s.component.exportName));
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(['priceCart', 'canEdit', 'validateZip']);
  });

  it('does not depend on the order the producer emitted them in', () => {
    const forwards = [
      { ...moneyComponent, exportName: 'validateZip', modulePath: 'src/c.ts' },
      { ...moneyComponent, exportName: 'priceCart', modulePath: 'src/b.ts' },
    ];
    const names = (components: unknown[]) =>
      ranked(components).subjects.map((s) => s.component.exportName);
    expect(names(forwards)).toEqual(names([...forwards].reverse()));
  });

  it('keeps a PAGE off this axis, because its route is already proposed', () => {
    // One surface in two denominators is the defect `componentHasOwnAxis` was
    // written to prevent — arriving here from two producers that AGREE.
    const result = ranked([
      { ...moneyComponent, kind: 'PAGE', exportName: 'CheckoutPage' },
      { ...moneyComponent, kind: 'LAYOUT', exportName: 'BillingLayout' },
      moneyComponent,
    ]);
    expect(result.onOtherAxis).toBe(2);
    expect(result.subjects).toHaveLength(1);
  });

  it('counts the exports it did not rank rather than letting them vanish', () => {
    const result = ranked([
      moneyComponent,
      { ...moneyComponent, exportName: 'formatLabel', modulePath: 'src/ui/label.ts', propsSummary: null },
      { ...moneyComponent, exportName: 'Spinner', modulePath: 'src/ui/spinner.ts', propsSummary: null, kind: 'COMPONENT' },
    ]);
    // Not proposed AND not silently gone: an unranked export is an uncovered
    // surface, and the number is what makes that readable.
    expect(result.subjects).toHaveLength(1);
    expect(result.unranked).toBe(2);
  });

  it('finds an existing test beside a module, in the recorded paths', () => {
    expect(likelyTestPaths('src/billing/pricing.ts', ['src/billing/pricing.test.ts'])).toEqual([
      'src/billing/pricing.test.ts',
    ]);
    expect(likelyTestPaths('src/pricing.ts', ['src/__tests__/pricing.spec.ts'])).toEqual([
      'src/__tests__/pricing.spec.ts',
    ]);
    expect(likelyTestPaths('app/pricing.py', ['app/test_pricing.py'])).toEqual([
      'app/test_pricing.py',
    ]);
  });

  it('does not call an unrelated file a test for this module', () => {
    // `src/testUtils.ts` is not a test for itself, and a sibling module's test
    // is not this module's test. A regex over anything containing "test" says
    // both are.
    expect(likelyTestPaths('src/testUtils.ts', ['src/testUtils.ts'])).toEqual([]);
    expect(likelyTestPaths('src/pricing.ts', ['src/checkout.test.ts'])).toEqual([]);
  });

  it('answers nothing when no path list was read, which is not "it has no tests"', () => {
    // The distinction the plan carries: an empty result here means nobody
    // looked, and the item says so in those words.
    expect(likelyTestPaths('src/pricing.ts', [])).toEqual([]);
  });
});

describe('a UNIT_GEN plan item', () => {
  const itemFor = (components: unknown[] = [moneyComponent], paths: string[] = []) =>
    scenariosFromSource(
      withComponents(components),
      allTypes(['UNIT_GEN']),
      [],
      paths,
    );

  it('names the file, the export and the WORD that classified it', () => {
    const item = itemFor().items[0]!;
    // Evidence-shaped, like every other producer here — and naming the word is
    // what lets a reviewer say "no, `charge` there is an electric charge".
    expect(item.rationale).toContain('src/billing/pricing.ts');
    expect(item.rationale).toContain('priceCart');
    expect(item.rationale).toMatch(/the word "(price|billing|pricing|taxRate|tax)"/);
    expect(item.rationale).toContain(STATIC_ONLY_SENTENCE);
  });

  it('says outright that the BODY, the TYPES and the RETURN were not read', () => {
    const item = itemFor().items[0]!;
    // The one sentence that stops a green unit test being read as proof the
    // signature is honoured. Without it the item reads as though someone looked
    // at the function.
    expect(item.rationale).toMatch(/BODY/);
    expect(item.rationale).toMatch(/parameter NAMES only/);
    expect(item.assertions.join(' ')).toMatch(/Do not read a pass here as proof/);
  });

  it('asserts a defect CLASS, never what the function computes', () => {
    const item = itemFor().items[0]!;
    const text = `${item.title} ${item.rationale} ${item.assertions.join(' ')}`;
    // The line this producer will not cross. A rationale that said what the
    // arithmetic should be would be inventing the only fact nobody read.
    expect(item.assertions[0]).toMatch(/never returns a negative/);
    expect(text).not.toMatch(/returns \d/);
    expect(text).not.toMatch(/should equal/);
  });

  it('carries no auth profile, because there is nobody to be in a unit test', () => {
    const item = itemFor().items[0]!;
    expect(item.authProfileId).toBeNull();
  });

  it('ranks money as a critical path and a date helper as merely important', () => {
    expect(itemFor([moneyComponent]).items[0]!.priority).toBe('CRITICAL_PATH');
    expect(
      itemFor([
        {
          ...moneyComponent,
          exportName: 'nextRenewalDate',
          modulePath: 'src/schedule/renewal.ts',
          propsSummary: 'props: startedAt, timezone',
        },
      ]).items[0]!.priority,
    ).toBe('IMPORTANT');
  });

  it('tells the generator the parameter NAMES are facts and the types are not', () => {
    const steps = itemFor().items[0]!.steps.join('\n');
    expect(steps).toContain('items, discountCode, taxRate');
    expect(steps).toMatch(/the names are from the source, the TYPES are not/);
  });

  it('proposes boundary cases over the parameters rather than ten happy paths', () => {
    const item = itemFor().items[0]!;
    const cases = item.steps.filter((step) => /^\[/.test(step));
    expect(cases.length).toBeGreaterThan(1);
  });

  it('asserts no rejection that rests on a parameter being required', () => {
    /*
     * `propsSummaryFor` strips everything after `[:=]`, so `{ qty = 1 }` and
     * `{ qty }` are the same string here and optionality is unread.
     *
     * Declaring the parameters `required` adds exactly two cases to the
     * expansion — `empty -> rejected` and `whitespace-only -> rejected` — and
     * both assert a refusal a DEFAULTED parameter is right not to perform. So
     * the test is on those two classes by name and on the EXPECTATION, not on
     * a class name the vocabulary does not contain: an assertion against
     * /MISSING_REQUIRED/ passes no matter what this code does, because
     * `EQUIVALENCE_CLASSES` has no such member. (It did, and this mutation
     * survived until the assertion was written against the real output.)
     */
    const item = itemFor().items[0]!;
    const cases = item.steps.filter((step) => /^\[/.test(step));
    expect(cases.length, 'there are cases to inspect').toBeGreaterThan(0);

    for (const step of cases) {
      expect(step, 'a rejection that rests on absence').not.toMatch(
        /^\[(empty|whitespace-only)\].*expect it to be rejected/,
      );
    }
    expect(cases.join('\n')).not.toMatch(/^\[empty\]/m);
    expect(cases.join('\n')).not.toMatch(/^\[whitespace-only\]/m);
    expect(item.assertions.join(' ')).toMatch(/whether it is optional/);
  });

  it('says there is nothing to vary when no parameter name was recorded', () => {
    const item = itemFor([{ ...moneyComponent, propsSummary: null }]).items[0]!;
    expect(item.steps.join('\n')).toMatch(/recorded no parameter names for it/);
    expect(item.assertions.join(' ')).toMatch(/any input variation at all/);
  });

  it('points at an existing test instead of restating it, when one was found', () => {
    const item = itemFor([moneyComponent], ['src/billing/pricing.test.ts']).items[0]!;
    expect(item.rationale).toContain('src/billing/pricing.test.ts');
    expect(item.rationale).toMatch(/extend them rather than restate them/);
    expect(item.assertions.join(' ')).toMatch(/Nothing here duplicates an assertion already made/);
  });

  it('does not claim a module has no tests when no paths were read', () => {
    const item = itemFor([moneyComponent], []).items[0]!;
    expect(item.rationale).toMatch(/in the recorded paths/);
    expect(item.rationale).not.toMatch(/has no tests/);
  });

  it('groups by the feature its directory names, not by `src`', () => {
    expect(itemFor().items[0]!.feature).toBe('Billing');
    expect(
      itemFor([{ ...moneyComponent, modulePath: 'src/pricing.ts' }]).items[0]!.feature,
    ).toBe('Pricing');
  });

  it('is stable: the same analysis produces the same item id', () => {
    expect(itemFor().items[0]!.id).toBe(itemFor().items[0]!.id);
    expect(itemFor().items[0]!.id).toMatch(/^source:unit:/);
  });
});

describe('what the UNIT_GEN producer discloses', () => {
  const derive = (components: unknown[], paths: string[] = []) =>
    scenariosFromSource(withComponents(components), allTypes(['UNIT_GEN']), [], paths);

  const why = (derived: ReturnType<typeof derive>, needle: RegExp): string | undefined =>
    derived.skipped.find((entry) => needle.test(entry.what))?.why;

  it('counts the cap that bit, with the number and the reason', () => {
    const many = Array.from({ length: MAX_UNIT_ITEMS + 4 }, (_unused, index) => ({
      ...moneyComponent,
      modulePath: `src/billing/m${index}.ts`,
      exportName: `priceThing${index}`,
    }));
    const derived = derive(many);

    expect(derived.items).toHaveLength(MAX_UNIT_ITEMS);
    // A cap applied without being disclosed is the undisclosed cap that makes a
    // percentage go up.
    expect(why(derived, /further ranked function/)).toMatch(
      new RegExp(`only the top ${MAX_UNIT_ITEMS} by risk`),
    );
  });

  it('tells "the repository exports none" apart from "nobody looked"', () => {
    const derived = derive([]);
    expect(derived.items).toHaveLength(0);
    // Two states that arrive here identically, and the next action differs.
    expect(why(derived, /Unit/i)).toMatch(/re-import the source to tell those two apart/);
  });

  it('counts the pages it kept off the axis, rather than going quiet', () => {
    const derived = derive([
      { ...moneyComponent, kind: 'PAGE', exportName: 'CheckoutPage' },
      moneyComponent,
    ]);
    expect(why(derived, /page and layout export/)).toMatch(/one surface in two denominators/);
  });

  it('counts the unranked exports, because they are uncovered and not absent', () => {
    const derived = derive([
      moneyComponent,
      { ...moneyComponent, exportName: 'formatLabel', modulePath: 'src/ui/label.ts', propsSummary: null },
    ]);
    const reason = why(derived, /other exported function/);
    expect(reason).toMatch(/They are not covered and they are not proposed/);
    expect(reason).toMatch(/Ask for one by hand if a name is misleading/);
  });

  it('counts the inventory in the totals, so the denominator is readable', () => {
    // A distinct export, because (module, exportName) is the identity and the
    // same pair twice is correctly ONE subject — which this assertion would
    // otherwise be quietly measuring instead.
    const derived = derive([
      moneyComponent,
      { ...moneyComponent, kind: 'PAGE', exportName: 'CheckoutPage' },
    ]);
    expect(derived.totals.components).toBe(2);
  });

  it('pairs each surviving item with its subject', () => {
    const many = Array.from({ length: MAX_UNIT_ITEMS + 2 }, (_unused, index) => ({
      ...moneyComponent,
      modulePath: `src/billing/m${index}.ts`,
      exportName: `priceThing${index}`,
    }));
    const derived = derive(many);

    expect(derived.unitSubjects).toHaveLength(derived.items.length);
    const ids = new Set(derived.items.map((item) => item.id));
    expect(derived.unitSubjects.every((pair) => ids.has(pair.itemId))).toBe(true);
  });

  it('drops the subject of an item the PLAN-WIDE cap deferred', () => {
    /*
     * The case the test above cannot reach. MAX_UNIT_ITEMS (8) bites first, so
     * eight unit items always survive MAX_PLAN_ITEMS (40) and the filter never
     * fires — the assertion passed with the filter replaced by `() => true`.
     *
     * To make the plan cap bite on a unit item it has to be OUTRANKED: forty
     * guarded routes are CRITICAL_PATH, a date-arithmetic helper is IMPORTANT,
     * and the unit items land below the cut. A subject left behind here would
     * have the generator fetch a module's source, fence it and fingerprint it
     * for a row that is not on the approval screen.
     */
    const crowded = parseCodebaseAnalysis({
      routes: Array.from({ length: MAX_PLAN_ITEMS }, (_unused, index) => ({
        path: `/page-${index}`,
        file: `app/page-${index}/page.tsx`,
        behindAuth: true,
        authEvidence: 'middleware matcher',
      })),
      components: [
        {
          ...moneyComponent,
          exportName: 'nextRenewalDate',
          modulePath: 'src/schedule/renewal.ts',
          propsSummary: 'props: startedAt',
        },
      ],
    })!;
    const derived = scenariosFromSource(crowded, allTypes(['SMOKE', 'UNIT_GEN']));

    expect(derived.items).toHaveLength(MAX_PLAN_ITEMS);
    expect(
      derived.items.some((item) => item.testType === 'UNIT_GEN'),
      'the unit item was deferred by the plan cap',
    ).toBe(false);
    expect(derived.unitSubjects).toEqual([]);
  });

  it('proposes nothing at all when UNIT_GEN was not asked for', () => {
    const derived = scenariosFromSource(withComponents([moneyComponent]), allTypes(['SMOKE']));
    expect(derived.items.every((item) => item.testType !== 'UNIT_GEN')).toBe(true);
    expect(derived.unitSubjects).toEqual([]);
  });

  it('is requestable, and is not in the no-preference default', () => {
    // Derivable, so a stored request for it is honoured rather than refused...
    expect(resolveTestTypeChoice(['UNIT_GEN']).types).toEqual(['UNIT_GEN']);
    // ...and absent from the default, because it needs a materialised checkout
    // to execute and a model to write. Both are honest outcomes for a type
    // somebody asked for and neither is an acceptable surprise.
    expect(DEFAULT_TEST_TYPES).not.toContain('UNIT_GEN');
  });
});

describe('the processor on a plan that carries unit items', () => {
  beforeEach(() => {
    h.events = [];
    h.generated = [];
    h.apiKey = '';
  });

  /** A project that asked for unit tests, with the inventory on the row. */
  const unitProject = () => ({
    id: 'p1',
    codebaseAnalysis: rawAnalysis,
    testTypePreference: ['UNIT_GEN'],
  });

  const skipsOf = (recorded: ReturnType<typeof stubPrisma>): Array<{ what: string; why: string }> =>
    (recorded.plans[0] as { skipped: Array<{ what: string; why: string }> }).skipped;

  it('says the existing-test check was not made when no path list was recorded', async () => {
    const recorded = stubPrisma(unitProject(), { id: 'e1', baseUrl: 'https://shop.example' });
    // `stubPrisma`'s snapshot carries no `paths`, which is exactly the
    // production state for a project ingested before the column was populated.
    await processAnalyzeSource(job(), { loadAnalysedPaths: async () => null });

    const skips = skipsOf(recorded);
    // The lie this prevents: a unit item that silently reads as "this function
    // has no tests" when nobody looked for one.
    const entry = skips.find((s) => /already have tests/.test(s.what));
    expect(entry, JSON.stringify(skips.map((s) => s.what))).toBeDefined();
    expect(entry!.why).toMatch(/recorded no file list/);
    expect(entry!.why).toMatch(/may duplicate a test you already have/);
  });

  it('does not say it when the path list WAS read', async () => {
    const recorded = stubPrisma(unitProject(), { id: 'e1', baseUrl: 'https://shop.example' });
    await processAnalyzeSource(job(), {
      loadAnalysedPaths: async () => ['src/billing/pricing.ts', 'src/billing/pricing.test.ts'],
    });

    // Never a standing nag: the sentence reaches the plan only when it bites.
    expect(skipsOf(recorded).some((s) => /already have tests/.test(s.what))).toBe(false);
  });

  it('says the function\'s source was not read, rather than leaving it implied', async () => {
    const recorded = stubPrisma(unitProject(), { id: 'e1', baseUrl: 'https://shop.example' });
    // No `openWorkspace`, which is every production caller today: this
    // processor runs on an UPLOAD, before any run has materialised anything.
    await processAnalyzeSource(job(), { loadAnalysedPaths: async () => [] });

    const entry = skipsOf(recorded).find((s) => /Reading the source of/.test(s.what));
    expect(entry).toBeDefined();
    expect(entry!.why).toMatch(/no checkout of your repository was available/);
    expect(entry!.why).toMatch(/parameter NAMES/);
    // And it must not be read as a fact about the customer's code.
    expect(entry!.why).toMatch(/never about what the function computes/);
  });

  it('stops saying it once a checkout IS available', async () => {
    const recorded = stubPrisma(unitProject(), { id: 'e1', baseUrl: 'https://shop.example' });
    await processAnalyzeSource(job(), {
      loadAnalysedPaths: async () => [],
      // The injected reader — no disk, no network, no checkout. The seam is
      // what makes this provable at all.
      openWorkspace: async () => ({
        read: async (relPath: string) =>
          relPath === 'src/billing/pricing.ts'
            ? { kind: 'FILE' as const, text: 'export const priceCart = (items) => items.length;' }
            : { kind: 'ABSENT' as const },
      }),
    });

    expect(skipsOf(recorded).some((s) => /Reading the source of/.test(s.what))).toBe(false);
  });
});

describe('the default path-list loader', () => {
  beforeEach(() => {
    h.events = [];
    h.generated = [];
    h.apiKey = '';
  });

  const unitProject = () => ({ id: 'p1', testTypePreference: ['UNIT_GEN'] });

  const skipsOf = (recorded: ReturnType<typeof stubPrisma>): Array<{ what: string; why: string }> =>
    (recorded.plans[0] as { skipped: Array<{ what: string; why: string }> }).skipped;

  /*
   * These run the DEFAULT loader — no `loadAnalysedPaths` dep — because that is
   * where the null-versus-`[]` decision actually lives. Injecting the dep in
   * every test left the default free to return `[]` for an unreadable column,
   * and a mutation doing exactly that survived: the plan then stops saying the
   * existing-test check was not made, and every unit item quietly reads as
   * "this function has no tests".
   */
  it('reads a recorded path list off the snapshot and matches a test file to a module', async () => {
    const recorded = stubPrisma(
      unitProject(),
      { id: 'e1', baseUrl: 'https://shop.example' },
      { analysis: rawAnalysis, paths: ['src/billing/pricing.ts', 'src/billing/pricing.test.ts'] },
    );
    await processAnalyzeSource(job());

    const items = (recorded.plans[0] as { items: { create: PlanItem[] } }).items.create;
    const unit = items.find((item) => item.testType === 'UNIT_GEN');
    expect(unit, 'a unit item was proposed').toBeDefined();
    expect(unit!.rationale).toContain('src/billing/pricing.test.ts');
    expect(skipsOf(recorded).some((s) => /already have tests/.test(s.what))).toBe(false);
  });

  it('answers NULL for an unreadable column, so the plan says nobody looked', async () => {
    const recorded = stubPrisma(
      unitProject(),
      { id: 'e1', baseUrl: 'https://shop.example' },
      // Not an array: a snapshot written by an older ingest. `[]` here would
      // read as "the ingest looked and the repository has no files".
      { analysis: rawAnalysis, paths: { nope: true } },
    );
    await processAnalyzeSource(job());

    expect(skipsOf(recorded).some((s) => /already have tests/.test(s.what))).toBe(true);
  });

  it('asks Postgres for the paths column by name', async () => {
    /*
     * `stubPrisma`'s `findFirst` ignores `select` and returns the whole stub
     * object, so a loader that selected the wrong column still read the right
     * value from the double — a mutation changing `select: { paths: true }` to
     * `{ id: true }` survived every test above. In production that select is
     * the query, and a column left out of it comes back undefined.
     */
    const selects: unknown[] = [];
    stubPrisma(
      unitProject(),
      { id: 'e1', baseUrl: 'https://shop.example' },
      { analysis: rawAnalysis, paths: ['src/billing/pricing.ts'] },
    );
    const snapshots = (h.prisma as { codebaseSnapshot: { findFirst: (a: unknown) => unknown } })
      .codebaseSnapshot;
    const passthrough = snapshots.findFirst;
    snapshots.findFirst = (args: unknown) => {
      selects.push((args as { select?: unknown }).select);
      return passthrough(args);
    };

    await processAnalyzeSource(job());
    expect(selects).toContainEqual({ paths: true });
  });

  it('answers NULL for an empty column too, for the same reason', async () => {
    const recorded = stubPrisma(
      unitProject(),
      { id: 'e1', baseUrl: 'https://shop.example' },
      { analysis: rawAnalysis, paths: [] },
    );
    await processAnalyzeSource(job());

    // A repository with no files is not a thing that happens, so an empty
    // column is a column nobody populated.
    expect(skipsOf(recorded).some((s) => /already have tests/.test(s.what))).toBe(true);
  });
});
