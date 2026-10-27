/**
 * Push notifications as a test type (§4 PUSH) — the other outbound half.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `plugins/mobile.ts` drives Appium, Maestro, Detox, Espresso and XCUITest, and
 * every one of them stops at the application's own UI. NOTHING in this product
 * triggers or asserts an APNs, FCM or Web Push delivery. So the notification
 * path — the one a product manager measures retention by, and the one that
 * breaks silently every time a payload key is renamed — was never driven at
 * all. `SURFACE_KINDS` counts `NOTIFICATION`; nothing could execute one.
 *
 * ── PUSH IS THE TYPE MOST LIKELY TO PRODUCE A FALSE GREEN ───────────────────
 *
 * And that is the whole reason this file is shaped the way it is. "We asked the
 * OS to deliver a notification and heard nothing back" looks EXACTLY like
 * success: no exception, no failed request, no red. A plugin written the obvious
 * way — trigger, wait, return PASSED — would report a green notification path
 * on an application that sends nothing, on an image with no device, for ever.
 * Three outcomes, and they are untouchable:
 *
 *   DELIVERED              a notification was OBSERVED, and its title, body,
 *                          payload, deep link, badge and priority were compared
 *                          against the spec. The only outcome that can pass.
 *
 *   MISMATCHED             a notification was OBSERVED and it is the wrong one:
 *                          the wrong title, the wrong total, a deep link that
 *                          does not route. FAILED, and a CONFIDENT failure —
 *                          which is why it is its own outcome and not folded
 *                          into the one below. "We saw the wrong notification"
 *                          and "we saw no notification" are different facts
 *                          with different confidence and different next steps,
 *                          and filing the first as the second would understate
 *                          a defect the run actually proved.
 *
 *   REQUESTED_NOT_OBSERVED we triggered the application event, the observer was
 *                          present and healthy, and NOTHING came through it
 *                          inside the bound. NOT A PASS. It is FAILED, and the
 *                          sentence says plainly what was established: nothing
 *                          was SEEN by the one observer available, which is not
 *                          the same sentence as "nothing was sent".
 *
 *   UNAVAILABLE            there is no device, no permission grant, no service
 *                          worker or no provider test credential, so the
 *                          question could not be ASKED. SKIPPED with a remedy.
 *                          Never SKIPPED without one, and never a pass: a
 *                          skipped push test inside a percentage is a
 *                          notification path that can never fail.
 *
 * {@link pushStatus} is the single function that maps an outcome to a status,
 * and `push.test.ts` pins `REQUESTED_NOT_OBSERVED` away from PASSED in a test
 * that is written to survive a future change of mind about WHICH non-pass it is.
 *
 * ── TWO OF THE THREE TRANSPORTS CANNOT BE DRIVEN FROM THIS IMAGE ───────────
 *
 * There is no install that produces an iOS device token, which is why the PUSH
 * declaration says `device: 'REAL_DEVICE'` and carries APNs and FCM deliveries
 * as `knownUnasserted` with `CAPABILITY_ABSENT`. WEB_PUSH is the one arm an
 * emulated browser context can serve, and it needs two things the spec must
 * carry explicitly: a NOTIFICATIONS grant in the environment block, and a
 * service worker that actually claimed a scope. Both are checked BEFORE the
 * trigger fires, because triggering first and discovering the gap afterwards
 * produces a REQUESTED_NOT_OBSERVED — a FAILED test — for a reason that is ours.
 *
 * ── SECURITY: THE PLUGIN CANNOT HOLD A CREDENTIAL ──────────────────────────
 *
 * `refusesLiveCredentials: true` on the PUSH declaration is enforced here
 * STRUCTURALLY and then again at run time, which is the "type-level and
 * run-time refusal, not a convention" rule 11 asks for:
 *
 *   · {@link SenderCredential} HAS NO VALUE FIELD. The whole interface is
 *     `{ present, mode }`, so there is no expression in this file that can
 *     reach a device token, a push certificate or a provider key — not to log
 *     it, not to hash it, not to put it in an error path. The plugin never
 *     needs one: it triggers the APPLICATION, and the application sends.
 *   · A `mode` of LIVE is refused with a named reason and nothing is triggered.
 *     So is UNKNOWN — see {@link refuseLiveSender}. Absent means NOT PROBED and
 *     never "probably test", which is the same rule the keystone's matrix
 *     resolution applies to an unprobed cell.
 */

import { z } from 'zod';
import {
  DEVICE_BOUND_PUSH_TRANSPORTS,
  pushTestSpecSchema,
  unassertedReasonSchema,
} from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  PushTransport,
  RunContext,
  StepResult,
  TestExecution,
  TestResultStatus,
} from '@qaai/shared';

export type PushTestSpec = z.infer<typeof pushTestSpecSchema>;
export type PushDeliverySpec = PushTestSpec['deliveries'][number];

/**
 * The keystone's `UnassertedReason`, taken off the zod enum rather than off
 * `./test-type-decl`, which is not on @qaai/shared's barrel. Same reasoning as
 * the twin in ./email.ts; the barrel line is in the handover.
 */
type UnassertedReasonName = z.infer<typeof unassertedReasonSchema>;

// ─── The three outcomes ──────────────────────────────────────────────────────

