/**
 * Event actions (§7) — running other people's automation off what QAAI sees.
 *
 * An ACTION is a customer-registered reaction to an event: "when a run fails,
 * POST this envelope to my endpoint". The vocabulary and the payload shapes are
 * the public contract in packages/shared/src/action-events.ts; this file is the
 * dispatcher — it turns one occurrence into zero or more outbound deliveries.
 *
 * ── What this file deliberately does NOT do ──────────────────────────────────
 *
 * It does not send anything. Not one `fetch`.
 *
 * There is already an outbound sender in this worker — `processDelivery` in
 * processors/notify.ts — with a WebhookDelivery row per destination, every
 * attempt recorded on it, exponential backoff through the queue, a FAILED row
 * as the dead letter, an HMAC signature, `redirect: 'manual'`, and a delivery
 * log the customer can read at GET /integrations/:id/deliveries. Writing a
 * second sender here would mean two retry policies, two dead-letter stories and
 * two places to notice one of them had quietly stopped working. So a dispatch
 * ends where `fanOutToChat` ends: a row, and one `enqueueDelivery`.
 *
 * What that costs is stated where it bites — see `checkActionDestination` on
 * the resolve/connect race, and `encodeActionEventBody` in @qaai/shared on the
 * body shape.
 *
 * ── Registration, without a new table ────────────────────────────────────────
 *
 * An action IS an `Integration` row of kind WEBHOOK whose config carries
 * `{ actions: { events: [...] } }`. Reusing the row is what gets this feature
 * the vault-sealed URL, the enable/disable switch, the org scoping and the
 * delivery history for free.
 *
 * WEBHOOK only, and that is a decision rather than an oversight: SLACK, TEAMS
 * and DISCORD rows exist to receive prose written for a human at 3am, and
 * posting a JSON envelope into one of them produces an unreadable blob in a
 * channel that is already getting the readable version from notify.ts.
 *
 * ── Untrusted by default ─────────────────────────────────────────────────────
 *
 * The customer installed this action themselves, and it is still untrusted. It
 * names a URL, and we make the request — from inside our network, from our
 * address space, with our egress. `http://169.254.169.254/` is not an exotic
 * attack, it is the first thing anyone tries, and `localhost:5432` is the
 * second. Every check below fails CLOSED: anything unparseable, unresolvable,
 * ambiguous or merely unfamiliar is refused and recorded, never attempted.
 *
 * ── Isolation ────────────────────────────────────────────────────────────────
 *
 * One action failing must not stop the others, and must not fail the run that
 * triggered it. Each dispatch is its own try/catch; the processor returns
 * normally with a summary in the log. It re-throws only when NOTHING could be
 * attempted (the read of the actions themselves failed), because that is the
 * only failure a retry can fix.
 *
 * ── Guarantee ────────────────────────────────────────────────────────────────
 *
 * AT-LEAST-ONCE. The delivery row id and the delivery job id are both derived
 * from the event id, so a retried dispatch re-claims the same row and collapses
 * onto the same job rather than paging twice — but a worker that dies between
 * the POST landing and the row recording it will send a second copy, and no
 * amount of care here changes that. The envelope's `id` is the idempotency key
 * a receiver deduplicates on; it is stable across every copy of one occurrence.
 */

import { promises as dns } from 'node:dns';
import { Queue } from 'bullmq';
import { describeWebhookFailure } from '@qaai/shared';
import type { NotifyJob } from '@qaai/shared';
/*
 * WHY THIS IMPORT IS A RELATIVE PATH: @qaai/shared exports only its barrel and
 * `./constants`, and adding `action-events` to packages/shared/src/index.ts is
 * a change to a file this wave does not own. Same workaround, for the same
 * reason and with the same resolution behaviour under tsc, tsx and vitest, as
 * the @qaai/storage `gc.js` import at the top of processors/retention.ts. It is
 * one line for the owner of that barrel to fix; see the report.
 */
import {
  MAX_FAILURES_IN_ACTION_EVENT,
  buildActionEvent,
  deriveRunEventTypes,
  encodeActionEventBody,
  parseActionSubscription,
  pickActionEvent,
} from '../../../../packages/shared/src/action-events.js';
import type {
  ActionEvent,
  ActionEventType,
  FlakeDetectedData,
  HealProposedData,
  MonitorDownData,
  RunEventData,
} from '../../../../packages/shared/src/action-events.js';
import { connection, logger, prisma } from '../context.js';
import { enqueueDelivery } from '../queues.js';
import { open as openSecret } from '../vault.js';
/*
 * The same pure module notify.ts and the API's integrations CRUD use. Two
 * implementations of "is this really a webhook destination" is how a URL
 * accepted at the door gets refused at delivery, or worse, the other way round.
 */
