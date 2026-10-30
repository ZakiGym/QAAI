/**
 * Test ownership (§8) — whose failure is this.
 *
 * A red build is only actionable if somebody knows it is theirs. QAAI could say
 * exactly what broke and why, and then put it on a screen that belongs to
 * everybody, which in practice means nobody: the failure sits in triage until a
 * person who happens to be looking recognises the test name.
 *
 * Two ways to answer, and the product needs both:
 *
 *   EXPLICIT   this test / this suite / this feature belongs to Dana, or to the
 *              payments team. Precise, and nobody will ever maintain it for a
 *              suite of two thousand tests.
 *   PATTERN    `tests/checkout/**` belongs to the payments team. One line covers
 *              a directory forever, including the tests that do not exist yet —
 *              which is the only reason ownership survives contact with a suite
 *              that grows every week. A repo with a CODEOWNERS file has already
 *              written these rules once, and they paste straight in.
 *
 * So the glob dialect is CODEOWNERS' own (gitignore's, minus the parts GitHub
 * drops), because the rules are being copied from a file people already have,
 * and a pattern that means something subtly different here would route failures
 * to the wrong team while looking correct.
 *
 * ─── Precedence ─────────────────────────────────────────────────────────────
 *
 * TEST > SUITE > FEATURE > PATH, and among path patterns the last one wins.
 *
 * The first three are ordered by how specifically a human pointed at the thing:
 * someone who assigned THIS test said more than someone who assigned the
 * directory it lives in. Last-match-wins among patterns is CODEOWNERS' rule
 * verbatim — `*` on line 1 and `tests/billing/**` on line 9 has to resolve to
 * billing, or every CODEOWNERS file pasted in here routes everything to the
 * catch-all.
 *
 * ─── An unowned test is a normal state ──────────────────────────────────────
 *
 * There is no default owner and no fallback, deliberately. Ownership is opt-in
 * and most suites will start with none; a product that treats "unowned" as an
 * error state nags about a table nobody asked to fill in. And a fallback owner
 * is worse than none: it pages whoever is listed first for failures that are not
 * theirs, and the second time that happens the feature gets turned off.
 *
 * This module is pure — no Prisma, no Express — because the interesting part is
 * the matching, and matching is only trustworthy if it is cheap to test. See
 * ownership.test.ts.
 */

/*
 * The vocabulary this module WRITES — who owns something, which kind of nobody
 * owns it, and what a ticket can be filed about — now lives in
 * packages/shared/src/types.ts, and is imported here rather than declared
 * twice. The matching itself (patterns, precedence, the rule table) stays in
 * this file; only the shapes a reader receives were promoted, because the web
 * app renders these states and could not name them while they lived inside the
 * API.
 *
 * Re-exported at the bottom of the file, not here, because three modules
 * already import them from this one — see that block.
 */
import type {
  IssueOwnerState,
  OwnerAssignment,
  OwnerRef,
  OwnershipState,
} from '@qaai/shared';

/*
 * The provenance vocabulary, FROM THE BARREL. It arrived here by a four-dot
 * relative path because `packages/shared/src/index.ts` did not re-export
 * `./ownership` yet; it does now (`export * from './ownership'`), so the
 * relative path is the stale half of a repaired pair and a cross-workspace
 * relative import that no longer has a reason.
 */
import {
  OWNER_PROVENANCES,
  OWNER_PROVENANCE_STRENGTH,
  isHumanSetProvenance,
  mayPage,
  resolutionIsCoherent,
} from '@qaai/shared';
import type {
  OwnableSubject,
  OwnerProvenance,
  OwnerResolution,
  OwnerStrength,
  OwnershipRuleSource,
} from '@qaai/shared';

/** Which of the four things a rule points at. */
export type OwnershipSubject = 'TEST' | 'SUITE' | 'FEATURE' | 'PATH';

/** A stable grouping key — the digest buckets failures by this. */
export function ownerKey(owner: OwnerRef): string {
  return owner.kind === 'USER' ? `USER:${owner.userId}` : `TEAM:${owner.teamId}`;
}

/**
 * The Prisma `select` that produces an `OwnershipRuleInput`.
 *
 * Exported because there are already three hand-written copies of this field
 * list (the digest, GET /team/ownership/resolve, and now the filing path), and
 * a copy that forgets `position` does not fail — it resolves last-match-wins
 * against a column that is always 0, which quietly routes every failure to the
 * first rule that matches instead of the last.
 */
export const OWNERSHIP_RULE_SELECT = {
  id: true,
  position: true,
  pathPattern: true,
  testId: true,
  suiteId: true,
  feature: true,
  ownerUserId: true,
  ownerTeamId: true,
  /*
   * WHERE THE RULE CAME FROM, and it is in the SHARED select rather than in one
   * caller's copy on purpose.
   *
   * `provenanceOfMatch` downgrades a winning match to CODEOWNERS_IMPORT — WEAK,
   * and therefore not pageable — only when it is told the rule was imported,
   * and every production caller passed nothing because there was no column to
   * read. A select that asks for it in three places and forgets it in the
   * fourth is the same silent failure `position` is commented for above: the
   * fourth surface pages a team on the strength of a glob somebody pasted,
   * while the other three correctly call it a suggestion.
   *
   * {@link codeownersRuleIdsOf} is what turns these rows into the set
   * `routeOwner` takes, so no caller spells `'CODEOWNERS'` itself.
   */
  source: true,
} as const;

/** One `OwnershipRule` row, reduced to what matching needs. */
export interface OwnershipRuleInput {
  id: string;
  /** Rule order within the project. Among path patterns, the highest wins. */
  position: number;
  pathPattern: string | null;
  testId: string | null;
  suiteId: string | null;
  feature: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  /**
   * `OWNERSHIP_RULE_SOURCES`, or null/absent.
   *
   * OPTIONAL, and ABSENT MEANS THE SAME AS NULL — nobody recorded where this
   * rule came from. The column is nullable and deliberately not back-filled.
   *
   * NULL IS READ AS MANUAL HERE, and that is the one place in this round where
   * a null may be read as a value. It is true rather than convenient: there was
   * no importer until this round, so no row that predates the column can have
   * been imported, and the migration that added it
   * (20261029160000_run_selection_source_preflight_evidence_and_ownership_rule_source)
   * states exactly that as its reason for not back-filling. The day a SECOND
   * source joins `OWNERSHIP_RULE_SOURCES`, that reasoning stops holding for it
   * — which is why {@link codeownersRuleIdsOf} asks "is it CODEOWNERS" and
   * never "is it not MANUAL".
   */
  source?: string | null;
}

/** The test being routed. */
export interface OwnableTest {
  id: string;
  filePath: string;
  suiteId: string | null;
  feature: string | null;
}

export interface OwnershipMatch {
  ruleId: string;
  subject: OwnershipSubject;
  owner: OwnerRef;
  /** Why this rule matched, in a sentence the cockpit prints verbatim. */
  reason: string;
}

/**
 * The full answer, not just the winner.
 *
 * `matched` is returned because "why does the payments team own this?" is asked
 * the moment ownership is wrong, and a resolver that only says who leaves the
 * user to reverse-engineer the rule list by hand.
 *
 * `skipped` exists because a rule that cannot be evaluated must not vanish. A
 * pattern that was valid when it was stored and is not valid now would otherwise
 * silently stop routing, and silently-stopped routing looks exactly like a test
 * nobody owns. Callers surface these; nothing here swallows one.
 */
export interface OwnershipResolution {
  owner: OwnershipMatch | null;
  matched: OwnershipMatch[];
  skipped: Array<{ ruleId: string; reason: string }>;
}

/** A rule the caller wrote wrong. Carries a sentence that says what to change. */
export class OwnershipRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipRuleError';
  }
}

// ─── Path patterns ───────────────────────────────────────────────────────────