/**
 * What a push delivery attempt concluded. See the file header.
 *
 * ORDER IS WORST-LAST-FIRST on purpose: a reader scanning this list meets the
 * only passing outcome first and the two that are not passes immediately
 * after, which is the opposite of how the obvious implementation reads.
 */
export const PUSH_OUTCOMES = [
  'DELIVERED',
  'MISMATCHED',
  'REQUESTED_NOT_OBSERVED',
  'UNAVAILABLE',
] as const;
export type PushOutcome = (typeof PUSH_OUTCOMES)[number];

/** Compile-time half of the parity guard; the run-time half is in push.test.ts. */
const PUSH_OUTCOME_PRESENT: Record<PushOutcome, true> = {
  DELIVERED: true,
  MISMATCHED: true,
  REQUESTED_NOT_OBSERVED: true,
  UNAVAILABLE: true,
};

export const PUSH_OUTCOME_LIST = Object.keys(PUSH_OUTCOME_PRESENT) as ReadonlyArray<PushOutcome>;

export const PUSH_OUTCOME_LABELS: Record<PushOutcome, string> = {
  DELIVERED: 'A notification was observed and asserted',
  MISMATCHED: 'A notification was observed and it is the wrong one',
  REQUESTED_NOT_OBSERVED: 'Triggered, and no notification was seen',
  UNAVAILABLE: 'The question could not be asked here',
};

/**
 * THE ONE OUTCOME THAT MAY PASS, as a value rather than as a condition.
 *
 * Exported so {@link pushStatus} and its test both read the same constant: a
 * second `=== 'DELIVERED'` somewhere else in this file is how the invariant
 * comes to have two implementations and one of them is wrong.
 */
export const PUSH_PASSING_OUTCOME: PushOutcome = 'DELIVERED';

/**
 * The status one outcome produces. THE invariant of this file.
 *
 * One function, exported, so there is exactly one place that can get it wrong
 * and exactly one place a test can pin.
 *
 *   DELIVERED              → PASSED
 *   MISMATCHED             → FAILED. We saw the notification and it is wrong.
 *   REQUESTED_NOT_OBSERVED → FAILED. The observer was present and saw nothing
 *                            after a cause we fired. That is a statement about
 *                            the application, and the step's own sentence
 *                            bounds it honestly.
 *   UNAVAILABLE            → SKIPPED, and the caller must attach `notRun` with
 *                            the remedy. A bare SKIPPED is the lie.
 *
 * `satisfies` on the record rather than a switch, because a fifth outcome then
 * fails to compile here instead of silently falling through to a default — and
 * a default in this function is a false green by construction.
 */
const PUSH_OUTCOME_STATUS = {
  DELIVERED: 'PASSED',
  MISMATCHED: 'FAILED',
  REQUESTED_NOT_OBSERVED: 'FAILED',
  UNAVAILABLE: 'SKIPPED',
} satisfies Record<PushOutcome, TestResultStatus>;

export function pushStatus(outcome: PushOutcome): TestResultStatus {
  return PUSH_OUTCOME_STATUS[outcome];
}

// ─── Why a delivery was unavailable ──────────────────────────────────────────

/**
 * The reasons a push could not be attempted, each with a REMEDY.
 *
 * A closed union rather than a sentence, because "how often does this project's
 * notification path go unmeasured, and why" is a `GROUP BY` — the same argument
 * the keystone's `UnassertedReason` makes. The remedy is beside the reason so
 * the two cannot drift: an UNAVAILABLE with no remedy is a dead end a customer
 * cannot act on, which is how a gap becomes permanent.
 */
export const PUSH_UNAVAILABLE_REASONS = [
  'NO_DEVICE',
  'NO_PERMISSION_GRANT',
  'NO_SERVICE_WORKER',
  'NO_SENDER_CREDENTIAL',
  'LIVE_SENDER_REFUSED',
  'NO_OBSERVER',
] as const;
export type PushUnavailableReason = (typeof PUSH_UNAVAILABLE_REASONS)[number];

const PUSH_UNAVAILABLE_PRESENT: Record<PushUnavailableReason, true> = {
  NO_DEVICE: true,
  NO_PERMISSION_GRANT: true,
  NO_SERVICE_WORKER: true,
  NO_SENDER_CREDENTIAL: true,
  LIVE_SENDER_REFUSED: true,
  NO_OBSERVER: true,
};

export const PUSH_UNAVAILABLE_REASON_LIST = Object.keys(
  PUSH_UNAVAILABLE_PRESENT,
) as ReadonlyArray<PushUnavailableReason>;

/**
 * Which `UnassertedReason` each one maps onto, so the gap lands in the
 * keystone's vocabulary rather than in a sentence only this file understands.
 *
 * `LIVE_SENDER_REFUSED` maps to `WOULD_MUTATE_PROTECTED_DATA` and NOT to
 * `CAPABILITY_ABSENT`, and the distinction is the point: the capability is
 * present, we refused to use it, and a report that filed our refusal as a
 * missing install would send somebody to fix the image. Rule 12 names
 * "a REFUSED surface recorded the same way as one that does not exist".
 */
export const PUSH_UNAVAILABLE_AS_UNASSERTED: Record<
  PushUnavailableReason,
  UnassertedReasonName
