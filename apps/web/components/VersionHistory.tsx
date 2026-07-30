'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DiffView } from './DiffView';

/**
 * Version history for one test.
 *
 * Every save already wrote a TestVersion — a human edit, a generated test, an
 * applied heal — and nothing has ever shown them. That made the provenance
 * question ("who changed this, and why") unanswerable from inside the product,
 * which is the wrong answer for a tool whose whole premise is that an agent
 * edits your code.
 *
 * Selecting a version diffs it against what is on screen now, so "what did the
 * healer actually change" is one click rather than an archaeology exercise.
 */

interface Version {
  id: string;
  version: number;
  source: string;
  message: string | null;
  authorId: string | null;
  createdAt: string;
  code?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  HUMAN: 'Edited by hand',
  GENERATOR: 'Written by the generator',
  HEALER: 'Applied heal',
  AGENT: 'Agent proposal',
  IMPORT: 'Imported',
};

const SOURCE_TINT: Record<string, string> = {
  HUMAN: 'text-ink-dim',
  GENERATOR: 'text-accent',
  HEALER: 'text-flake',
  AGENT: 'text-accent-2',
  IMPORT: 'text-ink-faint',
};

export interface VersionHistoryProps {
  projectId: string;
  testId: string;
  filePath: string;
  /** The editor's current buffer — the right-hand side of every diff. */
  currentCode: string;
  onClose: () => void;
}

export function VersionHistory({
  projectId,
  testId,
  filePath,
  currentCode,
  onClose,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    void api<{ versions: Version[] }>(`/projects/${projectId}/tests/${testId}/versions`)
      .then((d) => setVersions(d.versions))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [projectId, testId]);

  /** The list endpoint omits code to stay small; fetch it when one is picked. */
  async function pick(version: Version) {
    if (version.code !== undefined) {
      setSelected(version);
      return;
    }
    const full = await api<{ version: Version }>(
      `/projects/${projectId}/tests/${testId}/versions/${version.id}`,
    ).catch(() => null);
    setSelected(full?.version ?? { ...version, code: '' });
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-8"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`History of ${filePath}`}
        className="border-line bg-surface-1 grid h-full max-h-[80vh] w-full max-w-5xl grid-cols-[280px_1fr] overflow-hidden rounded-lg border shadow-2xl"
      >
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          <div className="border-line flex items-baseline gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-medium">History</h2>
            <span className="text-ink-faint truncate font-mono text-[10px]">{filePath}</span>
          </div>

          {loading && <p className="text-ink-faint px-4 py-4 text-xs">Loading…</p>}
          {!loading && versions.length === 0 && (
            <p className="text-ink-faint px-4 py-4 text-xs">No versions recorded yet.</p>
          )}

          {versions.map((version) => (
            <button
              key={version.id}
              type="button"
              onClick={() => void pick(version)}
              className={`border-line/60 flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left ${
                selected?.id === version.id ? 'bg-surface-2' : 'hover:bg-surface'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px]">v{version.version}</span>
                <span className={`text-[11px] ${SOURCE_TINT[version.source] ?? 'text-ink-dim'}`}>
                  {SOURCE_LABEL[version.source] ?? version.source}
                </span>
              </div>
              {version.message && (
                <span className="text-ink-faint line-clamp-2 text-[11px]">{version.message}</span>
              )}
              <span className="text-ink-faint text-[10px]">
                {new Date(version.createdAt).toLocaleString()}
              </span>
            </button>
          ))}
        </aside>

        <section className="grid min-h-0 grid-rows-[auto_1fr]">
          <div className="border-line flex items-center gap-3 border-b px-4 py-2.5">
            <p className="text-ink-dim text-xs">
              {selected
                ? `v${selected.version} → the version open in your editor`
                : 'Pick a version to see what changed'}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="text-ink-faint hover:text-ink ml-auto text-sm"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0">
            {selected ? (
              <DiffView
                original={selected.code ?? ''}
                modified={currentCode}
                language={filePath.endsWith('.json') ? 'json' : 'typescript'}
              />
            ) : (
              <p className="text-ink-faint p-6 text-sm">
                Every save is recorded — by you, by the generator, and by an applied heal.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
