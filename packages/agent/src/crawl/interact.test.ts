import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRAWL_POLICY,
  exercisabilityCounts,
  frontierIsConsistent,
  parseSurfaceKey,
  shouldGenerateAgainst,
  statusClassFor,
  type CrawlPolicy,
} from '@qaai/shared';
/*
 * The REAL primitives, imported rather than faked, because the one thing a
 * fake could not prove is the thing that matters: that the identity this
 * module mints composes with the route normaliser the rest of the crawl uses.
 * A local copy of `normaliseRoute` that collapsed one segment differently
 * would make every test here pass and every real crawl mint a node per order
 * id. crawler.test.ts already imports this module, so the cost is paid.
 */
import { normaliseRoute, semanticFor } from '../crawler.js';
import {
  INTERACTION_CAPABILITIES,
  accessibleName,
  budgetsFeedTheFrontier,
  budgetsThatBit,
  classifyControl,
  controlIdentity,
  describeReplay,
  detectRouteMode,
  discardedByBudgets,
  exploreInteractions,
  fieldGroupsFrom,
  identityOfRaw,
  implicitRole,
  isFieldControl,
  labelOf,
  normaliseStructureName,
  parseControlIdentity,
  rankCandidate,
  refusalFor,
  routeIdentity,
  selectorFor,
  stateSignatureOf,
  structuralDigest,
  type CrawlerPrimitives,
  type InteractionCapability,
  type InteractionCrawlOptions,
  type InteractionSurface,
  type RawControl,
  type RawNavigation,
  type RawStructureNode,
  type RouteMode,
} from './interact.js';

/**
 * WHAT IS AND IS NOT COVERED HERE, said plainly, in the style crawler.test.ts
 * established.
 *
 * Every decision this module makes — what to click, what to refuse, whether
 * two DOMs are one state, how to get back, what a budget cost — is a pure
 * function over plain data and is tested below against the real
 * `normaliseRoute` and `semanticFor`.
 *
 * NOT covered: `playwrightInteractionSurface` and the three `evaluate` scripts
 * it ships. They run inside a browser, and a unit test of them could only
 * prove that a mock DOM matches the code rather than that the code reads a
 * page correctly. That is exactly why the module is shaped the way it is: the
 * adapter makes no decisions, so the untestable part has no judgement in it.
 * The scripts are exercised end to end by the demo app.
 */

const primitives: CrawlerPrimitives = { normaliseRoute, semanticFor };

function policyWith(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return { ...DEFAULT_CRAWL_POLICY, ...overrides };
}

function raw(overrides: Partial<RawControl> & { ref: string }): RawControl {
  const base: Omit<RawControl, 'ref'> = {
    tag: 'button',
    type: null,
    role: null,
    rel: null,
    text: '',
    ariaLabel: null,
    title: null,
    testId: null,
    placeholder: null,
    label: null,
    name: null,
    href: null,
    ariaExpanded: null,
    ariaControls: null,
    ariaHasPopup: null,
    ariaCurrent: null,
    dataState: null,
    disabled: false,
    hidden: false,
    required: false,
    contentEditable: false,
    hasClickHandler: false,
    landmark: null,
    formIndex: null,
    fieldset: null,
    options: null,
    nth: null,
    cssPath: 'body > button',
    constraints: {},
  };
  return { ...base, ...overrides };
}

/** A page in the fake browser. The key is a STATE id; `url` may repeat. */
interface FakePage {
  url: string;
  title?: string;
  structure?: RawStructureNode[];
  dialogName?: string | null;
  activeMarkers?: string[];
  status?: number | null;
  isErrorPage?: boolean;
  controls?: RawControl[];
  /** ref → destination page key. A ref with no entry is a click that does nothing. */
  transitions?: Record<string, string>;
  navigations?: Record<string, RawNavigation['kind']>;
}

/**
 * The whole browser, as a literal. This is the payoff of the injected surface:
 * a two-state disclosure, a hash-routed SPA and a four-page paginated list are
 * each a few lines, and none of them needs a browser to run.
 */
function fakeSurface(
  pages: Record<string, FakePage>,
  config: {
    capabilities?: InteractionCapability[];
    start?: string;
    /** Fail every `goto` after this many successes — used to break a replay. */
    failGotoAfter?: number;
  } = {},
): { surface: InteractionSurface; clicks: string[]; fills: Array<{ ref: string; value: string }> } {
  const caps = config.capabilities ?? [...INTERACTION_CAPABILITIES];
  const clicks: string[] = [];
  const fills: Array<{ ref: string; value: string }> = [];
  const navs: RawNavigation[] = [];
  let current = config.start ?? '';
  let gotos = 0;

  const at = (): FakePage | undefined => pages[current];

  const surface: InteractionSurface = {
    capabilities: () => caps,
    url: () => at()?.url ?? '',
    async goto(url) {
      gotos += 1;
      if (config.failGotoAfter !== undefined && gotos > config.failGotoAfter) {
        return { ok: false, url: at()?.url ?? '', status: null, error: 'goto refused by the fake' };
      }
      const key = Object.keys(pages).find((name) => pages[name]?.url === url);
      if (key === undefined) {
        return { ok: false, url: at()?.url ?? '', status: null, error: `no page at ${url}` };
      }
      current = key;
      return { ok: true, url, status: pages[key]?.status ?? 200, error: null };
    },
    async back() {
      return { ok: false, url: at()?.url ?? '', status: null, error: 'BACK is not the strategy' };
    },
    async snapshot() {
      const page = at();
      return {
        url: page?.url ?? '',
        title: page?.title ?? page?.url ?? '',
        structure: page?.structure ?? [],
        dialogName: page?.dialogName ?? null,
        activeMarkers: page?.activeMarkers ?? [],
        statusCode: caps.includes('NAVIGATION_STATUS') ? (page?.status ?? 200) : null,
        isErrorPage: page?.isErrorPage ?? false,
      };
    },
    async controls() {
      return at()?.controls ?? [];
    },
    async click(ref) {
      clicks.push(`${current}#${ref}`);
      const to = at()?.transitions?.[ref];
      if (to === undefined) return { ok: true, error: null, navigated: false, status: null };
      if (!(to in pages)) {
        return { ok: false, error: `nowhere to go from ${ref}`, navigated: false, status: null };
      }
      const kind = at()?.navigations?.[ref];
      if (kind !== undefined) navs.push({ kind, url: pages[to]?.url ?? '' });
      current = to;
      return { ok: true, error: null, navigated: true, status: pages[to]?.status ?? 200 };
    },
    async fill(ref, value) {
      fills.push({ ref, value });
      return true;
    },
    async drainNavigations() {
      return navs.splice(0, navs.length);
    },
  };

  return { surface, clicks, fills };
}

function options(overrides: Partial<InteractionCrawlOptions> = {}): InteractionCrawlOptions {
  return {
    baseUrl: 'https://app.test',
    entryUrls: ['https://app.test/'],
    policy: DEFAULT_CRAWL_POLICY,
    primitives,
    // A frozen clock, so a wall-clock test measures the budget and not the CI box.
    now: () => 0,
    ...overrides,
  };
}

// ─── Per-page control identity: the "Save" defect ────────────────────────────

describe('controlIdentity', () => {
  it('puts the PAGE in the identity, so "Save" on five routes is five controls', () => {
    /*
     * THE DEFECT: locators.ts de-duplicates by locator EXPRESSION, so
     * getByRole('button', { name: 'Save' }) is ONE identity across five routes
     * and covering it on /profile marks the other four covered. A 100%-at-20%
     * lie, in the most flattering possible direction.
     */
    const routes = ['/profile', '/settings', '/billing', '/team', '/orders/:id'];
    const identities = new Set(
      routes.map((route) =>
        controlIdentity({ route, landmark: 'main', role: 'button', label: 'Save' }),
      ),
    );
    expect(identities.size).toBe(5);
  });

  it("keeps the application's own case, because folding it merges two controls", () => {
    expect(
      controlIdentity({ route: '/a', landmark: null, role: 'button', label: 'Save' }),
    ).not.toBe(controlIdentity({ route: '/a', landmark: null, role: 'button', label: 'save' }));
  });

  it('separates the same label in two different landmarks', () => {
    const header = controlIdentity({
      route: '/a',
      landmark: 'banner',
      role: 'button',
      label: 'Edit',
    });
    const main = controlIdentity({ route: '/a', landmark: 'main', role: 'button', label: 'Edit' });
    expect(header).not.toBe(main);
  });

  it('separates three same-named controls on one page by nth', () => {
    const all = [0, 1, 2].map((nth) =>
      controlIdentity({ route: '/a', landmark: 'main', role: 'button', label: 'Save', nth }),
    );
    expect(new Set(all).size).toBe(3);
    // And a unique control carries no index, so adding a second "Save" later
    // does not retire the first one's identity.
    expect(controlIdentity({ route: '/a', landmark: 'main', role: 'button', label: 'Save' })).toBe(
      '/a::main::button::Save::',
    );
  });

  it('distinguishes a button from a tab with the same name', () => {
    expect(
      controlIdentity({ route: '/a', landmark: 'main', role: 'tab', label: 'Filter' }),
    ).not.toBe(controlIdentity({ route: '/a', landmark: 'main', role: 'button', label: 'Filter' }));
  });

  it('round-trips, including a label that contains the separator', () => {
    const identity = controlIdentity({
      route: '/orders/:id',
      landmark: 'main',
      role: 'button',
      label: 'Status: 50% done',
      nth: 2,
    });
    expect(parseControlIdentity(identity)).toEqual({
      route: '/orders/:id',
      landmark: 'main',
      role: 'button',
      label: 'Status: 50% done',
      nth: 2,
    });
  });

  it('reports no enclosing landmark as a measurement, not as an unknown', () => {
    const identity = controlIdentity({ route: '/a', landmark: null, role: 'button', label: 'Go' });
    expect(parseControlIdentity(identity)?.landmark).toBeNull();
  });

  it('refuses an identity that is not five parts', () => {
    expect(parseControlIdentity('/a::main::button')).toBeNull();
    expect(parseControlIdentity('/a::main::button::Save::nonsense')).toBeNull();
  });
});

// ─── Locators ────────────────────────────────────────────────────────────────