> = {
  NO_DEVICE: 'CAPABILITY_ABSENT',
  NO_PERMISSION_GRANT: 'CAPABILITY_ABSENT',
  NO_SERVICE_WORKER: 'CAPABILITY_ABSENT',
  NO_SENDER_CREDENTIAL: 'REQUIRES_PROVISIONED_SANDBOX',
  LIVE_SENDER_REFUSED: 'WOULD_MUTATE_PROTECTED_DATA',
  NO_OBSERVER: 'CAPABILITY_ABSENT',
};

export const PUSH_UNAVAILABLE_REMEDIES: Record<PushUnavailableReason, string> = {
  NO_DEVICE:
    'APNs and FCM deliver to a real handset. Attach a device farm (the MOBILE type’s ' +
    'DeviceFarm surface) or run this delivery over WEB_PUSH, which an emulated browser can serve.',
  NO_PERMISSION_GRANT:
    'Web Push needs the notification permission granted before the page asks for it. Add ' +
    'NOTIFICATIONS to `environment.permissions` on this spec.',
  NO_SERVICE_WORKER:
    'Web Push is delivered through a service worker. Nothing claimed a scope on the page under ' +
    'test, so there was no registration to deliver into — check that the worker registers on ' +
    'this route, and assert it with the PWA type first.',
  NO_SENDER_CREDENTIAL:
    'Name the customer-owned Integration row that holds the provider’s TEST-mode sender ' +
    'credential in `senderIntegrationId`. QAAI never reads the value; it only asks whether one ' +
    'exists and which mode it is in.',
  LIVE_SENDER_REFUSED:
    'The named Integration is in live mode, or its mode was never established. Point ' +
    '`senderIntegrationId` at a test-mode row. QAAI will not drive a live sender, so a real ' +
    'customer never receives a notification from a test run.',
  NO_OBSERVER:
    'No push observer is attached to this run, so a delivery could not have been seen even if ' +
    'one happened. Attach one before reading a PUSH result as evidence.',
};

// ─── The injected surfaces (rule 8) ──────────────────────────────────────────

/**
 * A provider sender credential, DESCRIBED AND NEVER HANDED OVER.
 *
 * There is no `value`, no `token`, no `keyId` and no `pem`, and that absence is
 * load-bearing — see the file header. The plugin's only legitimate questions
 * about an APNs key are "is there one" and "is it the sandbox one", and both
 * are answerable without the bytes.
 */
export interface SenderCredential {
  readonly present: boolean;
  /**
   * TEST, LIVE, or UNKNOWN when the Integration row does not say.
   *
   * ABSENT IS NOT TEST. UNKNOWN is refused exactly like LIVE: an unprobed mode
   * resolved optimistically is how a test run sends a notification to somebody
   * real, and no install fixes having already done it.
   */
  readonly mode: 'TEST' | 'LIVE' | 'UNKNOWN';
}

/** Resolves an `Integration` id to a description. Never to a secret. */
export interface SenderCredentialSource {
  describe(integrationId: string): Promise<SenderCredential>;
}

/**
 * One notification, as an observer saw it.
 *
 * `deviceToken` is deliberately absent from this shape too: an observer that
 * handed one over would put it into step titles and artifacts through the
 * ordinary reporting path, and nothing in this file ever needs to know which
 * handset received the push — only that the right one did, which is the
 * observer's own business.
 */
export interface ObservedNotification {
  readonly title: string;
  readonly body: string;
  /** The custom data payload. Compared key by key against `expectData`. */
  readonly data: Readonly<Record<string, string>>;
  /** The deep link a tap must honour, as the payload declares it. */
  readonly deepLink: string | null;
  /** iOS/Android badge count, or null when the payload sets none. */
  readonly badge: number | null;
  /** The provider's own priority word, or null when the payload sets none. */
  readonly priority: string | null;
}

/** What tapping a notification did, when the environment can tap at all. */
export interface TapResult {
  /** False when this observer cannot tap. Then `landedOn` is meaningless. */
  readonly supported: boolean;
  /** The screen or route the app came to rest on. Null when unsupported. */
  readonly landedOn: string | null;
  readonly detail: string;
}

/**
 * Where a push can be SEEN.
 *
 * `available` is asked BEFORE anything is triggered, because an observer that
 * cannot see is the difference between UNAVAILABLE and the FAILED outcome
 * REQUESTED_NOT_OBSERVED — and getting that backwards is the false green this
 * whole file is built to prevent.
 */
export interface PushObserver {
  /**
   * Can this observer see a delivery of this transport at all?
   *
   * A reason string, never a bare boolean, so the UNAVAILABLE step can print
   * which of the six {@link PUSH_UNAVAILABLE_REASONS} applied.
   */
  available(transport: PushTransport): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: PushUnavailableReason }
  >;
  /**
   * Every notification seen within the bound. An EMPTY array means "none came
   * through this observer", which is REQUESTED_NOT_OBSERVED and NOT "none was
   * sent" — the step's sentence makes that distinction in writing.
   */
  observe(transport: PushTransport, timeoutMs: number): Promise<readonly ObservedNotification[]>;
  /** Tap the notification and report where the app landed. */
  tap(notification: ObservedNotification): Promise<TapResult>;
}

/**
 * The service worker a Web Push delivery goes through.
 *
 * Separate from the observer because they fail independently: a worker can be
 * registered and the OS-level grant still missing, and a grant can be present
 * with no worker to deliver into. One combined check would report the wrong
 * remedy half the time.
 */
