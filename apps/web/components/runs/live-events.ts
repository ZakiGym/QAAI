import type { LiveLine } from '../EvidenceRail';

/**
 * The live stream, turned into lines a person can read — and the LIST OF FRAMES
 * THE PAGE ASKS FOR.
 *
 * ── The defect this module exists to close ──────────────────────────────────
 *
 * `publish()` in apps/api/src/lib/events.ts writes a NAMED SSE frame
 * (`event: run.environment`). A browser DROPS a named event with no matching
 * listener — it does not fall through to `onmessage` — so a frame the cockpit
 * never registered for did not arrive late or arrive raw: it did not arrive at
 * all, and it did not even trigger the page's refetch. The listener list was
 * hard-coded in the page and four published kinds were missing from it:
 *
 *   · `run.environment`   — the preflight's "your environment is unusable",
 *                           whose own comment in the worker claims it is "the
 *                           frame the cockpit needs in order not to render a
 *                           mystery".
 *   · `verdict.suppressed`— a failure a mute swallowed. The mute design is
 *                           explicit that a suppressed failure stays VISIBLE
 *                           and keeps being counted; in the live stream it was
 *                           invisible.
 *   · `plugin.fault`      — an installed plugin that did not run.
 *   · `log`               — every line a self-hosted runner reports. An on-prem
 *                           run publishes almost nothing else, so its live pane
 *                           was blank from start to finish.
 *
 * So the list lives here, beside the renderer, and `live-events.test.ts` checks
 * it against the `RunEventType` union in the API's own source. Two mechanisms,
 * because each catches what the other cannot: a hand-written list drifts from
 * the union, and the union has no runtime form to compare against.
 *
 * ── Why a frame may still render nothing ────────────────────────────────────
 *
 * `describeEvent` returns null rather than printing a placeholder. This pane is
 * the one surface a user watches while they wait, and an unnamed frame adds
 * noise to the only place where noise actually costs something. It used to
 * print `step {"testId":"cms6vrt5i0003…","index":1,…}` — the raw payload,
 * straight off the wire.
 */

export type { LiveLine };

/**
 * Every frame the cockpit registers a listener for.
 *
 * Mirrors `RunEventType` in apps/api/src/lib/events.ts, which the web app
 * cannot import (it is server source, not a published package). The test pins
 * the two together, including the ones with no `describeEvent` case: a listener
 * with no line still triggers the page's reload, and an unregistered frame
 * triggers nothing.
 */
export const LIVE_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'run.environment',
  'test.started',
  'test.finished',
  'step',
  'verdict',
  'verdict.suppressed',
  'plugin.fault',
  'shard.started',
  'shard.finished',
  'log',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/**
 * Frames that must NOT trigger a refetch of the run.
 *
 * Only `log`, and it is about volume rather than relevance: a self-hosted
 * runner POSTs its stdout in batches and each line becomes one frame, so
 * reloading per frame would turn a chatty test into a refetch storm against
 * `GET /runs/:id`. Nothing a log line carries is stored on the run row anyway —
 * the line itself is the whole payload — so there is nothing to go and read.
 *
 * Every other frame reports a state change the page renders from the row
 * (a status, a count, a verdict, a shard), so every other frame reloads.
 */
export const NO_RELOAD: ReadonlySet<string> = new Set<LiveEventType>(['log']);

export function reloadsRun(label: string): boolean {
  return !NO_RELOAD.has(label);
}

