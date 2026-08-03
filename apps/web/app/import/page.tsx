'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, ApiError, type Project } from '../../lib/api';
import { useProject } from '../../components/shell/ProjectContext';
import { TestsHeader } from '../../components/TestsHeader';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Page, SectionLabel } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Suite import (§7) — the migration wedge, on the landing page as a headline.
 *
 * Drop your Cypress/Selenium/… suite → QAAI detects the framework, converts to
 * Playwright, and reports the coverage gained. Detection is instant and shown
 * before you commit; the guess is never binding — you can override it.
 *
 * The dropzone is a real dropzone. It has always LOOKED like one — dashed
 * border, "or a whole folder" — and had no drop handler at all, so dropping a
 * suite on it navigated the browser away to the first file. Folders come in
 * through `webkitGetAsEntry`, which is the only way a drop can carry a
 * directory; the file input alone cannot.
 */

interface Detection {
  framework: string;
  confidence: number;
  alternatives: Array<{ framework: string; score: number }>;
  evidence: string[];
  fileCount: number;
}

const FRAMEWORK_LABEL: Record<string, string> = {
  CYPRESS: 'Cypress',
  PLAYWRIGHT: 'Playwright',
  WEBDRIVERIO: 'WebdriverIO',
  PUPPETEER: 'Puppeteer',
  SELENIUM_JAVA: 'Selenium (Java)',
  SELENIUM_PYTHON: 'Selenium (Python)',
  SELENIUM_CSHARP: 'Selenium (C#)',
  SELENIUM_RUBY: 'Selenium (Ruby)',
  SELENIUM_JS: 'Selenium (JavaScript)',
  TESTCAFE: 'TestCafe',
  NIGHTWATCH: 'Nightwatch',
  ROBOT: 'Robot Framework',
  POSTMAN: 'Postman / Newman',
  KARATE: 'Karate',
  GHERKIN: 'Cucumber / Gherkin',
  UNKNOWN: 'Unknown',
};

const OVERRIDES = Object.keys(FRAMEWORK_LABEL).filter((f) => f !== 'UNKNOWN');

/** What an unfilled base URL becomes. Stated in the UI rather than only here. */
const DEFAULT_BASE_URL = 'http://localhost:3000';

/**
 * Folders nobody means to import.
 *
 * Someone dropping a repo root drops their dependencies with it, and a
 * node_modules walk is tens of thousands of files read into memory as text
 * before anything is sent. The cap below is the same guard from the other end.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo']);
const MAX_FILES = 2000;

type Phase = 'upload' | 'detected' | 'converting' | 'done' | 'error';

/** One dropped or picked file, with the path the API should see it under. */
interface Picked {
  path: string;
  file: File;
}

/** `readEntries` yields at most 100 at a time and signals the end with an empty batch. */
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

