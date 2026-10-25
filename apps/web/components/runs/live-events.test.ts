import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_TYPES, describeEvent, reloadsRun } from './live-events';

/**
 * The listener list, against the frames that are actually published.
 *
 * This is a PARITY test and not six hand-written cases, deliberately. The
 * defect it exists for was not a wrong line of copy: `publish()` writes a named
 * SSE frame, a browser DROPS a named frame with no listener, and the cockpit's
 * hard-coded list was four kinds short — so `run.environment`,
 * `verdict.suppressed`, `plugin.fault` and every on-prem runner `log` line were
 * published, relayed, and delivered nowhere. Cases for the four would have
 * passed the day they were written and said nothing about the fifth.
 *
 * Both halves are read out of SOURCE on purpose:
 *
 *  · `RunEventType` in the API declares what a frame may be, and the web app
 *    cannot import it (server source, not a published package), so a mirror is
 *    the only option and an unchecked mirror is how this drifted.
 *  · the `publishEvent` / `publish` call sites are the ground truth for what is
 *    actually sent, and they are what the union itself has to keep up with.
 *    A type added to the union and never published is harmless; a type
 *    published and missing from the union is invisible.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** The members of `export type RunEventType = …` in the API's events module. */
function apiEventTypes(): string[] {
  const source = read('../../../api/src/lib/events.ts');
  const block = /export type RunEventType =([\s\S]*?);\n/.exec(source);
  if (!block) throw new Error('RunEventType is not declared in apps/api/src/lib/events.ts');
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/**
 * Every `type: '…'` on a publish call site, across both producers.
 *
 * Matched on the whole file rather than per call because the event literal is
 * the only place in these files that writes `type: '<dotted or lowercase>'`
 * alongside a `runId`; the shape is checked below by asserting the set is
 * neither empty nor absurdly large, so a regex that stopped matching cannot
 * pass as "nothing is published".
 */
function publishedEventTypes(): Set<string> {
  const sources = [
    read('../../../worker/src/processors/run.ts'),
    read('../../../worker/src/processors/triage.ts'),
    read('../../../api/src/routes/runners.ts'),
    read('../../../api/src/lib/runners.ts'),
  ].join('\n');

  const types = new Set<string>();
  for (const match of sources.matchAll(/\btype:\s*'([a-z]+(?:\.[a-z]+)?)'/g)) {
    types.add(match[1]!);
  }
  return types;
}

describe('the cockpit listens for every frame the API can publish', () => {
  it('registers one listener per member of the API RunEventType union', () => {
    // Sorted compare: the ORDER of the union is nobody's contract, membership
    // is. A missing member here is a frame the browser throws away.
    expect([...LIVE_EVENT_TYPES].sort()).toEqual(apiEventTypes().sort());
  });

  it('covers every type a publish call site actually sends', () => {
    const published = publishedEventTypes();
    // Guard the extraction itself: these files publish a dozen distinct types,
    // so a regex that matched nothing (or matched the whole file) must not pass
    // as agreement.
    expect(published.size).toBeGreaterThanOrEqual(10);
    expect(published.size).toBeLessThan(40);

    const registered = new Set<string>(LIVE_EVENT_TYPES);
    const unheard = [...published].filter((type) => !registered.has(type));
    expect(unheard).toEqual([]);
  });

  it('is what the cockpit page actually registers from', () => {
    /*
     * A SOURCE assertion, and it is the only mechanism available: nothing in
     * this repo's suite renders a component, so there is no way to observe the
     * page's `addEventListener` calls. What it guards is the exact shape of the
     * original defect — a hand-written subset of the types, inline in the page
     * — so it fails if anybody reintroduces one, which a test of this module
     * alone cannot do.
     */
    const page = read('../../app/runs/[runId]/page.tsx');
    expect(page).toContain('for (const type of LIVE_EVENT_TYPES)');
    expect(page).toMatch(/addEventListener\(type, record\(type\)\)/);
  });

  it('includes the four kinds that were being dropped', () => {
    // Named explicitly as well as checked by parity, because these four are the
    // defect: each was published, relayed and delivered to nobody.
    for (const type of ['run.environment', 'verdict.suppressed', 'plugin.fault', 'log']) {
      expect(LIVE_EVENT_TYPES).toContain(type);
    }
  });
});

describe('describeEvent renders the frames that used to be dropped', () => {
  it('names the environment problem, from the reason the preflight wrote', () => {
    const line = describeEvent('run.environment', {
      reason: 'The base URL did not answer: connect ECONNREFUSED 127.0.0.1:3000',
      durationMs: 812,
      checks: [{ name: 'BASE_URL', kind: 'BLOCKED_BY_ENV', detail: 'nothing answered' }],
    });
    expect(line?.text).toContain('connect ECONNREFUSED');
    expect(line?.tone).toBe('bg-fail');
  });

  it('still reports an environment frame whose reason is null', () => {
    // `decision.reason` is nullable and the frame is published whenever ANY
    // check is UNAVAILABLE, so a null reason must not drop the line — the
    // frame only exists because something is wrong.
    const line = describeEvent('run.environment', {
      reason: null,
      checks: [{ name: 'REPO_WORKSPACE', kind: 'BLOCKED_BY_ENV', detail: 'no checkout' }],
    });
    expect(line).not.toBeNull();
    expect(line?.text).toContain('REPO_WORKSPACE');
  });

  it('keeps a muted failure visible instead of silently showing nothing', () => {
    const line = describeEvent('verdict.suppressed', {
      testResultId: 'tr_1',
      testName: 'checkout → pay',
      clusterKey: 'abc123abc123',
      label: 'TimeoutError on #pay',
      mutedUntil: '2026-11-01T00:00:00.000Z',
      mutedReason: 'known flake, ticket QA-41',
    });
    expect(line?.text).toContain('checkout → pay');
    expect(line?.text.toLowerCase()).toContain('muted');
  });

  it('names a plugin that did not run', () => {
    const line = describeEvent('plugin.fault', {
      pluginId: 'pl_1',
      plugin: 'k6 load',
      publisher: 'acme',
      kind: 'SIGNATURE_INVALID',
      message: 'the manifest signature did not verify',
    });
    expect(line?.text).toContain('k6 load');
    expect(line?.text).toContain('signature invalid');
  });

  it('reads a log line under either key the producers use', () => {
    // `text` is what the API and the on-prem runner send; `message` is what the
    // worker's crawl and import processors send. A line dropped for carrying
    // the other key reads exactly like a runner that said nothing.
    expect(
      describeEvent('log', { level: 'info', text: 'runner "ci-1" picked up 5 test(s)' })?.text,
    ).toBe('runner "ci-1" picked up 5 test(s)');
    expect(describeEvent('log', { message: 'Crawling https://example.test' })?.text).toBe(
      'Crawling https://example.test',
    );
    expect(describeEvent('log', { level: 'error', text: 'it died' })?.tone).toBe('bg-fail');
  });

  it('says a run started, with the size of the suite when it is stated', () => {
    expect(describeEvent('run.started', { total: 11, baseUrl: 'https://x.test' })?.text).toBe(
      'Run started · 11 tests',
    );
    // No total is not zero tests.
    expect(describeEvent('run.started', {})?.text).toBe('Run started');
  });

  it('drops a frame it cannot describe rather than printing the payload', () => {
    // The pane used to render `step {"testId":"cms6…","index":1,…}`.
    expect(describeEvent('step', { testId: 'cms6', index: 1 })).toBeNull();
    expect(describeEvent('test.finished', { name: 'a' })).toBeNull();
  });
});

describe('reloadsRun', () => {
  it('does not refetch the run for a log line', () => {
    // A self-hosted runner POSTs stdout in batches and each line is one frame;
    // reloading per frame is a refetch storm, and a log line carries its whole
    // payload with it anyway.
    expect(reloadsRun('log')).toBe(false);
  });

  it('refetches for every frame that reports a state change', () => {
    for (const type of LIVE_EVENT_TYPES) {
      if (type === 'log') continue;
      expect(reloadsRun(type)).toBe(true);
    }
  });
});
