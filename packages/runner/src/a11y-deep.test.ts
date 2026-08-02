/**
 * The properties the deep accessibility checks live or die on:
 *
 *  1. They are OFF unless a spec asked for them, BY NAME. A team that upgrades
 *     and inherits a hundred new findings switches the feature off within a day,
 *     which is worse than never shipping it.
 *  2. Severity is honest. Exactly one thing here is CRITICAL — a keyboard trap
 *     confirmed inescapable — and the same trap released by Escape is not, so a
 *     gate keyed on severity means something.
 *  3. They FAIL OPEN. A check that could not run says so; it never reports a
 *     clean page it did not look at, and it never costs the run its result.
 *  4. THEY DO NOT CRY WOLF. Half of these cases are well-built pages that must
 *     produce nothing at all — a proper modal, a page that honours
 *     prefers-reduced-motion, a two-column row. A checker with false positives
 *     is a checker nobody keeps switched on.
 *
 * Every behavioural claim is proved twice: once against fakes for the judgement
 * calls, and once against a REAL Chromium driving fixture pages with a planted
 * trap, a planted invisible focus ring, a planted unreachable control and a
 * planted animation — because a keyboard walk that only works in a unit test is
 * a keyboard walk nobody should trust.
 */

import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ExecutableTest, Finding, RunContext } from '@qaai/shared';
import { accessibilityPlugin } from './plugins/accessibility.js';
import {
  analyseTabRing,
  assessAccessibleName,
  computeAccessibleName,
  DEEP_A11Y_CHECKS,
  deepA11yCheckLabel,
  enabledChecks,
  expectsAccessibleName,
  focusIndicatorDelta,
  focusOrderRegressions,
  inPage,
  isDeepA11yFinding,
  isInconclusiveDeepA11yFinding,
  isSymbolOnlyName,
  isUninformativeName,
  motionProblems,
  parseDeepA11yConfig,
  runDeepA11yChecks,
  survivesForcedColors,
} from './a11y-deep.js';
import type {
  ElementSnapshot,
  FocusStyle,
  MotionSnapshot,
  ResolvedDeepA11yConfig,
  TabStop,
} from './a11y-deep.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const codes = (findings: Finding[]): string[] => [...new Set(findings.map((f) => f.code))].sort();
const byCode = (findings: Finding[], code: string): Finding | undefined =>
  findings.find((f) => f.code === code);

const element = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  index: 0,
  selector: 'button#save',
  tag: 'button',
  type: null,
  role: null,
  ariaLabel: null,
  ariaLabelledbyText: null,
  ariaLabelledbyMissing: [],
  labelText: null,
  text: '',
  imageAltText: null,
  title: null,
  placeholder: null,
  alt: null,
  value: null,
  ariaHidden: false,
  inert: false,
  disabled: false,
  tabIndex: 0,
  hasTabIndexAttribute: false,
  visible: true,
  rect: { x: 0, y: 0, width: 80, height: 30 },
  style: {},
  dialogAncestor: null,
  ...over,
});

const stop = (over: Partial<TabStop> = {}): TabStop => ({
  position: 0,
  index: 0,
  documentLevel: false,
  tag: 'button',
  label: 'Save',
  selector: 'button#save',
  style: {},
  dialogAncestor: null,
  ...over,
});

const NAME_OPTIONS = { uninformativeNames: ['click here', 'read more', 'button', 'more'] };

// ─── 1. Configuration: off unless asked for, by name ─────────────────────────

describe('parseDeepA11yConfig', () => {
  it('returns null when a spec has no deep block, so the axe path is untouched', () => {
    expect(parseDeepA11yConfig({ routes: ['/'] })).toBeNull();
    expect(parseDeepA11yConfig(null)).toBeNull();
    expect(parseDeepA11yConfig('nonsense')).toBeNull();
  });

  it('leaves every check off that was not named', () => {
    const config = parseDeepA11yConfig({ deep: { keyboardTraps: true } })!;
    expect(enabledChecks(config)).toEqual(['keyboardTraps']);
    expect(config.accessibleNames.enabled).toBe(false);
    expect(config.reducedMotion.enabled).toBe(false);
  });

  it('accepts the boolean shorthand and the object form, and keeps defaults', () => {
    const config = parseDeepA11yConfig({
      deep: { keyboardTraversal: true, accessibleNames: { ignoreSelectors: ['#widget'] } },
    })!;
    expect(config.keyboardTraversal.enabled).toBe(true);
    expect(config.keyboardTraversal.maxTabStops).toBe(200);
    expect(config.accessibleNames.enabled).toBe(true);
    expect(config.accessibleNames.ignoreSelectors).toEqual(['#widget']);
    expect(config.accessibleNames.uninformativeNames).toContain('click here');
  });

  it('switches one check off without disturbing the others', () => {
    const config = parseDeepA11yConfig({
      deep: { keyboardTraversal: true, keyboardTraps: false },
    })!;
    expect(enabledChecks(config)).toEqual(['keyboardTraversal']);
  });

  it('reports a malformed block instead of silently treating it as off', () => {
    const config = parseDeepA11yConfig({ deep: { keyboardTraversal: { maxTabStops: -4 } } })!;
    expect(config.configError).toMatch(/maxTabStops/);
    expect(enabledChecks(config)).toEqual([]);
  });

  it('names every check it knows about', () => {
    expect(DEEP_A11Y_CHECKS.map(deepA11yCheckLabel)).toEqual([
      'Keyboard traversal',
      'Keyboard traps',
      'Accessible names',
      'Focus management',
      'Reduced motion',
      'Forced colors',
    ]);
  });
});

// ─── 2. Accessible names ─────────────────────────────────────────────────────

