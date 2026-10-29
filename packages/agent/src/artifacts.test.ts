import { describe, expect, it } from 'vitest';
import { SECRET_SHAPES } from '@qaai/shared';
import {
  ARTIFACT_PLAN_PROBLEMS,
  FIXTURE_RENDERERS,
  MAX_DATASET_CASES,
  MAX_PAGE_OBJECTS_PER_SET,
  PATH_SOURCES,
  PATH_SOURCE_IS_THEIR_CONVENTION,
  PLAN_PROBLEM_BLOCKS,
  ROLE_HAS_MEMBER_SURFACE,
  ROLE_SUBDIRECTORY,
  applyNaming,
  artifactBriefing,
  buildDataset,
  datasetSecrets,
  declaredArtifactSet,
  dependentCalls,
  directoryForRole,
  exportedNamesOf,
  findReusablePageObject,
  memberNamesOf,
  memberSurfaceChange,
  moduleSpecifier,
  pageObjectClassName,
  planArtifacts,
  resolveAgainstRepository,
  reuseKey,
  type ArtifactRepository,
  type DiskState,
} from './artifacts.js';
import { ECOSYSTEM_IDS, ECOSYSTEMS, type EcosystemId } from './ecosystem-prompts.js';
import type { PageSource } from './page-objects.js';
import { datasetSchema } from '@qaai/shared';
import type { FormModel, PlanItem, Selector } from '@qaai/shared';
import {
  ARTIFACT_ROLES,
  artifactSetProblems,
  mayWriteDirectly,
  sharedSurfaceChange,
  type ArtifactLedgerEntry,
} from '@qaai/shared';
import {
  emptyStyleProfile,
  observed,
  type NamingConvention,
  type StyleProfile,
} from '@qaai/shared';

/**
 * ── What these tests are for ────────────────────────────────────────────────
 *
 * The planner's failure modes are not "it produced the wrong file name". They
 * are: it overwrote somebody's work, it minted a second page object for one
 * page, it changed a shared file and broke three specs, or it committed a
 * secret as test data. Each of those has its own describe below, and each
 * asserts on the REFUSAL rather than on the happy path — because a planner that
 * refuses nothing is the `pushRepo` defect with more files.
 *
 * Two of them end at a validator rather than at a spelling, which is the rule
 * this repo learned the expensive way: a test over a producer must end at the
 * layer the write path actually runs. The set the planner declares is pushed
 * through `artifactSetProblems`, and the dataset it writes is pushed through
 * `datasetSchema` — the same two functions the real write path calls.
 */

const sel = (over: Partial<Selector> = {}): Selector => ({
  strategy: 'ROLE',
  value: 'button',
  name: 'Add to cart',
  confidence: 0.95,
  ...over,
});

const item: PlanItem = {
  id: 'item-1',
  title: 'Adds an item to the cart',
  rationale: 'The money path.',
  feature: 'Checkout',
  priority: 'CRITICAL_PATH',
  testType: 'E2E',
  steps: ['Open the cart', 'Add an item'],
  assertions: ['The cart shows one item'],
  journeyId: null,
  authProfileId: null,
};

const form = (over: Partial<FormModel> = {}): FormModel => ({
  id: 'signup',
  name: 'Sign up',
  selector: { strategy: 'CSS', value: 'form#signup', confidence: 0.5 },
  fields: [
    {
      name: 'email',
      label: 'Email address',
      inputType: 'email',
      required: true,
      semantic: 'email',
      selector: { strategy: 'LABEL', value: 'Email address', confidence: 0.9 },
    },
  ],
  submit: sel({ name: 'Create account' }),
  ...over,
});

const page = (route: string, over: Partial<PageSource> = {}): PageSource => ({
  route,
  affordances: [{ label: 'Add to cart', kind: 'button', selector: sel() }],
  forms: [],
  navigations: [],
  ...over,
});

const ledgerEntry = (over: Partial<ArtifactLedgerEntry> = {}): ArtifactLedgerEntry => ({
  path: 'e2e/pages/cart.page.ts',
  role: 'PAGE_OBJECT',
  ownership: 'QAAI_OWNED',
  contentHash: 'h-cart-1',
  imports: [],
  ...over,
});

/**
 * A repository with a Map for a working tree.
 *
 * `digest` is `length:firstChar`, which is enough to distinguish the bytes this
 * suite uses and short enough to assert on. A real digest would be
 * `node:crypto`, which is why `ContentDigest` is injected in the first place.
 */
