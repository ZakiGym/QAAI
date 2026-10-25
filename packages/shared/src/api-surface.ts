/**
 * The machine-read side of the denominator: the surface an ARTIFACT declares.
 *
 * WHY THIS FILE EXISTS, AND WHY THESE FOUR THINGS ARE IN ONE FILE
 *
 * `requirements.ts` holds the surface a human declared. `surface.ts` holds the
 * registry every declarer writes into. This file holds the four inventories
 * that a reader can extract from something a machine already wrote down, and
 * that QAAI has no vocabulary for at all today:
 *
 *   1. THE API OPERATION REGISTRY. OpenAPI is parsed today only inside the
 *      CONTRACT runner and thrown away the moment the run ends, so the single
 *      richest declaration of an application's surface — methods, path
 *      templates, request shapes, declared auth, and every parameter bound —
 *      is read and discarded. The `HttpEndpoint` rows that survive are
 *      UNKNOWN-verb declarations nothing ever verifies.
 *   2. THE COMPONENT INVENTORY. There is none, anywhere in the repo, which is
 *      why UNIT_GEN and component-state coverage have no denominator: there is
 *      nothing to divide by. "Not just the happy path" is currently an
 *      adjective; {@link COMPONENT_STATE_KINDS} makes it a count.
 *   3. THE BACKGROUND SURFACES. A cron entry, a queue consumer, a webhook
 *      receiver, an upload handler, a websocket, a server action, a tRPC
 *      procedure. Nothing crawls these and no route table declares them, so
 *      they were not UNCOVERED — they were not THERE, and absent flatters the
 *      percentage while uncovered lowers it.
 *   4. OBSERVED TRAFFIC. `POST /traffic/analyze` computes real journeys, real
 *      session frequencies and a coverage cross-reference, and writes NOTHING.
 *      The third enumeration source does not currently outlive one HTTP
 *      response.
 *
 * They share a file because they share one property that governs every shape
 * below: each is read from an artifact that may be absent, partial, or silent,
 * and in each case the silence has to be a different value from the answer.
 *
 * THE FOUR SILENCES THIS FILE REFUSES TO SPELL AS ANSWERS
 *
 *   · {@link API_AUTH_DECLARATIONS} — "the document declared no auth for this
 *     operation" and "we never read a document" are different facts, and so is
 *     "the document is silent here and declares no global default".
 *   · {@link API_OPERATION_VERIFICATIONS} — NOT_PROBED is not "does not exist".
 *     It is a cap, a missing base URL or a policy refusal, and the reason goes
 *     on the row.
 *   · {@link ComponentItem.hasCatalogueEntry} — null means no catalogue was
 *     read. `false` means one was, and this component is not in it.
 *   · {@link TrafficIngestAccounting} — every cap that BIT is a count AND a
 *     reason, so the report can say "at least N more journeys existed" rather
 *     than quietly shrinking the denominator.
 *
 * WHAT THIS FILE IS NOT
 *
 * It parses nothing and fetches nothing. Every reader built on it takes its I/O
 * as an injected dependency; this module is vocabulary, shapes, write-path
 * schemas, and the few derivations that must have one implementation.
 */

import { z } from 'zod';
/*
 * VALUE imports, and the module graph they make is deliberate:
 * api-surface → surface → constants, and api-surface → codebase → flow-map.
 * No edge back from either.
 *
 * `DIMENSION_AXIS` in particular is CALLED and not copied. A background surface
 * has to land on one of the twelve `SURFACE_KINDS` axes or its cells have
 * nothing to be counted on, and surface.ts has already decided which axis a
 * JOB and an EMAIL land on. A second mapping here would be a second
 * denominator, which is the exact defect this round exists to end.
 */
import { DIMENSION_AXIS, type SurfaceDimensionKind, type SurfaceKind } from './surface';
import { HTTP_METHODS } from './codebase';

// ─── 1. The API operation registry ───────────────────────────────────────────

/**
 * The verbs an operation row may hold.
 *
 * 'UNKNOWN' is carried over from `HttpEndpoint.method` verbatim and for the
 * same reason stated there: a Next `route.ts` we were given no content for is
 * definitely an endpoint and its verbs are definitely unreadable, and saying
 * GET would be a guess dressed as a fact. The list is SPREAD from
 * `HTTP_METHODS` rather than retyped, so a verb added there cannot fail to be
 * storable here.
 */
export const API_OPERATION_METHODS = [...HTTP_METHODS, 'UNKNOWN'] as const;
export type ApiOperationMethod = (typeof API_OPERATION_METHODS)[number];

/**
 * What a DOCUMENT says about authentication on one operation.
 *
 * Five members, and the last two are the reason this is an enum rather than a
 * boolean. OpenAPI's `security` can be set globally, overridden per operation,
 * overridden to the empty array (which means "no auth here"), or omitted
 * entirely; and we may never have read a document for this operation at all,
 * because it came from a source detector or from traffic.
 *
 * Collapsing those into `authRequired: boolean` produces the single most
 * dangerous false negative in this product: every operation whose document we
 * did not read reads as public, a negative-auth test is generated for it, the
 * test gets a 401, and the 401 is reported as the application correctly
 * refusing anonymous access — a passing test that asserted nothing about an
 * operation we know nothing about.
 *
 * This is a claim about the DOCUMENT and never about the application. What the
 * application actually does is {@link ApiOperationProbe.authRequiredInFact},
 * and the two disagreeing is a finding worth a meeting.
 */
