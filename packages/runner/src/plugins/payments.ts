/**
 * The PAYMENTS test type (§4) — the money path, which is the first flow every
 * buyer names and the last one this product could execute.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Checkout could be CLICKED THROUGH and the money could not be asserted. No
 * 3DS, no decline, no insufficient funds, no webhook transition, no refund, no
 * partial capture — and clicking through was a PASS. Every other piece of the
 * vocabulary was already here: `paymentsTestSpecSchema` with its fourteen
 * scenario kinds (packages/shared/src/schemas.ts), the PAYMENTS declaration
 * (packages/shared/src/test-type-decl.ts), the `PAYMENT_FIELD` funnel
 * precondition the Explorer uses to propose the test
 * (packages/agent/src/explorer.ts). What was missing was this file, and without
 * it the only non-test reader of a fourteen-kind spec schema was the
 * declaration's own test.
 *
 * ── WHY THE OBVIOUS IMPLEMENTATION IS THE WORST OUTCOME AVAILABLE ───────────
 *
 * A stub that resolved "the charge succeeded" would move a coverage percentage
 * on the strength of a fake, on the money path, for ever. So the five outcomes
 * are closed and {@link moneyPathStatus} is the single function that maps one
 * to a status:
 *
 *   ASSERTED                 the application's own money state was READ BACK
 *                            and it matches the scenario — including the
 *                            AMOUNT, which is the assertion no click-through
 *                            test makes. The only outcome that may pass.
 *
 *   WRONG_MONEY_STATE        we read the money state and it is wrong: a charge
 *                            that succeeded where a decline was expected, a
 *                            capture for the wrong total, a second charge from
 *                            one double-click, an abandoned 3DS challenge that
 *                            took the money anyway, a webhook that arrived and
 *                            was ignored. FAILED, and a CONFIDENT failure —
 *                            which is why it is its own outcome and not folded
 *                            into the one below.
 *
 *   SUBMITTED_NOT_CONFIRMED  we submitted the payment and could not confirm
 *                            what became of it inside the bound. NOT A PASS,
 *                            and on this type it is the gravest sentence the
 *                            product can print: money may have moved and the
 *                            application does not know. FAILED, with the bound
 *                            and the limit of the claim stated in writing.
 *
 *   REFUSED                  QAAI declined to drive it — a gateway in live
 *                            mode, a gateway whose mode nobody established, a
 *                            spec naming something credential-shaped. SKIPPED,
 *                            and RECORDED AS REFUSED rather than as a missing
 *                            capability: filing our own refusal as an absent
 *                            adapter sends somebody to fix the image, and "how
 *                            often does QAAI refuse to charge" is a GROUP BY.
 *
 *   UNAVAILABLE              the question could not be ASKED: no checkout
 *                            adapter, no sandbox integration, no published
 *                            value for the outcome, a bot defence in front of
 *                            the form. SKIPPED with a remedy, never without
 *                            one, and never a pass.
 *
 * `push.ts` folds its live-sender refusal into UNAVAILABLE and maps the reason
 * to `WOULD_MUTATE_PROTECTED_DATA`. This file splits them into two outcomes,
 * and the split is deliberate rather than a difference of taste: on PAYMENTS
 * the refusal is the headline invariant of the whole type, and a reader must be
 * able to count refusals without reading ten remedy strings to work out which
 * UNAVAILABLEs were ours by choice.
 *
 * ── TEST MODE IS STRUCTURAL, IN FOUR PLACES ─────────────────────────────────
 *
 * 1. `paymentScenarioSchema.testMode` is `z.literal(true)` under `.strict()`
 *    with no credential field. A live-mode scenario cannot be constructed,
 *    parsed or stored. That property is not this file's to keep and this file
 *    does not weaken it.
 * 2. {@link refuseLiveMode} asserts it AGAIN at run time, off an `unknown`
 *    view of the field, because {@link runPaymentScenario} is exported and
 *    callable with a cast or a hand-built object. A run-time path that trusted
 *    the schema to have run is a path that fails open.
 * 3. {@link GatewayMode} HAS NO VALUE FIELD. The whole interface is
 *    `{ present, mode }` — the same shape, and the same argument, as
 *    `SenderCredential` in ./push.ts. There is NO EXPRESSION in this file that
 *    can reach a provider secret key: not to log it, not to hash it, not in an
 *    error path. The plugin triggers the APPLICATION's own checkout and the
 *    application holds the key.
 * 4. {@link describePublishedValue} returns a DESCRIPTION of a published test
 *    value and never the value, so this plugin cannot hold a card number
 *    either. The adapter resolves an id to the digits; the plugin passes the
 *    id. A PAN in a step title is a PAN in a log, a report and a Slack
 *    channel.
 *
 * A `mode` of LIVE is refused, and so is UNKNOWN. Absent is NOT "probably
 * test": an unprobed mode resolved optimistically is how a test run charges
 * somebody real, and no install fixes having already done it.
 *
 * ── THE ORDER IS THE DESIGN ─────────────────────────────────────────────────
 *
 * Every refusal happens BEFORE the checkout is submitted — see
 * {@link runPaymentScenario}'s seven numbered steps. Reordering the submission
 * ahead of an environment check turns OUR gap into SUBMITTED_NOT_CONFIRMED,
 * which is FAILED: QAAI reporting a defect in the customer's payment code
 * because this image has no adapter. On this type that mistake has a second
 * cost the other types do not pay — the submission is itself a write against
 * the customer's sandbox, which is why step 5 refuses to submit a payment
 * nothing in this run could have verified.
 *
 * ── THE CATALOGUE GATE, WHICH THE SCHEMA PROMISED AND NOBODY IMPLEMENTED ────
 *
 * `paymentScenarioSchema`'s comment says `catalogueId` is "validated against
 * the catalogue by the producer". packages/shared/src/payments.adversary.test.ts
 * records two FINDINGS against that promise: an invented id parses, and a raw
 * card-shaped number parses. There was no producer and no plugin, so nothing
 * validated it. {@link validatePublishedValue} is that gate — applied in
 * `validate()` before a run is queued and again at run time — and it checks the
 * thing that actually matters: that the named value FORCES THE OUTCOME THE
 * SCENARIO ASSERTS. A wrong test card is a silent payment-test failure: the
 * charge is declined for the wrong reason, the test asserts a decline, and it
 * passes while proving nothing.
 *
 * ── A CAPTCHA IS NEVER DEFEATED ─────────────────────────────────────────────
 *
 * The checkout adapter REPORTS a bot defence as `BOT_PROTECTION_UNSOLVED` and
 * this plugin stops there, with the keystone reason
 * `UNREACHABLE_BEHIND_BOT_PROTECTION` and a remedy that belongs entirely to the
 * customer: set the provider's own published test key on their own environment.
 * Nothing in this file evades, solves or works around a bot defence, and the
 * remedy printed beside the refusal comes from OUR table rather than from the
 * adapter's prose — an adapter's `detail` is data, not a remedy.
 *
 * ── INJECTED SURFACES (rule 8) ──────────────────────────────────────────────
 *
 * Nothing here imports playwright, spawns a process or opens a socket. Four
 * narrow interfaces and a clock, and every `unavailable*` default REFUSES
 * rather than fabricating an answer. The whole decision table is tested against
 * recorders with no browser and no provider.
 */

import { z } from 'zod';
import {
  CATALOGUE_PUBLISHERS,
  OUTCOME_FORCING_SCENARIOS,
  PAYMENT_SCENARIO_KINDS,
  SECRET_SHAPES,
  TEST_VALUES,
  admitPublishedValue,
  catalogueEntriesFor,
  catalogueHasId,
  isLuhnValid,
  paymentsTestSpecSchema,
  testValuesForProvider,
  unassertedReasonSchema,
} from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  PaymentOutcome,
  PaymentScenarioKind,
  RunContext,
  StepResult,
  TestExecution,
  TestResultStatus,
  TestValueProvider,
} from '@qaai/shared';
import { errorText } from '../files.js';

export type PaymentsTestSpec = z.infer<typeof paymentsTestSpecSchema>;
export type PaymentScenarioSpec = PaymentsTestSpec['scenarios'][number];

/**
 * The keystone's `UnassertedReason`, taken off the zod enum rather than off
 * `./test-type-decl`. Same reasoning as the twins in ./push.ts and ./email.ts:
 * one import, one vocabulary, and a gap that lands in the keystone's words
 * rather than in a sentence only this file understands.
 */
type UnassertedReasonName = z.infer<typeof unassertedReasonSchema>;

/** A hole this run left, in the keystone's vocabulary. */
export interface NotAsserted {
  readonly assertion: string;
  readonly reason: UnassertedReasonName;
}

// ─── The five outcomes ───────────────────────────────────────────────────────

/**
 * What one payment scenario concluded. See the file header.
 *
 * ORDER IS PASS-FIRST on purpose: a reader scanning this list meets the only
 * passing outcome and then, immediately, the four that are not passes — which
 * is the opposite of how the obvious implementation reads.
 */
export const MONEY_PATH_OUTCOMES = [
  'ASSERTED',
  'WRONG_MONEY_STATE',
  'SUBMITTED_NOT_CONFIRMED',
  'REFUSED',
  'UNAVAILABLE',
] as const;
export type MoneyPathOutcome = (typeof MONEY_PATH_OUTCOMES)[number];

/** Compile-time half of the parity guard; the run-time half is in payments.test.ts. */
const MONEY_PATH_OUTCOME_PRESENT: Record<MoneyPathOutcome, true> = {
  ASSERTED: true,
  WRONG_MONEY_STATE: true,
  SUBMITTED_NOT_CONFIRMED: true,
  REFUSED: true,
  UNAVAILABLE: true,
};

/** Derived, never hand-listed. */
export const MONEY_PATH_OUTCOME_LIST = Object.keys(
  MONEY_PATH_OUTCOME_PRESENT,
) as ReadonlyArray<MoneyPathOutcome>;

export const MONEY_PATH_OUTCOME_LABELS: Record<MoneyPathOutcome, string> = {
  ASSERTED: 'The money state was read back and matches',
  WRONG_MONEY_STATE: 'The money state was read back and it is wrong',
  SUBMITTED_NOT_CONFIRMED: 'Submitted, and what became of the money is unconfirmed',
  REFUSED: 'QAAI refused to drive this',
  UNAVAILABLE: 'The question could not be asked here',
};

/**
 * THE ONE OUTCOME THAT MAY PASS, as a value rather than as a condition.
 *
 * Exported so {@link moneyPathStatus}, the aggregate in {@link runPaymentsTest}
 * and both of their tests read the same constant. A second `=== 'ASSERTED'`
 * elsewhere in this file is how an invariant comes to have two implementations
 * and one of them is wrong.
 */
export const MONEY_PATH_PASSING_OUTCOME: MoneyPathOutcome = 'ASSERTED';

/**
 * The status one outcome produces. THE invariant of this file.
 *
 *   ASSERTED                → PASSED
 *   WRONG_MONEY_STATE       → FAILED. We read it and it is wrong.
 *   SUBMITTED_NOT_CONFIRMED → FAILED. We submitted a payment and nothing told
 *                             us what happened to it. The step's own sentence
 *                             bounds the claim.
 *   REFUSED                 → SKIPPED, and the caller attaches the refusal.
 *   UNAVAILABLE             → SKIPPED, and the caller attaches the remedy. A
 *                             bare SKIPPED is the lie.
 *
 * `satisfies` on a record rather than a switch, because a sixth outcome then
 * fails to compile HERE instead of falling through a default — and a default in
 * this function is a false green by construction.
 */
const MONEY_PATH_OUTCOME_STATUS = {
  ASSERTED: 'PASSED',
  WRONG_MONEY_STATE: 'FAILED',
  SUBMITTED_NOT_CONFIRMED: 'FAILED',
  REFUSED: 'SKIPPED',
  UNAVAILABLE: 'SKIPPED',
} satisfies Record<MoneyPathOutcome, TestResultStatus>;

export function moneyPathStatus(outcome: MoneyPathOutcome): TestResultStatus {
  return MONEY_PATH_OUTCOME_STATUS[outcome];
}

// ─── Why QAAI refused ────────────────────────────────────────────────────────

/**
 * The reasons this plugin declines to drive a scenario, each with a REMEDY.
 *
 * A closed union rather than a sentence, because "how often did QAAI refuse to
 * touch the money path, and why" is a `GROUP BY` and not a paragraph. Every one
 * of these is a decision OF OURS about a capability that is PRESENT, which is
 * exactly what keeps them out of {@link PAYMENT_UNAVAILABLE_REASONS}.
 */
export const PAYMENT_REFUSAL_REASONS = [
  /** The gateway integration reports live mode. The one this type exists to prevent. */
  'LIVE_MODE_GATEWAY',
  /** Nobody established the mode. Refused exactly as hard as LIVE. */
  'GATEWAY_MODE_UNESTABLISHED',
  /** `testMode` is not the literal `true` — a cast, or a hand-built scenario. */
  'TEST_MODE_NOT_DECLARED',
  /** The spec's `catalogueId` carries the prefix of a provider credential. */
  'SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE',
  /** The spec's `catalogueId` is a run of 12–19 digits, i.e. a card number. */
  'SPEC_NAMES_A_RAW_CARD_NUMBER',
  /** The spec's `path` resolves to a host the environment did not name. */
  'PATH_LEAVES_THE_ENVIRONMENT',
] as const;
export type PaymentRefusalReason = (typeof PAYMENT_REFUSAL_REASONS)[number];

