/**
 * DOM diff against the last green run (§5) — "what actually moved?"
 *
 * The cockpit hands you a screenshot of a failed test and leaves the reading to
 * you. But a screenshot cannot tell you that the Add-to-cart control kept its
 * pixels and lost its accessible name, and that is the single most common way a
 * locator breaks. QAAI already records a Playwright trace on failure, and a
 * trace carries a full DOM snapshot per action — so the evidence for "this
 * button moved and lost its accessible name" is already on disk. This module
 * turns two of those snapshots into that sentence.
 *
 * Three decisions shape everything below.
 *
 * **Structural, never textual.** A line diff of serialized DOM is unreadable:
 * minified markup has no lines, and the lines it does have are dominated by
 * generated ids and hashed class names. What a test cares about is the
 * accessibility shape — role, accessible name, position, whether the thing is
 * still visible and still enabled — so that is what gets compared.
 *
 * **Volatile attributes are dropped, and the drop is reported.** Without this,
 * every run diffs 400 lines of `css-1x2y3z` churn. With it, we are hiding real
 * bytes from the user, so `ignoredAttributes` says exactly what was hidden and
 * why. A filter nobody can see is a filter nobody can trust.
 *
 * **The test's own locators rank the output.** An element the failing selector
 * was looking for is the finding. Everything else is context, and is labelled
 * that way rather than being deleted — the cause is sometimes two nodes over.
 *
 * Everything here is pure: snapshots in, findings out. Storage, Prisma and zip
 * handling live in the route, which keeps this file testable without fixtures
 * on disk.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The Playwright trace snapshot format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node in a Playwright frame snapshot.
 *
 * Three shapes share one array type, which is why the guards below exist:
 *  - `"some text"`                     — a text node
 *  - `["DIV", { class: "x" }, ...kids]` — an element (attrs optional)
 *  - `[[2, 41]]`                        — a back-reference: "node 41 of the
 *    snapshot 2 before this one, unchanged". Playwright emits these for every
 *    subtree that did not change between actions, so most of a snapshot is
 *    references and resolving them is not optional.
 */
export type RawNode = string | unknown[];

export interface RawFrameSnapshot {
  callId?: string;
  snapshotName?: string;
  pageId?: string;
  frameId?: string;
  frameUrl?: string;
  isMainFrame?: boolean;
  html: RawNode;
  viewport?: { width: number; height: number };
  timestamp?: number;
  wallTime?: number;
}

/** Playwright's own bookkeeping attributes. Never part of the page. */
const PLAYWRIGHT_INTERNAL_PREFIX = '__playwright_';
/** Marks the element the action under trace was aimed at. */
const PLAYWRIGHT_TARGET_ATTR = '__playwright_target__';
/** Carries the live value of an input, which the `value` attribute does not. */
const PLAYWRIGHT_VALUE_ATTR = '__playwright_value_';

function isTextNode(node: RawNode): node is string {
  return typeof node === 'string';
}

function isElementNode(node: RawNode): node is unknown[] {
  return Array.isArray(node) && typeof node[0] === 'string';
}

function isReferenceNode(node: RawNode): node is unknown[] {
  return Array.isArray(node) && Array.isArray(node[0]);
}

function attributesOf(node: unknown[]): Record<string, string> {
  const candidate = node[1];
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, string>;
  }
  return {};
}

/** Children start after the attributes object, when there is one. */
function childrenOf(node: unknown[]): RawNode[] {
  const candidate = node[1];
  const start = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? 2 : 1;
  return node.slice(start) as RawNode[];
}

/**
 * The flat node list a back-reference indexes into.
 *
 * Post-order — children before their parent — and references are not counted,
 * because that is how Playwright numbers them when it writes the trace. Getting
 * the order wrong does not throw; it silently resolves every reference to the
 * wrong element, so this ordering is load-bearing and is covered by a test.
 */