/**
 * Ceilings on a pattern. Both are about the regex this compiles into: `**`
 * becomes a quantified group, and a pattern with thirty of them is a
 * backtracking bomb aimed at every ownership lookup in the org. No real
 * CODEOWNERS line comes close to either number.
 */
const MAX_PATTERN_LENGTH = 200;
const MAX_PATTERN_SEGMENTS = 24;

/** How many test paths one project may hold rules for. */
export const MAX_OWNERSHIP_RULES_PER_PROJECT = 500;

/**
 * Validate and tidy a pattern, or throw a sentence saying what is wrong with it.
 *
 * Most of the rejections are the places this dialect differs from the gitignore
 * syntax people half-remember, and each one is refused loudly rather than
 * reinterpreted — a pattern that silently means something other than what it
 * says routes failures to the wrong team and looks right while doing it. The
 * control-character refusal is the one that is not about the dialect at all;
 * its own comment says what it is for.
 *
 * NO SENTENCE THIS FUNCTION THROWS QUOTES THE PATTERN, and that is load-bearing
 * rather than taste: `parseCodeowners` puts these messages into its `skipped`
 * reasons and the importer hands those to a customer, so a message carrying the
 * offending line would be exactly the leak the importer refuses lines by NUMBER
 * to avoid. (`compilePattern` below does interpolate, for a doubled slash —
 * which is why the control-character check is here, in front of it.)
 */
export function normalisePattern(raw: string): string {
  const pattern = raw.trim();

  if (!pattern) {
    throw new OwnershipRuleError('A path pattern cannot be empty.');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new OwnershipRuleError(
      `That path pattern is ${pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}. Split it into two rules.`,
    );
  }
  /*
   * CONTROL CHARACTERS, refused here rather than downstream.
   *
   * THE DEFECT THIS CLOSES: an imported CODEOWNERS line is customer-authored
   * text, `stripped.split(/\s+/)` does not treat U+0007 (or any other C0
   * character that is not whitespace) as a separator, and nothing below this
   * point looked. Such a pattern stored fine and then reached
   * `compilePattern`'s doubled-slash refusal, which INTERPOLATES THE PATTERN —
   * so a newline or an escape sequence out of a repository's own file ended up
   * inside `OwnerAssignment.unusable[].reason`, which is copied verbatim into
   * `TriageVerdict.ownerNote` and read by a human and a model. A path is
   * customer-authored text by the same rule a locale tag is: report the field,
   * never the value.
   *
   * It is in `normalisePattern` and not in the importer because this is the ONE
   * validator both write paths run through — `parseCodeowners` calls it for
   * exactly that reason — and a check in the importer alone would leave the
   * hand-typed door open.
   */
  for (let index = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new OwnershipRuleError(
        'That path pattern contains a control character. Remove it — a path is matched against `Test.filePath`, and a control character there breaks every line-oriented report it appears in.',
      );
    }
  }
  if (pattern.startsWith('!')) {
    throw new OwnershipRuleError(
      'Negated patterns (!) are not supported, the same as in CODEOWNERS. Write the rule that should win as the later one instead — the last matching pattern owns the file.',
    );
  }
  if (/[[\]]/.test(pattern)) {
    throw new OwnershipRuleError(
      'Character ranges like [abc] are not supported, the same as in CODEOWNERS. Use * or ** instead.',
    );
  }
  if (pattern.includes('\\')) {
    throw new OwnershipRuleError('Use forward slashes in a path pattern, even for a Windows repo.');
  }

  const segments = pattern.split('/');
  if (segments.filter(Boolean).length > MAX_PATTERN_SEGMENTS) {
    throw new OwnershipRuleError(
      `That path pattern has more than ${MAX_PATTERN_SEGMENTS} segments. Match a directory with ** instead of spelling out every level.`,
    );
  }
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new OwnershipRuleError(
      '"." and ".." have no meaning in a test path pattern — write the path as it appears in the repository.',
    );
  }

  return pattern;
}

/**
 * One path segment as a regex fragment.
 *
 * A run of `*` collapses to one `[^/]*`: gitignore reads `a**b` as `a*b`, and
 * two adjacent `[^/]*` in the compiled regex is a quadratic backtrack for no
 * expressive gain. Whole-segment `**` never reaches here — the compiler handles
 * it, because it is the one token that may cross a slash.
 */