const PAYMENT_REFUSAL_PRESENT: Record<PaymentRefusalReason, true> = {
  LIVE_MODE_GATEWAY: true,
  GATEWAY_MODE_UNESTABLISHED: true,
  TEST_MODE_NOT_DECLARED: true,
  SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE: true,
  SPEC_NAMES_A_RAW_CARD_NUMBER: true,
  PATH_LEAVES_THE_ENVIRONMENT: true,
};

/** Derived, never hand-listed. */
export const PAYMENT_REFUSAL_REASON_LIST = Object.keys(
  PAYMENT_REFUSAL_PRESENT,
) as ReadonlyArray<PaymentRefusalReason>;

/**
 * Which `UnassertedReason` a refusal lands under.
 *
 * ALL FIVE are `WOULD_MUTATE_PROTECTED_DATA` and not one is
 * `CAPABILITY_ABSENT`, which is the whole reason the mapping exists as a table
 * rather than as a default: driving any of these could have moved real money,
 * the capability to do so was PRESENT, and a report that filed our refusal as a
 * missing install would send a reader to install an adapter that is already
 * here. Rule 12 names "a REFUSED surface recorded the same way as one that does
 * not exist".
 */
export const PAYMENT_REFUSAL_AS_UNASSERTED: Record<PaymentRefusalReason, UnassertedReasonName> = {
  LIVE_MODE_GATEWAY: 'WOULD_MUTATE_PROTECTED_DATA',
  GATEWAY_MODE_UNESTABLISHED: 'WOULD_MUTATE_PROTECTED_DATA',
  TEST_MODE_NOT_DECLARED: 'WOULD_MUTATE_PROTECTED_DATA',
  SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE: 'WOULD_MUTATE_PROTECTED_DATA',
  SPEC_NAMES_A_RAW_CARD_NUMBER: 'WOULD_MUTATE_PROTECTED_DATA',
  PATH_LEAVES_THE_ENVIRONMENT: 'WOULD_MUTATE_PROTECTED_DATA',
};

export const PAYMENT_REFUSAL_REMEDIES: Record<PaymentRefusalReason, string> = {
  LIVE_MODE_GATEWAY:
    'The named publisher’s integration is in LIVE mode on this environment. Point the environment ' +
    'at the provider’s TEST mode. QAAI will not drive a live gateway, so no real customer is ever ' +
    'charged by a test run.',
  GATEWAY_MODE_UNESTABLISHED:
    'Nobody established whether the gateway is in test mode, and an unprobed mode is NOT ' +
    '"probably test". Record the mode on the publisher’s integration and re-run; the answer flips ' +
    'to driveable the moment it says TEST.',
  TEST_MODE_NOT_DECLARED:
    'This scenario did not arrive through `paymentsTestSpecSchema`, where `testMode` is ' +
    '`z.literal(true)`. Parse the spec rather than casting it — the schema is the first of the ' +
    'four places test mode is enforced and this refusal is the second.',
  SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE:
    'The scenario’s `catalogueId` has the shape of a provider credential — a known credential ' +
    'prefix, or a long unstructured mixed-case run. A credential belongs ' +
    'on an AuthProfile row referencing Secret.name, never in a spec — name the PUBLISHED test ' +
    'value by its catalogue id instead.',
  SPEC_NAMES_A_RAW_CARD_NUMBER:
    'The scenario’s `catalogueId` is a long run of digits, which is the shape of a card number. A ' +
    'catalogue id NAMES a published value (`stripe.card.declined.generic`); it is never the value ' +
    'itself. QAAI will not drive a card number it was handed, and the id is not echoed anywhere.',
  PATH_LEAVES_THE_ENVIRONMENT:
    'A checkout `path` is a route on the environment under test (`/checkout`), never a URL. This ' +
    'one resolves to a different origin from the environment’s base URL, and a payment submitted ' +
    'there is a payment sent to a host nobody here named. A hosted payment page is reached by ' +
    'the checkout’s own redirect, which the adapter follows from the route. The path is not ' +
    'echoed anywhere.',
};

// ─── Why the question could not be asked ─────────────────────────────────────

/**
 * The reasons a scenario could not be ATTEMPTED, each with a REMEDY.
 *
 * The remedy sits beside the reason so the two cannot drift. An UNAVAILABLE
 * with no remedy is a dead end a customer cannot act on, which is how a gap
 * becomes permanent.
 */
export const PAYMENT_UNAVAILABLE_REASONS = [
  /** No checkout adapter is installed on this run. */
  'NO_CHECKOUT_SURFACE',
  /** The publisher has no sandbox integration on this environment. */
  'NO_GATEWAY_INTEGRATION',
  /** The `catalogueId` names nothing either catalogue in this build knows. */
  'NO_PUBLISHED_TEST_VALUE',
  /** The named value forces a DIFFERENT outcome, and a right one exists. */
  'VALUE_FORCES_A_DIFFERENT_OUTCOME',
  /** No published value from this provider forces the outcome at all. */
  'TEST_MODE_CANNOT_PRODUCE_IT',
  /** Nothing can read the application's own money state back. */
  'NO_MONEY_STATE_SOURCE',
  /** No webhook observer, so a provider transition could not have been seen. */
  'NO_WEBHOOK_OBSERVER',
  /** The application exposes no capture or refund action this run can drive. */
  'MERCHANT_ACTION_UNAVAILABLE',
  /** The checkout route never came up, so nothing was submitted. */
  'CHECKOUT_UNREACHABLE',
  /** A bot defence guards the form and no documented test key is configured. */
  'BOT_PROTECTION_UNSOLVED',
] as const;
export type PaymentUnavailableReason = (typeof PAYMENT_UNAVAILABLE_REASONS)[number];

const PAYMENT_UNAVAILABLE_PRESENT: Record<PaymentUnavailableReason, true> = {
  NO_CHECKOUT_SURFACE: true,
  NO_GATEWAY_INTEGRATION: true,
  NO_PUBLISHED_TEST_VALUE: true,
  VALUE_FORCES_A_DIFFERENT_OUTCOME: true,
  TEST_MODE_CANNOT_PRODUCE_IT: true,
  NO_MONEY_STATE_SOURCE: true,
  NO_WEBHOOK_OBSERVER: true,
  MERCHANT_ACTION_UNAVAILABLE: true,
  CHECKOUT_UNREACHABLE: true,
  BOT_PROTECTION_UNSOLVED: true,
};

/** Derived, never hand-listed. */
export const PAYMENT_UNAVAILABLE_REASON_LIST = Object.keys(
  PAYMENT_UNAVAILABLE_PRESENT,
) as ReadonlyArray<PaymentUnavailableReason>;

/**
 * Which `UnassertedReason` each one maps onto.
 *
 * Three of these earn their sentence. `CHECKOUT_UNREACHABLE` is
 * `SURFACE_UNREACHED` and not `CAPABILITY_ABSENT`: the adapter worked and the
 * route did not come up, which is a fact about the deployment rather than about
 * this image. `BOT_PROTECTION_UNSOLVED` uses the keystone's own member, because
 * it is the one gap whose remedy belongs entirely to the customer.
 * `TEST_MODE_CANNOT_PRODUCE_IT` is `PROVIDER_TEST_MODE_LIMIT` — neither our gap
 * nor a defect of theirs, the same reading the PAYMENTS declaration's
 * `knownUnasserted` entries carry.
 */
export const PAYMENT_UNAVAILABLE_AS_UNASSERTED: Record<
  PaymentUnavailableReason,
  UnassertedReasonName
> = {
  NO_CHECKOUT_SURFACE: 'CAPABILITY_ABSENT',
  NO_GATEWAY_INTEGRATION: 'REQUIRES_PROVISIONED_SANDBOX',
  NO_PUBLISHED_TEST_VALUE: 'REQUIRES_PROVISIONED_SANDBOX',
  VALUE_FORCES_A_DIFFERENT_OUTCOME: 'NOT_IMPLEMENTED',
  TEST_MODE_CANNOT_PRODUCE_IT: 'PROVIDER_TEST_MODE_LIMIT',
  NO_MONEY_STATE_SOURCE: 'CAPABILITY_ABSENT',
  NO_WEBHOOK_OBSERVER: 'CAPABILITY_ABSENT',
  MERCHANT_ACTION_UNAVAILABLE: 'CAPABILITY_ABSENT',
  CHECKOUT_UNREACHABLE: 'SURFACE_UNREACHED',
  BOT_PROTECTION_UNSOLVED: 'UNREACHABLE_BEHIND_BOT_PROTECTION',
};

export const PAYMENT_UNAVAILABLE_REMEDIES: Record<PaymentUnavailableReason, string> = {
  NO_CHECKOUT_SURFACE:
    'No checkout adapter is attached to this run, so no payment could be submitted. Attach one ' +
    'before reading a PAYMENTS result as evidence about your money path.',
  NO_GATEWAY_INTEGRATION:
    'This environment has no sandbox integration for the named publisher. Connect the provider’s ' +
    'TEST-mode account; QAAI never reads the key — it asks only whether one exists and which mode ' +
    'it is in.',
  NO_PUBLISHED_TEST_VALUE:
    'The scenario’s `catalogueId` names nothing in TEST_VALUES or PROVIDER_CATALOGUE. Name a ' +
    'published value that exists, or add the entry with its provenance — a value with no ' +
    'provenance cannot be acted on when a payment test fails for a reason that makes no sense.',
  VALUE_FORCES_A_DIFFERENT_OUTCOME:
    'The named test value forces a different provider outcome from the one this scenario asserts, ' +
    'so the run would drive the wrong card: the charge is refused for the wrong reason, the ' +
    'assertion still sees a refusal, and the test passes having proved nothing. Name the value ' +
    'whose catalogued outcome matches the scenario kind.',
  TEST_MODE_CANNOT_PRODUCE_IT:
    'No published value from this provider forces the outcome this scenario asserts, so no ' +
    'catalogue id would fix it. Either drive the scenario against a provider whose test mode ' +
    'publishes that outcome, or drop it — it is not a gap in your application.',
  NO_MONEY_STATE_SOURCE:
    'Nothing can read the application’s own money state back, so "the success page rendered" ' +
    'would be the strongest available claim — which is exactly the defect this type exists to ' +
    'remove. Attach a money-state adapter; until then no payment is submitted at all, because a ' +
    'charge nobody can verify is a write with no assertion.',
  NO_WEBHOOK_OBSERVER:
    'No webhook observer is attached, so a provider transition could not have been seen even if ' +
    'one arrived. The webhook is the half of a payment integration that breaks silently; a result ' +
    'without this adapter says nothing about it.',
  MERCHANT_ACTION_UNAVAILABLE:
    'This scenario needs the application’s OWN capture or refund action and the adapter exposes ' +
    'none. Point the adapter at the merchant action, or drop the scenario rather than reading an ' +
    'uncaptured authorisation as a capture.',
  CHECKOUT_UNREACHABLE:
    'The checkout route did not come up, so nothing was submitted and nothing is claimed. Check ' +
    'the path on the scenario and the environment’s base URL.',
  BOT_PROTECTION_UNSOLVED:
    'A bot defence guards this checkout and no documented test key is configured. The remedy is ' +
    'for the CUSTOMER to set the provider’s own published dummy site key and its paired secret on ' +
    'their own test environment. QAAI will not and cannot work around a bot defence.',
};

// ─── The money state, which is what "asserted" means here ───────────────────

/**
 * The states the money can be in, as the APPLICATION reports them.
 *
 * As the application reports them, and deliberately not as the provider does.
 * The defect this type exists for is the DISAGREEMENT between the two — the
 * charge succeeds and the order sits unpaid — so the half worth reading back is
 * what the application believes, which is also the only half a customer's own
 * users ever see.
 *
 * `NONE` is a real reading and never a default: it means the application has no
 * charge for this attempt, which is the CORRECT state after a decline or an
 * abandoned 3DS challenge, and the money-state source must be able to report it
 * affirmatively. An adapter that could not read is `null`, which is a different
 * fact with a different outcome. Rule 11: an unmeasured thing is not a zero.
 */
export const MONEY_STATES = [
  'NONE',
  'AUTHORISED',
  'CAPTURED',
  'PARTIALLY_CAPTURED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DECLINED',
  'REJECTED_CLIENT_SIDE',
  'CHALLENGE_ABANDONED',
] as const;
export type MoneyState = (typeof MONEY_STATES)[number];

const MONEY_STATE_PRESENT: Record<MoneyState, true> = {
  NONE: true,
  AUTHORISED: true,
  CAPTURED: true,
  PARTIALLY_CAPTURED: true,
  REFUNDED: true,
  PARTIALLY_REFUNDED: true,
  DECLINED: true,
  REJECTED_CLIENT_SIDE: true,
  CHALLENGE_ABANDONED: true,
};

/** Derived, never hand-listed. */
export const MONEY_STATE_LIST = Object.keys(MONEY_STATE_PRESENT) as ReadonlyArray<MoneyState>;