export const API_AUTH_DECLARATIONS = [
  /** The document declares a security requirement for this operation. */
  'REQUIRED',
  /**
   * The document offers both: a security requirement AND an empty alternative,
   * so anonymous access is declared legal. OpenAPI spells this as a `{}` entry
   * in the `security` array, and it is the state most parsers get wrong.
   */
  'OPTIONAL',
  /** The document explicitly declares NO security for this operation. */
  'NONE',
  /**
   * The document says nothing here and declares no global default. The document
   * is SILENT — which is not the same as declaring none.
   */
  'UNSTATED',
  /**
   * No document was read for this operation. Our silence, not theirs. The
   * default for a row minted by a source detector or by traffic.
   */
  'NOT_READ',
] as const;
export type ApiAuthDeclaration = (typeof API_AUTH_DECLARATIONS)[number];

export const API_AUTH_DECLARATION_LABELS: Record<ApiAuthDeclaration, string> = {
  REQUIRED: 'the document requires authentication',
  OPTIONAL: 'the document allows both anonymous and authenticated access',
  NONE: 'the document explicitly declares no authentication',
  UNSTATED: 'the document is silent and declares no default',
  NOT_READ: 'no document was read for this operation',
};

/**
 * The declarations under which an anonymous request is a MEANINGFUL test.
 *
 * Only the two where the document took a position that anonymous access is
 * allowed. Under UNSTATED and NOT_READ a 401 proves nothing about the
 * application and everything about our ignorance, so a generator must not mint
 * an assertion from them — it must say so instead.
 */
export const ANONYMOUS_ACCESS_DECLARED: readonly ApiAuthDeclaration[] = ['OPTIONAL', 'NONE'];

/**
 * What we know about whether this operation EXISTS in the running application.
 *
 * ── The four states, none of which asserts absence ──────────────────────────
 *
 *   DECLARED     a document or a detector declares it; no probe attempted.
 *                The default for a freshly-parsed row.
 *   NOT_PROBED   probing was CONSIDERED AND NOT DONE — no base URL for the
 *                environment, a policy rule refused it, or the probe budget was
 *                spent. Different from DECLARED because somebody tried to
 *                verify and could not, and the reason belongs on the row.
 *   CONFIRMED    a probe got an answer that proves the path is routed.
 *   NO_ANSWER    a probe was made and nothing answered at all — connection
 *                refused, DNS failure, timeout. UNKNOWN, not absent.
 *
 * ── Why there is no REFUTED member ──────────────────────────────────────────
 *
 * Because a 404 does not prove absence. A gateway that has not been reloaded, a
 * feature flag that is off, an authorisation wall that hides existence, and a
 * genuinely undeployed operation all return exactly the same 404, and we cannot
 * tell them apart from outside. So a 404 leaves the operation at its previous
 * state and the PROBE ROW records the status it saw; the finding "your document
 * declares an operation that 404s" is then derivable from the probe rows, as a
 * statement about what we observed, instead of being baked into the operation's
 * state as a claim we cannot defend.
 *
 * NOT_PROBED must never be rendered as "does not exist", and it is the member
 * most likely to be, because it is the one that will be most common on the day
 * this ships.
 */
export const API_OPERATION_VERIFICATIONS = [
  'DECLARED',
  'CONFIRMED',
  'NO_ANSWER',
  'NOT_PROBED',
] as const;
export type ApiOperationVerification = (typeof API_OPERATION_VERIFICATIONS)[number];

export const API_OPERATION_VERIFICATION_LABELS: Record<ApiOperationVerification, string> = {
  DECLARED: 'declared, never probed',
  CONFIRMED: 'a probe got an answer that proves it is routed',
  NO_ANSWER: 'a probe was made and nothing answered — unknown, not absent',
  NOT_PROBED: 'probing was not done, and the reason is on the row',
};

/** Verifications that are an OBSERVATION of the running application. */
export const CONFIRMED_VERIFICATIONS: readonly ApiOperationVerification[] = ['CONFIRMED'];

/**
 * Where a parameter sits, which decides how a negative test supplies it.
 *
 * A TS-only vocabulary rather than a Prisma enum: it lives inside the stored
 * parameter blob, where a database type cannot reach it, and its domain is
 * enforced at the producer by {@link apiParameterSchema} — the same judgement
 * `CoverageItem.unexercisableReason` records.
 */
export const API_PARAMETER_LOCATIONS = ['PATH', 'QUERY', 'HEADER', 'COOKIE', 'BODY'] as const;
export type ApiParameterLocation = (typeof API_PARAMETER_LOCATIONS)[number];

/**
 * One parameter and its declared bounds.
 *
 * ── Why the bounds are three-state ──────────────────────────────────────────
 *
 * Exactly as `FormField`'s constraint capture is, and for the same reason:
 *
 *   · absent/undefined → this reader does not capture that constraint at all.
 *   · null             → we read the declaration and it states no bound.
 *   · a value          → the declared bound.
 *
 * A `maxLength` of `null` read as "no limit" is a negative test that posts a
 * 10,000-character string at an operation whose document never promised to
 * reject it, and then reports the 500 it gets as a defect. A `maxLength` that
 * is merely missing because our reader ignores that keyword is a different
 * problem — in us — and must not be reported as the application's.
 */