function escapeSegment(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (char === '*') {
      while (segment[i + 1] === '*') i += 1;
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/**
 * Compile a CODEOWNERS pattern to an anchored regex.
 *
 *   tests/checkout/**   everything under that directory
 *   tests/**\/*.spec.ts  every spec at any depth below tests/
 *   *.visual.ts         that suffix anywhere in the repo
 *   /playwright.config.ts   only at the root
 *   e2e/                the directory e2e wherever it appears
 *
 * The anchoring rule is gitignore's and is the one people get wrong: a pattern
 * containing a slash anywhere (other than a trailing one) is matched from the
 * repository root, and a pattern without one matches at any depth. `*.spec.ts`
 * therefore matches `tests/a/b.spec.ts`, while `tests/*.spec.ts` matches only a
 * spec directly inside `tests/`.
 */
function compilePattern(pattern: string): RegExp {
  let body = pattern;

  let anchored = false;
  if (body.startsWith('/')) {
    anchored = true;
    body = body.replace(/^\/+/, '');
  }

  let directory = false;
  if (body.endsWith('/')) {
    directory = true;
    body = body.replace(/\/+$/, '');
  }

  if (!body) {
    throw new OwnershipRuleError('"/" is not a path pattern — name a directory or a file.');
  }
  if (body.includes('/')) anchored = true;

  const segments = body.split('/');
  let source = '';

  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;

    if (segment === '**') {
      // Crossing zero or more directories. As the final segment it must still
      // match something, so `tests/**` covers everything inside `tests/` but not
      // the bare directory entry itself.
      source += last ? '(?:[^/]+/)*[^/]+' : '(?:[^/]+/)*';
      return;
    }
    if (!segment) {
      throw new OwnershipRuleError(
        `"${pattern}" has an empty path segment — remove the doubled slash.`,
      );
    }

    source += escapeSegment(segment);
    if (!last) source += '/';
  });

  // A trailing slash means "this directory and everything in it".
  if (directory) source += '/.*';

  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`);
}

/**
 * Compiled patterns, memoised.
 *
 * Resolving one run means every rule tried against every failing test — a
 * hundred tests against thirty rules is three thousand matches, and recompiling
 * a regex for each is the difference between free and noticeable. Cleared
 * wholesale at the ceiling rather than evicted cleverly: it is a cache, and the
 * next lookup rebuilds what it needs.
 */
const PATTERN_CACHE = new Map<string, RegExp>();
const PATTERN_CACHE_LIMIT = 500;

function compiled(pattern: string): RegExp {
  const hit = PATTERN_CACHE.get(pattern);
  if (hit) return hit;

  const regex = compilePattern(normalisePattern(pattern));
  if (PATTERN_CACHE.size >= PATTERN_CACHE_LIMIT) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(pattern, regex);
  return regex;
}

/**
 * A test's path as the patterns expect it: forward slashes, no leading `./` or
 * `/`, no doubled separators. Case is preserved, because git paths are
 * case-sensitive and a rule that matched `Checkout/` but not `checkout/` is a
 * bug the repo would already have.
 */
export function normaliseTestPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/** Does `filePath` match `pattern`? Throws if the pattern is not valid. */
export function matchesPath(pattern: string, filePath: string): boolean {
  return compiled(pattern).test(normaliseTestPath(filePath));
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** How specifically a human pointed at the thing. Higher wins. */
const SUBJECT_RANK: Record<OwnershipSubject, number> = {
  TEST: 3,
  SUITE: 2,
  FEATURE: 1,
  PATH: 0,
};

function ownerOf(rule: OwnershipRuleInput): OwnerRef | null {
  if (rule.ownerUserId && rule.ownerTeamId) return null;
  if (rule.ownerUserId) return { kind: 'USER', userId: rule.ownerUserId };
  if (rule.ownerTeamId) return { kind: 'TEAM', teamId: rule.ownerTeamId };
  return null;
}

function subjectOf(rule: OwnershipRuleInput): OwnershipSubject | null {
  const set = [rule.testId, rule.suiteId, rule.feature, rule.pathPattern].filter(Boolean);
  if (set.length !== 1) return null;
  if (rule.testId) return 'TEST';
  if (rule.suiteId) return 'SUITE';
  if (rule.feature) return 'FEATURE';
  return 'PATH';
}

function sameFeature(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Every rule that matches this test, strongest first.
 *
 * Nothing here throws. A row that cannot be evaluated — a subject that is not
 * exactly one thing, an owner that is not exactly one person, a pattern that no
 * longer compiles — lands in `skipped` with a reason and the resolution
 * continues. Rules are data, and one bad row must not take out the routing for
 * every other test in the project, nor 500 the page that would let someone fix
 * it.
 */
export function resolveOwnership(
  test: OwnableTest,
  rules: OwnershipRuleInput[],
): OwnershipResolution {
  const matched: OwnershipMatch[] = [];
  const skipped: Array<{ ruleId: string; reason: string }> = [];

  for (const rule of rules) {
    const subject = subjectOf(rule);
    if (!subject) {
      skipped.push({
        ruleId: rule.id,
        reason:
          'This rule does not name exactly one of a test, a suite, a feature or a path pattern.',
      });
      continue;
    }

    const owner = ownerOf(rule);
    if (!owner) {
      skipped.push({
        ruleId: rule.id,
        reason: 'This rule does not name exactly one owner — set either a user or a team.',
      });
      continue;
    }

    let hit = false;
    let reason = '';

    if (subject === 'TEST') {
      hit = rule.testId === test.id;
      reason = 'Assigned to this test directly.';
    } else if (subject === 'SUITE') {
      hit = Boolean(test.suiteId) && rule.suiteId === test.suiteId;
      reason = 'Assigned to the suite this test belongs to.';
    } else if (subject === 'FEATURE') {
      hit = sameFeature(rule.feature, test.feature);
      reason = `Assigned to the "${rule.feature}" feature.`;
    } else {
      const path = normaliseTestPath(test.filePath);
      try {
        /*
         * An item with NO FILE has no path for a pattern to match, and the
         * pattern must not be allowed to match it anyway. `*` compiles to
         * `[^/]*`, which matches the empty string — so without this guard the
         * commonest CODEOWNERS line there is would own every surface the crawl
         * found and the source analysis never declared (`ownableSurface`
         * fabricates `filePath: ''` for exactly those), on the strength of a
         * path that does not exist. The reason sentence gave it away: it read
         * " matches *." with nothing in front of the verb.
         *
         * A gap attributed to the wrong team is worse than one attributed to
         * nobody — the wrong team closes the ticket. The pattern is still
         * COMPILED here, so a rule that can no longer be evaluated is still
         * reported as unusable rather than quietly skipped.
         */
        const matches = matchesPath(rule.pathPattern!, test.filePath);
        hit = path !== '' && matches;
      } catch (err) {
        skipped.push({
          ruleId: rule.id,
          reason:
            err instanceof OwnershipRuleError
              ? err.message
              : 'This path pattern could not be evaluated.',
        });
        continue;
      }
      reason = `${path} matches ${rule.pathPattern}.`;
    }

    if (hit) matched.push({ ruleId: rule.id, subject, owner, reason });
  }

  /*
   * Strongest subject first, then the LAST rule wins — CODEOWNERS' own rule,
   * which is why `position` is stored at all. The id breaks a tie so two rules
   * written at the same position resolve the same way on every request; a
   * resolver that returns a different owner on a refresh is one nobody can
   * debug.
   */
  const position = new Map(rules.map((rule) => [rule.id, rule.position]));
  const at = (match: OwnershipMatch): number => position.get(match.ruleId) ?? 0;

  matched.sort(
    (a, b) =>
      SUBJECT_RANK[b.subject] - SUBJECT_RANK[a.subject] ||
      at(b) - at(a) ||
      b.ruleId.localeCompare(a.ruleId),
  );

  return { owner: matched[0] ?? null, matched, skipped };
}

/** `resolveOwnership` for a list — the shape the digest and the run page want. */
export function resolveOwnershipFor(
  tests: OwnableTest[],
  rules: OwnershipRuleInput[],
): Map<string, OwnershipResolution> {
  const byTest = new Map<string, OwnershipResolution>();
  for (const test of tests) byTest.set(test.id, resolveOwnership(test, rules));
  return byTest;
}

// ─── Writing a rule ──────────────────────────────────────────────────────────

export interface OwnershipRuleDraft {
  pathPattern?: unknown;
  testId?: unknown;
  suiteId?: unknown;
  feature?: unknown;
  ownerUserId?: unknown;
  ownerTeamId?: unknown;
}

export interface NormalisedOwnershipRule {
  subject: OwnershipSubject;
  pathPattern: string | null;
  testId: string | null;
  suiteId: string | null;
  feature: string | null;
  owner: OwnerRef;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Turn what a caller sent into a row, or throw a sentence naming the fix.
 *
 * The two "exactly one" checks are the whole function. A rule with two subjects
 * is ambiguous about what it covers and a rule with two owners is ambiguous
 * about who hears — and an ambiguous routing rule does not fail, it just
 * quietly routes to one of them, which is how a team stops trusting the feature.
 */
export function normaliseRuleDraft(draft: OwnershipRuleDraft): NormalisedOwnershipRule {
  const pathPattern = text(draft.pathPattern);
  const testId = text(draft.testId);
  const suiteId = text(draft.suiteId);
  const feature = text(draft.feature);

  const subjects = [
    ['pathPattern', pathPattern],
    ['testId', testId],
    ['suiteId', suiteId],
    ['feature', feature],
  ].filter(([, value]) => value) as Array<[string, string]>;

  if (subjects.length === 0) {
    throw new OwnershipRuleError(
      'Say what this rule covers: one of pathPattern, testId, suiteId or feature.',
    );
  }
  if (subjects.length > 1) {
    throw new OwnershipRuleError(
      `A rule covers one thing, and this one names ${subjects.map(([key]) => key).join(' and ')}. Write one rule for each.`,
    );
  }

  const ownerUserId = text(draft.ownerUserId);
  const ownerTeamId = text(draft.ownerTeamId);
  if (ownerUserId && ownerTeamId) {
    throw new OwnershipRuleError(
      'A rule routes to one owner. Set ownerUserId or ownerTeamId, not both.',
    );
  }
  if (!ownerUserId && !ownerTeamId) {
    throw new OwnershipRuleError('Set ownerUserId or ownerTeamId — a rule with no owner routes nowhere.');
  }

  const owner: OwnerRef = ownerUserId
    ? { kind: 'USER', userId: ownerUserId }
    : { kind: 'TEAM', teamId: ownerTeamId! };

  if (pathPattern) {
    const normalised = normalisePattern(pathPattern);
    // Compile now so an unusable pattern is refused at write time, where the
    // person who typed it is still looking at it — rather than at read time,
    // where it degrades to "this test has no owner".
    compilePattern(normalised);
    return { subject: 'PATH', pathPattern: normalised, testId: null, suiteId: null, feature: null, owner };
  }

  if (testId) {
    return { subject: 'TEST', pathPattern: null, testId, suiteId: null, feature: null, owner };
  }
  if (suiteId) {
    return { subject: 'SUITE', pathPattern: null, testId: null, suiteId, feature: null, owner };
  }
  return { subject: 'FEATURE', pathPattern: null, testId: null, suiteId: null, feature, owner };
}

// ─── Assignment ──────────────────────────────────────────────────────────────

/**
 * Why a thing has no owner — and the point of the whole section.
 *
 * `resolveOwnership` returns `owner: null` for four situations that a reader
 * must not confuse, because only one of them is benign:
 *
 *   NO_RULES        nobody has written any rules. Expected, and not a problem
 *                   to nag about — ownership is opt-in (see the header).
 *   NO_MATCH        rules exist and none cover this. Someone meant to route
 *                   this area and did not.
 *   RULES_UNUSABLE  a rule that could have matched could not be evaluated, so
 *                   routing has silently STOPPED. This is the dangerous one: it
 *                   is indistinguishable from NO_MATCH from the outside, and it
 *                   means a team that believes it is being paged is not.
 *
 * A nullable `assigneeUserId` column alone cannot tell those apart, which is
 * exactly how an unowned failure ends up LOOKING owned — the worse of the two
 * failures, because nobody goes looking for it.
 *
 * SPLIT is the fifth value and belongs only to a thing that covers MANY
 * subjects: one cause spanning forty tests owned by three different teams has
 * no single true assignee, and picking one would route the whole ticket to
 * somebody who owns a third of it. It is never written on a single verdict.
 *
 * `OWNERSHIP_STATES`, `ISSUE_OWNER_STATES`, `ISSUE_SUBJECTS` and
 * `OwnerAssignment` are imported from `@qaai/shared` at the top of this file —
 * they used to be declared here, which meant the web app could not name the
 * state it was rendering.
 */

/**
 * Who owns this, and if nobody, which kind of nobody.
 *
 * A thin wrapper over `resolveOwnership` on purpose: the matching is the part
 * worth testing exhaustively and it stays above, untouched. What this adds is
 * the refusal to return a bare null.
 */
export function assignOwner(test: OwnableTest, rules: OwnershipRuleInput[]): OwnerAssignment {
  const resolution = resolveOwnership(test, rules);
  const unusable = resolution.skipped;

  if (resolution.owner) {
    return {
      state: 'OWNED',
      owner: resolution.owner.owner,
      ruleId: resolution.owner.ruleId,
      note:
        unusable.length > 0
          ? `${resolution.owner.reason} (${unusable.length} other rule(s) could not be evaluated: ${unusable[0]!.reason})`
          : resolution.owner.reason,
      unusable,
    };
  }

  const where = normaliseTestPath(test.filePath) || 'this item';

  if (rules.length === 0) {
    return {
      state: 'NO_RULES',
      owner: null,
      ruleId: null,
      note: 'Nobody has written an ownership rule for this project, so QAAI does not claim to know who owns this.',
      unusable,
    };
  }

  if (unusable.length > 0) {
    return {
      state: 'RULES_UNUSABLE',
      owner: null,
      ruleId: null,
      // Named as loudly as the sentence allows: this is the case where a team
      // believes it is being routed to and is not.
      note: `None of the ${rules.length} ownership rules match ${where}, and ${unusable.length} could not be evaluated at all — routing may have stopped without anyone noticing. First problem: ${unusable[0]!.reason}`,
      unusable,
    };
  }

  return {
    state: 'NO_MATCH',
    owner: null,
    ruleId: null,
    note: `None of the ${rules.length} ownership rules match ${where}. It is unowned until one does.`,
    unusable,
  };
}

/**
 * The exact column set a `TriageVerdict` assignment writes.
 *
 * Exists so that two call sites — the notify processor, which routes a finished
 * run, and the filing endpoint, which routes whatever it is about to file —
 * cannot disagree about what "assigned" means on a row. They were always going
 * to drift: one of them would remember to clear the opposite id and the other
 * would not, and a verdict holding both a user and a team is a routing hole
 * that looks like a routing rule.
 */
export interface VerdictOwnerColumns {
  assigneeUserId: string | null;
  assigneeTeamId: string | null;
  ownerRuleId: string | null;
  ownerState: OwnershipState;
  ownerNote: string;
  assignedAt: Date;
}

export function verdictOwnerColumns(
  assignment: OwnerAssignment,
  now: Date = new Date(),
): VerdictOwnerColumns {
  const owner = assignment.owner;
  return {
    // Both written on every assignment, never only the one that applies: a
    // re-route from a user to a team has to CLEAR the user, or the row keeps
    // paging whoever used to own it.
    assigneeUserId: owner?.kind === 'USER' ? owner.userId : null,
    assigneeTeamId: owner?.kind === 'TEAM' ? owner.teamId : null,
    ownerRuleId: assignment.ruleId,
    ownerState: assignment.state,
    // Truncated at the width a message column is worth: the note is a sentence
    // for a human, and a rule list that produced a 4KB reason is still readable
    // at this length.
    ownerNote: assignment.note.slice(0, 1_000),
    assignedAt: now,
  };
}

/**
 * One owner for a set of subjects, or an honest refusal.
 *
 * A cause that spans forty tests is one ticket, and that ticket needs one
 * assignee — but only if one is TRUE. Unanimity among the owned members is the
 * only condition under which it is, so anything else returns SPLIT and the
 * ticket says so rather than naming the owner of the largest share, which is a
 * guess dressed as a routing decision. Members with no owner do not veto
 * unanimity: "the payments team owns eight of these and nobody owns the other
 * two" still routes to payments, with the gap stated.
 */
export function consensusOwner(assignments: readonly OwnerAssignment[]): {
  state: IssueOwnerState;
  owner: OwnerRef | null;
  note: string;
} {
  const owned = assignments.filter((a) => a.owner !== null);
  const distinct = new Map(owned.map((a) => [ownerKey(a.owner!), a.owner!]));

  if (distinct.size === 1) {
    const owner = [...distinct.values()][0]!;
    const unowned = assignments.length - owned.length;
    return {
      state: 'OWNED',
      owner,
      note:
        unowned > 0
          ? `${owned.length} of ${assignments.length} are owned, and all of them by the same owner. The other ${unowned} are unowned.`
          : `All ${assignments.length} are owned by the same owner.`,
    };
  }

  if (distinct.size > 1) {
    return {
      state: 'SPLIT',
      owner: null,
      note: `These are owned by ${distinct.size} different owners, so there is no single assignee this ticket could truthfully carry.`,
    };
  }

  // Nobody owns any of them: report the worst of the reasons, since
  // RULES_UNUSABLE is the one that needs acting on.
  const worst =
    assignments.find((a) => a.state === 'RULES_UNUSABLE') ??
    assignments.find((a) => a.state === 'NO_MATCH') ??
    assignments[0];
  return {
    state: worst?.state ?? 'NO_RULES',
    owner: null,
    note: worst?.note ?? 'Nothing here has an owner.',
  };
}

/**
 * A surface item, in the shape the resolver already takes.
 *
 * An untested route is routed by the same rules as a failing test, and must be:
 * a team that wrote `app/checkout/** → @payments` has said who owns checkout,
 * and having to say it twice — once for failures, once for gaps — is how the
 * two answers end up different. Only PATH and FEATURE rules can match, because
 * a surface has no test id and no suite; `key` stands in as the id so the
 * resolution map can be keyed by it, and it can never collide with a TEST rule
 * because a surface key is `KIND:identity` and a test id is a cuid.
 *
 * `file` is null for an item the crawl found and the source analysis never
 * declared. That is not an error — it is a surface whose ownership CANNOT be
 * resolved by path, and `assignOwner` will say NO_MATCH rather than inventing
 * one.
 */
export function ownableSurface(item: {
  key: string;
  file: string | null;
  feature: string | null;
}): OwnableTest {
  return {
    id: item.key,
    filePath: item.file ?? '',
    suiteId: null,
    feature: item.feature,
  };
}

// ─── Naming an owner ─────────────────────────────────────────────────────────

/** Rows needed to print an owner. The shape both `User` and `Team` selects give. */
export interface OwnerDirectory {
  users: ReadonlyMap<string, { name?: string | null; email?: string | null }>;
  teams: ReadonlyMap<string, { slug?: string | null }>;
}

/**
 * What to call this owner on screen.
 *
 * One spelling, in one place, because there are already two: the digest prints
 * `@slug` for a team and `name || email` for a user, and so does
 * GET /team/ownership/resolve — and a team that is `@payments` in the digest
 * and `Payments` in a ticket reads as two different owners to the person
 * skimming both.
 *
 * The deleted-row fallbacks should be unreachable (deleting a user or a team
 * cascades its rules away) and say something true anyway, because a label that
 * renders as `undefined` is how a screen loses trust over a row nobody can
 * explain.
 */
export function ownerLabel(owner: OwnerRef, directory: OwnerDirectory): string {
  if (owner.kind === 'USER') {
    const user = directory.users.get(owner.userId);
    return user?.name || user?.email || 'a deleted user';
  }
  const team = directory.teams.get(owner.teamId);
  return team?.slug ? `@${team.slug}` : 'a deleted team';
}


// ─── Provenance: HOW the owner was decided ───────────────────────────────────

/*
 * THE DEFECT THIS SECTION CLOSES, verbatim from the round's register: "A
 * FAILURE IS NEVER ASSIGNED. Ownership resolves for the digest and for the
 * triage list, and the verdict itself goes to a shared queue nobody owns."
 *
 * Everything above answers WHO. Nothing above answers HOW WELL WE KNOW, and the
 * two halves of this file's job are not the same question: `assignOwner` returns
 * the same shape for "Dana assigned this test to herself" and "somebody once
 * wrote `tests/**` and this file is under tests/", so every surface that renders
 * an owner renders both identically. A digest that pages the payments team on
 * the strength of a catch-all glob teaches the payments team to filter the
 * digest.
 *
 * The vocabulary is `packages/shared/src/ownership.ts` — OWNER_PROVENANCES,
 * their strengths, `mayPage`, `isHumanSetProvenance`, `resolutionIsCoherent`.
 * This file supplies the half that vocabulary cannot: which provenance a MATCH
 * earns, given what matched and where the rule came from.
 *
 * IT IS IMPORTED FROM `@qaai/shared`, which now re-exports `./ownership`. It
 * used to arrive by a four-dot relative path because the barrel did not, and
 * that path is gone from this file. What is NOT an option is a second copy of
 * the strength table in this package: `apps/api/scripts/check-enums.ts` diffs
 * the shared file against `schema.prisma`, so there is exactly one declaration
 * of `OwnerProvenance` and it is not this one.
 */

/**
 * Which provenance a matching RULE earns, by what the rule points at.
 *
 * A `satisfies Record<OwnershipSubject, OwnerProvenance>`, so a fifth subject
 * cannot be added to this file without somebody deciding how much an answer
 * from it is worth. The four values are the four `RULE_*` provenances and the
 * mapping is one-to-one on purpose: the shared file orders its provenances
 * strongest-first in exactly the order `SUBJECT_RANK` above orders subjects, so
 * the two tables cannot disagree about which of two matches is better. The
 * run-time parity test is in ownership.test.ts.
 */
export const PROVENANCE_BY_SUBJECT = {
  TEST: 'RULE_TEST',
  SUITE: 'RULE_SUITE',
  FEATURE: 'RULE_FEATURE',
  PATH: 'RULE_PATH',
} as const satisfies Record<OwnershipSubject, OwnerProvenance>;

/**
 * Where a rule came from.
 *
 *   QAAI        a person typed it into this product, meaning to route QAAI's
 *               failures. DECLARED.
 *   CODEOWNERS  it arrived in bulk from a repository's CODEOWNERS file.
 *               Identical mechanism, different consent: nobody wrote it with
 *               QAAI in mind, and an import brings a thousand at once. The
 *               shared table makes it WEAK for that reason alone.
 *
 * IT IS NOW A COLUMN. `OwnershipRule.source` holds `OWNERSHIP_RULE_SOURCES`
 * ('MANUAL' | 'CODEOWNERS') as TEXT, so this is read off the row rather than
 * supplied by a caller that happens to remember — which is what
 * {@link codeownersRuleIdsOf} does, in one place, for all three routing
 * surfaces.
 *
 * TWO LISTS WITH THE SAME TWO MEANINGS, and the duplication is deliberate
 * rather than overlooked. `RULE_ORIGINS` is this module's in-memory vocabulary
 * for "where did the rule that matched come from"; `OWNERSHIP_RULE_SOURCES` is
 * the DOMAIN OF A TEXT COLUMN, and a stored domain and an in-memory vocabulary
 * drift for different reasons — the first needs a migration to change, the
 * second does not. {@link RULE_ORIGIN_BY_SOURCE} maps one onto the other as a
 * compiler-enforced record, so a third member of either list cannot arrive
 * without somebody saying what it means in the other.
 */
export const RULE_ORIGINS = ['QAAI', 'CODEOWNERS'] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

/**
 * The stored source → this module's origin.
 *
 * `satisfies Record<OwnershipRuleSource, RuleOrigin>`, so a third stored source
 * is a compile error here rather than a row that silently routes as if a human
 * had typed it.
 */
export const RULE_ORIGIN_BY_SOURCE = {
  MANUAL: 'QAAI',
  CODEOWNERS: 'CODEOWNERS',
} as const satisfies Record<OwnershipRuleSource, RuleOrigin>;

/**
 * The rule ids `routeOwner` must treat as bulk-imported — ONE reader for the
 * column, for all three routing surfaces.
 *
 * ── WHY A SET AND NOT A FIELD ON THE MATCH ──────────────────────────────────
 *
 * `routeOwner` already takes `codeownersRuleIds` and already downgrades a
 * winning match to CODEOWNERS_IMPORT from it. The gap was never the predicate,
 * it was that nothing in production ever built the set: the digest, the notify
 * processor and the filing endpoint each passed nothing, so every imported glob
 * claimed the strength of a rule somebody typed. This is the feeder.
 *
 * ── IT ASKS "IS IT CODEOWNERS", NEVER "IS IT NOT MANUAL" ────────────────────
 *
 * A row whose `source` is null, absent, or a spelling this build has never
 * heard of is NOT in the set. Null is MANUAL (see `OwnershipRuleInput.source`)
 * and an unrecognised spelling is unknown — and treating unknown as imported
 * would silently stop a real assignment paging anybody, which is the failure
 * mode `RULES_UNUSABLE` exists to make visible rather than one to introduce
 * quietly.
 */
export function codeownersRuleIdsOf(
  rules: readonly Pick<OwnershipRuleInput, 'id' | 'source'>[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.source === CODEOWNERS_SOURCE) ids.add(rule.id);
  }
  return ids;
}