export function describeEvent(label: string, data: Record<string, unknown>): LiveLine | null {
  const str = (key: string): string | null => (typeof data[key] === 'string' ? data[key] : null);
  const num = (key: string): number | null => (typeof data[key] === 'number' ? data[key] : null);

  switch (label) {
    case 'run.started': {
      const total = num('total');
      return {
        text: `Run started${total === null ? '' : ` · ${total} tests`}`,
        tone: 'bg-accent',
      };
    }
    case 'test.started': {
      const name = str('name');
      return name ? { text: `Running ${name}`, tone: 'bg-accent' } : null;
    }
    case 'test.finished': {
      const name = str('name');
      const status = str('status');
      if (!name || !status) return null;
      const ms = num('durationMs');
      const took = ms === null ? '' : ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : ` · ${ms}ms`;
      const passed = status === 'PASSED';
      return {
        text: `${passed ? 'Passed' : status === 'SKIPPED' ? 'Skipped' : 'Failed'}: ${name}${took}`,
        tone: passed ? 'bg-pass' : status === 'SKIPPED' ? 'bg-skip' : 'bg-fail',
      };
    }
    case 'step': {
      // Step titles are what the test actually did — "Click Add to cart" — and
      // are the most useful thing in the stream.
      const title = str('title');
      if (!title) return null;
      const status = str('status');
      return {
        text: title,
        tone: status === 'FAILED' ? 'bg-fail' : status === 'PASSED' ? 'bg-pass' : 'bg-skip',
      };
    }
    case 'verdict': {
      const verdict = str('verdict');
      return verdict
        ? { text: `Triaged as ${verdict.toLowerCase().replace(/_/g, ' ')}`, tone: 'bg-flake' }
        : null;
    }
    /*
     * A muted cause swallowed this failure, so no verdict exists for it and
     * nothing further will arrive about it. It is reported, because the whole
     * difference between a mute and a blind spot is that the mute says so.
     */
    case 'verdict.suppressed': {
      const name = str('testName');
      const cause = str('label');
      if (!name) return null;
      return {
        text: `Muted cause — no verdict for ${name}${cause ? `: ${cause}` : ''}`,
        tone: 'bg-flake',
      };
    }
    /*
     * The environment, as the preflight found it.
     *
     * Worded as a problem with named checks and NOT as "the run stopped": this
     * frame is published whenever any check came back UNAVAILABLE, which
     * includes runs that then executed everything they could. What was
     * unattemptable is on the results themselves.
     */
    case 'run.environment': {
      const reason = str('reason');
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const names = checks
        .map((check) =>
          check && typeof check === 'object'
            ? ((check as { name?: unknown }).name as string | undefined)
            : undefined,
        )
        .filter((name): name is string => typeof name === 'string');
      if (reason) return { text: `Environment: ${reason}`, tone: 'bg-fail' };
      if (names.length > 0) {
        return { text: `Environment check unavailable: ${names.join(', ')}`, tone: 'bg-fail' };
      }
      // No reason and no readable check: say that much and no more. The frame
      // is only published when something IS wrong, so dropping it would hide a
      // real problem behind a payload we could not parse.
      return { text: 'Environment problem — see the run detail', tone: 'bg-fail' };
    }
    /*
     * An installed plugin that did not run. Named, because the alternative is a
     * suite that silently covers less than the project thinks it does.
     */
    case 'plugin.fault': {
      const plugin = str('plugin') ?? str('pluginId');
      const kind = str('kind');
      if (!plugin) return null;
      return {
        text: `Plugin ${plugin} did not run${kind ? ` · ${kind.toLowerCase().replace(/_/g, ' ')}` : ''}`,
        tone: 'bg-fail',
      };
    }
    // Five workers interleaving their test lines is confusing without something
    // saying how many there are and when each one is done.
    case 'shard.started': {
      const index = num('shard');
      const total = num('shards');
      const tests = num('tests');
      if (index === null || total === null) return null;
      return {
        text: `Shard ${index} of ${total} started${tests === null ? '' : ` · ${tests} tests`}`,
        tone: 'bg-accent',
      };
    }
    case 'shard.finished': {
      const index = num('shard');
      const total = num('shards');
      if (index === null || total === null) return null;
      if (data.errored === true) {
        return { text: `Shard ${index} of ${total} did not complete`, tone: 'bg-fail' };
      }
      const failed = num('failed') ?? 0;
      return {
        text: `Shard ${index} of ${total} finished${failed > 0 ? ` · ${failed} failed` : ''}`,
        tone: failed > 0 ? 'bg-fail' : 'bg-pass',
      };
    }
    /*
     * `text` is what the API's own publishers and the on-prem runner send;
     * `message` is what the worker's crawl and import processors send. Both are
     * read, because a line dropped for carrying the wrong key reads exactly
     * like a runner that said nothing.
     */
    case 'log': {
      const text = str('text') ?? str('message');
      if (!text) return null;
      const level = str('level');
      return {
        text,
        tone: level === 'error' ? 'bg-fail' : level === 'warn' ? 'bg-flake' : 'bg-accent',
      };
    }
    case 'run.finished':
      return { text: 'Run finished', tone: 'bg-accent' };
    default:
      return null;
  }
}