export interface ApiParameterBound {
  name: string;
  location: ApiParameterLocation;
  /**
   * Whether the document says this parameter must be supplied.
   *
   * Null means the document did not say. OpenAPI defaults `required` to false
   * for everything except path parameters, and treating that default as a
   * declaration is how "this field is optional" gets asserted about a field the
   * author simply never annotated.
   */
  required: boolean | null;
  /** The declared type as the document spells it: `string`, `integer`, … */
  type: string | null;
  /** Numeric bounds, inclusive, as the document declares them. */
  minimum?: number | null;
  maximum?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  /** The declared regular expression, verbatim. Never compiled here. */
  pattern?: string | null;
  /** The declared closed set of values, in declaration order. */
  enumValues?: string[] | null;
}

/**
 * The edge of a declared bound: one value worth sending, and what the document
 * entitles us to expect back.
 *
 * ── Why `expectation` has an UNKNOWN member ─────────────────────────────────
 *
 * Because the generated assertion is only as strong as the declaration behind
 * it. `minimum: 1` entitles a test to assert that 0 is REJECTED. A `pattern`
 * entitles a test to assert nothing at all, because constructing a string that
 * matches an arbitrary regular expression is not something this module will
 * pretend to do — and inventing one that happens to match would produce a test
 * asserting the application accepts a value we guessed, which is a measured
 * claim about something we did not measure.
 */
export const API_BOUNDARY_EXPECTATIONS = ['ACCEPT', 'REJECT', 'UNKNOWN'] as const;
export type ApiBoundaryExpectation = (typeof API_BOUNDARY_EXPECTATIONS)[number];

export const API_BOUNDARY_EDGE_KINDS = [
  'BELOW_MINIMUM',
  'AT_MINIMUM',
  'AT_MAXIMUM',
  'ABOVE_MAXIMUM',
  'BELOW_MIN_LENGTH',
  'AT_MAX_LENGTH',
  'ABOVE_MAX_LENGTH',
  'IN_ENUM',
  'OUTSIDE_ENUM',
  'OMITTED',
] as const;
export type ApiBoundaryEdgeKind = (typeof API_BOUNDARY_EDGE_KINDS)[number];

export interface ApiBoundaryEdge {
  kind: ApiBoundaryEdgeKind;
  /** The value to send. A string length for the length edges, a number, or a member. */
  value: string | number | null;
  expectation: ApiBoundaryExpectation;
  /** The clause of the declaration that justifies the expectation. */
  reason: string;
}

/**
 * The boundary values a declared parameter entitles a negative test to try.
 *
 * ── Why this is here and not in the generator ───────────────────────────────
 *
 * Because it is arithmetic over a declaration, it is the same arithmetic for
 * every ecosystem, and it is the part that is easy to get subtly wrong in a way
 * no test catches: an off-by-one on `minimum` produces a test that asserts the
 * application rejects a value it is documented to accept, and that test will
 * pass against a buggy application and fail against a correct one.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It returns NOTHING for a `pattern`, and it never multiplies the bounds
 * together. Two bounds on one parameter are two edges to try, not four
 * combinations — the same argument `multiAxisDenominator` makes for not
 * multiplying dimensions.
 */
export function boundaryEdges(bound: ApiParameterBound): ApiBoundaryEdge[] {
  const edges: ApiBoundaryEdge[] = [];

  const minimum = bound.minimum ?? null;
  if (minimum !== null && Number.isFinite(minimum)) {
    edges.push({
      kind: 'BELOW_MINIMUM',
      value: minimum - 1,
      expectation: 'REJECT',
      reason: `the document declares minimum ${minimum}, so ${minimum - 1} is out of range`,
    });
    edges.push({
      kind: 'AT_MINIMUM',
      value: minimum,
      expectation: 'ACCEPT',
      reason: `the document declares minimum ${minimum} inclusive`,
    });
  }

  const maximum = bound.maximum ?? null;
  if (maximum !== null && Number.isFinite(maximum)) {
    edges.push({
      kind: 'AT_MAXIMUM',
      value: maximum,
      expectation: 'ACCEPT',
      reason: `the document declares maximum ${maximum} inclusive`,
    });
    edges.push({
      kind: 'ABOVE_MAXIMUM',
      value: maximum + 1,
      expectation: 'REJECT',
      reason: `the document declares maximum ${maximum}, so ${maximum + 1} is out of range`,
    });
  }

  const minLength = bound.minLength ?? null;
  /*
   * `> 0` and not `>= 0`. `minLength: 0` is satisfied by the empty string, so
   * there is no shorter string to send and no edge to try; emitting one would
   * mean a value of length -1, which is not a value.
   */
  if (minLength !== null && minLength > 0) {
    edges.push({
      kind: 'BELOW_MIN_LENGTH',
      value: minLength - 1,
      expectation: 'REJECT',
      reason: `the document declares minLength ${minLength}; send a value one character shorter`,
    });
  }

  const maxLength = bound.maxLength ?? null;
  if (maxLength !== null && maxLength >= 0) {
    edges.push({
      kind: 'AT_MAX_LENGTH',
      value: maxLength,
      expectation: 'ACCEPT',
      reason: `the document declares maxLength ${maxLength} inclusive`,
    });
    edges.push({
      kind: 'ABOVE_MAX_LENGTH',
      value: maxLength + 1,
      expectation: 'REJECT',
      reason: `the document declares maxLength ${maxLength}; send a value one character longer`,
    });
  }

  const enumValues = bound.enumValues ?? null;
  if (enumValues !== null && enumValues.length > 0) {
    const first = enumValues[0];
    if (first !== undefined) {
      edges.push({
        kind: 'IN_ENUM',
        value: first,
        expectation: 'ACCEPT',
        reason: `the document declares a closed set of ${enumValues.length} value(s)`,
      });
    }
    edges.push({
      kind: 'OUTSIDE_ENUM',
      value: outsideEnumValue(enumValues),
      expectation: 'REJECT',
      reason: `the document declares a closed set that does not contain this value`,
    });
  }

  /*
   * A required parameter's omission is an edge the document fully justifies,
   * and it is the one negative case every API has. `required: null` produces
   * nothing: OpenAPI defaults `required` to false, so "not annotated" and
   * "declared optional" are indistinguishable, and asserting a rejection from
   * that would be asserting from a default nobody wrote.
   */
  if (bound.required === true) {
    edges.push({
      kind: 'OMITTED',
      value: null,
      expectation: 'REJECT',
      reason: 'the document declares this parameter required',
    });
  }

  return edges;
}

