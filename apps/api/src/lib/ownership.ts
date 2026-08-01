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

/** Which of the four things a rule points at. */
export type OwnershipSubject = 'TEST' | 'SUITE' | 'FEATURE' | 'PATH';

/** Who a rule routes to. Exactly one of the two, ever. */
export type OwnerRef = { kind: 'USER'; userId: string } | { kind: 'TEAM'; teamId: string };

/** A stable grouping key — the digest buckets failures by this. */
export function ownerKey(owner: OwnerRef): string {
  return owner.kind === 'USER' ? `USER:${owner.userId}` : `TEAM:${owner.teamId}`;
}

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
 * The three rejections are the three places this dialect differs from the
 * gitignore syntax people half-remember, and each one is refused loudly rather
 * than reinterpreted — a pattern that silently means something other than what
 * it says routes failures to the wrong team and looks right while doing it.
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
      try {
        hit = matchesPath(rule.pathPattern!, test.filePath);
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
      reason = `${normaliseTestPath(test.filePath)} matches ${rule.pathPattern}.`;
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
