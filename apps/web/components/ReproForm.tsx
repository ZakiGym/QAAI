'use client';

import { useEffect, useState } from 'react';
import type { ProjectLite } from './shell/ProjectContext';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Tabs } from './ui/layout';

/**
 * The input half of /repro: a ticket in, a reproduction out.
 *
 * Two ways in, because a bug arrives two ways. Someone pastes what a customer
 * wrote into Slack, or they have a Jira/Linear/GitHub link. The link is fetched
 * through the token already stored on an integration — this form never asks for
 * a credential, and says so, because a field marked "token" on a page like this
 * is exactly what a phishing page looks like.
 *
 * `run` is on by default and is the whole point of the feature: a reproduction
 * nobody has watched fail has reproduced nothing. Turning it off is offered,
 * with the consequence spelled out rather than hidden in a tooltip.
 *
 * The report is set in mono. It is somebody else's text, pasted whole and read
 * by a parser rather than by a person — the same reason a stack trace is not
 * set in the UI face.
 */

export const MAX_REPORT_CHARS = 200_000;

export interface ReproRequest {
  text?: string;
  issueUrl?: string;
  environmentId?: string;
  run: boolean;
  force?: boolean;
}

type Mode = 'text' | 'issue';

const PLACEHOLDER = `Title: Order total wrong with 2+ items
Steps:
1. Add the Brew Scale
2. Add the Single Origin coffee
3. Go to checkout
Expected: total = subtotal + shipping + tax
Actual: total is 1800 short`;

export function ReproForm({
  project,
  busy,
  note,
  onSubmit,
}: {
  project: ProjectLite;
  busy: boolean;
  /** What the last attempt cost, shown beside the button once there is one. */
  note?: React.ReactNode;
  onSubmit: (request: ReproRequest) => void;
}) {
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [issueUrl, setIssueUrl] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [run, setRun] = useState(true);

  const environments = project.environments;

  // A project switch must not leave the previous project's environment id in
  // the form — the API would 404 on an environment this project does not own.
  useEffect(() => {
    setEnvironmentId(environments[0]?.id ?? '');
  }, [environments]);

  const ready = mode === 'text' ? text.trim().length > 0 : issueUrl.trim().length > 0;

  function submit() {
    if (!ready) return;
    onSubmit({
      ...(mode === 'text' ? { text: text.trim() } : { issueUrl: issueUrl.trim() }),
      ...(environmentId ? { environmentId } : {}),
      run,
    });
  }

  return (
    <div>
      <p className="text-ink-dim mb-3 text-[13.5px] leading-relaxed">
        Paste the ticket. The pipeline shows what it understood before anything is generated — an
        agent that misreads a report writes the wrong test.
      </p>

      <Tabs
        tabs={[
          { id: 'text' as const, label: 'Paste it' },
          { id: 'issue' as const, label: 'Issue URL' },
        ]}
        active={mode}
        onChange={setMode}
      />

      {mode === 'text' ? (
        <div>
          <label htmlFor="repro-text" className="sr-only">
            The bug report, as it was written
          </label>
          <textarea
            id="repro-text"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_REPORT_CHARS))}
            rows={10}
            placeholder={PLACEHOLDER}
            className="border-line bg-surface-1 focus:border-accent placeholder:text-ink-faint text-ink-dim min-h-[180px] w-full resize-y rounded-lg border p-3.5 font-mono text-[11.5px] leading-[1.7] outline-none"
          />
          <p className="text-ink-faint mt-1.5 text-[11px] tabular-nums">
            {text.length.toLocaleString()} / {MAX_REPORT_CHARS.toLocaleString()} characters.
            Headings, numbered steps and fenced blocks are all read — paste it whole rather than
            tidying it up first.
          </p>
        </div>
      ) : (
        <Field
          label="Jira, Linear or GitHub issue"
          value={issueUrl}
          onChange={(e) => setIssueUrl(e.target.value)}
          placeholder="https://github.com/acme/storefront/issues/412"
          className="font-mono"
          hint="Fetched with the token already stored on that integration in Settings → Integrations. QAAI will not send a token to a host that is not the one configured there, and never asks for a credential on this page."
        />
      )}

      {environments.length === 0 ? (
        <p className="text-flake mt-4 text-[12px] leading-relaxed">
          This app has no environment, so a test can be written but never executed — and until it
          has been seen to fail, nothing has been reproduced.{' '}
          <a href="/environments" className="text-accent hover:underline">
            Add an environment
          </a>
          .
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="repro-env"
              className="text-meta text-ink-faint mb-1.5 block font-mono font-semibold tracking-[0.1em] uppercase"
            >
              Where to run it
            </label>
            <select
              id="repro-env"
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
              className="border-line bg-surface-1 focus:border-accent text-body-sm w-full rounded-md border px-3 py-2 outline-none"
            >
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name} — {env.baseUrl}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2.5 text-[12px]">
            <input
              type="checkbox"
              className="accent-accent mt-0.5"
              checked={run}
              onChange={(e) => setRun(e.target.checked)}
            />
            <span>
              <span className="text-ink">Run the reproduction</span>
              <span className="text-ink-faint block text-[11px] leading-relaxed">
                On, because a test nobody has watched fail has reproduced nothing. The request is
                held while it runs — up to 90 seconds.
              </span>
            </span>
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button variant="primary" disabled={!ready} loading={busy} onClick={submit}>
          {busy ? 'Working…' : 'Write the repro'}
        </Button>
        {note}
      </div>
    </div>
  );
}