/**
 * THE ONE SPELLING OF THE STORED VALUE, and the compiler is the validator.
 *
 * `OwnershipRule.source` is TEXT with its domain at the producer
 * (`OWNERSHIP_RULE_SOURCES`), which means there is NO zod schema and NO
 * database enum between a typo and a stored row: `source: 'CODEOWNER'` would
 * insert, and `codeownersRuleIdsOf` would then never match it, so every
 * imported rule would silently page. The annotation on this constant is the
 * whole guard, and the importer and the reader share it so the two cannot
 * disagree about the spelling — which is lesson H in the one form available for
 * a TEXT column: a test over the producer ends at the validator the write path
 * runs, and here that validator is `tsc`.
 */
export const CODEOWNERS_SOURCE: OwnershipRuleSource = 'CODEOWNERS';

/**
 * What a surface may SAY about an owner.
 *
 *   ASSIGNED   a person decided this, or wrote a rule meaning to cover it.
 *              Page on it, put a name on the ticket, show it as an assignment.
 *   SUGGESTED  a bulk-imported glob, a git-blame guess or an inherited owner
 *              landed on it. Show it as a suggestion. Presenting one of these as
 *              an assignment is how a team learns to ignore assignments.
 *   UNOWNED    nobody. A reportable value, not an error — see
 *              `unownedFinding` in the shared file.
 */