function flattenForReferences(snapshot: RawFrameSnapshot): RawNode[] {
  const nodes: RawNode[] = [];
  const walk = (node: RawNode): void => {
    if (isTextNode(node)) {
      nodes.push(node);
      return;
    }
    if (isElementNode(node)) {
      for (const child of childrenOf(node)) walk(child);
      nodes.push(node);
    }
  };
  walk(snapshot.html);
  return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// The normalised model
// ─────────────────────────────────────────────────────────────────────────────

export interface DomElement {
  /**
   * Structural address, e.g. `html>body>main>form:nth-of-type(2)>button`.
   * Stable-ish on purpose: it survives a class rename but not a real move,
   * which is exactly the signal MOVED is looking for.
   */
  path: string;
  parentPath: string;
  tag: string;
  /** ARIA role — explicit `role=`, else the implicit role for the tag. */
  role: string;
  /** Accessible name, approximated (see `accessibleName`). */
  name: string;
  /** Where the name came from, so the UI can say "from aria-label". */
  nameSource: string;
  testId: string | null;
  /** Only kept when the id does not look machine-generated. */
  id: string | null;
  /** Own text, collapsed and capped. Empty for container elements. */
  text: string;
  hidden: boolean;
  disabled: boolean;
  /** Attributes after volatile ones are removed. */
  attrs: Record<string, string>;
  /** Playwright marked this as the element the traced action targeted. */
  actionTarget: boolean;
  depth: number;
  /** Document order among elements. Used to describe a move, not to match. */
  order: number;
}

export interface IgnoredAttribute {
  attribute: string;
  occurrences: number;
  reason: string;
}

export interface DomSnapshot {
  frameUrl: string;
  /** Playwright's own label, e.g. `after@call@12`. */
  snapshotName: string;
  wallTime: number | null;
  elements: DomElement[];
  ignoredAttributes: IgnoredAttribute[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Volatile attribute policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attributes whose value changes on every render by design.
 *
 * Framework bookkeeping, hydration markers, and cache-busting. None of them
 * carry meaning for a locator, and all of them differ between any two runs.
 */
const VOLATILE_ATTRIBUTE_NAMES: Array<{ test: RegExp; reason: string }> = [
  { test: /^nonce$/i, reason: 'CSP nonce — new on every response' },
  { test: /^data-reactid$/i, reason: 'React bookkeeping' },
  { test: /^data-react-checksum$/i, reason: 'React bookkeeping' },
  { test: /^data-reactroot$/i, reason: 'React bookkeeping' },
  { test: /^data-v-[0-9a-f]+$/i, reason: 'Vue scoped-style marker' },
  { test: /^data-svelte-h$/i, reason: 'Svelte hydration marker' },
  { test: /^data-astro-(cid|source)/i, reason: 'Astro build marker' },
  { test: /^data-emotion$/i, reason: 'Emotion style bookkeeping' },
  { test: /^data-styled/i, reason: 'styled-components bookkeeping' },
  { test: /^data-n-head$/i, reason: 'Nuxt head bookkeeping' },
  { test: /^data-headlessui-state$/i, reason: 'Headless UI transient state' },
  { test: /^data-radix-/i, reason: 'Radix generated marker' },
  { test: /^data-floating-ui-/i, reason: 'Floating UI generated marker' },
  { test: /^aria-activedescendant$/i, reason: 'points at a generated id' },
  { test: /^integrity$/i, reason: 'asset hash — changes on every build' },
];

/** Values that are generated per render: React ids, UUIDs, hashes, epochs. */
const GENERATED_VALUE_PATTERNS: RegExp[] = [
  /^:[a-zA-Z0-9]+:$/, // React 18 useId, e.g. ":r3:"
  /^(radix|headlessui|mui|mantine|chakra|reach)-/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{16,}$/i, // long hex hash
  /^\d{10,}$/, // epoch seconds / millis
];

/** Attributes whose value is an id, so a generated id makes them volatile too. */
const ID_BEARING_ATTRIBUTES = new Set([
  'id',
  'for',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-details',
  'form',
  'list',
]);

/** Class tokens produced by a bundler rather than written by a human. */
const HASHED_CLASS_PATTERNS: RegExp[] = [
  /^css-[a-z0-9]{5,}$/i, // Emotion
  /^sc-[A-Za-z0-9]{5,}$/, // styled-components
  /^jsx-\d+$/, // styled-jsx
  /^[A-Za-z][\w-]*__[\w-]+___[A-Za-z0-9_-]{5,}$/, // CSS modules, long form
  /^[A-Za-z][\w-]*_[A-Za-z0-9_-]{5,}__[A-Za-z0-9_-]{5,}$/, // CSS modules, Next
  /^[a-z]{1,4}_[A-Za-z0-9]{6,}$/, // Next.js `.module.css` short form
  /^svelte-[a-z0-9]{6,}$/,
  /^v-[0-9a-f]{8}$/,
];

function looksGenerated(value: string): boolean {
  return GENERATED_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * A class list with the bundler's hashes removed.
 *
 * Returns null when nothing readable survives — a `class` of pure hash is
 * noise, and reporting "class changed" on it is the exact failure mode this
 * whole filter exists to prevent.
 */
function stableClasses(value: string): string | null {
  const kept = value
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !HASHED_CLASS_PATTERNS.some((pattern) => pattern.test(token)));
  return kept.length ? kept.join(' ') : null;
}

/** Query strings are where cache-busting lives; the path is the identity. */
function stableUrlAttribute(value: string): string {
  const cut = value.indexOf('?');
  return cut === -1 ? value : value.slice(0, cut);
}

// ─────────────────────────────────────────────────────────────────────────────
// Roles and accessible names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Implicit ARIA roles for the elements a test actually locates.
 *
 * Deliberately not the full HTML-AAM table: an incomplete map produces an empty
 * role, which the diff treats as "no role information" and falls back on. A
 * *wrong* role would silently mis-match two elements, which is worse.
 */
const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: 'button',
  A: 'link', // only with href; handled below
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  ASIDE: 'complementary',
  FORM: 'form',
  SEARCH: 'search',
  DIALOG: 'dialog',
  TABLE: 'table',
  THEAD: 'rowgroup',
  TBODY: 'rowgroup',
  TFOOT: 'rowgroup',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  OPTION: 'option',
  PROGRESS: 'progressbar',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  IMG: 'img',
  FIGURE: 'figure',
  HR: 'separator',
  OUTPUT: 'status',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
  password: '', // no implicit role, per HTML-AAM
  hidden: '',
};

/** Roles whose accessible name comes from their own text content. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'cell',
  'columnheader',
  'rowheader',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'checkbox',
  'radio',
  'switch',
  'listitem',
  'row',
  'status',
]);

/** Roles a test is likely to target. Used only to break ranking ties. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
]);

function implicitRole(tag: string, attrs: Record<string, string>): string {
  if (tag === 'A') return attrs.href === undefined ? '' : 'link';
  if (tag === 'INPUT') {
    const type = (attrs.type ?? 'text').toLowerCase();
    return INPUT_ROLES[type] ?? 'textbox';
  }
  if (tag === 'SECTION' || tag === 'ASIDE') {
    // A landmark only when it is named — an unnamed <section> is generic.
    const named = attrs['aria-label'] || attrs['aria-labelledby'];
    if (tag === 'SECTION') return named ? 'region' : '';
    return 'complementary';
  }
  if (tag === 'SELECT') {
    const multiple = attrs.multiple !== undefined || Number(attrs.size ?? '1') > 1;
    return multiple ? 'listbox' : 'combobox';
  }
  if (tag === 'IMG') {
    // alt="" is the author saying "this is decoration"; respect it.
    return attrs.alt === '' ? 'presentation' : 'img';
  }
  return IMPLICIT_ROLES[tag] ?? '';
}

/** Collapse runs of whitespace and cap, so one huge <pre> cannot dominate. */
function collapse(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tags whose text is markup, not content. */
const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** Intermediate node, before attributes are sanitised. */
interface Walked {
  tag: string;
  rawAttrs: Record<string, string>;
  path: string;
  parentPath: string;
  depth: number;
  /** Concatenated descendant text, for name-from-content and TEXT_CHANGED. */
  textContent: string;
  /** Direct child elements, so a "deepest changed node" rule is possible. */
  childIndexes: number[];
  hiddenBySelf: boolean;
}

/**
 * Walk one snapshot, resolving back-references, into a flat element list.
 *
 * `index` is the snapshot's position in `all`, which is what a reference's
 * distance is measured against. A reference that points outside the list is
 * dropped rather than throwing: a truncated trace is a damaged artifact, and a
 * partial diff beats a 500.
 */
function walkSnapshot(all: RawFrameSnapshot[], index: number): Walked[] {
  const out: Walked[] = [];
  /** Cached per snapshot — the flatten is O(n) and references hit it often. */
  const flattened = new Map<number, RawNode[]>();
  const nodesFor = (i: number): RawNode[] => {
    let cached = flattened.get(i);
    if (!cached) {
      cached = flattenForReferences(all[i]!);
      flattened.set(i, cached);
    }
    return cached;
  };

  /**
   * Guards against a self-referential trace: a malformed reference chain could
   * otherwise loop forever inside one request.
   */
  let budget = 200_000;

  const visit = (
    node: RawNode,
    snapshotIndex: number,
    parentPath: string,
    depth: number,
    siblingCounts: Map<string, number>,
  ): string => {
    if (budget-- <= 0) return '';

    if (isTextNode(node)) return node;

    if (isReferenceNode(node)) {
      const [distance, nodeIndex] = node[0] as [number, number];
      const target = snapshotIndex - distance;
      if (target < 0 || target > snapshotIndex || target >= all.length) return '';
      const nodes = nodesFor(target);
      if (nodeIndex < 0 || nodeIndex >= nodes.length) return '';
      return visit(nodes[nodeIndex]!, target, parentPath, depth, siblingCounts);
    }

    if (!isElementNode(node)) return '';

    const tag = String(node[0]).toUpperCase();
    const rawAttrs = attributesOf(node);

    const seen = (siblingCounts.get(tag) ?? 0) + 1;
    siblingCounts.set(tag, seen);
    const segment = seen === 1 ? tag.toLowerCase() : `${tag.toLowerCase()}:nth-of-type(${seen})`;
    const path = parentPath ? `${parentPath}>${segment}` : segment;

    const self: Walked = {
      tag,
      rawAttrs,
      path,
      parentPath,
      depth,
      textContent: '',
      childIndexes: [],
      hiddenBySelf: isHidden(tag, rawAttrs),
    };
    out.push(self);

    const childCounts = new Map<string, number>();
    const pieces: string[] = [];
    for (const child of childrenOf(node)) {
      const before = out.length;
      const text = visit(child, snapshotIndex, path, depth + 1, childCounts);
      if (out.length > before) self.childIndexes.push(before);
      if (text) pieces.push(text);
    }

    self.textContent = NON_RENDERED_TAGS.has(tag) ? '' : collapse(pieces.join(' '), 400);
    return self.textContent;
  };

  visit(all[index]!.html, index, '', 0, new Map());
  return out;
}

function isHidden(tag: string, attrs: Record<string, string>): boolean {
  if (attrs.hidden !== undefined) return true;
  if ((attrs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  if (tag === 'INPUT' && (attrs.type ?? '').toLowerCase() === 'hidden') return true;
  const style = (attrs.style ?? '').toLowerCase();
  if (/display\s*:\s*none/.test(style)) return true;
  if (/visibility\s*:\s*hidden/.test(style)) return true;
  return false;
}

function isDisabled(attrs: Record<string, string>): boolean {
  if (attrs.disabled !== undefined) return true;
  if ((attrs['aria-disabled'] ?? '').toLowerCase() === 'true') return true;
  return false;
}

/**
 * Accessible name, approximated.
 *
 * This is not the full accname algorithm — no shadow DOM, no CSS-generated
 * content, no recursion budget subtleties. It follows the precedence order that
 * matters in practice (`aria-labelledby`, `aria-label`, native label, content),
 * which is the same order `getByRole(..., { name })` resolves in for the markup
 * tests actually target. Where it is unsure it returns an empty name, and the
 * diff treats an empty name as "no information" rather than as a change.
 */
function accessibleName(
  node: Walked,
  role: string,
  byId: Map<string, Walked>,
  labelFor: Map<string, Walked[]>,
  nodes: Walked[],
): { name: string; source: string } {
  const attrs = node.rawAttrs;

  const labelledBy = attrs['aria-labelledby'];
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => byId.get(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return { name: collapse(parts.join(' ')), source: 'aria-labelledby' };
  }

  if (attrs['aria-label']?.trim()) {
    return { name: collapse(attrs['aria-label']), source: 'aria-label' };
  }

  if (node.tag === 'IMG' || node.tag === 'AREA') {
    if (attrs.alt !== undefined) return { name: collapse(attrs.alt), source: 'alt' };
  }

  const isFormControl =
    node.tag === 'INPUT' || node.tag === 'SELECT' || node.tag === 'TEXTAREA' || attrs.role === 'textbox';
  if (isFormControl) {
    const type = (attrs.type ?? '').toLowerCase();
    if (node.tag === 'INPUT' && (type === 'button' || type === 'submit' || type === 'reset')) {
      if (attrs.value) return { name: collapse(attrs.value), source: 'value' };
    }
    if (attrs.id) {
      const labels = labelFor.get(attrs.id) ?? [];
      const text = labels.map((l) => l.textContent).filter(Boolean).join(' ');
      if (text) return { name: collapse(text), source: '<label for>' };
    }
    // Wrapping label: nearest ancestor <label> by path prefix.
    const wrapping = nodes.find(
      (candidate) => candidate.tag === 'LABEL' && node.path.startsWith(`${candidate.path}>`),
    );
    if (wrapping?.textContent) {
      return { name: collapse(wrapping.textContent), source: 'wrapping <label>' };
    }
    if (attrs.placeholder) return { name: collapse(attrs.placeholder), source: 'placeholder' };
  }

  if (node.tag === 'FIELDSET') {
    const legend = nodes.find(
      (candidate) => candidate.tag === 'LEGEND' && candidate.parentPath === node.path,
    );
    if (legend?.textContent) return { name: collapse(legend.textContent), source: '<legend>' };
  }

  if (node.tag === 'TABLE') {
    const caption = nodes.find(
      (candidate) => candidate.tag === 'CAPTION' && candidate.parentPath === node.path,
    );
    if (caption?.textContent) return { name: collapse(caption.textContent), source: '<caption>' };
  }

  if (NAME_FROM_CONTENT.has(role) && node.textContent) {
    return { name: collapse(node.textContent), source: 'text content' };
  }

  if (attrs.title?.trim()) return { name: collapse(attrs.title), source: 'title' };

  return { name: '', source: '' };
}

/**
 * A snapshot from the trace, normalised into comparable elements.
 *
 * `all` is every snapshot for one frame, in trace order; `index` picks the one
 * to resolve. Both are needed because back-references reach backwards into the
 * frame's own history.
 */
export function normaliseSnapshot(all: RawFrameSnapshot[], index: number): DomSnapshot {
  const source = all[index]!;
  const walked = walkSnapshot(all, index);

  const byId = new Map<string, Walked>();
  const labelFor = new Map<string, Walked[]>();
  for (const node of walked) {
    const id = node.rawAttrs.id;
    if (id && !byId.has(id)) byId.set(id, node);
    if (node.tag === 'LABEL' && node.rawAttrs.for) {
      const list = labelFor.get(node.rawAttrs.for) ?? [];
      list.push(node);
      labelFor.set(node.rawAttrs.for, list);
    }
  }

  /** Hidden is inherited: a child of a hidden container is not on the page. */
  const hiddenPaths: string[] = [];
  const inheritsHidden = (node: Walked): boolean =>
    hiddenPaths.some((prefix) => node.path.startsWith(`${prefix}>`));

  const ignored = new Map<string, IgnoredAttribute>();
  const noteIgnored = (attribute: string, reason: string): void => {
    const existing = ignored.get(attribute);
    if (existing) existing.occurrences += 1;
    else ignored.set(attribute, { attribute, occurrences: 1, reason });
  };

  const elements: DomElement[] = [];

  for (const node of walked) {
    if (NON_RENDERED_TAGS.has(node.tag)) continue;

    if (node.hiddenBySelf) hiddenPaths.push(node.path);
    const hidden = node.hiddenBySelf || inheritsHidden(node);

    const role = (node.rawAttrs.role ?? '').trim() || implicitRole(node.tag, node.rawAttrs);
    const { name, source: nameSource } = accessibleName(node, role, byId, labelFor, walked);

    // Attribute sanitising happens after naming, so a generated id can still be
    // followed by aria-labelledby before it is dropped from the display set.
    const attrs: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(node.rawAttrs)) {
      if (key.startsWith(PLAYWRIGHT_INTERNAL_PREFIX)) continue; // not page markup

      const volatileName = VOLATILE_ATTRIBUTE_NAMES.find((entry) => entry.test.test(key));
      if (volatileName) {
        noteIgnored(key, volatileName.reason);
        continue;
      }

      const value = String(rawValue);

      if (ID_BEARING_ATTRIBUTES.has(key) && looksGenerated(value)) {
        noteIgnored(key, 'value looks machine-generated');
        continue;
      }

      if (key === 'class') {
        const kept = stableClasses(value);
        if (kept === null) {
          noteIgnored('class', 'every class token was a bundler hash');
          continue;
        }
        if (kept !== value) noteIgnored('class', 'bundler-hashed class tokens');
        attrs.class = kept;
        continue;
      }

      if (key === 'src' || key === 'href' || key === 'srcset') {
        const stripped = stableUrlAttribute(value);
        if (stripped !== value) noteIgnored(key, 'query string (cache-busting)');
        attrs[key] = stripped;
        continue;
      }

      attrs[key] = value;
    }

    const rawId = node.rawAttrs.id;
    const testId =
      node.rawAttrs['data-testid'] ??
      node.rawAttrs['data-test-id'] ??
      node.rawAttrs['data-test'] ??
      node.rawAttrs['data-qa'] ??
      null;

    // A form control's live value is what the user sees; the attribute is what
    // the server sent. Playwright records the former, so prefer it.
    const liveValue = node.rawAttrs[PLAYWRIGHT_VALUE_ATTR];
    if (liveValue !== undefined) attrs.value = String(liveValue);

    elements.push({
      path: node.path,
      parentPath: node.parentPath,
      tag: node.tag,
      role,
      name,
      nameSource,
      testId,
      id: rawId && !looksGenerated(rawId) ? rawId : null,
      // Leaf text only: reporting a changed price on <body> as well as on the
      // <span> holding it turns one finding into fifteen.
      text: node.childIndexes.length === 0 ? collapse(node.textContent, 120) : '',
      hidden,
      disabled: isDisabled(node.rawAttrs),
      attrs,
      actionTarget: node.rawAttrs[PLAYWRIGHT_TARGET_ATTR] !== undefined,
      depth: node.depth,
      order: elements.length,
    });
  }

  return {
    frameUrl: source.frameUrl ?? '',
    snapshotName: source.snapshotName ?? '',
    wallTime: typeof source.wallTime === 'number' ? source.wallTime : null,
    elements,
    ignoredAttributes: [...ignored.values()].sort((a, b) => b.occurrences - a.occurrences),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Locators the test itself uses
// ─────────────────────────────────────────────────────────────────────────────

export interface TestLocator {
  kind: 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'title' | 'alt' | 'css';
  /** The role, the css selector, or the literal the locator searched for. */
  value: string;
  /** The `{ name }` option of getByRole. */
  name?: string;
  /** As written in the test, for display: `getByRole('button', …)`. */
  expression: string;
}

/**
 * A JS string literal in any of the three quote styles.
 *
 * Group 1 is the quote character and group 2 the contents. The back-reference
 * is what makes `locator('[data-testid="shipping"]')` work — a character class
 * that simply excluded all three quote characters stopped at the inner `"` and
 * silently found no locator at all, which is the worst possible failure for a
 * ranker: it produces a confident, empty answer.
 *
 * Because `\1` is positional, this may only be used as the FIRST capturing
 * group of whatever pattern embeds it.
 */
const QUOTED = String.raw`(['"\`])((?:(?!\1).)*)\1`;

/**
 * Every locator the test source mentions.
 *
 * Regex rather than a parser on purpose. The input is a Playwright spec, the
 * shapes are a closed set, and a parse failure on unusual source has to degrade
 * to "found fewer locators" — not to an exception in a triage endpoint. The
 * cost is that a locator built from a variable (`page.getByTestId(id)`) is
 * invisible here, which is why an unmatched finding is still shown as context
 * rather than dropped.
 */
export function extractLocators(...sources: Array<string | null | undefined>): TestLocator[] {
  const found = new Map<string, TestLocator>();
  const add = (locator: TestLocator): void => {
    const key = `${locator.kind}|${locator.value}|${locator.name ?? ''}`;
    if (!found.has(key)) found.set(key, locator);
  };

  const source = sources.filter(Boolean).join('\n');
  if (!source) return [];

  const simple: Array<[string, TestLocator['kind']]> = [
    ['getByTestId', 'testid'],
    ['getByLabel', 'label'],
    ['getByPlaceholder', 'placeholder'],
    ['getByText', 'text'],
    ['getByTitle', 'title'],
    ['getByAltText', 'alt'],
  ];

  for (const [method, kind] of simple) {
    const pattern = new RegExp(String.raw`${method}\(\s*${QUOTED}`, 'g');
    for (const match of source.matchAll(pattern)) {
      const value = match[2] ?? '';
      if (value) add({ kind, value, expression: `${method}('${value}')` });
    }
  }

  const roles = new RegExp(String.raw`getByRole\(\s*${QUOTED}\s*(?:,\s*\{([^}]*)\})?`, 'g');
  for (const match of source.matchAll(roles)) {
    const role = match[2] ?? '';
    if (!role) continue;
    const options = match[3] ?? '';
    const named = new RegExp(String.raw`name\s*:\s*${QUOTED}`).exec(options)?.[2];
    add({
      kind: 'role',
      value: role,
      name: named,
      expression: named ? `getByRole('${role}', { name: '${named}' })` : `getByRole('${role}')`,
    });
  }

  /*
   * Two families, because "first argument is a selector" is not a property of
   * the method name alone.
   *
   * `locator()` and friends always take one. `fill()` and friends take one only
   * on `page`/`frame` — chained off a locator (`getByLabel('Search').fill('kettle')`)
   * the first argument is the VALUE being typed. Matching on the bare method
   * name turned every string a test types into a phantom CSS selector, and a
   * phantom selector that happens to match an element promotes the wrong change
   * to the top of the findings list.
   */
  const selectorFirst = [
    new RegExp(String.raw`(?:locator|waitForSelector|querySelectorAll|querySelector)\(\s*${QUOTED}`, 'g'),
    new RegExp(
      String.raw`(?:^|[^.\w])(?:page|frame)\s*\.\s*(?:\$\$?|click|dblclick|fill|type|check|uncheck|hover|press|tap|focus|selectOption|setInputFiles|waitForSelector|isVisible|isHidden|isEnabled|isDisabled|textContent|innerText|getAttribute)\(\s*${QUOTED}`,
      'g',
    ),
  ];

  for (const pattern of selectorFirst) {
    for (const match of source.matchAll(pattern)) {
      const value = (match[2] ?? '').trim();
      if (!value || value.startsWith('http')) continue;
      // Playwright's testid engine written as a selector string.
      const testIdAttr = /\[data-(?:testid|test-id|test|qa)=['"]?([^'"\]]+)['"]?\]/.exec(value);
      if (testIdAttr?.[1]) {
        add({ kind: 'testid', value: testIdAttr[1], expression: `locator('${value}')` });
        continue;
      }
      if (value.startsWith('text=')) {
        add({ kind: 'text', value: value.slice(5), expression: `locator('${value}')` });
        continue;
      }
      add({ kind: 'css', value, expression: `locator('${value}')` });
    }
  }

  return [...found.values()];
}

/** Case- and whitespace-insensitive containment, the way Playwright matches. */
function loosely(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * Does this locator point at this element?
 *
 * Conservative by design. A false positive promotes an irrelevant change to
 * "the finding" and buries the real one, so anything ambiguous stays context.
 */
export function locatorMatches(locator: TestLocator, element: DomElement): boolean {
  switch (locator.kind) {
    case 'testid':
      return element.testId === locator.value;
    case 'role': {
      if (element.role !== locator.value.toLowerCase()) return false;
      if (!locator.name) return true;
      return loosely(element.name, locator.name) || loosely(element.text, locator.name);
    }
    case 'label':
    case 'placeholder':
    case 'title':
    case 'alt':
      return loosely(element.name, locator.value);
    case 'text':
      return loosely(element.text, locator.value) || loosely(element.name, locator.value);
    case 'css':
      return cssMatches(locator.value, element);
    default:
      return false;
  }
}

/**
 * The subset of CSS a hand-written locator actually uses: `#id`, `.class`,
 * `tag`, `[attr=value]`, and combinations of those on the *last* compound in a
 * descendant chain. Anything richer returns false rather than guessing.
 */
function cssMatches(selector: string, element: DomElement): boolean {
  const last = selector.split(/\s+|>/).filter(Boolean).pop();
  if (!last) return false;
  if (/[:,~+*]/.test(last)) return false;

  const parts = last.match(/^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g);
  if (!parts?.length) return false;

  for (const part of parts) {
    if (part.startsWith('#')) {
      if (element.id !== part.slice(1)) return false;
    } else if (part.startsWith('.')) {
      const classes = (element.attrs.class ?? '').split(/\s+/);
      if (!classes.includes(part.slice(1))) return false;
    } else if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) {
        if (element.attrs[inner] === undefined) return false;
      } else {
        const key = inner.slice(0, eq).replace(/[\^$*~|]$/, '');
        const value = inner.slice(eq + 1).replace(/^['"]|['"]$/g, '');
        const actual = key === 'data-testid' ? (element.testId ?? undefined) : element.attrs[key];
        if (actual === undefined || !loosely(actual, value)) return false;
      }
    } else if (element.tag.toLowerCase() !== part.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The diff
// ─────────────────────────────────────────────────────────────────────────────

export type DomChangeKind =
  | 'REMOVED'
  | 'ADDED'
  | 'NAME_CHANGED'
  | 'ROLE_CHANGED'
  | 'TESTID_CHANGED'
  | 'ID_CHANGED'
  | 'MOVED'
  | 'HIDDEN'
  | 'REVEALED'
  | 'DISABLED'
  | 'ENABLED'
  | 'TEXT_CHANGED';

/** The element as the UI shows it — enough to recognise it, not the whole node. */
export interface ElementRef {
  tag: string;
  role: string;
  name: string;
  nameSource: string;
  testId: string | null;
  id: string | null;
  text: string;
  path: string;
  hidden: boolean;
  disabled: boolean;
}

export interface DomChange {
  kind: DomChangeKind;
  /** One sentence, written for someone triaging at 2am. */
  summary: string;
  before: ElementRef | null;
  after: ElementRef | null;
  /** Locators from the test that name this element, as written in the source. */
  matchedLocators: string[];
  /** True when the test's own selectors look for this element. */
  touchedByTest: boolean;
  /** Playwright marked this element as the target of the traced action. */
  actionTarget: boolean;
  score: number;
}

export interface DomDiffResult {
  /** Findings first (a locator touches them), then context. Both ranked. */
  changes: DomChange[];
  findingCount: number;
  contextCount: number;
  /** Set when more changes existed than the cap allowed through. */
  truncated: number;
  counts: { before: number; after: number; matched: number };
  /** Union of what both sides hid, so the UI can say what it filtered. */
  ignoredAttributes: IgnoredAttribute[];
  before: { url: string; label: string };
  after: { url: string; label: string };
  /**
   * False when the two snapshots are of different pages — the diff is then
   * "you are looking at two different screens", not a regression.
   */
  urlsComparable: boolean;
}

/** How much each kind of change matters before anything else is known. */
const KIND_WEIGHT: Record<DomChangeKind, number> = {
  REMOVED: 40,
  // A renamed test id outranks a rename: getByTestId is the locator teams are
  // told to prefer *because* it is stable, so breaking one is never incidental.
  TESTID_CHANGED: 42,
  NAME_CHANGED: 38,
  ROLE_CHANGED: 36,
  ID_CHANGED: 24,
  HIDDEN: 30,
  DISABLED: 26,
  MOVED: 20,
  TEXT_CHANGED: 12,
  REVEALED: 8,
  ENABLED: 6,
  ADDED: 5,
};

/** Beyond this the list stops being readable. Findings are never truncated. */
const MAX_CONTEXT_CHANGES = 150;

function toRef(element: DomElement): ElementRef {
  return {
    tag: element.tag,
    role: element.role,
    name: element.name,
    nameSource: element.nameSource,
    testId: element.testId,
    id: element.id,
    text: element.text,
    path: element.path,
    hidden: element.hidden,
    disabled: element.disabled,
  };
}

/** Human handle for an element: the most identifying thing it has. */
function describe(element: DomElement): string {
  if (element.testId) return `${element.role || element.tag.toLowerCase()} [${element.testId}]`;
  if (element.name) return `${element.role || element.tag.toLowerCase()} "${element.name}"`;
  if (element.id) return `${element.role || element.tag.toLowerCase()} #${element.id}`;
  if (element.text) return `${element.tag.toLowerCase()} "${element.text}"`;
  // Nameless and idless: the role still says what it is, and the path says
  // where. Both beat printing a bare path the reader has to decode.
  return element.role ? `${element.role} at ${element.path}` : element.path;
}

/**
 * Identity keys, strongest first.
 *
 * Matching runs one pass per key: candidates that share a key are paired in
 * document order, then the pass moves on with whatever is left. Strongest-first
 * matters because a page with five product cards has five elements that share
 * `role+name` and only one that shares a given test id — pairing on the test id
 * first keeps the weaker keys from crossing them over.
 */
function identityKeys(element: DomElement): string[] {
  const keys: string[] = [];
  if (element.testId) keys.push(`testid:${element.testId}`);
  if (element.id) keys.push(`id:${element.id}`);
  if (element.role && element.name) keys.push(`rolename:${element.role}|${element.name}`);
  if (element.name) keys.push(`name:${element.name}|${element.tag}`);
  keys.push(`path:${element.path}`);
  if (element.role) keys.push(`rolepath:${element.role}|${element.parentPath}`);
  keys.push(`tagpath:${element.tag}|${element.parentPath}`);
  return keys;
}

const KEY_PASSES = ['testid:', 'id:', 'rolename:', 'name:', 'path:', 'rolepath:', 'tagpath:'];

function matchElements(
  before: DomElement[],
  after: DomElement[],
): { pairs: Array<[DomElement, DomElement]>; removed: DomElement[]; added: DomElement[] } {
  const pairs: Array<[DomElement, DomElement]> = [];
  const beforeLeft = new Set(before);
  const afterLeft = new Set(after);

  for (const prefix of KEY_PASSES) {
    const index = new Map<string, DomElement[]>();
    for (const element of before) {
      if (!beforeLeft.has(element)) continue;
      const key = identityKeys(element).find((k) => k.startsWith(prefix));
      if (!key) continue;
      const list = index.get(key) ?? [];
      list.push(element);
      index.set(key, list);
    }

    const claimed = new Map<string, number>();
    for (const element of after) {
      if (!afterLeft.has(element)) continue;
      const key = identityKeys(element).find((k) => k.startsWith(prefix));
      if (!key) continue;
      const candidates = index.get(key);
      if (!candidates) continue;
      const cursor = claimed.get(key) ?? 0;
      const partner = candidates[cursor];
      if (!partner) continue;
      claimed.set(key, cursor + 1);
      beforeLeft.delete(partner);
      afterLeft.delete(element);
      pairs.push([partner, element]);
    }
  }

  return {
    pairs,
    removed: before.filter((element) => beforeLeft.has(element)),
    added: after.filter((element) => afterLeft.has(element)),
  };
}

/**
 * A removal or addition worth reporting.
 *
 * Wrapper `<div>`s and `<span>`s appear and vanish constantly — a styling
 * refactor produces hundreds — and none of them can break a locator. Anything
 * with a role, a name, a test id or its own text stays.
 */
function isMeaningful(element: DomElement): boolean {
  return Boolean(
    element.testId || element.role || element.name || element.id || element.text || element.actionTarget,
  );
}

export interface DiffOptions {
  /** Locators the test uses. Findings are the changes these touch. */
  locators?: TestLocator[];
  maxContext?: number;
}

/**
 * Diff two normalised snapshots.
 *
 * `before` is the last green run, `after` is the failing one — so REMOVED means
 * "was there when this passed, is gone now", which is the direction triage
 * reads in.
 */
export function diffSnapshots(
  before: DomSnapshot,
  after: DomSnapshot,
  options: DiffOptions = {},
): DomDiffResult {
  const locators = options.locators ?? [];
  const { pairs, removed, added } = matchElements(before.elements, after.elements);

  const changes: DomChange[] = [];

  const locatorsFor = (...elements: Array<DomElement | null>): string[] => {
    const hits = new Set<string>();
    for (const element of elements) {
      if (!element) continue;
      for (const locator of locators) {
        if (locatorMatches(locator, element)) hits.add(locator.expression);
      }
    }
    return [...hits];
  };

  const push = (
    kind: DomChangeKind,
    summary: string,
    beforeElement: DomElement | null,
    afterElement: DomElement | null,
  ): void => {
    const matchedLocators = locatorsFor(beforeElement, afterElement);
    const actionTarget = Boolean(afterElement?.actionTarget || beforeElement?.actionTarget);
    const role = afterElement?.role ?? beforeElement?.role ?? '';
    const score =
      KIND_WEIGHT[kind] +
      (matchedLocators.length ? 100 : 0) +
      (actionTarget ? 60 : 0) +
      (INTERACTIVE_ROLES.has(role) ? 8 : 0);
    changes.push({
      kind,
      summary,
      before: beforeElement ? toRef(beforeElement) : null,
      after: afterElement ? toRef(afterElement) : null,
      matchedLocators,
      touchedByTest: matchedLocators.length > 0,
      actionTarget,
      score,
    });
  };

  for (const element of removed) {
    if (!isMeaningful(element)) continue;
    push('REMOVED', `${describe(element)} is gone — it was present when this test last passed.`, element, null);
  }

  for (const element of added) {
    if (!isMeaningful(element)) continue;
    push('ADDED', `${describe(element)} is new — it was not on the page when this test last passed.`, null, element);
  }

  /** Paths whose text changed, so only the deepest one is reported. */
  const textChanged = new Map<string, [DomElement, DomElement]>();
  /**
   * Elements already reported as renamed *because their text is their name*.
   *
   * A button whose label changes from "Pay now" to "Pay later" changes its
   * accessible name and its text in one edit. Reporting both is two findings
   * for one change — and it double-counts, so a single rename could fill the
   * findings list twice over. The rename is the one that explains the failure,
   * so it wins and the text change is dropped.
   */
  const renamedFromContent = new Set<string>();

  for (const [was, now] of pairs) {
    /*
     * The test id first, because it is the loudest possible break and the
     * quietest possible symptom: the element is still there, still named the
     * same, still in the same place, and `getByTestId` returns nothing.
     */
    if (was.testId !== now.testId) {
      push(
        'TESTID_CHANGED',
        now.testId
          ? was.testId
            ? `${describe(now)} changed test id: "${was.testId}" → "${now.testId}" — getByTestId('${was.testId}') no longer resolves.`
            : `${describe(now)} gained the test id "${now.testId}".`
          : `${describe(was)} lost its test id "${was.testId}" — getByTestId('${was.testId}') no longer resolves.`,
        was,
        now,
      );
    }

    if (was.id !== now.id) {
      push(
        'ID_CHANGED',
        `${describe(now)} changed id: ${was.id ? `"${was.id}"` : '(none)'} → ${now.id ? `"${now.id}"` : '(none)'} — ` +
          'a #id selector or a label association pointing at the old one is now broken.',
        was,
        now,
      );
    }

    if (was.role !== now.role) {
      push(
        'ROLE_CHANGED',
        `${describe(now)} changed role from ${was.role || '(none)'} to ${now.role || '(none)'} — ` +
          `a getByRole locator for the old role no longer finds it.`,
        was,
        now,
      );
    }

    if (was.name !== now.name) {
      if (was.nameSource === 'text content' || now.nameSource === 'text content') {
        renamedFromContent.add(now.path);
      }
      if (!was.name) {
        push('NAME_CHANGED', `${describe(now)} gained an accessible name: "${now.name}" (from ${now.nameSource}).`, was, now);
      } else if (!now.name) {
        push(
          'NAME_CHANGED',
          `${describe(was)} lost its accessible name — it was "${was.name}" (from ${was.nameSource}) ` +
            `and now has none, so it is unreachable by name.`,
          was,
          now,
        );
      } else {
        push(
          'NAME_CHANGED',
          `${describe(was)} renamed: "${was.name}" → "${now.name}"` +
            (was.nameSource === now.nameSource ? '' : ` (name now comes from ${now.nameSource})`),
          was,
          now,
        );
      }
    }

    if (was.parentPath !== now.parentPath) {
      push(
        'MOVED',
        `${describe(now)} moved: it was inside ${was.parentPath || 'the document root'} and is now inside ` +
          `${now.parentPath || 'the document root'}.`,
        was,
        now,
      );
    } else if (was.path !== now.path) {
      push('MOVED', `${describe(now)} shifted position among its siblings (${was.path} → ${now.path}).`, was, now);
    }

    if (was.hidden !== now.hidden) {
      push(
        now.hidden ? 'HIDDEN' : 'REVEALED',
        now.hidden
          ? `${describe(now)} is now hidden — it is in the DOM but not visible, which fails a visibility assertion rather than a lookup.`
          : `${describe(now)} is now visible; it was hidden when this test last passed.`,
        was,
        now,
      );
    }

    if (was.disabled !== now.disabled) {
      push(
        now.disabled ? 'DISABLED' : 'ENABLED',
        now.disabled
          ? `${describe(now)} is now disabled — a click on it will time out rather than fail to find it.`
          : `${describe(now)} is no longer disabled.`,
        was,
        now,
      );
    }

    if (was.text !== now.text && (was.text || now.text)) {
      textChanged.set(now.path, [was, now]);
    }
  }

  // Only the deepest changed node: a changed price should not also be reported
  // on its row, its table and its section.
  for (const [path, [was, now]] of textChanged) {
    if (renamedFromContent.has(path)) continue;
    const hasChangedDescendant = [...textChanged.keys()].some(
      (other) => other !== path && other.startsWith(`${path}>`),
    );
    if (hasChangedDescendant) continue;
    push('TEXT_CHANGED', `${describe(now)} text changed: "${was.text}" → "${now.text}"`, was, now);
  }

  changes.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));

  const findings = changes.filter((change) => change.touchedByTest || change.actionTarget);
  const context = changes.filter((change) => !change.touchedByTest && !change.actionTarget);
  const cap = options.maxContext ?? MAX_CONTEXT_CHANGES;
  const keptContext = context.slice(0, cap);

  return {
    changes: [...findings, ...keptContext],
    findingCount: findings.length,
    contextCount: keptContext.length,
    truncated: context.length - keptContext.length,
    counts: {
      before: before.elements.length,
      after: after.elements.length,
      matched: pairs.length,
    },
    ignoredAttributes: mergeIgnored(before.ignoredAttributes, after.ignoredAttributes),
    before: { url: before.frameUrl, label: before.snapshotName },
    after: { url: after.frameUrl, label: after.snapshotName },
    urlsComparable: samePage(before.frameUrl, after.frameUrl),
  };
}

function mergeIgnored(a: IgnoredAttribute[], b: IgnoredAttribute[]): IgnoredAttribute[] {
  const merged = new Map<string, IgnoredAttribute>();
  for (const entry of [...a, ...b]) {
    const existing = merged.get(entry.attribute);
    if (existing) existing.occurrences += entry.occurrences;
    else merged.set(entry.attribute, { ...entry });
  }
  return [...merged.values()].sort((x, y) => y.occurrences - x.occurrences);
}

/**
 * Same page, ignoring host and query.
 *
 * The two runs hit the same environment but not necessarily the same port or
 * the same session ids, and comparing `/cart` against `/checkout` would produce
 * a diff where every element changed — technically true and completely useless.
 * The caller shows a warning instead.
 */
export function samePage(a: string, b: string): boolean {
  if (!a || !b) return false;
  const path = (url: string): string => {
    try {
      return new URL(url).pathname.replace(/\/+$/, '') || '/';
    } catch {
      return url.split('?')[0]!.replace(/\/+$/, '') || '/';
    }
  };
  return path(a) === path(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frame snapshots out of a Playwright `.trace` file body.
 *
 * The file is JSONL and a damaged line is survivable — traces are written by a
 * process that can be killed mid-flush, and one unparseable line at the end of
 * a 40k-line file must not cost the whole diff.
 */
export function parseTraceSnapshots(body: string): RawFrameSnapshot[] {
  const snapshots: RawFrameSnapshot[] = [];
  for (const line of body.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    if (!line.includes('"frame-snapshot"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; snapshot?: RawFrameSnapshot };
      if (event.type === 'frame-snapshot' && event.snapshot?.html) snapshots.push(event.snapshot);
    } catch {
      // A truncated final line; everything before it is still good.
    }
  }
  return snapshots;
}

/** One frame's snapshots, in trace order. Back-references never cross frames. */
export function groupByFrame(snapshots: RawFrameSnapshot[]): Map<string, RawFrameSnapshot[]> {
  const byFrame = new Map<string, RawFrameSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = snapshot.frameId ?? '';
    const list = byFrame.get(key) ?? [];
    list.push(snapshot);
    byFrame.set(key, list);
  }
  return byFrame;
}

/** A document with nothing in it yet — not worth diffing against. */
function isBlank(snapshot: RawFrameSnapshot): boolean {
  const url = snapshot.frameUrl ?? '';
  return !url || url === 'about:blank' || url.startsWith('data:');
}

export interface AnchorChoice {
  frame: RawFrameSnapshot[];
  index: number;
  snapshot: RawFrameSnapshot;
}

/**
 * The snapshot to diff.
 *
 * The last non-blank snapshot of the busiest main frame: for the failing run
 * that is the page as it looked when the test gave up, which is the state the
 * user is asking about. `preferUrl` lets the baseline side line up with the
 * failing side's page rather than wherever the green run happened to end.
 */
export function pickAnchor(
  snapshots: RawFrameSnapshot[],
  preferUrl?: string,
): AnchorChoice | null {
  const byFrame = groupByFrame(snapshots);
  if (!byFrame.size) return null;

  let best: RawFrameSnapshot[] | null = null;
  for (const frame of byFrame.values()) {
    const usable = frame.filter((snapshot) => !isBlank(snapshot));
    if (!usable.length) continue;
    const mainFrame = usable.some((snapshot) => snapshot.isMainFrame);
    const bestIsMain = best?.some((snapshot) => snapshot.isMainFrame) ?? false;
    if (!best || (mainFrame && !bestIsMain) || (mainFrame === bestIsMain && usable.length > best.length)) {
      best = frame;
    }
  }
  if (!best) return null;

  const candidates = best
    .map((snapshot, index) => ({ snapshot, index }))
    .filter((entry) => !isBlank(entry.snapshot));
  if (!candidates.length) return null;

  if (preferUrl) {
    const onSamePage = candidates.filter((entry) => samePage(entry.snapshot.frameUrl ?? '', preferUrl));
    if (onSamePage.length) {
      const chosen = onSamePage[onSamePage.length - 1]!;
      return { frame: best, index: chosen.index, snapshot: chosen.snapshot };
    }
  }

  const chosen = candidates[candidates.length - 1]!;
  return { frame: best, index: chosen.index, snapshot: chosen.snapshot };
}

/** Trace body → the one snapshot worth diffing, already normalised. */
export function snapshotFromTrace(body: string, preferUrl?: string): DomSnapshot | null {
  const anchor = pickAnchor(parseTraceSnapshots(body), preferUrl);
  if (!anchor) return null;
  return normaliseSnapshot(anchor.frame, anchor.index);
}
