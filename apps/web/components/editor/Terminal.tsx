'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { TerminalBuffer, type Line, type SpanStyle, type TerminalColour } from './terminal-buffer';

/**
 * A shell on the machine the test failed on.
 *
 * Read `apps/api/src/lib/pty.ts` before changing anything here; the shape of
 * this panel is decided by two architectural facts it explains at length. The
 * short version, which this component is obliged to tell the user rather than
 * hide:
 *
 *   · It is **not a tty.** Commands are queued and picked up on the agent's
 *     next poll, so there is latency between pressing Enter and anything
 *     happening, and there is no interactivity — no `less`, no prompt, nothing
 *     that reads stdin. The UI therefore looks like a command log, not like a
 *     blinking cursor, because dressing it as a tty would be a promise the
 *     transport cannot keep.
 *   · It exists **only while the run is executing**, on **the customer's own
 *     runners**. Both refusals come back from the API as sentences and are
 *     rendered verbatim — they are the whole answer, and paraphrasing them into
 *     "could not open terminal" is what sends someone to support.
 *
 * Everything with logic in it lives in `terminal-buffer.ts`, which is unit
 * tested. This file is wiring: an EventSource, an input, and a countdown.
 */

/** Kept in step with the API's own limits, which the open call also returns. */
interface SessionLimits {
  maxSessionSeconds: number;
  idleSeconds: number;
  commandTimeoutSeconds: number;
  maxCommands: number;
  maxOutputBytes: number;
}

interface AllowlistEntry {
  command: string;
  forms: string[];
  why: string;
}

interface OpenResponse {
  session: {
    id: string;
    runId: string;
    runnerName: string;
    openedAt: string;
    expiresAt: string;
  };
  key: string;
  limits: SessionLimits;
  allowlist: AllowlistEntry[];
}

interface OpenSession {
  id: string;
  runnerName: string;
  expiresAt: number;
  limits: SessionLimits;
  allowlist: AllowlistEntry[];
}

/**
 * Token classes, written out in full.
 *
 * Tailwind scans source text, so `text-${colour}` would compile to nothing.
 * This is also the enforcement point for "design tokens only": there is no
 * branch here that can produce a colour the theme does not define.
 */
const FG_CLASS: Record<TerminalColour, string> = {
  ink: 'text-ink',
  'ink-dim': 'text-ink-dim',
  'ink-faint': 'text-ink-faint',
  accent: 'text-accent',
  pass: 'text-pass',
  flake: 'text-flake',
  fail: 'text-fail',
};

function spanClass(style: SpanStyle): string {
  return cn(
    style.fg ? FG_CLASS[style.fg] : undefined,
    style.bold && 'font-semibold',
    style.dim && 'opacity-60',
    style.underline && 'underline',
    // Inverse without a background token per colour: swapping to the surface
    // colour on an accent ground is the closest honest rendering.
    style.inverse && 'bg-ink text-surface',
  );
}

/** "4:31" — a countdown reads as a countdown, not as a timestamp. */
function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface TerminalProps {
  runId: string;
  className?: string;
}