export interface ServiceWorkerSurface {
  /** The scope a worker claimed on the page under test, or null when none did. */
  claimedScope(triggerPath: string): Promise<string | null>;
}

export interface PushTriggerResult {
  readonly fired: boolean;
  readonly detail: string;
}

/** Causes the application event that should produce a notification. */
export interface PushTrigger {
  fire(triggerPath: string, baseUrl: string): Promise<PushTriggerResult>;
}

/**
 * Injected so tests do not sleep. Structurally identical to `MailClock` in
 * ./email.ts and `JobClock` in ./jobs.ts, and deliberately not imported from
 * either: a plugin importing another plugin couples two independently
 * promotable types, and the shapes are mutually assignable so one fake serves
 * all three. Consolidation is named in the handover.
 */
export interface PushClock {
  now(): number;
}

export const realPushClock: PushClock = { now: () => Date.now() };

export interface PushDeps {
  observer: PushObserver;
  trigger: PushTrigger;
  worker: ServiceWorkerSurface;
  senders: SenderCredentialSource;
  clock?: PushClock;
}

// ─── Refusals that happen before anything is triggered ───────────────────────

export interface PushRefusal {
  readonly reason: PushUnavailableReason;
  /** The reason and its remedy, in one printable sentence. */
  readonly detail: string;
}

function refusal(reason: PushUnavailableReason, context: string): PushRefusal {
  return { reason, detail: `${context} ${PUSH_UNAVAILABLE_REMEDIES[reason]}` };
}

/**
 * The permission grant Web Push needs, read off the environment block.
 *
 * `environment` absent means the browser's own defaults, which for
 * notifications is "prompt" — and a prompt in an automated run is a dialog
 * nobody dismisses, so the delivery never happens and the result would be
 * REQUESTED_NOT_OBSERVED: a FAILED test for a gap in OUR spec. Refused up
 * front instead, with the field named.
 *
 * APNs and FCM are OUT of this check: an OS-level grant on a handset is not a
 * Playwright permission, and asserting the browser block for them would refuse
 * a correct device spec.
 */
export function missingPermissionGrant(
  transport: PushTransport,
  environment: PushTestSpec['environment'],
): PushRefusal | null {
  if (transport !== 'WEB_PUSH') return null;
  const permissions = environment?.permissions ?? [];
  if (permissions.includes('NOTIFICATIONS')) return null;
  return refusal(
    'NO_PERMISSION_GRANT',
    environment === undefined
      ? 'This WEB_PUSH delivery carries no `environment` block at all, so the browser would have ' +
          'prompted for permission and nothing would dismiss the prompt.'
      : 'This WEB_PUSH delivery grants ' +
          `${permissions.length} permission(s) and NOTIFICATIONS is not among them.`,
  );
}

/**
 * The live-mode refusal, which is run time's half of the structural one.
 *
 * Returns a refusal for LIVE **and for UNKNOWN**. The second is the one that
 * matters: a row whose mode was never established is a row that might be live,
 * and "probably test" is not a thing to be wrong about once.
 *
 * WEB_PUSH against the app's own VAPID setup legitimately names no Integration
 * — `pushDeliverySchema` defaults `senderIntegrationId` to null and only
 * refuses it for the device-bound transports — so a null id on WEB_PUSH is not
 * a gap and this function says so by returning null.
 */
export async function refuseLiveSender(
  delivery: PushDeliverySpec,
  senders: SenderCredentialSource,
): Promise<PushRefusal | null> {
  const id = delivery.senderIntegrationId;

  if (id === null) {
    if (DEVICE_BOUND_PUSH_TRANSPORTS.includes(delivery.transport)) {
      /*
       * `pushDeliverySchema` already refuses this at parse time. Kept here
       * because `runPushDelivery` is exported and callable with a spec a
       * caller built by hand, and a run-time path that trusted the schema to
       * have run is a path that fails open.
       */
      return refusal(
        'NO_SENDER_CREDENTIAL',
        `This ${delivery.transport} delivery names no sender Integration.`,
      );
    }
    return null;
  }

  const credential = await senders.describe(id);
  if (!credential.present) {
    return refusal(
      'NO_SENDER_CREDENTIAL',
      `Integration "${id}" holds no sender credential for this environment.`,
    );
  }
  if (credential.mode !== 'TEST') {
    return refusal(
      'LIVE_SENDER_REFUSED',
      `Integration "${id}" reports mode ${credential.mode}, and QAAI drives TEST-mode senders ` +
        'only.',
    );
  }
  return null;
}

// ─── Asserting what was observed ─────────────────────────────────────────────

