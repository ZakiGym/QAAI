'use client';

import { useCallback, useRef, useState } from 'react';
import { detectProject, type ProjectDetection } from '@qaai/shared';
import { MAX_LISTED_FILES, SKIP_DIRS, readRepo, type RepoPick } from './funnel';
import type { RepoFile } from '@qaai/shared';
import { cn } from '../../lib/cn';

/**
 * The headline path: hand QAAI your application's source and let it read the
 * shape of the repo.
 *
 * Two things about this are worth stating plainly, because both are unusual and
 * both are what make the step honest.
 *
 * ONE — nothing is uploaded. `detectProject` is a pure function of a file
 * listing that has been sitting in @qaai/shared, fully tested and called by
 * nothing, since it was written. It runs here, in the tab, against the folder
 * the user picked. The screen says so, and the network tab agrees.
 *
 * TWO — almost nothing is READ. Detection needs the bytes of about a dozen
 * manifests and nothing else; every other file contributes its path and its
 * extension. `RepoFile.content` is optional precisely for this, so a 40,000-file
 * monorepo costs a directory walk and a dozen small reads rather than loading a
 * repository into a browser tab as text.
 */

/** `readEntries` yields at most 100 per call and ends with an empty batch. */
function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pump();
      }, reject);
    pump();
  });
}

/**
 * Walk a dropped directory.
 *
 * The prune is at the DIRECTORY, before descending — not a filter over the
 * results. Walking into node_modules and discarding what comes out still costs
 * the walk, and on a real repo that walk is the difference between a folder
 * drop that lands in a second and one that appears to hang.
 */
async function walk(entry: FileSystemEntry, prefix: string, out: RepoPick[]): Promise<void> {
  if (out.length >= MAX_LISTED_FILES) return;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (file) out.push({ path: `${prefix}${entry.name}`, file });
    return;
  }

  if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export interface CodebaseResult {
  detection: ProjectDetection;
  /** Entries the pick contained, before the skips — the honest denominator. */
  seen: number;
  /** Files whose bytes were actually opened. */
  read: number;
  truncated: boolean;
  /** Paths, kept so a project name can be taken from the top folder. */
  paths: string[];
  /**
   * What detection was actually given: every kept path, contents only where a
   * detector needs them. Carried on the result because the SERVER re-runs the
   * same analysis — the browser's pass is for the pre-filled dropdown, and the
   * durable one belongs to the API. Without this the funnel had a detection to
   * show and nothing to upload.
   */
  files: RepoFile[];
}