export function Terminal({ runId, className }: TerminalProps) {
  const [session, setSession] = useState<OpenSession | null>(null);
  const [opening, setOpening] = useState(false);
  /** The API's own sentence for why this cannot be opened. Never paraphrased. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAllowlist, setShowAllowlist] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /*
   * The key lives in a ref, not in state and not in the URL. It is a bearer
   * capability for the session: putting it in a query string would put it in
   * the access log and the browser history, and putting it in state buys
   * nothing since no render depends on its value.
   */
  const keyRef = useRef<string | null>(null);
  const bufferRef = useRef<TerminalBuffer>(new TerminalBuffer());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Bumped on every write so React re-renders a buffer it cannot see into. */
  const [revision, setRevision] = useState(0);

  const lines: Line[] = useMemo(() => {
    void revision;
    return bufferRef.current.lines();
  }, [revision]);

  const write = useCallback((chunk: string) => {
    bufferRef.current.write(chunk);
    setRevision((value) => value + 1);
  }, []);

  const open = useCallback(async () => {
    setOpening(true);
    setRefusal(null);
    setClosedReason(null);
    try {
      const response = await api<OpenResponse>(`/terminal/runs/${runId}/sessions`, {
        method: 'POST',
      });
      keyRef.current = response.key;
      bufferRef.current = new TerminalBuffer();
      setRevision((value) => value + 1);
      setSession({
        id: response.session.id,
        runnerName: response.session.runnerName,
        expiresAt: new Date(response.session.expiresAt).getTime(),
        limits: response.limits,
        allowlist: response.allowlist,
      });
    } catch (error) {
      // The API's refusals are the product here: which of the several reasons
      // this run cannot have a shell, and what to do about each.
      setRefusal(
        error instanceof ApiError ? error.message : 'Could not reach the API to open a session.',
      );
    } finally {
      setOpening(false);
    }
  }, [runId]);

  const close = useCallback(async () => {
    if (!session || !keyRef.current) return;
    const key = keyRef.current;
    keyRef.current = null;
    setSession(null);
    setClosedReason('You closed this session.');
    await api(`/terminal/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { 'x-qaai-terminal-key': key },
      // A failed close is not worth an error banner: the session expires on its
      // own, which is the whole point of a hard limit.
    }).catch(() => {});
  }, [session]);

  // ─── The stream ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!session) return;

    /*
     * `withCredentials` because the stream is authorised by the cockpit session
     * cookie, not by the terminal key — EventSource cannot set a header, and
     * the alternative would be the key in the URL.
     */
    const source = new EventSource(`${API_URL}/terminal/sessions/${session.id}/stream`, {
      withCredentials: true,
    });

    const onCommand = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { argv: string[] };
      write(`\x1b[34m$\x1b[0m ${data.argv.join(' ')}\n`);
    };
    const onOutput = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { chunk: string; stream: 'stdout' | 'stderr' };
      // stderr is coloured here rather than by the program, because a program
      // that is not on a tty usually emits no colour at all — and "which stream
      // was this on" is exactly the distinction a log loses.
      write(data.stream === 'stderr' ? `\x1b[31m${data.chunk}\x1b[0m` : data.chunk);
    };
    const onTruncated = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { limit: number };
      write(`\n\x1b[33m[output cut at ${Math.round(data.limit / 1024)} KB]\x1b[0m\n`);
    };
    const onExit = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { exitCode: number | null; status: string };
      if (data.status === 'ABANDONED') {
        write(`\x1b[33m[abandoned — it ran past the command timeout]\x1b[0m\n`);
      } else if (data.exitCode !== 0) {
        write(`\x1b[31m[exit ${data.exitCode ?? '?'}]\x1b[0m\n`);
      }
      setBusy(false);
    };
    const onClosed = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { reason: string };
      keyRef.current = null;
      setClosedReason(data.reason);
      setSession(null);
      setBusy(false);
    };

    source.addEventListener('command', onCommand);
    source.addEventListener('output', onOutput);
    source.addEventListener('truncated', onTruncated);
    source.addEventListener('exit', onExit);
    source.addEventListener('closed', onClosed);

    return () => {
      source.removeEventListener('command', onCommand);
      source.removeEventListener('output', onOutput);
      source.removeEventListener('truncated', onTruncated);
      source.removeEventListener('exit', onExit);
      source.removeEventListener('closed', onClosed);
      source.close();
    };
  }, [session, write]);

  /** The countdown, ticking only while there is something to count down. */
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [session]);

  /** Follow the tail, the way every terminal does. */
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [revision]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const command = input.trim();
      if (!command || !session || !keyRef.current || busy) return;
      setBusy(true);
      setInput('');
      try {
        await api(`/terminal/sessions/${session.id}/commands`, {
          method: 'POST',
          headers: { 'x-qaai-terminal-key': keyRef.current },
          body: JSON.stringify({ command }),
        });
        // The `command` event echoes the parsed argv, so nothing is echoed here
        // — what appears is what the server will actually run, not what was
        // typed. The two differ (`ls tests` runs `ls -la tests`) and showing the
        // typed line would hide that.
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : 'Could not reach the API.';
        write(`\x1b[31m${message}\x1b[0m\n`);
        setBusy(false);
      }
    },
    [busy, input, session, write],
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!session) {
    return (
      <div
        className={cn(
          'rounded-lg border border-line bg-surface-1 p-4 text-body-sm text-ink-dim',
          className,
        )}
      >
        <p className="text-ink">Open a shell on the machine this run executed on.</p>
        <p className="mt-1.5 max-w-prose text-micro">
          A session lasts ten minutes, closes after two minutes idle, and can only run a fixed list
          of read-only commands. Every session and every command is written to your audit log.
        </p>

        {refusal ? (
          <p className="mt-3 rounded-md border border-line bg-surface-2 p-3 text-micro text-flake">
            {refusal}
          </p>
        ) : null}
        {closedReason ? (
          <p className="mt-3 text-micro text-ink-faint">{closedReason}</p>
        ) : null}

        <button
          type="button"
          onClick={() => void open()}
          disabled={opening}
          className="mt-3 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-body-sm text-ink hover:border-accent disabled:opacity-50"
        >
          {opening ? 'Opening…' : 'Open a session'}
        </button>
      </div>
    );
  }

  const secondsLeft = Math.max(0, Math.round((session.expiresAt - now) / 1000));

  return (
    <div className={cn('flex flex-col rounded-lg border border-line bg-surface-1', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <span className="font-mono text-micro text-ink">{session.runnerName}</span>
        <span className="text-micro text-ink-faint">
          Commands are queued and picked up by the agent — this is not a live tty.
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span
            className={cn(
              'font-mono text-micro tabular-nums',
              secondsLeft <= 60 ? 'text-flake' : 'text-ink-dim',
            )}
            title="This session closes when the countdown reaches zero, or after two minutes idle."
          >
            {remaining(session.expiresAt, now)}
          </span>
          <button
            type="button"
            onClick={() => setShowAllowlist((value) => !value)}
            className="text-micro text-ink-dim underline decoration-line-strong underline-offset-2 hover:text-ink"
          >
            {showAllowlist ? 'Hide commands' : 'What can I run?'}
          </button>
          <button
            type="button"
            onClick={() => void close()}
            className="text-micro text-ink-dim hover:text-fail"
          >
            Close
          </button>
        </span>
      </header>

      {showAllowlist ? (
        <dl className="grid gap-x-4 gap-y-1 border-b border-line bg-surface-2 px-3 py-2 text-micro sm:grid-cols-[auto_1fr]">
          {session.allowlist.map((entry) => (
            <div key={entry.command} className="contents">
              <dt className="font-mono text-ink">{entry.forms.join('  ·  ')}</dt>
              <dd className="text-ink-faint">{entry.why}</dd>
            </div>
          ))}
          <div className="contents">
            <dt className="font-mono text-ink-faint">—</dt>
            <dd className="text-ink-faint">
              Nothing that writes, fetches a URL, or prints the environment: the run&rsquo;s
              environment holds your injected secrets.
            </dd>
          </div>
        </dl>
      ) : null}

      <div
        ref={scrollRef}
        className="max-h-96 min-h-40 overflow-auto px-3 py-2 font-mono text-micro leading-relaxed"
      >
        {bufferRef.current.droppedLines > 0 ? (
          <p className="text-ink-faint">
            [{bufferRef.current.droppedLines} earlier lines dropped from the scrollback]
          </p>
        ) : null}
        {lines.map((line, index) => (
          // Index keys are correct here and only here: this list is append-only
          // and never reordered, so an index IS the line's identity.
          <div key={index} className="whitespace-pre-wrap break-all text-ink">
            {line.spans.map((span, spanIndex) => (
              <span key={spanIndex} className={spanClass(span.style)}>
                {span.text}
              </span>
            ))}
            {line.truncated ? <span className="text-ink-faint"> […line truncated]</span> : null}
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-line px-3 py-2">
        <span aria-hidden className="font-mono text-micro text-accent">
          $
        </span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label="Command"
          placeholder={busy ? 'Waiting for the agent…' : 'ls tests'}
          className="min-w-0 flex-1 bg-transparent font-mono text-micro text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="rounded-sm border border-line px-2 py-0.5 text-meta text-ink-dim disabled:opacity-40"
        >
          Run
        </button>
      </form>
    </div>
  );
}
