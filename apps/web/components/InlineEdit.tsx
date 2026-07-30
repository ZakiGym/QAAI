'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { DiffView } from './DiffView';

/**
 * Inline edit (⌘K) — describe a change, review the diff, accept it.
 *
 * Two states in one component, because they are one thought: a prompt bar, then
 * the result as a diff. The user never sees raw model output — they see what the
 * file would become, and nothing is written until they accept.
 *
 * The request is queued (the API holds no model client), so this polls. A slow
 * answer is the normal case, not an error, and the copy says so.
 */

interface EditState {
  ready: boolean;
  failed: boolean;
  oldCode: string;
  newCode: string;
  rationale: string;
  state: string;
}

export interface InlineEditProps {
  projectId: string;
  testId: string;
  /** The highlighted text, and where it was. */
  selection: { text: string; startLine: number; endLine: number };
  language: string;
  onAccept: (code: string) => void;
  onClose: () => void;
}

export function InlineEdit({
  projectId,
  testId,
  selection,
  language,
  onAccept,
  onClose,
}: InlineEditProps) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EditState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { proposalId } = await api<{ proposalId: string }>(
        `/projects/${projectId}/tests/${testId}/inline-edit`,
        {
          method: 'POST',
          body: JSON.stringify({
            instruction: instruction.trim(),
            selection: selection.text,
            selectionStartLine: selection.startLine,
            selectionEndLine: selection.endLine,
          }),
        },
      );

      // Poll until the worker fills newCode, or it reports a failure.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled.current) return;
        const { edit } = await api<{ edit: EditState }>(
          `/projects/${projectId}/inline-edit/${proposalId}`,
        );
        if (edit.failed) {
          setError(edit.rationale || 'The agent could not make that change');
          setBusy(false);
          return;
        }
        if (edit.ready) {
          setResult(edit);
          setBusy(false);
          return;
        }
      }
      setError('The edit timed out. Try a narrower instruction.');
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The edit failed');
      setBusy(false);
    }
  }

  return (
    <div className="border-line bg-surface-1 absolute inset-x-4 top-4 z-20 overflow-hidden rounded-lg border shadow-2xl">
      <form onSubmit={submit} className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-accent shrink-0 font-mono text-[11px]">⌘K</span>
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          disabled={busy || result !== null}
          placeholder={
            selection.text
              ? `Change the selected ${selection.endLine - selection.startLine + 1} line(s)…`
              : 'Describe a change to this test…'
          }
          className="placeholder:text-ink-faint flex-1 bg-transparent text-sm outline-none disabled:opacity-60"
        />
        {busy && <span className="text-ink-faint shrink-0 text-xs">Thinking…</span>}
        {!busy && !result && (
          <button
            type="submit"
            disabled={!instruction.trim()}
            className="bg-accent shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Generate
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-ink-faint hover:text-ink shrink-0 px-1 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </form>

      {error && (
        <p className="border-line text-fail border-t px-3 py-2 text-xs">{error}</p>
      )}

      {result && (
        <div className="border-line border-t">
          <p className="text-ink-dim px-3 py-2 text-xs">{result.rationale}</p>
          <div className="border-line h-64 border-t">
            <DiffView
              original={result.oldCode}
              modified={result.newCode}
              language={language}
              inline
            />
          </div>
          <div className="border-line flex items-center gap-2 border-t px-3 py-2">
            <button
              type="button"
              onClick={() => onAccept(result.newCode)}
              className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setInstruction('');
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              className="border-line hover:border-accent rounded-md border px-3 py-1.5 text-xs"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-ink-faint hover:text-ink ml-auto text-xs"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