/**
 * The states each scenario kind ACCEPTS, most-expected first.
 *
 * A LIST AND NOT ONE STATE, and that is the difference between a finding and a
 * false positive. An application that records "the 3DS challenge was abandoned
 * and no money was taken" and one that records nothing at all are both correct,
 * and a single expected state would have failed one of them — QAAI reporting a
 * defect that is not there, which is the most expensive kind of wrong this
 * product can be. The FIRST entry is the one the sentence names and the one
 * {@link expectedChargeMinor} is keyed on.
 *
 * Compiler-exhaustive over the SHARED union, so a fifteenth
 * `PaymentScenarioKind` fails to compile here rather than silently acquiring a
 * default. Two entries deserve their own sentence:
 *
 *   THREE_DS_CHALLENGE_FAIL accepts only the no-money states. An abandoned
 *   challenge that took the money anyway is the single worst defect on this
 *   list, and the only way to catch it is to assert the ABSENCE of a charge
 *   rather than the presence of an error message.
 *
 *   WEBHOOK_TRANSITION is `null` — its assertion is not a terminal state. What
 *   it proves is that the named provider event ARRIVED and that the application
 *   APPLIED it; which terminal state is correct afterwards depends on the
 *   customer's own integration, and this file inventing one would be asserting
 *   against a design it has never seen. The gap is recorded, not filled. See
 *   {@link runWebhookScenario}.
 */
export const ACCEPTABLE_MONEY_STATES: Record<
  PaymentScenarioKind,
  readonly [MoneyState, ...MoneyState[]] | null
> = {
  AUTHORISE_AND_CAPTURE: ['CAPTURED'],
  AUTHORISE_THEN_DELAYED_CAPTURE: ['CAPTURED'],
  PARTIAL_CAPTURE: ['PARTIALLY_CAPTURED'],
  THREE_DS_CHALLENGE_PASS: ['CAPTURED'],
  THREE_DS_CHALLENGE_FAIL: ['NONE', 'CHALLENGE_ABANDONED'],
  /*
   * A decline may leave a declined RECORD or nothing at all, and both are
   * correct implementations. What is not correct is CAPTURED, which this still
   * catches — the assertion that matters is "no money moved", and `chargeCount`
   * below is what proves it.
   */
  DECLINE_GENERIC: ['DECLINED', 'NONE'],
  DECLINE_INSUFFICIENT_FUNDS: ['DECLINED', 'NONE'],
  DECLINE_EXPIRED_CARD: ['DECLINED', 'NONE'],
  DECLINE_INCORRECT_CVC: ['DECLINED', 'NONE'],
  INVALID_CARD_NUMBER: ['REJECTED_CLIENT_SIDE', 'NONE'],
  WEBHOOK_TRANSITION: null,
  REFUND_FULL: ['REFUNDED'],
  REFUND_PARTIAL: ['PARTIALLY_REFUNDED'],
  DUPLICATE_SUBMISSION: ['CAPTURED'],
};

/**
 * The provider outcome each scenario kind needs its named value to FORCE.
 *
 * Compiler-exhaustive over the shared union for the same reason as the record
 * above, and the values are `PaymentOutcome` from
 * packages/shared/src/test-values.ts rather than a second vocabulary — the
 * catalogue already decided what a card does, and a parallel list is a list
 * that stops matching.
 *
 * `WEBHOOK_TRANSITION` is null: the EVENT forces that outcome, not a card,
 * which is also why `OUTCOME_FORCING_SCENARIOS` deliberately excludes it. The
 * 3-D Secure pair share `requires-3ds` — the same card presents the challenge
 * and the DRIVER decides whether it is completed or abandoned.
 */
export const FORCED_OUTCOME_FOR_SCENARIO: Record<PaymentScenarioKind, PaymentOutcome | null> = {
  AUTHORISE_AND_CAPTURE: 'success',
  AUTHORISE_THEN_DELAYED_CAPTURE: 'success',
  PARTIAL_CAPTURE: 'success',
  THREE_DS_CHALLENGE_PASS: 'requires-3ds',
  THREE_DS_CHALLENGE_FAIL: 'requires-3ds',
  DECLINE_GENERIC: 'declined-generic',
  DECLINE_INSUFFICIENT_FUNDS: 'declined-insufficient-funds',
  DECLINE_EXPIRED_CARD: 'declined-expired-card',
  DECLINE_INCORRECT_CVC: 'declined-incorrect-cvc',
  INVALID_CARD_NUMBER: 'invalid-number',
  WEBHOOK_TRANSITION: null,
  REFUND_FULL: 'success',
  REFUND_PARTIAL: 'success',
  DUPLICATE_SUBMISSION: 'success',
};

/**
 * How many money-taking charges may exist for an attempt that ended in a given
 * state.
 *
 * An exhaustive switch over `MoneyState` rather than a set of names, so a tenth
 * money state has to be given an allowance here instead of defaulting to one —
 * and the default that a careless author would pick is the dangerous direction,
 * since "one charge is fine" is what makes a double charge invisible.
 *
 * `chargeCount` on {@link ObservedMoney} counts charges that TOOK MONEY, which
 * is why DECLINED allows none: a declined attempt may leave a record, and a
 * record is not a charge.
 */
export function chargesAllowedFor(state: MoneyState): number {
  switch (state) {
    case 'AUTHORISED':
    case 'CAPTURED':
    case 'PARTIALLY_CAPTURED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 1;
    case 'NONE':
    case 'DECLINED':
    case 'REJECTED_CLIENT_SIDE':
    case 'CHALLENGE_ABANDONED':
      return 0;
  }
}

// ─── The injected surfaces (rule 8) ─────────────────────────────────────────

/**
 * A payment gateway's mode, DESCRIBED AND NEVER HANDED OVER.
 *
 * There is no `key`, no `secretKey`, no `apiKey` and no `token`, and that
 * absence is load-bearing — see the file header. The plugin's only legitimate
 * questions about a sandbox credential are "is there one" and "is it the test
 * one", and both are answerable without the bytes. The plugin triggers the
 * APPLICATION's checkout; the application sends the charge.
 *
 * Structurally identical to `SenderCredential` in ./push.ts, and deliberately
 * not imported from it: a plugin importing another plugin couples two
 * independently promotable types. Consolidation is named in the handover.
 */
export interface GatewayMode {
  readonly present: boolean;
  /**
   * TEST, LIVE, or UNKNOWN when nothing established it.
   *
   * ABSENT IS NOT TEST, and UNKNOWN is refused exactly like LIVE. An unprobed
   * mode resolved optimistically is how a test run charges somebody real.
   */
  readonly mode: 'TEST' | 'LIVE' | 'UNKNOWN';
}

/** Resolves a publisher to its gateway's mode. Never to a secret. */
export interface GatewayModeSource {
  describe(publisher: string): Promise<GatewayMode>;
}

/** The application's own money-moving action, as opposed to the provider's API. */
export const MERCHANT_ACTIONS = ['CAPTURE', 'REFUND'] as const;
export type MerchantAction = (typeof MERCHANT_ACTIONS)[number];

const MERCHANT_ACTION_PRESENT: Record<MerchantAction, true> = {
  CAPTURE: true,
  REFUND: true,
};

/** Derived, never hand-listed. */
export const MERCHANT_ACTION_LIST = Object.keys(
  MERCHANT_ACTION_PRESENT,
) as ReadonlyArray<MerchantAction>;

/**
 * What the adapter is told to submit.
 *
 * `catalogueId` AND NOT A CARD NUMBER. The adapter resolves the id to the
 * digits and types them; this plugin passes the name. That is what makes the
 * plugin incapable of putting a PAN into a step title, an error message or an
 * artifact, and it is why {@link describePublishedValue} returns a description
 * with no value field.
 */
export interface CheckoutRequest {
  readonly path: string;
  readonly catalogueId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  /** How many times to submit. 2 for DUPLICATE_SUBMISSION, 1 for everything else. */
  readonly submissions: number;
}

/**
 * Whether the checkout can be driven at all, asked BEFORE anything is
 * submitted.
 *
 * A REASON and never a bare boolean, which is the shape `PushObserver.available`
 * uses and for the same reason: the UNAVAILABLE step has to be able to print
 * WHICH gap applied, and "no adapter is configured" and "the route 500ed" have
 * different remedies and different owners. The adapter supplies the reason and
 * the `detail`; the REMEDY printed beside it comes from
 * {@link PAYMENT_UNAVAILABLE_REMEDIES}, because an adapter's prose is data and
 * a remedy is a product decision.
 *
 * `BOT_PROTECTION_UNSOLVED` is the reason an adapter returns when it sees a bot
 * defence. Nothing in this plugin then tries to get past it.
 */
export type CheckoutArrival =
  | { readonly ok: true; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: PaymentUnavailableReason;
      readonly detail: string;
    };

/**
 * What one submission did, as the page showed it.
 *
 * `reference` is the application's OWN identifier for the attempt — an order
 * number, a payment id it renders — carried so the money state can be read back
 * for the right attempt. It is never a card, a token, a cookie or a header
 * value: rule 3 forbids this file from storing or reporting a request body, a
 * header or a cookie from an observed request, and there is no field here one
 * could occupy.
 */
export interface CheckoutSubmission {
  readonly submitted: boolean;
  readonly reference: string | null;
  /** The form refused the value before any network call (INVALID_CARD_NUMBER). */
  readonly rejectedClientSide: boolean;
  /** A 3-D Secure challenge was presented and is waiting. */
  readonly challengePresented: boolean;
  readonly detail: string;
}

/** What resolving a 3-D Secure challenge did. */
export interface ChallengeResult {
  readonly completed: boolean;
  readonly detail: string;
}

/** What a merchant action did. */
export interface MerchantActionResult {
  readonly performed: boolean;
  readonly detail: string;
}

/**
 * The checkout, as this plugin needs it. Four methods, none of them a `Page`.
 *
 * Narrow on purpose: each is satisfiable in a handful of lines against a real
 * Playwright context, and the decision table above is tested with no browser at
 * all. `null` from `resolveChallenge` or `merchantAction` means THIS ADAPTER
 * CANNOT, which is UNAVAILABLE; it never means the application refused, which
 * is a different fact with a different status — hence the `performed` and
 * `completed` booleans on the results.
 */
export interface CheckoutSurface {
  arrive(path: string, baseUrl: string): Promise<CheckoutArrival>;
  submit(request: CheckoutRequest, baseUrl: string): Promise<CheckoutSubmission>;
  resolveChallenge(action: 'COMPLETE' | 'ABANDON'): Promise<ChallengeResult | null>;
  merchantAction(
    action: MerchantAction,
    amountMinor: number | null,
  ): Promise<MerchantActionResult | null>;
}

/**
 * The money, as the application reports it.
 *
 * `chargeCount` is what makes DUPLICATE_SUBMISSION decidable: two identical
 * submissions must leave EXACTLY ONE charge, and "the page looked right" cannot
 * tell one charge from two. It counts charges that TOOK MONEY — see
 * {@link chargesAllowedFor}. `chargedMinor` is what makes every other scenario
 * more than a page assertion: an amount on the screen that disagrees with the
 * amount taken is the defect no click-through test has ever caught.
 */
export interface ObservedMoney {
  readonly state: MoneyState;
  /** Minor units the application says were taken, or null when it will not say. */
  readonly chargedMinor: number | null;
  readonly currency: string | null;
  readonly chargeCount: number;
}

export interface MoneyStateSource {
  /**
   * Can the money be read back on this run at all?
   *
   * Asked BEFORE anything is submitted, and that order is a safety property
   * rather than an optimisation: submitting a payment this run could never
   * verify is a write against the customer's sandbox with no assertion
   * attached, which is the one thing a test-mode charge must never be.
   */
  available(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: PaymentUnavailableReason }
  >;
  /**
   * Read the application's money state back.
   *
   * `null` means COULD NOT READ and never "there is no charge" — that is
   * `state: 'NONE'`, which is a reading somebody took. Conflating the two is
   * how an adapter outage comes to be reported as a correctly refused payment.
   */
  observe(reference: string | null, timeoutMs: number): Promise<ObservedMoney | null>;
}

/**
 * A provider event the application received, as an observer saw it.
 *
 * NO PAYLOAD, NO HEADERS, NO SIGNATURE. The event NAME is the one the spec
 * already named and `appliedByApplication` is a boolean. Rule 3 forbids this
 * file from storing or reporting a request body or a header value from an
 * observed request, and this shape honours that structurally rather than by
 * remembering to redact: there is no field a webhook body could occupy.
 */
export interface ObservedTransition {
  readonly event: string;
  readonly appliedByApplication: boolean;
  readonly detail: string;
}

export interface WebhookObserver {
  /**
   * Can this observer see a provider transition at all?
   *
   * Asked BEFORE the checkout is driven, because an observer that cannot see is
   * the difference between UNAVAILABLE and SUBMITTED_NOT_CONFIRMED — and
   * getting that backwards reports a broken webhook path on the strength of our
   * own missing adapter.
   */
  available(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: PaymentUnavailableReason }
  >;
  /**
   * The transition, or `null` when none arrived inside the bound. Null is NOT
   * "the provider sent nothing" — it is "nothing came through the one observer
   * attached to this run", and the step's sentence makes that distinction in
   * writing.
   */
  waitFor(event: string, timeoutMs: number): Promise<ObservedTransition | null>;
}

/**
 * Injected so tests do not sleep. Structurally identical to `PushClock` in
 * ./push.ts and `MailClock` in ./email.ts, and deliberately not imported from
 * either, for the reason stated on {@link GatewayMode}.
 */
export interface PaymentsClock {
  now(): number;
}

export const realPaymentsClock: PaymentsClock = { now: () => Date.now() };

export interface PaymentsDeps {
  checkout: CheckoutSurface;
  gateways: GatewayModeSource;
  money: MoneyStateSource;
  webhooks: WebhookObserver;
  clock?: PaymentsClock;
}

// ─── The observation bound ───────────────────────────────────────────────────

