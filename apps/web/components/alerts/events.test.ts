/**
 * The alerts screen's routing rules.
 *
 * These matter more than most UI logic because they are a MIRROR: the truth
 * lives in the worker (`wantsRunFinished`, and notify.ts's monitor.down
 * branch), and a screen that mirrors it wrongly tells someone they are covered
 * when they are not. So the expectations here are written as the product
 * promise in words — "a blocked run reaches a failures-only channel" — not as a
 * restatement of the switch under test.
 */

import { describe, expect, it } from 'vitest';
import type { NotifyPrefs } from '../../lib/api';
import { ALERT_EVENTS, notifyPatch, routesTo, routingSummary } from './events';

const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({
  runFinished: 'failures',
  digest: true,
  ...over,
});

describe('routesTo mirrors what the worker actually sends', () => {
  it('always pages for a monitor, whatever the channel asked for', () => {
    // notify.ts sends monitor.down to every enabled chat integration and
    // deliberately ignores runFinished — including for a channel that muted
    // run reports entirely.
    expect(routesTo('monitor.down', prefs({ runFinished: 'off', digest: false }))).toBe('always');
  });

  it('sends failures AND gate-blocked runs to a failures-only channel', () => {
    const p = prefs({ runFinished: 'failures' });
    expect(routesTo('run.failed', p)).toBe('on');
    // The one people get wrong: a run can be blocked with every test green.
    expect(routesTo('run.blocked', p)).toBe('on');
    expect(routesTo('run.passed', p)).toBe('off');
  });

  it('sends a green run only to a channel that asked for every run', () => {
    expect(routesTo('run.passed', prefs({ runFinished: 'all' }))).toBe('on');
    expect(routesTo('run.failed', prefs({ runFinished: 'all' }))).toBe('on');
  });

  it('sends no run report at all to a channel switched off, digest aside', () => {
    const p = prefs({ runFinished: 'off', digest: true });
    expect(routesTo('run.failed', p)).toBe('off');
    expect(routesTo('run.blocked', p)).toBe('off');
    expect(routesTo('run.passed', p)).toBe('off');
    // The digest is its own preference and survives muting runs.
    expect(routesTo('digest', p)).toBe('on');
  });

  it('follows the digest preference for the digest', () => {
    expect(routesTo('digest', prefs({ digest: false }))).toBe('off');
  });

  it('has a rule for every event the screen lists', () => {
    // A new event added to the catalogue without a routing rule would render
    // as an unexplained blank in the table.
    for (const event of ALERT_EVENTS) {
      expect(['always', 'on', 'off']).toContain(routesTo(event.id, prefs()));
    }
  });
});

describe('routingSummary says what the channel hears', () => {
  it('names blocked runs alongside failures, because both reach a failures channel', () => {
    expect(routingSummary(prefs())).toBe('failures and blocked runs, plus the digest');
  });

  it('does not claim a muted channel is silent when the digest is still on', () => {
    expect(routingSummary(prefs({ runFinished: 'off' }))).toBe(
      'monitor pages only, plus the digest',
    );
    expect(routingSummary(prefs({ runFinished: 'off', digest: false }))).toBe('monitor pages only');
  });

  it('calls the loud setting loud', () => {
    expect(routingSummary(prefs({ runFinished: 'all', digest: false }))).toBe('every run');
  });
});

describe('notifyPatch sends only what changed', () => {
  it('is null when nothing changed, so Save cannot fire an empty PATCH', () => {
    // The endpoint refuses `{}` with "nothing to update"; a person toggling a
    // box and toggling it back must not be shown that error.
    expect(notifyPatch(prefs(), prefs())).toBeNull();
  });

  it('names one field when one field moved', () => {
    expect(notifyPatch(prefs(), prefs({ runFinished: 'all' }))).toEqual({
      notify: { runFinished: 'all' },
    });
    expect(notifyPatch(prefs(), prefs({ digest: false }))).toEqual({ notify: { digest: false } });
  });

  it('names both when both moved', () => {
    expect(notifyPatch(prefs(), prefs({ runFinished: 'off', digest: false }))).toEqual({
      notify: { runFinished: 'off', digest: false },
    });
  });

  it('sends digest:false rather than dropping a falsy value', () => {
    // A patch built by truthiness would silently refuse to turn the digest off.
    const patch = notifyPatch(prefs({ digest: true }), prefs({ digest: false }));
    expect(patch?.notify).toHaveProperty('digest', false);
  });
});
