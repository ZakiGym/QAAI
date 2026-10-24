/**
 * Inline edit (§8) — "change this bit of the test to do X".
 *
 * The narrowest possible agent: it is handed one file, the lines the user
 * highlighted, and a plain-English instruction, and it returns the whole file
 * back. Returning the file rather than a diff is deliberate — the caller renders
 * a diff anyway, and a model that emits prose-shaped diffs is the single most
 * common way this feature breaks. Let it write code, and compute the diff
 * ourselves.
 *
 * The same rule the Healer follows applies here: never quietly weaken a test.
 * A user asking to "make this pass" is asking for a bug fix, not for the
 * assertion to be deleted.
 *
 * That rule used to live only in the system prompt, which is a request, not a
 * guarantee. It is now verified after the fact by counting assertions in the
 * test's own dialect (`@qaai/shared`) before and after the edit — and when the
 * dialect cannot be determined, the proposal carries a note saying the count
 * was not verified rather than implying it was. The prompt itself is also
 * dialect-aware: told "keep the file valid TypeScript" about a Go test, a model
 * will cheerfully translate it, which deletes every assertion in the file and
 * looks like a successful edit.
 *
 * POST-CHECK PARITY
 *
 * Never-weaken was the ONLY rule this path enforced. An edit could introduce a
 * fixed sleep, a `div:nth-child(3)` locator, an `@qaai/` import or a file that
 * does not parse, and nothing looked — while the Generator, producing the same
 * kind of artefact, ran twelve gates over it. `editInline` now runs the same
 * gates (`postCheckCode`, shared with the heal applier so there is one copy of
 * the policy) over whatever the model returned, and the findings ride out on
 * `explanation`, which is the field the edit processor stores as the proposal's
 * rationale and the user reads above the diff.
 *
 * One rule is STRICTER here than on the heal path, for a reason worth stating:
 * an edit whose result does not parse is DECLINED and the file comes back
 * unchanged. A heal is a fix for a test that is already red, so refusing it
 * leaves the customer worse off than taking it — but an edit has an
 * alternative. Nothing is lost yet, the user still has their working file, and
 * they can ask again more precisely. That is the same judgement
 * `verifyAssertionsKept` already makes below.
 */

import { z } from 'zod';
import {
  assertionExampleFor,
  countAssertions,
  dialect,
  resolveDialect,
  type DialectId,
} from '@qaai/shared';
import type { TestType } from '@qaai/shared';
import { postCheckCode } from './heal-apply.js';
import type { ToolchainGates } from './admission.js';
import type { CallContext, LlmService } from './llm.js';

/**
 * The JavaScript prompt, kept BYTE-IDENTICAL to the one this module shipped
 * with. `cacheSystem: true` caches on the exact text, and the overwhelming
 * majority of edits are Playwright-TS — so the common path keeps its cache hit
 * and its behaviour, and the dialect variant below is additive.
 */
const SYSTEM = `You are the inline-edit agent inside QAAI, an AI QA engineer.

You are given a Playwright test file, the lines the user selected, and an
instruction. Return the COMPLETE updated file.

Rules:
- Change only what the instruction requires. Preserve unrelated code, comments,
  imports, and formatting exactly.
- Keep the file valid TypeScript that still runs under @playwright/test.
- Never delete or weaken an assertion unless the user explicitly asks for that
  assertion to change. "Make this pass" means find the right assertion, not
  remove it.
- Never add a fixed sleep. Use Playwright's auto-waiting locators and
  expect(...) assertions.
- Prefer role/label/test-id locators over CSS.
- If the instruction cannot be carried out safely, return the file unchanged and
  explain why in the explanation.`;

/**
 * The same instructions for a test that is not JavaScript.
 *
 * The first rule is the one that matters: a model handed a pytest file under a
 * prompt that says "keep the file valid TypeScript" produces valid TypeScript.
 * That is not an edit, it is a rewrite, and every assertion in the original is
 * gone — which the never-weaken check below would then correctly refuse, after
 * a full model call. Saying it up front is cheaper and kinder.
 */