function repository(over: {
  readonly ledger?: readonly ArtifactLedgerEntry[];
  readonly disk?: Record<string, string>;
  readonly unreadable?: readonly string[];
} = {}): ArtifactRepository {
  const disk = over.disk ?? {};
  const unreadable = new Set(over.unreadable ?? []);
  return {
    ledger: over.ledger ?? [],
    diskStateAt: (path): DiskState => {
      if (unreadable.has(path)) return { state: 'UNREADABLE', why: 'EACCES' };
      const content = disk[path];
      return content === undefined ? { state: 'ABSENT' } : { state: 'PRESENT', content };
    },
    filesUnder: (directory) =>
      Object.keys(disk).filter(
        (path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/'),
      ),
    digest: (input) => `${input.length}:${input.slice(0, 1)}`,
  };
}

function profileWith(over: Partial<StyleProfile> = {}): StyleProfile {
  return { ...emptyStyleProfile(), filesRead: 20, ...over };
}

const theirLayout = profileWith({
  fileLayout: observed({
    value: { root: 'e2e/specs', filename: '{name}.spec.ts', colocated: false },
    filesSeen: 18,
    filesConsidered: 20,
  }),
  naming: observed({ value: 'KEBAB', filesSeen: 18, filesConsidered: 20 }),
});

const plan = (over: Partial<Parameters<typeof planArtifacts>[0]> = {}) =>
  planArtifacts({
    item,
    profile: theirLayout,
    ecosystemId: 'PLAYWRIGHT_TS',
    pages: [page('/cart')],
    repository: repository(),
    seed: 'run-1',
    ...over,
  });

const kinds = (problems: readonly { kind: string }[]): string[] => problems.map((p) => p.kind);

describe('vocabulary parity: the run-time half', () => {
  it('PATH_SOURCE_IS_THEIR_CONVENTION decides every source, and the ecosystem ones are ours', () => {
    expect(Object.keys(PATH_SOURCE_IS_THEIR_CONVENTION).sort()).toEqual([...PATH_SOURCES].sort());
    const ours = Object.entries(PATH_SOURCE_IS_THEIR_CONVENTION)
      .filter(([, theirs]) => !theirs)
      .map(([source]) => source)
      .sort();
    /*
     * TWO sources are ours, not one, and the second is the interesting one:
     * `ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE` is the directory QAAI chose
     * after READING their layout and refusing to follow it, so reporting it as
     * their convention would claim a layout match that was deliberately not
     * made. Still an exact list: a measured source that turned up here would
     * mean a guess was about to be reported as a measurement.
     */
    expect(ours).toEqual(['ECOSYSTEM_DEFAULT', 'ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE']);
  });

  it.each([
    ['ROLE_SUBDIRECTORY', ROLE_SUBDIRECTORY],
    ['ROLE_HAS_MEMBER_SURFACE', ROLE_HAS_MEMBER_SURFACE],
  ])('%s is keyed on exactly the artifact roles', (_name, record) => {
    expect(Object.keys(record).sort()).toEqual([...ARTIFACT_ROLES].sort());
  });

  it('PLAN_PROBLEM_BLOCKS decides every problem, and exactly one does not block', () => {
    expect(Object.keys(PLAN_PROBLEM_BLOCKS).sort()).toEqual([...ARTIFACT_PLAN_PROBLEMS].sort());
    const warnings = Object.entries(PLAN_PROBLEM_BLOCKS)
      .filter(([, blocks]) => !blocks)
      .map(([kind]) => kind);
    // The one decision that could have gone the other way: importing a page
    // object we cannot parse beats minting a second one for the same page.
    expect(warnings).toEqual(['REUSE_SURFACE_UNREADABLE']);
  });

  it('every ecosystem has a decision about whether it gets a fixture', () => {
    expect(Object.keys(FIXTURE_RENDERERS).sort()).toEqual([...ECOSYSTEM_IDS].sort());
  });

  it('the page-object cap leaves room for the spec, the fixture and the dataset', () => {
    // Derived rather than written, so the two numbers cannot drift: a tenth
    // page object would push the set past MAX_ARTIFACTS_PER_SET and be refused
    // with SET_SIZE, which reads as a mystery rather than as a cap.
    const biggest = plan({
      pages: Array.from({ length: MAX_PAGE_OBJECTS_PER_SET + 4 }, (_unused, index) =>
        page(`/page-${index}`, { forms: [form({ id: `f${index}` })] }),
      ),
    });
    expect(biggest.artifacts.filter((a) => a.role === 'PAGE_OBJECT')).toHaveLength(
      MAX_PAGE_OBJECTS_PER_SET,
    );
    expect(kinds(biggest.problems)).not.toContain('SET_TOO_LARGE');
    expect(
      biggest.omitted.find((omission) => omission.what.includes('page-object cap')),
    ).toMatchObject({ count: 4 });
  });
});

describe('the paths are theirs, not ours', () => {
  it('uses the directory the ledger already puts this role in, over the profile', () => {
    const decision = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: theirLayout,
      ledger: [ledgerEntry({ path: 'support/page_objects/cart.ts' })],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });
    expect(decision).toEqual({ directory: 'support/page_objects', source: 'LEDGER_SIBLING' });
    expect(PATH_SOURCE_IS_THEIR_CONVENTION[decision.source]).toBe(true);
  });

  it('falls back to the style profile, then to the ecosystem, and says which', () => {
    const fromProfile = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: theirLayout,
      ledger: [],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });
    expect(fromProfile).toEqual({ directory: 'e2e/specs/pages', source: 'STYLE_PROFILE' });

    const fromEcosystem = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: profileWith(),
      ledger: [],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });
    expect(fromEcosystem.source).toBe('ECOSYSTEM_DEFAULT');
    // And this one is a guess, which the record says out loud.
    expect(PATH_SOURCE_IS_THEIR_CONVENTION[fromEcosystem.source]).toBe(false);
  });

  /*
   * ── A LEARNED OR RECORDED ROOT IS EVIDENCE, NEVER PERMISSION ──────────────
   *
   * Both branches above used to be followed unconditionally, and the
   * consequence was reproduced end to end rather than imagined: `learnStyle`
   * over four files at `.github/workflows/tests/*` left
   * `fileLayout.root = ".github/workflows/tests"` at MEDIUM confidence, which
   * `CONFIDENCE_IS_USABLE` calls usable, and this function returned
   * `.github/workflows/tests/pages` for a PAGE_OBJECT — a destination the same
   * `destinationDecision` the admission gate consults REFUSES, asked by nobody
   * on this path.
   *
   * The learner now skips those files, so the profile below is hand-built
   * deliberately: a `Project.styleProfile` computed before that guard existed
   * is still in the database, and a profile is not re-derived on read. This is
   * the second line of the same defence, and it has to hold on its own.
   */
  const poisonedProfile = profileWith({
    fileLayout: observed({
      value: { root: 'node_modules/@acme/suite', filename: '{name}.spec.ts', colocated: false },
      filesSeen: 18,
      filesConsidered: 20,
    }),
  });

  it('discards a profile root it may never write into, and does not report it as their convention', () => {
    const decision = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: poisonedProfile,
      ledger: [],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });

    expect(decision.directory).not.toContain('node_modules');
    expect(decision.directory).toBe('checkout/pages');
    /*
     * AND THE FALL-THROUGH IS DISCLOSED. `ECOSYSTEM_DEFAULT` would say "nobody
     * measured this repository", which is false and is the sentence a reviewer
     * would trust: a layout WAS measured and QAAI refused to follow it.
     */
    expect(decision.source).toBe('ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE');
    expect(PATH_SOURCE_IS_THEIR_CONVENTION[decision.source]).toBe(false);
  });

  /*
   * THE LEDGER SIBLING IS GUARDED TOO, and that is not belt-and-braces: a
   * ledger row is a RECORDED fact, which is exactly what rule 11 says ownership
   * must be — and a recorded row pointing into a cache is still a row QAAI must
   * not follow. The ledger branch runs FIRST, so an unguarded one would win
   * over the guarded profile branch below it.
   */
  it('discards a ledger sibling it may never write into, even though the ledger is the strongest signal', () => {
    const decision = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: theirLayout,
      ledger: [ledgerEntry({ path: 'packages/web/.cache/pages/cart.page.ts' })],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });

    expect(decision.directory).not.toContain('.cache');
    // The profile is clean here, so the refusal falls through to IT and not to
    // the ecosystem — a refused row must not also discard a usable profile.
    expect(decision).toEqual({ directory: 'e2e/specs/pages', source: 'STYLE_PROFILE' });
  });

  it('still follows a clean profile root, so the guard is not a blanket refusal', () => {
    const decision = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: theirLayout,
      ledger: [],
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });
    expect(decision).toEqual({ directory: 'e2e/specs/pages', source: 'STYLE_PROFILE' });
  });

  it('breaks a tie between two ledger directories the same way on every run', () => {
    const ledger = [
      ledgerEntry({ path: 'zzz/cart.page.ts' }),
      ledgerEntry({ path: 'aaa/checkout.page.ts' }),
    ];
    const forward = directoryForRole({ role: 'PAGE_OBJECT', profile: theirLayout, ledger, ecosystemId: 'PLAYWRIGHT_TS', item });
    const reversed = directoryForRole({
      role: 'PAGE_OBJECT',
      profile: theirLayout,
      ledger: [...ledger].reverse(),
      ecosystemId: 'PLAYWRIGHT_TS',
      item,
    });
    expect(forward.directory).toBe('aaa');
    expect(reversed).toEqual(forward);
  });

  it('re-cases the stem and keeps the marker the runner collects by', () => {
    /*
     * THE DEFECT THIS PINS, and it ends at the real validator rather than at a
     * spelling: pytest collects `test_*.py` and nothing else, Go needs
     * `*_test.go`, RSpec needs `*_spec.rb`. A planner that applied a
     * repository's PascalCase convention to the whole file name would produce
     * a file the runner never collects — and admission.ts's PATH_CONVENTION
     * gate calls that a suite that goes green over a file nobody executed. So
     * every combination is checked against `ecosystem.filePattern`, which is
     * the pattern that gate uses.
     */
    const ecosystems: EcosystemId[] = [
      'PLAYWRIGHT_TS',
      'PLAYWRIGHT_PYTHON',
      'PYTEST',
      'GO_TEST',
      'RSPEC',
      'JUNIT5',
      'PHPUNIT',
    ];
    const conventions: NamingConvention[] = ['KEBAB', 'SNAKE', 'CAMEL', 'PASCAL', 'DOTTED', 'MIXED'];
    for (const ecosystemId of ecosystems) {
      for (const naming of conventions) {
        const result = plan({
          ecosystemId,
          profile: profileWith({ naming: observed({ value: naming, filesSeen: 18, filesConsidered: 20 }) }),
        });
        expect(
          ECOSYSTEMS[ecosystemId].filePattern.test(result.specPath),
          `${ecosystemId} + ${naming} produced ${result.specPath}, which its runner does not collect`,
        ).toBe(true);
      }
    }
  });

  it('discloses the naming convention it could not apply, rather than applying it or skipping it', () => {
    /*
     * The other half of the rule above. pytest's collection marker lives INSIDE
     * the stem, so a kebab-case repository cannot have it: `test-adds-...py` is
     * not collected. The runner wins, and the convention that lost is reported
     * as a count and a reason — a cap applied without being disclosed is one of
     * the lies this product cannot afford, and so is a convention silently
     * dropped.
     */
    const kebabPython = plan({
      ecosystemId: 'PLAYWRIGHT_PYTHON',
      profile: profileWith({ naming: observed({ value: 'KEBAB', filesSeen: 18, filesConsidered: 20 }) }),
    });
    expect(kebabPython.specPath).toBe('tests/checkout/test_adds_an_item_to_the_cart.py');
    const omission = kebabPython.omitted.find((entry) => entry.what.includes('file naming'));
    expect(omission).toMatchObject({ count: 1 });
    expect(omission?.why).toContain(ECOSYSTEMS.PLAYWRIGHT_PYTHON.pathRule);

    // And a repository whose convention the runner can live with gets it.
    const snakePython = plan({
      ecosystemId: 'PLAYWRIGHT_PYTHON',
      profile: profileWith({ naming: observed({ value: 'SNAKE', filesSeen: 18, filesConsidered: 20 }) }),
    });
    expect(snakePython.omitted.find((entry) => entry.what.includes('file naming'))).toBeUndefined();
  });

  it('applies the repository’s naming to the stem', () => {
    expect(applyNaming('orders-id', 'SNAKE')).toBe('orders_id');
    expect(applyNaming('orders-id', 'PASCAL')).toBe('OrdersId');
    expect(applyNaming('orders-id', 'CAMEL')).toBe('ordersId');
    expect(applyNaming('orders-id', 'DOTTED')).toBe('orders.id');
  });

  it('leaves the stem alone when there is no majority, and when nothing was measured', () => {
    // MIXED is a real answer: there is no convention to match, so matching one
    // of the two would be wrong half the time.
    expect(applyNaming('orders-id', 'MIXED')).toBe('orders-id');
    expect(applyNaming('orders-id', null)).toBe('orders-id');
  });

  it('puts the dataset and the fixture under a fixtures directory inside their root', () => {
    const result = plan({ pages: [page('/cart', { forms: [form()] })] });
    const paths = Object.fromEntries(result.artifacts.map((a) => [a.role, a.path]));
    expect(paths.DATASET).toMatch(/^e2e\/specs\/fixtures\//);
    expect(paths.FIXTURE).toBe('e2e/specs/fixtures/setup/pages.fixture.ts');
    expect(paths.PAGE_OBJECT).toBe('e2e/specs/pages/cart.page.ts');
  });
});

