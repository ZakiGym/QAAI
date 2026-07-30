/**
 * Copilot processor (§3.5) — one turn of the agent conversation.
 *
 * Runs on the worker because a turn can take minutes: it may crawl, run a
 * suite, and come back. The API returns immediately and the cockpit follows
 * along over SSE.
 */

import type { CopilotJob } from '@qaai/shared';
import { llm, logger, prisma, publishEvent } from '../context.js';
import { buildCopilotTools } from '../copilot-tools.js';

const SYSTEM = `You are QAAI, an AI QA engineer working inside a QA platform. You
are talking to a QA engineer about one specific project, and you have tools that
read and act on that project.

How you work:

- Use your tools before answering anything factual. Never state a pass rate, a
  flake rate, or whether a test exists without reading it first. If you are
  about to write "it looks like" about something a tool could tell you, call the
  tool instead.
- Before writing any test code, call get_flow_map so you use locators that exist
  on the real page. Guessed selectors are the main reason generated tests are
  brittle, and you have no excuse for guessing.
- You cannot edit the suite. propose_test records a diff for the person to
  accept. Say clearly what you proposed and why; do not describe a proposal as
  though it has been applied.
- Do not claim a test passes unless run_tests actually returned a pass.

How to write tests:

- One test.step() per user-meaningful action, titled in plain English — those
  titles become the timeline the person reads when it fails.
- Assert meaning, not appearance. "the order total equals subtotal plus shipping
  plus tax" is a test; "the heading says Cart" is decoration. The bugs worth
  catching are arithmetic, state transitions, and permissions.
- Locators in order of preference: getByRole with a name, getByLabel,
  getByTestId. Reach for a raw CSS selector only when nothing else can work.
- Never use waitForTimeout or any fixed sleep.
- The code you write is committed to the customer's repository and must run
  under plain \`npx playwright test\`. Never import anything QAAI-specific.

How to talk:

Lead with the answer, then the evidence. Cite test names and run ids so the
person can click through. Keep it short — you are in a side panel, not a
document. When the data does not support a confident answer, say what is
missing rather than hedging.`;

export async function processCopilot(job: CopilotJob): Promise<void> {
  const { orgId, conversationId, projectId, userMessageId } = job;

  const conversation = await prisma.chatConversation.findFirst({
    where: { id: conversationId, orgId },
    select: { id: true, projectId: true },
  });
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`);

  const history = await prisma.chatMessage.findMany({
    where: { conversationId, error: null },
    orderBy: { createdAt: 'asc' },
    take: 40,
    select: { role: true, content: true, pending: true },
  });

  // The assistant row is created up front and marked pending, so the UI has
  // something to stream into rather than a gap where a reply should be.
  const assistantMessage = await prisma.chatMessage.create({
    data: { orgId, conversationId, role: 'assistant', content: '', pending: true },
  });

  const emit = (event: Record<string, unknown>) =>
    publishEvent(orgId, {
      runId: `chat:${conversationId}`,
      type: 'log',
      data: { messageId: assistantMessage.id, ...event },
      at: new Date().toISOString(),
    });

  const tools = buildCopilotTools({
    orgId,
    projectId,
    conversationId,
    messageId: assistantMessage.id,
  });

  try {
    const result = await llm.runToolLoop(
      { orgId, projectId, agent: 'CHAT', subjectId: conversationId },
      {
        system: SYSTEM,
        tier: 'strong',
        effort: 'medium',
        maxTokens: 8000,
        tools,
        messages: history
          .filter((m) => !m.pending && m.content.trim())
          .map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: m.content,
          })),
        onEvent: async (event) => {
          await emit(event as unknown as Record<string, unknown>);
        },
      },
    );

    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        content: result.text || '(no reply)',
        toolCalls: result.calls as unknown as object,
        pending: false,
      },
    });

    logger.info(
      { conversationId, calls: result.calls.length, stopped: result.stoppedBecause },
      'copilot turn finished',
    );
    await emit({ type: 'done', stoppedBecause: result.stoppedBecause });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversationId }, 'copilot turn failed');

    // The failure is written onto the message so the panel can show it. A turn
    // that dies silently looks identical to one still thinking.
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: { content: '', pending: false, error: message },
    });
    await emit({ type: 'error', message });
    throw err;
  } finally {
    void userMessageId;
  }
}