export interface NotificationMismatch {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Compare one observed notification to one delivery spec.
 *
 * Returns the mismatches, so a caller can report every one at once rather than
 * the first: "the title is wrong" and "the deep link is wrong" are two defects
 * and fixing one does not reveal the other if only one was reported.
 *
 * Substring comparison on title and body, exact on the data payload, and
 * `expectDeepLink` is a PREFIX match on the link — a deep link routinely
 * carries a campaign or message id the spec cannot know, and requiring equality
 * would fail every correct implementation that appends one.
 */
export function compareNotification(
  delivery: PushDeliverySpec,
  observed: ObservedNotification,
): NotificationMismatch[] {
  const problems: NotificationMismatch[] = [];

  if (delivery.expectTitle !== undefined && !observed.title.includes(delivery.expectTitle)) {
    problems.push({
      field: 'title',
      expected: `contains "${delivery.expectTitle}"`,
      actual: observed.title,
    });
  }
  if (delivery.expectBody !== undefined && !observed.body.includes(delivery.expectBody)) {
    problems.push({
      field: 'body',
      expected: `contains "${delivery.expectBody}"`,
      actual: observed.body,
    });
  }
  if (delivery.expectDeepLink !== undefined) {
    if (observed.deepLink === null) {
      problems.push({
        field: 'deepLink',
        expected: `starts with "${delivery.expectDeepLink}"`,
        // Not an empty string: a payload with no deep link and a payload with
        // an empty one are different bugs and read identically as "".
        actual: '(the payload carries no deep link)',
      });
    } else if (!observed.deepLink.startsWith(delivery.expectDeepLink)) {
      problems.push({
        field: 'deepLink',
        expected: `starts with "${delivery.expectDeepLink}"`,
        actual: observed.deepLink,
      });
    }
  }
  return problems;
}

/**
 * The notification a delivery spec is about, out of everything that was seen.
 *
 * A run may observe several — a digest and a chat message arriving together —
 * and asserting against `observed[0]` would make the result depend on delivery
 * order. So: the one with the FEWEST mismatches, which is the only ordering
 * that is stable under reordering and still reports the real mismatches of the
 * closest candidate when none matches.
 *
 * Ties keep the EARLIEST, so the choice is deterministic for a given observed
 * sequence — rule 10 — and no seed is needed because nothing here is sampled.
 */
export function closestNotification(
  delivery: PushDeliverySpec,
  observed: readonly ObservedNotification[],
): { notification: ObservedNotification; problems: NotificationMismatch[] } | null {
  let best: { notification: ObservedNotification; problems: NotificationMismatch[] } | null = null;
  for (const candidate of observed) {
    const problems = compareNotification(delivery, candidate);
    if (best === null || problems.length < best.problems.length) {
      best = { notification: candidate, problems };
    }
    if (best.problems.length === 0) break;
  }
  return best;
}

// ─── One delivery ────────────────────────────────────────────────────────────

export interface PushDeliveryResult {
  readonly outcome: PushOutcome;
  /** Set on UNAVAILABLE. Null otherwise. */
  readonly unavailableReason: PushUnavailableReason | null;
  /** Printable verbatim. */
  readonly detail: string;
  /** Holes this delivery left, in the keystone's vocabulary. */
  readonly notAsserted: ReadonlyArray<{ assertion: string; reason: UnassertedReasonName }>;
  /** How long the observation bound actually consumed, for the disclosure. */
  readonly observedForMs: number;
}

function unavailable(
  refused: PushRefusal,
  extraHoles: ReadonlyArray<{ assertion: string; reason: UnassertedReasonName }> = [],
): PushDeliveryResult {
  return {
    outcome: 'UNAVAILABLE',
    unavailableReason: refused.reason,
    detail: refused.detail,
    notAsserted: [
      {
        assertion: 'that a notification was delivered at all',
        reason: PUSH_UNAVAILABLE_AS_UNASSERTED[refused.reason],
      },
      ...extraHoles,
    ],
    observedForMs: 0,
  };
}

/**
 * Trigger one application event and assert the notification it should produce.
 *
 * THE ORDER IS THE DESIGN. Every refusal happens before the trigger fires:
 *
 *   1. can the observer see this transport at all?   → UNAVAILABLE
 *   2. is the notification permission granted?       → UNAVAILABLE
 *   3. did a service worker claim a scope?           → UNAVAILABLE (WEB_PUSH)
 *   4. is the sender credential present and TEST?    → UNAVAILABLE
 *   5. fire the trigger                              → UNAVAILABLE if it fails
 *   6. observe                                       → DELIVERED or
 *                                                      REQUESTED_NOT_OBSERVED
 *
 * Reordering 5 before any of 1-4 turns an environment gap into
 * REQUESTED_NOT_OBSERVED, which is FAILED — QAAI reporting a defect in the
 * customer's notification code because this image has no device. That is the
 * single most expensive mistake available in this file.
 */
export async function runPushDelivery(
  delivery: PushDeliverySpec,
  environment: PushTestSpec['environment'],
  baseUrl: string,
  deps: PushDeps,
): Promise<PushDeliveryResult> {
  const clock = deps.clock ?? realPushClock;

  // 1. The observer.
  const seeing = await deps.observer.available(delivery.transport);
  if (!seeing.ok) {
    return unavailable(
      refusal(
        seeing.reason,
        `No ${delivery.transport} delivery could be observed on this deployment.`,
      ),
    );
  }

  // 2. The permission grant.
  const permission = missingPermissionGrant(delivery.transport, environment);
  if (permission !== null) return unavailable(permission);

  // 3. The service worker, for Web Push only.
  if (delivery.transport === 'WEB_PUSH') {
    const scope = await deps.worker.claimedScope(delivery.triggerPath);
    if (scope === null) {
      return unavailable(
        refusal(
          'NO_SERVICE_WORKER',
          `No service worker claimed a scope on ${delivery.triggerPath}.`,
        ),
      );
    }
  }

  // 4. The sender credential — present, and in test mode.
  const sender = await refuseLiveSender(delivery, deps.senders);
  if (sender !== null) return unavailable(sender);

  // 5. The trigger.
  let fired: PushTriggerResult;
  try {
    fired = await deps.trigger.fire(delivery.triggerPath, baseUrl);
  } catch (err) {
    fired = {
      fired: false,
      detail: `The trigger surface threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!fired.fired) {
    /*
     * UNAVAILABLE and emphatically NOT REQUESTED_NOT_OBSERVED. The request was
     * never made, so "requested" is false and the name would be a lie — and the
     * status would be FAILED, blaming the customer's notification code for a
     * trigger we could not send.
     */
    return {
      outcome: 'UNAVAILABLE',
      unavailableReason: 'NO_OBSERVER',
      detail:
        `The application event was never triggered, so nothing was requested and nothing could ` +
        `be observed. ${fired.detail}`,
      notAsserted: [
        {
          assertion: 'that a notification was delivered at all',
          reason: 'SURFACE_UNREACHED',
        },
      ],
      observedForMs: 0,
    };
  }

  // 6. Observe.
  const timeoutMs = delivery.timeoutSeconds * 1_000;
  const observeStartedAt = clock.now();
  const observed = await deps.observer.observe(delivery.transport, timeoutMs);
  const observedForMs = Math.max(0, clock.now() - observeStartedAt);

  if (observed.length === 0) {
    return {
      outcome: 'REQUESTED_NOT_OBSERVED',
      unavailableReason: null,
      detail: requestedNotObservedWhy(delivery, timeoutMs, observedForMs),
      notAsserted: [
        {
          assertion: 'the notification as the OS renders it, outside the page',
          reason: 'CAPABILITY_ABSENT',
        },
      ],
      observedForMs,
    };
  }

  const closest = closestNotification(delivery, observed);
  /*
   * `observed.length > 0` guarantees a candidate, so null here would be a bug
   * in closestNotification rather than a state. Reported as not observed rather
   * than thrown: a crash in the runner is a failed test with a stack trace, and
   * this says what is actually known.
   */
  if (closest === null) {
    return {
      outcome: 'REQUESTED_NOT_OBSERVED',
      unavailableReason: null,
      detail: requestedNotObservedWhy(delivery, timeoutMs, observedForMs),
      notAsserted: [],
      observedForMs,
    };
  }

  const holes: Array<{ assertion: string; reason: UnassertedReasonName }> = [
    ...delivery.notAsserted,
  ];

  if (closest.problems.length > 0) {
    return {
      /*
       * MISMATCHED, not REQUESTED_NOT_OBSERVED. We SAW it. Filing a notification
       * we read field by field under the name of one we never saw would
       * understate a defect this run actually proved, and would make the
       * "nothing was seen is not nothing was sent" disclosure a false statement
       * about this result.
       */
      outcome: 'MISMATCHED',
      unavailableReason: null,
      detail:
        `${observed.length} notification(s) were observed and the closest one does not match: ` +
        `${closest.problems
          .map((p) => `${p.field} expected ${p.expected}, got "${p.actual}"`)
          .join('; ')}.`,
      notAsserted: holes,
      observedForMs,
    };
  }

  // The tap. A deep link that is in the payload and does not route is the half
  // that silently rots, so it is asserted when the environment can tap.
  let tapNote = '';
  if (delivery.expectDeepLink !== undefined) {
    const tap = await deps.observer.tap(closest.notification);
    if (!tap.supported) {
      holes.push({
        assertion: `that tapping the notification lands on "${delivery.expectDeepLink}"`,
        reason: 'CAPABILITY_ABSENT',
      });
      tapNote = ` The deep link is in the payload and was NOT followed: ${tap.detail}`;
    } else if (tap.landedOn === null) {
      holes.push({
        assertion: `that tapping the notification lands on "${delivery.expectDeepLink}"`,
        reason: 'SURFACE_UNREACHED',
      });
      tapNote = ` The tap was performed and the observer reported no landing screen: ${tap.detail}`;
    } else if (!tap.landedOn.startsWith(delivery.expectDeepLink)) {
      // Observed, tapped, and it went somewhere else. A confident failure.
      return {
        outcome: 'MISMATCHED',
        unavailableReason: null,
        detail:
          `The notification matched and tapping it landed on "${tap.landedOn}", which does not ` +
          `start with "${delivery.expectDeepLink}" — the payload's deep link does not route.`,
        notAsserted: holes,
        observedForMs,
      };
    } else {
      tapNote = ` Tapping it landed on "${tap.landedOn}".`;
    }
  }

