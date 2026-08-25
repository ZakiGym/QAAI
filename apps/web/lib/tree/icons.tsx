import type { ReactElement, ReactNode } from 'react';
import { cn } from '../cn';
import { isFixturePath } from './model';

/**
 * File icons for the editor's explorer, in the spirit of VS Code's Seti theme.
 *
 * Seti's identity is one glyph per file kind, tinted so a folder full of paths
 * can be read by shape and colour before a single filename is. That is worth
 * copying; its palette is not. Seti hard-codes hex, and this app ships a light
 * theme, a dark theme and three switchable accents — a literal `#cbcb41` for
 * JSON would be correct in exactly one of the six combinations and illegible in
 * at least one other.
 *
 * So the colour comes from the token layer instead, and it comes by ROLE rather
 * than by kind: five roles, each answering "what is this file FOR", each mapped
 * to a token the app already uses for that meaning. Fifteen kinds share those
 * five colours and are told apart by SHAPE. That inversion is deliberate — the
 * product is a QA tool, its users review failures for a living, and a reviewer
 * with deuteranopia must be able to read a spec from a fixture. Shape is the
 * primary channel here and colour is the secondary one, not the other way
 * round.
 *
 * Everything is inline SVG on a shared 16-unit grid at a single stroke weight.
 * No icon font, no library, no network: the panel is mono 11.5px and these
 * render at 13px, a size at which any two icons that do not agree on grid and
 * stroke look like they came from different products.
 */

// ─── Kinds ───────────────────────────────────────────────────────────────────

/**
 * What a row IS. Derived from the path first and the test's `type` second —
 * the path is what the user can see, so it wins wherever the two disagree.
 */
export type FileKind =
  | 'spec-ts'
  | 'spec-js'
  | 'spec-json'
  | 'a11y-json'
  | 'json'
  | 'csv'
  | 'image'
  | 'yaml'
  | 'markdown'
  | 'text'
  | 'code-ts'
  | 'code-js'
  | 'config'
  | 'lock'
  | 'unknown';

/** Every kind, for exhaustive iteration (the tests lean on this). */
export const FILE_KINDS = [
  'spec-ts',
  'spec-js',
  'spec-json',
  'a11y-json',
  'json',
  'csv',
  'image',
  'yaml',
  'markdown',
  'text',
  'code-ts',
  'code-js',
  'config',
  'lock',
  'unknown',
] as const satisfies readonly FileKind[];

// ─── The role palette ────────────────────────────────────────────────────────

/**
 * Five roles. Each is a sentence about what the file does for the user, and
 * each borrows the token the app already spends on that meaning elsewhere.
 */
export type IconRole = 'subject' | 'audit' | 'data' | 'neutral' | 'inert';

export const ICON_ROLE_CLASS: Record<IconRole, string> = {
  /*
   * The tests themselves — TS, JS and spec-driven JSON. `--color-accent` is the
   * app's "this is the thing you act on" colour (it is on the primary button,
   * the active nav item and the dirty dot), and in a test explorer the tests
   * are the subject. It is also the one hue that changes with the accent
   * picker, which is right: the user's chosen colour should land on the files
   * they came here to write.
   */
  subject: 'text-accent',
  /*
   * Accessibility specs, and only those. An a11y spec is a conformance check
   * rather than a correctness check — it asks whether the product meets a
   * published standard, not whether it does what the team meant — and `pass` is
   * the hue this app already spends on "meets the bar". Held at 85% so it never
   * lands on the exact value of the result tint in `decorations.ts`; the two
   * also never occupy the same position, since the tint colours the label and
   * this colours the glyph.
   */
  audit: 'text-pass/85',
  /*
   * Data the tests read or write: fixtures, CSV, and visual baselines. Seti
   * gives data files a warm yellow and `flake` is the only warm hue in the
   * palette, so the reference survives. Dimmed to 80% because full-strength
   * flake is the flaky badge, and a folder of fixtures must not look like a
   * folder of flaky tests.
   */
  data: 'text-flake/80',
  /*
   * Prose and structure — Markdown, text, YAML, config, and any .ts/.js that is
   * NOT a test. Body-text grey, because these read like the UI around them:
   * they are things a human wrote for another human, and none of them runs.
   * That plain `.ts` helpers land here and `.spec.ts` files land on the accent
   * is the single most useful distinction this palette draws.
   */
  neutral: 'text-ink-dim',
  /*
   * Lock files and anything unrecognised. The faintest ink in the system: the
   * explorer has to show these, nobody edits them by hand, and they should cost
   * the eye nothing on the way past.
   */
  inert: 'text-ink-faint',
};

