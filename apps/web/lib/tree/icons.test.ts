import { describe, expect, it } from 'vitest';
import { FIXTURE_PREFIX, NEW_TEST_TEMPLATES, TEST_TYPES } from '@qaai/shared';
import {
  CODE_BUFFER_TYPES,
  FILE_KINDS,
  FILE_KIND_META,
  ICON_ROLE_CLASS,
  FolderIcon,
  SPEC_JSON_SUFFIXES,
  iconClassFor,
  iconFor,
  kindFor,
  kindForPath,
  kindForTestType,
  type FileKind,
} from './icons';
import { FIXTURE_PREFIX as MODEL_FIXTURE_PREFIX } from './model';

/**
 * These icons never touch a DOM, so neither does this file. A React element is
 * a plain object; a function component is a function. Calling one and walking
 * what comes back tells us everything that matters — which glyph, which colour,
 * which label — with no renderer in the loop.
 */

interface Elementish {
  type: unknown;
  props: Record<string, unknown>;
}

const isElement = (v: unknown): v is Elementish =>
  typeof v === 'object' && v !== null && 'type' in v && 'props' in v;

/** Resolve function components until a host element (a string type) is left. */
function host(node: unknown): Elementish {
  let current = node;
  while (isElement(current) && typeof current.type === 'function') {
    current = (current.type as (p: unknown) => unknown)(current.props);
  }
  if (!isElement(current)) throw new Error('not an element');
  return current;
}

/** Flatten an element's children, through fragments and conditional `false`s. */
function children(el: Elementish): Elementish[] {
  const out: Elementish[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isElement(node)) return;
    if (typeof node.type !== 'string') {
      // A fragment (or a nested component): descend into its children.
      walk(node.props.children);
      return;
    }
    out.push(node);
  };
  walk(el.props.children);
  return out;
}

/**
 * A glyph's shape, as a comparable string. Two kinds drawing the same picture
 * is the failure this exists to catch: the whole accessibility argument for
 * this icon set is that shape, not hue, is the primary channel, and two kinds
 * sharing a silhouette quietly demotes colour back to load-bearing.
 */
function shape(kind: FileKind): string {
  const svg = host(FILE_KIND_META[kind].Icon({}));
  return children(svg)
    .filter((child) => child.type !== 'title')
    .map((child) => `${String(child.type)}:${JSON.stringify(child.props)}`)
    .join('|');
}

/** Only design tokens. A raw hex or a stock palette name breaks both themes. */
const TOKEN_CLASS = /^text-(ink|ink-dim|ink-faint|accent|pass|fail|flake|skip)(\/\d{1,3})?$/;

// ─── kindForPath: the name alone ─────────────────────────────────────────────

