'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, api } from '../lib/api';

/**
 * The copilot panel (§3.5) — the Claude Code half of the product.
 *
 * Three things it must do, and does:
 *  - Show tool calls as they happen, not a spinner. "reading order-total.spec.ts"
 *    is the difference between a black box and a colleague.
 *  - Never let the agent write. Proposals render as a diff with accept/reject.
 *  - Say plainly when a turn failed, rather than sitting there looking busy.
 */

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

interface Message {
  id: string;
  role: string;
  content: string;
  toolCalls: ToolCall[] | null;
  pending: boolean;
  error: string | null;
  createdAt: string;
}

interface Proposal {
  id: string;
  messageId: string | null;
  testId: string | null;
  filePath: string;
  oldCode: string;
  newCode: string;
  rationale: string;
  testName: string;
  testType: string;
  state: 'PENDING' | 'APPLIED' | 'REJECTED';
}

/** Human labels — `get_run_results` in a transcript reads like a stack trace. */
const TOOL_LABEL: Record<string, string> = {
  list_tests: 'Listing tests',
  read_test: 'Reading test',
  get_run_results: 'Reading run results',
  run_tests: 'Running tests',
  get_flow_map: 'Reading the app map',
  propose_test: 'Proposing a change',
};

/** Minimal line diff. Enough to review a test file; not a merge tool. */
function diffLines(before: string, after: string): Array<{ kind: ' ' | '-' | '+'; text: string }> {
  const a = before ? before.split('\n') : [];
  const b = after.split('\n');

  // Longest common subsequence. Test files are small enough that the O(n·m)
  // table is fine, and it produces a far more readable diff than a naive walk.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: Array<{ kind: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: '-', text: a[i]! });
      i++;
    } else {
      out.push({ kind: '+', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: '-', text: a[i++]! });
  while (j < b.length) out.push({ kind: '+', text: b[j++]! });

  return out;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  return (
    <pre className="border-line max-h-72 overflow-auto rounded-md border font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.kind === '+'
              ? 'bg-pass/10 text-pass px-2'
              : line.kind === '-'
                ? 'bg-fail/10 text-fail px-2'
                : 'text-ink-faint px-2'
          }
        >
          <span className="select-none opacity-50">{line.kind}</span> {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

export interface AgentPanelProps {
  projectId: string;
  /** Called after a proposal is applied, so the file tree can refresh. */
  onApplied?: () => void;
}

export function AgentPanel({ projectId, onApplied }: AgentPanelProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTool, setLiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (id: string) => {
    const data = await api<{ messages: Message[]; proposals: Proposal[] }>(
      `/copilot/conversations/${id}`,
    );
    setMessages(data.messages);
    setProposals(data.proposals);
    return data;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveTool]);

  // Follow the turn: SSE for tool activity, plus a poll because the final
  // message lands in the database, not on the stream.
  useEffect(() => {
    if (!conversationId || !busy) return;

    const source = new EventSource(`${API_URL}/copilot/conversations/${conversationId}/events`, {
      withCredentials: true,
    });

    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          data: { type?: string; name?: string; message?: string };
        };
        const d = parsed.data;
        if (d.type === 'tool_start') setLiveTool(TOOL_LABEL[d.name ?? ''] ?? d.name ?? null);
        if (d.type === 'tool_end') setLiveTool(null);
        if (d.type === 'done' || d.type === 'error') {
          setLiveTool(null);
          setBusy(false);
          void load(conversationId);
        }
      } catch {
        /* a malformed frame is not worth surfacing */
      }
    });

    const poll = setInterval(async () => {
      const data = await load(conversationId).catch(() => null);
      if (data && !data.messages.some((m) => m.pending)) {
        setBusy(false);
        setLiveTool(null);
      }
    }, 2500);

    return () => {
      source.close();
      clearInterval(poll);
    };
  }, [conversationId, busy, load]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;

    setDraft('');
    setError(null);
    setBusy(true);

    // Render the user's turn immediately; waiting for the round trip makes the
    // panel feel broken on a slow connection.
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
        toolCalls: null,
        pending: false,
        error: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const res = await api<{ conversationId: string }>('/copilot/messages', {
        method: 'POST',
        body: JSON.stringify({ projectId, conversationId, message: text }),
      });
      setConversationId(res.conversationId);
      await load(res.conversationId);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Could not send');
    }
  }

  async function decide(proposal: Proposal, accept: boolean) {
    try {
      await api(`/copilot/proposals/${proposal.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ accept }),
      });
      if (conversationId) await load(conversationId);
      if (accept) onApplied?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-line flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-ink-faint text-[11px] font-semibold tracking-wider uppercase">
          Agent
        </span>
        {conversationId && (
          <button
            type="button"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
              setProposals([]);
            }}
            className="text-ink-faint hover:text-ink ml-auto text-[11px]"
          >
            New chat
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="text-ink-faint space-y-3 text-xs">
            <p>Ask the agent to work on this project&rsquo;s tests. It can:</p>
            <ul className="space-y-1">
              <li>· read and run your tests</li>
              <li>· explain why something failed</li>
              <li>· propose new tests or fixes for you to approve</li>
            </ul>
            <p className="text-ink-faint/70 pt-1">
              Try: &ldquo;why did the checkout test fail?&rdquo;
            </p>
          </div>
        )}

        {messages.map((message) => {
          const attached = proposals.filter((p) => p.messageId === message.id);

          return (
            <div key={message.id}>
              {message.role === 'user' ? (
                <div className="bg-surface-2 ml-6 rounded-lg px-3 py-2 text-sm">
                  {message.content}
                </div>
              ) : (
                <div className="space-y-2">
                  {message.toolCalls?.map((call) => (
                    <div
                      key={call.id}
                      className={`flex items-center gap-2 rounded border px-2 py-1 font-mono text-[10px] ${
                        call.isError ? 'border-fail/40 text-fail' : 'border-line text-ink-faint'
                      }`}
                    >
                      <span>{call.isError ? '✕' : '✓'}</span>
                      <span>{TOOL_LABEL[call.name] ?? call.name}</span>
                    </div>
                  ))}

                  {message.error ? (
                    <p className="border-fail/40 bg-fail/10 text-fail rounded-md border p-2 text-xs">
                      {message.error}
                    </p>
                  ) : (
                    message.content && (
                      <p className="text-ink-dim text-sm leading-relaxed whitespace-pre-wrap">
                        {message.content}
                      </p>
                    )
                  )}

                  {attached.map((proposal) => (
                    <div
                      key={proposal.id}
                      className="border-line bg-surface-1 rounded-lg border p-3"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <span className="font-mono text-[11px]">{proposal.filePath}</span>
                        <span className="text-ink-faint ml-auto font-mono text-[10px]">
                          {proposal.testId ? 'edit' : 'new file'}
                        </span>
                      </div>

                      <p className="text-ink-dim mb-2 text-xs">{proposal.rationale}</p>

                      <DiffView before={proposal.oldCode} after={proposal.newCode} />

                      {proposal.state === 'PENDING' ? (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void decide(proposal, true)}
                            className="bg-accent rounded-md px-2.5 py-1 text-xs font-medium text-white"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(proposal, false)}
                            className="border-line rounded-md border px-2.5 py-1 text-xs"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <p className="text-ink-faint mt-2 font-mono text-[10px]">
                          {proposal.state.toLowerCase()}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {liveTool && (
          <div className="text-ink-faint flex items-center gap-2 font-mono text-[10px]">
            <span className="bg-accent inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
            {liveTool}…
          </div>
        )}

        {busy && !liveTool && <p className="text-ink-faint text-xs">Thinking…</p>}
        {error && <p className="text-fail text-xs">{error}</p>}

        <div ref={bottomRef} />
      </div>

      <div className="border-line shrink-0 border-t p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift-Enter is a newline — chat convention.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder="Ask the agent…"
          disabled={busy}
          className="border-line bg-surface-1 focus:border-accent w-full resize-none rounded-md border px-2.5 py-2 text-sm outline-none disabled:opacity-50"
        />
      </div>
    </div>
  );
}