import {
  decodeChatCredentials,
  integrationAad,
} from '../../../api/src/lib/chat-integrations.js';
/*
 * ONE list of names that resolve inside a private network, shared with the Jira
 * and generic-webhook guards. A name added there (`.svc` was, after somebody
 * noticed `kubernetes.default.svc` is reachable from every pod) is refused an
 * action payload the same day, rather than waiting for someone to remember the
 * second copy.
 */
import { isInternalHostname } from '../../../api/src/lib/issues.js';
/*
 * Gate rules are read with notify.ts's own helper rather than a second copy:
 * "which rules blocked this run" has exactly one right answer, and the chat
 * alert and the action payload disagreeing about it would be a bug nobody
 * would find until a customer's automation and their Slack channel told two
 * different stories about the same merge.
 */
import { blockingGateRules } from './notify.js';

/**
 * Its own queue, like flake, bisect and retention.
 *
 * NOT in `QUEUE_NAMES` (packages/shared/src/constants.ts) only because this
 * wave does not own that file — the same reason and the same shape as
 * `RETENTION_QUEUE`. `npm run check:wiring` reads this literal, so it cannot
 * drift from the registration in index.ts without CI noticing.
 */
export const ACTIONS_QUEUE = 'qaai.actions';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/**
 * How many actions one event may fan out to.
 *
 * An event is triggered by a run, and a run is triggered by a push. Without a
 * ceiling, one org with a scripted integration import turns every commit into
 * hundreds of outbound requests from our egress — which is a bill, a rate-limit
 * problem at whoever receives them, and a fine denial-of-service amplifier
 * pointed at a third party. Twenty is generous for a real team and small enough
 * to be uninteresting as a weapon. Exceeding it is logged at error rather than
 * silently truncated: a customer whose 21st action never fires deserves to have
 * that fact exist somewhere.
 */
export const MAX_ACTIONS_PER_EVENT = 20;

/**
 * Ceiling on one serialised envelope. The payload is already bounded field by
 * field (`MAX_FAILURES_IN_ACTION_EVENT`, no diffs, no logs), so hitting this
 * means something upstream grew unexpectedly — a test name pasted from a stack
 * trace, a gate rule detail built from an error. Refuse and record rather than
 * POST an unbounded body to somebody's endpoint.
 */
export const MAX_ACTION_BODY_BYTES = 64 * 1024;

/** Bound the DNS check, so a hostile resolver cannot hold a worker slot. */
const DNS_TIMEOUT_MS = 5_000;

// ─── The job ─────────────────────────────────────────────────────────────────

/**
 * One occurrence, as it rides the queue.
 *
 * `kind` says what HAPPENED; the dispatcher decides which event TYPES that is
 * (a red run blocked by the gate is `gate.blocked`, `run.failed` and
 * `run.finished` at once). Keeping the two apart is what lets the derivation
 * live in one tested place instead of at every producer.
 *
 * Ids, not objects — the rule at the top of packages/shared/src/jobs.ts. The
 * exceptions are the fields the ROW no longer proves by the time the job runs:
 * a monitor's streak resets on its next green check, and an event that reported
 * "0 failed checks in a row" would be worse than no event at all.
 */
export type ActionEventJob =
  | { orgId: string; kind: 'run'; runId: string; at?: string }
  | {
      orgId: string;
      kind: 'monitor';
      monitorId: string;
      runId: string;
      name: string;
      streak: number;
      at?: string;
    }
  | { orgId: string; kind: 'heal'; proposalId: string; at?: string }
  | { orgId: string; kind: 'flake'; testId: string; at?: string };

let actionsQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection. (`queues.ts` builds its producers at import time; that file is
 * not ours to change, and the same workaround is documented at the bottom of
 * processors/retention.ts.)
 */
function queue(): Queue {
  actionsQueue ??= new Queue(ACTIONS_QUEUE, { connection });
  return actionsQueue;
}

/**
 * The BullMQ job id, and therefore the deduplication key for the ENQUEUE half.
 *
 * Deterministic per occurrence: a producer that retries (or two shards that
 * both finalise) collapses onto one job instead of dispatching twice. The
 * monitor key carries the streak because a monitor crossing its threshold
 * twice, weeks apart, is genuinely two occurrences; the flake key carries the
 * day for the same reason.
 */
function actionJobId(job: ActionEventJob): string {
  const day = (job.at ?? new Date().toISOString()).slice(0, 10);
  if (job.kind === 'run') return `action-run-${job.runId}`;
  if (job.kind === 'monitor') return `action-monitor-${job.monitorId}-${job.streak}`;
  if (job.kind === 'heal') return `action-heal-${job.proposalId}`;
  return `action-flake-${job.testId}-${day}`;
}