  return {
    outcome: 'DELIVERED',
    unavailableReason: null,
    detail:
      `A ${delivery.transport} notification was observed ${observedForMs}ms after ` +
      `${delivery.triggerPath} and matches the spec.${tapNote}`,
    notAsserted: holes,
    observedForMs,
  };
}

/**
 * The sentence REQUESTED_NOT_OBSERVED is reported with.
 *
 * Exported so the test can pin its exact content, because the honesty of this
 * whole type lives in it. It states what was established ("we fired the
 * trigger"), what was not ("nothing came through the observer"), and — the part
 * an obvious implementation leaves out — that the two together do NOT establish
 * that nothing was sent. Rule 10's "a cap that bit must be reported as a count
 * AND a reason" is the bound and the elapsed time.
 */
export function requestedNotObservedWhy(
  delivery: PushDeliverySpec,
  timeoutMs: number,
  observedForMs: number,
): string {
  return (
    `REQUESTED_NOT_OBSERVED, which is NOT a pass: QAAI triggered ${delivery.triggerPath} and ` +
    `watched for a ${delivery.transport} notification for ${observedForMs}ms against the ` +
    `${timeoutMs}ms timeoutSeconds bound, and none came through. This establishes that nothing ` +
    'was SEEN by the one observer attached to this run — it does not establish that nothing was ' +
    'sent. Raise `timeoutSeconds` if your provider is slower than this.'
  );
}