// ─── Glyphs ──────────────────────────────────────────────────────────────────

/**
 * 13px. The panel is 11.5px mono; an icon set at the text size disappears and
 * one at 16px pushes the filename out of a 150px column. 13 is the size at
 * which the braces in the JSON glyph are still two distinct strokes.
 */
const ICON_SIZE = 'h-[13px] w-[13px] shrink-0';

export interface IconProps {
  className?: string;
  /**
   * Render the icon as decoration rather than content. The default is labelled,
   * because the kind carries information the filename does not always — an
   * `.a11y.json` and a `users.json` differ by icon long before they differ by
   * name. Pass `decorative` when the row already announces its kind some other
   * way and the second announcement is just noise.
   */
  decorative?: boolean;
}

interface GlyphProps extends IconProps {
  label: string;
  children: ReactNode;
}

/**
 * One wrapper for all of them, which is what keeps the set uniform: a single
 * grid, a single stroke weight, a single size, and labelling that cannot be
 * forgotten on the fifteenth icon.
 */
function Glyph({ label, className, decorative, children }: GlyphProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(ICON_SIZE, className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {/* The native tooltip. `aria-label` covers assistive tech; this covers the
          sighted user who does not recognise the glyph yet. */}
      {!decorative && <title>{label}</title>}
      {children}
    </svg>
  );
}

/** The page-with-a-folded-corner every document glyph is built on. */
const DOC_BODY = 'M4 2.5h4.5L12 6v7.5H4z';
const DOC_FOLD = 'M8.5 2.5V6H12';
/** Filled, not stroked: a 3px triangle outline at 13px is a smudge. */
const PLAY_IN_DOC = 'M6.6 8.1l2.7 1.7-2.7 1.7z';
/* A brace that survives being 9px tall. Two shallow curves meeting at a nib. */
const BRACE_LEFT = 'M6.6 3.2c-1.2 0-1.2 1.5-1.2 3 0 1-.8 1.6-1.3 1.8.5.2 1.3.8 1.3 1.8 0 1.5 0 3 1.2 3';
const BRACE_RIGHT = 'M9.4 3.2c1.2 0 1.2 1.5 1.2 3 0 1 .8 1.6 1.3 1.8-.5.2-1.3.8-1.3 1.8 0 1.5 0 3-1.2 3';

export function SpecTsIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Playwright spec (TypeScript)" {...p}>
      <path d={DOC_BODY} />
      <path d={DOC_FOLD} />
      <path d={PLAY_IN_DOC} fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function SpecJsIcon(p: IconProps): ReactElement {
  // A disc rather than a page: same "runnable" play mark, unmistakably not the
  // TypeScript one at a glance, which is the only thing that distinction has to
  // do since both are the same role colour.
  return (
    <Glyph label="Playwright spec (JavaScript)" {...p}>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M6.7 5.6l3.7 2.4-3.7 2.4z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function SpecJsonIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Spec-driven test (JSON)" {...p}>
      <path d={BRACE_LEFT} />
      <path d={BRACE_RIGHT} />
      <path d="M7 6.4l2 1.6-2 1.6z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function A11yIcon(p: IconProps): ReactElement {
  // The international access mark, near enough. It is the one glyph in the set
  // a user already knows the meaning of before they open the app.
  return (
    <Glyph label="Accessibility spec" {...p}>
      <circle cx="8" cy="3.5" r="1.35" fill="currentColor" stroke="none" />
      <path d="M3.8 6.6h8.4" />
      <path d="M8 6.4v3.5l-2.3 3.6" />
      <path d="M8 9.9l2.3 3.6" />
    </Glyph>
  );
}

export function JsonIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="JSON fixture" {...p}>
      <path d={BRACE_LEFT} />
      <path d={BRACE_RIGHT} />
    </Glyph>
  );
}