/**
 * A value guaranteed not to be in a declared enum.
 *
 * Derived from the members rather than hard-coded, because a hard-coded
 * sentinel is a value that one customer's enum will one day contain — and the
 * negative test would then assert a rejection of a value the application is
 * documented to accept. Appending a character to the longest member cannot
 * collide with any of them.
 */
function outsideEnumValue(members: readonly string[]): string {
  const longest = members.reduce(
    (best, member) => (member.length > best.length ? member : best),
    '',
  );
  return `${longest}\u0000qaai-not-a-member`;
}

/**
 * Why an operation was not probed, when its verification is NOT_PROBED.
 *
 * A closed vocabulary because each one has a different remedy and the report
 * groups by it. "No base URL" is a configuration the customer can fix in a
 * minute; "the probe budget was spent" is a cap WE applied and the report has
 * to be able to say how many operations it hid.
 */
export const NOT_PROBED_REASONS = [
  /** The environment has no base URL, so there was nowhere to send a request. */
  'NO_BASE_URL',
  /** A crawl-policy rule excluded the path. We did not look, on purpose. */
  'REFUSED_BY_POLICY',
  /** The per-run probe budget was spent before reaching this operation. */
  'BUDGET_SPENT',
  /** The verb is destructive and no disposable data is provisioned here. */
  'UNSAFE_VERB',
  /** We hold no credential that satisfies the declared security requirement. */
  'NO_CREDENTIAL',
] as const;
export type NotProbedReason = (typeof NOT_PROBED_REASONS)[number];

export const NOT_PROBED_REASON_LABELS: Record<NotProbedReason, string> = {
  NO_BASE_URL: 'the environment has no base URL to send a request to',
  REFUSED_BY_POLICY: 'a crawl-policy rule excluded this path; never attempted',
  BUDGET_SPENT: 'the probe budget was spent before this operation was reached',
  UNSAFE_VERB: 'a destructive verb with no disposable data provisioned here',
  NO_CREDENTIAL: 'no credential satisfies the declared security requirement',
};

/**
 * What one probe saw.
 *
 * Every field that could be a guess is nullable, and null means NOT DETERMINED
 * in every one of them. `authRequiredInFact` is the one that matters most: it
 * is the only place in the product where the application itself, rather than
 * its documentation, says whether an operation is public.
 */
export interface ApiOperationProbeFact {
  /** The HTTP status that came back. Null when nothing answered. */
  status: number | null;
  /**
   * Whether the verb was allowed. Null when undetermined — a 404 says nothing
   * about the verb, and only a 405 (or an `Allow` header) settles it.
   */
  verbAllowed: boolean | null;
  /**
   * Whether authentication was required IN FACT: an anonymous request was
   * refused, and the same request with a credential was not.
   *
   * Null unless BOTH halves were sent. One anonymous 401 on its own does not
   * establish it — the operation may be 401-ing everyone, including us — and
   * recording it as `true` from half the evidence is how the document and the
   * application come to agree on paper about an operation that is broken.
   */
  authRequiredInFact: boolean | null;
  /** True when anything at all answered. Distinguishes CONFIRMED from NO_ANSWER. */
  answered: boolean;
  /** The sentence shown beside the probe. Always written, never defaulted to ''. */
  detail: string;
}

// ─── 2. The component inventory ──────────────────────────────────────────────

/**
 * What kind of exported thing this is, which decides both how it is tested and
 * WHETHER IT IS ALREADY COUNTED SOMEWHERE ELSE.
 *
 * The second half is the important one and is the reason this is an enum rather
 * than a label. A Next.js `page.tsx` is both an exported component and a ROUTE,
 * and a denominator that counts it twice is not a bigger measurement of the
 * application — it is the same application divided by a larger number. Three
 * disjoint inventories of one app on three screens is the defect this round
 * exists to end; minting a fourth that double-counts the first would be an
 * expensive way to make it worse. {@link componentHasOwnAxis} is the guard.
 */
export const COMPONENT_ITEM_KINDS = [
  /** A presentational or interactive component. The UNIT_GEN denominator. */
  'COMPONENT',
  /** A route entry point. ALREADY on the ROUTE axis — see the note above. */
  'PAGE',
  /** A shell wrapping routes. Already reached through every route it wraps. */
  'LAYOUT',
  /** A hook. Testable in isolation, and not rendered. */
  'HOOK',
  /** A context provider. Its states are the states of everything under it. */
  'CONTEXT_PROVIDER',
  /** An exported helper that is not a component at all. */
  'UTILITY',
] as const;
export type ComponentItemKind = (typeof COMPONENT_ITEM_KINDS)[number];