/**
 * Queue one occurrence.
 *
 * `attempts: 3` because everything this job does before the hand-off is a
 * database read and a DNS lookup, both of which fail transiently and both of
 * which a retry genuinely fixes. The retry is safe to repeat: the delivery row
 * ids it derives are deterministic, so a second pass re-claims the same rows
 * rather than creating new ones.
 */
export async function enqueueActionEvent(job: ActionEventJob): Promise<void> {
  await queue().add(ACTIONS_QUEUE, job, { jobId: actionJobId(job), attempts: 3 });
}

export async function closeActionsQueue(): Promise<void> {
  if (actionsQueue) await actionsQueue.close();
  actionsQueue = null;
}

/**
 * The occurrences a notification implies.
 *
 * Event actions ride the notify queue's trigger rather than being enqueued from
 * run.ts and schedule.ts directly, because index.ts — which this wave owns — is
 * where the notify queue is registered, and a feature that needs an edit in
 * three files other people are editing this wave is a feature that arrives
 * half-wired. The mapping is pure and tested; the producers can call
 * `enqueueActionEvent` directly later without changing anything here.
 */
export function actionJobsFromNotify(job: NotifyJob): ActionEventJob[] {
  const at = new Date().toISOString();

  if (job.event === 'run.finished') {
    const runId = String(job.payload.runId ?? '');
    return runId ? [{ orgId: job.orgId, kind: 'run', runId, at }] : [];
  }

  if (job.event === 'monitor.down') {
    const monitorId = String(job.payload.monitorId ?? '');
    const runId = String(job.payload.runId ?? '');
    if (!monitorId) return [];
    return [
      {
        orgId: job.orgId,
        kind: 'monitor',
        monitorId,
        runId,
        name: String(job.payload.name ?? 'A monitor'),
        streak: Number(job.payload.streak ?? 0),
        at,
      },
    ];
  }

  return [];
}

/**
 * Enqueue whatever a just-processed notification implies, and never throw.
 *
 * Called from index.ts AFTER `processNotify`, in that order deliberately: the
 * chat message is a person being woken up and the action is a machine being
 * poked, and if only one of them is going to happen on a bad day it should be
 * the one with a human on the other end.
 */
export async function dispatchActionsForNotify(job: NotifyJob): Promise<void> {
  for (const actionJob of actionJobsFromNotify(job)) {
    await enqueueActionEvent(actionJob).catch((err) =>
      logger.error({ err, kind: actionJob.kind }, 'could not enqueue an event action'),
    );
  }
}

// ─── Egress policy ───────────────────────────────────────────────────────────

/**
 * What an address is, for the purpose of "may we POST a customer's test results
 * at it from inside our network".
 */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'link-local'
  | 'private'
  | 'multicast'
  | 'reserved'
  | 'unspecified'
  | 'unparseable';

/**
 * Classify a dotted-quad.
 *
 * Anything that is not exactly four plain decimal octets is `unparseable`, and
 * `unparseable` is refused — including octets with leading zeros, which some
 * resolvers and many parsers read as octal (`0177.0.0.1` is 127.0.0.1 to one
 * library and a nonsense hostname to the next). Disagreement between two
 * parsers about what an address means is the entire mechanism of this class of
 * bypass, so the only safe reading of an ambiguous string is "no".
 */
export function classifyIpv4(ip: string): AddressClass {
  const parts = ip.split('.');
  if (parts.length !== 4) return 'unparseable';

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return 'unparseable';
    if (part.length > 1 && part.startsWith('0')) return 'unparseable';
    const value = Number(part);
    if (value > 255) return 'unparseable';
    octets.push(value);
  }

  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT. Not "the internet" by any useful definition, and it is
  // where a surprising number of container networks land.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  // 169.254.0.0/16. The cloud metadata service — 169.254.169.254 on AWS, GCP
  // and Azure alike — lives here. This single line is most of the point of
  // this function.
  if (a === 169 && b === 254) return 'link-local';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'reserved';
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';

  return 'public';
}

/**
 * Expand an IPv6 literal into its eight groups, or null if it is not one.
 *
 * Written out rather than delegated to `net.isIP` because knowing that a string
 * IS an IPv6 address tells us nothing about WHICH address, and the whole
 * question here is which. Handles `::` once, and a trailing embedded IPv4
 * (`::ffff:127.0.0.1`), and refuses a zone index outright — `%eth0` only ever
 * appears on a link-local address, and an address that needs to name an
 * interface is by definition not on the public internet.
 */
