/**
 * Chat copilot (§3.5) — per-project chat with tool access to the flow map,
 * the test suite, and run history.
 *
 * Tools are supplied by the caller (the API knows how to read the database);
 * this module owns the loop and the prompt. Tool calls are returned alongside
 * the answer so the cockpit can show its work rather than a bare reply.
 */

import type { CallContext, LlmService } from './llm.js';

export interface CopilotTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface CopilotTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CopilotResult {
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

const SYSTEM = `You are the QAAI copilot, embedded in the cockpit of a QA
platform, answering questions about one project's tests.

You have tools that read the project's flow map, its tests, and its run history.
Use them before answering anything factual — never guess at a pass rate, a flake
rate, or whether a test exists.

Answer like a QA engineer talking to a teammate: lead with the answer, then the
evidence. Cite test names and run ids so the person can click through. When the
data does not support a confident answer, say what is missing rather than
hedging vaguely.

If asked to write or change tests, describe what you would write and point the
person at the Generator — you propose, the Generator produces the code.`;

/**
 * Runs one copilot turn.
 *
 * The loop is deliberately capped: a copilot that can call tools forever is a
 * runaway cost bug waiting to happen, and every real question here is
 * answerable in a handful of reads.
 */
export async function askCopilot(
  llm: LlmService,
  ctx: CallContext,
  args: {
    question: string;
    history: CopilotTurn[];
    tools: CopilotTool[];
    maxToolRounds?: number;
  },
): Promise<CopilotResult> {
  const maxRounds = args.maxToolRounds ?? 4;
  const toolCalls: CopilotResult['toolCalls'] = [];

  // Tool selection is done as a structured decision rather than with native
  // tool-calling so the copilot shares one code path with every other agent —
  // same retries, same accounting, same masking.
  const toolCatalogue = args.tools
    .map((t) => `  ${t.name}(${JSON.stringify(t.parameters)}) — ${t.description}`)
    .join('\n');

  let gathered = '';

  for (let round = 0; round < maxRounds; round++) {
    const decision = await llm.complete(ctx, {
      tier: 'cheap',
      effort: 'low',
      system: `You decide whether more data is needed to answer a question about a QA project.
Available tools:
${toolCatalogue}

Reply with exactly one line, either:
  CALL <toolName> <json args>
  DONE`,
      prompt: `Question: ${args.question}

Data gathered so far:
${gathered || '(nothing yet)'}`,
      maxTokens: 500,
    });

    const call = /^CALL\s+(\w+)\s+(\{.*\})\s*$/s.exec(decision.trim());
    if (!call) break;

    const tool = args.tools.find((t) => t.name === call[1]);
    if (!tool) break;

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(call[2]!) as Record<string, unknown>;
    } catch {
      break;
    }

    let result: unknown;
    try {
      result = await tool.execute(parsedArgs);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }

    toolCalls.push({ name: tool.name, args: parsedArgs, result });
    gathered += `\n${tool.name}(${JSON.stringify(parsedArgs)}) =>\n${JSON.stringify(result).slice(0, 4000)}\n`;
  }

  const conversation = args.history
    .slice(-8)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'You'}: ${turn.content}`)
    .join('\n');

  const reply = await llm.complete(ctx, {
    tier: 'strong',
    effort: 'medium',
    system: SYSTEM,
    prompt: `${conversation ? `Conversation so far:\n${conversation}\n\n` : ''}User: ${args.question}

Data from tools:
${gathered || '(no tool data — answer from the conversation, or say what you would need)'}`,
    maxTokens: 4000,
    cacheSystem: true,
  });

  return { reply, toolCalls };
}