describe('kindForPath', () => {
  const cases: Array<[string, FileKind]> = [
    // The spec kinds the panel exists to show.
    ['checkout/order-total.spec.ts', 'spec-ts'],
    ['order-total.spec.tsx', 'spec-ts'],
    ['legacy/login.spec.js', 'spec-js'],
    ['legacy/login.spec.mjs', 'spec-js'],
    ['legacy/login.spec.cjs', 'spec-js'],
    ['legacy/login.spec.jsx', 'spec-js'],
    // `.test.` is a test by any reading, even though this app mints `.spec.`.
    ['lib/tree.test.ts', 'spec-ts'],
    ['lib/tree.test.js', 'spec-js'],

    // Every typed spec buffer the create API can mint.
    ['api/root.api.json', 'spec-json'],
    ['home.visual.json', 'spec-json'],
    ['checkout.load.json', 'spec-json'],
    ['headers.security.json', 'spec-json'],
    ['cart.unit.json', 'spec-json'],
    ['signup.otp.json', 'spec-json'],
    ['orders.db.json', 'spec-json'],
    ['build.cli.json', 'spec-json'],
    ['ws.protocol.json', 'spec-json'],
    ['pact.contract.json', 'spec-json'],
    ['core.mutation.json', 'spec-json'],
    ['ios.mobile.json', 'spec-json'],
    ['lcp.perf.json', 'spec-json'],
    ['vitest.external.json', 'spec-json'],

    // Accessibility is singled out and must beat the generic spec suffix.
    ['home.a11y.json', 'a11y-json'],
    ['deep/nested/home.a11y.json', 'a11y-json'],

    ['fixtures/users.json', 'json'],
    ['data/orders.csv', 'csv'],
    ['data/orders.tsv', 'csv'],
    ['baselines/home.png', 'image'],
    ['baselines/home.jpg', 'image'],
    ['baselines/home.jpeg', 'image'],
    ['baselines/home.gif', 'image'],
    ['baselines/home.webp', 'image'],
    ['baselines/home.avif', 'image'],
    ['logo.svg', 'image'],
    ['ci/pipeline.yml', 'yaml'],
    ['ci/pipeline.yaml', 'yaml'],
    ['README.md', 'markdown'],
    ['docs/guide.mdx', 'markdown'],
    ['notes.txt', 'text'],
    ['run.log', 'text'],
    ['helpers/page-objects.ts', 'code-ts'],
    ['helpers/page-objects.tsx', 'code-ts'],
    ['helpers/loader.mts', 'code-ts'],
    ['helpers/loader.cts', 'code-ts'],
    ['helpers/util.js', 'code-js'],
    ['helpers/util.jsx', 'code-js'],
    ['helpers/util.mjs', 'code-js'],
    ['helpers/util.cjs', 'code-js'],

    // Config, which has to beat both `.ts` and `.json`.
    ['playwright.config.ts', 'config'],
    ['vitest.config.js', 'config'],
    ['next.config.mjs', 'config'],
    ['app.config.json', 'config'],
    ['tsconfig.json', 'config'],
    ['jsconfig.json', 'config'],
    ['package.json', 'config'],
    ['Dockerfile', 'config'],
    ['Makefile', 'config'],
    ['.env', 'config'],
    ['.env.local', 'config'],
    ['.eslintrc', 'config'],
    ['.prettierrc.json', 'config'],
    ['.gitignore', 'config'],
    ['babel.rc', 'config'],
    // A dotfile is config only when the dot is ALL it has. A suffix that says
    // what the file does outranks a dot that only says the shell hides it.
    ['.hidden.spec.ts', 'spec-ts'],
    ['.hidden.test.js', 'spec-js'],
    ['.hidden.a11y.json', 'a11y-json'],
    ['.eslintrc.config.ts', 'config'],

    // Locks, which have to beat json and yaml.
    ['package-lock.json', 'lock'],
    ['yarn.lock', 'lock'],
    ['pnpm-lock.yaml', 'lock'],
    ['bun.lockb', 'lock'],
    ['poetry.lock', 'lock'],
    ['Cargo.lock', 'lock'],
    ['Gemfile.lock', 'lock'],
    ['composer-lock.json', 'lock'],

    // Nothing recognisable — and never a blank.
    ['checkout/total', 'unknown'],
    ['LICENSE', 'unknown'],
    ['archive.tar.gz', 'unknown'],
    ['weird.qqq', 'unknown'],
  ];

  it.each(cases)('%s → %s', (path, expected) => {
    expect(kindForPath(path)).toBe(expected);
  });

  it('is case-insensitive, because a filename’s case is the author’s taste', () => {
    expect(kindForPath('Checkout/Order-Total.SPEC.TS')).toBe('spec-ts');
    expect(kindForPath('HOME.A11Y.JSON')).toBe('a11y-json');
    expect(kindForPath('Package-Lock.JSON')).toBe('lock');
  });

  /*
   * The order this pair is decided in used to make `.hidden.spec.ts` a config
   * file: any leading dot returned `config` before the spec check ran. Both
   * answers are defensible, so the decision is written down — in `kindForPath`,
   * and here, where it can be argued with:
   *
   *   · `.env`, `.gitignore`, `.eslintrc` — a dot and nothing else. Config.
   *   · `.hidden.spec.ts` — a dot AND a suffix. The suffix names what the file
   *     does; the dot only says the shell hides it. Test.
   *   · `.eslintrc.config.ts` — the explicit config patterns still win over
   *     both, because `.config.ts` is as specific as a name gets.
   */
  it('lets a spec suffix beat a leading dot, but not the config patterns', () => {
    expect(kindForPath('.hidden.spec.ts')).toBe('spec-ts');
    expect(kindForPath('.env')).toBe('config');
    expect(kindForPath('.env.local')).toBe('config');
    expect(kindForPath('.hidden.ts')).toBe('config');
    expect(kindForPath('.hidden.config.ts')).toBe('config');
  });

  it('reads only the last segment, so a dot in a folder name proves nothing', () => {
    expect(kindForPath('some.dir/notes')).toBe('unknown');
    expect(kindForPath('v1.2.3/orders.csv')).toBe('csv');
  });

  it('survives the paths that should never reach it', () => {
    // buildTree drops these before they become rows, but an icon helper that
    // throws takes the whole panel down with it.
    expect(kindForPath('')).toBe('unknown');
    expect(kindForPath('/')).toBe('unknown');
    expect(kindForPath('///')).toBe('unknown');
    expect(kindForPath('checkout/')).toBe('unknown');
    expect(kindForPath('.')).toBe('config');
    expect(kindForPath('trailing.')).toBe('unknown');
  });

  /*
   * Each of these is a pair the ORDER inside kindForPath decides, and each
   * would silently repaint a column of rows if the order were shuffled.
   */
  describe('precedence between overlapping patterns', () => {
    it('lock beats json and yaml', () => {
      expect(kindForPath('package-lock.json')).not.toBe('json');
      expect(kindForPath('pnpm-lock.yaml')).not.toBe('yaml');
    });
    it('a11y beats the generic spec suffix', () => {
      expect(kindForPath('home.a11y.json')).toBe('a11y-json');
    });
    it('config beats plain source and plain json', () => {
      expect(kindForPath('playwright.config.ts')).not.toBe('code-ts');
      expect(kindForPath('tsconfig.json')).not.toBe('json');
    });
    it('spec beats plain source', () => {
      expect(kindForPath('a.spec.ts')).not.toBe('code-ts');
      expect(kindForPath('a.spec.js')).not.toBe('code-js');
    });
  });
});