export const COMPONENT_ITEM_KIND_LABELS: Record<ComponentItemKind, string> = {
  COMPONENT: 'Components',
  PAGE: 'Route entry points',
  LAYOUT: 'Layouts',
  HOOK: 'Hooks',
  CONTEXT_PROVIDER: 'Context providers',
  UTILITY: 'Exported helpers',
};

/**
 * Kinds whose surface is already counted on another `SURFACE_KINDS` axis.
 *
 * They stay in the inventory — a page component's STATES are real surface and
 * the ROUTE axis has no notion of a loading state — but the component itself
 * must not be added to a denominator that already contains its route.
 */
export const COMPONENT_KINDS_WITH_OWN_AXIS: Record<ComponentItemKind, SurfaceKind | null> = {
  COMPONENT: null,
  PAGE: 'ROUTE',
  LAYOUT: 'ROUTE',
  HOOK: null,
  CONTEXT_PROVIDER: null,
  UTILITY: null,
};

/**
 * The axis this kind is already counted on, or null when it is not counted
 * anywhere else.
 *
 * A function rather than a direct `Record` read, so there is exactly one place
 * that knows where the fact lives — the same argument `exerciseOf` makes.
 */
export function componentHasOwnAxis(kind: ComponentItemKind): SurfaceKind | null {
  return COMPONENT_KINDS_WITH_OWN_AXIS[kind];
}

/**
 * The named states a component can be in, which is what turns "not just the
 * happy path" from an adjective into a count.
 *
 * Six, and the five that are not DEFAULT are where every interesting defect in
 * a modern frontend lives: a spinner that never clears, an empty state that
 * renders `0 results` as `undefined results`, an error boundary nobody has ever
 * seen, a forbidden state that leaks the shape of the thing it is hiding, and a
 * slow response the UI treats as a failure.
 *
 * SLOW is in the list on purpose even though it is not a render branch. It is
 * the state a test can only reach by holding a response open, it is the one
 * nobody writes by hand, and a component inventory that omitted it would make
 * "we cover every state" true and useless.
 */
export const COMPONENT_STATE_KINDS = [
  'DEFAULT',
  'LOADING',
  'EMPTY',
  'ERROR',
  'FORBIDDEN',
  'SLOW',
] as const;
export type ComponentStateKind = (typeof COMPONENT_STATE_KINDS)[number];

export const COMPONENT_STATE_KIND_LABELS: Record<ComponentStateKind, string> = {
  DEFAULT: 'the happy path',
  LOADING: 'loading',
  EMPTY: 'empty',
  ERROR: 'error',
  FORBIDDEN: 'forbidden',
  SLOW: 'slow response',
};

/** Every state that is not the happy path. The count the claim rests on. */
export const NON_HAPPY_PATH_STATES: readonly ComponentStateKind[] = COMPONENT_STATE_KINDS.filter(
  (kind) => kind !== 'DEFAULT',
);

// ─── 3. The dimensions a SOURCE discovers ────────────────────────────────────

/*
 * THESE ARE THE CUSTOMER'S FLAGS, NOT QAAI'S.
 *
 * `model FeatureFlag` in apps/api/prisma/schema.prisma is QAAI's OWN flag
 * store: four rows written by prisma/seed.ts, read by nothing, and one of the
 * four gaps `scripts/check-wiring.ts` records. It has nothing to do with
 * anything below. The flags modelled here belong to the APPLICATION UNDER TEST
 * — they are read out of the customer's LaunchDarkly project, their Unleash
 * instance, their `NEXT_PUBLIC_FEATURE_*` env gates — and they are stored as
 * `SurfaceDimension` rows with `kind: 'FLAG'`, never in `FeatureFlag`.
 *
 * Reusing QAAI's table for the customer's flags would make a row in it
 * ambiguous: the same primary key would mean "QAAI's visual-regression feature
 * is off" and "the customer's checkout-v2 flag exists", and no reader could
 * tell which. The same note is on `model FeatureFlag` itself.
 */

/**
 * The providers a customer's feature flags can be read out of.
 *
 * These are the values a reader puts in `DimensionDetail.FLAG.provider`, which
 * is `string | null` and documented as "null when unknown" — so this list
 * narrows a free-text field rather than adding a vocabulary. Null stays the
 * answer when we could not tell; there is deliberately no `UNKNOWN` member,
 * because that would be a second spelling of the same fact.
 */
export const FLAG_PROVIDERS = [
  'LAUNCHDARKLY',
  'UNLEASH',
  'OPENFEATURE',
  'GROWTHBOOK',
  'FLAGSMITH',
  'STATSIG',
  /** A `process.env.FEATURE_*` / `NEXT_PUBLIC_*` gate. The commonest of all. */
  'ENV_GATE',
  /** A table in the customer's own database. */
  'DATABASE',
  /** A checked-in config file: `flags.json`, `config/features.yml`. */
  'CONFIG_FILE',
] as const;
export type FlagProvider = (typeof FLAG_PROVIDERS)[number];

/**
 * The catalogues a locale list can be read out of.
 *
 * Recorded in `SurfaceDimensionValue.evidence`, because `SurfaceDimension` has
 * no `detector` column — `CoverageItem` has one and the dimension table does
 * not, so the sentence is the only place the reader's identity can go. Stated
 * here rather than left to each reader's prose so that "which reader found this
 * locale?" is answerable by a string match instead of by reading.
 */
