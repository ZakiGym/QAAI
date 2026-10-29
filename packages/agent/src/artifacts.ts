/**
 * THE ARTIFACT PLANNER — which files one generated test is, and where they go.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `generatedTestSchema` carried ONE `code` and ONE `filePath`, so a page
 * object, a shared fixture and a dataset file were impossible BY CONSTRUCTION,
 * while five prompts in ecosystem-prompts.ts tell the model to use page
 * objects. The only shape the old schema could express was setup copy-pasted
 * into every spec — simultaneously the thing reviewers delete tests for and the
 * thing that makes a suite unmaintainable. `artifactSetSchema` gave the output
 * a shape; this file decides what goes in it.
 *
 * ── Three rules, and each one is a thing this feature could get wrong ──────
 *
 * ONE. THE PATHS ARE THEIRS, NOT OURS. A file at `tests/qaai/generated/` in a
 * repository whose tests live in `e2e/specs/` is a file a reviewer reads as
 * "this was not written here". So the layout is DECIDED, from evidence, in this
 * order: where QAAI's own ledger already puts that role, then what the style
 * profile measured about their layout, then — last — the ecosystem default.
 * Every one of those sources is asked `destinationDecision` before it is
 * followed, so a learned or recorded root is EVIDENCE and never PERMISSION, and
 * the ecosystem default taken after a refusal is reported as its own source
 * rather than as "nothing was measured".
 * {@link PlacedArtifact.pathSource} records which of the four answered, and
 * {@link PATH_SOURCE_IS_THEIR_CONVENTION} records whether that answer was their
 * convention or ours, because the second is a guess and the first is not.
 *
 * TWO. A SECOND PAGE OBJECT FOR ONE PAGE IS WORSE THAN NONE. A suite with three
 * `CartPage` classes has no page object; it has three ways to be wrong about one
 * page. So {@link findReusablePageObject} looks for one that already exists —
 * QAAI's or the human's — and then the RECORDED ownership decides which of two
 * things happens: a page object the ledger says is QAAI_OWNED is UPDATED IN
 * PLACE, because a frozen page object drifts from the application the crawl just
 * read; anything else is IMPORTED and never written. The name match is an
 * INFERENCE and it decides only WHICH FILE is meant — never whether it may be
 * written, which is a recorded fact, per rule 11 and the header of
 * artifact-set.ts.
 *
 * THREE. UPDATING A SHARED FILE CHANGES EVERY DEPENDENT. `artifactSetProblems`
 * already refuses a replacement that removes an EXPORTED NAME. That is not
 * enough for a page object: renaming `addToCart()` to `addItem()` removes no
 * export — the class is still `CartPage` — and breaks every spec that calls it.
 * So {@link memberSurfaceChange} reads the MEMBER surface too, the plan lists
 * the dependents, and the update is refused when a dependent actually calls a
 * member that would disappear. A dependent whose bytes cannot be read is a
 * refusal and not a pass: absence of evidence is not evidence.
 *
 * ── No model, and no filesystem ────────────────────────────────────────────
 *
 * Everything here is computable from the repository: the page objects come from
 * the crawl (see page-objects.ts), the layout from the ledger and the style
 * profile, the dataset from `createSyntheticFactory` and a seed. There is no
 * model call in this file and no `node:fs` import — the repository arrives as
 * {@link ArtifactRepository}, a four-method interface a test implements in
 * twenty lines. A model may later narrate a plan; it may not produce one.
 *
 * ── Everything the crawl touched is UNTRUSTED ───────────────────────────────
 *
 * Routes, labels, field names and select options are page content. They reach
 * generated source only through page-objects.ts's quoters, they reach a FILE
 * NAME only through its `safeRoute` check, and a dataset built from them is
 * scanned by {@link datasetSecrets} before it is planned, because a select
 * option reading `process.env.STRIPE_SECRET` would otherwise be committed to
 * the customer's repository as test data.
 */

import type {
  ContentDigest,
  FormFieldSemantic,
  PlanItem,
  SyntheticField,
} from '@qaai/shared';
import { FIXTURE_PREFIX, SECRET_SHAPES, createSyntheticFactory } from '@qaai/shared';
import { ECOSYSTEMS, type EcosystemId } from './ecosystem-prompts.js';
import {
  MAX_LITERAL_CHARS,
  byCodeUnit,
  classNameFrom,
  identifierFrom,
  routeSlug,
  synthesisePageObject,
  toSnake,
  type PageObjectModel,
  type PageObjectOmission,
  type PageObjectRefusal,
  type PageObjectRenderer,
  type PageSource,
} from './page-objects.js';
import {
  MAX_ARTIFACTS_PER_SET,
  SHARED_ROLES,
  WRITABLE_BY_OWNERSHIP,
  dependentsOf,
  dispositionFor,
  orderedForApply,
  resolveOwnership,
  sharedSurfaceChange,
  type ArtifactLedgerEntry,
  type ArtifactRole,
  type ArtifactSet,
  type GeneratedArtifact,
  type OwnershipVerdict,
} from '@qaai/shared';
import {
  CONFIDENCE_IS_USABLE,
  destinationDecision,
  type NamingConvention,
  type StyleProfile,
} from '@qaai/shared';

/*
 * Both imports above resolve through the package barrel, and the note that used
 * to sit here claiming otherwise was WRONG — it said
 * `packages/shared/src/index.ts` has no `export * from './artifact-set'` or
 * `'./style-profile'` and that neither vocabulary was reachable through
 * `@qaai/shared`. Both lines are there (index.ts:236 and :237) and both of
 * these imports already named `@qaai/shared`, so the comment contradicted the
 * code directly above it. The same false note was corrected in admission.ts;
 * this copy survived. Deleting it rather than editing it, because there is no
 * longer anything to record: the handover it described has landed.
 */

// ─── Caps, each one disclosed where it bites ────────────────────────────────

/**
 * Page objects in one set.
 *
 * NINE, and the number is arithmetic rather than taste: `MAX_ARTIFACTS_PER_SET`
 * is 12, one is the SPEC, one is the FIXTURE and one is the DATASET, so nine is
 * what is left. Deriving it means the two numbers cannot drift apart — a tenth
 * page object would make the whole set exceed the cap and be refused with
 * SET_SIZE, which reads as a mysterious refusal rather than as a cap.
 */
export const MAX_PAGE_OBJECTS_PER_SET = MAX_ARTIFACTS_PER_SET - 3;

/** Rows in a generated dataset. One valid case per form is the honest default. */
export const MAX_DATASET_CASES = 12;

/** How many existing files a reuse scan will look at per directory. */
export const MAX_REUSE_SCAN_FILES = 500;

// ─── Where a file goes, and who said so ─────────────────────────────────────

/** Which of the four sources decided a path. */
export const PATH_SOURCES = [
  /** QAAI's own ledger already puts this role in a directory. The strongest signal. */
  'LEDGER_SIBLING',
  /** The style profile measured the repository's test layout. */
  'STYLE_PROFILE',
  /** Neither said anything, so the ecosystem's own convention decided. */
  'ECOSYSTEM_DEFAULT',
  /**
   * EVIDENCE EXISTED AND QAAI REFUSED TO FOLLOW IT, so the ecosystem default
   * decided instead. A SEPARATE MEMBER FROM `ECOSYSTEM_DEFAULT` on purpose.
   *
   * "Nobody measured this repository" and "this repository's measured layout
   * points somewhere QAAI must never write" produce the same directory and are
   * not the same fact: the first is a gap a scan closes, the second is a
   * refusal a human needs to see, because either the repository really does
   * keep its tests inside CI configuration or something poisoned the scan.
   * Collapsing them would be a cap applied without being disclosed.
   */
  'ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE',
] as const;
export type PathSource = (typeof PATH_SOURCES)[number];

/**
 * Is this path THEIR convention, or OURS?
 *
 * Compiler-enforced, and the distinction is the whole of rule ONE above. A path
 * from the ledger or the profile is a measurement of the repository; the
 * ecosystem default is a sensible guess, and a plan that reported the two as
 * the same thing would be claiming to have read a layout it never saw.
 */
export const PATH_SOURCE_IS_THEIR_CONVENTION = {
  LEDGER_SIBLING: true,
  STYLE_PROFILE: true,
  ECOSYSTEM_DEFAULT: false,
  /*
   * FALSE, and it is the interesting `false`. Their convention was read and
   * then DISCARDED, so the path QAAI chose is its own guess — reporting it as
   * their convention would claim a layout match that was deliberately not
   * made.
   */
  ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE: false,
} as const satisfies Record<PathSource, boolean>;

/**
 * The sub-directory each role lives in, under the layout root.
 *
 * Compiler-enforced over `ArtifactRole`, so an eighth role cannot be added
 * without deciding where it goes — the defect the planner would otherwise
 * produce is a file at the repository root.
 *
 * DATASET and FIXTURE both land under a `fixtures` directory, spelled from
 * `FIXTURE_PREFIX` in packages/shared/src/constants.ts so this product uses one
 * word for the idea rather than two. `testFilePath` already renames a crawled
 * feature called `fixtures` out of the way, so a real spec can never collide
 * with it.
 *
 * SAID PLAINLY, because the constant invites the stronger claim: this is the
 * DIRECTORY NAME and not the `Test.filePath` prefix the runner's selection rule
 * keys on. That rule is about rows in QAAI's own database; a dataset inside a
 * customer's test root is read by the spec's relative path, and whether it sits
 * at `fixtures/x.json` or `e2e/specs/fixtures/x.json` changes nothing about how
 * the spec reaches it.
 *
 * CONFIG_FRAGMENT is deliberately NOT a config path. It is a fragment a human
 * merges into their own runner config, and writing it next to
 * `playwright.config.ts` is how a tool comes to overwrite one.
 */