/**
 * How long to wait for the money to settle into a state, in milliseconds.
 *
 * A CONSTANT because `paymentScenarioSchema` is `.strict()` and has nowhere to
 * carry one: there is no `timeoutSeconds` on a payment scenario the way there
 * is on a push delivery. Fifteen seconds is a budget somebody chose — long
 * enough for a sandbox round trip and a webhook, short enough that a suite of
 * twenty scenarios cannot consume a run on its own — which is why it is a named
 * constant with this sentence beside it rather than an integer at a call site.
 * A per-scenario field is a one-line edit to packages/shared/src/schemas.ts and
 * is named in the handover; inventing a plugin-local spec field here would be a
 * second vocabulary for a spec that does not have one.
 */
export const DEFAULT_MONEY_OBSERVATION_MS = 15_000;

/**
 * The ceiling on a sentence an ADAPTER handed us, before it is printed.
 *
 * Every `detail` on a {@link CheckoutArrival}, a {@link CheckoutSubmission}, a
 * {@link ChallengeResult}, a {@link MerchantActionResult} and an
 * {@link ObservedTransition} is prose from outside this file — written by an
 * adapter, and in the webhook case derived from what a provider sent. Rule 8
 * says bound every length: these strings land in a step title, an
 * `errorMessage` and a log line, and an adapter that returned a megabyte of
 * HTML would put it in all three.
 *
 * TRUNCATED AND SAID SO, rather than truncated silently — a sentence that stops
 * mid-word with no marker reads as the adapter's own wording, and the next
 * reader debugs the wrong thing. Rejecting outright is the right answer for an
 * uploaded document; here the first three hundred characters of "the form
 * refused the card" are the useful part and discarding them would lose the only
 * explanation the result has.
 */
export const MAX_ADAPTER_DETAIL = 300;

export function adapterDetail(text: string): string {
  /*
   * MASKED BEFORE IT IS BOUNDED. An adapter quotes what the customer's page said,
   * and a checkout that errors often says too much: a server error that echoes
   * the key it was configured with, a debug banner, a provider message such as
   * "Invalid API Key provided". Bounding first would leave a prefix that is still
   * a usable credential — this file's own header says as much about a refusal
   * message — and bounding is not redaction.
   */
  const masked = maskCredentialShapes(text);
  if (masked.length <= MAX_ADAPTER_DETAIL) return masked;
  return `${masked.slice(0, MAX_ADAPTER_DETAIL)}… [truncated from ${masked.length} characters]`;
}

/**
 * Credential-shaped runs, masked, in a string that is about to be printed.
 *
 * ── THE DEFECT: THIS PLUGIN PRINTED WHATEVER IT WAS HANDED ──────────────────
 *
 * The file header promises that "there is NO EXPRESSION in this file that can
 * reach a provider secret key: not to log it, not to hash it, not in an error
 * path". That is true of the gateway interface, which has no value field — and
 * was false of every STRING the plugin interpolated. A scenario's `path`,
 * `publisher` and `webhookEvent` are customer text the schema bounds in length
 * and nothing else; an adapter's `detail` is prose off a customer's page; and a
 * thrown adapter error is whatever its author wrote. All of them went verbatim
 * into a step title, an `errorMessage`, a console line and the log — the same
 * places the rule names. A pay-by-link checkout is routinely addressed by a
 * token in the query string, so `/pay?token=…` landed in every step title of
 * every run, PASSED ones included.
 *
 * ── DERIVED FROM `SECRET_SHAPES`, never a parallel list ─────────────────────
 *
 * The same construction, and the same argument, as `safeExcerpt` in ./email.ts:
 * a hand-written list is how a shape probe came to cover sixteen of twenty-seven
 * declared shapes. Not imported from that file, for the reason {@link GatewayMode}
 * states — a plugin importing a sibling couples two independently promotable
 * types. The prefix is escaped because `-----BEGIN` and `ya29.` both contain
 * regex metacharacters, and an unescaped `.` would match one character of
 * anything.
 *
 * This is a mask for the SHAPES the vocabulary names. It is not a secret
 * detector, and nothing here claims it is: that is why {@link printablePath}
 * also drops the query string outright rather than trusting this to recognise
 * an opaque session token it has no prefix for.
 */
export function maskCredentialShapes(text: string): string {
  let masked = text;
  for (const shape of SECRET_SHAPES) {
    const prefix = shape.prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    masked = masked.replace(
      new RegExp(`${prefix}[A-Za-z0-9_\\-./+=]*`, 'g'),
      `[redacted: ${shape.what}]`,
    );
  }
  return masked;
}

/**
 * A scenario's route as it may be PRINTED: the pathname, masked, and no query.
 *
 * The raw `path` still goes to the checkout adapter untouched — it has to, a
 * query string can be what routes the checkout — but it is never what a reader
 * sees. The query is dropped rather than scrubbed because the values in it are
 * the part that is credential-like and the part no prefix list can recognise: an
 * opaque pay-link token has no `sk_` in front of it. The title says the query
 * was left out, so a reader does not mistake the shortened route for the whole.
 */