// ─── kindForTestType: the type alone ─────────────────────────────────────────

describe('kindForTestType', () => {
  it('gives the four Playwright-source types the TypeScript spec icon', () => {
    for (const type of ['E2E', 'SMOKE', 'CROSS_BROWSER', 'LOCALIZATION']) {
      expect(kindForTestType(type)).toBe('spec-ts');
    }
  });

  it('gives ACCESSIBILITY its own icon', () => {
    expect(kindForTestType('ACCESSIBILITY')).toBe('a11y-json');
  });

  it('gives every remaining type the JSON spec icon, and none of them a blank', () => {
    for (const type of TEST_TYPES) {
      const kind = kindForTestType(type);
      expect(FILE_KINDS).toContain(kind);
      if (!['E2E', 'SMOKE', 'CROSS_BROWSER', 'LOCALIZATION', 'ACCESSIBILITY'].includes(type)) {
        expect(kind).toBe('spec-json');
      }
    }
  });

  it('does not fall over on a type the enum grew after this shipped', () => {
    expect(kindForTestType('SOMETHING_NEW')).toBe('spec-json');
  });
});

// ─── kindFor: path and type together ─────────────────────────────────────────

describe('kindFor', () => {
  it('leaves an unambiguous path alone whatever the type says', () => {
    expect(kindFor('checkout/total.spec.ts', 'API')).toBe('spec-ts');
    expect(kindFor('README.md', 'E2E')).toBe('markdown');
    expect(kindFor('baselines/home.png', 'VISUAL')).toBe('image');
    expect(kindFor('package-lock.json', 'API')).toBe('lock');
  });

  it('promotes a bare .json to a spec once a test row is attached to it', () => {
    // `checkout/total.json` is indistinguishable from a fixture by name alone.
    expect(kindFor('checkout/total.json')).toBe('json');
    expect(kindFor('checkout/total.json', 'API')).toBe('spec-json');
  });

  it('lets ACCESSIBILITY claim a JSON that does not carry the suffix', () => {
    expect(kindFor('checkout/total.json', 'ACCESSIBILITY')).toBe('a11y-json');
    expect(kindFor('checkout/total.api.json', 'ACCESSIBILITY')).toBe('a11y-json');
  });

  it('promotes plain source to a spec once a test row is attached to it', () => {
    expect(kindFor('helpers/flow.ts')).toBe('code-ts');
    expect(kindFor('helpers/flow.ts', 'E2E')).toBe('spec-ts');
    expect(kindFor('helpers/flow.js', 'E2E')).toBe('spec-js');
  });

  it('falls back to the type when the path says nothing at all', () => {
    expect(kindFor('checkout/total')).toBe('unknown');
    expect(kindFor('checkout/total', 'E2E')).toBe('spec-ts');
    expect(kindFor('checkout/total', 'API')).toBe('spec-json');
    expect(kindFor('checkout/total', 'ACCESSIBILITY')).toBe('a11y-json');
  });

  /*
   * The rule the explorer has always enforced in prose ("fixtures are test
   * DATA, not tests") made mechanical. Without it a fixture named after the
   * spec that reads it would be drawn as a runnable test.
   */
  describe('fixtures are data, whatever else they look like', () => {
    it('keeps the fixture icon on a spec-suffixed name', () => {
      expect(kindFor('fixtures/users.api.json')).toBe('json');
      expect(kindFor('fixtures/audit.a11y.json')).toBe('json');
    });
    it('keeps the fixture icon even when a type is passed', () => {
      expect(kindFor('fixtures/users.json', 'API')).toBe('json');
      expect(kindFor('fixtures/users.json', 'ACCESSIBILITY')).toBe('json');
      expect(kindFor('fixtures/nested/deep/users.api.json', 'API')).toBe('json');
    });
    /*
     * "Whatever its suffix" includes the SOURCE suffixes, which is the half the
     * rule used to skip: a `fixtures/x.spec.ts` kept the runnable play-mark icon
     * while a `fixtures/x.api.json` did not. Nothing under `fixtures/` runs —
     * the API refuses to move a runnable test in there — so a play mark on one
     * is the icon promising something the server will not do.
     */
    it('demotes a spec SOURCE file too, not only a spec JSON', () => {
      expect(kindFor('fixtures/seed.spec.ts')).toBe('code-ts');
      expect(kindFor('fixtures/seed.spec.js')).toBe('code-js');
      expect(kindFor('fixtures/seed.test.ts', 'E2E')).toBe('code-ts');
      expect(kindFor('fixtures/deep/seed.spec.tsx')).toBe('code-ts');
    });

    /*
     * And the type is not consulted at all inside `fixtures/`, so an
     * extensionless fixture stays unknown instead of borrowing the icon of
     * whatever test row happens to be attached to it.
     */
    it('does not let the test type rescue an extensionless fixture', () => {
      expect(kindFor('fixtures/seed', 'E2E')).toBe('unknown');
      expect(kindFor('fixtures/seed', 'ACCESSIBILITY')).toBe('unknown');
      expect(kindFor('checkout/seed', 'E2E')).toBe('spec-ts');
    });

    /*
     * Case-SENSITIVE, matching the server. Every check on the API and in the
     * worker is `filePath.startsWith(FIXTURE_PREFIX)`, so `Fixtures/` is an
     * ordinary folder there. Lower-casing here made the icon layer a second,
     * disagreeing answer to "is this a fixture" — the exact class of bug this
     * codebase keeps hitting.
     */
    it('agrees with the server about case', () => {
      expect(kindFor('Fixtures/users.api.json')).toBe('spec-json');
      expect(kindFor('FIXTURES/users.api.json')).toBe('spec-json');
      expect(kindFor('fixtures/users.api.json')).toBe('json');
    });

    it('still reads non-JSON fixtures by extension', () => {
      expect(kindFor('fixtures/orders.csv', 'API')).toBe('csv');
      expect(kindFor('fixtures/notes.md')).toBe('markdown');
    });
    it('is not fooled by a folder that merely starts with the same letters', () => {
      expect(kindFor('fixtures-old/users.api.json')).toBe('spec-json');
    });
  });

  it('treats null, undefined and empty-string types as no type at all', () => {
    expect(kindFor('checkout/total.json', null)).toBe('json');
    expect(kindFor('checkout/total.json', undefined)).toBe('json');
    expect(kindFor('checkout/total.json', '')).toBe('json');
  });
});