describe('computeAccessibleName', () => {
  it('follows the documented precedence', () => {
    expect(
      computeAccessibleName(
        element({ ariaLabel: 'Search products', ariaLabelledbyText: 'Heading', text: 'Go' }),
      ),
    ).toEqual({ name: 'Search products', source: 'aria-label' });

    expect(
      computeAccessibleName(element({ ariaLabelledbyText: 'Delivery address', text: 'Edit' })),
    ).toEqual({ name: 'Delivery address', source: 'aria-labelledby' });

    expect(
      computeAccessibleName(element({ labelText: 'Email', placeholder: 'you@x.com' })),
    ).toEqual({ name: 'Email', source: 'label' });

    expect(computeAccessibleName(element({ text: 'Add to cart', title: 'Add' }))).toEqual({
      name: 'Add to cart',
      source: 'text',
    });

    expect(computeAccessibleName(element({ title: 'Close', placeholder: 'x' }))).toEqual({
      name: 'Close',
      source: 'title',
    });

    expect(computeAccessibleName(element({ placeholder: 'Your email' }))).toEqual({
      name: 'Your email',
      source: 'placeholder',
    });

    expect(computeAccessibleName(element({}))).toEqual({ name: '', source: 'none' });
  });

  it('names an image-only link from the image, which is every logo on the internet', () => {
    expect(
      computeAccessibleName(element({ tag: 'a', text: '', imageAltText: 'Ground Coffee home' })),
    ).toEqual({ name: 'Ground Coffee home', source: 'image-alt' });
    expect(
      assessAccessibleName(
        element({ tag: 'a', text: '', imageAltText: 'Ground Coffee home' }),
        NAME_OPTIONS,
      ),
    ).toBeNull();
  });

  it("takes a submit button's name from its value, and collapses whitespace", () => {
    expect(
      computeAccessibleName(element({ tag: 'input', type: 'submit', value: '  Place   order ' })),
    ).toEqual({ name: 'Place order', source: 'value' });
    // A text input's value is user data, never its name.
    expect(
      computeAccessibleName(element({ tag: 'input', type: 'text', value: 'zaki@x.com' })),
    ).toEqual({ name: '', source: 'none' });
  });
});

describe('assessAccessibleName', () => {
  const assess = (over: Partial<ElementSnapshot>) =>
    assessAccessibleName(element(over), NAME_OPTIONS);

  it('reports a control with no name at all', () => {
    expect(assess({})?.kind).toBe('missing');
  });

  it('reports a focusable control hidden from assistive technology', () => {
    const problem = assess({ ariaHidden: true, text: '🔍' });
    expect(problem?.kind).toBe('hidden-from-assistive-tech');
    expect(problem?.detail).toMatch(/aria-hidden/);
  });

  it('reports aria-labelledby pointing at nothing', () => {
    const problem = assess({ ariaLabelledbyMissing: ['legend-1'] });
    expect(problem?.kind).toBe('labelledby-missing-target');
    expect(problem?.detail).toContain('#legend-1');
  });

  it('reports an icon-only name', () => {
    expect(assess({ text: '🔍' })?.kind).toBe('symbol-only');
    expect(assess({ text: '›' })?.kind).toBe('symbol-only');
  });

  it('reports a name that says nothing, and leaves a real one alone', () => {
    expect(assess({ tag: 'a', text: 'Click here' })?.kind).toBe('uninformative');
    expect(assess({ tag: 'a', text: 'Read more' })?.kind).toBe('uninformative');
    // The false positive that would get this check switched off.
    expect(assess({ tag: 'a', text: 'Read more about the returns policy' })).toBeNull();
    expect(assess({ text: 'Add to cart' })).toBeNull();
  });

  it('treats a placeholder and a title as the weak names they are', () => {
    expect(assess({ tag: 'input', type: 'email', placeholder: 'Your email' })?.kind).toBe(
      'placeholder-only',
    );
    expect(assess({ title: 'Close the dialog' })?.kind).toBe('title-only');
  });

  it('flags an element carrying both aria-label and aria-labelledby, and says which wins', () => {
    const problem = assess({ ariaLabel: 'Close', ariaLabelledbyText: 'Delete everything' });
    expect(problem?.kind).toBe('conflicting-labels');
    expect(problem?.detail).toMatch(/aria-labelledby one/);
  });
});

describe('name helpers', () => {
  it('matches uninformative names whole, never as substrings', () => {
    expect(isUninformativeName('Click here', NAME_OPTIONS.uninformativeNames)).toBe(true);
    expect(isUninformativeName('click here.', NAME_OPTIONS.uninformativeNames)).toBe(true);
    expect(
      isUninformativeName(
        'Click here to see the delivery options',
        NAME_OPTIONS.uninformativeNames,
      ),
    ).toBe(false);
  });

  it('knows a name with no words in it', () => {
    expect(isSymbolOnlyName('→')).toBe(true);
    expect(isSymbolOnlyName('Next →')).toBe(false);
  });

  it('only expects names from things that are controls and rendered', () => {
    expect(expectsAccessibleName(element({ tag: 'button' }))).toBe(true);
    expect(expectsAccessibleName(element({ tag: 'div', role: 'button' }))).toBe(true);
    expect(expectsAccessibleName(element({ tag: 'div' }))).toBe(false);
    expect(expectsAccessibleName(element({ tag: 'button', visible: false }))).toBe(false);
  });
});

// ─── 3. Focus visibility ─────────────────────────────────────────────────────

