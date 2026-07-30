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
 */

import { z } from 'zod';
import type { CallContext, LlmService } from './llm.js';

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

export const inlineEditSchema = z.object({
  /** The complete file after the edit. */
  code: z.string().min(1),
  /** One sentence, shown above the diff. */
  explanation: z.string().min(1).max(400),
  /** True when the agent declined to make the change. */
  declined: z.boolean().default(false),
});

export type InlineEditResult = z.infer<typeof inlineEditSchema>;

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
}

export async function editInline(
  llm: LlmService,
  ctx: CallContext,
  input: InlineEditInput,
): Promise<InlineEditResult> {
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

  return llm.structured(ctx, {
    tier: 'strong',
    effort: 'medium',
    system: SYSTEM,
    prompt,
    schema: inlineEditSchema,
    schemaName: 'InlineEdit',
    maxTokens: 8000,
    cacheSystem: true,
  });
}