export const ASSIGNMENT_KINDS = ['ASSIGNED', 'SUGGESTED', 'UNOWNED'] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/**
 * Strength → what a surface may say. Compiler-enforced over every strength, and
 * DERIVED rather than re-decided: the shared file already answered "may this
 * page somebody" (`mayPage`), and a second threshold here would be a number
 * somebody tunes until a catch-all glob pages again.
 *
 * `strongerResolution` and this table therefore agree by construction. The
 * run-time check that they do is in ownership.test.ts.
 */
export const KIND_BY_STRENGTH = {
  HUMAN: 'ASSIGNED',
  DECLARED: 'ASSIGNED',
  WEAK: 'SUGGESTED',
  NONE: 'UNOWNED',
} as const satisfies Record<OwnerStrength, AssignmentKind>;

/**
 * An assignment with its provenance, and whether a surface may present it as an
 * assignment at all.
 *
 * TWO FIELDS, NOT ONE, and deliberately so. `provenance` says how the owner was
 * decided; `kind` says what a reader may be told. They are computed from each
 * other here, once — but a caller that had to derive "is this showable as an
 * assignment" from a nine-member enum at every render site would get it right in
 * the digest and wrong in the ticket, which is the `houseStyle.planned` defect
 * (one field meaning two things in two places) arriving by the other door.
 */