const style = (over: Partial<FocusStyle> = {}): FocusStyle => ({
  'outline-style': 'none',
  'outline-width': '0px',
  'outline-color': 'rgb(0, 0, 0)',
  'outline-offset': '0px',
  'box-shadow': 'none',
  'border-top-width': '0px',
  'border-top-style': 'none',
  'border-top-color': 'rgb(0, 0, 0)',
  'border-bottom-width': '0px',
  'border-bottom-color': 'rgb(0, 0, 0)',
  'background-color': 'rgb(31, 111, 235)',
  'background-image': 'none',
  color: 'rgb(255, 255, 255)',
  'text-decoration-line': 'none',
  'text-decoration-thickness': 'auto',
  transform: 'none',
  filter: 'none',
  opacity: '1',
  ...over,
});

describe('focusIndicatorDelta', () => {
  it('sees an outline that appears on focus', () => {
    const delta = focusIndicatorDelta(
      style(),
      style({ 'outline-style': 'solid', 'outline-width': '2px' }),
    );
    expect(delta).toEqual({ visible: true, via: ['outline'] });
    expect(survivesForcedColors(delta)).toBe(true);
  });

  it('reports nothing when the two states are identical — the removed focus ring', () => {
    expect(focusIndicatorDelta(style(), style())).toEqual({ visible: false, via: [] });
  });

  it('does not count an outline colour change while no outline is drawn', () => {
    // The trap a naive property diff falls into: outline-color is inherited from
    // `color` and moves with it even when outline-style stays `none`.
    const delta = focusIndicatorDelta(style(), style({ 'outline-color': 'rgb(1, 2, 3)' }));
    expect(delta.visible).toBe(false);
  });

  it('knows a box-shadow ring will not survive forced colors, and an outline will', () => {
    const shadow = focusIndicatorDelta(style(), style({ 'box-shadow': 'rgb(5) 0px 0px 0px 3px' }));
    expect(shadow.via).toEqual(['box-shadow']);
    expect(survivesForcedColors(shadow)).toBe(false);

    const both = focusIndicatorDelta(
      style(),
      style({
        'box-shadow': 'rgb(5) 0px 0px 0px 3px',
        'outline-style': 'solid',
        'outline-width': '2px',
      }),
    );
    expect(survivesForcedColors(both)).toBe(true);
  });

  it('accepts a background or underline change as an indicator', () => {
    expect(focusIndicatorDelta(style(), style({ 'background-color': 'rgb(0,0,0)' })).via).toEqual([
      'background',
    ]);
    expect(
      focusIndicatorDelta(style(), style({ 'text-decoration-line': 'underline' })).via,
    ).toEqual(['underline']);
  });
});

// ─── 4. Focus order ──────────────────────────────────────────────────────────

describe('focusOrderRegressions', () => {
  const rects = (...ys: number[]): ReadonlyMap<number, ElementSnapshot['rect']> =>
    new Map(ys.map((y, index) => [index, { x: 0, y, width: 100, height: 30 }] as const));

  const stops = (count: number): TabStop[] =>
    Array.from({ length: count }, (_, i) => stop({ position: i, index: i }));

  it('says nothing about a page that tabs top to bottom', () => {
    expect(focusOrderRegressions(stops(4), rects(0, 100, 200, 300))).toEqual([]);
  });

  it('says nothing about two controls sitting side by side on one row', () => {
    // Same y: a left/right argument, not a barrier. Reporting these is how a
    // focus-order check earns its reputation for noise.
    const sideBySide: TabStop[] = [
      stop({ position: 0, index: 0 }),
      stop({ position: 1, index: 1 }),
    ];
    const map = new Map([
      [0, { x: 200, y: 100, width: 80, height: 30 }],
      [1, { x: 0, y: 100, width: 80, height: 30 }],
    ]);
    expect(focusOrderRegressions(sideBySide, map)).toEqual([]);
  });

  it('says nothing about a card grid, which tabs up-and-right by design', () => {
    // The false positive the demo store produced: from the Add-to-cart button
    // at the bottom of one card to the title link at the top of the next card
    // along. Higher, but to the right, and exactly how a grid reads.
    const grid: TabStop[] = [stop({ position: 0, index: 0 }), stop({ position: 1, index: 1 })];
    const map = new Map([
      [0, { x: 20, y: 238, width: 120, height: 34 }],
      [1, { x: 250, y: 100, width: 90, height: 22 }],
    ]);
    expect(focusOrderRegressions(grid, map)).toEqual([]);
  });

  it('reports a tab order that jumps back up the page', () => {
    const regressions = focusOrderRegressions(stops(3), rects(0, 400, 100));
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.jumpedUpBy).toBe(270);
    expect(regressions[0]!.to.index).toBe(2);
  });

  it('caps what it reports so one bad page cannot produce two hundred findings', () => {
    const many = stops(20);
    const map = new Map(
      Array.from(
        { length: 20 },
        (_, i) => [i, { x: 0, y: (20 - i) * 100, width: 10, height: 10 }] as const,
      ),
    );
    expect(focusOrderRegressions(many, map).length).toBe(5);
  });
});

// ─── 5. The shape of the tab ring ────────────────────────────────────────────