export function CodebaseDrop({
  result,
  onResult,
}: {
  result: CodebaseResult | null;
  onResult: (result: CodebaseResult | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ingest = useCallback(
    async (picked: RepoPick[]) => {
      if (picked.length === 0) return;
      setReading(true);
      setError(null);
      try {
        const { files, seen, read, truncated } = await readRepo(picked);
        onResult({
          detection: detectProject(files),
          seen,
          read,
          truncated,
          paths: files.map((f) => f.path),
          files,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read that folder');
      } finally {
        setReading(false);
      }
    },
    [onResult],
  );

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);

    // Captured synchronously — the DataTransfer is emptied the moment this
    // handler yields, so an await before this line loses the drop entirely.
    const entries = Array.from(event.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => entry !== null);

    if (entries.length > 0) {
      const picked: RepoPick[] = [];
      for (const entry of entries) await walk(entry, '', picked);
      await ingest(picked);
      return;
    }

    // A browser with no entry API still gives a flat list; a flat list of source
    // files is a worse input than a tree but it is not nothing.
    await ingest(
      Array.from(event.dataTransfer.files).map((file) => ({ path: file.name, file })),
    );
  }

  return (
    <div className="mt-2.5 ml-7">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
        className={cn(
          'block cursor-pointer rounded-lg border-[1.5px] border-dashed px-4 py-6 text-center transition-colors',
          dragging
            ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]'
            : 'border-line-strong hover:border-accent',
        )}
      >
        <span className="block text-[13.5px] font-medium">
          {reading
            ? 'Reading the repo…'
            : result
              ? `${result.seen.toLocaleString()} files looked at`
              : 'Drop your repo folder, or browse'}
        </span>
        <span className="text-ink-faint mt-1.5 block text-[11.5px]">
          {result
            ? `${result.read} manifest${result.read === 1 ? '' : 's'} opened · nothing was uploaded`
            : 'node_modules, build output, lockfiles and binaries are skipped'}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          // @ts-expect-error — non-standard, and the only way to pick a folder.
          webkitdirectory=""
          onChange={(e) =>
            void ingest(
              Array.from(e.target.files ?? []).map((file) => ({
                path: file.webkitRelativePath || file.name,
                file,
              })),
            )
          }
          className="hidden"
        />
      </label>

      <p className="text-ink-faint mt-2 text-[11.5px] leading-relaxed">
        This runs in your browser. QAAI reads the manifests it needs — package.json, go.mod,
        pom.xml and their siblings — and sees every other file only as a path. Nothing is sent
        anywhere.
      </p>

      {error && (
        <p role="alert" className="text-fail mt-2 text-[12px]">
          {error}
        </p>
      )}

      {result && (
        <>
          <DetectionSummary result={result} />
          <button
            type="button"
            onClick={() => {
              onResult(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="text-ink-faint hover:text-ink mt-2.5 text-[12px] transition-colors"
          >
            pick a different folder
          </button>
        </>
      )}
    </div>
  );
}

/**
 * What was found, with the evidence.
 *
 * Detection's own contract is "evidence, not verdicts" — every claim it makes
 * carries the fact that produced it, because the whole point of showing our
 * work is that someone can overrule us knowingly. Rendering only the conclusion
 * would throw away the part that makes the conclusion arguable.
 */
function DetectionSummary({ result }: { result: CodebaseResult }) {
  const { detection } = result;
  const languages = detection.languages.filter((l) => l.fileCount > 0).slice(0, 4);
  const runners = detection.candidates.slice(0, 3);

  return (
    <div className="border-line mt-3 rounded-lg border px-4 py-3.5">
      <p className="text-meta text-ink-faint font-mono tracking-[0.1em] uppercase">
        What the repo says
      </p>

      <dl className="mt-2.5 grid gap-y-2 text-[12.5px] sm:grid-cols-[110px_1fr]">
        <dt className="text-ink-faint">Languages</dt>
        <dd className="text-ink-dim">
          {languages.length === 0 ? (
            <span className="text-ink-faint">none recognised</span>
          ) : (
            languages.map((lang, i) => (
              <span key={lang.language}>
                {i > 0 && ' · '}
                <span className={lang.supportedByGenerator ? undefined : 'text-ink-faint'}>
                  {lang.language.toLowerCase()}
                </span>{' '}
                <span className="text-ink-faint font-mono tabular-nums">{lang.fileCount}</span>
                {/* Naming a language QAAI cannot write tests in is more useful
                    than pretending the repo is not written in it. */}
                {!lang.supportedByGenerator && (
                  <span className="text-ink-faint"> (not generatable)</span>
                )}
              </span>
            ))
          )}
        </dd>

        <dt className="text-ink-faint">Packaging</dt>
        <dd className="text-ink-dim">
          {detection.packageManagers.length === 0 ? (
            <span className="text-ink-faint">none found</span>
          ) : (
            detection.packageManagers
              .slice(0, 3)
              .map((pm) => pm.manager)
              .join(' · ')
          )}
          {detection.monorepo && <span className="text-ink-faint"> · monorepo</span>}
        </dd>

        <dt className="text-ink-faint">Test runner</dt>
        <dd className="text-ink-dim">
          {runners.length === 0 ? (
            <span className="text-ink-faint">
              none configured — QAAI is not guessing one for you
            </span>
          ) : (
            <ul className="space-y-1">
              {runners.map((runner) => (
                <li key={`${runner.runner}:${runner.root}`}>
                  {runner.label}
                  <span className="text-ink-faint font-mono tabular-nums">
                    {' '}
                    {runner.confidence.toFixed(2)}
                  </span>
                  {runner.evidence[0] && (
                    <span className="text-ink-faint"> — {runner.evidence[0].detail}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      {/* Notes are detection's "Not right?" affordance: conflicts it resolved
          and gaps it is admitting to. They are the reason to disagree with it. */}
      {detection.notes.length > 0 && (
        <ul className="text-ink-faint mt-3 space-y-1.5 text-[11.5px] leading-relaxed">
          {detection.notes.slice(0, 3).map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      {detection.warnings.length > 0 && (
        <ul className="text-flake mt-2 space-y-1 text-[11.5px] leading-relaxed">
          {detection.warnings.slice(0, 3).map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}

      {result.truncated && (
        <p className="text-flake mt-2 text-[11.5px] leading-relaxed">
          That folder is larger than {MAX_LISTED_FILES.toLocaleString()} files, so the listing was
          cut short. Every manifest was still read, so the languages and packaging above are
          sound; the file counts are a floor, not a total.
        </p>
      )}
    </div>
  );
}
