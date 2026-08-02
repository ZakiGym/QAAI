'use client';

import { useEffect, useState } from 'react';
import type { ProjectLite } from './shell/ProjectContext';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { SectionLabel, Tabs } from './ui/layout';

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

const PLACEHOLDER = `Checkout charges twice when a promo code is applied late

Steps to reproduce
1. Add a bag of coffee to the cart from /products
2. Open /checkout and press Pay
3. Apply promo code SPRING20 while the spinner is showing

Expected
One order, charged once.

Actual
Two orders under /account. The second has a total of 0.00.

Environment
Chrome 126 on macOS, staging`;

export function ReproForm({
  project,
  busy,
  onSubmit,
}: {
  project: ProjectLite;
  busy: boolean;
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
      <Tabs
        tabs={[
          { id: 'text' as const, label: 'Paste the ticket' },
          { id: 'issue' as const, label: 'Issue URL' },
        ]}
        active={mode}
        onChange={setMode}
      />

      {mode === 'text' ? (
        <div>
          <label htmlFor="repro-text" className="text-ink-dim text-body-sm mb-1.5 block">
            The bug report, as it was written
          </label>
          <textarea
            id="repro-text"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_REPORT_CHARS))}
            rows={14}
            placeholder={PLACEHOLDER}
            className="border-line bg-surface-1 focus:border-accent placeholder:text-ink-faint text-body-sm w-full resize-y rounded-md border px-3 py-2 font-mono outline-none"
          />
          <p className="text-ink-faint text-micro mt-1.5 tabular-nums">
            {text.length.toLocaleString()} / {MAX_REPORT_CHARS.toLocaleString()} characters.
            Headings, numbered steps and fenced blocks are all read — paste it whole rather
            than tidying it up first.
          </p>
        </div>
      ) : (
        <div>
          <Field
            label="Jira, Linear or GitHub issue"
            value={issueUrl}
            onChange={(e) => setIssueUrl(e.target.value)}
            placeholder="https://github.com/acme/storefront/issues/412"
            className="font-mono"
            hint="Fetched with the token already stored on that integration in Settings → Integrations. QAAI will not send a token to a host that is not the one configured there, and never asks for a credential on this page."
          />
        </div>
      )}

      <div className="border-line mt-5 rounded-lg border p-4">
        <SectionLabel>Where to run it</SectionLabel>
        {environments.length === 0 ? (
          <p className="text-flake text-body-sm leading-relaxed">
            This app has no environment, so a test can be written but never executed — and
            until it has been seen to fail, nothing has been reproduced.{' '}
            <a href="/environments" className="text-accent hover:underline">
              Add an environment
            </a>
            .
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="repro-env" className="text-ink-dim text-body-sm mb-1.5 block">
                Environment
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
              <p className="text-ink-faint text-micro mt-1.5">
                The bug has to be present here for it to reproduce here.
              </p>
            </div>

            <label className="text-body-sm flex items-start gap-2.5 sm:pt-7">
              <input
                type="checkbox"
                className="accent-accent mt-0.5"
                checked={run}
                onChange={(e) => setRun(e.target.checked)}
              />
              <span>
                <span className="text-ink">Run the reproduction</span>
                <span className="text-ink-faint text-micro block leading-relaxed">
                  On, because a test nobody has watched fail has reproduced nothing. The
                  request is held while it runs — up to 90 seconds.
                </span>
              </span>
            </label>
          </div>
        )}
      </div>

      <Button
        variant="primary"
        className="mt-4 w-full"
        disabled={!ready}
        loading={busy}
        onClick={submit}
      >
        {busy ? 'Working…' : 'Read this report'}
      </Button>
      <p className="text-ink-faint text-micro mt-2 text-center">
        What was understood is shown before anything is generated, so a misread ticket is
        caught by you and not by a test.
      </p>
    </div>
  );
}