export interface OwnerRouting extends OwnerAssignment {
  readonly provenance: OwnerProvenance;
  readonly kind: AssignmentKind;
  /** True only for EXPLICIT_ASSIGNMENT. The predicate `applySuppression` asks. */
  readonly humanSet: boolean;
  /** May this answer wake somebody up? `mayPage` in the shared file. */
  readonly pageable: boolean;
}

/** An owner a person set on this exact thing. The only HUMAN provenance. */
export interface ExplicitAssignment {
  readonly owner: OwnerRef;
  /** Who set it, for the note. Never a token, never an email. */
  readonly byLabel?: string | null;
}

/**
 * What the caller knows beyond the rule table.
 *
 * Every field is OPTIONAL and the default of each is the weakest honest answer,
 * so a caller that knows nothing extra gets exactly what `assignOwner` already
 * returned plus a provenance for it. That is the point: this is not a second
 * resolver, it is the first one with its strength written down.
 */
export interface RoutingContext {
  /** A person assigned this exact subject. Beats every rule. */
  readonly explicit?: ExplicitAssignment | null;
  /** Rule ids that arrived from a repository's CODEOWNERS file. */
  readonly codeownersRuleIds?: ReadonlySet<string>;
  /**
   * The last human to edit the test, from git blame — a HEURISTIC and the
   * weakest answer this function will give. Used ONLY when no rule matched, and
   * never to override one: somebody who fixed a typo in a test a year ago does
   * not own it, and overriding a declared rule with them is how a digest pages
   * the wrong person.
   */
  readonly lastEditor?: { readonly userId: string } | null;
  /**
   * An owner inherited from a parent — a suite's owner applied to a test with
   * none of its own. A convenience, not a decision, so it sits between a rule
   * and git blame.
   */
  readonly inherited?: { readonly owner: OwnerRef; readonly fromLabel: string } | null;
}

/*
 * Strongest first — the shared declaration order, aliased rather than copied so
 * a reordering there cannot leave a stale precedence table here. `indexOf` on a
 * nine-member array is cheaper than the Map that would avoid it, and this runs
 * once per ticket rather than once per member.
 */
const PROVENANCE_RANK: readonly OwnerProvenance[] = OWNER_PROVENANCES;

/** The provenance a winning match earns, given where its rule came from. */
export function provenanceOfMatch(
  match: Pick<OwnershipMatch, 'ruleId' | 'subject'>,
  codeownersRuleIds?: ReadonlySet<string>,
): OwnerProvenance {
  return codeownersRuleIds?.has(match.ruleId)
    ? 'CODEOWNERS_IMPORT'
    : PROVENANCE_BY_SUBJECT[match.subject];
}

function routing(assignment: OwnerAssignment, provenance: OwnerProvenance): OwnerRouting {
  /*
   * The coherence check is the shared file's, run on every answer this function
   * produces rather than at the write site. The two illegal pairs — an owner
   * with provenance NONE, and no owner with a provenance that is not NONE — are
   * both easy to produce here by accident, and either one stored on a verdict
   * reads as a routing decision that was never made. It returns a PATH and
   * never a message built out of the value, which is why the thrown sentence
   * below names the field and not its contents.
   */
  const coherent = resolutionIsCoherent({
    state: assignment.state,
    owner: assignment.owner,
    provenance,
  });
  if (!coherent.coherent) {
    throw new OwnershipRuleError(
      `An ownership answer was composed with an incoherent "${coherent.path}". This is a bug in QAAI's routing, not in your rules.`,
    );
  }
  const strength = OWNER_PROVENANCE_STRENGTH[provenance];
  return {
    ...assignment,
    provenance,
    kind: KIND_BY_STRENGTH[strength],
    humanSet: isHumanSetProvenance(provenance),
    pageable: mayPage(provenance),
  };
}

/**
 * Who owns this, which kind of nobody if nobody, and HOW the answer was reached.
 *
 * `assignOwner` is left exactly as it was and is called here: the matching is
 * the part worth testing exhaustively and it does not change. What this adds is
 * the strength of the answer and the three fallbacks that only make sense once
 * strength exists — an explicit assignment that must beat every glob, and two
 * WEAK guesses that may only speak when no rule did.
 *
 * ORDER, and why each step is where it is:
 *
 *   1. EXPLICIT    a person pointed at this thing. The only HUMAN answer, and
 *                  the only one a suppression may be hung on.
 *   2. A RULE      whatever `assignOwner` found, with its provenance taken from
 *                  the subject it matched and downgraded to CODEOWNERS_IMPORT
 *                  when the rule was bulk-imported.
 *   3. INHERITED   a parent's owner. WEAK.
 *   4. LAST_EDITOR git blame. WEAK, and last.
 *
 * A fallback NEVER overrides a rule and never changes `unusable`: a project can
 * route this test by blame and still have a broken rule that has stopped
 * routing twenty others, and swallowing that is the failure mode this whole
 * file is arranged against. Both fallbacks keep `state: 'OWNED'` because an
 * owner WAS produced — and `kind: 'SUGGESTED'` is what stops a surface
 * presenting it as an assignment.
 */
export function routeOwner(
  test: OwnableTest,
  rules: OwnershipRuleInput[],
  context: RoutingContext = {},
): OwnerRouting {
  const matched = assignOwner(test, rules);

  if (context.explicit) {
    const by = context.explicit.byLabel ? ` by ${context.explicit.byLabel}` : '';
    return routing(
      {
        state: 'OWNED',
        owner: context.explicit.owner,
        ruleId: null,
        note:
          matched.unusable.length > 0
            ? `Assigned directly${by}. (${matched.unusable.length} ownership rule(s) could not be evaluated: ${matched.unusable[0]!.reason})`
            : `Assigned directly${by}.`,
        unusable: matched.unusable,
      },
      'EXPLICIT_ASSIGNMENT',
    );
  }

  if (matched.owner !== null) {
    const winner = resolveOwnership(test, rules).owner;
    /*
     * `winner` cannot be null when `matched.owner` is not — they come from the
     * same resolution — but the compiler does not know that, and a `!` here
     * would be the kind of assertion that outlives the invariant. Falling back
     * to RULE_PATH, the weakest of the four rule provenances, is the honest
     * answer if it ever did: understating a real rule is recoverable, and
     * overstating one pages a team that did not agree to be paged.
     */
    return routing(matched, winner ? provenanceOfMatch(winner, context.codeownersRuleIds) : 'RULE_PATH');
  }

  if (context.inherited) {
    return routing(
      {
        state: 'OWNED',
        owner: context.inherited.owner,
        ruleId: null,
        note: `No rule covers this; the owner shown is inherited from ${context.inherited.fromLabel}. A suggestion, not an assignment.`,
        unusable: matched.unusable,
      },
      'INHERITED',
    );
  }

  if (context.lastEditor) {
    return routing(
      {
        state: 'OWNED',
        owner: { kind: 'USER', userId: context.lastEditor.userId },
        ruleId: null,
        note: `No rule covers this; the owner shown is the last person to edit the test. A suggestion, not an assignment — write an ownership rule to make it one.`,
        unusable: matched.unusable,
      },
      'LAST_EDITOR',
    );
  }

  return routing(matched, 'NONE');
}