export const LOCALE_CATALOGUE_READERS = [
  'NEXT_INTL',
  'I18NEXT',
  'REACT_INTL',
  'VUE_I18N',
  'RAILS_I18N',
  'DJANGO_LOCALE',
  /** `<link rel="alternate" hreflang="…">` in the served HTML. */
  'HREFLANG',
  /** A `locales/` or `messages/` directory whose filenames are the tags. */
  'MESSAGE_DIRECTORY',
  /** A framework config that lists them: `i18n.locales` in next.config. */
  'FRAMEWORK_CONFIG',
] as const;
export type LocaleCatalogueReader = (typeof LOCALE_CATALOGUE_READERS)[number];

/**
 * A background surface and the facts that make it drivable, as a discriminated
 * union.
 *
 * ── Why a union and not a kind plus a blob of strings ───────────────────────
 *
 * Because the nine are not the same shape, and the differences are exactly the
 * facts a test needs: a cron has an expression, a queue consumer has a queue
 * name, a webhook receiver has a public path and a signature scheme, an upload
 * has accepted types and a size cap, a websocket has a path and the events it
 * emits, a server action has a module and an export, a tRPC procedure has a
 * router path and whether it mutates. Flattened into strings, not one of them
 * can be validated on the way in or used to drive anything — which is the state
 * `DimensionDetail` was created to end for roles and locales, and this is the
 * same argument for the surfaces nothing can crawl.
 *
 * ── Where these are stored ──────────────────────────────────────────────────
 *
 * In `CoverageItem.meta`, on the axis {@link backgroundSurfaceAxis} gives. NOT
 * in a new table: `CoverageItem` IS the surface registry, and a background job
 * is a surface in its own right rather than a cell of one. The matching
 * `SurfaceDimension` row (kind JOB or EMAIL) is what makes "how many jobs does
 * this app have" countable, and its `trigger` comes from
 * {@link backgroundTrigger} so it stays inside the five words surface.ts
 * documents for that field.
 *
 * ── The pattern this copies ─────────────────────────────────────────────────
 *
 * Both halves of the guard, as `DimensionDetail` carries them:
 * {@link BACKGROUND_SURFACE_KINDS} is derived from a `Record` the compiler
 * refuses to let drift, and api-surface.test.ts compares that list against
 * {@link backgroundSurfaceSchema}'s own options at run time.
 */
export type BackgroundSurfaceFact =
  | {
      kind: 'CRON';
      /** The expression as written. Never normalised: `@daily` is not `0 0 * * *`. */
      expression: string;
      /** The handler's module path, for the editor link. */
      handler: string | null;
    }
  | {
      kind: 'QUEUE_CONSUMER';
      queue: string;
      /** How many jobs run at once, when the registration declares it. */
      concurrency: number | null;
      handler: string | null;
    }
  | {
      kind: 'WEBHOOK_RECEIVER';
      /** The path the third party posts to. Public surface by definition. */
      path: string;
      /**
       * How the payload is authenticated: `hmac-sha256`, `stripe-signature`,
       * `none`. Null means we could not tell — which is NOT `none`, and the
       * difference decides whether an unsigned-payload test is a valid negative
       * case or a guess.
       */
      signatureScheme: string | null;
    }
  | {
      kind: 'OUTBOUND_EMAIL';
      /** The template identity, which is what a mailbox assertion matches on. */
      templateId: string;
      /** What sends it, in the customer's words. */
      sentBy: string | null;
    }
  | {
      kind: 'UPLOAD';
      /** The endpoint or action that accepts the file. */
      path: string;
      /** Accepted content types as declared. Empty array means none declared. */
      acceptedTypes: string[];
      /** The declared size cap in bytes. Null when nothing declares one. */
      maxBytes: number | null;
    }
  | {
      kind: 'WEBSOCKET';
      path: string;
      /** The message or event names the server emits, when they are literal. */
      events: string[];
    }
  | {
      kind: 'SSE';
      path: string;
      events: string[];
    }
  | {
      kind: 'SERVER_ACTION';
      /** The module the action is declared in. */
      module: string;
      /** The exported name. A server action has no URL to address it by. */
      exportName: string;
    }
  | {
      kind: 'TRPC_PROCEDURE';
      /** Dotted router path: `billing.invoices.list`. */
      procedure: string;
      /** True for a mutation. A query is safe to drive; a mutation is not. */
      mutation: boolean;
    };

/**
 * Every discriminant {@link BackgroundSurfaceFact} has, as a run-time value.
 * The compiler enforces this record; api-surface.test.ts enforces the zod union
 * against it.
 */
const BACKGROUND_SURFACE_PRESENT: Record<BackgroundSurfaceFact['kind'], true> = {
  CRON: true,
  QUEUE_CONSUMER: true,
  WEBHOOK_RECEIVER: true,
  OUTBOUND_EMAIL: true,
  UPLOAD: true,
  WEBSOCKET: true,
  SSE: true,
  SERVER_ACTION: true,
  TRPC_PROCEDURE: true,
};

export const BACKGROUND_SURFACE_KINDS = Object.keys(
  BACKGROUND_SURFACE_PRESENT,
) as ReadonlyArray<BackgroundSurfaceFact['kind']>;

export type BackgroundSurfaceKind = BackgroundSurfaceFact['kind'];

/**
 * Which existing dimension each background surface belongs to.
 *
 * Only two values, and that is the point: surface.ts already decided that a job
 * and an outbound email are the two enumerable background dimensions, and these
 * nine are a finer reading of the same two rather than a third. A `Record`
 * keyed on the union, so a tenth kind breaks this line instead of quietly
 * producing rows with no dimension.
 */