export function expandIpv6(ip: string): number[] | null {
  const raw = ip.trim().toLowerCase();
  if (raw.includes('%')) return null;
  if (raw.length === 0 || raw.includes(':::')) return null;

  // A trailing dotted-quad contributes two groups.
  let tail: number[] = [];
  let head = raw;
  const lastColon = raw.lastIndexOf(':');
  const suffix = lastColon >= 0 ? raw.slice(lastColon + 1) : '';
  if (suffix.includes('.')) {
    if (classifyIpv4(suffix) === 'unparseable') return null;
    const [a = 0, b = 0, c = 0, d = 0] = suffix.split('.').map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    head = raw.slice(0, lastColon);
    // `::1.2.3.4` leaves head as `:`, which must still parse as the `::` form.
    if (head === '') head = ':';
  }

  const doubleColon = head.indexOf('::');
  if (doubleColon !== head.lastIndexOf('::')) return null;

  const toGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const out: number[] = [];
    for (const piece of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleColon >= 0) {
    const left = toGroups(head.slice(0, doubleColon));
    const right = toGroups(head.slice(doubleColon + 2));
    if (!left || !right) return null;
    const fill = 8 - (left.length + right.length + tail.length);
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
  } else {
    const only = toGroups(head);
    if (!only) return null;
    groups = [...only, ...tail];
  }

  return groups.length === 8 ? groups : null;
}

/**
 * Classify an IPv6 address.
 *
 * The embedded-IPv4 forms are the interesting ones and each gets handled rather
 * than falling through to `public`: `::ffff:169.254.169.254`, the 6to4 encoding
 * `2002:a9fe:a9fe::`, and NAT64's `64:ff9b::a9fe:a9fe` all name the metadata
 * service, and all three look like ordinary global unicast if you only check
 * the first group. Unique-local `fc00::/7` covers `fd00:ec2::254`, which is
 * exactly the IPv6 metadata endpoint on EC2.
 */
export function classifyIpv6(ip: string): AddressClass {
  const g = expandIpv6(ip);
  if (!g) return 'unparseable';

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  if (g.every((group) => group === 0)) return 'unspecified';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'loopback';
  }

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyIpv4(embedded(g6, g7));
  }
  // 64:ff9b::/96 — NAT64. Same trick, different prefix.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embedded(g6, g7));
  }
  // 2002::/16 — 6to4 carries the IPv4 address in groups 1 and 2.
  if (g0 === 0x2002) return classifyIpv4(embedded(g1, g2));
  // 100::/64 — the discard-only prefix.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved';
  // 2001:db8::/32 — documentation.
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xffc0) === 0xfec0) return 'private';
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';

  return 'public';
}

/** Classify whatever a resolver handed back, v4 or v6. */
export function classifyAddress(ip: string): AddressClass {
  return ip.includes(':') ? classifyIpv6(ip) : classifyIpv4(ip);
}

/**
 * The static half of the egress policy: everything decidable from the URL text.
 *
 * Stricter than `checkChatDestination`'s generic-WEBHOOK rules on purpose, and
 * strictly stricter — anything this admits, that function admits too, which
 * matters because it runs again inside `processDelivery` immediately before the
 * POST. A rule here that the send-time check disagreed with would mean an
 * action that passes at dispatch and dead-letters at send, forever.
 *
 * The extra rules, and why:
 *
 *  • Port must be the https default. A generic webhook may legitimately live on
 *    an odd port; an action pointed at one is indistinguishable from a port
 *    scan run from our address space, and the value of the feature does not
 *    include that.
 *  • No IP literals at all, public ones included. An action names a HOST, so the
 *    resolver's answer is the thing we get to inspect, and there is no second
 *    "trusted literal" path to reason about. One rule is one rule.
 *  • The hostname must look like a hostname. The URL parser has already
 *    punycoded any unicode, so anything left outside `[a-z0-9.-]` is a parser
 *    disagreement waiting to happen.
 *
 * The reason strings name the HOST and never the path: for a webhook the path
 * IS the bearer credential, and the host is already shown in the cockpit.
 */
export function checkActionDestination(
  rawUrl: string,
): { ok: true; url: string; host: string } | { ok: false; reason: string } {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'This action has no destination URL.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That destination URL could not be parsed.' };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'An action destination must be https — the payload describes your test suite.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Remove the embedded credentials from the destination URL.' };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, reason: 'An action destination must use the default https port.' };
  }

  // Trailing dots come off BEFORE any check. `https://localhost./x` resolves
  // exactly like `https://localhost/x`, and one character defeating every
  // anchored guard below is not hypothetical — see the note in lib/issues.ts.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
    return { ok: false, reason: 'That destination host is not a valid hostname.' };
  }
  if (!host.includes('.')) {
    return {
      ok: false,
      reason: `Refusing to send to ${host}: use a public hostname, not a single-label name.`,
    };
  }
  if (isInternalHostname(host)) {
    return {
      ok: false,
      reason: `Refusing to send to ${host}: that name resolves inside a private network.`,
    };
  }
  if (classifyAddress(host) !== 'unparseable') {
    return {
      ok: false,
      reason: 'Refusing to send to an IP address: an action destination must be a hostname.',
    };
  }

  return { ok: true, url: `https://${host}${url.pathname}${url.search}`, host };
}

