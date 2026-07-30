'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * Record mode entry point (§C) — the fusion of the agent and the editor.
 *
 * The agent-does-the-tedious-part / you-own-the-output loop, in one button:
 * click Record, a real browser opens, you click through your app, close it, and
 * the recorded Playwright test lands in the editor for you to refine. No API
 * key, no prompt engineering — it just captures what you did.
 *
 * The browser window is the UI while recording, so this component's job is only
 * to start the session, tell the user what is happening, poll for the result,
 * and save it. It deliberately says "close the window to finish" because that
 * is genuinely how you stop — there is no in-app stop button for a window this
 * process does not own.
 */

interface RecordButtonProps {
  projectId: string;
  environmentId: string | null;
  /** Called with the new test id once a recording is saved. */
  onRecorded: (testId: string) => void;
}

type Phase = 'idle' | 'recording' | 'saving' | 'error';

export function RecordButton({ projectId, environmentId, onRecorded }: RecordButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  async function start() {
    if (!environmentId) {
      setError('Add an environment first — recording needs a URL to open.');
      setPhase('error');
      return;
    }

    const name = prompt('Name this recording', 'Recorded flow');
    if (!name) return;

    setError(null);
    setPhase('recording');

    try {
      const { sessionId } = await api<{ sessionId: string }>(`/projects/${projectId}/record`, {
        method: 'POST',
        body: JSON.stringify({ environmentId, name }),
      });
      sessionRef.current = sessionId;

      // Poll until the user closes the browser window (status flips to ready).
      pollRef.current = setInterval(async () => {
        const res = await api<{ status: string; code: string | null; error: string | null }>(
          `/projects/${projectId}/record/${sessionId}`,
        ).catch(() => null);
        if (!res) return;

        if (res.status === 'ready' && res.code) {
          stopPolling();
          await save(name, res.code);
        } else if (res.status === 'error') {
          stopPolling();
          setError(res.error ?? 'Recording failed');
          setPhase('error');
        }
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording');
      setPhase('error');
    }
  }

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  async function save(name: string, code: string) {
    setPhase('saving');
    try {
      const filePath = `recorded/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.spec.ts`;
      const { test } = await api<{ test: { id: string } }>(`/projects/${projectId}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          type: 'E2E',
          feature: 'Recorded',
          priority: 'IMPORTANT',
          code,
          filePath,
          tags: ['recorded'],
        }),
      });
      setPhase('idle');
      onRecorded(test.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the recording');
      setPhase('error');
    }
  }

  async function cancel() {
    stopPolling();
    if (sessionRef.current) {
      await api(`/projects/${projectId}/record/${sessionRef.current}`, { method: 'DELETE' }).catch(
        () => {},
      );
    }
    setPhase('idle');
  }

  if (phase === 'recording') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-flake flex items-center gap-1.5 text-xs">
          <span className="bg-fail inline-block h-2 w-2 animate-pulse rounded-full" />
          Recording — click through your app, then close the browser
        </span>
        <button
          type="button"
          onClick={() => void cancel()}
          className="border-line hover:border-fail rounded-md border px-2 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={phase === 'saving'}
        className="border-line hover:border-accent flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
        title="Click through your app and QAAI writes the test"
      >
        <span className="bg-fail inline-block h-2 w-2 rounded-full" />
        {phase === 'saving' ? 'Saving…' : 'Record'}
      </button>
      {error && <span className="text-fail max-w-xs truncate text-xs">{error}</span>}
    </div>
  );
}
