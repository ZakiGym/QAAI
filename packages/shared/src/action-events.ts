/**
 * Event actions (§7) — the event vocabulary, and the contract it is a contract for.
 *
 * QAAI observes things worth reacting to: a run finished, a run failed, a
 * quality gate blocked a merge, a monitor paged, the Healer proposed a fix, the
 * flake radar confirmed a flaky test. Until now the only possible reaction was
 * a chat message written for a human. This module is the machine-readable half:
 * a customer registers an ACTION against an event type, and QAAI POSTs them a
 * typed envelope when it happens.
 *
 * ── This is a public contract from the first customer who builds on it ───────
 *
 * Somebody's deploy pipeline will parse these fields. That makes every name
 * here load-bearing in a way the chat renderers next door are not — a chat
 * message can be reworded, `counts.failed` cannot be renamed. So:
 *
 *   • ADDING a field is always allowed and never bumps a version. Receivers
 *     must ignore fields they do not know; that is stated in the docs.
 *   • RENAMING, REMOVING or RETYPING a field bumps that event's entry in
 *     `ACTION_EVENT_DATA_VERSIONS`. `dataVersion` rides on every envelope so a
 *     receiver can switch on it instead of guessing from the shape.
 *   • `ACTION_EVENT_SPEC_VERSION` versions the ENVELOPE — the wrapper fields
 *     every event shares. It moves far less often than any payload, which is
 *     exactly why the two are separate numbers rather than one.
 *   • A new event TYPE is additive: an action only receives the types it asked
 *     for, so nobody's receiver sees a shape it did not opt into.
 *
 * ── Delivery guarantees, stated because a vague guarantee is a lie ───────────
 *
 * AT-LEAST-ONCE. Not exactly-once — exactly-once across a network boundary is
 * not something this system (or any) can offer, and claiming it would just move
 * the deduplication into a receiver that was told it did not need any. The
 * queue retries, a worker can die between the POST landing and the row
 * recording it, and either of those produces a second copy of the same event.
 *
 * What we give instead is a stable IDENTITY: `ActionEvent.id` is derived from
 * the event type and the row it is about, so every copy of one occurrence
 * carries the same id, forever. A receiver that remembers ids it has processed
 * gets effectively-once for the cost of one lookup. That derivation lives in
 * `actionEventId` and is part of the contract — it must stay deterministic.
 *
 * ── No Node imports, on purpose ──────────────────────────────────────────────
 *
 * Types, constants and pure functions only. The dispatcher (the worker's
 * processors/actions.ts) is where the database reads, the egress policy and the
 * DNS lookups live. This half has to stay importable from anywhere — including
 * a bundler that would choke on `node:dns` — because the same vocabulary has to
 * be describable in the UI, checkable in the API and emitted in the worker.
 */

import type { RunStatus } from './constants';
import type { RunTrigger } from './job-enums';

// ─── Versions ────────────────────────────────────────────────────────────────

/**
 * The envelope version. Bumped only when the WRAPPER changes — a field added
 * beside `type`/`data`, or one of them changing meaning. Payload changes do not
 * touch this; they move `ACTION_EVENT_DATA_VERSIONS` instead.
 */
export const ACTION_EVENT_SPEC_VERSION = 1;

// ─── The vocabulary ──────────────────────────────────────────────────────────

/**
 * Every event an action can subscribe to.
 *
 * Dotted `subject.verb`, past tense, and the subject first so the prefix
 * patterns below (`run.*`) group the way a reader expects. Order matters in one
 * place only: `deriveRunEventTypes` returns candidates most-specific-first.
 */
export const ACTION_EVENT_TYPES = [
  'run.finished',
  'run.failed',
  'gate.blocked',
  'monitor.down',
  'heal.proposed',
  'flake.detected',
] as const;

export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