export const ROLE_SUBDIRECTORY = {
  DATASET: FIXTURE_PREFIX.replace(/\/$/, ''),
  HELPER: 'helpers',
  FIXTURE: `${FIXTURE_PREFIX.replace(/\/$/, '')}/setup`,
  PAGE_OBJECT: 'pages',
  SPEC: '',
  SNAPSHOT: 'snapshots',
  CONFIG_FRAGMENT: 'qaai-config-fragments',
} as const satisfies Record<ArtifactRole, string>;

/**
 * Does a file of this role have MEMBERS a dependent can call?
 *
 * Compiler-enforced, and it exists to stop a true check producing a false
 * refusal. {@link memberSurfaceChange} reads method and property declarations;
 * a JSON dataset and a stored snapshot have none, so it would answer UNREADABLE
 * for every one of them — and UNREADABLE is a refusal, correctly, for a page
 * object and absurdly for a file of rows. For those roles the export-level
 * check in `artifactSetProblems` is the whole answer.
 */
export const ROLE_HAS_MEMBER_SURFACE = {
  DATASET: false,
  HELPER: true,
  FIXTURE: true,
  PAGE_OBJECT: true,
  SPEC: true,
  SNAPSHOT: false,
  CONFIG_FRAGMENT: false,
} as const satisfies Record<ArtifactRole, boolean>;

/** A directory for one role, and which evidence chose it. */
export interface LayoutDecision {
  readonly directory: string;
  readonly source: PathSource;
}

/** `a/b/c.ts` → `a/b`. `c.ts` → `''`. No `node:path`, so this module stays pure. */
function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '' : path.slice(0, cut);
}

function joinPath(...parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/**
 * The directory a file of this role belongs in.
 *
 * The ledger wins over the style profile, which is worth stating because it
 * looks backwards: the profile is a measurement of the whole repository and the
 * ledger is one row. But the ledger row is a RECORDED FACT about a file of
 * EXACTLY THIS ROLE that is already in this repository and already imported by
 * something, and a second page-object directory beside the first is the defect
 * this whole file exists to avoid. The profile's `fileLayout` describes where
 * SPECS live, which is a different question for every role but SPEC.
 *
 * One ledger row is enough, deliberately, and that is not a violation of
 * `MIN_EVIDENCE_FILES`: that floor exists because one of the CUSTOMER'S files
 * is an example rather than a convention. A ledger row is a file QAAI itself
 * wrote and recorded, so there is no inference to be weakly attested.
 */
export function directoryForRole(args: {
  readonly role: ArtifactRole;
  readonly profile: StyleProfile;
  readonly ledger: readonly ArtifactLedgerEntry[];
  readonly ecosystemId: EcosystemId;
  readonly item: PlanItem;
}): LayoutDecision {
  const { role, profile, ledger, ecosystemId, item } = args;

  const counts = new Map<string, number>();
  for (const entry of ledger) {
    if (entry.role !== role) continue;
    const directory = dirnameOf(entry.path);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  /*
   * ── A LEARNED ROOT IS EVIDENCE, NEVER PERMISSION ──────────────────────────
   *
   * BOTH branches below are asked `destinationDecision` before they are
   * followed, and `refusedEvidence` records that it happened so the
   * fall-through is a disclosed refusal rather than a silent "nothing was
   * measured".
   *
   * THE DEFECT THIS PREVENTS, which was reproduced end to end rather than
   * imagined: `learnStyle` over four files at `.github/workflows/tests/*` left
   * `fileLayout.root = ".github/workflows/tests"` at MEDIUM confidence, which
   * `CONFIDENCE_IS_USABLE` calls usable, and this function then returned
   * `.github/workflows/tests/pages` for a PAGE_OBJECT — a destination the same
   * `destinationDecision` refuses, asked by nobody on this path. An existing
   * test file is attacker-influenced input wherever a pull request can be
   * opened, so "the repository's own convention" is not a sentence that may
   * authorise a write location on its own.
   *
   * THE LEDGER SIBLING IS GUARDED TOO, and that is not belt-and-braces: a
   * ledger row is a RECORDED fact and a recorded fact pointing into
   * `node_modules` is still a row QAAI must not follow. One rule, asked of
   * every source of evidence.
   */
  let refusedEvidence = false;

  const sibling = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]),
  )[0];
  if (sibling) {
    if (destinationDecision({ path: sibling[0] }).verdict !== 'REFUSED') {
      return { directory: sibling[0], source: 'LEDGER_SIBLING' };
    }
    refusedEvidence = true;
  }

  const layout = profile.fileLayout;
  if (CONFIDENCE_IS_USABLE[layout.confidence] && layout.value) {
    const directory = joinPath(layout.value.root, ROLE_SUBDIRECTORY[role]);
    if (destinationDecision({ path: directory }).verdict !== 'REFUSED') {
      return { directory, source: 'STYLE_PROFILE' };
    }
    refusedEvidence = true;
  }

  const ecosystem = ECOSYSTEMS[ecosystemId];
  const conventional = ecosystem.path({ feature: item.feature, title: item.title });
  return {
    directory: joinPath(dirnameOf(conventional), ROLE_SUBDIRECTORY[role]),
    source: refusedEvidence ? 'ECOSYSTEM_DEFAULT_AFTER_REFUSED_EVIDENCE' : 'ECOSYSTEM_DEFAULT',
  };
}

/**
 * A file stem in the repository's own naming convention.
 *
 * MIXED returns the stem unchanged, which is the honest reading of "more than
 * one of the above, with no majority": there is nothing to match, so matching
 * nothing is better than picking one of the two and being wrong half the time.
 * Null — an UNKNOWN or LOW observation — does the same.
 */
export function applyNaming(stem: string, naming: NamingConvention | null): string {
  const parts = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return stem;
  const lower = parts.map((part) => part.toLowerCase());
  const pascal = lower.map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  switch (naming) {
    case 'KEBAB':
      return lower.join('-');
    case 'SNAKE':
      return lower.join('_');
    case 'CAMEL':
      return lower[0]! + pascal.slice(1).join('');
    case 'PASCAL':
      return pascal.join('');
    case 'DOTTED':
      return lower.join('.');
    case 'MIXED':
    case null:
      return stem;
  }
}

/** The naming convention this repository actually follows, or null. */
export function namingOf(profile: StyleProfile): NamingConvention | null {
  const observation = profile.naming;
  return CONFIDENCE_IS_USABLE[observation.confidence] ? observation.value : null;
}

// ─── The repository, as a narrow injected interface ─────────────────────────

/**
 * What is at a path.
 *
 * THREE STATES AND NOT TWO. `null` for "we could not read it" and `null` for
 * "there is nothing there" is the lie this product cannot afford — a null that
 * became a zero — and it has a direction: a planner that reads UNREADABLE as
 * ABSENT concludes the path is free and plans a write over a file it could not
 * see. `priorContent` in artifact-set.ts collapses the two because a schema has
 * no better option; the planner does, so it takes it.
 */
export type DiskState =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'PRESENT'; readonly content: string }
  | { readonly state: 'UNREADABLE'; readonly why: string };

/**
 * The repository, narrowly. Injected per rule 8: no `node:fs` reaches this
 * module, so every path in it is testable without a working tree.
 */
export interface ArtifactRepository {
  /**
   * The recorded ownership facts. Absence of a row means UNRECORDED, which is
   * NOT writable — see `WRITABLE_BY_OWNERSHIP`.
   */
  readonly ledger: readonly ArtifactLedgerEntry[];
  readonly diskStateAt: (path: string) => DiskState;
  /**
   * Files directly under a repo-relative directory, repo-relative.
   *
   * Used for ONE thing: finding a page object that already exists so the plan
   * can import it instead of minting a second one. It may never decide
   * ownership — that is {@link ArtifactRepository.ledger}'s job and nothing
   * else's.
   */
  readonly filesUnder: (directory: string) => readonly string[];
  readonly digest: ContentDigest;
}

// ─── Reuse ──────────────────────────────────────────────────────────────────

/** How a reusable page object was found. Evidence, never a verdict about ownership. */
export const REUSE_BASES = [
  /** A ledger row of role PAGE_OBJECT whose file name matches this page. */
  'LEDGER_ROW',
  /** A file in the repository whose name matches this page. QAAI has no record of it. */
  'REPOSITORY_FILE',
] as const;
export type ReuseBasis = (typeof REUSE_BASES)[number];