describe('implicitRole and selectorFor', () => {
  it('gives every input type its platform role', () => {
    expect(implicitRole('input', 'checkbox')).toBe('checkbox');
    expect(implicitRole('input', 'radio')).toBe('radio');
    expect(implicitRole('input', 'submit')).toBe('button');
    expect(implicitRole('input', 'search')).toBe('searchbox');
    expect(implicitRole('input', 'text')).toBe('textbox');
    expect(implicitRole('summary', null)).toBe('button');
    expect(implicitRole('select', null)).toBe('combobox');
    expect(implicitRole('div', null)).toBeNull();
  });

  it('names an ICON-ONLY control by its title when nothing else names it', () => {
    // An icon button with only a `title` is exactly the control crawler.ts
    // drops: it reads innerText, finds '', and `continue`s.
    expect(accessibleName(raw({ ref: 'r', title: 'Delete row' }))).toBe('Delete row');
    expect(accessibleName(raw({ ref: 'r', ariaLabel: 'Close', title: 'x' }))).toBe('Close');
  });

  it('falls back to the name attribute for a control with no accessible name', () => {
    expect(labelOf(raw({ ref: 'r', name: 'submit-order' }))).toBe('submit-order');
    expect(labelOf(raw({ ref: 'r' }))).toBe('');
  });

  it("matches bestSelector's order and confidences, which the 0.6 review threshold is calibrated against", () => {
    expect(selectorFor(raw({ ref: 'r', tag: 'button', text: 'Save' }))).toEqual({
      strategy: 'ROLE',
      value: 'button',
      name: 'Save',
      confidence: 0.95,
    });
    expect(
      selectorFor(raw({ ref: 'r', tag: 'div', label: 'Email', testId: 'email' })).strategy,
    ).toBe('LABEL');
    expect(
      selectorFor(raw({ ref: 'r', tag: 'div', testId: 'email', placeholder: 'you@x' })).strategy,
    ).toBe('TEST_ID');
    expect(selectorFor(raw({ ref: 'r', tag: 'div', placeholder: 'you@x' })).strategy).toBe(
      'PLACEHOLDER',
    );
    expect(selectorFor(raw({ ref: 'r', tag: 'div', cssPath: 'body > div' }))).toEqual({
      strategy: 'CSS',
      value: 'body > div',
      confidence: 0.3,
    });
  });

  it('carries nth when the page holds a duplicate, so the locator resolves to one element', () => {
    expect(selectorFor(raw({ ref: 'r', tag: 'button', text: 'Save', nth: 1 })).nth).toBe(1);
    expect(selectorFor(raw({ ref: 'r', tag: 'button', text: 'Save' })).nth).toBeUndefined();
  });
});

// ─── Candidate selection ─────────────────────────────────────────────────────

describe('classifyControl', () => {
  it('trusts what the markup DECLARES over what a label suggests', () => {
    // aria-expanded is the author telling us there is hidden content; "Next" is
    // us guessing from a word.
    expect(classifyControl(raw({ ref: 'r', text: 'Next', ariaExpanded: 'false' }))).toBe(
      'DISCLOSURE',
    );
    expect(classifyControl(raw({ ref: 'r', tag: 'summary', text: 'Details' }))).toBe('DISCLOSURE');
    expect(classifyControl(raw({ ref: 'r', role: 'tab', text: 'Billing' }))).toBe('TAB');
    expect(classifyControl(raw({ ref: 'r', text: 'Edit', ariaHasPopup: 'dialog' }))).toBe(
      'DIALOG_TRIGGER',
    );
    expect(classifyControl(raw({ ref: 'r', role: 'menuitem', text: 'Export' }))).toBe('MENU');
    expect(classifyControl(raw({ ref: 'r', text: 'More', ariaHasPopup: 'menu' }))).toBe('MENU');
    expect(classifyControl(raw({ ref: 'r', tag: 'a', href: 'https://x/2', rel: 'next' }))).toBe(
      'PAGINATION',
    );
  });

  it('reads the same "Next" as pagination in a nav and as a wizard step in main', () => {
    const inNav = raw({ ref: 'r', text: 'Next', landmark: 'navigation' });
    const inMain = raw({ ref: 'r', text: 'Next', landmark: 'main' });
    expect(classifyControl(inNav)).toBe('PAGINATION');
    expect(classifyControl(inMain)).toBe('WIZARD_STEP');
  });

  it('separates a search submit from any other submit, because only one is safe', () => {
    expect(
      classifyControl(
        raw({ ref: 'r', tag: 'button', type: 'submit', text: 'Search', formIndex: 0 }),
      ),
    ).toBe('SEARCH_SUBMIT');
    expect(
      classifyControl(
        raw({ ref: 'r', tag: 'button', type: 'submit', text: 'Pay now', formIndex: 0 }),
      ),
    ).toBe('FORM_SUBMIT');
  });

  it('captures the controls crawler.ts cannot see at all', () => {
    // role=button on a div, an onClick div, and an icon-only control named only
    // by aria-label. crawler.ts reads `button, input[type=submit]` with
    // non-empty innerText, so all three are invisible to it.
    expect(classifyControl(raw({ ref: 'r', tag: 'div', role: 'button', text: 'Apply' }))).toBe(
      'BUTTON',
    );
    expect(classifyControl(raw({ ref: 'r', tag: 'div', hasClickHandler: true }))).toBe(
      'HANDLER_DIV',
    );
    expect(classifyControl(raw({ ref: 'r', tag: 'button', ariaLabel: 'Close' }))).toBe('BUTTON');
  });

  it('is not fooled by a disabled or hidden control', () => {
    expect(classifyControl(raw({ ref: 'r', text: 'Save', disabled: true }))).toBeNull();
    expect(classifyControl(raw({ ref: 'r', text: 'Save', hidden: true }))).toBeNull();
  });

  it('leaves fields to the field extractor', () => {
    expect(classifyControl(raw({ ref: 'r', tag: 'input', type: 'text' }))).toBeNull();
    expect(classifyControl(raw({ ref: 'r', tag: 'div', role: 'combobox' }))).toBeNull();
    expect(classifyControl(raw({ ref: 'r', tag: 'div', contentEditable: true }))).toBeNull();
    expect(isFieldControl(raw({ ref: 'r', tag: 'input', type: 'hidden' }))).toBe(false);
    expect(isFieldControl(raw({ ref: 'r', tag: 'input', type: 'submit' }))).toBe(false);
  });

  it('is not an interaction at all for an inert div', () => {
    expect(classifyControl(raw({ ref: 'r', tag: 'div', text: 'Total: 40' }))).toBeNull();
  });
});

describe('rankCandidate', () => {
  it('ranks a declared aria-controls far above a div with a handler', () => {
    // The task's explicit requirement, and the reason is epistemic: one element
    // has told us there is a region it governs, the other has told us nothing.
    const declared = raw({ ref: 'r1', text: 'Filters', ariaControls: 'filter-panel' });
    const guessed = raw({ ref: 'r2', tag: 'div', hasClickHandler: true, text: 'Filters' });
    const left = rankCandidate(declared, classifyControl(declared)!, '/orders');
    const right = rankCandidate(guessed, classifyControl(guessed)!, '/orders');
    expect(left.score).toBeGreaterThan(right.score);
    expect(left.why).toContain('aria-controls');
  });

  it('penalises an unnamed control but still COUNTS it', () => {
    const named = raw({ ref: 'r1', text: 'Apply' });
    const unnamed = raw({ ref: 'r2' });
    const scored = rankCandidate(unnamed, 'BUTTON', '/a');
    expect(scored.score).toBeLessThan(rankCandidate(named, 'BUTTON', '/a').score);
    expect(scored.why).toContain('no accessible name');
    // Counted: it has an identity and a locator, both of which a report needs.
    expect(scored.identity).not.toBe('');
  });

  it('keeps the score inside 0–1 however many bonuses apply', () => {
    const everything = raw({
      ref: 'r',
      text: 'Filters',
      ariaExpanded: 'false',
      ariaControls: 'panel',
      dataState: 'closed',
      testId: 'filters',
    });
    const scored = rankCandidate(everything, 'DISCLOSURE', '/a');
    expect(scored.score).toBeLessThanOrEqual(1);
    expect(scored.score).toBeGreaterThan(0.9);
  });

  it('mints the same identity as identityOfRaw, so a replay path can be looked up', () => {
    const element = raw({ ref: 'r', text: 'Filters', landmark: 'main' });
    expect(rankCandidate(element, 'BUTTON', '/orders').identity).toBe(
      identityOfRaw(element, '/orders'),
    );
  });
});

// ─── Destructive refusal ─────────────────────────────────────────────────────

