/**
 * Applying a Healer diff to a test file (§3.4).
 *
 * The Healer produces a unified diff, and until now nothing could apply one —
 * an approved heal recorded intent and left the code untouched. This closes that
 * gap, and it is deliberately paranoid, because the input is a model-authored
 * patch being written over a customer's test:
 *
 * - The patch must apply cleanly. A model routinely miscounts line numbers, so a
 *   small fuzz is allowed, but a patch that cannot be placed is REFUSED rather
 *   than force-fitted. A half-applied test is worse than an unapplied one.
 * - The result is re-checked after the fact: it must be non-empty, must actually
 *   differ from the original, and must not have lost the test's structure.
 * - Assertions are counted before and after. The Healer is told never to weaken
 *   an assertion; this verifies it rather than trusting it, because "the suite
 *   quietly stopped testing anything" is the failure mode that matters.
 *
 * That last guard used to count `expect(` and `assert(`, which is JavaScript.
 * In a Go, pytest, JUnit or RSpec repository the count was 0 before the heal
 * and 0 after, so the guard reported "no assertions were lost" about a patch
 * that could have deleted every one of them — a no-op precisely where nobody
 * was watching. It now counts in the test's own dialect (`@qaai/shared`), and
 * when the dialect cannot be determined it says so on the result instead of
 * passing quietly: an unreadable file is a file a human has to look at, not a
 * file that passed.
 *
 * POST-CHECK PARITY (the second defect this file now answers)
 *
 * Three things write test code into a customer's repository — the Generator,
 * the inline editor and the Healer — and until now only the Generator checked
 * its output. Everything above is about ONE rule (never weaken an assertion).
 * It said nothing about a heal that introduces `await page.waitForTimeout(500)`,
 * a `div:nth-child(3)` locator, an `@qaai/` import, or a file that does not
 * parse at all. The no-sleep and no-lock-in rules were enforced on one of three
 * code-producing paths, and the one path that writes the file with NO HUMAN IN
 * THE LOOP (auto-apply in the triage processor) was one of the two that skipped
 * them.
 *
 * So `postCheckCode` below runs the SAME gate set as the Generator —
 * `admission.ts`'s `admit`, with `item: null`, because a heal or an edit changes
 * a test nobody planned — over the patched file, and `postCheckToolchain`
 * supplies the one toolchain gate that is reachable with no repository checkout.
 * It lives in this file rather than its own because the applier and the rules
 * about what may be applied are one decision, and the inline editor imports it
 * from here so there is exactly one copy of that decision.
 */

import { extname } from 'node:path';
import { applyPatch } from 'diff';
import { countAssertions, findTestBlocks, resolveDialect, type DialectId } from '@qaai/shared';
import type { Language, TestType } from '@qaai/shared';
import { FINAL_ATTEMPT, admit, admitSet } from './admission.js';
import type {
  AdmissionReport,
  GateId,
  GateOutcome,
  GateStatus,
  SetAdmissionReport,
  ToolchainGates,
} from './admission.js';
import { toolchainFor } from './toolchain.js';
/*
 * Reached by a RELATIVE PATH ACROSS THE WORKSPACE BOUNDARY, which is a defect
 * and is recorded as one — `admission.ts`, `generator.ts`, `artifacts.ts`,
 * `page-objects.ts` and `refactor.ts` all carry the same note this round.
 * `packages/shared/src/index.ts` has no `export * from './artifact-set'`, and
 * the one-line fix is TS2308 on it: `artifact-set.ts` and `requirements.ts`
 * both export a type named `ContentDigest`. TYPE-ONLY here, so it is erased at
 * build time and reaches no runtime code across the boundary.
 */
import type {
  ArtifactSet,
  ArtifactSetContext,
} from '@qaai/shared';

export interface ApplyResult {
  ok: boolean;
  /** The new file contents. Only present when `ok`. */
  code?: string;
  /** Why it was refused, safe to show a user. */
  reason?: string;
  /** How much fuzz was needed — 0 means the patch applied exactly. */
  fuzz?: number;
  /**
   * Set when the never-weaken guard could not be RUN, on a patch that is
   * otherwise fine. Not a refusal — refusing every heal on a file type we do
   * not recognise would brick healing for a whole repository — but not silence
   * either. A caller showing a heal for review must show this with it.
   */
  review?: string;
}