/** A page object the plan imports rather than mints. */
export interface ReusedArtifact {
  readonly role: ArtifactRole;
  readonly path: string;
  readonly route: string;
  readonly basis: ReuseBasis;
  /** The recorded verdict for that path. UNRECORDED for most human files, and that is fine: importing is not writing. */
  readonly ownership: OwnershipVerdict;
  /**
   * What a spec may import from it, as far as the scanner could read. EMPTY
   * means nothing could be read, which is reported rather than treated as "it
   * exports nothing" — see {@link ARTIFACT_PLAN_PROBLEMS}' REUSE_SURFACE_UNREADABLE.
   */
  readonly exportedNames: readonly string[];
  readonly why: string;
  /**
   * The module specifier the spec imports it by. Filled in by the planner,
   * which is the only caller that knows where the spec will sit.
   */
  readonly specifier: string | null;
}

/**
 * Normalise a file name or a route to the one string both can be compared on.
 *
 * `OrdersIdPage.java`, `orders_id_page.py`, `orders-id.page.ts` and the route
 * `/orders/:id` all reduce to `ordersid`. The page/screen/object suffixes are
 * stripped FIRST, because `cart.page.ts` and `cart.ts` are the same page object
 * under two conventions and a comparison that kept the suffix would mint a
 * second one.
 */
export function reuseKey(nameOrRoute: string): string {
  const base = nameOrRoute.split('/').filter(Boolean).join('-');
  let stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  /*
   * REPEATEDLY, until it stops changing. `cart-page-object.ts` carries two of
   * these markers, and a single pass left `cart-page` — which does not match
   * `cart`, so a second page object would have been minted for a page that
   * already had one. Found by this module's own test, which is why the test
   * lists four spellings rather than two.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = stem.replace(/[-_.]?(pageobject|page|screen|object|po)$/i, '');
    if (stripped === stem || stripped.length === 0) break;
    stem = stripped;
  }
  return stem.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Every name a file exports, as far as a scanner can tell.
 *
 * DELIBERATELY `sharedSurfaceChange(content, '')` and not a second scanner.
 * Replacing a file with nothing removes everything it exported, so `removed` IS
 * the export list — which means this module and `artifactSetProblems` answer
 * "what does this file export" with the same code, rather than with two regex
 * sets that agree until somebody adds a language to one of them. That is the
 * defect suite-health.ts's two assertion vocabularies already cost this repo a
 * slice.
 *
 * Empty means UNREADABLE, and the caller must treat it as such.
 */
export function exportedNamesOf(content: string): readonly string[] {
  const change = sharedSurfaceChange(content, '');
  return change.state === 'READ' ? change.removed : [];
}

/**
 * A page object for this route that already exists, or null.
 *
 * The ledger is consulted first and the repository second, which is the order
 * of how much is KNOWN about the candidate rather than a preference: a ledger
 * row carries a role and a recorded ownership, and a file found by name carries
 * neither.
 *
 * The match is an inference from a file name, and it decides exactly one thing:
 * WHICH existing file this page's object is. Whether QAAI may WRITE it is
 * decided by the `ownership` on the row this returns — read from the ledger by
 * `resolveOwnership`, which answers UNRECORDED, and therefore no, for every
 * file the ledger has never seen.
 */
export function findReusablePageObject(args: {
  readonly route: string;
  readonly directory: string;
  readonly repository: ArtifactRepository;
}): ReusedArtifact | null {
  const { route, directory, repository } = args;
  const key = reuseKey(route);
  if (key.length === 0) return null;

  const fromLedger = repository.ledger.find(
    (entry) =>
      entry.role === 'PAGE_OBJECT' && reuseKey(entry.path.split('/').pop() ?? '') === key,
  );
  const candidate = fromLedger
    ? { path: fromLedger.path, basis: 'LEDGER_ROW' as const }
    : (() => {
        const match = repository
          .filesUnder(directory)
          .slice(0, MAX_REUSE_SCAN_FILES)
          .filter((path) => reuseKey(path.split('/').pop() ?? '') === key)
          /*
           * Sorted before taking the first, so two candidates in one directory
           * (`cart.page.ts` and `CartPage.ts`, left behind by a migration)
           * resolve the same way on every run. An unordered `find` over a
           * directory listing is a plan that changes when the filesystem
           * reorders.
           */
          .sort(byCodeUnit)[0];
        return match ? { path: match, basis: 'REPOSITORY_FILE' as const } : null;
      })();
  if (!candidate) return null;

  const disk = repository.diskStateAt(candidate.path);
  const exportedNames = disk.state === 'PRESENT' ? exportedNamesOf(disk.content) : [];
  return {
    role: 'PAGE_OBJECT',
    path: candidate.path,
    route,
    basis: candidate.basis,
    ownership: resolveOwnership(repository.ledger, candidate.path),
    exportedNames,
    // The planner fills this in: this function does not know where the spec
    // will sit, and inventing a specifier from a guess is how a prompt comes to
    // carry an import that does not resolve.
    specifier: null,
    why:
      candidate.basis === 'LEDGER_ROW'
        ? 'QAAI already generated a page object for this page; the spec imports it rather than a second copy.'
        : 'This repository already has a page object for this page; the spec imports theirs rather than minting a rival.',
  };
}

// ─── The member surface, and why the export surface is not enough ───────────

/**
 * Words that look like a member declaration to a line scanner and are not.
 *
 * The scanner below is deliberately not a parser, for the reason
 * suite-health.ts gives: the content is whatever a human or a model last wrote,
 * including files that do not parse. The cost of that is keywords —
 * `if (`, `for (`, `while (` — reading as method declarations. They are
 * excluded here rather than tolerated, because a false `removed` entry that a
 * dependent "mentions" would refuse every update of every page object.
 *
 * The second guard is in {@link dependentCalls}, which requires a MEMBER ACCESS
 * (`.name`) rather than a bare word: no spec ever writes `.if`.
 */
const NOT_MEMBERS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'await', 'else',
  'do', 'with', 'super', 'this', 'function', 'class', 'import', 'export', 'print',
  'assert', 'yield', 'raise', 'del', 'lambda', 'elif', 'except', 'match', 'case',
  'using', 'lock', 'foreach', 'fixed', 'unless', 'begin', 'end', 'when', 'in', 'is',
  'and', 'or', 'not', 'try', 'finally', 'throw', 'throws', 'await', 'async', 'static',
]);

/**
 * Member declaration forms, scanner-level and multi-language.
 *
 * Each is anchored at the start of a line, because a member declaration always
 * is and an expression almost never is. Over-reading costs a false "a dependent
 * might break", which is the direction that asks a human to look; under-reading
 * costs a silent break, which is the direction that does not.
 */