/** Injectable for tests; the real one is Node's resolver. */
export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

const nodeLookup: LookupFn = (host) =>
  dns.lookup(host, { all: true, verbatim: true, family: 0 });

/**
 * The resolving half: every address this name answers with must be public.
 *
 * EVERY, not "the first" and not "any". A hostname is not a promise about where
 * it points, and a record set that mixes one routable address with
 * `169.254.169.254` is not a misconfiguration — it is the attack, written down.
 * An empty answer is refused too: no addresses is not "no problem".
 *
 * ── The honest limitation ────────────────────────────────────────────────────
 *
 * This is a CHECK, not a PIN. The connection is opened later, by
 * `processDelivery`'s `fetch`, which resolves the name again — so a resolver
 * that answers differently the second time (DNS rebinding, a short TTL, a
 * poisoned cache) can still steer the request somewhere this function refused.
 * Closing that window means handing the sender a pinned address, which is a
 * change to the fetch call in processors/notify.ts — a file this wave does not
 * own. It is written up in the report rather than papered over here, because a
 * mitigation described as a guarantee is worse than no mitigation at all.
 *
 * What the check does buy, today: every static case (`169.254.169.254`,
 * `localhost:5432`, an IP literal, a `.svc` name) is refused outright, and the
 * DNS case is refused unless an attacker controls the resolution race as well
 * as the name. Redirects out of the allowed space are already refused by the
 * sender, which treats a 3xx as an error rather than a hop.
 */
export async function resolveIsPublic(
  host: string,
  lookup: LookupFn = nodeLookup,
): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: string }> {
  let answers: Array<{ address: string }>;
  try {
    answers = await withTimeout(lookup(host), DNS_TIMEOUT_MS);
  } catch (err) {
    /*
     * The shared classifier, so an action's delivery log speaks the same
     * vocabulary as a chat integration's. Node's resolver puts the code on the
     * error itself while undici wraps it in `cause`, so it is re-wrapped here
     * rather than teaching the classifier a second shape — this is the caller
     * adapting to the contract, which is the right direction.
     */
    const described = describeWebhookFailure(
      wrapLookupError(err),
      DNS_TIMEOUT_MS / 1000,
    );
    return { ok: false, reason: `Could not resolve ${host}: ${described}` };
  }

  const addresses = answers.map((answer) => answer.address).filter(Boolean);
  if (addresses.length === 0) {
    return { ok: false, reason: `${host} resolved to no addresses.` };
  }

  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind !== 'public') {
      /*
       * Naming the address is deliberate, and consistent with the rule this
       * file follows everywhere else: the PATH of a webhook URL is the bearer
       * credential and never appears in a log or a delivery row; the host does
       * (the cockpit already displays it), and the address it resolved to is
       * the one fact that makes this refusal actionable instead of baffling.
       */
      return {
        ok: false,
        reason: `Refusing to send to ${host}: it resolves to ${address}, which is a ${kind} address.`,
      };
    }
  }

  return { ok: true, addresses };
}

/**
 * Re-shape a resolver error into what `describeWebhookFailure` reads.
 *
 * The shared classifier expects undici's shape — the syscall code on
 * `err.cause` — while Node's resolver puts it on the error itself. Adapting
 * here rather than teaching the classifier a second shape keeps one vocabulary
 * across every delivery log in the product; a timeout is passed through
 * unwrapped because the classifier recognises it by name.
 */