// ─── Step recording ──────────────────────────────────────────────────────────

class StepRecorder {
  readonly steps: StepResult[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  /**
   * Record one delivery.
   *
   * UNAVAILABLE is a SKIPPED step because `error` on a StepResult means "this
   * failed" and it did not. REQUESTED_NOT_OBSERVED IS a FAILED step, with the
   * bounded sentence in the error, because the status rule says so and a
   * SKIPPED step under a FAILED test is how a reader comes to believe the
   * notification path was merely unmeasured.
   */
  record(delivery: PushDeliverySpec, result: PushDeliveryResult, startedAtMs: number): void {
    /*
     * Derived from `pushStatus` rather than re-decided here. A second mapping
     * is how a step comes to say SKIPPED under a FAILED test — which is how a
     * reader comes to believe the notification path was merely unmeasured.
     * TIMED_OUT and FLAKY are not outcomes this plugin produces, so the
     * fall-through is unreachable and says so.
     */
    const testStatus = pushStatus(result.outcome);
    const status: StepResult['status'] =
      testStatus === 'PASSED' ? 'PASSED' : testStatus === 'FAILED' ? 'FAILED' : 'SKIPPED';
    const title =
      `${delivery.transport} ${delivery.triggerPath} — ` +
      `${PUSH_OUTCOME_LABELS[result.outcome]}${result.outcome === 'DELIVERED' ? '' : `: ${result.detail}`}`;

    const index = this.steps.length;
    this.ctx.logger.step({ testId: this.testId, index, title, status });
    this.steps.push({
      index,
      title,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      screenshotKey: null,
      error:
        status === 'FAILED'
          ? { message: result.detail, stack: null, selector: null, expected: null, actual: null }
          : null,
    });
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Run a push test: every delivery in the spec, in order.
 *
 * The status rule, which is {@link pushStatus} applied across a list:
 *
 *   · any MISMATCHED or
 *     REQUESTED_NOT_OBSERVED     → FAILED.
 *   · all DELIVERED              → PASSED.
 *   · no DELIVERED at all        → SKIPPED, NOT_RUN, with every remedy. A
 *                                  result with only UNAVAILABLEs in it is not a
 *                                  pass; it is a notification path nobody
 *                                  tested, and saying so is the only honest
 *                                  outcome.
 *   · a mix of DELIVERED and
 *     UNAVAILABLE                → PASSED, with every unmeasured delivery
 *                                  disclosed on the result and in its own step.
 */
export async function runPushTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: PushTestSpec,
  deps: PushDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const recorder = new StepRecorder(ctx, test.id);
  const notes: ConsoleEntry[] = [];

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  const results: PushDeliveryResult[] = [];
  for (const delivery of spec.deliveries) {
    if (ctx.signal.aborted) break;
    const stepStartedAt = Date.now();
    let result: PushDeliveryResult;
    try {
      result = await runPushDelivery(delivery, spec.environment, ctx.baseUrl, deps);
    } catch (err) {
      /*
       * A surface that threw told us nothing about the application, so this is
       * UNAVAILABLE and not REQUESTED_NOT_OBSERVED. The same rule as a failed
       * trigger, for the same reason.
       */
      result = {
        outcome: 'UNAVAILABLE',
        unavailableReason: 'NO_OBSERVER',
        detail: `A push surface failed while checking this: ${
          err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
        }`,
        notAsserted: [
          { assertion: 'that a notification was delivered at all', reason: 'CAPABILITY_ABSENT' },
        ],
        observedForMs: 0,
      };
    }
    results.push(result);
    recorder.record(delivery, result, stepStartedAt);
  }

  /*
   * FAILING rather than `=== 'REQUESTED_NOT_OBSERVED'`, so a fifth outcome
   * whose status is FAILED is counted here the day it is added instead of
   * falling into the "nothing was measured" branch below as a silent pass.
   */
  const failing = results.filter((r) => pushStatus(r.outcome) === 'FAILED');
  const delivered = results.filter((r) => r.outcome === PUSH_PASSING_OUTCOME);
  const unavailables = results.filter((r) => r.outcome === 'UNAVAILABLE');

  for (const result of unavailables) {
    notes.push({
      level: 'warn',
      text: `Not measured — UNAVAILABLE (${result.unavailableReason ?? 'unstated'}): ${result.detail}`,
      at: new Date().toISOString(),
    });
  }
  for (const result of results) {
    for (const hole of result.notAsserted) {
      notes.push({
        level: 'warn',
        text: `NOT ASSERTED (${hole.reason}): ${hole.assertion}`,
        at: new Date().toISOString(),
      });
    }
  }

  const unmeasuredNote =
    unavailables.length > 0
      ? ` ${unavailables.length} of ${results.length} delivery(ies) were NOT measured: ` +
        `${unavailables.map((r) => r.unavailableReason ?? 'unstated').join(', ')}.`
      : '';

  if (failing.length > 0) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      errorMessage: `${failing.map((r) => r.detail).join(' | ')}${unmeasuredNote}`,
    };
  }