describe('analyseTabRing', () => {
  const candidates = [element({ index: 0 }), element({ index: 1 }), element({ index: 2 })];

  it('reports a control that is in the tab order and never got focus', () => {
    const walked = [
      stop({ position: 0, index: 0 }),
      stop({ position: 1, index: 2 }),
      stop({ position: 2, index: -1, documentLevel: true }),
    ];
    const ring = analyseTabRing(walked, candidates, { exhausted: false });
    expect(ring.completed).toBe(true);
    expect(ring.unreachable.map((el) => el.index)).toEqual([1]);
    expect(ring.stuckAt).toBeNull();
    expect(ring.cycle).toBeNull();
  });

  it('counts a div with an interactive role as expected in the ring', () => {
    const withDiv = [
      element({ index: 0 }),
      element({ index: 1, tag: 'div', role: 'button', tabIndex: -1 }),
    ];
    const ring = analyseTabRing(
      [stop({ index: 0 }), stop({ position: 1, index: -1, documentLevel: true })],
      withDiv,
      { exhausted: false },
    );
    expect(ring.unreachable.map((el) => el.index)).toEqual([1]);
  });

  it('leaves an element alone when tabindex="-1" took it out on purpose', () => {
    const withOptOut = [
      element({ index: 0 }),
      element({ index: 1, role: 'button', tabIndex: -1, hasTabIndexAttribute: true }),
    ];
    const ring = analyseTabRing(
      [stop({ index: 0 }), stop({ position: 1, index: -1, documentLevel: true })],
      withOptOut,
      { exhausted: false },
    );
    expect(ring.unreachable).toEqual([]);
  });

  it('does not invent unreachable elements when the walk was cut short', () => {
    // A walk stopped by a trap has not finished visiting. Calling the remainder
    // unreachable turns one real problem into a page of invented ones.
    const ring = analyseTabRing([stop({ index: 0 }), stop({ position: 1, index: 0 })], candidates, {
      exhausted: true,
    });
    expect(ring.unreachable).toEqual([]);
    expect(ring.stuckAt?.index).toBe(0);
  });

  it('sees focus that stops moving', () => {
    const ring = analyseTabRing(
      [stop({ position: 0, index: 1 }), stop({ position: 1, index: 1 })],
      candidates,
      { exhausted: false },
    );
    expect(ring.stuckAt?.position).toBe(1);
  });

  it('sees a cycle that never reaches the document while other controls exist', () => {
    const ring = analyseTabRing(
      [stop({ position: 0, index: 0 }), stop({ position: 1, index: 1 })],
      candidates,
      { exhausted: true },
    );
    expect(ring.cycle?.length).toBe(2);
    expect(ring.completed).toBe(false);
  });

  it('calls a ring that wrapped through the document closed, not cyclical', () => {
    const ring = analyseTabRing(
      [
        stop({ position: 0, index: 0 }),
        stop({ position: 1, index: 1 }),
        stop({ position: 2, index: 2 }),
        stop({ position: 3, index: -1, documentLevel: true }),
      ],
      candidates,
      { exhausted: false },
    );
    expect(ring.cycle).toBeNull();
    expect(ring.unreachable).toEqual([]);
  });
});

// ─── 6. Motion ───────────────────────────────────────────────────────────────

const motion = (over: Partial<MotionSnapshot> = {}): MotionSnapshot => ({
  reduceMatches: true,
  animations: [],
  scrollBehavior: 'auto',
  autoplayMedia: [],
  hasReducedMotionQuery: false,
  unreadableStylesheets: 0,
  ...over,
});

describe('motionProblems', () => {
  it('reports an animation that repeats forever under reduce', () => {
    const problems = motionProblems(
      motion({
        animations: [
          {
            name: 'spin',
            target: 'div.spinner',
            durationMs: 800,
            iterations: -1,
            playState: 'running',
          },
        ],
      }),
      { longAnimationMs: 1000 },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.endless).toBe(true);
  });

  it('ignores a short transition, which is not what makes anybody ill', () => {
    expect(
      motionProblems(
        motion({
          animations: [
            { name: '', target: 'a.link', durationMs: 150, iterations: 1, playState: 'running' },
          ],
        }),
        { longAnimationMs: 1000 },
      ),
    ).toEqual([]);
  });

  it('ignores an animation that has already finished', () => {
    expect(
      motionProblems(
        motion({
          animations: [
            {
              name: 'fade',
              target: 'main',
              durationMs: 4000,
              iterations: 1,
              playState: 'finished',
            },
          ],
        }),
        { longAnimationMs: 1000 },
      ),
    ).toEqual([]);
  });

  it('reports smooth scrolling and unpausable autoplay', () => {
    const problems = motionProblems(
      motion({ scrollBehavior: 'smooth', autoplayMedia: ['video#hero'] }),
      { longAnimationMs: 1000 },
    );
    expect(problems.map((p) => p.kind).sort()).toEqual(['autoplay', 'scroll-behaviour']);
  });
});

// ─── 7. Against a real browser, with planted barriers ────────────────────────