/**
 * The provenance a MANY-SUBJECT answer may claim: the WEAKEST among the members
 * that have an owner.
 *
 * `consensusOwner` above decides whether one owner is true for a whole cause.
 * This decides how good that answer is, and the weakest-wins rule is the only
 * defensible one: a ticket for forty tests, thirty-nine of them assigned by
 * name and one by a bulk-imported glob, is a ticket whose claim to that owner is
 * only as strong as the glob. Taking the strongest would let one explicit
 * assignment launder thirty-nine guesses into an assignment nobody made.
 *
 * Members with no owner do not weaken it, for the same reason they do not veto
 * unanimity in `consensusOwner`: "the payments team owns eight of these and
 * nobody owns the other two" still routes to payments, with the gap stated.
 * When nothing is owned the answer is NONE / UNOWNED.
 */
export function consensusProvenance(routings: readonly OwnerRouting[]): {
  provenance: OwnerProvenance;
  kind: AssignmentKind;
} {
  const owned = routings.filter((routed) => routed.owner !== null);
  if (owned.length === 0) return { provenance: 'NONE', kind: 'UNOWNED' };
  const weakest = owned.reduce(
    (worst, routed) =>
      PROVENANCE_RANK.indexOf(routed.provenance) > PROVENANCE_RANK.indexOf(worst) ? routed.provenance : worst,
    owned[0]!.provenance,
  );
  return { provenance: weakest, kind: KIND_BY_STRENGTH[OWNER_PROVENANCE_STRENGTH[weakest]] };
}

/** `routeOwner` for a list — the shape the digest and the filing path want. */
export function routeOwnershipFor(
  tests: OwnableTest[],
  rules: OwnershipRuleInput[],
  context: (test: OwnableTest) => RoutingContext = () => ({}),
): Map<string, OwnerRouting> {
  const byTest = new Map<string, OwnerRouting>();
  for (const test of tests) byTest.set(test.id, routeOwner(test, rules, context(test)));
  return byTest;
}

/**
 * The routing as the shared `OwnerResolution` — the shape the web app and the
 * suppression path read.
 *
 * `subject` is an argument because the resolver cannot know it: the same test
 * row is the subject of a FAILURE when it is red and of a TEST when a
 * suppression is being hung on it, and a function that guessed would be a
 * second opinion about what is being owned.
 */
export function routingResolution(
  subject: OwnableSubject,
  routed: OwnerRouting,
): OwnerResolution {
  return {
    subject,
    state: routed.state,
    owner: routed.owner,
    provenance: routed.provenance,
    ruleId: routed.ruleId,
    note: routed.note,
    unusable: routed.unusable,
  };
}

/**
 * The verdict columns, INCLUDING `ownerProvenance`.
 *
 * ─── WHY THIS IS A SECOND FUNCTION AND NOT A CHANGED ONE ────────────────────
 *
 * `TriageVerdict.ownerProvenance` says in the schema that it is "written
 * together or not at all" with `ownerState`, and `verdictOwnerColumns` above
 * writes `ownerState` and cannot write a provenance — it is handed an
 * `OwnerAssignment`, which does not carry one. Making its `provenance` argument
 * required would have broken `apps/worker/src/processors/notify.ts`, which the
 * round that added this function did not own; making it optional would write
 * `ownerState` without `ownerProvenance` and contradict the column's own
 * documentation, which is one of the lies this product cannot afford.
 *
 * So the writer that CAN tell the truth is this function, over `OwnerRouting`.
 *
 * ─── THAT EDIT HAS NOW LANDED ───────────────────────────────────────────────
 *
 * `apps/worker/src/processors/notify.ts` writes through THIS function, so both
 * verdict writers — it and `apps/api/src/routes/issues.ts` — write the
 * provenance with the state. `verdictOwnerColumns` is NOT dead: it is the
 * implementation of the five columns this one extends, called on the line
 * below, and `ownership.test.ts` exercises it directly. It simply has no
 * remaining PRODUCTION caller of its own, which is the point — there is one
 * writer of a verdict's owner columns and it cannot omit the provenance.
 */
export interface VerdictRoutingColumns extends VerdictOwnerColumns {
  ownerProvenance: OwnerProvenance;
}

/**
 * THE OWNER LABEL A SURFACE MAY PRINT, given what the answer is worth.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `mayPage` has existed for a round and NOTHING ASKED IT. The digest printed
 * `— @payments` and the 3am chat alert printed `— @payments`, identically, for
 * an owner a person assigned and for an owner a glob landed on. No team has
 * actually been paged by a bulk-imported glob yet, and the only reason is that
 * `OwnershipRule.source` had no writer, so nothing could BE imported — the
 * CODEOWNERS import lands in this same round and removes that accident. A
 * digest that pages a team on the strength of a glob teaches that team to
 * filter the digest, and then the RULES_UNUSABLE line gets filtered with it.
 *
 * ── WHY THE PHRASING IS HERE AND NOT IN EACH RENDERER ───────────────────────
 *
 * Two surfaces print this — `ownerSuffix` in the digest and the failure line in
 * the chat alert — and the one thing worse than neither of them qualifying the
 * claim is one of them qualifying it and the other not: a reader who sees
 * "@payments" in the alert and "@payments (suggested, not paged)" in the digest
 * concludes the two disagree about who owns it. `ownerLabel` is shared for exactly this
 * reason and this is the same argument one step further on.
 *
 * It composes a STRING for a human out of two fields that stay separate in the
 * model — `OwnerRouting` keeps `owner`, `provenance`, `kind` and `pageable`
 * apart on purpose — so nothing here collapses two facts into one stored value.
 */
export function ownerClaimLabel(label: string, pageable: boolean): string {
  return pageable ? label : `${label} (suggested, not paged)`;
}

export function verdictRoutingColumns(
  routed: OwnerRouting,
  now: Date = new Date(),
): VerdictRoutingColumns {
  return {
    ...verdictOwnerColumns(routed, now),
    ownerProvenance: routed.provenance,
  };
}

// ─── Importing a repository's CODEOWNERS ─────────────────────────────────────

/**
 * One CODEOWNERS line, parsed.
 *
 * `owners` are the raw tokens — `@acme/payments`, `@dana`, `dana@acme.com` —
 * and are NOT resolved here. Resolution needs the org's users and teams, which
 * means Prisma, which this module deliberately does not have; and a parser that
 * silently dropped the tokens it could not resolve would turn "we could not
 * find this team" into "this directory has no owner", which is the one
 * confusion the whole ownership vocabulary exists to prevent.
 */
export interface CodeownersEntry {
  /** 1-based line number in the file, so a refusal can be pointed at. */
  readonly line: number;
  readonly pathPattern: string;
  readonly owners: readonly string[];
}

/** How many lines of a CODEOWNERS file are read. GitHub's own ceiling is 3MB. */
export const MAX_CODEOWNERS_LINES = 2_000;