/**
 * What the never-weaken guard knows about the test's language.
 *
 * Optional, and a caller that passes nothing gets the behaviour this module had
 * before dialects existed (see `jsLexiconAssertions`) plus a `review` note
 * saying the count was not verified. It is optional rather than required
 * because the two call sites that apply a heal — the approval route and the
 * auto-apply path in the triage processor — have the test row in hand and can
 * pass `filePath` without any other change, and a required parameter would have
 * meant editing them from here.
 */
export interface HealApplyHints {
  /** The test's own path. The strongest single signal and usually enough. */
  filePath?: string | null;
  /** The project's runner id, when the path cannot settle Cypress vs Jest. */
  ecosystemId?: string | null;
}

/**
 * The pre-dialect counter, kept for the case where the caller named no file.
 *
 * It is right about JavaScript and silent about everything else, which is the
 * defect this module's header describes — so it is used only as a FLOOR: a
 * JavaScript assertion that disappears is still caught, and the result is still
 * marked unverified because a count of 0 before and 0 after proves nothing.
 */
function jsLexiconAssertions(code: string): number {
  return (code.match(/\bexpect\s*\(|\bassert(?:\.|\s*\()/g) ?? []).length;
}

/**
 * Rewrite every `@@ -a,b +c,d @@` header so its line counts match the hunk body.
 *
 * This is the difference between the feature working and the feature looking
 * broken. A language model writes correct diff *content* but miscounts hunk
 * lengths constantly, and jsdiff's parser is strict — a wrong count makes it
 * throw, so an otherwise perfect fix would be rejected as "malformed".
 *
 * Only the declared counts are touched; not one character of content changes, so
 * this cannot turn a bad patch into a plausible one.
 */
export function normalizeHunkHeaders(diff: string): string {
  const lines = diff.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (!header) {
      out.push(line);
      continue;
    }

    // Walk the body to the next header or the end of the patch.
    let oldCount = 0;
    let newCount = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const body = lines[j]!;
      if (body.startsWith('@@') || body.startsWith('--- ') || body.startsWith('+++ ')) break;
      if (body.startsWith('\\')) continue; // "\ No newline at end of file"
      if (body.startsWith('-')) oldCount += 1;
      else if (body.startsWith('+')) newCount += 1;
      else if (body.startsWith(' ')) {
        oldCount += 1;
        newCount += 1;
      } else if (body === '') {
        // A bare empty line inside a hunk is an unprefixed context line — the
        // single most common model slip. Treat it as context, and emit it as one.
        const isTrailing = lines.slice(j).every((l) => l.trim() === '');
        if (isTrailing) break;
        oldCount += 1;
        newCount += 1;
      } else {
        break; // Not part of a hunk at all.
      }
    }

    out.push(`@@ -${header[1]},${oldCount} +${header[2]},${newCount} @@${header[3]}`);
  }

  return out.join('\n');
}

/**
 * Test-case count, used to catch a test that lost its body.
 *
 * JavaScript keeps its original regex rather than the dialect's `testBlock`
 * patterns: the regex counts OCCURRENCES and the dialect counts LINES, so two
 * `test(` calls on one line are 2 here and 1 there. Nothing about this change
 * is worth altering what a JS heal is allowed to do, so the swap applies only
 * to the languages where the old count was always 0.
 */