describe('refusalFor', () => {
  it('refuses a destructive label and names the policy field a human can change', () => {
    const refused = refusalFor(
      { kind: 'BUTTON', label: 'Delete order', path: null },
      policyWith(),
      '/orders/:id',
    );
    expect(refused?.state).toBe('REFUSED');
    expect(refused?.rule).toBe('allowDestructive: false');
    expect(refused?.detail).toContain('Delete order');
  });

  it('refuses every destructive verb a real application uses', () => {
    const labels = [
      'Delete',
      'Destroy project',
      'Remove member',
      'Revoke token',
      'Cancel subscription',
      'Deactivate account',
      'Close account',
      'Reset database',
      'Downgrade plan',
      'Unsubscribe',
    ];
    for (const label of labels) {
      const refused = refusalFor({ kind: 'BUTTON', label, path: null }, policyWith(), '/a');
      expect(refused, label).not.toBeNull();
      expect(refused?.state, label).toBe('REFUSED');
    }
  });

  it('still refuses when allowDestructive is on but no glob names this route', () => {
    // The two-field design exists for exactly this: "this environment is
    // disposable" is not the same permission as "these paths are allowed".
    const refused = refusalFor(
      { kind: 'BUTTON', label: 'Delete order', path: null },
      policyWith({ allowDestructive: true, destructiveAllowGlobs: ['/sandbox/**'] }),
      '/orders/:id',
    );
    expect(refused?.state).toBe('REFUSED');
    expect(refused?.rule).toContain('destructiveAllowGlobs');
    expect(refused?.rule).toContain('/orders/:id');
  });

  it('drives a destructive control when the customer opted that path in', () => {
    expect(
      refusalFor(
        { kind: 'BUTTON', label: 'Delete order', path: null },
        policyWith({ allowDestructive: true, destructiveAllowGlobs: ['/orders/**'] }),
        '/orders/:id',
      ),
    ).toBeNull();
  });

  it('holds a logout control out as UNEXERCISABLE when there is no path to check', () => {
    // A logout BUTTON has no href, so no policy rule can be quoted. Calling it
    // REFUSED with an invented rule would be worse than saying our harness
    // refuses it — which is the honest sentence, and a different remedy.
    const held = refusalFor({ kind: 'BUTTON', label: 'Sign out', path: null }, policyWith(), '/a');
    expect(held?.state).toBe('UNEXERCISABLE');
    expect(held?.reason).toBe('SESSION_ENDING');
  });

  it('quotes the policy rule when the logout control DOES have a path', () => {
    const refused = refusalFor(
      { kind: 'LINK', label: 'Log out', path: '/logout' },
      policyWith(),
      '/a',
    );
    expect(refused?.state).toBe('REFUSED');
    expect(refused?.rule).toBe('excludeGlobs: /logout');
  });

  it('holds a real-world side effect out, and no policy field can turn it on', () => {
    for (const label of ['Pay now', 'Place order', 'Charge card', 'Send invite', 'Publish']) {
      const held = refusalFor(
        { kind: 'BUTTON', label, path: null },
        policyWith({ allowDestructive: true, destructiveAllowGlobs: ['/**'] }),
        '/checkout',
      );
      expect(held?.state, label).toBe('UNEXERCISABLE');
      expect(held?.reason, label).toBe('REAL_WORLD_SIDE_EFFECT');
    }
  });

  it('refuses a form submit under safeMethodsOnly and says a test still may', () => {
    const refused = refusalFor(
      { kind: 'FORM_SUBMIT', label: 'Create project', path: null },
      policyWith({ safeMethodsOnly: true }),
      '/projects',
    );
    expect(refused?.state).toBe('REFUSED');
    expect(refused?.rule).toBe('safeMethodsOnly: true');
    expect(
      refusalFor(
        { kind: 'FORM_SUBMIT', label: 'Create project', path: null },
        policyWith({ safeMethodsOnly: false }),
        '/projects',
      ),
    ).toBeNull();
  });

  it('admits an ordinary control', () => {
    expect(
      refusalFor({ kind: 'TAB', label: 'Archived', path: null }, policyWith(), '/orders'),
    ).toBeNull();
  });

  it('never produces a REFUSED without a rule or an UNEXERCISABLE without a reason', () => {
    /*
     * The invariant the whole state is for: "excluded by policy" with no rule
     * named is indistinguishable from a bug in the crawler, and a customer's
     * only possible response to it is to distrust the number.
     */
    const labels = ['Delete', 'Log out', 'Pay now', 'Create project', 'Archived', 'Next'];
    const kinds = ['BUTTON', 'FORM_SUBMIT', 'LINK', 'TAB'] as const;
    for (const label of labels) {
      for (const kind of kinds) {
        const result = refusalFor({ kind, label, path: null }, policyWith(), '/a');
        if (result === null) continue;
        expect(result.detail.length, `${kind} ${label}`).toBeGreaterThan(0);
        if (result.state === 'REFUSED') expect(result.rule, `${kind} ${label}`).toBeTruthy();
        if (result.state === 'UNEXERCISABLE')
          expect(result.reason, `${kind} ${label}`).toBeTruthy();
        // And whatever it is, it is held OUT of the coverage denominator, so a
        // refusal can never raise the percentage.
        expect(exercisabilityCounts(result.state), `${kind} ${label}`).toBe(false);
      }
    }
  });
});

// ─── State identity ─────────────────────────────────────────────────────────

describe('state signatures', () => {
  const page = (names: string[], extra: Partial<Parameters<typeof structuralDigest>[0]> = {}) => ({
    structure: names.map((name, depth) => ({ role: 'heading', name, depth })),
    dialogName: null,
    activeMarkers: [],
    ...extra,
  });

  it('does not mint a new state because a timestamp ticked', () => {
    // Without this, every revisit of a dashboard is a new node, the crawl never
    // terminates, and the denominator inflates with duplicates.
    expect(structuralDigest(page(['Updated 2 minutes ago']))).toBe(
      structuralDigest(page(['Updated 5 minutes ago'])),
    );
    expect(structuralDigest(page(['Created 2026-10-24T09:00:00Z']))).toBe(
      structuralDigest(page(['Created 2026-01-02T23:11:00Z'])),
    );
    expect(structuralDigest(page(['12 results']))).toBe(structuralDigest(page(['4,210 results'])));
  });

  it('reads a re-sorted list as the same state', () => {
    expect(structuralDigest(page(['Alice', 'Bob', 'Carol']))).toBe(
      structuralDigest(page(['Carol', 'Alice', 'Bob'])),
    );
  });

  it("reads a wizard's step 2 as a DIFFERENT state from step 1", () => {
    expect(structuralDigest(page(['Delivery address']))).not.toBe(
      structuralDigest(page(['Payment details'])),
    );
  });

  it('reads an open dialog as a different state from the page behind it', () => {
    expect(structuralDigest(page(['Orders'], { dialogName: 'Edit order' }))).not.toBe(
      structuralDigest(page(['Orders'])),
    );
  });

  it('ignores a spinner and a toast, but NOT a validation error', () => {
    // A live region is an animation frame. An alert is a state, and the error
    // path is where the tests live.
    const withSpinner = {
      structure: [
        { role: 'heading', name: 'Orders', depth: 1 },
        { role: 'progressbar', name: 'Loading', depth: 2 },
        { role: 'status', name: 'Saved', depth: 2 },
      ],
      dialogName: null,
      activeMarkers: [],
    };
    const withAlert = {
      structure: [
        { role: 'heading', name: 'Orders', depth: 1 },
        { role: 'alert', name: 'Email is required', depth: 2 },
      ],
      dialogName: null,
      activeMarkers: [],
    };
    expect(structuralDigest(withSpinner)).toBe(structuralDigest(page(['Orders'])));
    expect(structuralDigest(withAlert)).not.toBe(structuralDigest(page(['Orders'])));
  });

  it('normalises a name without losing what distinguishes it', () => {
    expect(normaliseStructureName('  Order   #1001  placed 2 minutes ago ')).toBe(
      'order ## placed <ago>',
    );
  });

  it('gives the same tab clicked twice ONE signature', () => {
    const snapshot = {
      url: 'https://app.test/dash',
      title: 'Dash',
      structure: [{ role: 'heading', name: 'Billing', depth: 1 }],
      dialogName: null,
      activeMarkers: ['Billing'],
      statusCode: 200,
      isErrorPage: false,
    };
    const first = stateSignatureOf(snapshot, 'PATH', DEFAULT_CRAWL_POLICY, primitives);
    const second = stateSignatureOf({ ...snapshot }, 'PATH', DEFAULT_CRAWL_POLICY, primitives);
    expect(first.id).toBe(second.id);
    expect(first.route).toBe('/dash');
  });
});

// ─── SPA and hash routes ────────────────────────────────────────────────────

describe('detectRouteMode', () => {
  it('refuses to decide from one URL', () => {
    // The task's rule: detect it, do not guess from one URL. UNDETERMINED is a
    // real answer, and the guess is unfalsifiable in both directions.
    const decided = detectRouteMode(['https://app.test/#/orders']);
    expect(decided.mode).toBe('UNDETERMINED');
    expect(decided.why).toContain('one URL cannot');
  });

  it('detects a hash-routed app from two route-like hashes under one path', () => {
    expect(detectRouteMode(['https://a.test/#/orders', 'https://a.test/#/customers']).mode).toBe(
      'HASH',
    );
  });

  it('calls it MIXED when hash routes span several pathnames', () => {
    expect(
      detectRouteMode([
        'https://a.test/app/#/orders',
        'https://a.test/admin/#/users',
        'https://a.test/admin/#/roles',
      ]).mode,
    ).toBe('MIXED');
  });

  it('calls it PATH when the pathnames vary and no hash repeats', () => {
    expect(detectRouteMode(['https://a.test/orders', 'https://a.test/customers']).mode).toBe(
      'PATH',
    );
  });

  it('is not fooled by a string that is not a URL', () => {
    expect(detectRouteMode(['not a url', 'also not']).mode).toBe('UNDETERMINED');
  });
});

describe('routeIdentity', () => {
  const id = (url: string, mode: RouteMode, policy = DEFAULT_CRAWL_POLICY) =>
    routeIdentity(url, mode, policy, primitives);

  it('KEEPS the hash route — the defect that made a hash-routed app one node', () => {
    /*
     * crawler.ts:356 sets `target.hash = ''` BEFORE dedupe, so every URL in a
     * Vue/Angular-useHash app normalises to the same string and the whole
     * application enumerates as exactly ONE node.
     */
    expect(id('https://a.test/#/orders', 'HASH').route).toBe('/#/orders');
    expect(id('https://a.test/#/orders', 'HASH').identity).not.toBe(
      id('https://a.test/#/customers', 'HASH').identity,
    );
  });

  it('normalises the hash route, so #/orders/1001 and #/orders/1002 are one template', () => {
    expect(id('https://a.test/#/orders/1001', 'HASH').route).toBe('/#/orders/:id');
    expect(id('https://a.test/#/orders/ORD-4411', 'HASH').route).toBe('/#/orders/:id');
  });

  it('does not invent a parameter inside a hash NAME', () => {
    // `#home` is a name, not a path; collapsing a segment of it would claim a
    // router parameter the application does not have.
    expect(id('https://a.test/dash#home', 'HASH').route).toBe('/dash#home');
  });

  it('drops a bare in-page anchor in PATH mode and keeps a route-like one', () => {
    expect(id('https://a.test/docs#installation', 'PATH').route).toBe('/docs');
    expect(id('https://a.test/docs#/installation', 'PATH').route).toBe('/docs#/installation');
  });

  it('drops a bare anchor when the mode is UNDETERMINED, because the SYNTAX decides', () => {
    expect(id('https://a.test/docs#features', 'UNDETERMINED').route).toBe('/docs');
    expect(id('https://a.test/docs#/features', 'UNDETERMINED').route).toBe('/docs#/features');
  });

  it('strips the ignored query parameters and DISCLOSES which it stripped', () => {
    const result = id('https://a.test/p?utm_source=x&gclid=y&page=2', 'PATH');
    expect(result.identity).toBe('/p?page=2');
    expect(result.queryDropped).toEqual(['utm_source', 'gclid']);
  });

  it('sorts the surviving query, so ?b=1&a=2 and ?a=2&b=1 are one state', () => {
    expect(id('https://a.test/p?b=1&a=2', 'PATH').identity).toBe(
      id('https://a.test/p?a=2&b=1', 'PATH').identity,
    );
  });

  it('normalises the path with the REAL crawler normaliser', () => {
    expect(id('https://a.test/orders/ORD-1001/items/7', 'PATH').route).toBe(
      '/orders/:id/items/:id',
    );
  });
});