const MEMBER_FORMS: readonly RegExp[] = [
  // C-family method: optional modifiers, optional return type, name, open paren.
  /^[ \t]*(?:(?:public|private|protected|internal|static|final|open|override|readonly|async|suspend|abstract|virtual|get|set)[ \t]+)*(?:[A-Za-z_$][\w<>[\].,$ ]*?[ \t]+)?([A-Za-z_$]\w*)[ \t]*\(/gm,
  // Python / Kotlin / Go / Ruby / PHP definitions.
  /^[ \t]*(?:def|fun|func|sub|function)[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm,
  // A property or field: `readonly route = …`, `route: string`, `route =`.
  /^[ \t]*(?:(?:public|private|protected|static|readonly|const|val|var|let)[ \t]+)+([A-Za-z_$]\w*)[ \t]*[:=]/gm,
];

/** The members a file offers, as far as a scanner can tell. */
export function memberNamesOf(content: string): readonly string[] {
  const names = new Set<string>();
  for (const form of MEMBER_FORMS) {
    /*
     * `matchAll` and NOT `exec`, for the reason artifact-set.ts's `exportedNames`
     * records: a /g regex driven by `exec` carries `lastIndex` between calls and
     * would skip the first half of the second file it ever saw. `matchAll`
     * constructs a fresh regex from this one on every call.
     */
    for (const hit of content.matchAll(form)) {
      const name = hit[1];
      if (!name || NOT_MEMBERS.has(name) || NOT_MEMBERS.has(name.toLowerCase())) continue;
      names.add(name);
    }
  }
  return [...names];
}

/** What replacing one version of a shared file with another does to its members. */
export type MemberSurfaceChange =
  | { readonly state: 'UNREADABLE' }
  | {
      readonly state: 'READ';
      readonly removed: readonly string[];
      readonly added: readonly string[];
    };

/**
 * The member-level counterpart of `sharedSurfaceChange`.
 *
 * It exists because the export-level check CANNOT see the change this feature
 * is most likely to make: a page object whose class name is unchanged and whose
 * `addToCart()` is now `addItem()` removes no export at all, and breaks every
 * spec that called it. UNREADABLE is not "nothing was removed", exactly as it
 * is not there.
 */
export function memberSurfaceChange(before: string, after: string): MemberSurfaceChange {
  const old = memberNamesOf(before);
  if (old.length === 0) return { state: 'UNREADABLE' };
  const next = new Set(memberNamesOf(after));
  const oldSet = new Set(old);
  return {
    state: 'READ',
    removed: old.filter((name) => !next.has(name)),
    added: [...next].filter((name) => !oldSet.has(name)),
  };
}

/**
 * Which of these member names the dependent's own bytes actually reach for.
 *
 * MEMBER ACCESS and not a bare word: `cartPage.addToCart()`,
 * `page["addToCart"]`, `page.add_to_cart`, or Ruby's `:add_to_cart`. A spec
 * that merely contains the word "match" somewhere in a string is not calling a
 * method called `match`, and treating it as one would refuse every update.
 *
 * Both the camelCase and the snake_case spelling are checked, because the page
 * object's member is named once in {@link PageObjectModel} and rendered in two
 * casings — so a Python dependent calls `add_to_cart` for the member this
 * module calls `addToCart`.
 */
export function dependentCalls(
  dependentContent: string,
  members: readonly string[],
): readonly string[] {
  return members.filter((member) =>
    [member, toSnake(member)].some((spelling) => {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:[.:]|\\[["'])${escaped}\\b`).test(dependentContent);
    }),
  );
}

// ─── Refusal ────────────────────────────────────────────────────────────────

/** Why a plan may not be applied. Closed, so no caller can treat a new reason as a pass. */
export const ARTIFACT_PLAN_PROBLEMS = [
  /** Two planned artifacts resolve to one path. The second would silently win. */
  'PATH_COLLISION',
  /** A planned path's bytes could not be read, so no disposition can be computed from them. */
  'DISK_UNREADABLE',
  /** Replacing a shared artifact would remove a member a dependent calls. */
  'SHARED_MEMBER_REMOVED',
  /** A shared artifact is replaced and its prior members could not be read. */
  'SHARED_MEMBERS_UNREADABLE',
  /** A dependent of a shared artifact could not be read, so the blast radius is unknown. */
  'SHARED_DEPENDENT_UNREADABLE',
  /** The dataset carries an environment reference or a credential-shaped token. */
  'DATASET_SECRET',
  /** More artifacts than `MAX_ARTIFACTS_PER_SET`, after the page-object cap. */
  'SET_TOO_LARGE',
  /** A reused artifact's exports could not be read, so the prompt cannot name them. */
  'REUSE_SURFACE_UNREADABLE',
] as const;
export type ArtifactPlanProblemKind = (typeof ARTIFACT_PLAN_PROBLEMS)[number];

/**
 * Does this problem FORBID the plan, or only warn?
 *
 * Compiler-enforced. Exactly one member is `false`, and the decision it holds
 * is the one that could have gone either way: a reused page object whose
 * exports we could not read is a WARNING, because the alternative to importing
 * a file we cannot parse is MINTING A SECOND PAGE OBJECT FOR THE SAME PAGE,
 * which this file's rule TWO says is worse than having none. The prompt is told
 * the path and told that the names could not be read, and the admission gate's
 * TYPECHECK — the customer's own compiler — is what catches a wrong import.
 */
export const PLAN_PROBLEM_BLOCKS = {
  PATH_COLLISION: true,
  DISK_UNREADABLE: true,
  SHARED_MEMBER_REMOVED: true,
  SHARED_MEMBERS_UNREADABLE: true,
  SHARED_DEPENDENT_UNREADABLE: true,
  DATASET_SECRET: true,
  SET_TOO_LARGE: true,
  REUSE_SURFACE_UNREADABLE: false,
} as const satisfies Record<ArtifactPlanProblemKind, boolean>;

export interface ArtifactPlanProblem {
  readonly kind: ArtifactPlanProblemKind;
  /** The offending path, so a finding is attributable to a file a human can open. */
  readonly path: string;
  readonly why: string;
}

// ─── Secrets in generated test data ─────────────────────────────────────────

/**
 * Environment references and credential shapes a dataset may never contain.
 *
 * A dataset is DATA the customer's suite runs against, and it is committed to
 * their repository. Two things must never be in it: a reference to
 * `process.env` (the value would be resolved on somebody's machine and a
 * committed test fixture that reads a secret is a secret in a fixture), and
 * anything shaped like a live credential.
 *
 * The values themselves come from `createSyntheticFactory`, which cannot
 * produce either. The reason this scanner exists anyway is that a dataset's
 * COLUMN NAMES and SELECT OPTIONS come from the crawl, which is page content,
 * which is attacker-influenced — so the check is over the final bytes rather
 * than over the generator's intentions.
 *
 * WHAT IT DOES NOT CATCH, said plainly: a high-entropy string with no
 * recognisable prefix. This is a named-shape scanner, not an entropy
 * classifier, and claiming otherwise would be a pass that means "we did not
 * check".
 *
 * ── WHY THERE IS NO CREDENTIAL PREFIX IN THIS LIST ──────────────────────────
 *
 * There used to be six, hand-written, and they named 12 of the 26 shapes
 * `SECRET_SHAPES` in @qaai/shared already knows. The 14 a committed dataset
 * could therefore carry were measured, not reasoned: `sk_test_`, `rk_test_`,
 * `whsec_`, `ASIA`, `github_pat_`, `xapp-`, `glpat-`, `npm_`, `AIza`, `ya29.`,
 * `sq0csp-`, `sq0atp-`, `EAAA` and `SG.` — every one of them a live credential
 * walking into the customer's repository past a gate whose own name says
 * DATASET_SECRET.
 *
 * That is this codebase's `ASSERTION_KEY`-versus-`specAssertions` defect in the
 * credential layer: two vocabularies for one question, and the weaker one on
 * the write path. `packages/runner/src/plugins/email.ts` and `payments.ts` both
 * carry a comment saying they are DERIVED FROM `SECRET_SHAPES` and never a
 * parallel list, for exactly this reason. So this list now holds only the
 * ENVIRONMENT references, which `SECRET_SHAPES` has no notion of and which are
 * not credentials but references to one, and every credential PREFIX comes from
 * `SECRET_SHAPES` itself. `pk_live_` stays here and not there on purpose: a
 * publishable key is public by design — which is why `SECRET_SHAPES`
 * deliberately omits it, and the reason is written down there — but a dataset
 * committed to a repository is still not where it belongs.
 */
const SECRET_FORMS: readonly (readonly [string, RegExp])[] = [
  ['a process.env reference', /\bprocess\s*\.\s*env\b/],
  ['an os.environ reference', /\bos\s*\.\s*environ\b/],
  ['a System.getenv reference', /\bSystem\s*\.\s*getenv\b/],
  ['a Ruby ENV reference', /\bENV\s*\[/],
  ['a PowerShell env reference', /\$env:/i],
  ['a shell variable expansion', /\$\{?[A-Z][A-Z0-9_]{3,}\}?/],
  ['a publishable live-key prefix', /\bpk_live_[A-Za-z0-9]{4,}/],
];

/**
 * Every secret shape in this text, named. Empty means none of the named shapes
 * is present.
 *
 * A SUBSTRING test for the prefixes and not a word-boundary regex, and that is
 * the direction a credential scanner has to err: `\b` does not match between a
 * quote and `-----BEGIN`, and an AWS id pasted in lower case is still an AWS
 * id. Over-reading costs a refused dataset and a human a look; under-reading
 * commits the key.
 *
 * Deduplicated by NAME through a `Set`, so a shape both halves recognise is
 * reported once rather than twice — and the order is the order the two lists
 * declare, so two calls over one dataset report the same names in the same
 * sequence.
 */
export function datasetSecrets(content: string): readonly string[] {
  const named = new Set<string>();
  for (const [label, pattern] of SECRET_FORMS) {
    if (pattern.test(content)) named.add(label);
  }
  for (const shape of SECRET_SHAPES) {
    if (content.includes(shape.prefix)) named.add(shape.what);
  }
  return [...named];
}

// ─── The plan ───────────────────────────────────────────────────────────────

/** One file the plan will write, with its content already computed where it can be. */
export interface PlacedArtifact {
  readonly role: ArtifactRole;
  readonly path: string;
  /** Computed, model-free. Empty ONLY for the SPEC, whose code the generator supplies. */
  readonly content: string;
  /** Repo-relative paths this file imports from the project. */
  readonly imports: readonly string[];
  readonly why: string;
  readonly pathSource: PathSource;
  /** The page object's model, for a PAGE_OBJECT. Null for every other role. */
  readonly model: PageObjectModel | null;
  /**
   * The module specifier the SPEC imports this by, or null when the spec does
   * not import it — itself, and a DATASET, which is read as a file.
   *
   * Computed ONCE, here, and carried rather than recomputed by the briefing.
   * Two implementations of "what path does the spec write for this file" is two
   * answers, and the one in the prompt is the one that has to be right.
   */
  readonly specifier: string | null;
}

/** A page that got no page object, and why. A finding about the application, or our reach. */
export interface UnplannedPage {
  readonly route: string;
  readonly reason: PageObjectRefusal;
  readonly why: string;
}

/** The blast radius of replacing one shared artifact. */
export interface SharedImpact {
  readonly path: string;
  /** Repo-relative paths of everything the ledger says imports it. */
  readonly dependents: readonly string[];
  /** Members that would disappear, and which dependents call them. */
  readonly brokenCalls: readonly { readonly member: string; readonly dependents: readonly string[] }[];
}

export interface ArtifactPlan {
  readonly itemId: string;
  /** The SPEC's path. The generator's `filePath`, so the two shapes agree. */
  readonly specPath: string;
  /** Everything to write, ordered by `ARTIFACT_ROLE_RANK` through `orderedForApply` at assembly. */
  readonly artifacts: readonly PlacedArtifact[];
  readonly reused: readonly ReusedArtifact[];
  readonly unplannedPages: readonly UnplannedPage[];
  readonly sharedImpact: readonly SharedImpact[];
  /**
   * Paths this plan IMPORTS that the ledger has never seen, which must be
   * recorded as `HUMAN_AUTHORED` before the set is applied.
   *
   * Two separate things go wrong without this, and the first one is the one
   * that bites immediately: `artifactSetProblems` resolves an import against
   * the set or against the LEDGER, so a spec importing a human's page object —
   * a file that plainly exists on disk and is in neither — is refused with
   * UNRESOLVED_IMPORT. The second is slower and worse: with no row at that
   * path, a later run resolves it UNRECORDED, and UNRECORDED is the state a
   * reservation may claim.
   *
   * `HUMAN_AUTHORED` is exactly the member artifact-set.ts describes for this —
   * "the row exists so that 'QAAI does not own this' is a FACT rather than the
   * absence of a fact". So this is not a gap in the vocabulary; it is the row
   * the apply path owes.
   */
  readonly recordAsTheirs: readonly string[];
  /** Every cap that bit, as a count and a reason. */
  readonly omitted: readonly PageObjectOmission[];
  readonly problems: readonly ArtifactPlanProblem[];
  /** True when no blocking problem is present. See {@link PLAN_PROBLEM_BLOCKS}. */
  readonly plannable: boolean;
}

export interface PlanArtifactsArgs {
  readonly item: PlanItem;
  readonly profile: StyleProfile;
  readonly ecosystemId: EcosystemId;
  /** The pages this item touches, most relevant first — the cap keeps the head of this list. */
  readonly pages: readonly PageSource[];
  readonly repository: ArtifactRepository;
  /**
   * The dataset seed. A run id, per `SyntheticOptions.seed`: the same seed gives
   * the same dataset forever, which is what makes a generated fixture reviewable.
   */
  readonly seed: string;
  readonly renderers?: Partial<Record<EcosystemId, PageObjectRenderer>>;
}

/**
 * THE PLAN: which files, where, and which of them already exist.
 *
 * Deterministic and model-free. Called BEFORE the model writes the spec,
 * because the spec has to import the page objects and the prompt therefore has
 * to carry their paths and their class names — which is what
 * {@link artifactBriefing} renders.
 */
export function planArtifacts(args: PlanArtifactsArgs): ArtifactPlan {
  const { item, profile, ecosystemId, repository, seed } = args;
  const problems: ArtifactPlanProblem[] = [];
  const omitted: PageObjectOmission[] = [];
  const add = (kind: ArtifactPlanProblemKind, path: string, why: string): void => {
    problems.push({ kind, path, why });
  };

  const naming = namingOf(profile);
  const specLayout = directoryForRole({ role: 'SPEC', profile, ledger: repository.ledger, ecosystemId, item });
  const pageLayout = directoryForRole({ role: 'PAGE_OBJECT', profile, ledger: repository.ledger, ecosystemId, item });
  const fixtureLayout = directoryForRole({ role: 'FIXTURE', profile, ledger: repository.ledger, ecosystemId, item });
  const datasetLayout = directoryForRole({ role: 'DATASET', profile, ledger: repository.ledger, ecosystemId, item });

  const ecosystem = ECOSYSTEMS[ecosystemId];
  const conventionalBase = (() => {
    const conventional = ecosystem.path({ feature: item.feature, title: item.title });
    return conventional.split('/').pop() ?? conventional;
  })();
  /*
   * THE RUNNER'S COLLECTION RULE BEATS THE PROJECT'S NAMING CONVENTION, and
   * that order was found by this module's own test rather than reasoned out.
   *
   * Re-casing only the part before the first dot looked safe: the extension and
   * the `.spec` marker survive. It is not. pytest collects `test_*.py` and the
   * marker is INSIDE the stem, so a kebab-case repository turned
   * `test_adds_an_item.py` into `test-adds-an-item.py` — a file pytest never
   * collects, which admission.ts's PATH_CONVENTION gate describes exactly: the
   * suite goes GREEN over a file nobody executed.
   *
   * So the re-cased name is CHECKED against the same `filePattern` that gate
   * uses, and when it fails the ecosystem's own name wins and the convention
   * that could not be applied is DISCLOSED — rather than silently applied, and
   * rather than silently skipped.
   */
  const recasedBase = (() => {
    const firstDot = conventionalBase.indexOf('.');
    const stem = firstDot < 0 ? conventionalBase : conventionalBase.slice(0, firstDot);
    const rest = firstDot < 0 ? '' : conventionalBase.slice(firstDot);
    return `${applyNaming(stem, naming)}${rest}`;
  })();
  const recasedPath = joinPath(specLayout.directory, recasedBase);
  const specPath = ecosystem.filePattern.test(recasedPath)
    ? recasedPath
    : joinPath(specLayout.directory, conventionalBase);
  if (specPath !== recasedPath) {
    omitted.push({
      what: `this repository's ${naming ?? 'measured'} file naming, on the spec`,
      why:
        `${ecosystem.label} collects ${ecosystem.pathRule}, and the re-cased name does not match ` +
        'it, so the runner\u2019s rule won. A spec at a path its runner does not collect would ' +
        'never run, and the suite would go green without it.',
      count: 1,
    });
  }

  // ── Page objects: reuse, then mint ───────────────────────────────────────
  const placed: PlacedArtifact[] = [];
  const reused: ReusedArtifact[] = [];
  const unplannedPages: UnplannedPage[] = [];

  const pages = args.pages.slice(0, MAX_PAGE_OBJECTS_PER_SET);
  if (args.pages.length > pages.length) {
    omitted.push({
      what: 'pages past the per-set page-object cap',
      why:
        `This item touches ${args.pages.length} pages and a set may hold ` +
        `${MAX_PAGE_OBJECTS_PER_SET} page objects beside its spec, fixture and dataset. The ` +
        'pages kept are the ones the item names first; the spec must locate anything on the rest itself.',
      count: args.pages.length - pages.length,
    });
  }

  for (const page of pages) {
    const existing = findReusablePageObject({
      route: page.route,
      directory: pageLayout.directory,
      repository,
    });

    /*
     * REUSE OR REPLACE, and the fact that decides it is the RECORDED one.
     *
     * `WRITABLE_BY_OWNERSHIP` has exactly one `true` key, and this is the
     * question it answers: a page object the ledger records as QAAI_OWNED is
     * OURS, so a fresh crawl must UPDATE it — freezing it would mean the
     * controls the crawl just found never reach the suite, and the file would
     * drift from the application it describes. Anything else — a human's file,
     * one a human has edited, one nobody recorded — is IMPORTED and never
     * written, which is rule 11 and the single fact `pushRepo` lacks.
     */
    const ours = existing !== null && WRITABLE_BY_OWNERSHIP[existing.ownership];
    if (existing && !ours) {
      reused.push({ ...existing, specifier: moduleSpecifier(specPath, existing.path, profile) });
      if (existing.exportedNames.length === 0) {
        add(
          'REUSE_SURFACE_UNREADABLE',
          existing.path,
          'A page object for this page already exists and nothing could be read about what it ' +
            'exports, so the prompt can name the path and not the class. Importing it anyway ' +
            'beats minting a second page object for one page.',
        );
      }
      continue;
    }

    const synthesis = synthesisePageObject({
      page,
      profile,
      ecosystemId,
      ...(args.renderers ? { renderers: args.renderers } : {}),
      fileStem: applyNaming(routeSlug(page.route), naming),
    });
    if (synthesis.state === 'REFUSED') {
      unplannedPages.push({ route: page.route, reason: synthesis.reason, why: synthesis.why });
      continue;
    }
    /*
     * The path we already own wins over the path we would choose today. A
     * naming convention measured differently on this run would otherwise move
     * the file — and a move is a delete plus a write, which leaves the old file
     * orphaned and every spec that imports it broken. Nothing in this round may
     * delete a file, so nothing in this round may move one.
     */
    const pageObjectPath =
      ours && existing ? existing.path : joinPath(pageLayout.directory, synthesis.fileName);
    placed.push({
      role: 'PAGE_OBJECT',
      path: pageObjectPath,
      content: synthesis.source,
      imports: [],
      why: `The page object for this page, synthesised from the crawl's ${synthesis.model.accessors.length} sighted control(s).`,
      pathSource: ours && existing ? 'LEDGER_SIBLING' : pageLayout.source,
      model: synthesis.model,
      specifier: moduleSpecifier(specPath, pageObjectPath, profile),
    });
    omitted.push(...synthesis.model.omitted);
  }

  // ── The fixture, only where one can be written correctly ────────────────
  const fixtureRenderer = FIXTURE_RENDERERS[ecosystemId];
  const pageObjects = placed.filter((artifact) => artifact.role === 'PAGE_OBJECT');
  if (fixtureRenderer && pageObjects.length > 0) {
    const fixturePath = joinPath(
      fixtureLayout.directory,
      fixtureRenderer.fileName(applyNaming('pages', naming)),
    );
    const members = pageObjects.flatMap((artifact) =>
      artifact.model
        ? [
            {
              className: artifact.model.className,
              accessor: identifierFrom(artifact.model.className, 'page'),
              specifier: moduleSpecifier(fixturePath, artifact.path, profile),
            },
          ]
        : [],
    );
    placed.push({
      role: 'FIXTURE',
      path: fixturePath,
      content: fixtureRenderer.render(members),
      imports: pageObjects.map((artifact) => artifact.path),
      why: 'One fixture that builds every page object this suite uses, so setup is not copy-pasted into each spec.',
      pathSource: fixtureLayout.source,
      model: null,
      specifier: moduleSpecifier(specPath, fixturePath, profile),
    });
  } else if (pageObjects.length > 0) {
    omitted.push({
      what: 'a shared fixture',
      why:
        `No fixture renderer is built in for ${ecosystem.label}, and a fixture file at a path its ` +
        'runner does not load is setup that never runs. The spec constructs its page objects ' +
        'itself rather than importing a fixture that would be ignored.',
      count: 1,
    });
  }

  // ── The dataset, deterministic from the seed ────────────────────────────
  const dataset = buildDataset({ pages, item, seed });
  if (dataset && dataset.valuesTruncated > 0) {
    omitted.push({
      what: 'dataset cells shortened to the literal cap',
      why: `These values came from page content longer than ${MAX_LITERAL_CHARS} characters, so the row holds a prefix and the application may reject it for a reason that is ours.`,
      count: dataset.valuesTruncated,
    });
  }
  if (dataset && dataset.casesOmitted > 0) {
    omitted.push({
      what: 'dataset cases past the cap',
      why: `These pages carry more forms than the ${MAX_DATASET_CASES}-case dataset cap, so the rest have no row and a spec that needs them supplies its own values.`,
      count: dataset.casesOmitted,
    });
  }
  if (dataset) {
    const datasetPath = joinPath(
      datasetLayout.directory,
      `${applyNaming(routeSlug(`/${item.feature}-${item.title}`), naming)}.json`,
    );
    const secrets = datasetSecrets(dataset.content);
    if (secrets.length > 0) {
      add(
        'DATASET_SECRET',
        datasetPath,
        `The generated dataset contains ${secrets.join(', ')}. A dataset is committed to the ` +
          'customer’s repository and run against their application, so it was not planned. ' +
          'Its column names and option values come from crawled page content, which is where ' +
          'this came from.',
      );
    } else {
      placed.push({
        role: 'DATASET',
        path: datasetPath,
        content: dataset.content,
        imports: [],
        why: `Form data for this test, derived from the crawl's field semantics and the run seed, so it is the same on every run.`,
        pathSource: datasetLayout.source,
        model: null,
        // Read as a FILE, not imported: a specifier with the extension stripped
        // would be an import of a JSON module, which is a different thing and
        // not what the briefing tells the model to write.
        specifier: null,
      });
    }
  }

  // ── The spec goes last in the list and first in the prompt ──────────────
  placed.push({
    role: 'SPEC',
    path: specPath,
    content: '',
    imports: [
      ...placed.filter((artifact) => artifact.role === 'FIXTURE').map((artifact) => artifact.path),
      ...(placed.some((artifact) => artifact.role === 'FIXTURE')
        ? []
        : pageObjects.map((artifact) => artifact.path)),
      ...reused.map((artifact) => artifact.path),
    ],
    why: 'The test itself. The only file in this set a runner collects.',
    pathSource: specLayout.source,
    model: null,
    specifier: null,
  });

  // ── Collisions, size, and the shared-surface blast radius ───────────────
  const seen = new Set<string>();
  for (const artifact of placed) {
    if (seen.has(artifact.path)) {
      add(
        'PATH_COLLISION',
        artifact.path,
        'Two artifacts in this plan resolve to the same path, which happens when two routes ' +
          'reduce to one slug. The plan is refused rather than letting the second silently win.',
      );
    }
    seen.add(artifact.path);
  }
  if (placed.length > MAX_ARTIFACTS_PER_SET) {
    add(
      'SET_TOO_LARGE',
      '',
      `${placed.length} artifacts, past the cap of ${MAX_ARTIFACTS_PER_SET}. Nothing was ` +
        'truncated: a half-applied set is a repository that does not build.',
    );
  }

  const sharedImpact = placed
    .filter((artifact) => SHARED_ROLES[artifact.role])
    .flatMap((artifact) =>
      impactOf({ artifact, repository, problems: { add } }) ?? [],
    );

  return {
    itemId: item.id,
    specPath,
    artifacts: placed,
    reused,
    unplannedPages,
    sharedImpact,
    recordAsTheirs: reused
      .filter((artifact) => resolveOwnership(repository.ledger, artifact.path) === 'UNRECORDED')
      .map((artifact) => artifact.path),
    omitted,
    problems,
    plannable: !problems.some((problem) => PLAN_PROBLEM_BLOCKS[problem.kind]),
  };
}

/**
 * The dependents a shared replacement would change, and whether it breaks one.
 *
 * Returns `[]` rather than a record when there is nothing to replace or nothing
 * imports it: a page object nothing imports yet can be rewritten freely, and
 * saying otherwise would be noise that gets the whole check ignored — the rule
 * `artifactSetProblems` already applies to the export surface.
 */
function impactOf(args: {
  readonly artifact: PlacedArtifact;
  readonly repository: ArtifactRepository;
  readonly problems: { readonly add: (kind: ArtifactPlanProblemKind, path: string, why: string) => void };
}): readonly SharedImpact[] {
  const { artifact, repository } = args;
  const { add } = args.problems;
  const dependents = dependentsOf(repository.ledger, artifact.path);
  if (dependents.length === 0) return [];

  const disk = repository.diskStateAt(artifact.path);
  if (disk.state === 'UNREADABLE') {
    add(
      'DISK_UNREADABLE',
      artifact.path,
      `${dependents.length} file(s) import this and its current bytes could not be read ` +
        `(${disk.why}), so nothing can be said about what they would lose.`,
    );
    return [{ path: artifact.path, dependents: dependents.map((entry) => entry.path), brokenCalls: [] }];
  }
  if (disk.state === 'ABSENT') {
    // Nothing to replace: the dependents import a file that is not there, which
    // is already broken and is not made worse by writing it.
    return [{ path: artifact.path, dependents: dependents.map((entry) => entry.path), brokenCalls: [] }];
  }

  if (!ROLE_HAS_MEMBER_SURFACE[artifact.role]) {
    // A dataset or a snapshot has no members. Its surface is its bytes, and
    // `artifactSetProblems` is what decides whether replacing them is allowed.
    return [{ path: artifact.path, dependents: dependents.map((entry) => entry.path), brokenCalls: [] }];
  }

  const change = memberSurfaceChange(disk.content, artifact.content);
  if (change.state === 'UNREADABLE') {
    add(
      'SHARED_MEMBERS_UNREADABLE',
      artifact.path,
      `${dependents.length} file(s) import this and no member declaration could be read from ` +
        'what it replaces. UNREADABLE is not "nothing was removed".',
    );
    return [{ path: artifact.path, dependents: dependents.map((entry) => entry.path), brokenCalls: [] }];
  }

  const broken = new Map<string, string[]>();
  for (const dependent of dependents) {
    const dependentDisk = repository.diskStateAt(dependent.path);
    if (dependentDisk.state !== 'PRESENT') {
      add(
        'SHARED_DEPENDENT_UNREADABLE',
        dependent.path,
        `This file imports ${artifact.path} and its bytes could not be read, so whether it calls ` +
          `one of the ${change.removed.length} member(s) this change removes is unknown. An ` +
          'unknown blast radius is a refusal.',
      );
      continue;
    }
    for (const member of dependentCalls(dependentDisk.content, change.removed)) {
      broken.set(member, [...(broken.get(member) ?? []), dependent.path]);
    }
  }

  const brokenCalls = [...broken.entries()]
    .map(([member, paths]) => ({ member, dependents: paths }))
    .sort((a, b) => byCodeUnit(a.member, b.member));
  for (const entry of brokenCalls) {
    add(
      'SHARED_MEMBER_REMOVED',
      artifact.path,
      `This replacement removes ${entry.member}, which ${entry.dependents.length} file(s) call: ` +
        `${entry.dependents.join(', ')}. Change them in the same set, or propose it.`,
    );
  }

  return [
    { path: artifact.path, dependents: dependents.map((entry) => entry.path), brokenCalls },
  ];
}

// ─── The dataset ────────────────────────────────────────────────────────────

/** `SyntheticField`, from a crawled form field. The semantic is what the factory keys on. */
function syntheticFieldOf(field: {
  readonly name: string;
  readonly label: string | null;
  readonly inputType: string;
  readonly required: boolean;
  readonly semantic: FormFieldSemantic;
  readonly options?: string[];
  readonly maxLength?: number | null;
  readonly minLength?: number | null;
  readonly pattern?: string | null;
}): SyntheticField {
  return {
    name: field.name,
    semantic: field.semantic,
    label: field.label,
    inputType: field.inputType,
    required: field.required,
    ...(field.options ? { options: field.options } : {}),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
  };
}

/** A generated dataset, and the cases a cap cost. */
export interface Dataset {
  /** The file's bytes. A top-level JSON array of rows. */
  readonly content: string;
  /**
   * Forms that would have produced a row and did not, because
   * {@link MAX_DATASET_CASES} bit. A count, so the planner can disclose it.
   */
  readonly casesOmitted: number;
  /**
   * Cells shortened to {@link MAX_LITERAL_CHARS}.
   *
   * A truncated cell is a value the application will reject for a reason that
   * is ours, so the count travels rather than the truncation being invisible —
   * a cap that bit and was not reported is one of the lies this product cannot
   * afford, and a dataset is the one artifact a reviewer reads as literal truth.
   */
  readonly valuesTruncated: number;
}

/**
 * One JSON dataset for every form these pages carry, or null when they carry
 * none.
 *
 * A TOP-LEVEL ARRAY OF OBJECTS, which is not a style choice: `parseJsonRows` in
 * packages/runner/src/data-driven.ts refuses anything else, and `datasetSchema`
 * requires every column name to match `/^[A-Za-z_][A-Za-z0-9_]*$/` because a
 * column reaches a request as a `{{placeholder}}`. The keys here come from
 * {@link identifierFrom}, which emits exactly that class — so a dataset this
 * function writes is one the product's own runner can read, rather than a file
 * shaped like one.
 *
 * Deterministic from `(seed, item.id, form id)`: `createSyntheticFactory` is
 * pure, so the same arguments produce byte-identical bytes in every process,
 * forever. That is what makes a committed generated fixture reviewable — a
 * dataset that changed every run would produce a diff on every generation.
 */
export function buildDataset(args: {
  readonly pages: readonly PageSource[];
  readonly item: PlanItem;
  readonly seed: string;
}): Dataset | null {
  const factory = createSyntheticFactory({ seed: args.seed, scope: args.item.id });
  const rows: Record<string, string>[] = [];
  let casesOmitted = 0;
  let valuesTruncated = 0;

  for (const page of args.pages) {
    for (const form of page.forms) {
      const fields = form.fields.filter(
        (field) => field.inputType.toLowerCase() !== 'file' && field.inputType.toLowerCase() !== 'hidden',
      );
      if (fields.length === 0) continue;
      /*
       * The cap is counted HERE, after the form is known to produce a row, and
       * it is counted rather than `break`ing the loop. An earlier version broke
       * out of the inner loop only, so the next page's forms were considered
       * again and the number of cases a cap had cost was nowhere — a cap
       * applied without being disclosed, which is one of the lies this product
       * cannot afford.
       */
      if (rows.length >= MAX_DATASET_CASES) {
        casesOmitted += 1;
        continue;
      }
      /*
        * Scoped by ROUTE AND FORM ID, not by form id alone. Two pages whose
        * forms share an id — `#signup` on /register and on /checkout is
        * ordinary — would otherwise be given the same scope, and
        * `createSyntheticFactory` is pure, so they would get the SAME email in
        * two rows. A dataset whose rows collide on a unique field is a dataset
        * whose second case fails for a reason that is ours.
        */
      const fill = factory
        .scoped(`${page.route}/${form.id}`)
        .fillForm(fields.map(syntheticFieldOf));
      const row: Record<string, string> = {};
      for (const [index, field] of fields.entries()) {
        const column = identifierFrom(field.name || field.label || '', `field${index + 1}`);
        /*
         * The cap is the same one page-objects.ts uses for a generated literal,
         * so the two cannot disagree about how long a crawled string may be —
         * and it is COUNTED, because a shortened cell is a value the
         * application will reject for a reason that is ours.
         */
        const value = fill.values[field.name] ?? '';
        if (value.length > MAX_LITERAL_CHARS) valuesTruncated += 1;
        row[column] = value.slice(0, MAX_LITERAL_CHARS);
      }
      rows.push(row);
    }
  }

  if (rows.length === 0) return null;
  return { content: `${JSON.stringify(rows, null, 2)}\n`, casesOmitted, valuesTruncated };
}

// ─── Fixture renderers ──────────────────────────────────────────────────────

/** One page object a fixture exposes. */
export interface FixtureMember {
  readonly className: string;
  /** The fixture key a spec destructures: `cartPage`. */
  readonly accessor: string;
  /** The import specifier, relative to the fixture file. */
  readonly specifier: string;
}

export interface FixtureRenderer {
  readonly fileName: (stem: string) => string;
  readonly render: (members: readonly FixtureMember[]) => string;
}

/**
 * WHICH ECOSYSTEMS GET A FIXTURE, as a total record — and almost all of them do
 * not.
 *
 * This looks like a gap and is a refusal. A fixture file is only a fixture if
 * the runner LOADS it, and where it has to sit to be loaded is a fact about the
 * customer's configuration: pytest finds `conftest.py` relative to its rootdir,
 * JUnit 5 needs the extension registered, RSpec needs `spec_helper` required.
 * None of those is readable from a crawl and a flow map, so writing the file
 * anyway would produce setup that never runs — a pass that means "we did not
 * check", with a file in somebody's repository to show for it.
 *
 * Playwright TypeScript is the exception because `test.extend` needs no
 * registration at all: a spec that imports `test` from the fixture file gets
 * the fixtures, and a spec that does not is unaffected.
 *
 * Total over `EcosystemId`, so a 40th ecosystem cannot fall through to the
 * TypeScript renderer — the `CONVERT_SYSTEM` defect this round exists to fix.
 */
export const FIXTURE_RENDERERS = {
  PLAYWRIGHT_TS: {
    fileName: (stem: string) => `${stem}.fixture.ts`,
    render: (members: readonly FixtureMember[]) => {
      const lines: string[] = [
        '/*',
        ' * Generated by QAAI. One fixture per page object, so a spec destructures the pages it',
        ' * needs instead of constructing them. Import `test` and `expect` from here.',
        ' */',
        "import { test as base } from '@playwright/test';",
      ];
      for (const member of members) {
        lines.push(`import { ${member.className} } from '${member.specifier}';`);
      }
      lines.push('');
      lines.push(
        `export const test = base.extend<{ ${members
          .map((member) => `${member.accessor}: ${member.className}`)
          .join('; ')} }>({`,
      );
      for (const member of members) {
        lines.push(`  ${member.accessor}: async ({ page }, use) => {`);
        lines.push(`    await use(new ${member.className}(page));`);
        lines.push('  },');
      }
      lines.push('});', '');
      /*
       * Re-exported rather than left to the spec: a spec that imports `test`
       * from here and `expect` from '@playwright/test' works, and a spec that
       * imports BOTH from '@playwright/test' silently gets the un-extended
       * `test` and no fixtures. One import line removes the choice.
       */
      lines.push("export { expect } from '@playwright/test';", '');
      return lines.join('\n');
    },
  },
  CYPRESS: null,
  WEBDRIVERIO: null,
  PUPPETEER: null,
  NIGHTWATCH: null,
  TESTCAFE: null,
  JEST: null,
  VITEST: null,
  PLAYWRIGHT_PYTHON: null,
  SELENIUM_PYTHON: null,
  APPIUM_PYTHON: null,
  PYTEST: null,
  UNITTEST: null,
  ROBOT: null,
  PLAYWRIGHT_JAVA: null,
  SELENIUM_JAVA: null,
  APPIUM_JAVA: null,
  JUNIT5: null,
  TESTNG: null,
  PLAYWRIGHT_KOTLIN: null,
  SELENIUM_KOTLIN: null,
  ESPRESSO: null,
  JUNIT5_KOTLIN: null,
  PLAYWRIGHT_CSHARP: null,
  SELENIUM_CSHARP: null,
  NUNIT: null,
  XUNIT: null,
  CAPYBARA_RSPEC: null,
  SELENIUM_RUBY: null,
  RSPEC: null,
  MINITEST: null,
  PLAYWRIGHT_GO: null,
  CHROMEDP: null,
  GO_TEST: null,
  PANTHER: null,
  CODECEPTION: null,
  PHPUNIT: null,
  PEST: null,
  CUCUMBER: null,
} as const satisfies Record<EcosystemId, FixtureRenderer | null>;

/**
 * The module specifier one generated file uses to import another.
 *
 * The project's own `importAlias` wins when the profile measured one at MEDIUM
 * or above — a suite that imports everything through `@/` and then receives a
 * `../../pages/cart.page` is a file that was not written here. Otherwise a
 * relative path, and the extension is dropped: every ecosystem with a built-in
 * renderer here is TypeScript, where the extension is omitted under both of the
 * module resolutions this repo's own tsconfigs use.
 */
export function moduleSpecifier(from: string, to: string, profile: StyleProfile): string {
  const alias = profile.importAlias;
  const withoutExtension = to.replace(/\.[A-Za-z0-9]{1,4}$/, '');
  if (CONFIDENCE_IS_USABLE[alias.confidence] && alias.value) {
    return `${alias.value}${withoutExtension}`;
  }
  const fromParts = dirnameOf(from).split('/').filter(Boolean);
  const toParts = withoutExtension.split('/').filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1;
  }
  const up = fromParts.length - shared;
  const down = toParts.slice(shared);
  return up === 0 ? `./${down.join('/')}` : `${'../'.repeat(up)}${down.join('/')}`;
}

// ─── The briefing: what the prompt is told, model-free ──────────────────────

/**
 * THE ONLY SANCTIONED RENDERING OF A PLAN INTO A PROMPT.
 *
 * It exists for the same reason `styleProfileBriefing` does: five prompt files
 * would each describe the set differently and one of them would forget to say
 * that the page object already exists. Deterministic, OUR words over a closed
 * vocabulary, and it quotes NO customer source — the only crawled strings it
 * contains are class names and paths that have already been through
 * `identifierFrom` and `safeRoute`.
 *
 * An empty plan renders one honest line, which is the behaviour rule 13 demands.
 */
export function artifactBriefing(plan: ArtifactPlan): string {
  const lines: string[] = [];
  const pageObjects = plan.artifacts.filter((artifact) => artifact.role === 'PAGE_OBJECT');
  const fixture = plan.artifacts.find((artifact) => artifact.role === 'FIXTURE');
  const dataset = plan.artifacts.find((artifact) => artifact.role === 'DATASET');

  if (pageObjects.length === 0 && plan.reused.length === 0 && !fixture && !dataset) {
    return (
      `THE FILES BESIDE THIS TEST: none. Write the whole test in ${plan.specPath}; there is no ` +
      'page object, fixture or dataset for it, so do not import one.'
    );
  }

  lines.push(
    `THE FILES BESIDE THIS TEST. They are being written for you — do not write them again, and ` +
      `do not inline what they already do. Your spec goes in ${plan.specPath}.`,
  );

  if (fixture) {
    lines.push(
      `- Import test and expect from ${fixture.specifier ?? fixture.path} — that is the ` +
        'fixture that constructs the page objects. Importing test from the runner directly gets ' +
        'you the un-extended one and no fixtures.',
    );
  }
  for (const artifact of pageObjects) {
    if (!artifact.model) continue;
    lines.push(
      `- ${artifact.model.className} from ${artifact.specifier ?? artifact.path}: ` +
        `${artifact.model.accessors.length} accessor(s), ${artifact.model.navigations.length} ` +
        `navigation(s), ${artifact.model.fillers.length} form filler(s). Use them; the locators ` +
        'in it were observed on the page.',
    );
  }
  for (const artifact of plan.reused) {
    lines.push(
      artifact.exportedNames.length > 0
        ? `- ${artifact.path} ALREADY EXISTS and is the page object for this page. Import ` +
          `${artifact.exportedNames.slice(0, 6).join(', ')} from ` +
          `${artifact.specifier ?? artifact.path}. Do not write a second one.`
        : `- ${artifact.path} ALREADY EXISTS and is the page object for this page. Its exports ` +
          'could not be read, so read the file and import from it. Do not write a second one.',
    );
  }
  if (dataset) {
    lines.push(
      `- ${dataset.path} holds the form data, as a JSON array of rows whose keys are the field ` +
        'names. Read it rather than hard-coding values.',
    );
  }

  lines.push(
    'ASSERTIONS GO IN THE SPEC AND NOWHERE ELSE. A page object that asserts is a page object ' +
      'whose failure message names the wrong thing.',
  );
  return lines.join('\n');
}

// ─── From a plan to a set ───────────────────────────────────────────────────

/**
 * The set a PRODUCER declares, before any repository is consulted.
 *
 * `QAAI_OWNED` and `NEW` on every artifact, which is what a freshly generated
 * file IS and exactly what `singleFileArtifactSet` claims for the single-file
 * case. This is the shape `artifactSetSchema` accepts — it runs
 * `artifactSetProblems` with no ledger and skips the ledger-dependent half —
 * so it is what gets attached to `generatedTestSchema` and stored.
 *
 * IT IS NOT A PERMISSION TO WRITE. {@link resolveAgainstRepository} is, and a
 * caller that applies this set without re-resolving it is the `pushRepo`
 * defect with extra steps.
 */
export function declaredArtifactSet(args: {
  readonly plan: ArtifactPlan;
  readonly specCode: string;
  readonly dialect: ArtifactSet['dialect'];
}): ArtifactSet {
  /*
   * `orderedForApply` and not the plan's own order, which is the order a HUMAN
   * reads (page objects, then the fixture, then the data, then the test). A set
   * in that order is refused with APPLY_ORDER, because the apply order is
   * `ARTIFACT_ROLE_RANK`'s — a DATASET before the FIXTURE that imports it. Two
   * orders exist and only one of them is the set's; sorting here is what stops
   * the readable one from leaking into the stored one.
   */
  return orderedForApply({
    dialect: args.dialect,
    artifacts: args.plan.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      content: artifact.role === 'SPEC' ? args.specCode : artifact.content,
      disposition: 'NEW' as const,
      ownership: 'QAAI_OWNED' as const,
      imports: artifact.imports,
      basedOnHash: null,
      why: artifact.why,
    })),
  });
}

/** A path the ledger must record before the set can be applied. */
export interface Reservation {
  readonly path: string;
  readonly role: ArtifactRole;
  readonly why: string;
}

export interface ResolvedSet {
  /** The set as the ledger NOW stands. Dispositions derived, never claimed. */
  readonly set: ArtifactSet;
  /**
   * Paths holding nothing, recorded by nobody.
   *
   * A write there destroys nothing, which is the only ground on which QAAI may
   * claim a path — and the claim must be RECORDED before the write, because
   * `artifactSetProblems` refuses an artifact whose ownership disagrees with the
   * ledger's. So this is the planner ASKING, not granting: record these rows,
   * then resolve again and the set comes back NEW and applyable.
   */
  readonly reservations: readonly Reservation[];
  readonly problems: readonly ArtifactPlanProblem[];
  /** False while any reservation is outstanding or any problem blocks. Never guessed. */
  readonly applyable: boolean;
}

/**
 * THE SET AS THE REPOSITORY WILL ACCEPT IT — every disposition derived from
 * `dispositionFor`, every ownership read from the ledger, nothing claimed.
 *
 * The three outcomes per path, and each is a decision this round's rule 11
 * turns on:
 *
 *  · RECORDED QAAI_OWNED and the bytes still match → `UPDATE_OWNED`, carrying
 *    the ledger's hash as its optimistic-concurrency token.
 *  · RECORDED QAAI_OWNED and the bytes have CHANGED → `PROPOSED_EDIT`. A human
 *    changed our file, so it is theirs now.
 *  · UNRECORDED → `PROPOSED_EDIT`, and when nothing is on disk, a RESERVATION.
 *    Never a write on the strength of the path looking like ours.
 */
export function resolveAgainstRepository(args: {
  readonly set: ArtifactSet;
  readonly repository: ArtifactRepository;
}): ResolvedSet {
  const { repository } = args;
  const problems: ArtifactPlanProblem[] = [];
  const reservations: Reservation[] = [];

  const artifacts: GeneratedArtifact[] = args.set.artifacts.map((artifact) => {
    const verdict = resolveOwnership(repository.ledger, artifact.path);
    const row = repository.ledger.find((entry) => entry.path === artifact.path);
    const disk = repository.diskStateAt(artifact.path);
    if (disk.state === 'UNREADABLE') {
      problems.push({
        kind: 'DISK_UNREADABLE',
        path: artifact.path,
        why:
          `The bytes at this path could not be read (${disk.why}), so no disposition can be ` +
          'computed from them. It is proposed rather than written, and the set carries no base ' +
          'hash for it — which is itself a refusal, and the correct one: a change computed ' +
          'against unknown bytes.',
      });
    }
    const onDiskHash = disk.state === 'PRESENT' ? repository.digest(disk.content) : null;
    const disposition = dispositionFor({
      verdict,
      ledgerHash: row?.contentHash ?? null,
      onDiskHash,
    });

    if (verdict === 'UNRECORDED' && disk.state === 'ABSENT') {
      reservations.push({
        path: artifact.path,
        role: artifact.role,
        why:
          'Nothing is at this path and no ledger row claims it, so writing it destroys nothing. ' +
          'Record it as QAAI_OWNED first; this plan does not grant itself the write.',
      });
    }

    return {
      ...artifact,
      disposition,
      ownership: verdict,
      basedOnHash:
        disposition === 'NEW'
          ? null
          : // UPDATE_OWNED is based on what the LEDGER holds — that is the token
            // `artifactSetProblems` compares. PROPOSED_EDIT is based on what is
            // ON DISK, because that is what the human would be shown a diff
            // against.
            disposition === 'UPDATE_OWNED'
            ? (row?.contentHash ?? null)
            : onDiskHash,
    };
  });

  return {
    set: { ...args.set, artifacts },
    reservations,
    problems,
    applyable:
      reservations.length === 0 && !problems.some((problem) => PLAN_PROBLEM_BLOCKS[problem.kind]),
  };
}

/**
 * The class name a reused or planned page object offers, for a caller that has
 * only the path.
 *
 * Exported because the generator needs it for the prompt and the inline editor
 * needs it for a completion, and deriving it twice is how two spellings of one
 * class name end up in one repository.
 */
export function pageObjectClassName(route: string): string {
  return `${classNameFrom(routeSlug(route), 'page')}Page`;
}