export function CsvIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Delimited data" {...p}>
      <rect x="3" y="3.5" width="10" height="9" rx="1" />
      <path d="M3 7h10" />
      <path d="M8 3.5v9" />
    </Glyph>
  );
}

export function ImageIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Image" {...p}>
      <rect x="3" y="3.5" width="10" height="9" rx="1.2" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M3.3 11.1l3.1-2.7 2.3 1.9 1.6-1.3 2.4 2" />
    </Glyph>
  );
}

export function YamlIcon(p: IconProps): ReactElement {
  // Indented key/value pairs — what YAML looks like from across the room, and
  // why it cannot be confused with the flat lines of the plain-text glyph.
  return (
    <Glyph label="YAML" {...p}>
      <circle cx="4" cy="4.6" r="0.95" fill="currentColor" stroke="none" />
      <path d="M6.4 4.6h6.1" />
      <circle cx="6.2" cy="8" r="0.95" fill="currentColor" stroke="none" />
      <path d="M8.6 8h3.9" />
      <circle cx="8.4" cy="11.4" r="0.95" fill="currentColor" stroke="none" />
      <path d="M10.8 11.4h1.7" />
    </Glyph>
  );
}

export function MarkdownIcon(p: IconProps): ReactElement {
  // The markdown mark itself: an M and a down arrow inside a rounded box.
  return (
    <Glyph label="Markdown" {...p}>
      <rect x="2.4" y="4" width="11.2" height="8" rx="1.4" />
      <path d="M4.6 9.9V6.1l1.6 1.9 1.6-1.9v3.8" />
      <path d="M10.9 6.1v3.7" />
      <path d="M9.7 8.6l1.2 1.3 1.2-1.3" />
    </Glyph>
  );
}

export function TextIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Plain text" {...p}>
      <path d="M3.5 4.6h9" />
      <path d="M3.5 8h9" />
      <path d="M3.5 11.4h5.5" />
    </Glyph>
  );
}

export function CodeTsIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="TypeScript source" {...p}>
      <path d="M6 5L3 8l3 3" />
      <path d="M10 5l3 3-3 3" />
    </Glyph>
  );
}

export function CodeJsIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="JavaScript source" {...p}>
      <path d="M6 5L3 8l3 3" />
      <path d="M10 5l3 3-3 3" />
      <path d="M9.1 4.1l-2.2 7.8" />
    </Glyph>
  );
}

export function ConfigIcon(p: IconProps): ReactElement {
  // Sliders, not a cog. A cog at 13px is six notches wide and reads as a blob;
  // two tracks and two knobs survive the size.
  return (
    <Glyph label="Configuration" {...p}>
      <path d="M3 5.5h5.2" />
      <path d="M11.5 5.5h1.5" />
      <circle cx="9.9" cy="5.5" r="1.5" />
      <path d="M3 10.5h1.4" />
      <path d="M7.7 10.5h5.3" />
      <circle cx="6.1" cy="10.5" r="1.5" />
    </Glyph>
  );
}

export function LockIcon(p: IconProps): ReactElement {
  return (
    <Glyph label="Lock file" {...p}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.3" />
      <path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7" />
    </Glyph>
  );
}

export function UnknownFileIcon(p: IconProps): ReactElement {
  // The fallback is a real glyph, never whitespace. A blank column where an
  // icon should be reads as a rendering bug, and the whole point of an icon
  // gutter is that every row has something in the same place.
  return (
    <Glyph label="File" {...p}>
      <path d={DOC_BODY} />
      <path d={DOC_FOLD} />
    </Glyph>
  );
}

/**
 * Folders. Not one of the fifteen kinds — a folder has no extension and no test
 * type — but the explorer needs it from the same set, at the same weight, or
 * the one row type without an icon becomes the one that looks broken.
 */