// ─── Formless field extraction ──────────────────────────────────────────────

describe('fieldGroupsFrom', () => {
  const context = { route: '/signup', primitives };

  it('produces a FormModel for a controlled React form with no <form> element', () => {
    /*
     * THE DEFECT: crawler.ts:141 reads fields inside `page.locator('form')`, so
     * a controlled React app renders ZERO FormModels — no field semantics, and
     * UNSUBMITTED_FORM can never fire because there is no form to fire about.
     */
    const forms = fieldGroupsFrom(
      [
        raw({
          ref: 'r0',
          tag: 'input',
          type: 'email',
          name: 'email',
          label: 'Email',
          landmark: 'main',
        }),
        raw({
          ref: 'r1',
          tag: 'input',
          type: 'password',
          name: 'password',
          label: 'Password',
          landmark: 'main',
        }),
        raw({ ref: 'r2', tag: 'button', text: 'Sign in', landmark: 'main' }),
      ],
      context,
    );
    expect(forms).toHaveLength(1);
    expect(forms[0]?.fields.map((field) => field.semantic)).toEqual(['email', 'password']);
    expect(forms[0]?.submit?.name).toBe('Sign in');
  });

  it('captures the real constraints, which every boundary test needs', () => {
    const forms = fieldGroupsFrom(
      [
        raw({
          ref: 'r0',
          tag: 'input',
          type: 'text',
          name: 'coupon',
          landmark: 'main',
          required: true,
          constraints: {
            maxLength: 10,
            minLength: 3,
            pattern: '[A-Z0-9]+',
            min: '2024-01-01',
            max: '2026-12-31',
            step: '0.01',
            inputMode: 'numeric',
            autocomplete: 'off',
          },
        }),
      ],
      context,
    );
    const field = forms[0]?.fields[0];
    expect(field?.maxLength).toBe(10);
    expect(field?.minLength).toBe(3);
    expect(field?.pattern).toBe('[A-Z0-9]+');
    // Strings, not numbers: min="2024-01-01" on a date input is not a number,
    // and parsing here would throw the date cases away.
    expect(field?.min).toBe('2024-01-01');
    expect(field?.step).toBe('0.01');
    expect(field?.required).toBe(true);
  });

  it('reports a MISSING submit as null, which is what UNSUBMITTED_FORM needs', () => {
    const forms = fieldGroupsFrom(
      [raw({ ref: 'r0', tag: 'input', type: 'text', name: 'q', landmark: 'main' })],
      context,
    );
    expect(forms[0]?.submit).toBeNull();
  });

  it('groups by the fieldset legend first, then by the landmark', () => {
    const forms = fieldGroupsFrom(
      [
        raw({
          ref: 'r0',
          tag: 'input',
          type: 'text',
          name: 'card',
          fieldset: 'Payment',
          landmark: 'main',
        }),
        raw({ ref: 'r1', tag: 'input', type: 'text', name: 'city', landmark: 'main' }),
        raw({ ref: 'r2', tag: 'input', type: 'text', name: 'search', landmark: 'banner' }),
      ],
      context,
    );
    expect(forms.map((form) => form.name).sort()).toEqual([
      'Fields in Payment',
      'Fields in banner',
      'Fields in main',
    ]);
  });

  it('leaves fields that ARE inside a <form> to crawler.ts, so nothing is double-counted', () => {
    expect(
      fieldGroupsFrom(
        [raw({ ref: 'r0', tag: 'input', type: 'text', name: 'q', formIndex: 0, landmark: 'main' })],
        context,
      ),
    ).toEqual([]);
  });

  it('ignores a hidden field and a submit input', () => {
    expect(
      fieldGroupsFrom(
        [
          raw({ ref: 'r0', tag: 'input', type: 'text', name: 'q', hidden: true }),
          raw({ ref: 'r1', tag: 'input', type: 'hidden', name: 'csrf' }),
          raw({ ref: 'r2', tag: 'input', type: 'submit' }),
        ],
        context,
      ),
    ).toEqual([]);
  });

  it('keeps a select’s options, and names a group with no landmark honestly', () => {
    const forms = fieldGroupsFrom(
      [raw({ ref: 'r0', tag: 'select', name: 'country', options: ['UK', 'US'] })],
      context,
    );
    expect(forms[0]?.name).toBe('Fields outside any landmark');
    expect(forms[0]?.fields[0]?.options).toEqual(['UK', 'US']);
  });
});

// ─── Budget bookkeeping ─────────────────────────────────────────────────────

describe('budget disclosure helpers', () => {
  it('reports only the budgets that bit, and sums what they cost', () => {
    const bites = [
      {
        budget: 'INTERACTION_BUDGET' as const,
        limit: 10,
        bites: 0,
        discarded: 0,
        scope: null,
        reason: 'x',
      },
      {
        budget: 'PER_NODE_INTERACTION_BUDGET' as const,
        limit: 2,
        bites: 3,
        discarded: 7,
        scope: '/a',
        reason: 'y',
      },
    ];
    expect(budgetsThatBit(bites)).toHaveLength(1);
    expect(discardedByBudgets(bites)).toBe(7);
  });
});

describe('describeReplay', () => {
  it('renders the path a human would write in the test', () => {
    expect(
      describeReplay({
        steps: [
          {
            kind: 'GOTO',
            target: 'https://a.test/orders',
            label: 'https://a.test/orders',
            selector: null,
          },
          {
            kind: 'FILL',
            target: '/orders::main::searchbox::Search::',
            label: 'Search',
            selector: null,
            value: 'qaai',
          },
          {
            kind: 'CLICK',
            target: '/orders::main::button::Filters::',
            label: 'Filters',
            selector: null,
          },
        ],
        verified: true,
        divergedTo: null,
        strategy: 'REPLAY',
      }),
    ).toBe('open https://a.test/orders → type "qaai" into Search → click "Filters"');
  });
});

// ─── The traversal ──────────────────────────────────────────────────────────