export const BACKGROUND_SURFACE_DIMENSION: Record<BackgroundSurfaceKind, SurfaceDimensionKind> = {
  CRON: 'JOB',
  QUEUE_CONSUMER: 'JOB',
  WEBHOOK_RECEIVER: 'JOB',
  OUTBOUND_EMAIL: 'EMAIL',
  UPLOAD: 'JOB',
  WEBSOCKET: 'JOB',
  SSE: 'JOB',
  SERVER_ACTION: 'JOB',
  TRPC_PROCEDURE: 'JOB',
};

/**
 * The `SURFACE_KINDS` axis a background surface's `CoverageItem` sits on.
 *
 * Derived through `DIMENSION_AXIS` rather than written out, so there is one
 * mapping from a dimension to an axis in the repo and not two. A second copy
 * here is how `BACKGROUND_JOB` and `NOTIFICATION` would come to be counted
 * differently on two screens.
 */
export function backgroundSurfaceAxis(kind: BackgroundSurfaceKind): SurfaceKind {
  return DIMENSION_AXIS[BACKGROUND_SURFACE_DIMENSION[kind]];
}

/**
 * The `DimensionDetail.JOB.trigger` word for a background surface.
 *
 * Constrained to the five words surface.ts documents for that field — CRON,
 * QUEUE, WEBHOOK, STARTUP, MANUAL — rather than widening it to these nine. The
 * finer kind lives in `CoverageItem.meta` as a {@link BackgroundSurfaceFact};
 * the dimension row keeps the coarse trigger. Writing nine words into a field
 * whose doc comment names five would make that comment false, which is one of
 * the lies this product cannot afford.
 *
 * OUTBOUND_EMAIL has no trigger and returns null: it is an EMAIL dimension, and
 * EMAIL detail has no trigger field at all.
 */
export const BACKGROUND_TRIGGERS = ['CRON', 'QUEUE', 'WEBHOOK', 'STARTUP', 'MANUAL'] as const;
export type BackgroundTrigger = (typeof BACKGROUND_TRIGGERS)[number];

export function backgroundTrigger(kind: BackgroundSurfaceKind): BackgroundTrigger | null {
  switch (kind) {
    case 'CRON':
      return 'CRON';
    case 'QUEUE_CONSUMER':
      return 'QUEUE';
    case 'WEBHOOK_RECEIVER':
      return 'WEBHOOK';
    case 'WEBSOCKET':
    case 'SSE':
      /*
       * A long-lived connection the server opens on start-up and holds. Not a
       * webhook: nothing posts to it, and a negative test for an unsigned
       * payload makes no sense against it.
       */
      return 'STARTUP';
    case 'UPLOAD':
    case 'SERVER_ACTION':
    case 'TRPC_PROCEDURE':
      /* Driven by a request a person or a test makes. */
      return 'MANUAL';
    case 'OUTBOUND_EMAIL':
      return null;
  }
}

// ─── 4. Traffic, made durable ────────────────────────────────────────────────

/**
 * What one traffic ingest cost the denominator.
 *
 * ── Why this is a stored shape and not a log line ───────────────────────────
 *
 * `POST /traffic/:projectId/analyze` applies at least four caps today — 50,000
 * entries, 500 tests compared, a `maxJourneys` of up to 40, and a per-session
 * step limit — and every one of them is a lever that makes the coverage
 * percentage go UP, because truncating shrinks the denominator while the
 * numerator (the tests that already exist) does not move. All four currently
 * vanish with the HTTP response.
 *
 * Every field below is therefore a COUNT and a REASON, so the report can print
 * "at least 212 more journeys existed" rather than "stopped early". `atLeast`
 * is a FLOOR and never an estimate: it counts journeys the analysis actually
 * held and dropped, exactly as `FlowMap.atLeastMoreUrls` counts URLs that were
 * actually queued or actually seen past the depth limit. Inventing a number in
 * the alarming direction is the same sin as inventing one in the flattering
 * direction.
 */
export interface TrafficIngestAccounting {
  /** Entries the parser recognised. */
  entriesParsed: number;
  /** Entries it could not parse, and why, by reason. Never a sample of content. */
  entriesSkipped: number;
  /** Sessions the analysis grouped the entries into. */
  sessions: number;
  /** Journeys written as rows. */
  journeysStored: number;
  /**
   * Journeys the analysis ranked and did NOT store because a cap bit. A floor:
   * these were held, counted and dropped.
   */
  journeysDroppedByCap: number;
  /**
   * Each cap that actually bit, named, with the number it was set to. Empty when
   * none did — which is a different and much better fact than an empty list
   * because nobody looked.
   */
  capsThatBit: Array<{ cap: string; limit: number; droppedAtLeast: number }>;
  /** The sentence the report prints beside the numbers. */
  rule: string;
}

/**
 * Summarise the caps that bit, as the sentence a reader forwards.
 *
 * One implementation because a second one would word it differently, and the
 * whole value of a disclosed cap is that it reads the same everywhere.
 */
export function describeTrafficCaps(accounting: TrafficIngestAccounting): string {
  if (accounting.capsThatBit.length === 0) {
    return `no cap bit: all ${accounting.journeysStored} journey(s) the analysis found were stored`;
  }
  const parts = accounting.capsThatBit.map(
    (cap) => `${cap.cap} (limit ${cap.limit}) hid at least ${cap.droppedAtLeast}`,
  );
  return (
    `${accounting.journeysStored} journey(s) stored; at least ` +
    `${accounting.journeysDroppedByCap} more existed — ${parts.join('; ')}`
  );
}

// ─── The write path ──────────────────────────────────────────────────────────