async function walk(entry: FileSystemEntry, prefix: string, out: Picked[]): Promise<void> {
  if (out.length >= MAX_FILES) return;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: `${prefix}${entry.name}`, file });
    return;
  }

  if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export default function ImportPage() {
  const router = useRouter();
  /**
   * Which project this imports into is the shell's answer, not `projects[0]`.
   * Someone with three apps under test was silently importing a Cypress suite
   * into whichever project happened to sort first.
   */
  const { project, loading: projectsLoading, reload } = useProject();
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [phase, setPhase] = useState<Phase>('upload');
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [framework, setFramework] = useState<string>('');
  const [overriding, setOverriding] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [convertedCount, setConvertedCount] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Import used to require a project to already exist — so someone arriving WITH
   * a Cypress suite and nothing else hit a screen that silently did nothing.
   * When there is no project, these fields appear and one is created on the way
   * through.
   */
  const [newProjectName, setNewProjectName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  /** The project this page created, before the shell's list has caught up. */
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const activeProjectId = createdProject?.id ?? project?.id ?? null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  /** Read the picked files as text and name the project after what was dropped. */
  const ingest = useCallback(
    async (picked: Picked[]) => {
      if (picked.length === 0) return;
      setReading(true);
      try {
        const read = await Promise.all(
          picked.slice(0, MAX_FILES).map(
            ({ path, file }) =>
              new Promise<{ path: string; content: string }>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve({ path, content: String(reader.result ?? '') });
                reader.onerror = () => resolve({ path, content: '' });
                reader.readAsText(file);
              }),
          ),
        );
        setFiles(read);
        setPhase('upload');
        setDetection(null);
        setBatchId(null);
        setError(null);

        setNewProjectName((current) => {
          if (current) return current;
          const top = read.map((f) => f.path.split('/')[0]).find((seg) => seg && !seg.includes('.'));
          return top ? top.replace(/[-_]/g, ' ') : 'Imported tests';
        });
      } finally {
        setReading(false);
      }
    },
    [],
  );

  function onPick(list: FileList | null) {
    if (!list) return;
    void ingest(
      Array.from(list).map((file) => ({ path: file.webkitRelativePath || file.name, file })),
    );
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);

    // The entries have to be captured synchronously — the DataTransfer is
    // emptied the moment this handler yields.
    const entries = Array.from(event.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => entry !== null);

    if (entries.length > 0) {
      const picked: Picked[] = [];
      for (const entry of entries) await walk(entry, '', picked);
      void ingest(picked);
      return;
    }

    // A browser with no entry API still gives us the flat file list.
    void ingest(Array.from(event.dataTransfer.files).map((file) => ({ path: file.name, file })));
  }

  async function detect() {
    if (files.length === 0) return;
    setError(null);
    try {
      // No project yet? Make one, plus an environment for the tests to run
      // against later. Imported tests are converted to Playwright.
      let targetId = activeProjectId;
      if (!targetId) {
        const created = await api<{ project: Project }>('/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: newProjectName.trim() || 'Imported tests',
            primaryLanguage: 'TYPESCRIPT',
            primaryFramework: 'PLAYWRIGHT',
          }),
        });
        targetId = created.project.id;
        await api(`/projects/${targetId}/environments`, {
          method: 'POST',
          body: JSON.stringify({
            name: 'local',
            kind: 'LOCAL',
            baseUrl: newBaseUrl.trim() || DEFAULT_BASE_URL,
          }),
        }).catch(() => {
          /* the suite still imports without an environment; runs need one later */
        });
        setCreatedProject(created.project);
        // So the switcher in the sidebar knows about it too.
        void reload();
      }

      const res = await api<{ batch: { id: string }; detection: Detection }>(
        `/projects/${targetId}/import`,
        { method: 'POST', body: JSON.stringify({ files }) },
      );
      setBatchId(res.batch.id);
      setDetection(res.detection);
      setFramework(res.detection.framework);
      setOverriding(false);
      setPhase('detected');
    } catch (err) {
      // The page no longer fetches /projects itself, so this is where a
      // signed-out session surfaces.
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Detection failed');
      setPhase('error');
    }
  }

  const follow = useCallback((id: string) => {
    const source = new EventSource(`${API_URL}/import/${id}/events`, { withCredentials: true });
    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data: { message?: string } };
        if (parsed.data.message) setLog((prev) => [...prev, parsed.data.message!].slice(-200));
      } catch {
        /* ignore */
      }
    });
    const poll = setInterval(async () => {
      const res = await api<{
        batch: {
          state: string;
          convertedCount: number;
          summary: string | null;
          error: string | null;
        };
      }>(`/import/${id}`).catch(() => null);
      if (!res) return;
      if (res.batch.state === 'DONE') {
        clearInterval(poll);
        source.close();
        setConvertedCount(res.batch.convertedCount);
        setSummary(res.batch.summary);
        setPhase('done');
      } else if (res.batch.state === 'ERRORED') {
        clearInterval(poll);
        source.close();
        setError(res.batch.error ?? 'Conversion failed');
        setPhase('error');
      }
    }, 2000);
    return () => {
      clearInterval(poll);
      source.close();
    };
  }, []);

  async function convert() {
    if (!batchId) return;
    setPhase('converting');
    setLog([]);
    try {
      await api(`/import/${batchId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ framework }),
      });
      follow(batchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start conversion');
      setPhase('error');
    }
  }

  const showDropzone = phase !== 'converting' && phase !== 'done';

  return (
    <Page width="full">
      <TestsHeader />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-10 pt-8 pb-16">
          <p className="text-ink-dim text-[13.5px] leading-relaxed">
            Drop a suite; QAAI detects the framework, converts to Playwright, and reports the
            coverage gained. The guess is never binding.
          </p>

          {showDropzone && (
            <>
              <label
                htmlFor="files"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => void onDrop(e)}
                className={cn(
                  'mt-4 block cursor-pointer rounded-xl border-[1.5px] border-dashed p-9 text-center transition-colors',
                  dragging
                    ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]'
                    : 'border-line-strong hover:border-accent',
                )}
              >
                <span className="block text-[14px] font-medium">
                  {reading
                    ? 'Reading…'
                    : files.length > 0
                      ? `${files.length} file${files.length === 1 ? '' : 's'} selected`
                      : 'Drop a suite folder'}
                </span>
                <span className="text-ink-faint mt-1.5 block text-[12px]">
                  Cypress, Selenium, WebdriverIO, TestCafe, Postman, Cucumber… or{' '}
                  <span className="text-accent">browse</span>
                </span>
                <input
                  id="files"
                  type="file"
                  multiple
                  // @ts-expect-error — non-standard but widely supported folder upload
                  webkitdirectory=""
                  onChange={(e) => onPick(e.target.files)}
                  className="hidden"
                />
              </label>
              <p className="text-ink-faint mt-2 text-center text-[11.5px]">
                Nothing leaves your machine except the file contents, sent to your QAAI instance.
              </p>
            </>
          )}

          {/* No project yet — name the one this import will create. */}
          {files.length > 0 && !projectsLoading && !activeProjectId && (
            <div className="border-line mt-5 space-y-3 rounded-lg border p-4">
              <SectionLabel>New project</SectionLabel>
              <p className="text-ink-dim text-[12px]">
                You have no project yet, so this import will create one.
              </p>
              <Field
                aria-label="Project name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
              />
              <Field
                aria-label="Base URL"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://staging.example.com (where these tests run)"
                // The default was silent: leaving this blank quietly pointed the
                // environment at localhost, which is nobody's staging server.
                hint={`Leave this blank and the environment is created against ${DEFAULT_BASE_URL}.`}
                className="font-mono"
              />
            </div>
          )}

          {files.length > 0 && phase !== 'detected' && phase !== 'converting' && phase !== 'done' && (
            <Button variant="primary" onClick={() => void detect()} className="mt-4 w-full">
              Detect the framework
            </Button>
          )}

          {detection && phase !== 'upload' && (
            <section className="border-line mt-5 rounded-lg border px-[18px] py-4">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="text-micro text-accent rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2 py-[3px] font-mono font-semibold tracking-[0.05em] tabular-nums">
                  {detection.framework} · {detection.confidence.toFixed(2)}
                </span>
                <span className="text-ink-dim min-w-0 text-[13px]">
                  <span className="tabular-nums">{detection.fileCount}</span> file
                  {detection.fileCount === 1 ? '' : 's'}
                  {detection.evidence.length > 0 && <> · evidence: {detection.evidence.join(', ')}</>}
                </span>
                {phase === 'detected' && (
                  <span className="text-ink-faint ml-auto font-mono text-[10.5px]">
                    wrong?{' '}
                    <button
                      type="button"
                      onClick={() => setOverriding((open) => !open)}
                      aria-expanded={overriding}
                      className="text-accent hover:underline"
                    >
                      override
                    </button>
                  </span>
                )}
              </div>

              {phase === 'detected' && overriding && (
                <div className="mt-3">
                  <label htmlFor="override" className="text-ink-faint mb-1.5 block text-[11.5px]">
                    Convert as
                    {detection.alternatives.length > 0 && (
                      <>
                        {' '}
                        — it also looked like{' '}
                        {detection.alternatives
                          .slice(0, 2)
                          .map((a) => FRAMEWORK_LABEL[a.framework] ?? a.framework)
                          .join(', ')}
                      </>
                    )}
                  </label>
                  <select
                    id="override"
                    value={framework}
                    onChange={(e) => setFramework(e.target.value)}
                    className="border-line bg-surface focus:border-accent text-body-sm w-full rounded-md border px-3 py-2 outline-none"
                  >
                    {OVERRIDES.map((f) => (
                      <option key={f} value={f}>
                        {FRAMEWORK_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(phase === 'converting' || phase === 'done') && (
                <div
                  ref={logRef}
                  role="log"
                  aria-live="polite"
                  className="border-line text-ink-faint mt-3 max-h-[120px] overflow-y-auto rounded-lg border px-3 py-2.5 font-mono text-[10.5px] leading-[1.7]"
                >
                  {log.length === 0 ? (
                    <p>Starting the converter…</p>
                  ) : (
                    log.map((line, i) => (
                      // A skip or a not-a-valid-X is not an error, but it is the
                      // one line in a hundred someone has to actually read.
                      <p
                        key={i}
                        className={
                          /skipped|not a valid|no tests found|failed/i.test(line)
                            ? 'text-flake'
                            : undefined
                        }
                      >
                        {line}
                      </p>
                    ))
                  )}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                {phase === 'detected' && (
                  <Button variant="primary" onClick={() => void convert()}>
                    Convert {detection.fileCount} file{detection.fileCount === 1 ? '' : 's'}
                  </Button>
                )}
                {phase === 'converting' && (
                  <span className="text-ink-dim text-[12px]">
                    Converting {detection.fileCount} file{detection.fileCount === 1 ? '' : 's'}…
                  </span>
                )}
                {phase === 'done' && (
                  <span className="text-ink-dim text-[12px]">
                    <span className="text-pass tabular-nums">{convertedCount}</span> converted ·{' '}
                    <span className="text-flake">every one flagged for review</span> — the flags open
                    in the editor
                  </span>
                )}
              </div>

              {phase === 'detected' && framework !== 'POSTMAN' && (
                <p className="text-flake mt-2.5 text-[11.5px] leading-relaxed">
                  Code conversion uses the model — it needs ANTHROPIC_API_KEY set. Postman
                  collections convert without a key.
                </p>
              )}
            </section>
          )}

          {phase === 'done' && (
            <div className="mt-5 rounded-lg border border-[color-mix(in_srgb,var(--color-pass)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-pass)_7%,transparent)] px-[18px] py-4">
              <p className="text-[13.5px] font-semibold">
                Migrated <span className="tabular-nums">{convertedCount}</span> test
                {convertedCount === 1 ? '' : 's'} to the Imported suite.
              </p>
              {summary && (
                <p className="text-ink-dim mt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap">
                  {summary}
                </p>
              )}
              <Link href="/editor" className="text-accent mt-3 inline-block text-[12.5px]">
                Open them in the editor →
              </Link>
            </div>
          )}

          {error && <p className="text-fail mt-5 text-[13px] leading-relaxed">{error}</p>}
        </div>
      </div>
    </Page>
  );
}