export function printablePath(path: string): string {
  const cut = path.search(/[?#]/);
  if (cut === -1) return maskCredentialShapes(path);
  return `${maskCredentialShapes(path.slice(0, cut))}?…`;
}

/**
 * The bound actually used, clamped to the test's own timeout.
 *
 * Without the clamp a five-second test would wait fifteen for its money state
 * and be killed by the harness mid-observation — reported as a timeout rather
 * than as the SUBMITTED_NOT_CONFIRMED it is, which is a worse sentence about a
 * payment than the true one. The floor keeps a nonsense timeout from producing
 * a zero-length observation that could only ever conclude "nothing seen".
 */
export function moneyObservationBoundMs(testTimeoutMs: number): number {
  if (!Number.isFinite(testTimeoutMs) || testTimeoutMs <= 0) {
    return DEFAULT_MONEY_OBSERVATION_MS;
  }
  return Math.max(1_000, Math.min(DEFAULT_MONEY_OBSERVATION_MS, Math.floor(testTimeoutMs)));
}

// ─── The published value, described and never held ──────────────────────────

/**
 * What this plugin is allowed to know about a published test value.
 *
 * THERE IS NO `value` FIELD, and that is the fourth structural guarantee in the
 * file header. A published card number is not a secret — that is what makes it
 * publishable — but a PAN in a step title is a PAN in a log, a report and a
 * Slack channel, and the plugin has no need of one: it hands the ADAPTER an id.
 *
 * `forcesOutcome` is null for an entry from `PROVIDER_CATALOGUE`, which carries
 * IBANs, VAT numbers and bot-protection keys and has no `outcome` column at
 * all. Null therefore means NOT KNOWABLE FROM THE CATALOGUE rather than "forces
 * nothing", and {@link validatePublishedValue} records that as a hole instead of
 * passing it.
 */
export interface PublishedValueDescription {
  readonly id: string;
  /** The publisher, in whichever catalogue's vocabulary holds the entry. */
  readonly publisher: string;
  /** The `test-values.ts` provider, when the entry is joined to one. */
  readonly testValueProvider: TestValueProvider | null;
  readonly forcesOutcome: PaymentOutcome | null;
  readonly testModeOnly: boolean;
  readonly verified: boolean;
  /** The provenance sentence a reader acts on when a test fails oddly. */
  readonly sourceNote: string;
}

/**
 * Describe the value a `catalogueId` names, from either catalogue.
 *
 * BOTH, because the product has two and a reader of a spec cannot be expected
 * to know which: cards and mail sinks live in `TEST_VALUES`
 * (packages/shared/src/test-values.ts) and the rest of the gated surface —
 * IBANs, VAT numbers, sandbox OAuth users, bot-protection test keys — lives in
 * `PROVIDER_CATALOGUE` (packages/shared/src/provider-catalogue.ts). Asking only
 * the first would refuse a perfectly good SEPA scenario.
 *
 * Returns `null` for an id neither knows, which is what `catalogueHasId`'s own
 * doc comment warns about: a spec citing a value that does not exist sends its
 * reader to nothing, and the reader concludes the whole provenance apparatus is
 * decorative.
 *
 * The catalogue half is scanned through `catalogueEntriesFor` over
 * `CATALOGUE_PUBLISHERS` rather than by reaching for a by-id export that module
 * does not have. A `catalogueEntryFor(id)` belongs beside `catalogueHasId` and
 * is named in the handover; a relative import past the package barrel to get at
 * its private array is the "reached by relative path across the workspace
 * boundary" defect, and it would leave the parity guard enforced on a file
 * nobody imports as a package.
 */
export function describePublishedValue(catalogueId: string): PublishedValueDescription | null {
  const entry = TEST_VALUES.find((candidate) => candidate.id === catalogueId);
  if (entry !== undefined) {
    return {
      id: entry.id,
      publisher: entry.provider,
      testValueProvider: entry.provider,
      forcesOutcome: entry.outcome ?? null,
      testModeOnly: entry.testModeOnly,
      verified: entry.verified,
      sourceNote: entry.sourceNote,
    };
  }
  if (!catalogueHasId(catalogueId)) return null;
  for (const publisher of CATALOGUE_PUBLISHERS) {
    const found = catalogueEntriesFor(publisher).find((candidate) => candidate.id === catalogueId);
    if (found === undefined) continue;
    return {
      id: found.id,
      publisher: found.publisher,
      testValueProvider: found.linkedTestValueProvider,
      /*
       * NULL, and it is a gap rather than a zero: `CatalogueEntry` has no
       * `outcome` column, so what this value forces is not knowable from the
       * catalogue and the caller records a hole.
       */
      forcesOutcome: null,
      testModeOnly: found.testModeOnly,
      verified: found.verified,
      sourceNote: found.sourceNote,
    };
  }
  /*
   * `catalogueHasId` said yes and no publisher's entries carry the id, which
   * can only happen if that function and `catalogueEntriesFor` disagree about
   * the catalogue. Reported as "not catalogued" rather than thrown: the caller
   * turns it into UNAVAILABLE with a remedy, where a throw would be a 500 in
   * the worker.
   */
  return null;
}

/**
 * Does any published value from this provider force this outcome?
 *
 * Asked WITHOUT `cardForOutcome`, deliberately. That helper falls back to
 * Stripe when the named provider has no card for the outcome — a good default
 * for a planner that has seen a card field and cannot tell which processor is
 * behind it, and exactly the wrong answer here: the fallback would report that
 * Adyen can force an incorrect-CVC decline because Stripe can, and the
 * distinction between "you named the wrong card" and "this provider publishes
 * no card for this outcome" would collapse into the first, which is the one
 * with a remedy that cannot work.
 */
export function providerCanForce(provider: TestValueProvider, outcome: PaymentOutcome): boolean {
  return testValuesForProvider(provider).some(
    (candidate) => candidate.kind === 'card' && candidate.outcome === outcome,
  );
}

// ─── Refusals, which all happen before anything is driven ───────────────────

export interface PaymentRefusal {
  readonly reason: PaymentRefusalReason;
  /** The reason and its remedy, in one printable sentence. */
  readonly detail: string;
}

export interface PaymentUnavailable {
  readonly reason: PaymentUnavailableReason;
  readonly detail: string;
}

function refuse(reason: PaymentRefusalReason, context: string): PaymentRefusal {
  return { reason, detail: `${context} ${PAYMENT_REFUSAL_REMEDIES[reason]}` };
}

function cannotAsk(reason: PaymentUnavailableReason, context: string): PaymentUnavailable {
  return { reason, detail: `${context} ${PAYMENT_UNAVAILABLE_REMEDIES[reason]}` };
}

/**
 * The run-time half of `z.literal(true)`.
 *
 * Reads `testMode` through an `unknown` view on purpose. The field's TYPE is
 * the literal `true`, so a direct comparison is dead code to the compiler — and
 * {@link runPaymentScenario} is EXPORTED and callable with a cast or a
 * hand-built object, which is exactly the path the adversary suite takes
 * (`{ ...BASE, testMode: false } as unknown as …`). A guard the compiler
 * optimises away on the strength of a type the caller may have lied about is
 * not a guard.
 *
 * Nothing is driven when this returns a refusal, which is the whole point:
 * rule 5 asks for structurally incapable, not guarded-and-then-attempted.
 */
export function refuseLiveMode(scenario: PaymentScenarioSpec): PaymentRefusal | null {
  const declared: unknown = (scenario as { readonly testMode?: unknown }).testMode;
  if (declared === true) return null;
  return refuse(
    'TEST_MODE_NOT_DECLARED',
    'This scenario does not declare `testMode: true`, so nothing about it was driven.',
  );
}

/**
 * Refuse a `path` that does not stay on the environment under test.
 *
 * ── THE DEFECT: A SPEC FIELD THAT IS A URL IN DISGUISE ──────────────────────
 *
 * `paymentScenarioSchema.path` is `z.string().min(1).max(500)` — "the route the
 * checkout starts at" — and nothing makes it a route. `https://169.254.169.254/…`,
 * `//host/pay`, `http://localhost:6379/` and `\\host\pay` all parse, and the
 * checkout adapter is handed `(path, baseUrl)` to resolve with the platform's own
 * URL parser, which obliges every one of them. That is a submission — a form post
 * carrying a published test card — to whichever host the spec names, from a
 * worker that can reach a metadata service. Rule 9 says every outbound host is
 * classified before anything connects, and this plugin imports no network and so
 * has no classifier to call; the honest equivalent here is the strictest one.
 * There is no host a payment test legitimately needs besides the environment's
 * own, so the test is not "is this host public?" but "is this the same origin?".
 *
 * Resolved with the WHATWG parser the adapter will use rather than matched with
 * a regex, because the parser is the authority on what `\\host` and `//host`
 * mean, and a pattern that disagrees with it is the hole.
 *
 * REFUSED and not UNAVAILABLE, and the path is NOT echoed: it is the very text
 * that may carry a host nobody should see in a report, and the reason names the
 * rule rather than the value.
 */
export function refuseOffEnvironmentPath(path: string, baseUrl: string): PaymentRefusal | null {
  let environment: URL;
  let target: URL;
  try {
    environment = new URL(baseUrl);
    target = new URL(path, environment);
  } catch {
    return refuse(
      'PATH_LEAVES_THE_ENVIRONMENT',
      'The scenario’s path, or the environment’s base URL, could not be resolved to a location, ' +
        'so nothing about where it would be driven could be established.',
    );
  }
  if (target.origin === environment.origin && target.origin !== 'null') return null;
  return refuse(
    'PATH_LEAVES_THE_ENVIRONMENT',
    'The scenario’s path does not resolve to the environment’s own origin, so nothing was driven.',
  );
}

/**
 * Refuse a `catalogueId` that is itself a credential or a card number.
 *
 * THE ID IS NEVER ECHOED, not even truncated, and that is deliberate: a refusal
 * message carrying the first eight characters of a live key puts `sk_live_` plus
 * entropy into a log, and a log is the one place a leaked credential is
 * guaranteed to be retained. The refusal names the SHAPE that matched — the
 * argument `admitPublishedValue` makes for its own `detail` — and this function
 * delegates to it rather than keeping a second prefix list beside
 * `SECRET_SHAPES`.
 *
 * The card rule is length-and-digits and NOT Luhn, which is the subtle half: a
 * Luhn-INVALID sixteen-digit run is still somebody's mistyped card number, and
 * refusing only the valid ones would mean the product echoed the mistyped ones
 * into a report. A catalogue id is a dotted name, never a run of digits, so the
 * rule costs nothing legitimate.
 */
export function refuseCredentialShapedId(catalogueId: string): PaymentRefusal | null {
  const compact = catalogueId.replace(/[\s-]/g, '');
  if (/^\d{12,19}$/.test(compact)) {
    return refuse(
      'SPEC_NAMES_A_RAW_CARD_NUMBER',
      `The scenario's catalogueId is a ${compact.length}-digit run, which is the shape of ` +
        `${isLuhnValid(compact) ? 'a card number' : 'a mistyped card number'} rather than of a ` +
        'catalogue id. It is not quoted anywhere in this result.',
    );
  }
  const admission = admitPublishedValue(catalogueId);
  /*
   * BOTH reasons that mean "this is a credential and not a name", not one.
   * `admitPublishedValue` separates a known prefix (SECRET_SHAPED) from a long,
   * mixed-case, unstructured run (OPAQUE_HIGH_ENTROPY) — the shape of a generated
   * key with a prefix this vocabulary does not carry — and refusing only the
   * first let the second fall through to "no published value is catalogued under
   * <the id>", which QUOTES it into a step title. A catalogue id is a dotted
   * name; neither reason can describe one.
   */
  if (
    !admission.admitted &&
    (admission.reason === 'SECRET_SHAPED' || admission.reason === 'OPAQUE_HIGH_ENTROPY')
  ) {
    return refuse(
      'SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE',
      `The scenario's catalogueId ${admission.detail}. It is not quoted anywhere in this result.`,
    );
  }
  return null;
}

export type PublishedValueVerdict =
  | {
      readonly ok: true;
      readonly value: PublishedValueDescription | null;
      readonly holes: readonly NotAsserted[];
    }
  | { readonly ok: false; readonly refusal: PaymentRefusal }
  | { readonly ok: false; readonly unavailable: PaymentUnavailable };

/**
 * The catalogue gate the schema's comment promised and nothing implemented.
 *
 * Four questions, in the order whose answer a reader most needs first:
 *
 *   1. is the id credential- or card-shaped?   → REFUSED, nothing driven
 *   2. does the id name a value at all?        → UNAVAILABLE
 *   3. does that value force the outcome this
 *      scenario asserts?                      → UNAVAILABLE, and the two
 *                                               reasons are kept apart:
 *                                               VALUE_FORCES_A_DIFFERENT_OUTCOME
 *                                               when a right value exists, and
 *                                               TEST_MODE_CANNOT_PRODUCE_IT
 *                                               when this provider publishes
 *                                               none — one remedy is "name the
 *                                               other card" and the other is
 *                                               "no card will do", and sending
 *                                               somebody to do the first when
 *                                               the second is true is a loop
 *                                               they cannot get out of.
 *   4. is the entry verified?                  → a HOLE on an otherwise fine
 *                                               scenario, carried onto the
 *                                               result even when it passes.
 *
 * The third is the one this gate exists for and the one nothing in the product
 * checked. A `DECLINE_INSUFFICIENT_FUNDS` scenario naming the generic-decline
 * card drives a card that declines for the WRONG REASON; the assertion still
 * sees a refusal and the test passes having proved nothing. The catalogue's own
 * header calls that out — "a wrong test card number is a silent payment-test
 * failure" — and this is the first code in the repository to act on it.
 *
 * A scenario with NO `catalogueId` is fine for the kinds
 * `OUTCOME_FORCING_SCENARIOS` does not name; the schema already refuses it for
 * the ones it does, and the branch below keeps that refusal reachable for a
 * hand-built scenario rather than trusting the schema to have run.
 */
export function validatePublishedValue(scenario: PaymentScenarioSpec): PublishedValueVerdict {
  const id = scenario.catalogueId;
  if (id === null) {
    if (OUTCOME_FORCING_SCENARIOS.includes(scenario.kind)) {
      return {
        ok: false,
        unavailable: cannotAsk(
          'NO_PUBLISHED_TEST_VALUE',
          `A ${scenario.kind} scenario needs a published value to force its outcome and names none.`,
        ),
      };
    }
    return { ok: true, value: null, holes: [] };
  }

  const shaped = refuseCredentialShapedId(id);
  if (shaped !== null) return { ok: false, refusal: shaped };

  const described = describePublishedValue(id);
  if (described === null) {
    return {
      ok: false,
      unavailable: cannotAsk(
        'NO_PUBLISHED_TEST_VALUE',
        `No published test value is catalogued under "${maskCredentialShapes(id)}".`,
      ),
    };
  }

  const wanted = FORCED_OUTCOME_FOR_SCENARIO[scenario.kind];
  const holes: NotAsserted[] = [];

  if (wanted !== null && described.forcesOutcome === null) {
    /*
     * A HOLE AND NOT A PASS. The entry is real and its catalogue has no
     * `outcome` column, so whether it forces what this scenario asserts is
     * UNKNOWN — and an unknown treated as agreement is exactly how the wrong
     * value gets driven. Recorded in the keystone's vocabulary and carried onto
     * the result even when the scenario goes on to pass.
     */
    holes.push({
      assertion:
        `that the published value "${described.id}" forces ${wanted} — its catalogue records no ` +
        'outcome for any entry, so the match could not be checked',
      reason: 'NOT_IMPLEMENTED',
    });
  } else if (wanted !== null && described.forcesOutcome !== wanted) {
    const provider = described.testValueProvider;
    const anotherWouldDo = provider !== null && providerCanForce(provider, wanted);
    return {
      ok: false,
      unavailable: cannotAsk(
        anotherWouldDo ? 'VALUE_FORCES_A_DIFFERENT_OUTCOME' : 'TEST_MODE_CANNOT_PRODUCE_IT',
        `A ${scenario.kind} scenario needs a value that forces ${wanted}, and "${described.id}" ` +
          `forces ${described.forcesOutcome}.`,
      ),
    };
  }

  if (!described.verified) {
    /*
     * The catalogue's own honesty, carried through rather than flattened. An
     * entry recalled from a provider's documentation is "very likely right and
     * the first thing to check when a payment test fails for a reason that
     * makes no sense", and a result that did not say so would let a green row
     * stand on a value nobody confirmed.
     */
    holes.push({
      assertion:
        `that "${described.id}" still behaves as catalogued — the entry is unverified ` +
        `(${described.sourceNote})`,
      reason: 'NOT_IMPLEMENTED',
    });
  }

  return { ok: true, value: described, holes };
}

export type GatewayVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: PaymentRefusal }
  | { readonly ok: false; readonly unavailable: PaymentUnavailable };

/**
 * Refuse a gateway that is not demonstrably in test mode.
 *
 * Returns a refusal for LIVE **and for UNKNOWN**, and the second is the one
 * that matters. `mode !== 'TEST'` becoming `mode === 'LIVE'` reads as a
 * tightening and is the single change in this file that could let an
 * environment nobody looked at take a real payment. Absent is not "probably
 * test", and no install fixes having already charged somebody.
 *
 * An absent integration is UNAVAILABLE rather than REFUSED: there is nothing to
 * refuse, the customer has simply not connected a sandbox, and the remedy is
 * theirs to apply.
 */
export async function resolveGateway(
  scenario: PaymentScenarioSpec,
  gateways: GatewayModeSource,
): Promise<GatewayVerdict> {
  const mode = await gateways.describe(scenario.publisher);
  if (!mode.present) {
    return {
      ok: false,
      unavailable: cannotAsk(
        'NO_GATEWAY_INTEGRATION',
        `No gateway integration for "${maskCredentialShapes(scenario.publisher)}" exists on this environment.`,
      ),
    };
  }
  if (mode.mode === 'TEST') return { ok: true };
  return {
    ok: false,
    refusal: refuse(
      mode.mode === 'LIVE' ? 'LIVE_MODE_GATEWAY' : 'GATEWAY_MODE_UNESTABLISHED',
      `The "${maskCredentialShapes(scenario.publisher)}" gateway reports mode ${mode.mode}.`,
    ),
  };
}

// ─── One scenario ───────────────────────────────────────────────────────────

export interface MoneyMismatch {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ScenarioResult {
  readonly outcome: MoneyPathOutcome;
  /** Set on REFUSED. Null otherwise. */
  readonly refusalReason: PaymentRefusalReason | null;
  /** Set on UNAVAILABLE. Null otherwise. */
  readonly unavailableReason: PaymentUnavailableReason | null;
  /** Printable verbatim. */
  readonly detail: string;
  readonly notAsserted: readonly NotAsserted[];
  /** How long the observation bound actually consumed, for the disclosure. */
  readonly observedForMs: number;
}

function refusedResult(refusal: PaymentRefusal): ScenarioResult {
  return {
    outcome: 'REFUSED',
    refusalReason: refusal.reason,
    unavailableReason: null,
    detail: refusal.detail,
    notAsserted: [
      {
        assertion: 'anything at all about the money path — QAAI refused to drive it',
        reason: PAYMENT_REFUSAL_AS_UNASSERTED[refusal.reason],
      },
    ],
    observedForMs: 0,
  };
}

function unavailableResult(
  unavailable: PaymentUnavailable,
  extraHoles: readonly NotAsserted[] = [],
): ScenarioResult {
  return {
    outcome: 'UNAVAILABLE',
    refusalReason: null,
    unavailableReason: unavailable.reason,
    detail: unavailable.detail,
    notAsserted: [
      {
        assertion: 'that the money moved as the scenario says it should',
        reason: PAYMENT_UNAVAILABLE_AS_UNASSERTED[unavailable.reason],
      },
      ...extraHoles,
    ],
    observedForMs: 0,
  };
}

/**
 * Compare what the application says about the money to what the scenario says.
 *
 * Returns EVERY mismatch rather than the first: "the state is wrong" and "the
 * amount is wrong" are two defects, and fixing one does not reveal the other if
 * only one was reported.
 *
 * The amount is compared only when the application reported one. A null
 * `chargedMinor` beside a terminal state is a hole, not a zero — rule 11 — and
 * the caller records it as such rather than comparing it against the expected
 * total as if the application had said "nothing was taken".
 */
export function compareMoney(
  scenario: PaymentScenarioSpec,
  acceptable: readonly [MoneyState, ...MoneyState[]],
  observed: ObservedMoney,
): MoneyMismatch[] {
  const problems: MoneyMismatch[] = [];
  const primary = acceptable[0];

  if (!acceptable.includes(observed.state)) {
    problems.push({
      field: 'state',
      expected: acceptable.length === 1 ? primary : `one of ${acceptable.join(' or ')}`,
      actual: observed.state,
    });
  }

  const expectedMinor = expectedChargeMinor(scenario, primary);
  if (expectedMinor !== null && observed.chargedMinor !== null) {
    if (observed.chargedMinor !== expectedMinor) {
      problems.push({
        field: 'amount',
        expected: `${expectedMinor} minor units`,
        actual: `${observed.chargedMinor} minor units`,
      });
    }
    if (observed.currency !== null && observed.currency !== scenario.currency) {
      problems.push({ field: 'currency', expected: scenario.currency, actual: observed.currency });
    }
  }

  /*
   * ONE CHARGE, ALWAYS — not only for DUPLICATE_SUBMISSION. A second charge
   * from a single submission is the same defect seen from the other side, and
   * checking it only where it is named would let a retry path double-charge on
   * every other scenario in silence.
   */
  const allowed = chargesAllowedFor(primary);
  if (observed.chargeCount !== allowed) {
    problems.push({
      field: 'chargeCount',
      expected: `exactly ${allowed}`,
      actual: String(observed.chargeCount),
    });
  }

  return problems;
}

/**
 * The amount the application should say was taken, for a given terminal state.
 *
 * Null where no amount is asserted at all: a decline, a client-side rejection
 * and an abandoned challenge must take NOTHING, and the charge-count check is
 * what proves that. Asserting an amount of zero on them would instead be
 * asserting that the application REPORTED a zero charge, which is a different
 * and wrong claim about an application that correctly reports nothing.
 */
export function expectedChargeMinor(
  scenario: PaymentScenarioSpec,
  state: MoneyState,
): number | null {
  switch (state) {
    case 'PARTIALLY_CAPTURED':
    case 'PARTIALLY_REFUNDED':
      /*
       * The partial amount, which `paymentScenarioSchema` guarantees is present
       * for PARTIAL_CAPTURE and REFUND_PARTIAL and refuses above `amountMinor`.
       * The fallback is the full amount rather than a throw: this function is
       * reachable with a hand-built scenario, and a crash in the runner is a
       * failed test with a stack trace where a comparison against the full
       * total is at least a statement about money.
       */
      return scenario.partialAmountMinor ?? scenario.amountMinor;
    case 'AUTHORISED':
    case 'CAPTURED':
    case 'REFUNDED':
      return scenario.amountMinor;
    case 'NONE':
    case 'DECLINED':
    case 'REJECTED_CLIENT_SIDE':
    case 'CHALLENGE_ABANDONED':
      return null;
  }
}

/**
 * Drive one scenario and assert what the money did.
 *
 * THE ORDER IS THE DESIGN. Every refusal happens before the checkout is
 * submitted, because a submission is itself a write against the customer's
 * sandbox:
 *
 *   1. is `testMode` the literal `true`?              → REFUSED
 *   2. does the named value exist, and force the
 *      outcome this scenario asserts?                → REFUSED or UNAVAILABLE
 *   3. is the gateway present and in TEST mode?       → REFUSED or UNAVAILABLE
 *   4. can the money be read back at all?             → UNAVAILABLE
 *   5. can the webhook be observed, when the
 *      scenario needs one?                           → UNAVAILABLE
 *   6. does the checkout come up, and is a bot
 *      defence in front of it?                       → UNAVAILABLE
 *   7. submit, act, and read the money back           → ASSERTED,
 *                                                       WRONG_MONEY_STATE or
 *                                                       SUBMITTED_NOT_CONFIRMED
 *
 * Moving 7 ahead of any of 1-6 turns an environment gap into
 * SUBMITTED_NOT_CONFIRMED, which is FAILED — QAAI reporting a defect in the
 * customer's payment code because this image has no adapter — and does it
 * having already submitted a payment. Step 4 is the one a reader is most likely
 * to think is in the wrong place: it is there because a charge nobody can
 * verify is a write with no assertion attached, and the honest thing to do with
 * one is not to make it.
 */
export async function runPaymentScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  options: { readonly observationBoundMs?: number } = {},
): Promise<ScenarioResult> {
  const clock = deps.clock ?? realPaymentsClock;
  const boundMs = options.observationBoundMs ?? DEFAULT_MONEY_OBSERVATION_MS;

  // 1. Test mode, as a run-time fact and not as a type.
  const liveMode = refuseLiveMode(scenario);
  if (liveMode !== null) return refusedResult(liveMode);

  // 1b. The route stays on the environment under test. Before anything is
  //     looked up, because nothing else here may be asked about a host the
  //     environment never named.
  const offEnvironment = refuseOffEnvironmentPath(scenario.path, baseUrl);
  if (offEnvironment !== null) return refusedResult(offEnvironment);

  // 2. The published value: shape, existence, and the outcome it forces.
  const value = validatePublishedValue(scenario);
  if (!value.ok) {
    return 'refusal' in value ? refusedResult(value.refusal) : unavailableResult(value.unavailable);
  }
  const declaredHoles: NotAsserted[] = [...scenario.notAsserted, ...value.holes];

  // 3. The gateway — present, and in test mode.
  const gateway = await resolveGateway(scenario, deps.gateways);
  if (!gateway.ok) {
    return 'refusal' in gateway
      ? refusedResult(gateway.refusal)
      : unavailableResult(gateway.unavailable, declaredHoles);
  }

  // 4. The money, readable, BEFORE anything is charged.
  const readable = await deps.money.available();
  if (!readable.ok) {
    return unavailableResult(
      cannotAsk(
        readable.reason,
        "The application's own money state cannot be read on this run, so no payment was " +
          'submitted.',
      ),
      declaredHoles,
    );
  }

  // 5. The webhook observer, for the one scenario kind that needs one.
  if (scenario.kind === 'WEBHOOK_TRANSITION') {
    const seeing = await deps.webhooks.available();
    if (!seeing.ok) {
      return unavailableResult(
        cannotAsk(seeing.reason, 'No provider transition could be observed on this run.'),
        declaredHoles,
      );
    }
  }

  // 6. The checkout, and the bot defence that may be in front of it.
  const arrival = await deps.checkout.arrive(scenario.path, baseUrl);
  if (!arrival.ok) {
    /*
     * The adapter's reason, with OUR remedy appended. The `detail` is the
     * adapter's own prose and is quoted as data; the remedy is a product
     * decision and comes from the table, so an adapter cannot talk a reader
     * into working around a bot defence.
     */
    return unavailableResult(
      cannotAsk(
        arrival.reason,
        `"${printablePath(scenario.path)}" could not be driven. ${adapterDetail(arrival.detail)}`,
      ),
      declaredHoles,
    );
  }

  // 7. Drive it. Every arm reads the money back; none of them infers it.
  return driveScenario(scenario, baseUrl, deps, { boundMs, clock, holes: declaredHoles });
}

interface DriveContext {
  readonly boundMs: number;
  readonly clock: PaymentsClock;
  readonly holes: readonly NotAsserted[];
}

/**
 * The scenario-kind switch, which is EXHAUSTIVE on purpose.
 *
 * No `default`. The function's return type does not include `undefined`, so a
 * fifteenth `PaymentScenarioKind` with no branch is a compile error in this
 * file — "function lacks ending return statement" — at build time. A `default`
 * here would instead give a new kind the behaviour of whichever arm somebody
 * thought was closest, which on a money path is how a refund scenario comes to
 * be executed as an authorisation.
 *
 * The arms are grouped by what they have to DO rather than by name: the four
 * declines are one arm because the drive is identical and only the accepted
 * state differs, while the 3-D Secure pair, the two refunds, the two captures
 * and the client-side rejection each need something after the submission that
 * the others do not.
 */
async function driveScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  switch (scenario.kind) {
    case 'AUTHORISE_AND_CAPTURE':
    case 'DECLINE_GENERIC':
    case 'DECLINE_INSUFFICIENT_FUNDS':
    case 'DECLINE_EXPIRED_CARD':
    case 'DECLINE_INCORRECT_CVC':
      return runSubmitAndReadScenario(scenario, baseUrl, deps, drive, 1);

    case 'DUPLICATE_SUBMISSION':
      /*
       * TWO submissions in ONE request, so the adapter can double-submit the
       * way a user's double-click does: inside one page lifetime, against one
       * idempotency key if the application sets one. Two sequential calls to
       * `submit` would be two separate checkouts and would prove nothing about
       * the defect.
       */
      return runSubmitAndReadScenario(scenario, baseUrl, deps, drive, 2);

    case 'INVALID_CARD_NUMBER':
      return runClientRejectionScenario(scenario, baseUrl, deps, drive);

    case 'AUTHORISE_THEN_DELAYED_CAPTURE':
    case 'PARTIAL_CAPTURE':
      return runCaptureScenario(scenario, baseUrl, deps, drive);

    case 'THREE_DS_CHALLENGE_PASS':
    case 'THREE_DS_CHALLENGE_FAIL':
      return runChallengeScenario(scenario, baseUrl, deps, drive);

    case 'REFUND_FULL':
    case 'REFUND_PARTIAL':
      return runRefundScenario(scenario, baseUrl, deps, drive);

    case 'WEBHOOK_TRANSITION':
      return runWebhookScenario(scenario, baseUrl, deps, drive);
  }
}

