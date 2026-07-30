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
 */

import { applyPatch } from 'diff';

export interface ApplyResult {
  ok: boolean;
  /** The new file contents. Only present when `ok`. */
  code?: string;
  /** Why it was refused, safe to show a user. */
  reason?: string;
  /** How much fuzz was needed — 0 means the patch applied exactly. */
  fuzz?: number;
}

/** `expect(...)`-style assertion count, used to catch a weakened test. */
export function countAssertions(code: string): number {
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

/** `test(...)` / `test.step(...)` count, used to catch a test that lost its body. */
function countTestBlocks(code: string): number {
  return (code.match(/\btest\s*\(|\btest\.step\s*\(/g) ?? []).length;
}

/**
 * Apply a unified diff to `original`.
 *
 * Tries an exact application first and only then widens the fuzz, so a patch
 * that fits precisely is never placed loosely.
 */
export function applyHealDiff(original: string, diff: string): ApplyResult {
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

  const testsBefore = countTestBlocks(original);
  const testsAfter = countTestBlocks(applied);
  if (testsBefore > 0 && testsAfter < testsBefore) {
    return {
      ok: false,
      reason: `The diff removes ${testsBefore - testsAfter} test block(s). A heal may fix a test, not delete one.`,
    };
  }

  const assertionsBefore = countAssertions(original);
  const assertionsAfter = countAssertions(applied);
  if (assertionsAfter < assertionsBefore) {
    return {
      ok: false,
      reason: `The diff removes ${assertionsBefore - assertionsAfter} assertion(s). A self-healing suite that drops assertions stops testing anything, so this needs a human edit instead.`,
    };
  }

  return { ok: true, code: applied, fuzz: usedFuzz };
}