  if (delivered.length === 0) {
    const why =
      `None of this test's ${spec.deliveries.length} push delivery(ies) could be attempted, so ` +
      `nothing is claimed about "${test.name}". ` +
      (unavailables.length > 0
        ? unavailables.map((r) => `${r.unavailableReason ?? 'unstated'}: ${r.detail}`).join(' | ')
        : 'The run was cancelled before any delivery was attempted.');
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      /*
       * NOT_RUN, the weakest of the four kinds. BLOCKED_BY_ENV would be a
       * stronger claim than the evidence supports — the environment under test
       * may be perfectly healthy and the gap entirely on this image — and
       * UNSUPPORTED would be wrong the other way, since a WEB_PUSH delivery on
       * a properly granted context runs here fine.
       */
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    errorMessage: unmeasuredNote.trim() || null,
  };
}

// ─── The real adapters ───────────────────────────────────────────────────────

/**
 * An observer that cannot see anything, and SAYS SO for every transport.
 *
 * `{ ok: false }` rather than an empty `observe`, and the distinction is the
 * entire false-green argument of this file. An observer that reported itself
 * available and then returned `[]` would drive every push test to
 * REQUESTED_NOT_OBSERVED — FAILED — which is QAAI reporting a broken
 * notification path on the strength of its own missing adapter. Reporting
 * UNAVAILABLE with a remedy is the honest shape, and it is why `available` is
 * asked before anything is triggered.
 */
export const unavailablePushObserver: PushObserver = {
  available(transport: PushTransport) {
    return Promise.resolve({
      ok: false as const,
      reason: DEVICE_BOUND_PUSH_TRANSPORTS.includes(transport)
        ? ('NO_DEVICE' as const)
        : ('NO_OBSERVER' as const),
    });
  },
  observe() {
    return Promise.resolve([]);
  },
  tap() {
    return Promise.resolve({
      supported: false,
      landedOn: null,
      detail: 'No push observer is attached to this run, so no notification could be tapped.',
    });
  },
};

/** No service worker surface: every Web Push delivery is UNAVAILABLE with the remedy. */
export const unavailableServiceWorker: ServiceWorkerSurface = {
  claimedScope() {
    return Promise.resolve(null);
  },
};

/** A trigger that refuses, so a non-delivery is never blamed on the application. */
export const unavailablePushTrigger: PushTrigger = {
  fire(triggerPath) {
    return Promise.resolve({
      fired: false,
      detail: `No trigger adapter is configured, so ${triggerPath} was not driven.`,
    });
  },
};

/**
 * A credential source that reports NOTHING PRESENT rather than guessing a mode.
 *
 * `mode: 'UNKNOWN'` beside `present: false`, and both halves matter: a source
 * that defaulted to TEST would let a hand-built spec past
 * {@link refuseLiveSender} on an Integration nobody looked at, which is the one
 * way this file could ever drive a live sender.
 */
export const unavailableSenderCredentials: SenderCredentialSource = {
  describe() {
    return Promise.resolve({ present: false, mode: 'UNKNOWN' });
  },
};

let deps: PushDeps = {
  observer: unavailablePushObserver,
  trigger: unavailablePushTrigger,
  worker: unavailableServiceWorker,
  senders: unavailableSenderCredentials,
};

/** Install observer/trigger/worker/credential surfaces. Returns the previous set. */
export function setPushDeps(next: PushDeps): PushDeps {
  const previous = deps;
  deps = next;
  return previous;
}

/**
 * The plugin.
 *
 * `type: 'PUSH'` is in `PENDING_TEST_TYPES` and not in `TEST_TYPES`, so this
 * registers in `PENDING_PLUGINS` in packages/runner/src/registry.ts and
 * `pendingTypes()` reports it as a named gap until the mint lands. The spec
 * schema (`pushTestSpecSchema`) and the type declaration already exist in
 * @qaai/shared, so nothing here invents a second vocabulary for the transports.
 */
export const pushPlugin = {
  type: 'PUSH' as const,

  validate(test: ExecutableTest): void {
    const parsed = pushTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Push test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * The permission gap, caught HERE rather than at run time. A WEB_PUSH
     * delivery with no NOTIFICATIONS grant is a guaranteed UNAVAILABLE, and a
     * test author who learns that after queueing a run has waited to be told
     * about a one-field omission. `validate` runs before anything is triggered.
     */
    const missing = parsed.data.deliveries
      .map((delivery, index) => {
        const gap = missingPermissionGrant(delivery.transport, parsed.data.environment);
        return gap === null ? null : `deliveries[${index}]: ${gap.detail}`;
      })
      .filter((entry): entry is string => entry !== null);
    if (missing.length > 0) {
      throw new Error(`Push test "${test.name}" cannot be attempted — ${missing.join('; ')}`);
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runPushTest(ctx, test, pushTestSpecSchema.parse(test.spec), deps);
  },
};