/** Submit, then read the money back. The shape every other arm builds on. */
async function runSubmitAndReadScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
  submissions: number,
): Promise<ScenarioResult> {
  const submitted = await submit(scenario, baseUrl, deps, drive, submissions);
  if (!submitted.ok) return submitted.result;
  return readMoneyBack(scenario, deps, drive, submitted.submission, '');
}

/**
 * Submit a value the form should refuse, and prove it took nothing.
 *
 * TWO assertions, and the second is the one that matters. A form that accepts a
 * Luhn-invalid number and sends it to the provider has a defect — the
 * client-side validation path this scenario is named for — and it is reported
 * as a mismatch rather than as an unavailability, because it is a finding the
 * run established. But a form that failed to validate and then took the money
 * is a far worse defect, so the money is read back either way and `chargeCount`
 * decides the verdict.
 */
async function runClientRejectionScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  const submitted = await submit(scenario, baseUrl, deps, drive, 1);
  if (!submitted.ok) return submitted.result;

  const note = submitted.submission.rejectedClientSide
    ? ' The form refused the value before any network call, as it should.'
    : ' The form ACCEPTED the value and submitted it to the provider, so the client-side ' +
      'validation this scenario is named for did not happen.';

  const extra: MoneyMismatch[] = submitted.submission.rejectedClientSide
    ? []
    : [
        {
          field: 'clientValidation',
          expected: 'the form refuses the value before any network call',
          actual: 'the form accepted it and submitted it to the provider',
        },
      ];

  return readMoneyBack(scenario, deps, drive, submitted.submission, note, extra);
}

/** Submit, perform the application's own capture, then read the money back. */
async function runCaptureScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  const submitted = await submit(scenario, baseUrl, deps, drive, 1);
  if (!submitted.ok) return submitted.result;

  const amount = scenario.kind === 'PARTIAL_CAPTURE' ? scenario.partialAmountMinor : null;
  const captured = await deps.checkout.merchantAction('CAPTURE', amount);
  if (captured === null) {
    /*
     * UNAVAILABLE, and the outstanding authorisation is DISCLOSED. The payment
     * was submitted and this run cannot capture it, so the honest result is
     * "not measured" PLUS the fact that an authorisation may be sitting in the
     * customer's sandbox — a reader who is not told that will not go and look.
     */
    return unavailableResult(
      cannotAsk(
        'MERCHANT_ACTION_UNAVAILABLE',
        'The payment was authorised and this run has no capture action to drive, so an ' +
          "authorisation may be outstanding in the customer's sandbox.",
      ),
      drive.holes,
    );
  }
  /*
   * An adapter that HAS a capture action and could not complete it is a
   * statement about the application — the window in which an order is lost — so
   * the money is still read back and the state decides the verdict.
   */
  return readMoneyBack(
    scenario,
    deps,
    drive,
    submitted.submission,
    captured.performed
      ? ` Captured through the application's own action: ${adapterDetail(captured.detail)}`
      : ` The application's capture action did not complete: ${adapterDetail(captured.detail)}`,
  );
}

/**
 * Submit, resolve the 3-D Secure challenge, then read the money back.
 *
 * A scenario that expects a challenge and is NOT presented one is a FINDING
 * rather than an unavailability: an application that skipped 3DS on a value the
 * provider flags for it has a defect the customer must know about, and filing
 * that as "we could not measure" would hide the one result this scenario exists
 * to produce. So the money is still read back and the missing challenge is
 * named in the sentence.
 */
async function runChallengeScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  const submitted = await submit(scenario, baseUrl, deps, drive, 1);
  if (!submitted.ok) return submitted.result;

  const abandon = scenario.kind === 'THREE_DS_CHALLENGE_FAIL';
  if (!submitted.submission.challengePresented) {
    return readMoneyBack(
      scenario,
      deps,
      drive,
      submitted.submission,
      ' NO 3-D Secure challenge was presented, on a value the provider flags for one — so the ' +
        'application either bypassed the challenge or never requested it.',
      [
        {
          field: 'threeDsChallenge',
          expected: 'a 3-D Secure challenge is presented',
          actual: 'none was presented',
        },
      ],
    );
  }

  const resolved = await deps.checkout.resolveChallenge(abandon ? 'ABANDON' : 'COMPLETE');
  if (resolved === null) {
    return unavailableResult(
      cannotAsk(
        'MERCHANT_ACTION_UNAVAILABLE',
        'A 3-D Secure challenge was presented and this adapter cannot drive it, so the challenge ' +
          'was left unresolved.',
      ),
      drive.holes,
    );
  }
  /*
   * An ABANDON that reports `completed: true` is the adapter contradicting its
   * own instruction, and reading the money back after it would describe a state
   * nobody asked for — a PASSED abandonment test that actually completed the
   * challenge. Reported as not measured rather than as a verdict.
   */
  if (abandon === resolved.completed) {
    return unavailableResult(
      cannotAsk(
        'MERCHANT_ACTION_UNAVAILABLE',
        `The adapter was asked to ${abandon ? 'ABANDON' : 'COMPLETE'} the 3-D Secure challenge ` +
          `and reports that it did the opposite, so this scenario drove something other than what ` +
          `it asserts. ${adapterDetail(resolved.detail)}`,
      ),
      drive.holes,
    );
  }
  return readMoneyBack(
    scenario,
    deps,
    drive,
    submitted.submission,
    abandon
      ? ` The 3-D Secure challenge was ABANDONED: ${adapterDetail(resolved.detail)}`
      : ` The 3-D Secure challenge was completed: ${adapterDetail(resolved.detail)}`,
  );
}