export function FolderIcon({ open = false, ...p }: IconProps & { open?: boolean }): ReactElement {
  return (
    <Glyph label={open ? 'Folder, expanded' : 'Folder, collapsed'} {...p}>
      {open ? (
        <>
          <path d="M2.5 12.4V4.6a1 1 0 0 1 1-1h2.6l1.4 1.6h5a1 1 0 0 1 1 1v1.1" />
          <path d="M2.5 12.4l1.9-4.3h10.1l-1.9 4.3z" />
        </>
      ) : (
        <path d="M2.5 4.6a1 1 0 0 1 1-1h2.6l1.4 1.6h5a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      )}
    </Glyph>
  );
}

// ─── Kind → glyph, colour and words ──────────────────────────────────────────

export interface FileKindMeta {
  /** The icon's `aria-label`, its tooltip, and the word the tests assert on. */
  label: string;
  role: IconRole;
  Icon: (props: IconProps) => ReactElement;
}

export const FILE_KIND_META: Record<FileKind, FileKindMeta> = {
  'spec-ts': { label: 'Playwright spec (TypeScript)', role: 'subject', Icon: SpecTsIcon },
  'spec-js': { label: 'Playwright spec (JavaScript)', role: 'subject', Icon: SpecJsIcon },
  'spec-json': { label: 'Spec-driven test (JSON)', role: 'subject', Icon: SpecJsonIcon },
  'a11y-json': { label: 'Accessibility spec', role: 'audit', Icon: A11yIcon },
  json: { label: 'JSON fixture', role: 'data', Icon: JsonIcon },
  csv: { label: 'Delimited data', role: 'data', Icon: CsvIcon },
  image: { label: 'Image', role: 'data', Icon: ImageIcon },
  yaml: { label: 'YAML', role: 'neutral', Icon: YamlIcon },
  markdown: { label: 'Markdown', role: 'neutral', Icon: MarkdownIcon },
  text: { label: 'Plain text', role: 'neutral', Icon: TextIcon },
  'code-ts': { label: 'TypeScript source', role: 'neutral', Icon: CodeTsIcon },
  'code-js': { label: 'JavaScript source', role: 'neutral', Icon: CodeJsIcon },
  config: { label: 'Configuration', role: 'neutral', Icon: ConfigIcon },
  lock: { label: 'Lock file', role: 'inert', Icon: LockIcon },
  unknown: { label: 'File', role: 'inert', Icon: UnknownFileIcon },
};

/** The token class a kind's glyph is tinted with. */
export function iconClassFor(kind: FileKind): string {
  return ICON_ROLE_CLASS[FILE_KIND_META[kind].role];
}

// ─── Deriving the kind ───────────────────────────────────────────────────────

/**
 * The typed spec suffixes `@qaai/shared`'s new-test templates mint, duplicated
 * here for the reason `lib/tree.ts` gives for duplicating FIXTURE_PREFIX: that
 * package ships source TS and the web build has no transpilePackages entry for
 * it. Drifting from the list is not dangerous — an unlisted `*.foo.json` simply
 * falls through to the fixture icon — but the list is worth keeping current.
 *
 * Exported for the drift guard in `icons.test.ts`, which derives the same set
 * from `NEW_TEST_TEMPLATES` and fails when the two disagree. A hand-copied
 * constant with nothing checking it is a constant that is already wrong; the
 * test is the only place allowed to import the shared package, because it is
 * the only place that is not bundled.
 */
export const SPEC_JSON_SUFFIXES = [
  '.api.json',
  '.visual.json',
  '.a11y.json',
  '.load.json',
  '.security.json',
  '.unit.json',
  '.otp.json',
  '.db.json',
  '.cli.json',
  '.protocol.json',
  '.contract.json',
  '.mutation.json',
  '.mobile.json',
  '.perf.json',
  '.external.json',
] as const;

/** Extension → kind, for everything that needs no special-casing. */
const BY_EXTENSION: Record<string, FileKind> = {
  json: 'json',
  csv: 'csv',
  tsv: 'csv',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  log: 'text',
  ts: 'code-ts',
  tsx: 'code-ts',
  mts: 'code-ts',
  cts: 'code-ts',
  js: 'code-js',
  jsx: 'code-js',
  mjs: 'code-js',
  cjs: 'code-js',
};

/** Files nobody hand-edits, matched on the whole name. */
const LOCK_NAMES = new Set(['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock', 'cargo.lock', 'gemfile.lock']);

/** Config matched on the whole name, in addition to the patterns below. */
const CONFIG_NAMES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'dockerfile', 'makefile', 'procfile']);