const PAGE_SHELL = (title: string, head: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/**
 * Every fixture is a page a real team has shipped. `clean`, `modal-good`,
 * `motion-ok` and `route-ok` are the control group: they are built correctly and
 * anything reported against them is a false positive.
 */
const FIXTURES: Record<string, string> = {
  '/clean': PAGE_SHELL(
    'Clean',
    `<style>
      :focus-visible { outline: 3px solid #005fcc; outline-offset: 2px; }
      body { margin: 0; font: 16px sans-serif; }
      p { margin: 0 0 24px; }
    </style>`,
    `<h1>Order a coffee</h1>
     <p><a href="#products" id="products">Browse the products</a></p>
     <p><button id="add">Add to cart</button></p>
     <p><label for="email">Email address</label><input id="email" type="email"></p>
     <p><button id="checkout">Place order</button></p>
     <p><a href="#home" id="logo"><img alt="Ground Coffee home" width="24" height="24"
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a></p>`,
  ),

  '/broken': PAGE_SHELL(
    'Broken',
    `<style>
      :focus-visible { outline: 3px solid #005fcc; }
      /* The reset that removes the focus ring — the most common a11y bug alive. */
      #noring:focus, #noring:focus-visible { outline: none; }
      /* A ring that vanishes in Windows High Contrast. */
      #shadowring:focus-visible { outline: none; box-shadow: 0 0 0 3px #0057d8; }
      body { margin: 0; font: 16px sans-serif; }
      p { margin: 0 0 24px; }
      #uptop { position: absolute; top: 4px; left: 0; }
    </style>`,
    `<h1 style="margin-top:120px">Broken</h1>
     <p><button id="icon" aria-hidden="true">🔍</button></p>
     <p><div role="button" id="fake">Save draft</div></p>
     <p><a href="#x" id="vague">Click here</a></p>
     <p><input id="ph" placeholder="Your email"></p>
     <p><input id="search" type="search"></p>
     <p><button id="noring">Continue</button></p>
     <p><button id="shadowring">Shadow ring</button></p>
     <p><button id="uptop">Up top</button></p>`,
  ),

  '/trap': PAGE_SHELL(
    'Trap',
    '<style>:focus-visible { outline: 3px solid #005fcc; }</style>',
    `<button id="one">One</button>
     <button id="trap">Date picker</button>
     <button id="two">Two</button>
     <script>
       var trap = document.getElementById('trap');
       trap.addEventListener('keydown', function (event) {
         if (event.key === 'Tab') { event.preventDefault(); trap.focus(); }
       });
     </script>`,
  ),

  '/trap-escapable': PAGE_SHELL(
    'Escapable trap',
    '<style>:focus-visible { outline: 3px solid #005fcc; }</style>',
    `<button id="one">One</button>
     <button id="trap">Date picker</button>
     <button id="two">Two</button>
     <script>
       var trap = document.getElementById('trap');
       var held = true;
       trap.addEventListener('keydown', function (event) {
         if (event.key === 'Escape') { held = false; return; }
         if (event.key === 'Tab' && held) { event.preventDefault(); trap.focus(); }
       });
     </script>`,
  ),

  '/trap-cycle': PAGE_SHELL(
    'Cycling trap',
    '<style>:focus-visible { outline: 3px solid #005fcc; }</style>',
    `<button id="outside">Back to the shop</button>
     <div id="dialog" role="dialog" aria-modal="true">
       <button id="a">Yes</button>
       <button id="b">No</button>
     </div>
     <script>
       var a = document.getElementById('a');
       var b = document.getElementById('b');
       a.focus();
       /* Cycles between the two buttons forever and never lets go — the shape a
          modal takes when nothing ever closes it. */
       document.addEventListener('keydown', function (event) {
         if (event.key !== 'Tab') return;
         event.preventDefault();
         (document.activeElement === a ? b : a).focus();
       });
     </script>`,
  ),

  '/modal-bad': PAGE_SHELL(
    'Bad modal',
    `<style>
      :focus-visible { outline: 3px solid #005fcc; }
      #dialog[hidden] { display: none; }
      #dialog { border: 1px solid #333; padding: 16px; }
     </style>`,
    `<button id="open">Delete account</button>
     <button id="after">Something else</button>
     <div id="dialog" role="dialog" aria-modal="true" hidden>
       <h2>Are you sure?</h2>
       <button id="confirm">Yes, delete it</button>
       <button id="close">Cancel</button>
     </div>
     <script>
       var dialog = document.getElementById('dialog');
       document.getElementById('open').addEventListener('click', function () {
         dialog.hidden = false;           /* focus is never moved in */
       });
       document.getElementById('close').addEventListener('click', function () {
         dialog.hidden = true;            /* and never restored on the way out */
       });
     </script>`,
  ),

  '/modal-good': PAGE_SHELL(
    'Good modal',
    `<style>
      :focus-visible { outline: 3px solid #005fcc; }
      #dialog[hidden] { display: none; }
      #dialog { border: 1px solid #333; padding: 16px; }
     </style>`,
    `<button id="open">Delete account</button>
     <button id="after">Something else</button>
     <div id="dialog" role="dialog" aria-modal="true" hidden>
       <h2>Are you sure?</h2>
       <button id="confirm">Yes, delete it</button>
       <button id="close">Cancel</button>
     </div>
     <script>
       var dialog = document.getElementById('dialog');
       var opener = document.getElementById('open');
       var confirm = document.getElementById('confirm');
       var close = document.getElementById('close');
       var lastFocused = null;

       function open() {
         lastFocused = document.activeElement;
         dialog.hidden = false;
         confirm.focus();
       }
       function shut() {
         dialog.hidden = true;
         if (lastFocused) lastFocused.focus();
       }
       opener.addEventListener('click', open);
       close.addEventListener('click', shut);
       document.addEventListener('keydown', function (event) {
         if (event.key === 'Escape' && !dialog.hidden) shut();
         if (event.key !== 'Tab' || dialog.hidden) return;
         var first = confirm, last = close;
         if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
         else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
       });
     </script>`,
  ),

  '/motion': PAGE_SHELL(
    'Motion',
    `<style>
      html { scroll-behavior: smooth; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .spinner { animation: spin 900ms linear infinite; width: 40px; height: 40px; background: #333; }
     </style>`,
    '<h1>Loading</h1><div class="spinner" id="spinner"></div><button id="go">Go</button>',
  ),

  '/motion-ok': PAGE_SHELL(
    'Motion, done right',
    `<style>
      html { scroll-behavior: smooth; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .spinner { animation: spin 900ms linear infinite; width: 40px; height: 40px; background: #333; }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        .spinner { animation: none; }
      }
     </style>`,
    '<h1>Loading</h1><div class="spinner" id="spinner"></div><button id="go">Go</button>',
  ),

  '/route-lost': PAGE_SHELL(
    'Route change that drops focus',
    '<style>:focus-visible { outline: 3px solid #005fcc; }</style>',
    `<nav id="nav"><button id="go">Open the order</button></nav>
     <main id="view"><h1>Orders</h1></main>
     <script>
       document.getElementById('go').addEventListener('click', function () {
         history.pushState({}, '', '/route-lost?order=1');
         document.getElementById('nav').remove();   /* focus falls back to <body> */
         document.getElementById('view').innerHTML = '<h1>Order 1</h1>';
       });
     </script>`,
  ),

  '/route-ok': PAGE_SHELL(
    'Route change that moves focus',
    '<style>:focus-visible { outline: 3px solid #005fcc; }</style>',
    `<nav id="nav"><button id="go">Open the order</button></nav>
     <main id="view"><h1>Orders</h1></main>
     <script>
       document.getElementById('go').addEventListener('click', function () {
         history.pushState({}, '', '/route-ok?order=1');
         var view = document.getElementById('view');
         view.innerHTML = '<h1 id="title" tabindex="-1">Order 1</h1>';
         document.getElementById('title').focus();
       });
     </script>`,
  ),
};

/**
 * Probed at collection time, because `describe.skipIf` needs the answer before
 * the suite is defined. A developer without a Playwright browser gets a skipped
 * suite, never a red one — the same rule the runner applies to a missing tool:
 * `npx playwright install chromium` installs it.
 */
const chromiumAvailable = await (async (): Promise<boolean> => {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumAvailable)('against a real Chromium, with planted barriers', () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const body = FIXTURES[path];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? '<!doctype html><title>404</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A fresh context per case: focus state and media emulation must not leak. */
  const run = async (
    route: string,
    deep: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<typeof runDeepA11yChecks>>> => {
    context = await browser.newContext();
    page = await context.newPage();
    const url = `${origin}${route}`;
    const navigate = async (): Promise<void> => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    };
    try {
      await navigate();
      return await runDeepA11yChecks({
        page,
        route,
        config: parseDeepA11yConfig({ deep }) as ResolvedDeepA11yConfig,
        navigate,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  // ── The bug the demo store found, encoded ──

  it('runs a function the bundler rewrote for keepNames, which is how tsx ships it', async () => {
    // esbuild's keepNames — on by default in tsx, which is how this repo runs
    // the worker in development — rewrites `const helper = …` into
    // `__name(helper, "helper")`, a helper defined at the top of the MODULE and
    // therefore absent from the page. Running the plugin against the live demo
    // store produced `ReferenceError: __name is not defined` on every check,
    // while this suite (vitest, which does not add the helper) stayed green.
    // This is that exact shape, so the fix cannot be undone silently.
    context = await browser.newContext();
    page = await context.newPage();
    try {
      await page.goto(`${origin}/clean`, { waitUntil: 'domcontentloaded' });
      // Building the exact source shape esbuild emits is the only way to prove
      // the fix, so this one really does want the Function constructor.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const keepNamesShaped = new Function(
        'arg',
        'const helper = __name((value) => value.x + 1, "helper"); return helper(arg);',
      ) as (arg: { x: number }) => number;

      await expect(page.evaluate(keepNamesShaped, { x: 41 })).rejects.toThrow(
        /__name is not defined/,
      );
      await expect(page.evaluate(inPage(keepNamesShaped), { x: 41 })).resolves.toBe(42);
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 60_000);

  // ── The control group ──

  it('reports nothing at all on a page that is built properly', async () => {
    const result = await run('/clean', {
      keyboardTraversal: true,
      keyboardTraps: true,
      accessibleNames: true,
      reducedMotion: true,
      forcedColors: true,
    });
    expect(codes(result.findings)).toEqual([]);
    expect(result.outcomes.every((o) => o.status === 'RAN')).toBe(true);
  }, 60_000);

  // ── 1. Keyboard traversal ──

  it('finds the control no keyboard can reach, the invisible focus ring and the backwards jump', async () => {
    const result = await run('/broken', { keyboardTraversal: true });
    const found = codes(result.findings);
    expect(found).toContain('a11y.keyboard.unreachable');
    expect(found).toContain('a11y.keyboard.focus-not-visible');
    expect(found).toContain('a11y.keyboard.focus-order');

    const unreachable = byCode(result.findings, 'a11y.keyboard.unreachable')!;
    expect(unreachable.severity).toBe('SERIOUS');
    expect(unreachable.message).toContain('#fake');
    expect(unreachable.message).toMatch(/WCAG 2\.1\.1 Keyboard, Level A/);
    expect(unreachable.message).toMatch(/tabindex="0"|<button>/);
    expect(unreachable.helpUrl).toBe('https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html');

    const ring = byCode(result.findings, 'a11y.keyboard.focus-not-visible')!;
    expect(ring.message).toContain('#noring');
    expect(ring.message).toMatch(/WCAG 2\.4\.7 Focus Visible, Level AA/);
    expect(ring.severity).toBe('SERIOUS');

    const order = byCode(result.findings, 'a11y.keyboard.focus-order')!;
    expect(order.message).toContain('#uptop');
    expect(order.severity).toBe('MODERATE');
  }, 60_000);

  // ── 2. Keyboard traps ──

  it('calls an inescapable trap CRITICAL — the one finding that fails a test', async () => {
    const result = await run('/trap', { keyboardTraps: true });
    const trap = byCode(result.findings, 'a11y.keyboard.trap')!;
    expect(trap.severity).toBe('CRITICAL');
    expect(trap.message).toContain('#trap');
    expect(trap.message).toMatch(/WCAG 2\.1\.2 No Keyboard Trap, Level A/);
    expect(trap.message).toMatch(/Shift\+Tab does not go back/);
  }, 60_000);

  it('calls a ring that cycles among two controls and never lets go a trap', async () => {
    // The bug this case exists for: the escape probe used to ask "did focus
    // move?", and inside a cycle it always has — from Yes to No and back. That
    // graded an inescapable dialog MODERATE. The question is whether focus
    // reached anything OUTSIDE the cycle.
    const result = await run('/trap-cycle', { keyboardTraps: true, keyboardTraversal: true });
    const trap = byCode(result.findings, 'a11y.keyboard.trap')!;
    expect(trap.severity).toBe('CRITICAL');
    expect(trap.message).toMatch(/cycles forever/);
    expect(trap.message).toMatch(/Neither Shift\+Tab nor Escape escaped it/);
    // And the control it never reaches is not also reported as unreachable: one
    // problem, one finding.
    expect(byCode(result.findings, 'a11y.keyboard.unreachable')).toBeUndefined();
  }, 60_000);

  it('does not call the same trap CRITICAL when Escape gets out of it', async () => {
    const result = await run('/trap-escapable', { keyboardTraps: true });
    const trap = byCode(result.findings, 'a11y.keyboard.trap')!;
    expect(trap.severity).toBe('SERIOUS');
    expect(trap.message).toMatch(/only be left with Escape/);
    expect(trap.message).toMatch(/2\.1\.2 allows a non-standard exit only when it is documented/);
  }, 60_000);

  // ── 3. Accessible names ──

  it('names the controls that resolve to nothing, or to nothing useful', async () => {
    const result = await run('/broken', { accessibleNames: true });
    const found = codes(result.findings);
    expect(found).toContain('a11y.name.hidden');
    expect(found).toContain('a11y.name.uninformative');
    expect(found).toContain('a11y.name.placeholder-only');
    expect(found).toContain('a11y.name.missing');

    const hidden = byCode(result.findings, 'a11y.name.hidden')!;
    expect(hidden.message).toContain('#icon');
    expect(hidden.severity).toBe('SERIOUS');

    const vague = byCode(result.findings, 'a11y.name.uninformative')!;
    expect(vague.message).toContain('Click here');
    expect(vague.severity).toBe('MODERATE');
    expect(vague.message).toMatch(/WCAG 2\.4\.4/);
  }, 60_000);

  // ── 4. Focus management ──

  it('reports a dialog that never takes focus, never holds it and never gives it back', async () => {
    const result = await run('/modal-bad', {
      focusManagement: {
        modals: [{ name: 'Delete account', trigger: '#open', dialog: '#dialog', close: '#close' }],
      },
    });
    const found = codes(result.findings);
    expect(found).toContain('a11y.focus.modal-not-moved');
    expect(found).toContain('a11y.focus.modal-not-trapped');
    expect(found).toContain('a11y.focus.modal-not-restored');

    const notMoved = byCode(result.findings, 'a11y.focus.modal-not-moved')!;
    expect(notMoved.severity).toBe('SERIOUS');
    expect(notMoved.message).toMatch(/role="dialog"/);
  }, 60_000);

  it('reports nothing against a dialog that does all three correctly', async () => {
    const result = await run('/modal-good', {
      focusManagement: {
        modals: [{ name: 'Delete account', trigger: '#open', dialog: '#dialog', close: '#close' }],
      },
    });
    expect(result.findings.filter((f) => f.code.startsWith('a11y.focus.'))).toEqual([]);
  }, 60_000);

  it('reports a same-document route change that drops focus, and not one that manages it', async () => {
    const lost = await run('/route-lost', {
      focusManagement: { routeChanges: [{ name: 'Open order', trigger: '#go' }] },
    });
    const finding = byCode(lost.findings, 'a11y.focus.route-change-lost')!;
    expect(finding.severity).toBe('MODERATE');
    expect(finding.message).toMatch(/aria-live|tabindex="-1"/);

    const ok = await run('/route-ok', {
      focusManagement: { routeChanges: [{ name: 'Open order', trigger: '#go' }] },
    });
    expect(byCode(ok.findings, 'a11y.focus.route-change-lost')).toBeUndefined();
  }, 90_000);

  // ── 5. Reduced motion and forced colors ──

  it('reports motion that ignores prefers-reduced-motion, and clears a page that honours it', async () => {
    const ignored = await run('/motion', { reducedMotion: true });
    const found = codes(ignored.findings);
    expect(found).toContain('a11y.motion.not-reduced');
    expect(found).toContain('a11y.motion.smooth-scroll');
    const animation = byCode(ignored.findings, 'a11y.motion.not-reduced')!;
    expect(animation.severity).toBe('SERIOUS');
    expect(animation.message).toMatch(/repeats forever/);
    expect(animation.message).toMatch(/No stylesheet on this page mentions prefers-reduced-motion/);

    const honoured = await run('/motion-ok', { reducedMotion: true });
    expect(honoured.findings.filter((f) => f.code.startsWith('a11y.motion.'))).toEqual([]);
  }, 90_000);

  it('reports a focus ring that disappears in forced-colors mode', async () => {
    const result = await run('/broken', { keyboardTraversal: true, forcedColors: true });
    const lost = byCode(result.findings, 'a11y.forced-colors.focus-indicator-lost')!;
    expect(lost.message).toContain('#shadowring');
    expect(lost.message).toMatch(/box-shadow/);
    expect(lost.severity).toBe('MODERATE');
  }, 60_000);

  // ── Failing open ──

  it('says so, loudly, when a configured scenario could not be exercised', async () => {
    const result = await run('/clean', {
      focusManagement: { modals: [{ name: 'Ghost', trigger: '#does-not-exist' }] },
    });
    const inconclusive = result.findings.filter(isInconclusiveDeepA11yFinding);
    expect(inconclusive).toHaveLength(1);
    expect(inconclusive[0]!.severity).toBe('MINOR');
    expect(inconclusive[0]!.message).toContain('#does-not-exist');
  }, 60_000);

  it('says so when focus management is on but nothing was configured to exercise', async () => {
    const result = await run('/clean', { focusManagement: true });
    expect(codes(result.findings)).toEqual(['a11y.inconclusive.focusManagement']);
    expect(result.findings[0]!.message).toMatch(/deep\.focusManagement\.modals/);
  }, 60_000);

  it('says so when the deep block switches nothing on', async () => {
    const result = await run('/clean', {});
    expect(codes(result.findings)).toEqual(['a11y.inconclusive.config']);
    expect(result.findings[0]!.message).toMatch(/keyboardTraps/);
  }, 60_000);

  it('reports a malformed deep block rather than quietly checking nothing', async () => {
    context = await browser.newContext();
    page = await context.newPage();
    try {
      await page.goto(`${origin}/clean`, { waitUntil: 'domcontentloaded' });
      const result = await runDeepA11yChecks({
        page,
        route: '/clean',
        config: parseDeepA11yConfig({ deep: { keyboardTraps: { escapeKeys: [42] } } })!,
        navigate: async () => {
          await page.goto(`${origin}/clean`, { waitUntil: 'domcontentloaded' });
        },
      });
      expect(result.findings.every(isDeepA11yFinding)).toBe(true);
      expect(codes(result.findings)).toEqual(['a11y.inconclusive.config']);
      expect(result.findings[0]!.message).toMatch(/escapeKeys/);
      expect(result.outcomes.every((o) => o.status === 'SKIPPED')).toBe(true);
      expect(result.outcomes).toHaveLength(DEEP_A11Y_CHECKS.length);
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 60_000);

  // ── 8. The plugin: additive, and only a confirmed trap can fail a test ──

  describe('the ACCESSIBILITY plugin', () => {
    const runContext = (baseUrl: string): RunContext =>
      ({
        runId: 'run_a11y',
        orgId: 'org_a11y',
        projectId: 'proj_a11y',
        environmentId: 'env_a11y',
        baseUrl,
        secrets: {},
        storageState: null,
        artifacts: {
          put: async () => 'k',
          putFile: async () => 'k',
          get: async () => null,
          putPersistent: async () => 'k',
        },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          step: () => undefined,
        },
        signal: new AbortController().signal,
        determinism: {
          freezeClockAt: null,
          randomSeed: 1,
          waitForNetworkIdle: false,
          retryOnce: false,
        },
      }) satisfies RunContext;

    const test = (spec: unknown): ExecutableTest => ({
      id: 'test_a11y',
      name: 'the storefront is accessible',
      type: 'ACCESSIBILITY',
      code: '',
      filePath: 'tests/a11y.json',
      spec,
      timeoutMs: 120_000,
      quarantined: false,
      tags: [],
    });

    it('behaves exactly as before when the spec has no deep block', async () => {
      const execution = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/clean'] }),
      );
      expect(execution.steps).toHaveLength(1);
      expect(execution.steps[0]!.title).toBe('Scan /clean');
      expect(execution.findings.filter(isDeepA11yFinding)).toEqual([]);
    }, 60_000);

    it('adds a step per deep check and keeps the scan step first', async () => {
      const execution = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/clean'], deep: { accessibleNames: true, keyboardTraversal: true } }),
      );
      expect(execution.steps[0]!.title).toBe('Scan /clean');
      expect(execution.steps.map((s) => s.index)).toEqual([0, 1, 2]);
      expect(execution.steps[1]!.title).toMatch(/^Accessible names \/clean —/);
      expect(execution.steps[2]!.title).toMatch(/^Keyboard traversal \/clean —/);
      expect(execution.status).toBe('PASSED');
    }, 60_000);

    it('fails the test on a confirmed keyboard trap, and names it in the message', async () => {
      const execution = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/trap'], deep: { keyboardTraps: true } }),
      );
      expect(execution.status).toBe('FAILED');
      expect(execution.errorMessage).toContain('a11y.keyboard.trap');
      // The step itself is not FAILED: the check ran fine, the page did not.
      expect(execution.steps.every((s) => s.status !== 'FAILED')).toBe(true);
    }, 60_000);

    it('does not change a verdict for the barriers that are not blockers', async () => {
      // The property, stated as a comparison: switching the deep checks on adds
      // findings and must not, on its own, turn a test red. /broken has plenty
      // of both kinds — including one axe CRITICAL of its own, which is exactly
      // the point: the verdict has to be the same either way.
      const withoutDeep = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/broken'] }),
      );
      const withDeep = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/broken'], deep: { keyboardTraversal: true, accessibleNames: true } }),
      );

      const deep = withDeep.findings.filter(isDeepA11yFinding);
      expect(deep.length).toBeGreaterThan(3);
      expect(deep.some((f) => f.severity === 'CRITICAL')).toBe(false);
      expect(withDeep.status).toBe(withoutDeep.status);
      expect(withDeep.errorMessage).toBe(withoutDeep.errorMessage);
    }, 90_000);

    it('skips deep checks on a route it could not even load', async () => {
      const execution = await accessibilityPlugin.execute(
        runContext(origin),
        test({ routes: ['/clean'], deep: { keyboardTraversal: true } }),
      );
      expect(execution.steps.length).toBe(2);

      const broken = await accessibilityPlugin.execute(
        runContext('http://127.0.0.1:1'),
        test({ routes: ['/clean'], deep: { keyboardTraversal: true } }),
      );
      // One failed scan step and nothing else: a route that never loaded is one
      // problem, not seven.
      expect(broken.steps).toHaveLength(1);
      expect(broken.steps[0]!.status).toBe('FAILED');
      expect(broken.status).toBe('FAILED');
    }, 90_000);
  });
});