/** Submit, refund through the application's own action, then read the money back. */
async function runRefundScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  const submitted = await submit(scenario, baseUrl, deps, drive, 1);
  if (!submitted.ok) return submitted.result;

  const amount = scenario.kind === 'REFUND_PARTIAL' ? scenario.partialAmountMinor : null;
  const refunded = await deps.checkout.merchantAction('REFUND', amount);
  if (refunded === null) {
    return unavailableResult(
      cannotAsk(
        'MERCHANT_ACTION_UNAVAILABLE',
        'The payment was taken and this run has no refund action to drive, so a test-mode charge ' +
          "is outstanding in the customer's sandbox.",
      ),
      drive.holes,
    );
  }
  return readMoneyBack(
    scenario,
    deps,
    drive,
    submitted.submission,
    refunded.performed
      ? ` Refunded through the application's own action: ${adapterDetail(refunded.detail)}`
      : ` The application's refund action did not complete: ${adapterDetail(refunded.detail)}`,
  );
}

/**
 * Submit, wait for the provider event, and assert that the application APPLIED
 * it.
 *
 * ── WHY THIS ARM ASSERTS TWO THINGS AND NOT THREE ───────────────────────────
 *
 * The webhook is the half of a payment integration that breaks silently: the
 * charge succeeds, the application never hears about it, and the order sits
 * unpaid while the customer has been billed. So the two assertions are that the
 * named event ARRIVED and that the application APPLIED it — the second being
 * the one a page assertion can never make.
 *
 * WHICH terminal money state is correct afterwards is NOT asserted, and the
 * hole is recorded rather than filled with a guess: `ACCEPTABLE_MONEY_STATES`
 * is null for this kind because only the customer's own integration knows what
 * `charge.refunded` should leave behind, and this file inventing an answer would
 * be asserting against a design it has never seen.
 *
 * Neither is the RECEIVER's own correctness — constant-time signature
 * verification, replay rejection, resolving the org from our own records rather
 * than from the payload. Those are properties of the endpoint that receives the
 * webhook, none of them is observable from a test run, and all three are
 * recorded as a named hole so that a green row cannot read as coverage of them.
 */
async function runWebhookScenario(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
): Promise<ScenarioResult> {
  const event = scenario.webhookEvent;
  if (event === null) {
    /*
     * The schema refuses this at parse time; kept reachable for a hand-built
     * scenario, for the reason stated on `validatePublishedValue`.
     */
    return unavailableResult(
      cannotAsk(
        'NO_WEBHOOK_OBSERVER',
        'A webhook-transition scenario names no event to wait for, so it would pass the moment ' +
          'the page did.',
      ),
      drive.holes,
    );
  }

  const submitted = await submit(scenario, baseUrl, deps, drive, 1);
  if (!submitted.ok) return submitted.result;

  const holes: NotAsserted[] = [
    ...drive.holes,
    {
      assertion:
        'which terminal money state is correct after this event — only the customer’s own ' +
        'integration knows, so it is not asserted rather than guessed',
      reason: 'NOT_IMPLEMENTED',
    },
    {
      assertion:
        'that the receiving endpoint verified the provider’s signature in constant time, ' +
        'rejected a replay, and resolved the org from its own records rather than from the ' +
        'payload — none of which is observable from a test run',
      reason: 'NOT_IMPLEMENTED',
    },
  ];

  const startedAt = drive.clock.now();
  const observed = await deps.webhooks.waitFor(event, drive.boundMs);
  const observedForMs = Math.max(0, drive.clock.now() - startedAt);

  if (observed === null) {
    return {
      outcome: 'SUBMITTED_NOT_CONFIRMED',
      refusalReason: null,
      unavailableReason: null,
      detail: submittedNotConfirmedWhy(scenario, drive.boundMs, observedForMs, event),
      notAsserted: holes,
      observedForMs,
    };
  }

  if (!observed.appliedByApplication) {
    return {
      /*
       * WRONG_MONEY_STATE and emphatically not SUBMITTED_NOT_CONFIRMED. The
       * event ARRIVED and the application did nothing with it — that is the
       * order sitting unpaid, proved, and it is the defect this scenario was
       * written for. Filing it under the bounded "we could not confirm"
       * sentence would understate a finding the run established.
       */
      outcome: 'WRONG_MONEY_STATE',
      refusalReason: null,
      unavailableReason: null,
      detail:
        `The provider event "${adapterDetail(observed.event)}" arrived ${observedForMs}ms after ` +
        `the payment and the application did NOT apply it: ${adapterDetail(observed.detail)}. ` +
        `The charge happened and the ` +
        'application does not know, which is an order sitting unpaid against a customer who has ' +
        'already been billed.',
      notAsserted: holes,
      observedForMs,
    };
  }

  return {
    outcome: 'ASSERTED',
    refusalReason: null,
    unavailableReason: null,
    detail:
      `The provider event "${adapterDetail(observed.event)}" arrived ${observedForMs}ms after ` +
      `the payment and the application applied it: ${adapterDetail(observed.detail)}.`,
    notAsserted: holes,
    observedForMs,
  };
}

/** Submit the checkout, turning a failure to submit into the right non-verdict. */
async function submit(
  scenario: PaymentScenarioSpec,
  baseUrl: string,
  deps: PaymentsDeps,
  drive: DriveContext,
  submissions: number,
): Promise<
  | { readonly ok: true; readonly submission: CheckoutSubmission }
  | { readonly ok: false; readonly result: ScenarioResult }
> {
  const request: CheckoutRequest = {
    path: scenario.path,
    catalogueId: scenario.catalogueId,
    amountMinor: scenario.amountMinor,
    currency: scenario.currency,
    submissions,
  };
  const submission = await deps.checkout.submit(request, baseUrl);
  if (submission.submitted) return { ok: true, submission };
  /*
   * UNAVAILABLE and NOT SUBMITTED_NOT_CONFIRMED. Nothing was submitted, so
   * "submitted" would be a lie in the name — and the status would be FAILED,
   * blaming the customer's payment code for a form this run could not drive.
   * The same rule, and the same reason, as a failed trigger in ./push.ts.
   */
  return {
    ok: false,
    result: unavailableResult(
      cannotAsk(
        'CHECKOUT_UNREACHABLE',
        `Nothing was submitted at "${printablePath(scenario.path)}". ${adapterDetail(submission.detail)}`,
      ),
      /*
       * `drive.holes` AND NOT `scenario.notAsserted`. The first is the second
       * plus whatever the published-value check already recorded — that the
       * named entry is unverified, that its catalogue records no outcome — and
       * dropping those on the one path where the checkout would not open is how
       * a hole comes to exist on nine results and vanish on the tenth.
       */
      drive.holes,
    ),
  };
}

/**
 * Read the application's money state back and decide the verdict.
 *
 * This is the function that makes a PAYMENTS result worth more than a
 * screenshot, and the three branches are the whole honesty of the type:
 *
 *   the source could not read  → SUBMITTED_NOT_CONFIRMED. We submitted a
 *                                payment and do not know what became of it.
 *   it read, and it is wrong   → WRONG_MONEY_STATE, with every mismatch.
 *   it read, and it matches    → ASSERTED, with the amount named.
 *
 * `null` from the source is NEVER read as `state: 'NONE'`. An adapter that
 * could not look and an application with no charge are different facts, and
 * conflating them would turn every adapter outage into a passing decline test.
 */
async function readMoneyBack(
  scenario: PaymentScenarioSpec,
  deps: PaymentsDeps,
  drive: DriveContext,
  submission: CheckoutSubmission,
  note: string,
  extraProblems: readonly MoneyMismatch[] = [],
): Promise<ScenarioResult> {
  const acceptable = ACCEPTABLE_MONEY_STATES[scenario.kind];
  const holes: NotAsserted[] = [...drive.holes];

  if (acceptable === null) {
    /*
     * Only WEBHOOK_TRANSITION, which has its own arm and never reaches here.
     * Reported rather than thrown: a crash in the runner is a failed test with
     * a stack trace, and this says what is actually known.
     */
    return unavailableResult(
      cannotAsk(
        'NO_MONEY_STATE_SOURCE',
        `A ${scenario.kind} scenario asserts no terminal money state, so none was compared.`,
      ),
      holes,
    );
  }

  const startedAt = drive.clock.now();
  let observed: ObservedMoney | null;
  try {
    observed = await deps.money.observe(submission.reference, drive.boundMs);
  } catch (err) {
    observed = null;
    /*
     * A source that threw told us nothing about the money, which is the same
     * state as one that returned null — and it is recorded with the thrown
     * message so a reader can tell an outage from an empty read.
     */
    holes.push({
      assertion: `that the money state could be read at all (${maskCredentialShapes(errorText(err)).slice(0, 200)})`,
      reason: 'CAPABILITY_ABSENT',
    });
  }
  const observedForMs = Math.max(0, drive.clock.now() - startedAt);

  if (observed === null) {
    return {
      outcome: 'SUBMITTED_NOT_CONFIRMED',
      refusalReason: null,
      unavailableReason: null,
      detail: `${submittedNotConfirmedWhy(scenario, drive.boundMs, observedForMs, null)}${note}`,
      notAsserted: holes,
      observedForMs,
    };
  }

  /*
   * A terminal state with no amount beside it is a HOLE and not a zero. The
   * application says money moved and will not say how much, which is exactly
   * the reading rule 11 forbids turning into a number.
   */
  if (expectedChargeMinor(scenario, acceptable[0]) !== null && observed.chargedMinor === null) {
    holes.push({
      assertion:
        'the AMOUNT the application says was taken — it reported a state and no amount, and a ' +
        'missing amount is not a zero',
      reason: 'SURFACE_UNREACHED',
    });
  }

  const problems = [...extraProblems, ...compareMoney(scenario, acceptable, observed)];
  if (problems.length > 0) {
    return {
      outcome: 'WRONG_MONEY_STATE',
      refusalReason: null,
      unavailableReason: null,
      detail:
        `The application's own money state was read ${observedForMs}ms after "${printablePath(scenario.path)}" ` +
        `and does not match a ${scenario.kind} scenario: ` +
        `${problems.map((p) => `${p.field} expected ${p.expected}, got ${p.actual}`).join('; ')}.${note}`,
      notAsserted: holes,
      observedForMs,
    };
  }

  const amount = expectedChargeMinor(scenario, acceptable[0]);
  return {
    outcome: 'ASSERTED',
    refusalReason: null,
    unavailableReason: null,
    detail:
      `${scenario.kind} at "${printablePath(scenario.path)}": the application reports ${observed.state}` +
      `${amount === null ? ' and no charge' : ` of ${amount} ${scenario.currency} minor units`}` +
      ` with ${observed.chargeCount} charge(s), read back ${observedForMs}ms after the ` +
      `submission.${note}`,
    notAsserted: holes,
    observedForMs,
  };
}

/**
 * The sentence SUBMITTED_NOT_CONFIRMED is reported with.
 *
 * Exported so the test can pin its exact content, because the honesty of this
 * whole type lives in it. It states what was established ("we submitted a
 * payment"), what was not ("nothing confirmed what became of it"), and — the
 * part an obvious implementation leaves out — that the two together mean MONEY
 * MAY HAVE MOVED AND THE APPLICATION DOES NOT KNOW, which is a sentence
 * somebody has to go and act on rather than a red square.
 */
export function submittedNotConfirmedWhy(
  scenario: PaymentScenarioSpec,
  boundMs: number,
  observedForMs: number,
  event: string | null,
): string {
  const watched =
    event === null
      ? `watched the application's own money state for ${observedForMs}ms`
      : `watched for the provider event "${maskCredentialShapes(event)}" for ${observedForMs}ms`;
  return (
    `SUBMITTED_NOT_CONFIRMED, which is NOT a pass: QAAI submitted a ${scenario.kind} payment at ` +
    `"${printablePath(scenario.path)}" and ${watched} against the ${boundMs}ms bound, and nothing confirmed what ` +
    'became of it. This establishes that nothing was SEEN by the one observer attached to this ' +
    'run — it does NOT establish that no money moved, and on a payment those are very different ' +
    'facts: a charge may exist in the sandbox that the application has no record of. Check the ' +
    'provider dashboard for this attempt before treating it as a non-event.'
  );
}

// ─── Step recording ─────────────────────────────────────────────────────────