describe('a second page object for one page is worse than none', () => {
  it('collapses the four spellings of one page object onto one key', () => {
    const keys = [
      'cart.page.ts',
      'CartPage.java',
      'cart_page.py',
      'cart.ts',
      '/cart',
      'cart-page-object.ts',
    ].map(reuseKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('cart');
  });

  it('imports the human’s page object rather than minting a rival', () => {
    const result = plan({
      repository: repository({
        disk: { 'e2e/specs/pages/CartPage.ts': 'export class CartPage {\n  async addToCart() {}\n}\n' },
      }),
    });
    expect(result.artifacts.filter((a) => a.role === 'PAGE_OBJECT')).toHaveLength(0);
    expect(result.reused).toHaveLength(1);
    expect(result.reused[0]).toMatchObject({
      path: 'e2e/specs/pages/CartPage.ts',
      basis: 'REPOSITORY_FILE',
      // Found by name, so the ledger has never seen it — and UNRECORDED is not
      // writable, which is exactly why it is imported and not replaced.
      ownership: 'UNRECORDED',
      exportedNames: ['CartPage'],
    });
  });

  it('imports a page object a human has taken over from us, and never writes it', () => {
    const result = plan({
      repository: repository({
        ledger: [ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', ownership: 'HUMAN_EDITED' })],
        disk: { 'e2e/specs/pages/cart.page.ts': 'export class CartPage {}\n' },
      }),
    });
    expect(result.artifacts.filter((a) => a.role === 'PAGE_OBJECT')).toHaveLength(0);
    expect(result.reused[0]).toMatchObject({ ownership: 'HUMAN_EDITED', basis: 'LEDGER_ROW' });
  });

  it('UPDATES a page object the ledger records as ours, rather than freezing it', () => {
    /*
     * The other half of the rule, and the one that is easy to get backwards: a
     * page object QAAI owns must take the controls the crawl just found, or the
     * file drifts from the application it describes and the suite stops being
     * able to reach anything new.
     */
    const result = plan({
      repository: repository({
        ledger: [ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', ownership: 'QAAI_OWNED' })],
        disk: { 'e2e/specs/pages/cart.page.ts': 'export class CartPage {}\n' },
      }),
    });
    expect(result.reused).toHaveLength(0);
    const pageObject = result.artifacts.find((a) => a.role === 'PAGE_OBJECT');
    // In place: a move is a delete plus a write, and nothing here may delete.
    expect(pageObject?.path).toBe('e2e/specs/pages/cart.page.ts');
    expect(pageObject?.content).toContain('addToCartButton');
  });

  it('reports a reused page object whose exports could not be read, and does not block on it', () => {
    const result = plan({
      repository: repository({
        disk: { 'e2e/specs/pages/cart.page.ts': 'this file has no export form a scanner knows\n' },
      }),
    });
    expect(kinds(result.problems)).toEqual(['REUSE_SURFACE_UNREADABLE']);
    expect(result.reused[0]?.exportedNames).toEqual([]);
    // Not a block: minting a second page object for one page is worse.
    expect(result.plannable).toBe(true);
    expect(artifactBriefing(result)).toContain('could not be read');
  });

  it('asks for the human\u2019s file to be recorded as theirs, and the set then resolves', () => {
    /*
     * FOUND BY PUSHING THE PLAN THROUGH THE REAL VALIDATOR rather than by
     * reading it. `artifactSetProblems` resolves an import against the set or
     * the LEDGER, so a spec importing a human's page object — a file that
     * plainly exists and is in neither — is refused with UNRESOLVED_IMPORT.
     *
     * The fix is not a change to the keystone: `HUMAN_AUTHORED` is the member
     * it already describes for "QAAI does not own this, as a FACT rather than
     * the absence of a fact". So the plan ASKS for that row, and with the row
     * present the import resolves and the later run cannot mistake the file for
     * a free path to claim.
     */
    const theirPath = 'e2e/specs/pages/CartPage.ts';
    const content = 'export class CartPage {}\n';
    const bare = repository({ disk: { [theirPath]: content } });
    const first = plan({ repository: bare });
    expect(first.recordAsTheirs).toEqual([theirPath]);
    expect(first.artifacts.find((a) => a.role === 'SPEC')?.imports).toContain(theirPath);

    const resolveWith = (repo: ArtifactRepository) =>
      resolveAgainstRepository({
        set: declaredArtifactSet({
          plan: plan({ repository: repo }),
          specCode: "import { CartPage } from './pages/CartPage';\ntest('t', () => {});\n",
          dialect: 'JS_EXPECT',
        }),
        repository: repo,
      });

    const withoutRow = resolveWith(bare);
    expect(
      kinds(artifactSetProblems(withoutRow.set, { ledger: bare.ledger })),
    ).toContain('UNRESOLVED_IMPORT');

    const recorded = repository({
      ledger: [
        ledgerEntry({ path: theirPath, ownership: 'HUMAN_AUTHORED', contentHash: 'theirs' }),
        ...withoutRow.reservations.map((reservation) =>
          ledgerEntry({ path: reservation.path, role: reservation.role, ownership: 'QAAI_OWNED', contentHash: 'unused' }),
        ),
      ],
      disk: { [theirPath]: content },
    });
    const withRow = resolveWith(recorded);
    expect(withRow.applyable).toBe(true);
    expect(
      artifactSetProblems(withRow.set, {
        ledger: recorded.ledger,
        priorContent: (path) => {
          const state = recorded.diskStateAt(path);
          return state.state === 'PRESENT' ? state.content : null;
        },
      }),
    ).toEqual([]);
    // And their file is still theirs: nothing in the set writes to it.
    expect(withRow.set.artifacts.map((a) => a.path)).not.toContain(theirPath);
    expect(plan({ repository: recorded }).recordAsTheirs).toEqual([]);
  });

  it('picks between two candidate files in one directory the same way on every run', () => {
    const disk = {
      'e2e/specs/pages/CartPage.ts': 'export class CartPage {}\n',
      'e2e/specs/pages/cart.page.ts': 'export class Cart {}\n',
    };
    const first = findReusablePageObject({ route: '/cart', directory: 'e2e/specs/pages', repository: repository({ disk }) });
    const again = findReusablePageObject({
      route: '/cart',
      directory: 'e2e/specs/pages',
      repository: repository({ disk: { ...disk } }),
    });
    expect(first?.path).toBe('e2e/specs/pages/CartPage.ts');
    expect(again?.path).toBe(first?.path);
  });

  it('exportedNamesOf reads a file’s surface with the same scanner the refusal uses', () => {
    expect([...exportedNamesOf('export class CartPage {}\nexport const helper = 1;\n')].sort()).toEqual([
      'CartPage',
      'helper',
    ]);
    // Empty IS unreadable, and the caller has to treat it as such.
    expect(exportedNamesOf('nothing here\n')).toEqual([]);
  });
});

describe('two artifacts at one path is an error, not a last-one-wins', () => {
  it('refuses two routes that reduce to one file name', () => {
    const result = plan({ pages: [page('/user-profile'), page('/user_profile')] });
    expect(kinds(result.problems)).toContain('PATH_COLLISION');
    expect(result.plannable).toBe(false);
    // Both are still listed: the plan is refused rather than silently deduped,
    // so a human can see which two pages collided.
    expect(result.artifacts.filter((a) => a.role === 'PAGE_OBJECT')).toHaveLength(2);
  });

  it('does not refuse two routes that reduce to two file names', () => {
    const result = plan({ pages: [page('/user-profile'), page('/team-profile')] });
    expect(kinds(result.problems)).not.toContain('PATH_COLLISION');
    expect(result.plannable).toBe(true);
  });
});

describe('ownership: a write to a file QAAI does not own is a proposal', () => {
  const set = (repo: ArtifactRepository) =>
    resolveAgainstRepository({
      set: declaredArtifactSet({
        plan: plan({ repository: repo }),
        specCode: "import { test } from './x';\ntest('t', () => {});\n",
        dialect: 'JS_EXPECT',
      }),
      repository: repo,
    });

  it('proposes rather than writes over a file a human authored', () => {
    const repo = repository({
      ledger: [
        ledgerEntry({
          path: 'e2e/specs/adds-an-item-to-the-cart.spec.ts',
          role: 'SPEC',
          ownership: 'HUMAN_AUTHORED',
          contentHash: 'h-theirs',
        }),
      ],
      disk: { 'e2e/specs/adds-an-item-to-the-cart.spec.ts': 'their test\n' },
    });
    const resolved = set(repo);
    const spec = resolved.set.artifacts.find((a) => a.role === 'SPEC')!;
    expect(spec).toMatchObject({ disposition: 'PROPOSED_EDIT', ownership: 'HUMAN_AUTHORED' });
    expect(mayWriteDirectly(spec)).toBe(false);
    // The bytes the proposal was computed against, so a human sees a diff
    // against what is actually there.
    expect(spec.basedOnHash).toBe(repo.digest('their test\n'));
  });

  it('downgrades its own file to a proposal once the bytes stop matching the ledger', () => {
    const repo = repository({
      ledger: [ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', contentHash: 'h-we-wrote-this' })],
      disk: { 'e2e/specs/pages/cart.page.ts': 'a human changed this\n' },
    });
    const resolved = set(repo);
    const pageObject = resolved.set.artifacts.find((a) => a.role === 'PAGE_OBJECT')!;
    expect(pageObject.disposition).toBe('PROPOSED_EDIT');
    expect(mayWriteDirectly(pageObject)).toBe(false);
  });

  it('updates its own file in place while the bytes still match', () => {
    const content = 'export class CartPage {}\n';
    const repo = repository({
      ledger: [
        ledgerEntry({
          path: 'e2e/specs/pages/cart.page.ts',
          contentHash: `${content.length}:${content.slice(0, 1)}`,
        }),
      ],
      disk: { 'e2e/specs/pages/cart.page.ts': content },
    });
    const resolved = set(repo);
    const pageObject = resolved.set.artifacts.find((a) => a.role === 'PAGE_OBJECT')!;
    expect(pageObject).toMatchObject({ disposition: 'UPDATE_OWNED', ownership: 'QAAI_OWNED' });
    expect(mayWriteDirectly(pageObject)).toBe(true);
    // The optimistic-concurrency token is the LEDGER'S hash, which is what
    // `artifactSetProblems` compares against.
    expect(pageObject.basedOnHash).toBe(`${content.length}:${content.slice(0, 1)}`);
  });

  it('asks for a reservation rather than granting itself a write, and the reserved set applies', () => {
    /*
     * THE END-TO-END TEST, and it ends at the validator the real write path
     * runs rather than at a spelling.
     *
     * A path holding nothing that nobody recorded is NOT writable — UNRECORDED
     * is not writable, which is the whole of `WRITABLE_BY_OWNERSHIP`. So the
     * planner asks for a row and reports that it cannot apply yet. Record the
     * rows, resolve again, and `artifactSetProblems` — with the real ledger and
     * the real working tree — returns NOTHING.
     */
    const empty = repository();
    const first = set(empty);
    expect(first.applyable).toBe(false);
    expect(first.reservations.map((reservation) => reservation.path).sort()).toEqual(
      first.set.artifacts.map((a) => a.path).sort(),
    );
    for (const artifact of first.set.artifacts) {
      expect(artifact.disposition).toBe('PROPOSED_EDIT');
    }

    const reserved = repository({
      ledger: first.reservations.map((reservation) =>
        ledgerEntry({ path: reservation.path, role: reservation.role, ownership: 'QAAI_OWNED', contentHash: 'unused' }),
      ),
    });
    const second = resolveAgainstRepository({
      set: declaredArtifactSet({
        plan: plan({ repository: reserved }),
        specCode: "import { test } from './x';\ntest('t', () => {});\n",
        dialect: 'JS_EXPECT',
      }),
      repository: reserved,
    });
    expect(second.reservations).toEqual([]);
    expect(second.applyable).toBe(true);
    for (const artifact of second.set.artifacts) {
      expect(artifact).toMatchObject({ disposition: 'NEW', ownership: 'QAAI_OWNED' });
      expect(mayWriteDirectly(artifact)).toBe(true);
    }
    expect(
      artifactSetProblems(second.set, {
        ledger: reserved.ledger,
        priorContent: () => null,
      }),
    ).toEqual([]);
  });

  it('never reads a file it could not open as an empty one', () => {
    const repo = repository({ unreadable: ['e2e/specs/pages/cart.page.ts'] });
    const resolved = set(repo);
    expect(kinds(resolved.problems)).toContain('DISK_UNREADABLE');
    expect(resolved.applyable).toBe(false);
    const pageObject = resolved.set.artifacts.find((a) => a.role === 'PAGE_OBJECT')!;
    expect(pageObject.disposition).toBe('PROPOSED_EDIT');
    // No base hash, because there are no bytes to base on — and that is itself
    // the correct refusal, which the keystone states as MISSING_BASE_HASH.
    expect(pageObject.basedOnHash).toBeNull();
    expect(kinds(artifactSetProblems(resolved.set, { ledger: repo.ledger }))).toContain(
      'MISSING_BASE_HASH',
    );
  });

  it('declares a set in apply order, not in the order a human reads it', () => {
    const declared = declaredArtifactSet({
      plan: plan({ pages: [page('/cart', { forms: [form()] })] }),
      specCode: "test('t', () => {});\n",
      dialect: 'JS_EXPECT',
    });
    expect(declared.artifacts.map((a) => a.role)).toEqual([
      'DATASET',
      'FIXTURE',
      'PAGE_OBJECT',
      'SPEC',
    ]);
    // The producer's claim, which `artifactSetSchema` accepts — and which is
    // not a permission to write anything.
    expect(kinds(artifactSetProblems(declared))).not.toContain('APPLY_ORDER');
  });
});

describe('updating a shared file changes every dependent', () => {
  const oldPageObject = [
    'export class CartPage {',
    '  constructor(private readonly page: Page) {}',
    '  async addToCart(): Promise<void> {}',
    '  async removeFromCart(): Promise<void> {}',
    '}',
    '',
  ].join('\n');

  const specCalling = (member: string) =>
    `import { CartPage } from '../pages/cart.page';\ntest('t', async () => {\n  await cartPage.${member}();\n});\n`;

  /** Our own page object, three specs importing it, and the crawl no longer offering that control. */
  function withThreeDependents(override: { readonly disk?: Record<string, string> } = {}) {
    const paths = ['e2e/specs/one.spec.ts', 'e2e/specs/two.spec.ts', 'e2e/specs/three.spec.ts'];
    return {
      paths,
      repo: repository({
        ledger: [
          ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', contentHash: 'h-old' }),
          ...paths.map((path) =>
            ledgerEntry({ path, role: 'SPEC', imports: ['e2e/specs/pages/cart.page.ts'] }),
          ),
        ],
        disk: {
          'e2e/specs/pages/cart.page.ts': oldPageObject,
          ...Object.fromEntries(paths.map((path) => [path, specCalling('addToCart')])),
          ...(override.disk ?? {}),
        },
      }),
    };
  }

  it('refuses a replacement that removes a member three specs call, and names all three', () => {
    const { paths, repo } = withThreeDependents();
    const result = plan({ repository: repo });

    const removal = result.problems.find((problem) => problem.kind === 'SHARED_MEMBER_REMOVED');
    expect(removal, 'the rename is refused').toBeDefined();
    expect(removal?.path).toBe('e2e/specs/pages/cart.page.ts');
    expect(removal?.why).toContain('addToCart');
    for (const path of paths) expect(removal?.why).toContain(path);
    expect(result.plannable).toBe(false);

    // The blast radius is LISTED, not just counted: a reviewer needs the files.
    const impact = result.sharedImpact.find((entry) => entry.path === 'e2e/specs/pages/cart.page.ts');
    expect([...(impact?.dependents ?? [])].sort()).toEqual([...paths].sort());
    expect(impact?.brokenCalls).toEqual([{ member: 'addToCart', dependents: paths }]);
  });

  it('the export-level check cannot see that rename, which is why the member check exists', () => {
    /*
     * This is the justification for `memberSurfaceChange` existing at all, as a
     * test rather than as a paragraph: the class is still exported under the
     * same name, so the export surface is UNCHANGED, and every spec that called
     * the renamed method is broken anyway.
     */
    const replacement = oldPageObject.replace('addToCart', 'addItem');
    const exports = sharedSurfaceChange(oldPageObject, replacement);
    expect(exports).toEqual({ state: 'READ', removed: [], added: [] });

    const members = memberSurfaceChange(oldPageObject, replacement);
    expect(members.state).toBe('READ');
    if (members.state !== 'READ') return;
    expect(members.removed).toContain('addToCart');
    expect(members.added).toContain('addItem');
  });

  it('does not refuse a replacement when no dependent calls the member that went', () => {
    const { repo } = withThreeDependents({
      disk: {
        'e2e/specs/one.spec.ts': specCalling('goto'),
        'e2e/specs/two.spec.ts': specCalling('goto'),
        'e2e/specs/three.spec.ts': specCalling('goto'),
      },
    });
    const result = plan({ repository: repo });
    expect(kinds(result.problems)).not.toContain('SHARED_MEMBER_REMOVED');
    expect(result.plannable).toBe(true);
    // The dependents are still reported — the change still reaches them.
    expect(result.sharedImpact[0]?.dependents).toHaveLength(3);
  });

  it('does not refuse a replacement nothing imports', () => {
    const repo = repository({
      ledger: [ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', contentHash: 'h-old' })],
      disk: { 'e2e/specs/pages/cart.page.ts': oldPageObject },
    });
    const result = plan({ repository: repo });
    expect(result.sharedImpact).toEqual([]);
    expect(result.plannable).toBe(true);
  });

  it('refuses when a dependent’s bytes cannot be read, because an unknown blast radius is a refusal', () => {
    const paths = ['e2e/specs/one.spec.ts'];
    const repo = repository({
      ledger: [
        ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', contentHash: 'h-old' }),
        ...paths.map((path) => ledgerEntry({ path, role: 'SPEC', imports: ['e2e/specs/pages/cart.page.ts'] })),
      ],
      disk: { 'e2e/specs/pages/cart.page.ts': oldPageObject },
      unreadable: paths,
    });
    const result = plan({ repository: repo });
    expect(kinds(result.problems)).toContain('SHARED_DEPENDENT_UNREADABLE');
    expect(result.plannable).toBe(false);
  });

  it('refuses when the prior members cannot be read at all', () => {
    const repo = repository({
      ledger: [
        ledgerEntry({ path: 'e2e/specs/pages/cart.page.ts', contentHash: 'h-old' }),
        ledgerEntry({ path: 'e2e/specs/one.spec.ts', role: 'SPEC', imports: ['e2e/specs/pages/cart.page.ts'] }),
      ],
      disk: {
        'e2e/specs/pages/cart.page.ts': 'opaque bytes with no declaration in them\n',
        'e2e/specs/one.spec.ts': specCalling('addToCart'),
      },
    });
    const result = plan({ repository: repo });
    expect(kinds(result.problems)).toContain('SHARED_MEMBERS_UNREADABLE');
    expect(result.plannable).toBe(false);
  });

  it('does not ask a dataset for its members, which it has none of', () => {
    /*
     * `memberSurfaceChange` answers UNREADABLE for a JSON file, and UNREADABLE
     * is a refusal — correctly for a page object and absurdly for a file of
     * rows. `ROLE_HAS_MEMBER_SURFACE` is what stops a true check producing a
     * false refusal, and without it a dataset with any dependent at all would
     * block every plan that touched it.
     */
    const datasetPath = 'e2e/specs/fixtures/checkout-adds-an-item-to-the-cart.json';
    const repo = repository({
      ledger: [
        ledgerEntry({ path: datasetPath, role: 'DATASET', contentHash: 'h-data' }),
        ledgerEntry({ path: 'e2e/specs/one.spec.ts', role: 'SPEC', imports: [datasetPath] }),
      ],
      disk: {
        [datasetPath]: '[{"email": "old@example.com"}]\n',
        'e2e/specs/one.spec.ts': "test('t', () => {});\n",
      },
    });
    const result = plan({ repository: repo, pages: [page('/cart', { forms: [form()] })] });
    expect(ROLE_HAS_MEMBER_SURFACE.DATASET).toBe(false);
    expect(kinds(result.problems)).not.toContain('SHARED_MEMBERS_UNREADABLE');
    expect(result.plannable).toBe(true);
    // The dependents are still reported: the change still reaches that spec.
    expect(result.sharedImpact.find((entry) => entry.path === datasetPath)?.dependents).toEqual([
      'e2e/specs/one.spec.ts',
    ]);
  });

  it('reads a member declaration and not a keyword that looks like one', () => {
    const names = memberNamesOf(
      [
        'class X {',
        '  async addToCart() {}',
        '  get total() { return 1; }',
        '  def python_style(self):',
        '}',
        'if (x) {',
        'for (const y of z) {',
        'while (true) {',
        'switch (k) {',
      ].join('\n'),
    );
    expect(names).toContain('addToCart');
    expect(names).toContain('python_style');
    for (const keyword of ['if', 'for', 'while', 'switch']) {
      expect(names, `${keyword} is not a member`).not.toContain(keyword);
    }
  });

  it('dependentCalls needs a member access, not a bare word anywhere in the file', () => {
    const spec = "test('matches the total', () => { expect(match).toBe(1); });\n";
    expect(dependentCalls(spec, ['match'])).toEqual([]);
    expect(dependentCalls('await cartPage.match();\n', ['match'])).toEqual(['match']);
    expect(dependentCalls("page['match']\n", ['match'])).toEqual(['match']);
    // Both casings, because one member name renders two ways.
    expect(dependentCalls('cart_page.add_to_cart()\n', ['addToCart'])).toEqual(['addToCart']);
  });
});

describe('a dataset is data the customer’s suite runs against', () => {
  const withForm = [page('/cart', { forms: [form()] })];

  it('is byte-identical from the same seed and different from another', () => {
    const first = buildDataset({ pages: withForm, item, seed: 'run-1' });
    expect(buildDataset({ pages: withForm, item, seed: 'run-1' })).toEqual(first);
    expect(buildDataset({ pages: withForm, item, seed: 'run-2' })?.content).not.toBe(first?.content);
  });

  it('gives two forms that share an id two different values', () => {
    /*
     * `createSyntheticFactory` is pure, so two forms scoped by id alone would
     * get the SAME email — and a dataset whose rows collide on a unique field
     * is a dataset whose second case fails for a reason that is ours. The scope
     * is (route, form id) for exactly that.
     */
    const dataset = buildDataset({
      pages: [page('/register', { forms: [form()] }), page('/checkout', { forms: [form()] })],
      item,
      seed: 'run-1',
    });
    const rows = JSON.parse(dataset!.content) as { email: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.email).not.toBe(rows[1]!.email);
  });

  it('writes rows the product’s own dataset schema accepts', () => {
    // Ends at the validator: `datasetSchema` is what the runner parses a
    // dataset through, and every column name has to survive being a
    // `{{placeholder}}`. A row the crawl's field names made unspellable is a
    // dataset that is never read.
    const dataset = buildDataset({
      pages: [
        page('/cart', {
          forms: [
            form({
              fields: [
                {
                  name: '2 day shipping!',
                  label: null,
                  inputType: 'text',
                  required: false,
                  semantic: 'freeform',
                  selector: { strategy: 'CSS', value: '#x', confidence: 0.5 },
                },
              ],
            }),
          ],
        }),
      ],
      item,
      seed: 'run-1',
    });
    const rows = JSON.parse(dataset!.content) as Record<string, string>[];
    expect(datasetSchema.safeParse({ source: 'inline', rows }).success).toBe(true);
    expect(Object.keys(rows[0]!)).toEqual(['n2DayShipping']);
  });

  it('refuses a dataset carrying an environment reference from crawled page content', () => {
    /*
     * The values come from a pure factory and cannot be a secret. The COLUMN
     * NAMES and the SELECT OPTIONS come from the crawl, which is page content,
     * which is attacker-influenced — and the factory picks from the options it
     * is given. So the check is over the final bytes.
     */
    const result = plan({
      pages: [
        page('/cart', {
          forms: [
            form({
              fields: [
                {
                  name: 'token',
                  label: 'Token',
                  inputType: 'select',
                  required: true,
                  semantic: 'freeform',
                  options: ['process.env.STRIPE_SECRET'],
                  selector: { strategy: 'LABEL', value: 'Token', confidence: 0.9 },
                },
              ],
            }),
          ],
        }),
      ],
    });
    const problem = result.problems.find((entry) => entry.kind === 'DATASET_SECRET');
    expect(problem?.why).toContain('a process.env reference');
    expect(result.plannable).toBe(false);
    // And nothing was planned at that path: a refused dataset is not written.
    expect(result.artifacts.filter((a) => a.role === 'DATASET')).toHaveLength(0);
  });

  it('names every secret shape it looks for, and does not claim the ones it cannot see', () => {
    // The credential prefixes are named by `SECRET_SHAPES`, which is why these
    // read as that vocabulary's sentences and not as a second set of words for
    // the same shapes.
    /*
     * COMPOSED, never written whole — including AWS's own published example id.
     * Push protection matches the SHAPE, not the provenance, and a key-shaped
     * literal in a committed file has already cost this repository a rejected
     * commit. The prefix comes from the same vocabulary the scanner consults.
     */
    const awsPrefix =
      SECRET_SHAPES.find((shape) => shape.what === 'an AWS access key id')?.prefix ?? 'AKIA';
    expect(datasetSecrets(`${awsPrefix}FABRICATEDFORTEST01`)).toEqual([
      'an AWS access key id',
    ]);
    expect(datasetSecrets('sk_live_abcd1234')).toEqual(['a Stripe live secret key']);
    expect(datasetSecrets('${SECRET_TOKEN}')).toEqual(['a shell variable expansion']);
    expect(datasetSecrets('-----BEGIN RSA PRIVATE KEY-----')).toEqual([
      'a PEM block: a private key or a certificate',
    ]);
    // A named-shape scanner, not an entropy classifier. Saying so beats a pass
    // that means "we did not check".
    expect(datasetSecrets('f3Kq8ZtW2bR9xLmP')).toEqual([]);
  });

  /*
   * THE PAIR THAT MAY NOT DRIFT. `datasetSecrets` is the only thing between a
   * crawl-derived dataset and `DATASET_SECRET`, which BLOCKS the plan, and the
   * repository already keeps one credential vocabulary for the whole product.
   * A hand-written second copy named 12 of these 26 and let 14 live credentials
   * through; this test is what stops the copy coming back, because a shape
   * added to `SECRET_SHAPES` and not reachable from here fails here.
   */
  it('names every credential shape the repository itself knows about', () => {
    const unnamed = SECRET_SHAPES.filter(
      (shape) => datasetSecrets(`{"apiKey": "${shape.prefix}A1b2C3d4E5f6G7h8"}`).length === 0,
    ).map((shape) => shape.prefix);
    expect(unnamed).toEqual([]);
    // And it is the shared vocabulary that is being consulted, not a list this
    // file happens to agree with today.
    expect(datasetSecrets('whsec_A1b2C3d4')).toEqual([
      'a Stripe webhook signing secret',
    ]);
    expect(datasetSecrets('glpat-A1b2C3d4')).toEqual([
      'a GitLab personal access token',
    ]);
  });

  /*
   * `pk_live_` is OURS and not `SECRET_SHAPES`', and the two files disagree on
   * purpose: a publishable key is public by design, so the catalogue admits it,
   * and a dataset committed to the customer's repository is still not where it
   * belongs. Pinned here so a later tidy-up that "unifies" the two lists has to
   * read the reason first.
   */
  it('still refuses a publishable live key, which the shared catalogue deliberately admits', () => {
    expect(datasetSecrets('pk_live_abcd1234')).toEqual(['a publishable live-key prefix']);
    expect(SECRET_SHAPES.some((shape) => shape.prefix === 'pk_live_')).toBe(false);
  });

  it('never reads a value out of the environment', () => {
    const key = 'QAAI_ARTIFACTS_TEST_SECRET';
    process.env[key] = 'this-must-not-appear';
    try {
      const dataset = buildDataset({ pages: withForm, item, seed: 'run-1' });
      expect(dataset?.content).not.toContain('this-must-not-appear');
      expect(dataset?.content).not.toContain(key);
    } finally {
      delete process.env[key];
    }
  });

  it('discloses the case cap as a count and a reason rather than stopping quietly', () => {
    const many = Array.from({ length: MAX_DATASET_CASES + 3 }, (_unused, index) =>
      page(`/p${index}`, { forms: [form({ id: `f${index}` })] }),
    );
    const dataset = buildDataset({ pages: many, item, seed: 'run-1' });
    expect(JSON.parse(dataset!.content)).toHaveLength(MAX_DATASET_CASES);
    expect(dataset?.casesOmitted).toBe(3);
  });

  it('counts a cell it had to shorten rather than letting a prefix look like a value', () => {
    const longOption = 'y'.repeat(400);
    const result = plan({
      pages: [
        page('/cart', {
          forms: [
            form({
              fields: [
                {
                  name: 'note',
                  label: 'Note',
                  inputType: 'select',
                  required: false,
                  semantic: 'freeform',
                  options: [longOption],
                  selector: { strategy: 'LABEL', value: 'Note', confidence: 0.9 },
                },
              ],
            }),
          ],
        }),
      ],
    });
    const omission = result.omitted.find((entry) => entry.what.includes('cells shortened'));
    expect(omission).toMatchObject({ count: 1 });
    const dataset = result.artifacts.find((a) => a.role === 'DATASET')!;
    expect((JSON.parse(dataset.content) as { note: string }[])[0]!.note).toHaveLength(200);
  });

  it('plans no dataset for pages with no forms', () => {
    expect(buildDataset({ pages: [page('/cart')], item, seed: 'run-1' })).toBeNull();
    expect(plan().artifacts.filter((a) => a.role === 'DATASET')).toHaveLength(0);
  });
});

describe('the fixture, and refusing to write one that would never load', () => {
  it('builds one fixture over every page object, re-exporting the runner’s expect', () => {
    const result = plan({ pages: [page('/cart'), page('/checkout')] });
    const fixture = result.artifacts.find((a) => a.role === 'FIXTURE')!;
    expect(fixture.content).toContain(
      'export const test = base.extend<{ cartPage: CartPage; checkoutPage: CheckoutPage }>({',
    );
    expect(fixture.content).toContain("import { CartPage } from '../../pages/cart.page';");
    // Both from one place, or a spec that imports `test` from the runner gets
    // the un-extended one and silently no fixtures.
    expect(fixture.content).toContain("export { expect } from '@playwright/test';");
    expect(fixture.imports).toEqual([
      'e2e/specs/pages/cart.page.ts',
      'e2e/specs/pages/checkout.page.ts',
    ]);
  });

  it('refuses to write a fixture for a runner whose loading rule it cannot read, and says why', () => {
    const result = plan({ ecosystemId: 'PLAYWRIGHT_PYTHON' });
    expect(result.artifacts.filter((a) => a.role === 'FIXTURE')).toHaveLength(0);
    const omission = result.omitted.find((entry) => entry.what === 'a shared fixture');
    expect(omission?.why).toContain(ECOSYSTEMS.PLAYWRIGHT_PYTHON.label);
    expect(omission?.why).toContain('never runs');
    // And the spec imports the page objects directly instead.
    const spec = result.artifacts.find((a) => a.role === 'SPEC')!;
    expect(spec.imports).toEqual(['e2e/specs/pages/cart_page.py']);
  });

  it('computes a specifier that climbs out of the fixture directory', () => {
    expect(
      moduleSpecifier('e2e/specs/fixtures/setup/pages.fixture.ts', 'e2e/specs/pages/cart.page.ts', profileWith()),
    ).toBe('../../pages/cart.page');
    expect(moduleSpecifier('e2e/a.spec.ts', 'e2e/pages/cart.page.ts', profileWith())).toBe(
      './pages/cart.page',
    );
  });

  it('uses the project’s own import alias when it measured one', () => {
    const aliased = profileWith({
      importAlias: observed({ value: '@/', filesSeen: 18, filesConsidered: 20 }),
    });
    expect(moduleSpecifier('e2e/a.spec.ts', 'e2e/pages/cart.page.ts', aliased)).toBe(
      '@/e2e/pages/cart.page',
    );
  });

  it('ignores an alias the profile only weakly attests', () => {
    const weak = profileWith({
      importAlias: observed({ value: '@/', filesSeen: 2, filesConsidered: 20 }),
    });
    expect(weak.importAlias.confidence).toBe('LOW');
    expect(moduleSpecifier('e2e/a.spec.ts', 'e2e/pages/cart.page.ts', weak)).toBe(
      './pages/cart.page',
    );
  });
});

describe('the briefing', () => {
  it('tells the model to import the fixture rather than the runner’s own test', () => {
    const briefing = artifactBriefing(plan({ pages: [page('/cart', { forms: [form()] })] }));
    expect(briefing).toContain('Import test and expect from ./fixtures/setup/pages.fixture');
    expect(briefing).toContain('CartPage from ./pages/cart.page');
    expect(briefing).toContain('holds the form data');
    expect(briefing).toContain('ASSERTIONS GO IN THE SPEC AND NOWHERE ELSE');
  });

  it('renders one honest line when there is nothing beside the spec', () => {
    const bare = plan({ pages: [] });
    expect(bare.artifacts.map((a) => a.role)).toEqual(['SPEC']);
    expect(artifactBriefing(bare)).toContain('none');
    expect(artifactBriefing(bare)).toContain('do not import one');
  });

  it('quotes no customer source, however hostile the page was', () => {
    const payload = "'); process.exit(1); //";
    const briefing = artifactBriefing(
      plan({
        pages: [
          page('/cart', {
            affordances: [{ label: payload, kind: 'button', selector: sel({ name: payload }) }],
            forms: [
              form({
                fields: [
                  {
                    name: payload,
                    label: payload,
                    inputType: 'text',
                    required: false,
                    semantic: 'freeform',
                    selector: { strategy: 'CSS', value: '#x', confidence: 0.9 },
                  },
                ],
              }),
            ],
          }),
        ],
      }),
    );
    // The briefing carries class names and paths, both already sanitised. The
    // customer's own strings are fenced where they belong — inside the page
    // object's escaped literals — and never in the prompt's own prose.
    expect(briefing).not.toContain('process.exit');
    expect(briefing).toContain('CartPage');
  });
});

describe('what a page refused for brittleness does to the plan', () => {
  it('records the refusal as a finding and plans no page object for it', () => {
    const result = plan({
      pages: [
        page('/cart', {
          affordances: [
            { label: 'One', kind: 'button', selector: { strategy: 'CSS', value: '.sc-x7f2', confidence: 0.4 } },
          ],
        }),
      ],
    });
    expect(result.artifacts.filter((a) => a.role === 'PAGE_OBJECT')).toHaveLength(0);
    expect(result.unplannedPages).toEqual([
      expect.objectContaining({ route: '/cart', reason: 'ALL_LOCATORS_BRITTLE' }),
    ]);
    // Still plannable: the spec is written, it just locates its own elements.
    expect(result.plannable).toBe(true);
  });

  it('derives a class name the same way the planner and the editor both need it', () => {
    expect(pageObjectClassName('/orders/:id')).toBe('OrdersIdPage');
    expect(pageObjectClassName('/')).toBe('RootPage');
  });
});
