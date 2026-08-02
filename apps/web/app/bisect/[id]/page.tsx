'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { BisectProgressView, BisectReportView, useBisectPoll } from '../../../components/BisectPanel';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Card, Page, PageHeader, Skeleton } from '../../../components/ui/layout';
import { relativeTime } from '../../../components/ui';

/**
 * One investigation, at its own address.
 *
 * The API deliberately keeps a bisect in audit rows rather than in Redis, so
 * that "which commit broke this" survives the weekend — BullMQ prunes finished
 * jobs after 24 hours and an answer that expires is not an answer. That
 * durability is only worth anything if the answer has a URL: this is the thing
 * you paste into the incident channel, and the thing you open on Monday.
 *
 * It renders exactly what the panel on the test page renders. Two surfaces
 * showing the same investigation differently would be two investigations.
 */

interface TestHead {
  test: { id: string; name: string; filePath: string };
}

export default function BisectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { view, error, loading, gone, refresh } = useBisectPoll(id);

  // Only for the heading. GET /bisect/:id returns a testId and no name, and a
  // page titled with a cuid is a page nobody can tell apart from another one.
  const [head, setHead] = useState<TestHead['test'] | null>(null);
  const testId = view?.testId ?? null;

  useEffect(() => {
    if (!testId) return;
    let dead = false;
    void api<TestHead>(`/tests/${testId}/history?limit=1`)
      .then((response) => {
        if (!dead) setHead(response.test);
      })
      // The name is decoration. Losing it must not cost the report.
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [testId]);

  if (gone) {
    return (
      <Page width="wide">
        <PageHeader title="Bisect" subtitle={<code className="font-mono">{id}</code>} />
        <EmptyState
          title="No investigation with this id"
          body="Either it never existed, or it was requested more than 45 minutes ago and never concluded — an investigation that does not finish inside its deadline leaves no report to read. Open the test and run a new one."
          action={{ label: 'Back to quality', href: '/quality' }}
        />
      </Page>
    );
  }

  if (loading && !view) {
    return (
      <Page width="wide">
        <PageHeader title="Bisect" subtitle="Loading…" />
        <Card className="space-y-3 p-4">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </Card>
      </Page>
    );
  }

  if (error && !view) {
    return (
      <Page width="wide">
        <PageHeader title="Bisect" subtitle={<code className="font-mono">{id}</code>} />
        <p role="alert" className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
          {error}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="text-accent mt-4 inline-block text-sm hover:underline"
        >
          Try again
        </button>
      </Page>
    );
  }

  if (!view) return null;

  const report = view.result;

  return (
    <Page width="wide">
      <PageHeader
        title="Bisect"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {head ? (
              <>
                <span className="text-ink">{head.name}</span>
                <span className="text-ink-faint">·</span>
                <code className="font-mono">{head.filePath}</code>
              </>
            ) : (
              <code className="font-mono">{id}</code>
            )}
            {view.finishedAt && (
              <>
                <span className="text-ink-faint">·</span>
                <span className="text-ink-faint tabular-nums">
                  concluded {relativeTime(view.finishedAt)}
                </span>
              </>
            )}
          </span>
        }
        actions={
          view.testId && (
            <Link
              href={`/tests/${view.testId}`}
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-body-sm rounded-md border px-3.5 py-2"
            >
              Test history →
            </Link>
          )
        }
      />

      {error && (
        <p className="border-line text-ink-dim text-micro mb-4 rounded-md border border-dashed p-3">
          {error} — showing the last successful read.{' '}
          <button
            type="button"
            onClick={refresh}
            className="text-accent underline decoration-dotted underline-offset-2"
          >
            Try again
          </button>
        </p>
      )}

      <Card className="p-4">
        {view.state === 'DONE' && report ? (
          <BisectReportView
            report={report}
            probeRuns={view.probeRuns}
            requestedAt={view.requestedAt}
          />
        ) : view.state === 'DONE' ? (
          <p className="text-ink-dim text-body-sm leading-relaxed">
            This bisect concluded, but the record it wrote could not be read back as a report. Its
            probe runs, if it created any, are the evidence that remains.
          </p>
        ) : (
          <BisectProgressView view={view} />
        )}
      </Card>
    </Page>
  );
}