class StepRecorder {
  readonly steps: StepResult[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  /**
   * Record one scenario.
   *
   * The status is DERIVED from {@link moneyPathStatus} rather than re-decided
   * here. A second mapping is how a step comes to say SKIPPED under a FAILED
   * test — which is how a reader comes to believe the money path was merely
   * unmeasured. REFUSED and UNAVAILABLE are SKIPPED steps because `error` on a
   * StepResult means "this failed" and neither of them did.
   */
  record(scenario: PaymentScenarioSpec, result: ScenarioResult, startedAtMs: number): void {
    const testStatus = moneyPathStatus(result.outcome);
    const status: StepResult['status'] =
      testStatus === 'PASSED' ? 'PASSED' : testStatus === 'FAILED' ? 'FAILED' : 'SKIPPED';
    /*
     * The route is WITHHELD from the title of the one result whose whole reason is
     * that the route names a host the environment did not: that text is the
     * destination, and the refusal exists so it is neither driven nor reported.
     */
    const route =
      result.refusalReason === 'PATH_LEAVES_THE_ENVIRONMENT'
        ? '(route withheld)'
        : printablePath(scenario.path);
    const title =
      `${scenario.kind} ${route} — ${MONEY_PATH_OUTCOME_LABELS[result.outcome]}` +
      `${result.outcome === MONEY_PATH_PASSING_OUTCOME ? '' : `: ${result.detail}`}`;

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

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Run a PAYMENTS test: every scenario in the spec, in order.
 *
 * The status rule, which is {@link moneyPathStatus} applied across a list:
 *
 *   · any WRONG_MONEY_STATE or
 *     SUBMITTED_NOT_CONFIRMED  → FAILED.
 *   · all ASSERTED             → PASSED.
 *   · no ASSERTED at all       → SKIPPED, NOT_RUN, with every refusal and every
 *                                remedy. A result made only of REFUSEDs and
 *                                UNAVAILABLEs is not a pass; it is a money path
 *                                nobody tested, and saying so is the only
 *                                honest outcome available.
 *   · a mix                    → PASSED, with every refusal and every
 *                                unmeasured scenario disclosed on the result
 *                                and in its own step.
 *
 * The refused count is reported SEPARATELY from the unmeasured count, which is
 * rule 7's "recorded as refused": a reader must be able to see that QAAI
 * declined to drive something without parsing ten remedy sentences to work out
 * which of them were ours by choice.
 */
export async function runPaymentsTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: PaymentsTestSpec,
  deps: PaymentsDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const recorder = new StepRecorder(ctx, test.id);
  const notes: ConsoleEntry[] = [];
  const observationBoundMs = moneyObservationBoundMs(test.timeoutMs);

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  const results: ScenarioResult[] = [];
  for (const scenario of spec.scenarios) {
    if (ctx.signal.aborted) break;
    const stepStartedAt = Date.now();
    let result: ScenarioResult;
    try {
      result = await runPaymentScenario(scenario, ctx.baseUrl, deps, { observationBoundMs });
    } catch (err) {
      /*
       * A surface that threw told us nothing about the money, so this is
       * UNAVAILABLE and not SUBMITTED_NOT_CONFIRMED — we do not know that
       * anything was submitted. The same rule as a failed submission, for the
       * same reason.
       */
      result = unavailableResult(
        cannotAsk(
          'NO_CHECKOUT_SURFACE',
          `A payment surface failed while checking this: ${maskCredentialShapes(errorText(err)).slice(0, 300)}.`,
        ),
        scenario.notAsserted,
      );
    }
    results.push(result);
    recorder.record(scenario, result, stepStartedAt);
  }

  /*
   * FAILING rather than a list of outcome names, so a sixth outcome whose
   * status is FAILED is counted here the day it is added instead of falling
   * into the "nothing was measured" branch below as a silent pass.
   */
  const failing = results.filter((r) => moneyPathStatus(r.outcome) === 'FAILED');
  const asserted = results.filter((r) => r.outcome === MONEY_PATH_PASSING_OUTCOME);
  const refused = results.filter((r) => r.outcome === 'REFUSED');
  const unavailable = results.filter((r) => r.outcome === 'UNAVAILABLE');

  for (const result of refused) {
    notes.push({
      level: 'warn',
      text: `REFUSED (${result.refusalReason ?? 'unstated'}): ${result.detail}`,
      at: new Date().toISOString(),
    });
  }
  for (const result of unavailable) {
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
        text: `NOT ASSERTED (${hole.reason}): ${maskCredentialShapes(hole.assertion)}`,
        at: new Date().toISOString(),
      });
    }
  }

  const holeCount = results.reduce((sum, r) => sum + r.notAsserted.length, 0);
  const disclosure = [
    refused.length > 0
      ? `${refused.length} of ${results.length} scenario(s) were REFUSED by QAAI: ` +
        `${refused.map((r) => r.refusalReason ?? 'unstated').join(', ')}.`
      : '',
    unavailable.length > 0
      ? `${unavailable.length} of ${results.length} scenario(s) were NOT measured: ` +
        `${unavailable.map((r) => r.unavailableReason ?? 'unstated').join(', ')}.`
      : '',
    holeCount > 0
      ? `${holeCount} assertion(s) were NOT made: ` +
        `${results
          .flatMap((r) => r.notAsserted)
          .map((hole) => `${hole.reason}: ${maskCredentialShapes(hole.assertion)}`)
          .join(' | ')}.`
      : '',
  ]
    .filter((sentence) => sentence.length > 0)
    .join(' ');

  if (failing.length > 0) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      errorMessage: [failing.map((r) => r.detail).join(' | '), disclosure]
        .filter((part) => part.length > 0)
        .join(' ── '),
    };
  }

  if (asserted.length === 0) {
    const why =
      `None of this test's ${spec.scenarios.length} payment scenario(s) could be asserted, so ` +
      `nothing is claimed about "${test.name}". ` +
      (results.length > 0 ? disclosure : 'The run was cancelled before any scenario was attempted.');
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      /*
       * NOT_RUN, the weakest of the four kinds, even when every scenario was
       * REFUSED. BLOCKED_BY_ENV would be a stronger claim than the evidence
       * supports — a gateway in live mode is a perfectly healthy environment
       * that this product declines to touch — and UNSUPPORTED would be wrong
       * the other way, since a test-mode gateway with an adapter runs here
       * fine.
       */
      notRun: { kind: ctx.signal.aborted ? 'CANCELLED' : 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    errorMessage: disclosure.length > 0 ? disclosure : null,
  };
}

// ─── The shipped adapters ───────────────────────────────────────────────────

/**
 * A gateway source that reports NOTHING PRESENT rather than guessing a mode.
 *
 * `mode: 'UNKNOWN'` beside `present: false`, and both halves matter. A source
 * that defaulted to TEST would let a hand-built spec past
 * {@link resolveGateway} on an environment nobody looked at, which is the one
 * way this file could ever drive a live gateway.
 */
export const unavailableGatewayModes: GatewayModeSource = {
  describe() {
    return Promise.resolve({ present: false, mode: 'UNKNOWN' });
  },
};

/**
 * A checkout surface that REFUSES rather than fabricating a payment.
 *
 * `arrive` answers `NO_CHECKOUT_SURFACE` rather than returning a submission
 * that reports success, and that distinction is the entire false-green argument
 * of this file. A stub that resolved "the charge succeeded" would drive every
 * payment test to ASSERTED — PASSED — on an image with no browser, which is
 * QAAI reporting a healthy money path on the strength of its own missing
 * adapter.
 *
 * `NO_CHECKOUT_SURFACE` and NOT `CHECKOUT_UNREACHABLE`, which is the same
 * distinction one level down: the route may be perfectly healthy, and blaming
 * the deployment for our missing adapter would send somebody to debug a server
 * that is fine. It is also NOT `BOT_PROTECTION_UNSOLVED`: claiming a bot
 * defence we never saw would attribute our gap to the customer's CAPTCHA and
 * send them to configure a test key that would change nothing.
 */
export const unavailableCheckoutSurface: CheckoutSurface = {
  arrive(path) {
    return Promise.resolve({
      ok: false as const,
      reason: 'NO_CHECKOUT_SURFACE' as const,
      detail: `No checkout adapter is configured for this run, so "${printablePath(path)}" was not opened.`,
    });
  },
  submit(request) {
    return Promise.resolve({
      submitted: false,
      reference: null,
      rejectedClientSide: false,
      challengePresented: false,
      detail: `No checkout adapter is configured for this run, so "${printablePath(request.path)}" was not driven.`,
    });
  },
  resolveChallenge() {
    return Promise.resolve(null);
  },
  merchantAction() {
    return Promise.resolve(null);
  },
};

/**
 * A money-state source that cannot read, and says so.
 *
 * NOT `state: 'NONE'`. A fake "there is no charge" would pass every decline
 * scenario in the product on a deployment with no adapter at all — the single
 * most attractive wrong answer available here, because it looks exactly like a
 * correctly refused payment. `available()` answering first means the default
 * deps never submit anything.
 */
export const unavailableMoneyStateSource: MoneyStateSource = {
  available() {
    return Promise.resolve({ ok: false as const, reason: 'NO_MONEY_STATE_SOURCE' as const });
  },
  observe() {
    return Promise.resolve(null);
  },
};

/** No webhook observer: the one scenario kind that needs it is UNAVAILABLE with the remedy. */
export const unavailableWebhookObserver: WebhookObserver = {
  available() {
    return Promise.resolve({ ok: false as const, reason: 'NO_WEBHOOK_OBSERVER' as const });
  },
  waitFor() {
    return Promise.resolve(null);
  },
};

let deps: PaymentsDeps = {
  checkout: unavailableCheckoutSurface,
  gateways: unavailableGatewayModes,
  money: unavailableMoneyStateSource,
  webhooks: unavailableWebhookObserver,
};

/**
 * Install the surfaces a run executes against. Returns the previous set, so a
 * test restores exactly what it found.
 *
 * The same module-level injection point as `setPushDeps` and `setDocumentDeps`,
 * for the same reason: a plugin's `execute` signature is fixed by `RunnerPlugin`
 * and cannot take a deps argument, so the worker installs them before the run
 * and the tests install recorders.
 */
export function setPaymentsDeps(next: PaymentsDeps): PaymentsDeps {
  const previous = deps;
  deps = next;
  return previous;
}

/**
 * The plugin.
 *
 * `type: 'PAYMENTS'` is in `PENDING_TEST_TYPES` and not in `TEST_TYPES`, so
 * this registers in `PENDING_PLUGINS` in packages/runner/src/registry.ts and
 * `pendingTypes()` reports it as a named gap until the mint lands.
 * `promotePendingPlugins` moves it into the live table the moment the
 * vocabulary names it, with no further edit here — see `mintTestTypeSteps` in
 * packages/shared/src/constants.ts for the four edits that mint it.
 *
 * The spec schema (`paymentsTestSpecSchema`) and the type declaration already
 * exist in @qaai/shared, so nothing here invents a second vocabulary for the
 * fourteen scenario kinds, the outcome a card forces, or the reasons an
 * assertion went unmade.
 */
export const paymentsPlugin = {
  type: 'PAYMENTS' as const,

  validate(test: ExecutableTest): void {
    const parsed = paymentsTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Payments test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * THE CATALOGUE GATE, APPLIED BEFORE ANYTHING IS DRIVEN.
     *
     * `paymentScenarioSchema`'s own comment says `catalogueId` is "validated
     * against the catalogue by the producer", and payments.adversary.test.ts
     * records that nothing did it: an invented id parses, and a raw card-shaped
     * number parses. This is that validation. It runs HERE as well as inside
     * {@link runPaymentScenario} because `validate` is the one hook the worker
     * calls before `execute` — so a spec that cannot be attempted as written
     * says so with a readable sentence instead of producing a run's worth of
     * UNAVAILABLE steps, and because the wrong card is the failure mode that
     * does not look like one.
     *
     * WHICH verdicts are raised here is deliberate, because a throw becomes a
     * FAILED result in the worker:
     *
     *   · a REFUSAL always throws. A spec carrying something credential- or
     *     card-shaped must not be driven at all, and the loudest available
     *     sentence is the right one.
     *   · the outcome MISMATCH throws. Both ids exist in this build and they
     *     disagree, which is a fact about the spec that no environment, no
     *     adapter and no later catalogue entry changes: no credential can make
     *     a decline card force a 3-D Secure challenge.
     *   · NO_PUBLISHED_TEST_VALUE does NOT throw, and that is the considered
     *     one. The catalogue is OUR data and it grows — the provider catalogue
     *     carries its own `CATALOGUE_OMISSIONS` list of values deliberately
     *     left out — so a spec naming an entry this build does not carry is as
     *     much a gap in our data as an error in their test, and failing the
     *     whole test for it would make our gap read as their defect. It is
     *     UNAVAILABLE at run time with the remedy instead.
     *   · everything else — no sandbox integration, no adapter, a bot defence —
     *     is a property of the DEPLOYMENT, and a stored test must survive it
     *     rather than refusing to run.
     */
    const problems: string[] = [];
    parsed.data.scenarios.forEach((scenario, index) => {
      const checked = validatePublishedValue(scenario);
      if (checked.ok) return;
      if ('refusal' in checked) {
        problems.push(`scenarios[${index}]: ${checked.refusal.detail}`);
        return;
      }
      if (
        checked.unavailable.reason === 'VALUE_FORCES_A_DIFFERENT_OUTCOME' ||
        checked.unavailable.reason === 'TEST_MODE_CANNOT_PRODUCE_IT'
      ) {
        problems.push(`scenarios[${index}]: ${checked.unavailable.detail}`);
      }
    });
    if (problems.length > 0) {
      throw new Error(`Payments test "${test.name}" cannot be attempted — ${problems.join('; ')}`);
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runPaymentsTest(ctx, test, paymentsTestSpecSchema.parse(test.spec), deps);
  },
};

/**
 * The fourteen scenario kinds, re-exported from the shared vocabulary.
 *
 * Re-exported rather than restated so a reader of this plugin and a reader of
 * the schema are looking at ONE list. The compiler-exhaustive records above —
 * {@link ACCEPTABLE_MONEY_STATES} and {@link FORCED_OUTCOME_FOR_SCENARIO} — are
 * keyed by it, and payments.test.ts asserts the run-time half against
 * `paymentScenarioKindSchema.options`, which is the pairing the house style asks
 * for on every union with a write path.
 */
export { PAYMENT_SCENARIO_KINDS };