describe('exploreInteractions', () => {
  const heading = (name: string): RawStructureNode[] => [{ role: 'heading', name, depth: 1 }];

  it('finds the state behind a button and records the path that reaches it', async () => {
    const { surface } = fakeSurface({
      orders: {
        url: 'https://app.test/orders',
        structure: heading('Orders'),
        controls: [
          raw({
            ref: 'r0',
            text: 'Filters',
            ariaExpanded: 'false',
            ariaControls: 'panel',
            landmark: 'main',
          }),
        ],
        transitions: { r0: 'filtered' },
      },
      filtered: {
        url: 'https://app.test/orders',
        structure: [...heading('Orders'), { role: 'group', name: 'Archived only', depth: 2 }],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/orders'] }),
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.action).toBe('click "Filters"');
    expect(edge.kind).toBe('DISCLOSURE');
    // The replay path is the artefact the Generator needs to write a test that
    // reaches the state, and it is recorded ON THE EDGE.
    expect(edge.replay.steps.map((step) => step.kind)).toEqual(['GOTO', 'CLICK']);
    expect(edge.replay.steps[1]?.target).toBe(edge.controlIdentity);
    expect(edge.replay.verified).toBe(true);
    expect(describeReplay(edge.replay)).toBe('open https://app.test/orders → click "Filters"');
  });

  it('verifies the replay by WALKING it, and does not report a state it could not re-reach', async () => {
    const { surface } = fakeSurface(
      {
        orders: {
          url: 'https://app.test/orders',
          structure: heading('Orders'),
          controls: [raw({ ref: 'r0', text: 'Filters', landmark: 'main' })],
          transitions: { r0: 'filtered' },
        },
        filtered: { url: 'https://app.test/orders', structure: heading('Archived') },
      },
      // The third goto fails: entry registration, then reach(entry), then the
      // reach(child) that would verify the child's path.
      { failGotoAfter: 2 },
    );

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/orders'] }),
    );

    expect(result.stats.replayFailures).toBe(1);
    /*
     * The state is DISCOVERED and UNEXPANDED, so it feeds the lower bound. It
     * is not `unreachable` — we stood in it, so "unknown whether it exists" is
     * the wrong sentence, and filing it there let the crawl be reported
     * CONVERGED with an unexpanded state in it.
     */
    expect(result.frontier.unvisitedQueued).toBe(1);
    expect(result.frontier.atLeastMoreUrls).toBe(1);
    expect(frontierIsConsistent(result.frontier)).toBe(true);
    const child = result.nodes.find((node) => node.interactionDepth === 1);
    expect(child?.replay.verified).toBe(false);
    // STOPPED, not CONVERGED: a state we cannot return to is a state no test
    // can reach, and reporting it as reachable is a promise we cannot keep.
    expect(result.outcome).toBe('STOPPED');
  });

  it('gives the same tab clicked from two states ONE node and two edges', async () => {
    const { surface } = fakeSurface({
      overview: {
        url: 'https://app.test/dash',
        structure: heading('Overview'),
        activeMarkers: ['Overview'],
        controls: [
          raw({ ref: 'r0', role: 'tab', text: 'Overview', landmark: 'main' }),
          raw({ ref: 'r1', role: 'tab', text: 'Billing', landmark: 'main' }),
        ],
        transitions: { r1: 'billing' },
      },
      billing: {
        url: 'https://app.test/dash',
        structure: heading('Billing'),
        activeMarkers: ['Billing'],
        controls: [
          raw({ ref: 'r0', role: 'tab', text: 'Overview', landmark: 'main' }),
          raw({ ref: 'r1', role: 'tab', text: 'Billing', landmark: 'main' }),
        ],
        transitions: { r0: 'overview', r1: 'billing' },
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/dash'] }),
    );

    expect(result.nodes).toHaveLength(2);
    // overview→billing and billing→overview. Clicking the live tab again is a
    // no-op, not a third node.
    expect(result.edges).toHaveLength(2);
    expect(result.stats.noOpInteractions).toBeGreaterThanOrEqual(1);
  });

  it('a hash-routed SPA enumerates as more than one node', async () => {
    // The headline defect, end to end: today this app is ONE node and its
    // coverage denominator is 1.
    const { surface } = fakeSurface({
      orders: {
        url: 'https://app.test/#/orders',
        structure: heading('Orders'),
        controls: [raw({ ref: 'r0', text: 'Customers', landmark: 'main', ariaControls: 'view' })],
        transitions: { r0: 'customers' },
        navigations: { r0: 'PUSH' },
      },
      customers: { url: 'https://app.test/#/customers', structure: heading('Customers') },
      invoices: { url: 'https://app.test/#/invoices', structure: heading('Invoices') },
    });

    const result = await exploreInteractions(
      surface,
      options({
        entryUrls: ['https://app.test/#/orders', 'https://app.test/#/invoices'],
      }),
    );

    expect(result.routeMode).toBe('HASH');
    expect(result.nodes.map((node) => node.route).sort()).toEqual([
      '/#/customers',
      '/#/invoices',
      '/#/orders',
    ]);
    // A client-side navigation is recorded as an edge, with the history kind.
    expect(result.edges[0]?.navigation).toBe('PUSH');
    expect(result.stats.clientNavigations).toBe(1);
  });

  it('replays a path whose click CHANGED the route', async () => {
    /*
     * The case my first implementation got wrong and no test caught: a CLICK
     * step's identity is minted under the route of the page it was found ON,
     * and the replay used to look it up under the route of the state it leads
     * TO. Every path whose click navigated then failed to resolve its control,
     * so every such state was reported unreachable — a whole class of surface
     * lost to a string mismatch, with no error anywhere.
     */
    const { surface } = fakeSurface({
      app: {
        url: 'https://app.test/app',
        structure: heading('App'),
        controls: [
          raw({ ref: 'r0', text: 'Open report', ariaExpanded: 'false', landmark: 'main' }),
        ],
        transitions: { r0: 'report' },
      },
      report: { url: 'https://app.test/reports/2026', structure: heading('Report') },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/app'] }),
    );

    const edge = result.edges[0]!;
    expect(edge.replay.steps[1]?.target).toContain('/app::');
    expect(edge.replay.verified).toBe(true);
    expect(edge.replay.divergedTo).toBeNull();
    expect(result.stats.replayFailures).toBe(0);
    expect(result.outcome).toBe('CONVERGED');
  });

  it('counts a policy-refused CONTROL once, in both ledgers but not twice in the frontier', async () => {
    /*
     * A refused link is two facts — a line in the exclusion ledger (grouped by
     * rule) and a held-out surface (named in the inventory) — and ONE refused
     * thing. Adding the two lists inflates the single number whose only job is
     * to be defensible.
     */
    const { surface } = fakeSurface({
      app: {
        url: 'https://app.test/app',
        structure: heading('App'),
        controls: [
          raw({
            ref: 'r0',
            tag: 'a',
            text: 'Log out',
            href: 'https://app.test/logout',
            landmark: 'banner',
          }),
        ],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/app'] }),
    );

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.rule).toBe('excludeGlobs: /logout');
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.exercise.rule).toBe('excludeGlobs: /logout');
    expect(result.frontier.excluded).toBe(1);
  });

  it('records a refused control as a named, held-out surface rather than dropping it', async () => {
    const { surface, clicks } = fakeSurface({
      order: {
        url: 'https://app.test/orders/1001',
        structure: heading('Order'),
        controls: [
          raw({ ref: 'r0', text: 'Delete order', landmark: 'main' }),
          raw({ ref: 'r1', text: 'Sign out', landmark: 'banner' }),
        ],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/orders/1001'] }),
    );

    expect(clicks).toEqual([]);
    expect(result.refusals).toHaveLength(2);
    const destructive = result.refusals.find((entry) => entry.label === 'Delete order')!;
    expect(destructive.exercise.state).toBe('REFUSED');
    expect(destructive.exercise.rule).toBe('allowDestructive: false');
    expect(parseSurfaceKey(destructive.surfaceItemKey)).toEqual({
      kind: 'COMPONENT_STATE',
      identity: destructive.identity,
    });
    const session = result.refusals.find((entry) => entry.label === 'Sign out')!;
    expect(session.exercise.state).toBe('UNEXERCISABLE');
    expect(session.exercise.reason).toBe('SESSION_ENDING');
    // Both are still SIGHTINGS: counted, named, and not driven.
    expect(result.controls.filter((sighting) => sighting.exercise !== null)).toHaveLength(2);
    expect(result.controls.every((sighting) => !sighting.exercised)).toBe(true);
  });

  it('discloses the per-state interaction budget as a COUNT and a reason', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [
          raw({ ref: 'r0', text: 'A', ariaControls: 'a', landmark: 'main' }),
          raw({ ref: 'r1', text: 'B', landmark: 'main' }),
          raw({ ref: 'r2', text: 'C', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(surface, options({ perNodeInteractionBudget: 1 }));

    const bite = result.budgets.find((entry) => entry.budget === 'PER_NODE_INTERACTION_BUDGET')!;
    expect(bite.limit).toBe(1);
    expect(bite.bites).toBe(1);
    // The number that matters: "at least 2 more existed".
    expect(bite.discarded).toBe(2);
    expect(result.frontier.atLeastMoreUrls).toBe(2);
    expect(frontierIsConsistent(result.frontier)).toBe(true);
    expect(result.outcome).toBe('STOPPED');
    expect(result.why).toContain('per-state interaction budget');
    // The invariant that keeps "converged" honest: a budget that cost 2
    // candidates cannot coexist with a lower bound of 0.
    expect(budgetsFeedTheFrontier(result)).toBe(true);
    // The highest-scoring candidate is the one that was kept.
    expect(result.controls.find((sighting) => sighting.exercised)?.label).toBe('A');
  });

  it('discloses the global interaction budget', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [
          raw({ ref: 'r0', text: 'A', landmark: 'main' }),
          raw({ ref: 'r1', text: 'B', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(surface, options({ interactionBudget: 1 }));

    const bite = result.budgets.find((entry) => entry.budget === 'INTERACTION_BUDGET')!;
    expect(bite.discarded).toBe(1);
    expect(result.outcome).toBe('STOPPED');
    expect(budgetsFeedTheFrontier(result)).toBe(true);
    expect(result.frontier.atLeastMoreUrls).toBeGreaterThanOrEqual(1);
  });

  it('discloses the depth cap as a CapBite with what it discarded', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [
          raw({ ref: 'r0', text: 'A', landmark: 'main' }),
          raw({ ref: 'r1', text: 'B', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(surface, options({ maxInteractionDepth: 0 }));

    const bite = result.caps.find((entry) => entry.cap === 'DEPTH')!;
    expect(bite.limit).toBe(0);
    expect(bite.discarded).toBe(2);
    expect(bite.scope).toBe('/');
    expect(result.edges).toEqual([]);
    expect(result.outcome).toBe('STOPPED');
  });

  it('discloses the per-page control cap, which crawler.ts applied SILENTLY at 20', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [
          raw({ ref: 'r0', text: 'A', landmark: 'main' }),
          raw({ ref: 'r1', text: 'B', landmark: 'main' }),
          raw({ ref: 'r2', text: 'C', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(surface, options({ controlsPerPage: 1 }));

    const bite = result.caps.find((entry) => entry.cap === 'AFFORDANCES_PER_PAGE')!;
    expect(bite.limit).toBe(1);
    expect(bite.discarded).toBe(2);
    expect(bite.reason).toContain('at least 2 more existed');
  });

  it('discloses the wall clock, and does not call a timed-out crawl converged', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [raw({ ref: 'r0', text: 'A', landmark: 'main' })],
        transitions: { r0: 'next' },
      },
      next: { url: 'https://app.test/next', structure: heading('Next') },
    });

    let ticks = 0;
    const result = await exploreInteractions(
      surface,
      // Expires only after the first state has been expanded, so there is
      // something left in the queue for the cap to discard.
      options({ wallClockMillis: 1_000, now: () => (ticks++ < 2 ? 0 : 5_000) }),
    );

    const bite = result.caps.find((entry) => entry.cap === 'WALL_CLOCK')!;
    expect(bite.discarded).toBeGreaterThan(0);
    expect(result.outcome).toBe('STOPPED');
    expect(result.frontier.atLeastMoreUrls).toBeGreaterThan(0);
  });

  it('claims CONVERGED only when the frontier is empty and nothing bit', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [raw({ ref: 'r0', text: 'Filters', ariaControls: 'p', landmark: 'main' })],
        transitions: { r0: 'open' },
      },
      open: { url: 'https://app.test/', structure: heading('Filters open') },
    });

    const result = await exploreInteractions(surface, options());

    expect(result.caps).toEqual([]);
    expect(result.budgets).toEqual([]);
    expect(result.frontier.atLeastMoreUrls).toBe(0);
    expect(result.outcome).toBe('CONVERGED');
  });

  it('is FAILED, not an empty success, when the surface cannot click', async () => {
    /*
     * The single most flattering lie available here: "0 states behind controls"
     * from a harness that cannot click reads as "this app has nothing behind a
     * button", and the coverage percentage goes UP.
     */
    const { surface } = fakeSurface(
      { home: { url: 'https://app.test/', controls: [raw({ ref: 'r0', text: 'A' })] } },
      { capabilities: ['GOTO', 'SNAPSHOT', 'CONTROLS'] },
    );

    const result = await exploreInteractions(surface, options());

    expect(result.outcome).toBe('FAILED');
    expect(result.why).toContain('CLICK');
    expect(result.nodes).toEqual([]);
    expect(result.unavailable.map((gap) => gap.capability)).toContain('CLICK');
  });

  it('reports an unobservable client navigation count as NULL, never as zero', async () => {
    const { surface } = fakeSurface(
      { home: { url: 'https://app.test/', structure: heading('Home') } },
      {
        capabilities: ['CLICK', 'GOTO', 'SNAPSHOT', 'CONTROLS', 'FILL', 'NAVIGATION_STATUS'],
      },
    );

    const result = await exploreInteractions(surface, options());

    expect(result.stats.clientNavigations).toBeNull();
    const gap = result.unavailable.find((entry) => entry.capability === 'HISTORY_HOOK')!;
    expect(gap.cost).toContain('UNKNOWN');
  });

  it('writes a null status rather than assuming 200 when the surface cannot read one', async () => {
    const { surface } = fakeSurface(
      { home: { url: 'https://app.test/', structure: heading('Home') } },
      { capabilities: ['CLICK', 'GOTO', 'SNAPSHOT', 'CONTROLS'] },
    );

    const result = await exploreInteractions(surface, options());

    const node = result.nodes[0]!;
    expect(node.status?.code).toBeNull();
    expect(statusClassFor(node.status?.code)).toBe('UNKNOWN');
    // And the generator refuses to write a happy-path test against it, rather
    // than assuming the page was healthy.
    expect(shouldGenerateAgainst(node)).toBe(false);
  });

  it('keeps a 404 state in the graph and out of happy-path generation', async () => {
    const { surface } = fakeSurface({
      missing: {
        url: 'https://app.test/nope',
        structure: heading('Not found'),
        status: 404,
        isErrorPage: true,
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/nope'] }),
    );

    expect(result.nodes[0]?.status).toEqual({
      code: 404,
      class: 'CLIENT_ERROR',
      isErrorPage: true,
    });
    expect(shouldGenerateAgainst(result.nodes[0]!)).toBe(false);
  });

  it('records an off-origin landing as an ORIGIN, with no query string anywhere', async () => {
    const { surface } = fakeSurface({
      login: {
        url: 'https://app.test/login',
        structure: heading('Sign in'),
        controls: [
          raw({
            ref: 'r0',
            tag: 'a',
            text: 'Continue with SSO',
            href: 'https://idp.example/authorize?state=SECRET-TOKEN&login_hint=a@b.test',
            landmark: 'main',
          }),
        ],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/login'] }),
    );

    expect(result.externals).toEqual([
      {
        kind: 'LINK',
        origin: 'https://idp.example',
        fromRoute: '/login',
        samplePath: '/authorize',
        occurrences: 1,
      },
    ]);
    // There is no version of this product that needs an IdP state token stored.
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(result)).not.toContain('login_hint');
    expect(result.frontier.offOrigin).toBe(1);
  });

  it('puts a policy-refused entry URL in the exclusion ledger with the rule', async () => {
    const { surface } = fakeSurface({
      home: { url: 'https://app.test/', structure: heading('Home') },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/', 'https://app.test/logout'] }),
    );

    expect(result.excluded).toEqual([
      {
        url: 'https://app.test/logout',
        route: '/logout',
        kind: 'POLICY_EXCLUDE',
        rule: 'excludeGlobs: /logout',
        discoveredFrom: null,
      },
    ]);
    // A refused surface is KNOWN by name, so it is NOT part of "more existed".
    expect(result.frontier.excluded).toBe(1);
    expect(result.frontier.atLeastMoreUrls).toBe(0);
  });

  it('records a click that changes nothing as a no-op, not as a new state', async () => {
    const { surface } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [raw({ ref: 'r0', text: 'Refresh', landmark: 'main' })],
      },
    });

    const result = await exploreInteractions(surface, options());

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    expect(result.stats.noOpInteractions).toBe(1);
    const sighting = result.controls[0]!;
    expect(sighting.exercised).toBe(true);
    expect(sighting.leadsTo).toBeNull();
  });

  it('types the probe before a search submit and puts the FILL on the replay path', async () => {
    const { surface, fills } = fakeSurface({
      products: {
        url: 'https://app.test/products',
        structure: heading('Products'),
        controls: [
          raw({
            ref: 'q',
            tag: 'input',
            type: 'search',
            name: 'q',
            ariaLabel: 'Search products',
            landmark: 'main',
            formIndex: 0,
          }),
          raw({
            ref: 'go',
            tag: 'button',
            type: 'submit',
            text: 'Search',
            landmark: 'main',
            formIndex: 0,
          }),
        ],
        transitions: { go: 'results' },
      },
      results: { url: 'https://app.test/products?q=qaai', structure: heading('1 result') },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/products'] }),
    );

    expect(fills).toEqual([
      { ref: 'q', value: 'qaai' },
      // Once more on the replay walk that verifies the path.
      { ref: 'q', value: 'qaai' },
    ]);
    const edge = result.edges[0]!;
    expect(edge.kind).toBe('SEARCH_SUBMIT');
    expect(edge.replay.steps.map((step) => step.kind)).toEqual(['GOTO', 'FILL', 'CLICK']);
    expect(edge.replay.steps[1]?.value).toBe('qaai');
    expect(edge.replay.verified).toBe(true);
  });

  it('stops following pagination after the per-template budget and says so', async () => {
    const page = (n: number, next: string | null): FakePage => ({
      url: n === 1 ? 'https://app.test/products' : `https://app.test/products?page=${n}`,
      structure: heading(`Products page ${n}`),
      controls: [raw({ ref: 'r0', text: 'Next', landmark: 'navigation' })],
      ...(next === null ? {} : { transitions: { r0: next } }),
    });
    const { surface } = fakeSurface({
      p1: page(1, 'p2'),
      p2: page(2, 'p3'),
      p3: page(3, 'p4'),
      p4: page(4, null),
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/products'], maxPaginationFollow: 2 }),
    );

    const bite = result.caps.find((entry) => entry.cap === 'PER_TEMPLATE_BUDGET')!;
    expect(bite.limit).toBe(2);
    expect(bite.scope).toBe('/products');
    expect(bite.discarded).toBeGreaterThan(0);
    expect(result.outcome).toBe('STOPPED');
  });

  it('records an in-app LINK without clicking it, because the URL crawl owns it', async () => {
    /*
     * Both halves matter. Recording it is the control denominator — crawler.ts
     * never put a link in `affordances` at all, which is why the 'link' member
     * of that vocabulary had no producer. NOT clicking it is the division of
     * labour: the URL crawl follows hrefs, and clicking them here would record
     * the same traversal twice and spend the interaction budget on it.
     */
    const { surface, clicks } = fakeSurface({
      home: {
        url: 'https://app.test/',
        structure: heading('Home'),
        controls: [
          raw({
            ref: 'r0',
            tag: 'a',
            text: 'Orders',
            href: 'https://app.test/orders',
            landmark: 'navigation',
          }),
        ],
      },
    });

    const result = await exploreInteractions(surface, options());

    expect(clicks).toEqual([]);
    expect(result.edges).toEqual([]);
    const sighting = result.controls[0]!;
    expect(sighting.kind).toBe('LINK');
    expect(sighting.affordanceKind).toBe('link');
    expect(sighting.exercised).toBe(false);
    // Not a refusal either: nothing refused it, another pass owns it.
    expect(sighting.exercise).toBeNull();
    expect(result.refusals).toEqual([]);
    expect(result.nodes[0]?.affordances[0]?.kind).toBe('link');
    expect(result.outcome).toBe('CONVERGED');
  });

  it('attaches formless field groups to the state they were found on', async () => {
    const { surface } = fakeSurface({
      signup: {
        url: 'https://app.test/signup',
        structure: heading('Sign up'),
        controls: [
          raw({
            ref: 'r0',
            tag: 'input',
            type: 'email',
            name: 'email',
            label: 'Email',
            landmark: 'main',
          }),
          raw({ ref: 'r1', tag: 'div', role: 'button', text: 'Create account', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/signup'] }),
    );

    expect(result.formlessForms).toHaveLength(1);
    expect(result.formlessForms[0]?.stateId).toBe(result.nodes[0]?.signature.id);
    expect(result.formlessForms[0]?.forms[0]?.fields[0]?.semantic).toBe('email');
  });

  it('keeps BOTH same-named controls in the affordance list, keyed on identity', async () => {
    const { surface } = fakeSurface({
      order: {
        url: 'https://app.test/orders/1001',
        structure: heading('Order'),
        controls: [
          raw({ ref: 'r0', text: 'Edit', landmark: 'banner' }),
          raw({ ref: 'r1', text: 'Edit', landmark: 'main' }),
          raw({ ref: 'r2', tag: 'input', type: 'text', name: 'note', landmark: 'main' }),
        ],
      },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/orders/1001'] }),
    );

    const affordances = result.nodes[0]!.affordances;
    // crawler.ts keyed the first sighting by LABEL, so the second "Edit" was
    // dropped — and it recorded no inputs at all.
    expect(affordances.filter((entry) => entry.label === 'Edit')).toHaveLength(2);
    expect(affordances.filter((entry) => entry.kind === 'input')).toHaveLength(1);
    expect(result.stats.controlsSeen).toBe(3);
  });

  it('normalises the route of an interaction state with the real normaliser', async () => {
    const { surface } = fakeSurface({
      order: { url: 'https://app.test/orders/ORD-1001', structure: heading('Order') },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/orders/ORD-1001'] }),
    );

    expect(result.nodes[0]?.route).toBe('/orders/:id');
    // stateKey is the digest, so the readers that group by it keep working.
    expect(result.nodes[0]?.stateKey).toBe(result.nodes[0]?.signature.digest);
  });

  it('marks a state behind an auth bounce, and does not guess when there was no request', async () => {
    const { surface } = fakeSurface({
      app: {
        url: 'https://app.test/app',
        structure: heading('App'),
        controls: [raw({ ref: 'r0', text: 'Admin', ariaControls: 'x', landmark: 'main' })],
        transitions: { r0: 'login' },
      },
      login: { url: 'https://app.test/login', structure: heading('Sign in') },
    });

    const result = await exploreInteractions(
      surface,
      options({ entryUrls: ['https://app.test/app'] }),
    );

    expect(result.nodes.find((node) => node.route === '/login')?.behindAuth).toBe(true);
    expect(result.nodes.find((node) => node.route === '/app')?.behindAuth).toBe(false);
  });

  it('reports nothing measured when there is nothing to measure', async () => {
    const { surface } = fakeSurface({});
    const result = await exploreInteractions(surface, options({ entryUrls: [] }));
    expect(result.outcome).toBe('FAILED');
    expect(result.why).toContain('no page');
    expect(result.frontier.atLeastMoreUrls).toBe(0);
  });
});

// ─── A mini application with real state, not authored transitions ────────────

/**
 * WHY A SECOND FAKE, when `fakeSurface` above already builds a page graph.
 *
 * `fakeSurface` maps a ref to a DESTINATION PAGE, so every transition is
 * authored: the fixture decides that clicking `r0` from `p1` lands on `p2`,
 * and the two pages are distinguishable because the author wrote them that
 * way. That proves the traversal and it cannot prove the thing underneath it —
 * whether `stateSignatureOf` MERGES two genuinely different views of one
 * application. The pagination fixture above is the demonstration: it passes
 * because each page carries `?page=n` in the URL, and a client-side pager does
 * not.
 *
 * So this one holds mutable state. `controls()` is computed from it and
 * `click()` mutates it, exactly as a browser does, and no transition is
 * written down anywhere. Everything below is driven through the real
 * `exploreInteractions` against it.
 */
type MiniCtrl = Partial<RawControl> & { ref: string };

/** What a real adapter measures: `nth` over the page's own read. */
function withNth(list: RawControl[]): RawControl[] {
  const keyOf = (c: RawControl): string =>
    `${c.role ?? implicitRole(c.tag, c.type) ?? c.tag}::${accessibleName(c)}`;
  const counts = new Map<string, number>();
  for (const c of list) counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return list.map((c) => {
    const key = keyOf(c);
    if ((counts.get(key) ?? 0) < 2) return c;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...c, nth: n };
  });
}

type MiniRoute = 'dashboard' | 'orders' | 'wizard' | 'settings';
const MINI_TABS = ['Overview', 'Activity', 'Notes'] as const;
const MINI_STEPS = ['Shipping address', 'Payment method', 'Review and place'] as const;
const MINI_ENTRY = [
  'https://app.test/#/dashboard',
  'https://app.test/#/orders',
  'https://app.test/#/wizard',
  'https://app.test/#/settings',
];

function miniApp(
  config: {
    /** False: the wizard's steps differ only by the step NUMBER. */
    distinctWizardSteps?: boolean;
    /** True: the pager puts the page in the URL, as a server-rendered list does. */
    pageInUrl?: boolean;
    /** True: nothing is ever disabled, so a disabled control is the only variable. */
    nothingDisabled?: boolean;
  } = {},
) {
  const distinctSteps = config.distinctWizardSteps ?? true;
  const app = {
    route: 'dashboard' as MiniRoute,
    tab: 0,
    modal: false,
    accordion: false,
    step: 1,
    page: 1,
    query: '',
    deletes: 0,
    logouts: 0,
    resets: 0,
  };
  const clicks: string[] = [];
  let pendingFill = '';

  const mini = (c: MiniCtrl): RawControl => raw({ ...c, cssPath: `body [data-ref=${c.ref}]` });

  const url = (): string =>
    app.route === 'orders' && config.pageInUrl === true && app.page > 1
      ? `https://app.test/?page=${app.page}#/orders`
      : `https://app.test/#/${app.route}`;

  const controlsNow = (): RawControl[] => {
    const out: RawControl[] = [
      ...(['dashboard', 'orders', 'wizard', 'settings'] as MiniRoute[]).map((r) =>
        mini({
          ref: `nav-${r}`,
          tag: 'a',
          text: r[0]!.toUpperCase() + r.slice(1),
          href: `https://app.test/#/${r}`,
          landmark: 'navigation',
        }),
      ),
      mini({
        ref: 'logout',
        tag: 'a',
        text: 'Log out',
        href: 'https://app.test/logout',
        landmark: 'navigation',
      }),
      // The mobile menu toggle, `hidden` at this viewport. A real control that
      // is not interactive in the state we read it in — the same class of thing
      // as the disabled pager button, and it used to be dropped uncounted too.
      mini({ ref: 'mobile-menu', text: 'Menu', landmark: 'navigation', hidden: true }),
    ];
    if (app.route === 'dashboard') {
      MINI_TABS.forEach((t, i) =>
        out.push(
          mini({
            ref: `tab-${i}`,
            role: 'tab',
            text: t,
            landmark: 'main',
            ...(i === app.tab ? { ariaCurrent: 'true' } : {}),
          }),
        ),
      );
      out.push(
        mini({ ref: 'open-report', text: 'Open report', ariaHasPopup: 'dialog', landmark: 'main' }),
      );
      if (app.modal) out.push(mini({ ref: 'close', text: 'Close', landmark: 'dialog' }));
    }
    if (app.route === 'orders') {
      out.push(
        mini({
          ref: 'q',
          tag: 'input',
          type: 'text',
          name: 'q',
          label: 'Search orders',
          landmark: 'main',
          formIndex: 0,
        }),
        mini({
          ref: 'search',
          type: 'submit',
          text: 'Search',
          name: 'search',
          landmark: 'main',
          formIndex: 0,
        }),
        mini({ ref: 'delete', text: 'Delete order', landmark: 'main' }),
        mini({ ref: 'next', text: 'Next', landmark: 'pagination' }),
        mini({
          ref: 'prev',
          text: 'Previous',
          landmark: 'pagination',
          disabled: config.nothingDisabled === true ? false : app.page === 1,
        }),
      );
    }
    if (app.route === 'wizard') {
      out.push(
        app.step < 3
          ? mini({ ref: 'continue', text: 'Continue', landmark: 'main' })
          : mini({ ref: 'finish', text: 'Finish', landmark: 'main' }),
      );
      if (app.step > 1) out.push(mini({ ref: 'back', text: 'Back', landmark: 'main' }));
    }
    if (app.route === 'settings') {
      out.push(
        mini({
          ref: 'adv',
          text: 'Advanced',
          ariaExpanded: app.accordion ? 'true' : 'false',
          ariaControls: 'adv-panel',
          landmark: 'main',
        }),
        mini({
          ref: 'digest',
          tag: 'input',
          type: 'email',
          name: 'digest',
          label: 'Email digest',
          fieldset: 'Notifications',
          landmark: 'main',
          constraints: { maxLength: 120 },
        }),
        mini({
          ref: 'hook',
          tag: 'input',
          type: 'url',
          name: 'hook',
          label: 'Slack webhook',
          fieldset: 'Notifications',
          landmark: 'main',
        }),
      );
      if (app.accordion) out.push(mini({ ref: 'reset', text: 'Reset defaults', landmark: 'main' }));
    }
    return withNth(out);
  };

  const structureNow = (): RawStructureNode[] => {
    const h = (name: string, depth = 1): RawStructureNode => ({ role: 'heading', name, depth });
    const t = (name: string): RawStructureNode => ({ role: 'text', name, depth: 2 });
    if (app.route === 'dashboard') {
      return [
        h('Dashboard'),
        { role: 'region', name: `${MINI_TABS[app.tab]} panel`, depth: 2 },
        { role: 'status', name: 'Saved 2 minutes ago', depth: 2 },
      ];
    }
    if (app.route === 'orders') {
      const start = 1000 + (app.page - 1) * 5;
      const rows: RawStructureNode[] = [];
      for (let i = 0; i < 5; i += 1) {
        rows.push({
          role: 'row',
          name: `ORD-${start + i} $${40 + i}.00 2026-10-0${i + 1}`,
          depth: 3,
        });
      }
      return [
        h('Orders'),
        ...(app.query === '' ? [] : [t(`Results for "${app.query}"`)]),
        t(`Page ${app.page} of 5`),
        ...rows,
      ];
    }
    if (app.route === 'wizard') {
      return [
        h('Checkout'),
        t(`Step ${app.step} of 3`),
        ...(distinctSteps ? [h(MINI_STEPS[app.step - 1]!, 2)] : []),
      ];
    }
    return [h('Settings'), ...(app.accordion ? [h('Advanced options', 2)] : [])];
  };

  const surface: InteractionSurface = {
    capabilities: () => [...INTERACTION_CAPABILITIES],
    url,
    async goto(target) {
      const match = /#\/(dashboard|orders|wizard|settings)/.exec(target);
      if (match === null) {
        return { ok: false, url: url(), status: null, error: `no route in ${target}` };
      }
      app.route = match[1] as MiniRoute;
      // A load resets component state, which is what a real reload does and
      // what makes the replay path the only way back to a deep state.
      app.tab = 0;
      app.modal = false;
      app.accordion = false;
      app.step = 1;
      app.page = 1;
      app.query = '';
      return { ok: true, url: url(), status: 200, error: null };
    },
    async back() {
      return { ok: false, url: url(), status: null, error: 'BACK is not the strategy' };
    },
    async snapshot() {
      return {
        url: url(),
        title: `${app.route} — Mini`,
        structure: structureNow(),
        dialogName: app.modal ? 'Report details' : null,
        activeMarkers:
          app.route === 'dashboard'
            ? [MINI_TABS[app.tab]!]
            : app.route === 'orders'
              ? [String(app.page)]
              : [],
        statusCode: 200,
        isErrorPage: false,
      };
    },
    async controls() {
      return controlsNow();
    },
    async click(ref) {
      clicks.push(`${app.route}#${ref}`);
      const tab = /^tab-(\d)$/.exec(ref);
      if (tab !== null) app.tab = Number(tab[1]);
      else if (ref === 'open-report') app.modal = true;
      else if (ref === 'close') app.modal = false;
      else if (ref === 'next') app.page = Math.min(app.page + 1, 5);
      else if (ref === 'prev') app.page = Math.max(app.page - 1, 1);
      else if (ref === 'continue') app.step = Math.min(app.step + 1, 3);
      else if (ref === 'back') app.step = Math.max(app.step - 1, 1);
      else if (ref === 'adv') app.accordion = !app.accordion;
      else if (ref === 'search') app.query = pendingFill;
      else if (ref === 'delete') app.deletes += 1;
      else if (ref === 'reset') app.resets += 1;
      else if (ref === 'logout') app.logouts += 1;
      else if (ref.startsWith('nav-')) app.route = ref.slice(4) as MiniRoute;
      return { ok: true, error: null, navigated: false, status: null };
    },
    async fill(ref, value) {
      pendingFill = value;
      return true;
    },
    async drainNavigations() {
      return [];
    },
  };

  return { surface, app, clicks };
}

async function crawlMini(
  config: Parameters<typeof miniApp>[0] = {},
  overrides: Partial<InteractionCrawlOptions> = {},
) {
  const mini = miniApp(config);
  const result = await exploreInteractions(
    mini.surface,
    options({ entryUrls: MINI_ENTRY, ...overrides }),
  );
  return { ...mini, result };
}

describe('exploreInteractions against an application with real state', () => {
  it('reaches step 3 of the wizard and records the path that gets there', async () => {
    const { result, clicks } = await crawlMini();

    const step3 = result.nodes.find(
      (node) => node.route === '/#/wizard' && node.interactionDepth === 2,
    );
    expect(step3, 'no wizard state two clicks deep').toBeDefined();
    expect(step3!.replay.steps.map((step) => `${step.kind}:${step.label}`)).toEqual([
      'GOTO:https://app.test/#/wizard',
      'CLICK:Continue',
      'CLICK:Continue',
    ]);
    expect(step3!.replay.verified).toBe(true);
    // Step 3 is where "Finish" lives, so reaching it is what makes the last
    // control of the flow visible at all.
    expect(clicks).toContain('wizard#finish');
  });

  it('gives every state it found a replayable path, and verifies each one', async () => {
    const { result } = await crawlMini();

    const entries = new Set(
      result.nodes.filter((node) => node.interactionDepth === 0).map((node) => node.id),
    );
    const reached = new Set(result.edges.map((edge) => edge.to));
    const orphans = result.nodes.filter((node) => !entries.has(node.id) && !reached.has(node.id));
    expect(
      orphans.map((node) => node.id),
      'a state with no edge into it',
    ).toEqual([]);
    expect(result.nodes.every((node) => node.replay.verified)).toBe(true);
    expect(result.edges.every((edge) => edge.replay.verified)).toBe(true);
    // The replay is WALKED, not assumed, so the cost is real and reported.
    expect(result.stats.replays).toBeGreaterThan(result.stats.statesVisited);
  });

  it('gives the same tab reached from three different states ONE node', async () => {
    const { result } = await crawlMini();

    const activity = result.nodes.filter(
      (node) => node.signature.markers.includes('Activity') && node.signature.dialog === null,
    );
    expect(activity).toHaveLength(1);
    expect(result.edges.filter((edge) => edge.to === activity[0]!.id).length).toBeGreaterThan(1);
    // And the modal over that tab is a DIFFERENT state, named rather than hashed.
    expect(
      result.nodes.some(
        (node) =>
          node.signature.markers.includes('Activity') && node.signature.dialog === 'Report details',
      ),
    ).toBe(true);
  });

  it('refuses the delete and the logout, drives neither, and holds both out', async () => {
    const { result, app } = await crawlMini();

    expect(app.deletes, 'a destructive control was clicked').toBe(0);
    expect(app.logouts, 'a session-ending control was clicked').toBe(0);
    expect(app.resets).toBe(0);

    const keys = new Set(result.refusals.map((entry) => entry.surfaceItemKey));
    expect(keys).toContain('COMPONENT_STATE:/#/orders::main::button::Delete order::');
    expect(keys).toContain('COMPONENT_STATE:/#/settings::main::button::Reset defaults::');
    expect(keys).toContain('COMPONENT_STATE:/#/dashboard::navigation::link::Log out::');
    // Held out of the denominator, every one of them: refusing cannot raise
    // the percentage.
    expect(result.refusals.every((entry) => !exercisabilityCounts(entry.exercise.state))).toBe(
      true,
    );
    expect(
      result.refusals.every((entry) =>
        entry.exercise.state === 'REFUSED'
          ? typeof entry.exercise.rule === 'string'
          : typeof entry.exercise.reason === 'string',
      ),
    ).toBe(true);
  });

  it('counts DISTINCT refused surfaces in the frontier, not refusal records', async () => {
    /*
     * A refusal is recorded once per STATE it is seen on, so the "Log out" link
     * in the site nav produces one record per state. The arithmetic used to add
     * the record counts, which read four times too high on this app — in a
     * ledger whose whole job is to be defensible.
     */
    const { result } = await crawlMini();

    const distinct = new Set(result.refusals.map((entry) => entry.surfaceItemKey));
    expect(result.refusals.length).toBeGreaterThan(distinct.size);
    expect(result.frontier.excluded).toBe(distinct.size);
    expect(frontierIsConsistent(result.frontier)).toBe(true);
  });

  it('counts a disabled control instead of erasing it from the denominator', async () => {
    /*
     * `classifyControl` returns null for a disabled element and the null branch
     * dropped it with no sighting, no refusal and no count — so the pager's
     * "Previous", disabled on page 1, existed in the application and nowhere in
     * the report. A count is not the whole remedy (a named held-out surface
     * needs an `UNEXERCISABLE_REASONS` member that does not exist yet) but it
     * is the difference between a disclosed gap and an invisible one.
     */
    const disabled = await crawlMini();
    const enabled = await crawlMini({ nothingDisabled: true });

    expect(disabled.result.stats.disabledControls).toBe(2);
    expect(enabled.result.stats.disabledControls).toBe(0);
    // The hidden sibling: one per state read, and counted rather than dropped.
    expect(disabled.result.stats.hiddenControls).toBe(disabled.result.stats.statesVisited);
    // The enabled run sees two controls the disabled run did not.
    expect(enabled.result.stats.controlsSeen - disabled.result.stats.controlsSeen).toBe(2);
    expect(enabled.result.controls.some((entry) => entry.label === 'Previous')).toBe(true);
  });

  it('does not call a client-side pager inert, and does not call that crawl complete', async () => {
    /*
     * THE HEADLINE DEFECT OF THIS SLICE, and it needs both halves to see.
     *
     * Server-rendered pagination puts the page in the URL, so the identity
     * differs, the pages are enumerated, and the per-template budget bites with
     * a number. A client-side pager touches neither the URL nor anything the
     * digest can see: page 2's five rows normalise to the same single line as
     * page 1's, its "Page 2 of 5" to "page # of #", its aria-current marker to
     * "#". The signature is byte-identical, so `Next` reads as a control that
     * does nothing — and four fifths of the table is neither enumerated nor
     * disclosed, while the crawl reports CONVERGED. That is the truncation that
     * makes the coverage percentage go UP, wearing the word for the opposite.
     */
    const inUrl = await crawlMini({ pageInUrl: true });
    expect(inUrl.result.edges.some((edge) => edge.kind === 'PAGINATION')).toBe(true);
    const bite = inUrl.result.caps.find((entry) => entry.cap === 'PER_TEMPLATE_BUDGET');
    expect(bite?.discarded).toBeGreaterThan(0);
    expect(inUrl.result.frontier.atLeastMoreUrls).toBeGreaterThan(0);
    expect(inUrl.result.outcome).toBe('STOPPED');

    const clientSide = await crawlMini();
    // Still not enumerated — that is a limit of the state digest, not of this
    // assertion — but no longer reported as a measurement that the control is
    // inert, and the report says so in the sentence the caller prints.
    expect(clientSide.result.edges.some((edge) => edge.kind === 'PAGINATION')).toBe(false);
    expect(clientSide.result.stats.indistinguishableInteractions).toBeGreaterThan(0);
    expect(clientSide.result.why).toContain('DECLARE a transition');
    expect(clientSide.result.why).toContain('neither enumerated nor ruled out');
  });

  it('says so when a wizard whose steps differ only by NUMBER collapses', async () => {
    /*
     * The same digest limit one flow over. "Step 1 of 3" and "Step 2 of 3"
     * normalise to "step # of #", so a wizard with a numeric step indicator and
     * no per-step heading is ONE state: Continue reads as inert on the first
     * click, steps 2 and 3 never exist, and `Finish` is never seen. The test
     * that claimed step 2 is a different state from step 1 is true only because
     * its fixture gave each step its own text.
     */
    const numbered = await crawlMini({ distinctWizardSteps: false });

    expect(numbered.result.nodes.filter((node) => node.route === '/#/wizard')).toHaveLength(1);
    expect(numbered.clicks.filter((click) => click === 'wizard#continue')).toHaveLength(1);
    expect(numbered.clicks).not.toContain('wizard#finish');
    // The collapse is not fixed here; what is fixed is that it is NAMED.
    expect(numbered.result.stats.indistinguishableInteractions).toBeGreaterThan(0);
    expect(numbered.result.why).toContain('neither enumerated nor ruled out');

    // And the control-shaped half: with distinct step content it does reach 3.
    const distinct = await crawlMini();
    expect(distinct.result.nodes.filter((node) => node.route === '/#/wizard').length).toBe(3);
  });

  it('records closing a disclosure as an edge back to the parent', async () => {
    /*
     * Worth asserting because the opposite was reported as a gap. Clicking an
     * open accordion shut from the OPEN state lands on the parent signature,
     * which is a known state and not the current one — so it is an edge, and a
     * test that asserts a panel closes has one to be generated from. The no-op
     * branch only fires on a click that lands back on the state it started in.
     */
    const { result } = await crawlMini();

    const settingsClosed = result.nodes.find(
      (node) => node.route === '/#/settings' && node.interactionDepth === 0,
    )!;
    const settingsOpen = result.nodes.find(
      (node) => node.route === '/#/settings' && node.interactionDepth === 1,
    )!;
    expect(
      result.edges.some(
        (edge) =>
          edge.from === settingsOpen.id &&
          edge.to === settingsClosed.id &&
          edge.kind === 'DISCLOSURE',
      ),
    ).toBe(true);
  });

  it('a hash-routed SPA with no path variety still enumerates thirteen states', async () => {
    /*
     * End to end, and the number is the point: `crawler.ts` enumerates this
     * application as ONE node, because it strips the hash before dedupe and
     * never clicks anything. Four routes, three tabs, a modal over each tab, a
     * three-step wizard, an accordion and a search result come to thirteen.
     */
    const { result } = await crawlMini();

    expect(result.routeMode).toBe('HASH');
    expect(result.nodes).toHaveLength(13);
    expect(new Set(result.nodes.map((node) => node.route))).toEqual(
      new Set(['/#/dashboard', '/#/orders', '/#/wizard', '/#/settings']),
    );
    expect(
      result.formlessForms[0]!.forms[0]!.submit,
      'the missing submit is the finding',
    ).toBeNull();
    expect(result.formlessForms[0]!.forms[0]!.fields).toHaveLength(2);
  });
});

describe('refusalFor: the session-ending opt-in', () => {
  it('needs a glob that names the route, exactly as the destructive rule does', () => {
    /*
     * THE DEFECT: a bare `allowDestructive` used to be enough to drive a
     * logout whose path the policy admitted, so one environment switch
     * licensed clicking "Sign out" on every route — while "Delete order" on
     * that same route under that same policy stayed REFUSED for want of a
     * matching glob. The weaker gate guarded the stronger consequence: a
     * destructive click loses one record, a logout makes every state measured
     * after it anonymous.
     */
    const policy = policyWith({
      excludeGlobs: [],
      allowDestructive: true,
      destructiveAllowGlobs: ['/sandbox/**'],
    });

    const held = refusalFor(
      { kind: 'LINK', label: 'Sign out', path: '/account/sign-out' },
      policy,
      '/orders',
    );
    expect(held?.state).toBe('REFUSED');
    expect(held?.rule).toBe('destructiveAllowGlobs: no pattern matched /orders');
    // The sibling rule, same policy, same route: they now agree.
    const destructive = refusalFor(
      { kind: 'BUTTON', label: 'Delete order', path: null },
      policy,
      '/orders',
    );
    expect(destructive?.rule).toBe(held?.rule);

    // And the opt-in still works when the customer names the path.
    const optedIn = refusalFor(
      { kind: 'LINK', label: 'Sign out', path: '/sandbox/sign-out' },
      policyWith({
        excludeGlobs: [],
        allowDestructive: true,
        destructiveAllowGlobs: ['/sandbox/**'],
      }),
      '/sandbox/orders',
    );
    expect(optedIn).toBeNull();
  });
});