function systemFor(id: DialectId | null): string {
  if (id === null || id === 'JS_EXPECT' || id === 'JS_CHAI') return SYSTEM;
  const record = dialect(id);
  return `You are the inline-edit agent inside QAAI, an AI QA engineer.

You are given a test file written for ${record.label}, the lines the user
selected, and an instruction. Return the COMPLETE updated file.

Rules:
- Change only what the instruction requires. Preserve unrelated code, comments,
  imports, and formatting exactly.
- Keep the file in the language and test framework it is already written in. Do
  NOT translate it to another language, runner or assertion library, whatever
  the instruction seems to ask for.
- Never delete or weaken an assertion unless the user explicitly asks for that
  assertion to change. "Make this pass" means find the right assertion, not
  remove it. In this file an assertion looks like:
      ${record.example}
- Never add a fixed sleep. Use the framework's own waiting and assertion APIs.
- Prefer role/label/test-id locators over CSS.
- If the instruction cannot be carried out safely, return the file unchanged and
  explain why in the explanation.`;
}

export const inlineEditSchema = z.object({
  /** The complete file after the edit. */
  code: z.string().min(1),
  /** One sentence, shown above the diff. */
  explanation: z.string().min(1).max(400),
  /** True when the agent declined to make the change. */
  declined: z.boolean().default(false),
});

export type InlineEditResult = z.infer<typeof inlineEditSchema>;

/**
 * What the caller gets back: the model's result, plus whatever the never-weaken
 * check has to say about it.
 *
 * `review` is deliberately NOT part of `inlineEditSchema` — that schema is sent
 * to the model, and a field the model can fill in is a field the model can
 * reassure us with. This one is only ever written here.
 */
export interface InlineEditOutcome extends InlineEditResult {
  /** Set when the assertion count could not be verified. A human must look. */
  review?: string;
  /**
   * What the post-check gates found in the edited file, in plain sentences:
   * a fixed sleep, a brittle locator, a QAAI import, a test that now asserts
   * nothing. Empty means every reachable gate passed — not that nothing ran.
   */
  flags?: string[];
  /**
   * Which checks ran over the edited file and which did not. Carried so the
   * rationale a user reads cannot imply a check that never happened; the edit
   * path has no repository checkout, so typecheck, format and lint are among
   * the ones that did not.
   */
  checks?: string;
}

export interface InlineEditInput {
  filePath: string;
  code: string;
  /** The highlighted text. Empty when the user invoked it with no selection. */
  selection: string;
  selectionStartLine: number;
  selectionEndLine: number;
  instruction: string;
  /** Locators the last crawl found, so a "click the X button" edit targets something real. */
  availableLocators?: string[];
  /**
   * The test's own type and spec, for the post-check gates.
   *
   * Both optional, because the caller (`processEdit`) reads an AgentProposal
   * row that carries the file and not the test. The default below is the type
   * the overwhelming majority of inline edits are — a code-mode UI test — and
   * it is the SAFE default: a code-mode type makes the ASSERTIONS gate read the
   * file, where an edited UI test's assertions actually are. Defaulting to a
   * spec-driven type would make the gate look for assertions in a spec that was
   * never passed and report a file with assertions as having none.
   */
  testType?: TestType;
  spec?: unknown;
}

/**
 * The never-weaken check, as a pure function so it can be tested without a
 * model call — which matters, because the case worth testing is the one where
 * the model misbehaves.
 *
 * Three outcomes:
 *  - the dialect is known and the count held: the edit passes through.
 *  - the dialect is known and the count DROPPED: the file is returned unchanged
 *    and `declined` is set, which is the shape the caller already handles (the
 *    edit processor turns a declined proposal into a REJECTED row carrying the
 *    explanation). A refusal is right here and a review flag is not: nothing
 *    has been lost yet, and the user can simply ask again more precisely.
 *  - the dialect is UNKNOWN: the proposal still goes through — this is a diff a
 *    human approves, not an auto-apply — but it says out loud that the count
 *    was not checked. Never "0 assertions, nothing to lose".
 */
export function verifyAssertionsKept(
  input: Pick<InlineEditInput, 'code' | 'filePath'>,
  result: InlineEditResult,
  id: DialectId | null,
): InlineEditOutcome {
  // A declined edit, or one that changed nothing, has nothing to verify.
  if (result.declined || result.code === input.code) return result;

  if (id === null) {
    const note = `QAAI has no assertion lexicon for "${input.filePath}", so it could not check that this edit keeps as many assertions as the original. Read the diff before accepting it.`;
    return { ...result, review: note, explanation: `${result.explanation} (${note})` };
  }

  const before = countAssertions(input.code, id);
  const after = countAssertions(result.code, id);
  if (after >= before) return result;

  return {
    code: input.code,
    declined: true,
    explanation: `Refused: the edit would have removed ${before - after} of ${before} assertion(s) from this test. "Make this pass" means finding the right assertion, not deleting it — the file is unchanged. Ask again naming the assertion you want changed, or write ${assertionExampleFor(id)} yourself.`.slice(
      0,
      400,
    ),
  };
}