export function isActionEventType(value: unknown): value is ActionEventType {
  return typeof value === 'string' && (ACTION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Payload version per event type. All 1 today; the point of the map is that a
 * breaking change to ONE payload does not force a version bump on the other
 * five, which is what happens the moment there is a single global number.
 */
export const ACTION_EVENT_DATA_VERSIONS: Record<ActionEventType, number> = {
  'run.finished': 1,
  'run.failed': 1,
  'gate.blocked': 1,
  'monitor.down': 1,
  'heal.proposed': 1,
  'flake.detected': 1,
};

/** One sentence each, for the subscription UI and for generated documentation. */
export const ACTION_EVENT_LABELS: Record<ActionEventType, string> = {
  'run.finished': 'Every run that reaches a terminal state, green or red.',
  'run.failed': 'A run with at least one failing test.',
  'gate.blocked': 'A quality gate blocked a run — the merge is being held.',
  'monitor.down': 'A monitor crossed its consecutive-failure threshold.',
  'heal.proposed': 'The Healer proposed a fix for a broken test.',
  'flake.detected': 'The flake radar confirmed a test is flaky.',
};

// ─── Payloads ────────────────────────────────────────────────────────────────

/**
 * How many failing tests an event names before it starts counting instead.
 *
 * Bounded because the envelope is an HTTP body: a 4,000-test suite that fails
 * wholesale would otherwise produce a multi-megabyte POST to a receiver that
 * budgeted for a few kilobytes, and the useful signal ("the whole suite is
 * down") is already in `counts`. `failuresTruncated` carries what was left out
 * so the receiver knows it is looking at a sample, not the set.
 */
export const MAX_FAILURES_IN_ACTION_EVENT = 20;

export interface ActionRunFailure {
  testId: string;
  name: string;
  filePath: string;
  /** TestResultStatus — `FAILED` or `TIMED_OUT`. Widened to string so a new
   *  result status added upstream cannot break a receiver's parse. */
  status: string;
}

/**
 * One run, as the three run-shaped events all describe it.
 *
 * `run.finished`, `run.failed` and `gate.blocked` deliberately SHARE this
 * payload rather than each having their own. They are not different facts —
 * they are the same finished run seen through different filters, and a receiver
 * that starts on `run.failed` and later also wants green runs should not have
 * to write a second parser to do it. The event type is the filter; the data is
 * the run.
 */
export interface RunEventData {
  runId: string;
  projectId: string;
  projectName: string | null;
  environmentId: string;
  environmentName: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  counts: {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
  };
  gate: {
    passed: boolean;
    /** The BLOCK rules, as sentences. Empty when nothing blocked. */
    blocked: string[];
  };
  commitSha: string | null;
  branch: string | null;
  prNumber: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** At most `MAX_FAILURES_IN_ACTION_EVENT` of them. */
  failures: ActionRunFailure[];
  /** How many failures did not fit above. 0 when the list is complete. */
  failuresTruncated: number;
  /** Deep link into the cockpit, or null when the worker has no public URL. */
  url: string | null;
}

export interface MonitorDownData {
  monitorId: string;
  name: string;
  /** Consecutive failed checks at the moment the threshold was crossed. */
  streak: number;
  projectId: string;
  environmentId: string;
  environmentName: string | null;
  /** The check that tripped it. */
  runId: string;
  url: string | null;
}

export interface HealProposedData {
  proposalId: string;
  testId: string;
  testName: string;
  filePath: string;
  projectId: string;
  /** HealRisk: SELECTOR_ONLY | ASSERTION_CHANGE | STRUCTURAL. */
  riskLevel: string;
  /** 0–1. */
  confidence: number;
  /**
   * The diff is deliberately NOT here. It is unbounded, it is the customer's
   * source code, and an action URL is a destination we cannot vouch for — a
   * receiver that wants the patch can fetch it from the API with its own
   * credential. The event says a proposal exists and where to find it.
   */
  url: string | null;
}

export interface FlakeDetectedData {
  testId: string;
  testName: string;
  filePath: string;
  projectId: string;
  suiteId: string | null;
  /** 0–1, as maintained by the run finaliser. */
  flakeRate: number;
  /** Whether the radar also quarantined it. */
  quarantined: boolean;
  url: string | null;
}

/** Which payload each event type carries. The map IS the contract. */
export interface ActionEventDataMap {
  'run.finished': RunEventData;
  'run.failed': RunEventData;
  'gate.blocked': RunEventData;
  'monitor.down': MonitorDownData;
  'heal.proposed': HealProposedData;
  'flake.detected': FlakeDetectedData;
}

// ─── The envelope ────────────────────────────────────────────────────────────

export interface ActionEvent<T extends ActionEventType = ActionEventType> {
  specVersion: number;
  /**
   * The idempotency key. Deterministic from the type and the subject row, so
   * every redelivery of one occurrence carries the same value — see the
   * at-least-once note at the top of this file.
   */
  id: string;
  type: T;
  /** Version of `data`'s shape for this `type`. */
  dataVersion: number;
  orgId: string;
  /** Null for an event that is not about one project. */
  projectId: string | null;
  /** ISO-8601, UTC. When the thing happened, not when it was delivered. */
  occurredAt: string;
  data: ActionEventDataMap[T];
}

/**
 * The event id, and therefore the idempotency key.
 *
 * Deterministic and STABLE — changing this derivation silently re-delivers
 * history to every receiver that deduplicates on it, so it is as much a
 * published interface as the field names are.
 *
 * The sanitiser is a fixed pattern over the parts (never a pattern compiled
 * FROM them): ids are cuids today, but this id becomes part of a database
 * primary key and a BullMQ job id downstream, and neither should be at the
 * mercy of whatever a future subject id turns out to contain.
 */
export function actionEventId(type: ActionEventType, subject: readonly string[]): string {
  const parts = subject
    .map((part) => String(part).replace(/[^A-Za-z0-9._-]/g, '-'))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? `${type}:${parts.join(':')}` : type;
}

export interface BuildActionEventInput<T extends ActionEventType> {
  type: T;
  orgId: string;
  projectId: string | null;
  /** The row(s) this event is about. Feeds `actionEventId`. */
  subject: readonly string[];
  occurredAt: Date | string;
  data: ActionEventDataMap[T];
}

/** Stamp an envelope. The only supported way to mint one — it is what keeps
 *  `specVersion`, `dataVersion` and the id derivation in one place. */
export function buildActionEvent<T extends ActionEventType>(
  input: BuildActionEventInput<T>,
): ActionEvent<T> {
  const occurred = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  return {
    specVersion: ACTION_EVENT_SPEC_VERSION,
    id: actionEventId(input.type, input.subject),
    type: input.type,
    dataVersion: ACTION_EVENT_DATA_VERSIONS[input.type],
    orgId: input.orgId,
    projectId: input.projectId,
    // An unparseable date must not produce `"Invalid Date"` on the wire, and it
    // must not throw either — the event is the point, the timestamp is detail.
    occurredAt: Number.isNaN(occurred.getTime())
      ? new Date().toISOString()
      : occurred.toISOString(),
    data: input.data,
  };
}

/**
 * Which run-shaped events one finished run IS, most specific first.
 *
 * A red run that the gate also blocked is all three at once; the ordering is
 * what lets `pickActionEvent` hand each action the narrowest type it asked for
 * instead of firing it three times. See that function for why once matters.
 */
export function deriveRunEventTypes(run: {
  counts: { failed: number };
  gate: { blocked: string[] };
}): ActionEventType[] {
  const types: ActionEventType[] = [];
  if (run.gate.blocked.length > 0) types.push('gate.blocked');
  if (run.counts.failed > 0) types.push('run.failed');
  types.push('run.finished');
  return types;
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

/** Subscribe to everything, including event types that do not exist yet. */
export const ACTION_EVENT_WILDCARD = '*';

/**
 * How many patterns one action may subscribe with.
 *
 * The list comes out of a customer-editable JSON column and is walked once per
 * candidate type per event, so it is bounded for the same reason every other
 * customer-supplied list in this repo is: nothing that runs inside a dispatch
 * loop gets to be unbounded because somebody pasted a thousand entries.
 */
export const MAX_ACTION_SUBSCRIPTION_PATTERNS = 32;

export interface ActionSubscription {
  /** Patterns that name something in the vocabulary. */
  events: string[];
  /**
   * Entries that named nothing. Kept rather than dropped silently so the
   * dispatcher can say "this action asked for `run.suceeded` and will never
   * fire" — a typo in a subscription is otherwise indistinguishable from an
   * event that simply has not happened yet, which is the worst way to spend an
   * afternoon.
   */
  unknown: string[];
}

/**
 * Read an action's subscription out of `Integration.config`.
 *
 * The shape is `{ actions: { events: ["run.failed", "gate.blocked"] } }`.
 * Everything about it is untrusted — it is a JSON column a customer edits — so
 * this fails CLOSED in every direction: a config that is not an object, an
 * `events` that is not an array, an entry that is not a string, or a pattern
 * that matches no known event all yield no subscription rather than a guess.
 * An action that subscribes to nothing fires for nothing.
 */
export function parseActionSubscription(config: unknown): ActionSubscription {
  const root = (config ?? {}) as { actions?: unknown };
  const actions = (root.actions ?? {}) as { events?: unknown };
  const raw = Array.isArray(actions.events) ? actions.events : [];

  const events: string[] = [];
  const unknown: string[] = [];

  for (const entry of raw.slice(0, MAX_ACTION_SUBSCRIPTION_PATTERNS)) {
    if (typeof entry !== 'string') continue;
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (events.includes(pattern) || unknown.includes(pattern)) continue;
    if (isKnownPattern(pattern)) events.push(pattern);
    else unknown.push(pattern);
  }

  return { events, unknown };
}

/**
 * A pattern is known if it is the wildcard, an event type, or a `prefix.*` that
 * covers at least one event type. The last clause is the one that matters: it
 * is what stops `runn.*` from being accepted as a subscription that can never
 * fire, and it is checked against the vocabulary rather than with a pattern
 * built out of the customer's string.
 */
function isKnownPattern(pattern: string): boolean {
  if (pattern === ACTION_EVENT_WILDCARD) return true;
  if (isActionEventType(pattern)) return true;
  if (!pattern.endsWith('.*')) return false;
  const prefix = pattern.slice(0, -1);
  return ACTION_EVENT_TYPES.some((type) => type.startsWith(prefix));
}

/**
 * Does this subscription cover `type`?
 *
 * Prefix matching is done with `startsWith` on a literal slice, deliberately.
 * The subscription is customer input and this repo does not compile a regular
 * expression from customer input — a `.*` here is a suffix this function
 * understands, not a pattern handed to an engine.
 */
export function actionSubscriptionMatches(
  events: readonly string[],
  type: ActionEventType,
): boolean {
  for (const pattern of events) {
    if (pattern === ACTION_EVENT_WILDCARD) return true;
    if (pattern === type) return true;
    if (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/**
 * The one event this action should receive for this occurrence, or null.
 *
 * `candidates` arrives most-specific-first. An action subscribed to both
 * `run.failed` and `run.finished` gets ONE delivery for a red run — the
 * `run.failed` one — rather than two.
 *
 * That is a deliberate guarantee, not an optimisation. An action is somebody's
 * automation: it opens a ticket, it pages a rotation, it re-runs a deploy.
 * Delivering the same run three times because they subscribed broadly means
 * three tickets, and "we sent you every event that matched" is no comfort to
 * the person closing two of them. One occurrence, one event, narrowest match.
 */
export function pickActionEvent(
  events: readonly string[],
  candidates: readonly ActionEventType[],
): ActionEventType | null {
  for (const candidate of candidates) {
    if (actionSubscriptionMatches(events, candidate)) return candidate;
  }
  return null;
}

// ─── The wire body ───────────────────────────────────────────────────────────

/**
 * The envelope, serialised for transport.
 *
 * WHY THIS EXISTS AS A NAMED FUNCTION rather than a bare `JSON.stringify` at
 * the call site: the outbound sender this feature reuses (the worker's
 * `processDelivery`, via `chatPayload`) puts a generic webhook's body together
 * as `{ event, text }`, where `text` is a string. So the envelope travels as
 * JSON inside that string field, and a receiver's first step is
 * `JSON.parse(body.text)`.
 *
 * That double encoding is not a design anyone would choose; it is the price of
 * having exactly ONE outbound sender, with one retry policy, one delivery log
 * and one dead-letter story. A second sender that produced a prettier body
 * would be a second thing to notice had stopped working. The pairing of
 * encode/decode here is what makes the awkward shape a stated contract instead
 * of a surprise, and it is the seam where a future `chatPayload` that carries a
 * structured `payload` key can be adopted without moving the parse.
 */
export function encodeActionEventBody(event: ActionEvent): string {
  return JSON.stringify(event);
}

/**
 * Read an envelope back — from the `text` field of a delivery, or from a job
 * payload that crossed a process boundary and may have been written by an older
 * deploy. Returns null rather than throwing, and rejects anything whose type is
 * not in the vocabulary: a dispatcher that fanned out an event it cannot name
 * would be POSTing an untyped blob to a customer's automation.
 */
export function decodeActionEventBody(raw: unknown): ActionEvent | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const event = parsed as Partial<ActionEvent>;
  if (!isActionEventType(event.type)) return null;
  if (typeof event.id !== 'string' || event.id.length === 0) return null;
  if (typeof event.orgId !== 'string' || event.orgId.length === 0) return null;
  if (typeof event.occurredAt !== 'string') return null;
  if (typeof event.specVersion !== 'number') return null;
  if (!event.data || typeof event.data !== 'object') return null;

  return event as ActionEvent;
}