// ─── The set itself ──────────────────────────────────────────────────────────

describe('the icon set', () => {
  it('has meta for every kind and no kind without meta', () => {
    expect(Object.keys(FILE_KIND_META).sort()).toEqual([...FILE_KINDS].sort());
  });

  it.each([...FILE_KINDS])('%s is coloured with a design token, never a raw value', (kind) => {
    const cls = iconClassFor(kind);
    expect(cls).toMatch(TOKEN_CLASS);
    expect(cls).not.toMatch(/#|blue|slate|gray|grey|zinc|indigo|amber|emerald|\d{3}\b/);
  });

  it('uses only the five named roles', () => {
    const roles = new Set(FILE_KINDS.map((k) => FILE_KIND_META[k].role));
    expect([...roles].sort()).toEqual(['audit', 'data', 'inert', 'neutral', 'subject']);
    for (const role of roles) expect(ICON_ROLE_CLASS[role]).toMatch(TOKEN_CLASS);
  });

  it('gives every kind a non-empty label', () => {
    for (const kind of FILE_KINDS) expect(FILE_KIND_META[kind].label.length).toBeGreaterThan(0);
  });

  it('draws a different shape for every kind, so hue is never the only signal', () => {
    const shapes = FILE_KINDS.map(shape);
    expect(new Set(shapes).size).toBe(FILE_KINDS.length);
    // And nothing is empty: the fallback is a real glyph, not whitespace.
    for (const s of shapes) expect(s.length).toBeGreaterThan(0);
  });

  it('holds every glyph to one grid, one weight and one size', () => {
    for (const kind of FILE_KINDS) {
      const svg = host(FILE_KIND_META[kind].Icon({}));
      expect(svg.type).toBe('svg');
      expect(svg.props.viewBox).toBe('0 0 16 16');
      expect(svg.props.strokeWidth).toBe(1.4);
      expect(svg.props.fill).toBe('none');
      expect(svg.props.stroke).toBe('currentColor');
      expect(String(svg.props.className)).toContain('h-[13px] w-[13px]');
    }
  });

  it('labels every icon for assistive tech and for the cursor', () => {
    for (const kind of FILE_KINDS) {
      const svg = host(FILE_KIND_META[kind].Icon({}));
      expect(svg.props.role).toBe('img');
      expect(svg.props['aria-label']).toBe(FILE_KIND_META[kind].label);
      const title = children(svg).find((c) => c.type === 'title');
      expect(title?.props.children).toBe(FILE_KIND_META[kind].label);
    }
  });

  it('goes silent when the caller says the icon is decoration', () => {
    const svg = host(FILE_KIND_META['spec-ts'].Icon({ decorative: true }));
    expect(svg.props['aria-hidden']).toBe(true);
    expect(svg.props.role).toBeUndefined();
    expect(svg.props['aria-label']).toBeUndefined();
    expect(children(svg).some((c) => c.type === 'title')).toBe(false);
  });

  it('draws folders at the same weight, and says which way they are pointing', () => {
    const closed = host(FolderIcon({}));
    const open = host(FolderIcon({ open: true }));
    expect(closed.props['aria-label']).toBe('Folder, collapsed');
    expect(open.props['aria-label']).toBe('Folder, expanded');
    expect(closed.props.strokeWidth).toBe(1.4);
    expect(open.props.viewBox).toBe('0 0 16 16');
    // Different shapes, not just a different word.
    const shapeOf = (el: Elementish) =>
      children(el)
        .filter((c) => c.type !== 'title')
        .map((c) => JSON.stringify(c.props))
        .join('|');
    expect(shapeOf(open)).not.toBe(shapeOf(closed));
  });
});

// ─── iconFor: the one call a row makes ───────────────────────────────────────

describe('iconFor', () => {
  it('returns the component for the kind it derived, already tinted', () => {
    const el = iconFor('checkout/total.spec.ts') as unknown as Elementish;
    expect(el.type).toBe(FILE_KIND_META['spec-ts'].Icon);
    expect(String(el.props.className)).toContain('text-accent');
  });

  it('threads the test type through to the kind', () => {
    const el = iconFor('checkout/total.json', 'ACCESSIBILITY') as unknown as Elementish;
    expect(el.type).toBe(FILE_KIND_META['a11y-json'].Icon);
  });

  it('lets a caller override the size without losing the colour', () => {
    const el = iconFor('README.md', null, 'h-4 w-4') as unknown as Elementish;
    const cls = String(host(el).props.className);
    // twMerge keeps the later size and drops the default, but the tint stays.
    expect(cls).toContain('h-4');
    expect(cls).toContain('w-4');
    expect(cls).not.toContain('h-[13px]');
    expect(cls).toContain('text-ink-dim');
  });

  it('never returns nothing, for any path', () => {
    for (const path of ['', '/', 'LICENSE', 'a.qqq', 'weird name.with.dots']) {
      const el = iconFor(path) as unknown as Elementish;
      expect(typeof el.type).toBe('function');
      expect(host(el).type).toBe('svg');
    }
  });
});

// ─── Drift guards ────────────────────────────────────────────────────────────

/*
 * Three constants in `icons.tsx` are copies of things `@qaai/shared` owns, and
 * the copies are deliberate: that package ships source TS and the web build has
 * no transpilePackages entry for it, so importing it into a bundled module is
 * not an option. A copy with nothing checking it is a copy that is already
 * wrong, though — so the checking happens HERE, in a file vitest runs and Next
 * never bundles, which is the one place both halves can be seen at once.
 */
describe('the constants copied out of @qaai/shared', () => {
  it('lists exactly the typed spec suffixes the new-test templates mint', () => {
    const fromTemplates = Object.values(NEW_TEST_TEMPLATES)
      .filter((template) => template.buffer === 'spec')
      .map((template) => template.fileSuffix);
    expect([...SPEC_JSON_SUFFIXES].sort()).toEqual([...new Set(fromTemplates)].sort());
  });

  it('lists exactly the types whose buffer is Playwright source', () => {
    const fromTemplates = TEST_TYPES.filter(
      (type) => NEW_TEST_TEMPLATES[type]?.buffer === 'code',
    );
    expect([...CODE_BUFFER_TYPES].sort()).toEqual([...fromTemplates].sort());
  });

  /*
   * One prefix, one answer. The model owns the copy the whole tree reads, and
   * `icons.tsx` now imports its `isFixturePath` rather than keeping a second
   * one that lower-cased first and answered differently.
   */
  it('uses the same fixture prefix the server does', () => {
    expect(MODEL_FIXTURE_PREFIX).toBe(FIXTURE_PREFIX);
  });

  /*
   * And the sweep below is driven by the shared enum itself, so a nineteenth
   * test type becoming a twentieth cannot leave a gap here: an unlisted type
   * lands on the JSON spec icon, which is right, and this proves it rather than
   * assuming it.
   */
  it('gives every type in the enum a real icon', () => {
    for (const type of TEST_TYPES) {
      expect(FILE_KINDS).toContain(kindForTestType(type));
    }
  });
});

// ─── iconFor: the decorative option ──────────────────────────────────────────

/*
 * `IconProps` has documented `decorative` from the start, and `iconFor` — the
 * one call a row actually makes — had no way to pass it. The third argument now
 * takes the options object the documentation implies, and a bare string still
 * means `className`, so the common call is unchanged.
 */
describe('iconFor options', () => {
  it('still takes a bare className string', () => {
    const el = iconFor('README.md', null, 'h-4 w-4') as unknown as Elementish;
    const svg = host(el);
    expect(String(svg.props.className)).toContain('h-4');
    expect(svg.props.role).toBe('img');
  });

  it('takes the same className in the options object', () => {
    const el = iconFor('README.md', null, { className: 'h-4 w-4' }) as unknown as Elementish;
    expect(String(host(el).props.className)).toContain('h-4');
  });

  it('goes silent for assistive tech when the row already says the kind', () => {
    const el = iconFor('checkout/a.spec.ts', 'E2E', { decorative: true }) as unknown as Elementish;
    const svg = host(el);
    expect(svg.props['aria-hidden']).toBe(true);
    expect(svg.props.role).toBeUndefined();
    expect(svg.props['aria-label']).toBeUndefined();
    expect(children(svg).some((c) => c.type === 'title')).toBe(false);
    // The colour survives: it is decoration, not invisibility.
    expect(String(svg.props.className)).toContain('text-accent');
  });

  it('is labelled by default, and labelled with the kind it derived', () => {
    for (const options of [undefined, {}, 'h-4', { decorative: false }] as const) {
      const el = iconFor('home.a11y.json', null, options) as unknown as Elementish;
      const svg = host(el);
      expect(svg.props.role).toBe('img');
      expect(svg.props['aria-label']).toBe(FILE_KIND_META['a11y-json'].label);
    }
  });
});