function countTestBlocks(code: string, dialect: DialectId | null): number {
  if (dialect === null || dialect === 'JS_EXPECT' || dialect === 'JS_CHAI') {
    return (code.match(/\btest\s*\(|\btest\.step\s*\(/g) ?? []).length;
  }
  return findTestBlocks(code, dialect).length;
}

/**
 * Apply a unified diff to `original`.
 *
 * Tries an exact application first and only then widens the fuzz, so a patch
 * that fits precisely is never placed loosely.
 */
export function applyHealDiff(original: string, diff: string, hints?: HealApplyHints): ApplyResult {
  if (!diff.trim()) return { ok: false, reason: 'The proposal contains no diff' };

  let applied: string | false = false;
  let usedFuzz = 0;
  let parseError: string | null = null;

  // Repair the hunk arithmetic before parsing; see normalizeHunkHeaders.
  const patch = normalizeHunkHeaders(diff);

  for (const fuzzFactor of [0, 1, 2]) {
    let attempt: string | false;
    try {
      attempt = applyPatch(original, patch, { fuzzFactor });
    } catch (err) {
      // jsdiff THROWS on a structurally malformed patch rather than returning
      // false, and a model does occasionally emit one. Uncaught, that would be a
      // 500 on approval and a dead triage job — so a bad patch is just a refusal.
      parseError = err instanceof Error ? err.message : 'malformed patch';
      break;
    }
    if (attempt !== false) {
      applied = attempt;
      usedFuzz = fuzzFactor;
      break;
    }
  }

  if (parseError) {
    return { ok: false, reason: `The proposed diff is malformed and cannot be applied (${parseError})` };
  }

  if (applied === false) {
    return {
      ok: false,
      reason:
        'The diff no longer applies to this test — the file has changed since the proposal was made. Re-run triage to get a fresh proposal.',
    };
  }

  if (!applied.trim()) {
    return { ok: false, reason: 'Applying the diff would empty the file' };
  }
  if (applied === original) {
    return { ok: false, reason: 'The diff is a no-op against the current file' };
  }

  const dialect = resolveDialect({
    filePath: hints?.filePath ?? null,
    ecosystemId: hints?.ecosystemId ?? null,
  });

  const testsBefore = countTestBlocks(original, dialect);
  const testsAfter = countTestBlocks(applied, dialect);
  if (testsBefore > 0 && testsAfter < testsBefore) {
    return {
      ok: false,
      reason: `The diff removes ${testsBefore - testsAfter} test block(s). A heal may fix a test, not delete one.`,
    };
  }

  /*
   * The never-weaken guard. Counted in the test's own language when we know it,
   * and reported as UNVERIFIED when we do not — because the failure this guard
   * exists to prevent is silent, and a guard that cannot run must not look like
   * a guard that passed.
   */
  const assertionsBefore = dialect
    ? countAssertions(original, dialect)
    : jsLexiconAssertions(original);
  const assertionsAfter = dialect ? countAssertions(applied, dialect) : jsLexiconAssertions(applied);
  if (assertionsAfter < assertionsBefore) {
    return {
      ok: false,
      reason: `The diff removes ${assertionsBefore - assertionsAfter} assertion(s). A self-healing suite that drops assertions stops testing anything, so this needs a human edit instead.`,
    };
  }

  if (dialect === null) {
    return {
      ok: true,
      code: applied,
      fuzz: usedFuzz,
      review: `The assertion count could not be read for ${
        hints?.filePath ? `"${hints.filePath}" — QAAI has no assertion lexicon for that file type` : 'this test — no file path was supplied'
      }. The patch applies and keeps the test's structure, but nobody has verified that it still asserts as much as it did. Read the diff before accepting it.`,
    };
  }

  return { ok: true, code: applied, fuzz: usedFuzz };
}

// ─── Post-check: the gates, run on code a heal or an edit produced ───────────

/**
 * The repo root handed to `toolchainFor` on a path that HAS no repo root.
 *
 * Nothing is ever read from it. The heal paths run inside an Express request
 * and the triage processor, neither of which has the customer's checkout on
 * disk, and the one gate we use below (the in-process TypeScript parse) never
 * consults it. It is deliberately a path that cannot exist rather than, say,
 * `process.cwd()`: if `toolchain.ts` ever changes so that the parse DOES read
 * the repo, this makes the gate report UNAVAILABLE — honest — instead of
 * quietly checking a generated test against QAAI's own source tree.
 */
const NO_REPO_ROOT = '/qaai/no-repository-checkout';

/**
 * The extensions whose SYNTAX gate is answered in process, with no checkout and
 * no child process.
 *
 * `toolchainFor().syntax` dispatches TypeScript and JavaScript to
 * `ts.transpileModule` — no Program, no module resolution, no `repoRoot` — and
 * dispatches every other language to a spawned parser resolved out of the
 * customer's `node_modules` or PATH. The second kind cannot work here (there is
 * nothing to resolve from and nowhere to run it) and must not be attempted: a
 * list endpoint that spawns `python3` once per heal row is a different defect.
 *
 * This list mirrors `EXT_LANGUAGE` in `toolchain.ts`, which is read-only from
 * here. If an extension is added there and not here, this path reports
 * "not parsed" for it — a loss of coverage that is visible in the `checks`
 * string below, never a false PASS.
 */
const IN_PROCESS_PARSEABLE: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** Whether the patched file can be parsed at all without the customer's checkout. */
export function syntaxIsReachableWithoutACheckout(filePath: string): boolean {
  return IN_PROCESS_PARSEABLE.has(extname(filePath).toLowerCase());
}

function unavailableGate(gate: GateId, why: string): GateOutcome {
  return { gate, status: 'UNAVAILABLE', why, detail: [], line: null };
}

/**
 * The partial toolchain these paths genuinely have.
 *
 * SYNTAX is real: the in-process TypeScript parse is the single most valuable
 * check here, because a heal that does not parse is strictly worse than the red
 * test it replaces — the red test fails with an assertion error a human can
 * read, while an unparseable file fails with "the runner produced no report"
 * and takes every sibling test in the file down with it.
 *
 * TYPECHECK, FORMAT and LINT are UNAVAILABLE, and say why. Each of them needs
 * the customer's checkout — their tsconfig, their prettier, their eslint flat
 * config — and this path has none. They are NOT faked into a PASS: that is the
 * original defect wearing a new hat, and `admission.ts`'s rule 2 exists to
 * forbid it. They are reported as not run, and the `checks` string a human
 * reads names them.
 */
export function postCheckToolchain(): ToolchainGates {
  const real = toolchainFor({ repoRoot: NO_REPO_ROOT });
  return {
    async syntax(input) {
      if (!syntaxIsReachableWithoutACheckout(input.filePath)) {
        return unavailableGate(
          'SYNTAX',
          `Nobody has confirmed this file still parses: QAAI parses TypeScript and JavaScript in process, and a "${
            extname(input.filePath) || '(no extension)'
          }" file needs its own compiler run from the repository checkout, which this path does not have.`,
        );
      }
      return real.syntax(input);
    },
    async typecheck() {
      return unavailableGate(
        'TYPECHECK',
        "Nobody has confirmed this file typechecks: typechecking needs the repository's own tsconfig and node_modules, and a heal or an edit is applied without a checkout.",
      );
    },
    async format() {
      return unavailableGate(
        'FORMAT',
        "This file was not reformatted: the formatter is the repository's own prettier, and a heal or an edit is applied without a checkout — so the patch keeps whatever style it was written in.",
      );
    },
    async lint() {
      return unavailableGate(
        'LINT',
        "Nobody has run the project's lint rules over this file: they live in the repository's eslint config, and a heal or an edit is applied without a checkout.",
      );
    },
  };
}

/**
 * The gates that CANNOT run on this path by construction — not by accident, and
 * not because anything went wrong with this particular file.
 *
 * The distinction matters because `admit` puts every UNAVAILABLE into
 * `reviewFlags`, and six permanent flags on every heal ever proposed is a flag
 * nobody reads — the exact failure `admission.ts` warns about for the mutation
 * gate. So these are reported in the `checks` string ("not checked: …"), where
 * a human can see what was skipped, and are kept out of `flags`, which is for
 * things about THIS file.
 *
 *  - TYPECHECK / FORMAT / LINT — need the customer's checkout (see above).
 *  - FIDELITY — needs an approved plan item, and a heal or an edit changes a
 *    test that already exists. `admit` says exactly this and reports it
 *    UNAVAILABLE rather than guessing.
 *  - DUPLICATE — needs the rest of the suite, which neither path loads. A heal
 *    cannot create a duplicate anyway: it patches a test that is already there.
 *  - PATH_CONVENTION — a heal does not move the file. If the test is at a path
 *    the runner never collects, that was true before the heal and the heal
 *    cannot fix it; blocking a fix over it would strand the customer.
 *  - MUTATION — measured after the test is stored, by its own runner.
 */
const STRUCTURALLY_UNAVAILABLE: readonly GateId[] = [
  'TYPECHECK',
  'FORMAT',
  'LINT',
  'FIDELITY',
  'DUPLICATE',
  'PATH_CONVENTION',
  'MUTATION',
];

/** Short names for the one line a human reads about what was and was not checked. */
const GATE_LABEL: Record<GateId, string> = {
  SYNTAX: 'parses',
  TYPECHECK: 'typecheck',
  FORMAT: 'formatting',
  LINT: 'lint',
  ASSERTIONS: 'asserts something',
  LOCATORS: 'locator resilience',
  FIDELITY: 'plan fidelity',
  NO_LOCK_IN: 'no QAAI dependency',
  NO_FIXED_SLEEP: 'no fixed sleep',
  PATH_CONVENTION: 'file path',
  DUPLICATE: 'duplication',
  MUTATION: 'mutation',
};

export interface PostCheck {
  /**
   * Whether this file may be written at all — by a human approving it or by the
   * unattended path. False ONLY when the patched file does not parse; see
   * `postCheckCode` for why that is the one refusal.
   */
  allowed: boolean;
  /** Why not, when `allowed` is false. Safe to show a user. */
  refusal?: string;
  /**
   * Whether the UNATTENDED path may write it. Stricter than `allowed` on
   * purpose: see `postCheckCode`.
   */
  autoApplyAllowed: boolean;
  /** Why the unattended path was declined, when `allowed` is true but this is false. */
  autoApplyDeclined?: string;
  /**
   * Plain sentences about THIS file, for the human-facing record: every warning
   * and every failure from a gate that actually ran. Empty is meaningful here —
   * it means every reachable gate passed, not that nothing was looked at.
   */
  flags: string[];
  /**
   * One line naming the checks that ran and the checks that did not. Derived
   * from the gate statuses rather than written by hand, so it cannot claim a
   * check that did not happen.
   */
  checks: string;
  /** The whole report, for a caller that wants line numbers and detail. */
  report: AdmissionReport;
}

export interface PostCheckInput {
  /** The file AFTER the patch or the edit — `ApplyResult.code`, or the model's file. */
  code: string;
  filePath: string;
  testType: TestType;
  /** The test's own spec. A spec-driven type keeps its assertions here, not in code. */
  spec?: unknown;
  language?: Language | null;
  ecosystemId?: string | null;
  /**
   * A real toolchain, when a caller has one. Absent means the partial toolchain
   * above — and the absence is load-bearing: it is what tells this function
   * that a SYNTAX of UNAVAILABLE on a non-JavaScript file is structural rather
   * than a fact about the file. A caller that injects its own is claiming real
   * coverage, so an UNAVAILABLE from it blocks the unattended path.
   */
  toolchain?: ToolchainGates;
}

/**
 * Run the Generator's gates over code a heal or an inline edit produced.
 *
 * THE VERDICTS MEAN SOMETHING DIFFERENT HERE, and that is the whole design.
 *
 * A generated test can be refused: nothing is lost but a model call, and the
 * behaviour it would have covered was never covered anyway. A HEAL is a fix for
 * a test that is currently RED. Refusing it leaves the customer with a broken
 * test and no proposal — so a refusal has to be worth more than the fix it
 * throws away, and for almost every gate it is not. Hence:
 *
 *  - **SYNTAX FAIL is the one refusal, on every path, reviewed or not.** A file
 *    that does not parse is strictly worse than the red test it replaces: the
 *    red test fails with an assertion error naming a line, the unparseable one
 *    fails with "no report" and takes its file's sibling tests with it. Refusing
 *    costs the customer nothing — they keep the red test they already had, the
 *    proposal stays on record with the reason, and triage can propose again. And
 *    it is a refusal we can be SURE about: the parse is transpile-only, so a
 *    missing import cannot masquerade as a syntax error. A human approving a
 *    file that does not parse is not a check, it is a rubber stamp, which is why
 *    this one does not defer to review.
 *
 *  - **ASSERTIONS FAIL is a flag, never a refusal, and that is deliberate.**
 *    `applyHealDiff` above is the SINGLE AUTHORITY on never-weaken, because
 *    never-weaken is a RELATIVE question — fewer assertions than BEFORE — and
 *    `admit` has no "before" to compare against; `AdmissionInput` carries one
 *    file. The ASSERTIONS gate answers a different, absolute question: does the
 *    result assert anything worth anything. They cannot disagree, because they
 *    are not the same predicate. Where they overlap — a test that asserted
 *    nothing before and asserts nothing after — never-weaken correctly permits
 *    it and ASSERTIONS correctly dislikes it, and refusing would not buy the
 *    customer a single assertion: the file was already assertion-free. So that
 *    is a loud flag, and exactly one authority can refuse a heal for losing an
 *    assertion.
 *
 *  - **WARN is a flag.** A brittle locator or a fixed sleep in a heal is worth a
 *    human's eye and is not worth leaving a test broken over. Two of the three
 *    heal paths put the diff in front of a person, and this is what they read.
 *
 *  - **The unattended path is held to a higher bar than the reviewed one.**
 *    `autoApplyAllowed` requires every gate that could run to have actually
 *    PASSED — no FAIL, no WARN, no UNAVAILABLE. Not symmetry for its own sake:
 *    a flag is a message to a human, and auto-apply is the one path with no
 *    human to read it. A fixed sleep merely flagged on a reviewed heal becomes,
 *    unattended, a flake source silently committed to the customer's repository
 *    with nobody told. Auto-apply is PREMISED on the output having been checked,
 *    so when a check did not happen the premise is gone and the proposal goes to
 *    a person instead — which is precisely what this path already did for
 *    `ApplyResult.review`.
 *
 *  - **UNAVAILABLE blocks the unattended path only when it is a fact about THIS
 *    file.** Blocking on every UNAVAILABLE would disable auto-apply outright,
 *    because FIDELITY, DUPLICATE and the three checkout gates can never run
 *    here — a feature silently switched off is as dishonest as a gate that
 *    lies. So the structurally-unavailable gates above are excluded, and a
 *    SYNTAX that could never have run on this file type (a Go or pytest test,
 *    with no checkout to compile from) is structural too: it is reported as not
 *    checked, and the dialect-based gates that CAN read that file — assertions,
 *    locators, no-lock-in, no-fixed-sleep — still decide. A `.ts` heal whose
 *    parse came back UNAVAILABLE is the other case: the parser was reachable
 *    and did not answer, which is a fact about this file, and the unattended
 *    path declines.
 */
/**
 * What the gates found about a multi-file change.
 *
 * ── WHY A SECOND SHAPE AND NOT A LOOP OVER {@link postCheckCode} ───────────
 *
 * Because the VERDICT is about the set and not about the files. A heal or a
 * refactor that rewrites a spec and the page object it imports is ONE change: a
 * spec applied without its page object fails its first run on an import error,
 * which reads to a human as a broken test rather than as an interrupted write.
 * A caller folding N `PostCheck`s together would have to decide that, and would
 * decide it differently from the next caller.
 *
 * Every semantic {@link postCheckCode} owns is preserved, because this calls the
 * same `admitSet` that calls the same `admit`:
 *
 *   · SYNTAX FAIL is the one refusal, on every path, reviewed or not — and now
 *     a SYNTAX FAIL on ANY artifact refuses the whole set, for the reason
 *     above;
 *   · ASSERTIONS FAIL is a flag and never a refusal (`applyHealDiff` is the
 *     single authority on never-weaken, which is a RELATIVE question `admit`
 *     cannot ask);
 *   · the unattended path is held stricter than the reviewed one;
 *   · a structurally unavailable gate does not block auto-apply, and a gate
 *     that could have run and did not, does.
 *
 * What it ADDS is the set's own refusals — a duplicate path, a write to a file
 * QAAI does not own, a stale base — and those ARE refusals on every path: none
 * of them is a thing a human approving a diff can make safe, and the last one
 * means the change was computed against bytes somebody has since replaced.
 */
export interface SetPostCheck {
  /** Whether this SET may be written at all, by a human approving it or not. */
  allowed: boolean;
  refusal?: string;
  autoApplyAllowed: boolean;
  autoApplyDeclined?: string;
  /** Plain sentences, each prefixed with the file it is about. */
  flags: string[];
  /** One line per artifact naming what ran and what did not. */
  checks: string;
  /** The whole set report, for a caller that wants line numbers per file. */
  report: SetAdmissionReport;
}

export interface PostCheckSetInput {
  set: ArtifactSet;
  testType: TestType;
  /** The SPEC's spec, for a spec-driven or hybrid type. */
  spec?: unknown;
  language?: Language | null;
  ecosystemId?: string | null;
  toolchain?: ToolchainGates;
  /**
   * The ledger and the working tree. OMITTING IT IS NOT A PASS: the five
   * ownership refusals are then not asked, `report.ledgerChecked` is false, and
   * {@link SetPostCheck.autoApplyAllowed} is false as a result — an unattended
   * write to a path nobody checked the ownership of is the exact defect the
   * ownership model exists to prevent.
   */
  context?: ArtifactSetContext;
}

export async function postCheckSet(input: PostCheckSetInput): Promise<SetPostCheck> {
  const report = await admitSet({
    set: input.set,
    testType: input.testType,
    // No plan item: a heal and a refactor both change tests that already exist.
    item: null,
    language: input.language ?? null,
    ecosystemId: input.ecosystemId ?? null,
    spec: input.spec,
    attempt: FINAL_ATTEMPT,
    toolchain: input.toolchain ?? postCheckToolchain(),
    context: input.context,
    /*
     * There is no revise loop here for the same reason `postCheckCode` asks for
     * the terminal attempt: the Healer produced a DIFF and the refactor engine
     * produced a deterministic rewrite, so there is nothing to hand a
     * `revisePrompt` to.
     */
    revisable: false,
  });

  const structural = new Set<GateId>(STRUCTURALLY_UNAVAILABLE);
  const flags: string[] = [];
  const checkLines: string[] = [];
  let syntaxFailure: { path: string; why: string } | null = null;
  let blocker: { path: string; gate: GateId; status: GateStatus; why: string } | null = null;

  for (const artifact of report.artifacts) {
    const notAbout = new Set<GateId>(artifact.report.gates.map((gate) => gate.gate));
    for (const id of artifact.judged) notAbout.delete(id);

    /*
     * Per artifact, because `syntaxIsReachableWithoutACheckout` is a question
     * about THIS file's extension: a `.ts` spec's parse is reachable in process
     * and a `.py` fixture's is not, and treating the set's answer as one would
     * either block auto-apply on every polyglot set or claim a parse that never
     * ran.
     */
    const perFile = new Set(structural);
    if (
      input.toolchain === undefined &&
      !syntaxIsReachableWithoutACheckout(artifact.path)
    ) {
      perFile.add('SYNTAX');
    }

    const judged = artifact.report.gates.filter(
      (gate) => artifact.judged.includes(gate.gate) && !perFile.has(gate.gate),
    );
    const syntax = artifact.report.gates.find((gate) => gate.gate === 'SYNTAX');
    if (syntax?.status === 'FAIL' && syntaxFailure === null) {
      syntaxFailure = {
        path: artifact.path,
        why: syntax.detail[0] ?? syntax.why,
      };
    }

    const ranIds = new Set<GateId>(
      judged.filter((gate) => gate.status !== 'UNAVAILABLE').map((gate) => gate.gate),
    );
    const ran = artifact.report.gates.filter((g) => ranIds.has(g.gate)).map((g) => GATE_LABEL[g.gate]);
    const notRun = artifact.report.gates
      .filter((g) => !ranIds.has(g.gate))
      .map((g) => GATE_LABEL[g.gate]);
    checkLines.push(
      `${artifact.path} (${artifact.role}): checked ${ran.join(', ') || 'nothing'}; not checked ${
        notRun.join(', ') || 'nothing'
      }.`,
    );

    for (const gate of judged) {
      if (gate.status === 'PASS') continue;
      flags.push(
        gate.status === 'FAIL'
          ? `${artifact.path}: this change fails a check a generated test would have been sent back for: ${gate.why}`
          : `${artifact.path}: ${gate.why}`,
      );
      blocker ??= { path: artifact.path, gate: gate.gate, status: gate.status, why: gate.why };
    }
  }

  // The gates that were set aside because they are not about a role. Said out
  // loud rather than dropped — see `GATES_NOT_ABOUT_ROLE`.
  for (const aside of report.setAside) flags.push(`${aside.path}: ${aside.why}`);
  for (const problem of report.setProblems) {
    flags.push(`${problem.path || '(the set)'}: ${problem.kind} — ${problem.why}`);
  }

  const checks = checkLines.join(' ');

  if (syntaxFailure !== null) {
    return {
      allowed: false,
      refusal: `"${syntaxFailure.path}" does not parse, so applying this change would replace a test that fails with a readable error by a file the runner cannot load at all — along with every other test in it. ${syntaxFailure.why}`,
      autoApplyAllowed: false,
      autoApplyDeclined: `"${syntaxFailure.path}" does not parse.`,
      flags,
      checks,
      report,
    };
  }

  if (report.setProblems.length > 0) {
    const first = report.setProblems[0]!;
    /*
     * A STRUCTURAL REFUSAL IS A REFUSAL ON EVERY PATH, including a reviewed
     * one, and that is the one place this differs from `postCheckCode`'s "only
     * SYNTAX refuses". A human approving a diff cannot make "two artifacts write
     * to one path" or "the bytes this was computed against have been replaced"
     * safe — approving the second DISCARDS whatever replaced them, which is the
     * work this whole model exists to protect.
     */
    return {
      allowed: false,
      refusal: `This change may not be applied: ${first.kind} at "${first.path || '(the set)'}" — ${first.why}`,
      autoApplyAllowed: false,
      autoApplyDeclined: `${first.kind} at "${first.path || '(the set)'}".`,
      flags,
      checks,
      report,
    };
  }

  /*
   * `ledgerChecked: false` DECLINES THE UNATTENDED PATH and does not block the
   * reviewed one. A human approving the diff is the premise auto-apply lacks,
   * and an unattended write to a path whose ownership nobody checked is the
   * `pushRepo` defect with a different caller.
   */
  if (!report.ledgerChecked) {
    return {
      allowed: true,
      autoApplyAllowed: false,
      autoApplyDeclined:
        'No ownership ledger was supplied, so whether QAAI may write these paths is undecided. An unattended write to a path nobody checked the ownership of is how a human’s file gets overwritten.',
      flags,
      checks,
      report,
    };
  }

  return {
    allowed: true,
    autoApplyAllowed: blocker === null,
    autoApplyDeclined: blocker
      ? `Applying this without a human needs every check that can run to pass; "${
          GATE_LABEL[blocker.gate]
        }" on ${blocker.path} came back ${blocker.status}. ${blocker.why}`
      : undefined,
    flags,
    checks,
    report,
  };
}

export async function postCheckCode(input: PostCheckInput): Promise<PostCheck> {
  const report = await admit({
    code: input.code,
    filePath: input.filePath,
    testType: input.testType,
    // No plan item: a heal and an edit both change a test that already exists.
    // FIDELITY reports UNAVAILABLE rather than guessing, which is correct.
    item: null,
    language: input.language ?? null,
    ecosystemId: input.ecosystemId ?? null,
    spec: input.spec,
    /*
     * `attempt` is the revise loop's counter, and there is no revise loop here:
     * the Healer produced a DIFF, not a file, so there is nothing to hand a
     * `revisePrompt` to. Asking for the terminal attempt keeps `report.verdict`
     * from ever being REVISE, which would be meaningless on this path — and
     * this function keys on the GATE STATUSES rather than the verdict anyway,
     * because the verdict arithmetic was written for code that can be thrown
     * away and regenerated. A heal cannot be.
     */
    attempt: FINAL_ATTEMPT,
    toolchain: input.toolchain ?? postCheckToolchain(),
  });

  const structural = new Set<GateId>(STRUCTURALLY_UNAVAILABLE);
  if (input.toolchain === undefined && !syntaxIsReachableWithoutACheckout(input.filePath)) {
    structural.add('SYNTAX');
  }

  const judged = report.gates.filter((gate) => !structural.has(gate.gate));
  const syntax = report.gates.find((gate) => gate.gate === 'SYNTAX');

  const ranIds = new Set<GateId>(
    judged.filter((gate) => gate.status !== 'UNAVAILABLE').map((gate) => gate.gate),
  );
  const ran = report.gates.filter((g) => ranIds.has(g.gate)).map((g) => GATE_LABEL[g.gate]);
  const notRun = report.gates.filter((g) => !ranIds.has(g.gate)).map((g) => GATE_LABEL[g.gate]);
  const checks = `Checked after patching: ${ran.join(', ') || 'nothing'}. Not checked: ${
    notRun.join(', ') || 'nothing'
  }.`;

  const flags = judged
    .filter((gate) => gate.status !== 'PASS')
    .map((gate) =>
      gate.status === 'FAIL'
        ? `This change fails a check that a generated test would have been sent back for: ${gate.why}`
        : gate.why,
    );

  if (syntax?.status === 'FAIL') {
    const where = syntax.line === null ? '' : ` (line ${syntax.line})`;
    return {
      allowed: false,
      refusal: `The patched file does not parse${where}, so applying it would replace a test that fails with a readable error by a file the runner cannot load at all — along with every other test in it. ${
        syntax.detail[0] ?? syntax.why
      }`,
      autoApplyAllowed: false,
      autoApplyDeclined: 'The patched file does not parse.',
      flags,
      checks,
      report,
    };
  }

  const blocker = judged.find((gate) => gate.status !== 'PASS');
  return {
    allowed: true,
    autoApplyAllowed: blocker === undefined,
    autoApplyDeclined: blocker
      ? `Applying this without a human needs every check that can run to pass; "${
          GATE_LABEL[blocker.gate]
        }" came back ${blocker.status}. ${blocker.why}`
      : undefined,
    flags,
    checks,
    report,
  };
}
