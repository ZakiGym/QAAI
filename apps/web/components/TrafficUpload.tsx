'use client';

import { useState } from 'react';
import { api, type TrafficAnalysis, type TrafficFormat } from '../lib/api';
import { Button } from './ui/Button';
import { SectionLabel } from './ui/layout';

/**
 * The upload half of /traffic.
 *
 * One file goes up and a ranked, redacted analysis comes back — the endpoint is
 * synchronous, so this is a form, not a job. Three things are deliberate:
 *
 * 1. The file is read in the browser and posted as `text/plain`. The API's JSON
 *    parser is capped at 2MB and a week of access logs is not, so the text body
 *    parser (24MB) is the one this must hit. Options ride in the query string
 *    because the body is the upload.
 *
 * 2. A file over the cap is refused HERE, with its size, rather than sent to
 *    collect a 413 whose body is not even JSON.
 *
 * 3. `includeStaticAssets` / `includeBots` are sent ONLY when true. The API
 *    coerces them with `z.coerce.boolean()`, and `Boolean("false")` is `true` —
 *    sending the unticked state would turn the filter off, which is the exact
 *    opposite of what the box says.
 */

/** Matches UPLOAD_LIMIT on the API's text body parser. */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const FORMATS: Array<{ value: TrafficFormat | 'AUTO'; label: string }> = [
  { value: 'AUTO', label: 'Detect automatically' },
  { value: 'HAR', label: 'HAR (DevTools, Charles, a proxy)' },
  { value: 'ACCESS_LOG', label: 'Access log (Common / Combined)' },
  { value: 'OTLP', label: 'OTLP spans' },
];

const ACCEPT = '.har,.log,.txt,.json,.ndjson,application/json,text/plain';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function TrafficUpload({
  projectId,
  busy,
  onStart,
  onAnalysed,
  onError,
}: {
  projectId: string;
  busy: boolean;
  /** Fired before the request, so the page can clear the previous analysis. */
  onStart: () => void;
  onAnalysed: (analysis: TrafficAnalysis) => void;
  /** The raw failure, so the page can tell a signed-out session from a bad file. */
  onError: (err: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [format, setFormat] = useState<TrafficFormat | 'AUTO'>('AUTO');
  const [sessionGap, setSessionGap] = useState('');
  const [includeStaticAssets, setIncludeStaticAssets] = useState(false);
  const [includeBots, setIncludeBots] = useState(false);
  const [tooBig, setTooBig] = useState<string | null>(null);

  function accept(picked: File | null | undefined) {
    if (!picked) return;
    if (picked.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setTooBig(
        `${picked.name} is ${bytes(picked.size)}. The upload limit is ${bytes(MAX_UPLOAD_BYTES)} — ` +
          'split the log, or take a narrower window.',
      );
      return;
    }
    setTooBig(null);
    setFile(picked);
  }

  async function analyse() {
    if (!file) return;
    onStart();
    try {
      const query = new URLSearchParams();
      if (format !== 'AUTO') query.set('format', format);
      const gap = Number(sessionGap);
      if (sessionGap.trim() && Number.isFinite(gap) && gap >= 1) {
        query.set('sessionGapMinutes', String(Math.round(gap)));
      }
      // Only ever sent as `true` — see the note at the top of this file.
      if (includeStaticAssets) query.set('includeStaticAssets', 'true');
      if (includeBots) query.set('includeBots', 'true');

      const search = query.toString();
      const text = await file.text();
      const analysis = await api<TrafficAnalysis>(
        `/traffic/${projectId}/analyze${search ? `?${search}` : ''}`,
        {
          method: 'POST',
          // Overrides the client's default JSON content type: this body is the
          // raw upload, and the 2MB JSON parser must not see it.
          headers: { 'content-type': 'text/plain' },
          body: text,
        },
      );
      onAnalysed(analysis);
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div>
      <label
        htmlFor="traffic-file"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files?.[0]);
        }}
        className={`block cursor-pointer rounded-lg border border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-line-strong'
        }`}
      >
        <span className="text-ink text-body-sm block font-medium">
          {file ? file.name : 'Drop a HAR, an access log or an OTLP export here'}
        </span>
        <span className="text-ink-faint text-micro mt-1 block tabular-nums">
          {file
            ? `${bytes(file.size)} · click to choose a different file`
            : `or click to choose a file — up to ${bytes(MAX_UPLOAD_BYTES)}`}
        </span>
        <input
          id="traffic-file"
          type="file"
          accept={ACCEPT}
          onChange={(e) => accept(e.target.files?.[0])}
          className="hidden"
        />
      </label>

      {tooBig && <p className="text-fail text-micro mt-2">{tooBig}</p>}

      <div className="border-line mt-4 rounded-lg border p-4">
        <SectionLabel>How to read it</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="traffic-format" className="text-ink-dim text-body-sm mb-1.5 block">
              Format
            </label>
            <select
              id="traffic-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as TrafficFormat | 'AUTO')}
              className="border-line bg-surface-1 focus:border-accent text-body-sm w-full rounded-md border px-3 py-2 outline-none"
            >
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <p className="text-ink-faint text-micro mt-1.5">
              Detection reads the shape, not the file extension.
            </p>
          </div>

          <div>
            <label htmlFor="traffic-gap" className="text-ink-dim text-body-sm mb-1.5 block">
              A session ends after
            </label>
            <div className="flex items-center gap-2">
              <input
                id="traffic-gap"
                type="number"
                min={1}
                max={1440}
                inputMode="numeric"
                value={sessionGap}
                onChange={(e) => setSessionGap(e.target.value)}
                placeholder="30"
                className="border-line bg-surface-1 focus:border-accent text-body-sm w-24 rounded-md border px-3 py-2 tabular-nums outline-none"
              />
              <span className="text-ink-dim text-body-sm">minutes of silence</span>
            </div>
            <p className="text-ink-faint text-micro mt-1.5">
              Blank uses 30 minutes, the analytics convention. This decides where one
              user&rsquo;s journey stops and the next begins.
            </p>
          </div>
        </div>

        <div className="border-line mt-4 space-y-2 border-t pt-4">
          <label className="text-body-sm flex items-start gap-2.5">
            <input
              type="checkbox"
              className="accent-accent mt-0.5"
              checked={includeStaticAssets}
              onChange={(e) => setIncludeStaticAssets(e.target.checked)}
            />
            <span>
              <span className="text-ink">Include static assets</span>
              <span className="text-ink-faint block text-micro">
                CSS, images and fonts are excluded by default — nobody writes a test for a
                sprite sheet.
              </span>
            </span>
          </label>
          <label className="text-body-sm flex items-start gap-2.5">
            <input
              type="checkbox"
              className="accent-accent mt-0.5"
              checked={includeBots}
              onChange={(e) => setIncludeBots(e.target.checked)}
            />
            <span>
              <span className="text-ink">Include bots and uptime monitors</span>
              <span className="text-ink-faint block text-micro">
                Excluded by default: a monitor hitting one path every minute would outrank
                every real journey.
              </span>
            </span>
          </label>
        </div>
      </div>

      <Button
        variant="primary"
        className="mt-4 w-full"
        disabled={!file}
        loading={busy}
        onClick={() => void analyse()}
      >
        {busy ? 'Analysing…' : 'Analyse this traffic'}
      </Button>
      <p className="text-ink-faint text-micro mt-2 text-center">
        The upload is redacted as it is read and is never written down — not to a row, not to
        the audit log, not to a log line.
      </p>
    </div>
  );
}