function wrapLookupError(err: unknown): Error {
  if (err instanceof Error && err.name === 'TimeoutError') return err;
  return new Error('lookup failed', { cause: err });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Named so the shared classifier reports "no answer within 5s" rather
      // than its unknown-error fallback.
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      reject(timeout);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ─── Building the event ──────────────────────────────────────────────────────

function webUrl(path: string): string | null {
  const base = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
  return base ? `${base}${path}` : null;
}

interface BuiltEvent {
  orgId: string;
  projectId: string | null;
  occurredAt: string;
  /** The row(s) the idempotency key is derived from. */
  subject: string[];
  /** Most specific first — see `pickActionEvent`. */
  candidates: ActionEventType[];
  data: RunEventData | MonitorDownData | HealProposedData | FlakeDetectedData;
}

/**
 * Read the subject row and assemble the payload.
 *
 * Every read is scoped by `orgId` from the job, the way every worker processor
 * scopes its own queries — the worker's Prisma client deliberately carries no
 * tenancy extension, because it drains jobs across every org.
 *
 * A subject that is gone returns null and the dispatch ends quietly. That is
 * the right answer rather than a retry: retention swept the run, or somebody
 * deleted the monitor, and neither gets better on the second attempt.
 */
async function buildEvent(job: ActionEventJob): Promise<BuiltEvent | null> {
  const occurredAt = job.at ?? new Date().toISOString();

  if (job.kind === 'run') {
    const run = await prisma.run.findFirst({
      where: { id: job.runId, orgId: job.orgId },
      select: {
        id: true,
        projectId: true,
        environmentId: true,
        status: true,
        trigger: true,
        totalCount: true,
        passedCount: true,
        failedCount: true,
        flakyCount: true,
        skippedCount: true,
        gateResult: true,
        commitSha: true,
        branch: true,
        prNumber: true,
        startedAt: true,
        finishedAt: true,
        project: { select: { name: true } },
        environment: { select: { name: true } },
        results: {
          where: { status: { in: ['FAILED', 'TIMED_OUT'] } },
          // Ordered so a redelivery names the same tests in the same order —
          // an event that is byte-identical to its previous copy is one a
          // receiver can compare, and `id` is the only total ordering here.
          orderBy: { id: 'asc' },
          take: MAX_FAILURES_IN_ACTION_EVENT + 1,
          select: { status: true, testId: true, test: { select: { name: true, filePath: true } } },
        },
      },
    });
    if (!run) return null;

    const over = run.results.length > MAX_FAILURES_IN_ACTION_EVENT;
    const failures = run.results.slice(0, MAX_FAILURES_IN_ACTION_EVENT).map((result) => ({
      testId: result.testId,
      name: result.test.name,
      filePath: result.test.filePath,
      status: String(result.status),
    }));

    // The exact count only when the list was actually cut. `failedCount` cannot
    // stand in for it: it counts FAILED, and this list also holds TIMED_OUT.
    let truncated = 0;
    if (over) {
      const total = await prisma.testResult.count({
        where: { runId: run.id, orgId: job.orgId, status: { in: ['FAILED', 'TIMED_OUT'] } },
      });
      truncated = Math.max(0, total - failures.length);
    }

    // Read once. The chat alert and the action payload must agree about which
    // rules blocked, and calling the classifier twice is how they start not to.
    const blocked = blockingGateRules(run.gateResult);

    const data: RunEventData = {
      runId: run.id,
      projectId: run.projectId,
      projectName: run.project?.name ?? null,
      environmentId: run.environmentId,
      environmentName: run.environment?.name ?? null,
      status: run.status,
      trigger: run.trigger,
      counts: {
        total: run.totalCount,
        passed: run.passedCount,
        failed: run.failedCount,
        flaky: run.flakyCount,
        skipped: run.skippedCount,
      },
      gate: { passed: blocked.length === 0, blocked },
      commitSha: run.commitSha,
      branch: run.branch,
      prNumber: run.prNumber,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      failures,
      failuresTruncated: truncated,
      url: webUrl(`/runs/${run.id}`),
    };

    return {
      orgId: job.orgId,
      projectId: run.projectId,
      occurredAt: run.finishedAt ? run.finishedAt.toISOString() : occurredAt,
      subject: [run.id],
      candidates: deriveRunEventTypes(data),
      data,
    };
  }

  if (job.kind === 'monitor') {
    const monitor = await prisma.monitor.findFirst({
      where: { id: job.monitorId, orgId: job.orgId },
      select: {
        id: true,
        projectId: true,
        environmentId: true,
        environment: { select: { name: true } },
      },
    });
    if (!monitor) return null;

    const data: MonitorDownData = {
      monitorId: monitor.id,
      // The job's copies, not the row's: by the time this runs the monitor may
      // have gone green and reset its streak, and reporting that would describe
      // a different moment than the one that fired.
      name: job.name,
      streak: job.streak,
      projectId: monitor.projectId,
      environmentId: monitor.environmentId,
      environmentName: monitor.environment?.name ?? null,
      runId: job.runId,
      url: job.runId ? webUrl(`/runs/${job.runId}`) : null,
    };

    return {
      orgId: job.orgId,
      projectId: monitor.projectId,
      occurredAt,
      // The streak is part of the identity: the same monitor crossing its
      // threshold again next month is a different occurrence, and a receiver
      // deduplicating on the id must not swallow the second page.
      subject: [monitor.id, String(job.streak)],
      candidates: ['monitor.down'],
      data,
    };
  }

  if (job.kind === 'heal') {
    const proposal = await prisma.healProposal.findFirst({
      where: { id: job.proposalId, orgId: job.orgId },
      select: {
        id: true,
        testId: true,
        riskLevel: true,
        confidence: true,
        test: { select: { name: true, filePath: true, projectId: true } },
      },
    });
    if (!proposal) return null;

    const data: HealProposedData = {
      proposalId: proposal.id,
      testId: proposal.testId,
      testName: proposal.test.name,
      filePath: proposal.test.filePath,
      projectId: proposal.test.projectId,
      riskLevel: String(proposal.riskLevel),
      confidence: proposal.confidence,
      url: webUrl(`/tests/${proposal.testId}`),
    };

    return {
      orgId: job.orgId,
      projectId: proposal.test.projectId,
      occurredAt,
      subject: [proposal.id],
      candidates: ['heal.proposed'],
      data,
    };
  }

  const test = await prisma.test.findFirst({
    where: { id: job.testId, orgId: job.orgId },
    select: {
      id: true,
      name: true,
      filePath: true,
      projectId: true,
      suiteId: true,
      flakeRate: true,
      quarantined: true,
    },
  });
  if (!test) return null;

  const data: FlakeDetectedData = {
    testId: test.id,
    testName: test.name,
    filePath: test.filePath,
    projectId: test.projectId,
    suiteId: test.suiteId,
    flakeRate: test.flakeRate,
    quarantined: test.quarantined,
    url: webUrl(`/tests/${test.id}`),
  };

  return {
    orgId: job.orgId,
    projectId: test.projectId,
    occurredAt,
    subject: [test.id, occurredAt.slice(0, 10)],
    candidates: ['flake.detected'],
    data,
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

interface ActionRow {
  id: string;
  config: unknown;
  configEnc: string | null;
}

/**
 * Record a destination we refused, and stop.
 *
 * Zero attempts, FAILED immediately, the reason on the row. Retrying cannot
 * help a URL that fails a static check or a name that resolves inside our
 * network, and a PENDING row that will never move is worse than a clear no.
 * The row is the answer to "why didn't my action fire", which is the question
 * a customer will actually ask.
 */
async function recordRefusal(
  orgId: string,
  action: ActionRow,
  event: ActionEvent,
  reason: string,
): Promise<void> {
  await prisma.webhookDelivery.upsert({
    where: { id: deliveryIdFor(event, action.id) },
    create: {
      id: deliveryIdFor(event, action.id),
      orgId,
      integrationId: action.id,
      event: event.type,
      payload: { actionEventId: event.id },
      signature: '',
      status: 'FAILED',
      attempts: 0,
      lastError: reason,
    },
    update: {},
  });
  logger.warn({ integrationId: action.id, event: event.type, reason }, 'refused an event action');
}

/** Deterministic, so a retried dispatch re-claims the row instead of duplicating it. */
function deliveryIdFor(event: ActionEvent, integrationId: string): string {
  return `wd-${event.id.replace(/:/g, '-')}-${integrationId}`;
}

/**
 * One action, from subscription to queued delivery.
 *
 * Throws only on something the CALLER should count as this action's failure —
 * the loop below catches it, so one broken action costs nothing but its own row.
 */
async function dispatchOne(
  orgId: string,
  action: ActionRow,
  event: ActionEvent,
  lookup: LookupFn,
): Promise<'queued' | 'refused'> {
  /*
   * Unseal to check the destination.
   *
   * The URL is sealed because it IS the credential, and this is the one place
   * an action's URL is read outside the sender. It is read to be CHECKED and
   * then dropped — it is never logged, never written to the delivery row, and
   * never returned. `processDelivery` unseals it again for the POST, which is
   * why nothing has to be carried forward from here.
   */
  let url: string;
  try {
    if (!action.configEnc) throw new Error('no sealed credentials');
    const keyVersion = ((action.config ?? {}) as { keyVersion?: number }).keyVersion ?? 1;
    url = decodeChatCredentials(
      openSecret(action.configEnc, keyVersion, orgId, integrationAad(action.id)),
    ).url;
  } catch {
    await recordRefusal(
      orgId,
      action,
      event,
      'could not unseal this action’s destination; nothing was sent',
    );
    return 'refused';
  }

  const destination = checkActionDestination(url);
  if (!destination.ok) {
    await recordRefusal(orgId, action, event, destination.reason);
    return 'refused';
  }

  const resolved = await resolveIsPublic(destination.host, lookup);
  if (!resolved.ok) {
    await recordRefusal(orgId, action, event, resolved.reason);
    return 'refused';
  }

  const body = encodeActionEventBody(event);
  if (Buffer.byteLength(body, 'utf8') > MAX_ACTION_BODY_BYTES) {
    await recordRefusal(
      orgId,
      action,
      event,
      `This event serialised to more than ${MAX_ACTION_BODY_BYTES} bytes and was not sent.`,
    );
    return 'refused';
  }

  const deliveryId = deliveryIdFor(event, action.id);
  await prisma.webhookDelivery.upsert({
    where: { id: deliveryId },
    create: {
      id: deliveryId,
      orgId,
      integrationId: action.id,
      event: event.type,
      /*
       * `text` because that is the field `processDelivery` reads and hands to
       * `chatPayload` — see `encodeActionEventBody` for why the envelope
       * travels as a string. `actionEventId` rides alongside so the delivery
       * log itself carries the idempotency key a customer would quote in a
       * support conversation; processDelivery ignores fields it does not know.
       */
      payload: { text: body, actionEventId: event.id },
      signature: '',
      status: 'PENDING',
      attempts: 0,
    },
    // Never reset a row a delivery job may already be recording into.
    update: {},
  });

  await enqueueDelivery({ orgId, deliveryId });
  return 'queued';
}

export interface ActionDispatchDeps {
  /** Test seam. Production resolves through Node. */
  lookup?: LookupFn;
}

/**
 * Fan one occurrence out to every action registered for it.
 *
 * Never throws for a single action's failure — that is the isolation guarantee,
 * and it is why the loop's catch is inside the loop rather than around it. It
 * DOES throw when the read of the actions themselves fails, because then
 * nothing was attempted and a retry is exactly the right response.
 */
export async function processActionEvent(
  job: ActionEventJob,
  deps: ActionDispatchDeps = {},
): Promise<void> {
  const lookup = deps.lookup ?? nodeLookup;

  const built = await buildEvent(job);
  if (!built) {
    logger.warn({ kind: job.kind, orgId: job.orgId }, 'the subject of an event action is gone');
    return;
  }

  // Deliberately NOT caught: nothing has been attempted, so a retry is free and
  // correct. Everything after this point is per-action.
  const rows = await prisma.integration.findMany({
    where: { orgId: job.orgId, enabled: true, kind: 'WEBHOOK' },
    select: { id: true, config: true, configEnc: true },
    // Total and stable, so the cap below always cuts the same tail rather than
    // a different one per attempt.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_ACTIONS_PER_EVENT + 1,
  });

  let actions: ActionRow[] = rows;
  if (rows.length > MAX_ACTIONS_PER_EVENT) {
    actions = rows.slice(0, MAX_ACTIONS_PER_EVENT);
    logger.error(
      { orgId: job.orgId, cap: MAX_ACTIONS_PER_EVENT },
      'more actions are registered than one event may fan out to; the newest were not dispatched',
    );
  }

  let queued = 0;
  let refused = 0;
  let failed = 0;
  let skipped = 0;

  for (const action of actions) {
    const subscription = parseActionSubscription(action.config);
    if (subscription.unknown.length > 0) {
      // A typo in a subscription is otherwise indistinguishable from an event
      // that has not happened yet, which is a bad afternoon.
      logger.warn(
        { integrationId: action.id, unknown: subscription.unknown },
        'an action subscribes to event names that do not exist',
      );
    }

    const type = pickActionEvent(subscription.events, built.candidates);
    if (!type) {
      // Not subscribed. No row: "you did not ask for this" is a preference
      // honoured, not a delivery that failed, and it does not belong in a log
      // a customer reads to find out what went wrong.
      skipped += 1;
      continue;
    }

    const event = buildActionEvent({
      type,
      orgId: built.orgId,
      projectId: built.projectId,
      subject: built.subject,
      occurredAt: built.occurredAt,
      // The payload shape is fixed by `type` in the contract; `buildEvent`
      // produced exactly the one this candidate list belongs to.
      data: built.data,
    });

    try {
      const outcome = await dispatchOne(job.orgId, action, event, lookup);
      if (outcome === 'queued') queued += 1;
      else refused += 1;
    } catch (err) {
      /*
       * The isolation guarantee, in four lines. One action whose row failed to
       * write, whose vault key rotated, whose anything — must not cost the
       * other nineteen their delivery, and must not fail the run that triggered
       * this. It is logged and the loop continues.
       */
      failed += 1;
      logger.error(
        { err, integrationId: action.id, event: type },
        'an event action failed to dispatch; the others are unaffected',
      );
    }
  }

  logger.info(
    { orgId: job.orgId, kind: job.kind, queued, refused, failed, skipped },
    'event actions dispatched',
  );
}