/**
 * How many CHARACTERS of a CODEOWNERS upload are accepted at all.
 *
 * {@link MAX_CODEOWNERS_LINES} bounds the lines READ and reports what it did
 * not read; this bounds what the request may CARRY, which is a different job
 * and a refusal rather than a disclosure. A single 3MB line is two thousand
 * lines as far as the line cap is concerned, and `normalisePattern` would then
 * be handed a 3MB string.
 *
 * {@link MAX_CODEOWNERS_LINES} lines of {@link MAX_PATTERN_LENGTH} plus room
 * for the owner tokens on each. A real CODEOWNERS file is three orders of
 * magnitude under it.
 */
export const MAX_CODEOWNERS_CHARS = 600_000;

/**
 * One owner token out of a CODEOWNERS line, reduced to what QAAI can LOOK UP.
 *
 * ── WHY THIS IS A SHAPE AND NOT A RESOLUTION ────────────────────────────────
 *
 * Resolution needs the org's users, teams and memberships, which means Prisma,
 * which this module deliberately does not have. What is pure is the question
 * "what KIND of thing is this token claiming to be, and what is the one string
 * we would look it up by" — and keeping that here is what stops the import
 * endpoint inventing a second reading of `@acme/payments`.
 *
 * The three readings are GitHub's own:
 *
 *   `@acme/payments`  an org team. The SLUG is the part after the slash;
 *                     `acme` is the GitHub org and means nothing to QAAI.
 *   `@dana`           a user handle. QAAI stores no handles, so this is
 *                     looked up as a TEAM SLUG and nothing else — matching it
 *                     against a user by guessing an email would invent an
 *                     address.
 *   `dana@acme.com`   an email address. The one token that can name a user.
 *
 * `null` is "this is not an owner token at all", and the caller refuses the
 * LINE for it rather than importing the half that parsed.
 */
export type CodeownersOwnerToken =
  | { readonly kind: 'TEAM'; readonly slug: string }
  | { readonly kind: 'USER'; readonly email: string };

/** The token's shape, with no lookup and no guessing. */
export function codeownersOwnerToken(raw: string): CodeownersOwnerToken | null {
  const token = raw.trim();
  if (!token || token.length > 200) return null;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }

  if (token.startsWith('@')) {
    const body = token.slice(1);
    if (!body) return null;
    /*
     * `@acme/payments` → `payments`, `@dana` → `dana`. A token with TWO slashes
     * is not a shape GitHub produces, so it is refused rather than read as its
     * last segment: reading it would make `@acme/payments/oncall` import as the
     * `oncall` team, which is an owner nobody named.
     */
    const parts = body.split('/');
    if (parts.length > 2) return null;
    const slug = (parts.length === 2 ? parts[1] : parts[0]) ?? '';
    if (!slug || slug.includes('@')) return null;
    return { kind: 'TEAM', slug };
  }

  /*
   * An email, and only one `@` — `a@b@c` is not an address and is refused
   * rather than reduced to one. The real check is the LOOKUP: a token that is
   * not a user QAAI already knows about never becomes a rule, so the shape test
   * here only has to be narrow enough to pick the right lookup.
   */
  const at = token.indexOf('@');
  if (at <= 0 || token.indexOf('@', at + 1) !== -1) return null;
  if (at === token.length - 1 || !token.slice(at + 1).includes('.')) return null;
  return { kind: 'USER', email: token };
}

/**
 * Parse a CODEOWNERS file into rule drafts, deterministically and with no model
 * and no network.
 *
 * ─── WHAT IS REFUSED, AND WHY NOTHING IS GUESSED ────────────────────────────
 *
 * A line this dialect cannot express is SKIPPED WITH A REASON and counted. The
 * alternative — reinterpreting it as the nearest pattern this product does
 * support — routes failures to the wrong team while looking correct, which is
 * the failure `normalisePattern` already refuses loudly for a hand-typed
 * pattern. An import is the one place where a thousand of them arrive at once,
 * so it is the last place to start guessing.
 *
 * Sections (`[Section name]`, GitHub's CODEOWNERS-with-sections syntax) are
 * skipped rather than parsed: a section carries approval-count and optional-ness
 * semantics that have no meaning here, and silently flattening them would route
 * an OPTIONAL reviewer's directory to them as an owner.
 *
 * THE LINE CAP IS REPORTED. `truncated` carries the number of lines that were
 * never read and why, because an import that silently stopped at 2,000 lines
 * would leave a project believing it had routed a directory it had not.
 */
export function parseCodeowners(text: string): {
  entries: CodeownersEntry[];
  skipped: Array<{ line: number; reason: string }>;
  truncated: { lines: number; reason: string } | null;
} {
  const all = text.split(/\r?\n/);
  const read = all.slice(0, MAX_CODEOWNERS_LINES);
  const entries: CodeownersEntry[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];

  read.forEach((raw, index) => {
    const line = index + 1;
    const stripped = raw.replace(/#.*$/, '').trim();
    if (!stripped) return;

    if (stripped.startsWith('[') || stripped.startsWith('^[')) {
      skipped.push({
        line,
        reason:
          'Section headers carry approval counts and optional reviewers, which have no meaning for failure routing. Write the patterns inside it as plain rules.',
      });
      return;
    }

    const fields = stripped.split(/\s+/);
    const pattern = fields[0];
    const owners = fields.slice(1).filter((field) => field.startsWith('@') || field.includes('@'));

    if (!pattern) return;
    if (owners.length === 0) {
      skipped.push({ line, reason: 'This line names a path and no owner, so it routes nowhere.' });
      return;
    }
    if (owners.length !== fields.length - 1) {
      skipped.push({
        line,
        reason:
          'Some tokens on this line are neither a @handle, a @org/team nor an email address. The line was not imported rather than importing the half of it that parsed.',
      });
      return;
    }

    try {
      // The SAME validator a hand-typed pattern goes through. An imported
      // pattern that would be refused in the UI must be refused here too, or
      // the import becomes a way to store rules the editor cannot show.
      entries.push({ line, pathPattern: normalisePattern(pattern), owners });
    } catch (err) {
      skipped.push({
        line,
        reason:
          err instanceof OwnershipRuleError
            ? err.message
            : 'This path pattern could not be evaluated.',
      });
    }
  });

  return {
    entries,
    skipped,
    truncated:
      all.length > read.length
        ? {
            lines: all.length - read.length,
            reason: `Only the first ${MAX_CODEOWNERS_LINES} lines were read. The rest were NOT imported, so the directories they cover are still unowned.`,
          }
        : null,
  };
}

// ─── Re-exported vocabulary ──────────────────────────────────────────────────

/*
 * MANDATORY, not tidiness. `OwnershipState`, `IssueOwnerState`,
 * `IssueSubject`, `OwnerRef` and `OwnerAssignment` were declared in this file
 * and are imported FROM this file by routes/surface.ts, routes/issues.ts and
 * ownership.test.ts. Promoting them into @qaai/shared without re-exporting
 * them here would break those three modules for no reader's benefit: a module
 * that resolves ownership is exactly where a caller looks for the words
 * ownership is described in.
 *
 * `packages/shared/src/types.test.ts` pins the member spellings, which is the
 * half that matters — every one of these is the validated domain of a TEXT
 * column, so a member dropped or respelled in transit does not fail to
 * compile. It fails to match a row somebody already wrote.
 */
export { ISSUE_OWNER_STATES, ISSUE_SUBJECTS, OWNERSHIP_STATES } from '@qaai/shared';
/*
 * And the provenance half. Re-exported for the same reason the block above
 * exists: a module that routes ownership is where a caller looks for the words
 * ownership is described in, and routes/issues.ts already imports these four
 * from here. The barrel publishes them now, so this is a convenience and no
 * longer the only way to reach them.
 */
export type {
  OwnableSubject,
  OwnerProvenance,
  OwnerResolution,
  OwnerStrength,
} from '@qaai/shared';
export type {
  IssueOwnerState,
  IssueSubject,
  OwnerAssignment,
  OwnerRef,
  OwnershipState,
} from '@qaai/shared';
