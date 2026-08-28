/**
 * The event-action contract (§7).
 *
 * What these tests are for is narrower than "does the code run". This module is
 * a PUBLIC CONTRACT — somebody's deploy pipeline parses these envelopes — so
 * the failures worth catching are the ones that would silently change what a
 * receiver sees:
 *
 *   • an event type added without a payload version or a label, so envelopes
 *     ship carrying `dataVersion: undefined`;
 *   • the id derivation drifting, which re-delivers history to every receiver
 *     that deduplicates on it;
 *   • the subscription parser accepting something it cannot honour, so an
 *     action silently never fires;
 *   • `.*` in a subscription being read as a regular expression rather than the
 *     literal suffix this module defines it as.
 *
 * Every expectation below is written against a value spelled out in the test,
 * never against a second call into the module under test.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_EVENT_DATA_VERSIONS,
  ACTION_EVENT_LABELS,
  ACTION_EVENT_SPEC_VERSION,
  ACTION_EVENT_TYPES,
  MAX_ACTION_SUBSCRIPTION_PATTERNS,
  actionEventId,
  actionSubscriptionMatches,
  buildActionEvent,
  decodeActionEventBody,
  deriveRunEventTypes,
  encodeActionEventBody,
  isActionEventType,
  parseActionSubscription,
  pickActionEvent,
} from './action-events';
import type { RunEventData } from './action-events';

const runData = (over: Partial<RunEventData> = {}): RunEventData => ({
  runId: 'run1',
  projectId: 'proj1',
  projectName: 'Storefront',
  environmentId: 'env1',
  environmentName: 'staging',
  status: 'FAILED',
  trigger: 'CI',
  counts: { total: 41, passed: 38, failed: 3, flaky: 0, skipped: 0 },
  gate: { passed: false, blocked: [] },
  commitSha: 'abc1234',
  branch: 'main',
  prNumber: 7,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:05:00.000Z',
  failures: [],
  failuresTruncated: 0,
  url: 'https://app.example/runs/run1',
  ...over,
});

describe('the vocabulary', () => {
  it('gives every event type a payload version and a label', () => {
    // Catches the real mistake: adding a seventh type and forgetting one of the
    // two maps, which ships `dataVersion: undefined` on the wire.
    for (const type of ACTION_EVENT_TYPES) {
      expect(typeof ACTION_EVENT_DATA_VERSIONS[type]).toBe('number');
      expect(ACTION_EVENT_LABELS[type]?.length).toBeGreaterThan(0);
    }
    expect(ACTION_EVENT_TYPES.length).toBe(Object.keys(ACTION_EVENT_DATA_VERSIONS).length);
    expect(ACTION_EVENT_TYPES.length).toBe(Object.keys(ACTION_EVENT_LABELS).length);
  });

  it('names exactly the six events this wave publishes', () => {
    // Spelled out rather than derived. Removing or renaming one is a breaking
    // change to a published contract and should require editing this list.
    expect([...ACTION_EVENT_TYPES]).toEqual([
      'run.finished',
      'run.failed',
      'gate.blocked',
      'monitor.down',
      'heal.proposed',
      'flake.detected',
    ]);
  });

  it('refuses anything outside the vocabulary', () => {
    expect(isActionEventType('run.failed')).toBe(true);
    expect(isActionEventType('run.succeeded')).toBe(false);
    expect(isActionEventType('')).toBe(false);
    expect(isActionEventType(null)).toBe(false);
    expect(isActionEventType(42)).toBe(false);
  });
});

describe('the idempotency key', () => {
  it('is a stable, spelled-out string', () => {
    // Pinned literally. This value is what receivers deduplicate on; if a
    // refactor changes the shape, every one of them replays history.
    expect(actionEventId('run.failed', ['clx123'])).toBe('run.failed:clx123');
    expect(actionEventId('monitor.down', ['mon1', '3'])).toBe('monitor.down:mon1:3');
  });

  it('is identical across two independent calls with the same subject', () => {
    expect(actionEventId('run.finished', ['run1'])).toBe(actionEventId('run.finished', ['run1']));
  });

  it('sanitises a subject that could poison an id downstream', () => {
    // The id becomes part of a database primary key and a BullMQ job id. A
    // subject carrying a colon would silently change the shape of both.
    expect(actionEventId('run.failed', ['a:b', 'c/d'])).toBe('run.failed:a-b:c-d');
    expect(actionEventId('run.failed', ['', '  '])).toBe('run.failed:--');
  });
});

describe('buildActionEvent', () => {
  it('stamps the envelope and payload versions from the maps', () => {
    const event = buildActionEvent({
      type: 'run.failed',
      orgId: 'org1',
      projectId: 'proj1',
      subject: ['run1'],
      occurredAt: '2026-01-01T00:05:00.000Z',
      data: runData(),
    });

    expect(event.specVersion).toBe(ACTION_EVENT_SPEC_VERSION);
    expect(event.dataVersion).toBe(1);
    expect(event.id).toBe('run.failed:run1');
    expect(event.type).toBe('run.failed');
    expect(event.orgId).toBe('org1');
    expect(event.occurredAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('normalises a Date to ISO-8601', () => {
    const event = buildActionEvent({
      type: 'run.finished',
      orgId: 'org1',
      projectId: null,
      subject: ['run1'],
      occurredAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      data: runData(),
    });
    expect(event.occurredAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('substitutes now rather than shipping "Invalid Date" on the wire', () => {
    const event = buildActionEvent({
      type: 'run.finished',
      orgId: 'org1',
      projectId: null,
      subject: ['run1'],
      occurredAt: 'not a date',
      data: runData(),
    });
    // A receiver parsing `occurredAt` must never be handed an unparseable
    // string because a column was null upstream.
    expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
  });
});

describe('deriveRunEventTypes', () => {
  it('puts the most specific type first for a red, blocked run', () => {
    expect(
      deriveRunEventTypes({ counts: { failed: 3 }, gate: { blocked: ['flake rate too high'] } }),
    ).toEqual(['gate.blocked', 'run.failed', 'run.finished']);
  });

  it('reports a green run blocked by the gate as blocked', () => {
    // The case that used to announce itself as "all 41 passed" while the deploy
    // it blocked sat waiting — a gate can block on run SHAPE with every test
    // green, and an automation watching for held merges has to see it.
    expect(
      deriveRunEventTypes({ counts: { failed: 0 }, gate: { blocked: ['p95 over budget'] } }),
    ).toEqual(['gate.blocked', 'run.finished']);
  });

  it('reports a clean run as nothing but finished', () => {
    expect(deriveRunEventTypes({ counts: { failed: 0 }, gate: { blocked: [] } })).toEqual([
      'run.finished',
    ]);
  });
});

describe('parseActionSubscription', () => {
  it('reads the events an action asked for', () => {
    const parsed = parseActionSubscription({
      actions: { events: ['run.failed', 'gate.blocked'] },
    });
    expect(parsed.events).toEqual(['run.failed', 'gate.blocked']);
    expect(parsed.unknown).toEqual([]);
  });

  it('accepts the wildcard and a prefix pattern', () => {
    expect(parseActionSubscription({ actions: { events: ['*'] } }).events).toEqual(['*']);
    expect(parseActionSubscription({ actions: { events: ['run.*'] } }).events).toEqual(['run.*']);
  });

  it('separates a typo instead of silently dropping it', () => {
    // The failure this prevents: an action subscribed to `run.suceeded` looks
    // exactly like an action whose event has not happened yet.
    const parsed = parseActionSubscription({ actions: { events: ['run.suceeded', 'run.failed'] } });
    expect(parsed.events).toEqual(['run.failed']);
    expect(parsed.unknown).toEqual(['run.suceeded']);
  });

  it('refuses a prefix pattern that covers nothing', () => {
    expect(parseActionSubscription({ actions: { events: ['runn.*'] } })).toEqual({
      events: [],
      unknown: ['runn.*'],
    });
    // `run.finished.*` looks plausible and matches no event type.
    expect(parseActionSubscription({ actions: { events: ['run.finished.*'] } }).events).toEqual([]);
  });

  it('fails closed on every shape a JSON column can actually hold', () => {
    for (const config of [null, undefined, 'nope', 42, [], {}, { actions: null }, { actions: 7 }]) {
      expect(parseActionSubscription(config)).toEqual({ events: [], unknown: [] });
    }
    expect(parseActionSubscription({ actions: { events: 'run.failed' } }).events).toEqual([]);
    expect(parseActionSubscription({ actions: { events: [1, true, null] } }).events).toEqual([]);
  });

  it('trims, lower-cases and de-duplicates', () => {
    const parsed = parseActionSubscription({
      actions: { events: ['  RUN.FAILED ', 'run.failed'] },
    });
    expect(parsed.events).toEqual(['run.failed']);
  });

  it('bounds how many patterns one action may carry', () => {
    const many = new Array<string>(MAX_ACTION_SUBSCRIPTION_PATTERNS + 10).fill('run.finished');
    // De-duplication collapses these, so the assertion that matters is the
    // slice: an unbounded list walked once per candidate per event is a loop a
    // customer controls the length of.
    many[MAX_ACTION_SUBSCRIPTION_PATTERNS] = 'gate.blocked';
    const parsed = parseActionSubscription({ actions: { events: many } });
    expect(parsed.events).toEqual(['run.finished']);
  });
});

describe('actionSubscriptionMatches', () => {
  it('matches exactly, by wildcard, and by prefix', () => {
    expect(actionSubscriptionMatches(['run.failed'], 'run.failed')).toBe(true);
    expect(actionSubscriptionMatches(['*'], 'heal.proposed')).toBe(true);
    expect(actionSubscriptionMatches(['run.*'], 'run.finished')).toBe(true);
  });

  it('does not let a prefix reach outside its own subject', () => {
    expect(actionSubscriptionMatches(['run.*'], 'gate.blocked')).toBe(false);
    expect(actionSubscriptionMatches(['run.failed'], 'run.finished')).toBe(false);
    expect(actionSubscriptionMatches([], 'run.finished')).toBe(false);
  });

  it('treats `.*` as a literal suffix, not a regular expression', () => {
    // The whole point of matching with startsWith on a slice. If a pattern were
    // ever compiled, `.*` would subscribe to everything and `.` would be a
    // single-character wildcard — both of which would be somebody's automation
    // receiving events they never asked for.
    expect(actionSubscriptionMatches(['.*'], 'run.finished')).toBe(false);
    expect(actionSubscriptionMatches(['run?finished'], 'run.finished')).toBe(false);
    expect(actionSubscriptionMatches(['run.finishe.'], 'run.finished')).toBe(false);
  });
});

describe('pickActionEvent', () => {
  it('delivers one event, the narrowest the action asked for', () => {
    // A broadly-subscribed action must not open three tickets for one red run.
    expect(
      pickActionEvent(['run.finished', 'run.failed'], [
        'gate.blocked',
        'run.failed',
        'run.finished',
      ]),
    ).toBe('run.failed');
  });

  it('falls back to the broader type when the narrow one was not requested', () => {
    expect(pickActionEvent(['run.finished'], ['run.failed', 'run.finished'])).toBe('run.finished');
  });

  it('returns null when nothing was asked for', () => {
    expect(pickActionEvent(['monitor.down'], ['run.failed', 'run.finished'])).toBeNull();
    expect(pickActionEvent([], ['run.finished'])).toBeNull();
  });

  it('gives a wildcard subscriber the most specific type once', () => {
    expect(pickActionEvent(['*'], ['gate.blocked', 'run.failed', 'run.finished'])).toBe(
      'gate.blocked',
    );
  });
});

describe('the wire body', () => {
  const event = buildActionEvent({
    type: 'run.failed',
    orgId: 'org1',
    projectId: 'proj1',
    subject: ['run1'],
    occurredAt: '2026-01-01T00:05:00.000Z',
    data: runData({ failures: [{ testId: 't1', name: 'checkout', filePath: 'a.spec.ts', status: 'FAILED' }] }),
  });

  it('round-trips through the string field the sender carries it in', () => {
    const decoded = decodeActionEventBody(encodeActionEventBody(event));
    expect(decoded).toEqual(event);
  });

  it('reads an already-parsed object too', () => {
    expect(decodeActionEventBody(JSON.parse(encodeActionEventBody(event)))).toEqual(event);
  });

  it('refuses anything that is not an envelope', () => {
    // Fail closed: a dispatcher that accepted these would be POSTing an untyped
    // blob to somebody's automation.
    expect(decodeActionEventBody('not json')).toBeNull();
    expect(decodeActionEventBody(null)).toBeNull();
    expect(decodeActionEventBody(7)).toBeNull();
    expect(decodeActionEventBody({ ...event, type: 'run.exploded' })).toBeNull();
    expect(decodeActionEventBody({ ...event, id: '' })).toBeNull();
    expect(decodeActionEventBody({ ...event, orgId: undefined })).toBeNull();
    expect(decodeActionEventBody({ ...event, specVersion: '1' })).toBeNull();
    expect(decodeActionEventBody({ ...event, data: null })).toBeNull();
  });
});