/**
 * Types whose editor buffer is Playwright source rather than a JSON spec — the
 * `buffer: 'code'` entries of `NEW_TEST_TEMPLATES`, copied for the same bundler
 * reason as the suffixes above and held to the same drift guard in the tests.
 */
export const CODE_BUFFER_TYPES: ReadonlySet<string> = new Set([
  'E2E',
  'SMOKE',
  'CROSS_BROWSER',
  'LOCALIZATION',
]);

/** The last path segment, lower-cased. `''` for a path that is all separators. */
function basename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return (segments[segments.length - 1] ?? '').toLowerCase();
}

/**
 * What the NAME alone says a file is.
 *
 * Order is the whole algorithm, because most of these patterns overlap:
 * `package-lock.json` is a lock before it is JSON, `.a11y.json` is an audit
 * before it is a spec, `playwright.config.ts` is config before it is source,
 * and `checkout.spec.ts` is a test before it is TypeScript. Reordering any pair
 * here silently changes what a whole column of rows looks like.
 */
export function kindForPath(path: string): FileKind {
  const name = basename(path);
  if (name === '') return 'unknown';

  // 1. Locks. `package-lock.json` and `pnpm-lock.yaml` would otherwise be read
  //    as data files, which invites someone to open a 40k-line diff.
  if (LOCK_NAMES.has(name) || name.endsWith('.lock') || /-lock\.(json|ya?ml)$/.test(name)) return 'lock';

  // 2. Accessibility specs, ahead of every other JSON. This is the one test
  //    kind whose subject is the user rather than the product, and the one the
  //    brief singles out — it must not be swallowed by the generic spec icon.
  if (name.endsWith('.a11y.json')) return 'a11y-json';

  // 3. The other typed spec buffers.
  if (SPEC_JSON_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'spec-json';

  // 4. Named config, and the two config-by-pattern shapes. All three describe
  //    what the file IS, so they beat both the spec check and the extension.
  if (CONFIG_NAMES.has(name)) return 'config';
  if (/\.config\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(name)) return 'config';
  if (/\.rc(\.(json|ya?ml|js|cjs))?$/.test(name)) return 'config';

  // 5. Tests, before plain source. `.test.` is included because a QA product's
  //    own repo is full of them and a file called `tree.test.ts` is a test by
  //    any reading, even though this app mints `.spec.ts`.
  if (/\.(spec|test)\.(ts|tsx|mts|cts)$/.test(name)) return 'spec-ts';
  if (/\.(spec|test)\.(js|jsx|mjs|cjs)$/.test(name)) return 'spec-js';

  // 6. Bare dotfiles — AFTER the spec check, deliberately. The rule is meant
  //    for `.env`, `.gitignore`, `.eslintrc`: a leading dot and no other
  //    structure. `.hidden.spec.ts` has structure, and the suffix says what the
  //    file DOES while the dot only says the shell hides it, so the suffix
  //    wins. Ahead of the extension table, so `.env.local` is still config
  //    rather than an unknown `.local`.
  if (name.startsWith('.')) return 'config';

  // 7. Everything else is its extension.
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'unknown';
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'unknown';
}

/**
 * What a TYPE alone says, for the rows whose path carries no signal — a test
 * saved as `checkout/total` with no extension at all, which the create API
 * permits and the tree must still draw.
 */
export function kindForTestType(testType: string): FileKind {
  if (testType === 'ACCESSIBILITY') return 'a11y-json';
  return CODE_BUFFER_TYPES.has(testType) ? 'spec-ts' : 'spec-json';
}

/**
 * The kind of a row, from its path and (when it is a test) its type.
 *
 * The two signals are combined rather than ranked, because each knows something
 * the other does not:
 *
 *  · The path knows about fixtures. Anything under `fixtures/` is test DATA, not
 *    a test — the explorer has always tinted it to say so — so a fixture keeps
 *    the fixture icon even when its name ends in a spec suffix.
 *  · The type knows a JSON buffer is executable. `checkout/total.json` looks
 *    exactly like a fixture until you know a test row is attached to it, and
 *    ACCESSIBILITY is the only type that changes which icon a JSON gets.
 *  · The type also rescues an extensionless or unrecognised path, which is the
 *    only case where the name genuinely says nothing.
 *
 * `testType` is optional so folders, fixtures and any not-yet-loaded row can
 * call this with a path alone.
 */
export function kindFor(path: string, testType?: string | null): FileKind {
  const fromPath = kindForPath(path);

  if (isFixturePath(path)) {
    /*
     * A fixture is never a test, whatever its suffix or its row's type claims —
     * and that is the whole rule, not just the JSON half of it. `fixtures/` is
     * materialised into the run workspace as DATA; the API refuses to move a
     * runnable test into it (`Moving a test into fixtures/ would stop it ever
     * running`). So every RUNNABLE kind is demoted to the nearest non-runnable
     * one: a spec-driven JSON to the fixture icon, a `.spec.ts` to plain
     * TypeScript source. Drawing a play mark on a file that can never run is
     * the icon telling a lie the server will not honour.
     *
     * The type is not consulted at all, which is why an extensionless fixture
     * stays `unknown` rather than borrowing its row's test type.
     *
     * `isFixturePath` comes from the model, and it is case-SENSITIVE, because
     * every server-side check is `filePath.startsWith(FIXTURE_PREFIX)`. A
     * `Fixtures/` folder is an ordinary folder to the API, and an icon layer
     * that disagreed would be a second answer to "is this a fixture".
     */
    switch (fromPath) {
      case 'spec-json':
      case 'a11y-json':
        return 'json';
      case 'spec-ts':
        return 'code-ts';
      case 'spec-js':
        return 'code-js';
      default:
        return fromPath;
    }
  }

  if (!testType) return fromPath;

  switch (fromPath) {
    case 'json':
      return testType === 'ACCESSIBILITY' ? 'a11y-json' : 'spec-json';
    case 'spec-json':
      return testType === 'ACCESSIBILITY' ? 'a11y-json' : 'spec-json';
    case 'code-ts':
      return 'spec-ts';
    case 'code-js':
      return 'spec-js';
    case 'unknown':
      return kindForTestType(testType);
    default:
      // markdown, images, YAML, locks and config are never a test's buffer, and
      // an a11y spec is already as specific as this can get.
      return fromPath;
  }
}

// ─── The one call a row makes ────────────────────────────────────────────────

/**
 * What a caller may say about the icon it is asking for. The same two fields
 * `IconProps` documents, because a row that can set `decorative` on a glyph it
 * renders itself and cannot set it through `iconFor` is an API disagreeing with
 * its own documentation.
 */
export interface IconOptions {
  className?: string;
  /** See `IconProps.decorative`. Default false: the icon is labelled content. */
  decorative?: boolean;
}

/**
 * The icon for a row, already coloured. This is the entire public surface a row
 * component needs: `{iconFor(node.path, node.test?.type)}`.
 *
 * The third argument is a bare `className` or the full options object — a
 * string is shorthand for `{ className }`, so the common call stays short and
 * the `decorative` case is reachable without a second function. `className` is
 * appended, not replaced, and `cn` resolves the conflict, so a caller who wants
 * a bigger icon in the breadcrumb bar passes `'h-4 w-4'` and gets it while one
 * who passes nothing gets the tree's 13px.
 *
 * Pass `{ decorative: true }` only where the row already announces its kind
 * some other way; the default is labelled, and an unlabelled icon in a file
 * tree is a shape a screen reader cannot name.
 */
export function iconFor(
  path: string,
  testType?: string | null,
  options?: string | IconOptions,
): ReactElement {
  const opts: IconOptions = typeof options === 'string' ? { className: options } : (options ?? {});
  const kind = kindFor(path, testType);
  const { Icon } = FILE_KIND_META[kind];
  return (
    <Icon
      className={cn(iconClassFor(kind), opts.className)}
      {...(opts.decorative === true ? { decorative: true } : {})}
    />
  );
}