/*
 * As in requirements.ts: these schemas are in this module and not in
 * `schemas.ts` because a vocabulary and its only legal write path belong
 * together. Eight GateRule kinds shipped unsaveable for two slices because the
 * union was in one file and the schema in another, and nothing in CI can see
 * that class of defect — a union member with no write path is live code in a
 * reached file.
 */

const modulePath = z.string().trim().min(1).max(1_000);
const pathTemplate = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^\//, 'a path template is matched against a URL path, so it must start with "/"');

export const apiParameterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  location: z.enum(API_PARAMETER_LOCATIONS),
  required: z.boolean().nullable().default(null),
  type: z.string().trim().min(1).max(100).nullable().default(null),
  /*
   * `.optional()` AND `.nullable()` on every bound, which is not redundant: it
   * is the three-state capture the doc comment on `ApiParameterBound`
   * describes. Absent means this reader does not capture the constraint;
   * explicit null means the declaration states no bound. A `.default(null)`
   * here would erase the first state, and the first state is the one that keeps
   * our own reader's gaps from being reported as the application's.
   */
  minimum: z.number().nullable().optional(),
  maximum: z.number().nullable().optional(),
  minLength: z.number().int().min(0).nullable().optional(),
  maxLength: z.number().int().min(0).nullable().optional(),
  pattern: z.string().max(2_000).nullable().optional(),
  enumValues: z.array(z.string().max(500)).max(500).nullable().optional(),
});

export const apiOperationSchema = z.object({
  method: z.enum(API_OPERATION_METHODS),
  pathTemplate,
  /** The document's own `operationId`. Null when it has none — most do not. */
  operationId: z.string().trim().min(1).max(300).nullable().default(null),
  /**
   * Which document this came from: a URL, a repo-relative path, or the
   * detector's name when it came from source. Required: an operation with no
   * provenance cannot be re-read, re-diffed or disputed.
   */
  sourceDocument: z.string().trim().min(1).max(2_000),
  authDeclaration: z.enum(API_AUTH_DECLARATIONS),
  parameters: z.array(apiParameterSchema).max(500).default([]),
  /**
   * The request and response shapes, as the document declares them.
   *
   * Opaque JSON on purpose. A JSON-schema subset modelled as a union here would
   * be a second, worse JSON-schema implementation, and the one consumer —
   * boundary generation — needs {@link ApiParameterBound} rather than the whole
   * tree. Null means the document declared none; absent is not a state, because
   * every reader that writes an operation has looked at its body.
   */
  requestShape: z.unknown().nullable().default(null),
  responseShapes: z.unknown().nullable().default(null),
  evidence: z.string().trim().min(1).max(1_000),
});
export type ApiOperationInput = z.infer<typeof apiOperationSchema>;

/**
 * One background surface's facts. The run-time half of
 * {@link BackgroundSurfaceFact}.
 */
export const backgroundSurfaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CRON'),
    expression: z.string().trim().min(1).max(200),
    handler: modulePath.nullable().default(null),
  }),
  z.object({
    kind: z.literal('QUEUE_CONSUMER'),
    queue: z.string().trim().min(1).max(200),
    concurrency: z.number().int().min(1).max(10_000).nullable().default(null),
    handler: modulePath.nullable().default(null),
  }),
  z.object({
    kind: z.literal('WEBHOOK_RECEIVER'),
    path: pathTemplate,
    signatureScheme: z.string().trim().min(1).max(100).nullable().default(null),
  }),
  z.object({
    kind: z.literal('OUTBOUND_EMAIL'),
    templateId: z.string().trim().min(1).max(300),
    sentBy: z.string().trim().min(1).max(300).nullable().default(null),
  }),
  z.object({
    kind: z.literal('UPLOAD'),
    path: pathTemplate,
    acceptedTypes: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    maxBytes: z.number().int().min(0).nullable().default(null),
  }),
  z.object({
    kind: z.literal('WEBSOCKET'),
    path: pathTemplate,
    events: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  }),
  z.object({
    kind: z.literal('SSE'),
    path: pathTemplate,
    events: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  }),
  z.object({
    kind: z.literal('SERVER_ACTION'),
    module: modulePath,
    exportName: z.string().trim().min(1).max(300),
  }),
  z.object({
    kind: z.literal('TRPC_PROCEDURE'),
    procedure: z.string().trim().min(1).max(300),
    mutation: z.boolean(),
  }),
]);

export const componentItemSchema = z.object({
  modulePath,
  /** The exported name. `default` is a legal and common value. */
  exportName: z.string().trim().min(1).max(300),
  kind: z.enum(COMPONENT_ITEM_KINDS),
  /**
   * A one-line summary of the props, for a human and for a generator's prompt —
   * never the full type. Null when the export has no props (a hook, a utility).
   */
  propsSummary: z.string().trim().min(1).max(2_000).nullable().default(null),
  /**
   * Whether a story or catalogue entry exists.
   *
   * Three states and all three are needed: null means NO CATALOGUE WAS READ,
   * `false` means one was read and this component is not in it, `true` means it
   * is. Null read as `false` would report "nothing is in Storybook" about a
   * project whose Storybook we never looked for — a measured claim about
   * something not measured.
   */
  hasCatalogueEntry: z.boolean().nullable().default(null),
  /** The catalogue entry's id, when there is one. */
  catalogueRef: z.string().trim().min(1).max(500).nullable().default(null),
  evidence: z.string().trim().min(1).max(1_000),
});
export type ComponentItemInput = z.infer<typeof componentItemSchema>;