/** How much of the gate findings is folded into the user-visible rationale. */
const MAX_EXPLANATION_CHARS = 1_200;

/**
 * Run the Generator's gates over the edited file.
 *
 * Exported and async-but-model-free so the interesting cases are testable
 * without an API key: the default toolchain is `postCheckToolchain`, whose one
 * live gate is an in-process TypeScript parse, so this is deterministic, spawns
 * nothing and touches no filesystem.
 *
 * Three outcomes, mirroring `verifyAssertionsKept` above:
 *  - every reachable gate passed: the proposal goes through untouched except
 *    for `checks`, which records what ran. Saying what ran even on a clean
 *    result is the point — "no flags" has to be distinguishable from "nothing
 *    looked".
 *  - a gate FAILED on SYNTAX: declined, file unchanged. See the module header
 *    for why an edit is refused here where a heal is not.
 *  - anything else (a fixed sleep, a brittle locator, a QAAI import, a test
 *    that now asserts nothing): the edit goes through — this is a diff a human
 *    approves, not an auto-apply — and the findings are appended to the
 *    explanation, which is what the user reads above that diff.
 */
export async function verifyEditAdmissible(
  input: Pick<InlineEditInput, 'code' | 'filePath' | 'testType' | 'spec'>,
  result: InlineEditOutcome,
  toolchain?: ToolchainGates,
): Promise<InlineEditOutcome> {
  /*
   * A declined edit, or one that changed nothing, returns the file the customer
   * ALREADY HAS. Gating that would report the sleep in their own pre-existing
   * test as a finding about an edit that did not happen, and declining it would
   * be refusing to hand back the file we were given.
   */
  if (result.declined || result.code === input.code) return result;

  const check = await postCheckCode({
    code: result.code,
    filePath: input.filePath,
    testType: input.testType ?? 'E2E',
    spec: input.spec,
    toolchain,
  });

  if (!check.allowed) {
    return {
      code: input.code,
      declined: true,
      explanation: `Refused: ${check.refusal ?? 'the edited file did not pass the post-edit checks.'} The file is unchanged — ask again, or make the change in the editor.`.slice(
        0,
        MAX_EXPLANATION_CHARS,
      ),
      ...(result.review === undefined ? {} : { review: result.review }),
      flags: check.flags,
      checks: check.checks,
    };
  }

  if (check.flags.length === 0) return { ...result, flags: [], checks: check.checks };

  const note = check.flags.join(' ');
  return {
    ...result,
    flags: check.flags,
    checks: check.checks,
    review: result.review === undefined ? note : `${result.review} ${note}`,
    explanation: `${result.explanation} (${note})`.slice(0, MAX_EXPLANATION_CHARS),
  };
}

export async function editInline(
  llm: LlmService,
  ctx: CallContext,
  input: InlineEditInput,
): Promise<InlineEditOutcome> {
  const id = resolveDialect({ filePath: input.filePath });
  const prompt = `FILE: ${input.filePath}

INSTRUCTION
${input.instruction}

${
  input.selection.trim()
    ? `SELECTED LINES ${input.selectionStartLine}-${input.selectionEndLine}
${input.selection}`
    : 'The user made no selection — apply the instruction to the file as a whole.'
}

${
  input.availableLocators?.length
    ? `LOCATORS THIS APP ACTUALLY HAS (from the latest crawl)\n${input.availableLocators
        .map((l) => `  ${l}`)
        .join('\n')}\n`
    : ''
}
CURRENT FILE
${input.code}

Return the complete updated file.`;

  const result = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'medium',
    system: systemFor(id),
    prompt,
    schema: inlineEditSchema,
    schemaName: 'InlineEdit',
    maxTokens: 8000,
    cacheSystem: true,
  });

  /*
   * Order: never-weaken first, then the gates.
   *
   * `verifyAssertionsKept` can return the ORIGINAL file with `declined` set,
   * and in that case there is no edited file to gate — running the gates first
   * would mean reporting findings about a proposal that was then thrown away.
   * It is also the cheaper check, and it is the one authority on never-weaken
   * (see `postCheckCode`): the gates deliberately do not refuse for a lost
   * assertion, so this call has to happen and has to come first.
   */
  return verifyEditAdmissible(input, verifyAssertionsKept(input, result, id));
}
