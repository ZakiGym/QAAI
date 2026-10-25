/**
 * The expected-surface catalogue — the only module that can report an ABSENCE.
 *
 * WHY THIS FILE EXISTS
 *
 * Every other part of enumeration answers "what is there?". A route table, a
 * crawl, a sitemap, an OpenAPI document: each one reads something that exists
 * and reports it. That means the absence of a feature can never become a
 * finding. QAAI can say "you have 412 routes and 25 are covered" and it cannot
 * say "you have a login and no password-reset route", which is the more
 * alarming of the two sentences and the one a prospect forwards.
 *
 * So this file inverts the question. It holds a small catalogue of surface that
 * an application OF A GIVEN SHAPE is expected to have, and matches the
 * enumerated surface against it. The output is not a count — it is a list of
 * named expectations with a verdict each.
 *
 * THE FAILURE MODE THIS MODULE IS BUILT AROUND
 *
 * A prospect who is told they are missing a feature they deliberately do not
 * have stops trusting the entire report, including the parts that were right.
 * One false gap costs more than ten true ones earn. Three mechanisms exist here
 * for that single reason, and none of them is decoration:
 *
 *   1. AN EXPECTATION MUST BE TRIGGERED BY EVIDENCE. Nothing is expected
 *      because it is usually present. `PASSWORD_RESET` is expected because a
 *      login surface was enumerated; `MFA` is expected because privileged
 *      surface was enumerated. The evidence sentence travels on the result, so
 *      the customer reads WHY we expected it and can tell us we are wrong.
 *
 *   2. AN EXPECTATION THAT DOES NOT APPLY IS `NOT_APPLICABLE`, WITH A REASON —
 *      never a silent omission. An SSO-only application has no password to
 *      reset, and the report says so by name. A silently omitted expectation
 *      and an expectation we judged inapplicable look identical to a reader,
 *      and only one of them is a judgement we are willing to defend.
 *
 *   3. A SILENCE IS NOT AN ANSWER. `INDETERMINATE` exists because "the crawl
 *      requested an unknown URL and got the application's own 404 page" and
 *      "nothing ever requested an unknown URL" are different facts. Only a
 *      crawl can establish the second; if no crawl participated, reporting "you
 *      have no 404 page" is our silence dressed up as their defect. Every
 *      expectation therefore declares `detectableBy` — the declarers that could
 *      possibly evidence it — and yields INDETERMINATE when none of them ran.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A long catalogue. Fifteen expectations ship, each with a trigger that some
 * declarer actually produces. The temptation is a checklist of forty best
 * practices, which would generate a wall of UNMET rows for every application
 * and teach the reader to skip the section. `SEARCH` is the worked example of
 * the restraint: it is MET when a search path exists and NOT_APPLICABLE
 * otherwise, because nothing we enumerate establishes that an application has a
 * corpus worth searching. An application with no search is making a product
 * decision, not leaving a gap, and we are not in a position to tell the
 * difference.
 *
 * NOTHING HERE CALLS A MODEL
 *
 * Same rule as surface-inventory.ts and coverage.ts. The triggers are set
 * membership over enumerated items and the matchers are token comparisons, so
 * the customer can re-run this in their own CI and get the same verdicts.
 */

import {
  AUTH_SURFACE_KINDS,
  SURFACE_SOURCE_LABELS,
  parseSurfaceKey,
  type AuthSurfaceKind,
  type SurfaceItem,
  type SurfaceKind,
  type SurfaceSource,
} from '@qaai/shared';
import { canonicalRoute } from './coverage.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The expectations. Fifteen, and the list is closed on purpose — see the note
 * above about the forty-item checklist nobody reads.
 *
 * `LEGAL_PAGES` was split into `TERMS_OF_SERVICE` and `PRIVACY_POLICY` because
 * one of the two is routinely present without the other, and a single
 * expectation would have had to report a half-met state. There is no half-met
 * state; there are two expectations.
 */
export const EXPECTATION_IDS = [
  'NOT_FOUND_PAGE',
  'SERVER_ERROR_PAGE',
  'PASSWORD_RESET',
  'SIGNUP',
  'EMAIL_VERIFICATION',
  'LOGOUT',
  'MFA',
  'ACCOUNT_DELETION',
  'DATA_EXPORT',
  'CONSENT_COOKIE',
  'TERMS_OF_SERVICE',
  'PRIVACY_POLICY',
  'SESSION_TIMEOUT',
  'SEARCH',
  'HEALTH_CHECK',
] as const;
export type ExpectationId = (typeof EXPECTATION_IDS)[number];

/**
 * The four answers, and the reason there are four rather than two.
 *
 * MET and UNMET are the cheap half. The other two carry the honesty:
 *
 *   NOT_APPLICABLE  we evaluated the trigger and this application is not the
 *                   shape that expects it. A judgement, with its reason on the
 *                   row, which the customer may dispute.
 *   INDETERMINATE   we could not evaluate it. Either no declarer that could
 *                   have seen this thing participated, or the one that did
 *                   returned an inconclusive observation. NOT a gap, and never
 *                   counted as one.
 *
 * Collapsing INDETERMINATE into UNMET is the specific lie this file exists to
 * avoid: it reports a thing as measured that was not measured, and it moves the
 * finding count in the direction that flatters the vendor's demo.
 */
export const EXPECTATION_VERDICTS = ['MET', 'UNMET', 'NOT_APPLICABLE', 'INDETERMINATE'] as const;
export type ExpectationVerdict = (typeof EXPECTATION_VERDICTS)[number];

export const EXPECTATION_VERDICT_LABELS: Record<ExpectationVerdict, string> = {
  MET: 'present',
  UNMET: 'expected and not found',
  NOT_APPLICABLE: 'not expected for an application of this shape',
  INDETERMINATE: 'could not be established',
};

/**
 * How much weight an UNMET deserves.
 *
 * Qualifies UNMET and nothing else — a MET is a found item and needs no
 * hedging, and a NOT_APPLICABLE is a judgement whose reasoning is on the row.
 * The value on the definition is the expectation's intrinsic strength; the
 * value on a RESULT may be one step lower, because an absence observed through
 * an enumeration that disclosed it stopped early is weaker evidence than the
 * same absence observed through a complete one. See `downgradeConfidence`.
 */
export const EXPECTATION_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ExpectationConfidence = (typeof EXPECTATION_CONFIDENCES)[number];

// ─── Evidence in ─────────────────────────────────────────────────────────────

/**
 * Facts about the application that are not items, and cannot be.
 *
 * Every member is `boolean | null` and every member is REQUIRED, which is the
 * whole design. An optional member would be read as `undefined`, `undefined`
 * would be read as falsy, and "nothing requested an unknown URL" would silently
 * become "this application serves no 404 page" — a wrong fact, in the direction
 * that invents a finding. Making the key mandatory turns forgetting to fill it
 * in into a compile error, and `null` is the value that says we looked and
 * could not tell.
 *
 *   null   → nobody established this. Yields INDETERMINATE.
 *   false  → established as absent.
 *   true   → established as present.
 */
export interface CatalogueObservations {
  /**
   * An unknown URL was requested and the application answered with its own
   * not-found page. Only a crawl can establish this: a route table does not
   * declare the URL it does not serve.
   */
  notFoundPage: boolean | null;
  /** The application's own error page was observed for a server failure. */
  serverErrorPage: boolean | null;
  /**
   * The application sets cookies beyond what the session itself needs. The
   * trigger for consent handling, and `false` is a real answer: an application
   * with only a session cookie owes nobody a consent banner.
   */
  nonEssentialCookies: boolean | null;
  /**
   * Accounts are created by invitation rather than self-service. `true` makes
   * a missing signup page NOT_APPLICABLE instead of a finding, which is the
   * single most common false gap this catalogue could produce — most B2B
   * applications have no public registration and are right not to.
   */
  inviteOnlyAccounts: boolean | null;
}

/** An observations record that establishes nothing. Every verdict it can reach is honest. */
export const NOTHING_OBSERVED: CatalogueObservations = {
  notFoundPage: null,
  serverErrorPage: null,
  nonEssentialCookies: null,
  inviteOnlyAccounts: null,
};

export interface CatalogueEvidence {
  /**
   * The enumerated surface, from however many declarers produced it. Read for
   * both the triggers and the matchers.
   */
  items: readonly SurfaceItem[];
  /**
   * The declarers that participated AND SUCCEEDED. A source that was configured
   * and failed to load must not appear here: its silence would then be read as
   * its answer, which is the same defect `reconcile.ts` refuses in the large.
   */
  participated: readonly SurfaceSource[];
  observations: CatalogueObservations;
  /**
   * Whether the enumeration that produced `items` accounted for its own
   * completeness, and what it concluded. THREE-VALUED on purpose:
   *
   *   true   every discovered URL in scope was visited.
   *   false  a cap, a budget or a depth limit bit. The enumeration said so.
   *   null   the enumeration did not account for completeness at all — which
   *          is NOT the same as "it was complete", and must not be rendered as
   *          such. Every crawl written before the cap ledger existed is null.
   *
   * Anything other than `true` lowers the confidence of every UNMET by one
   * step and adds a caveat naming the reason, because an absence seen through a
   * truncated enumeration is a weaker claim.
   */
  enumerationComplete: boolean | null;
  /**
   * The lower bound on surface the enumeration knew about and did not reach,
   * when one was recorded. Null means no bound was recorded; it does not mean
   * zero. Printed in the caveat so the reader sees the cap as a COUNT and not
   * only as an adjective.
   */
  atLeastMoreSurfaces: number | null;
}

// ─── Results out ─────────────────────────────────────────────────────────────

export interface ExpectationResult {
  expectation: ExpectationId;
  label: string;
  /** The `SURFACE_KINDS` axis the missing thing would be counted on. */
  axis: SurfaceKind;
  verdict: ExpectationVerdict;
  /**
   * Qualifies UNMET only. Present on every row so a reader never has to guess
   * whether a blank means "certain" or "unrecorded", but meaningless elsewhere
   * — see the note on `EXPECTATION_CONFIDENCES`.
   */
  confidence: ExpectationConfidence;
  /**
   * The sentence that justifies the verdict, in the customer's terms: the
   * evidence that triggered the expectation, the reason it does not apply, or
   * the declarer whose absence made it undecidable. Same contract as
   * `SurfaceItem.evidence` — this is what makes a finding auditable rather than
   * asserted.
   */
  why: string;
  /** The enumerated item keys that satisfied it. Empty unless MET. */
  metBy: string[];
  /** The declarers that could evidence this expectation at all. */
  detectableBy: SurfaceSource[];
  /**
   * For INDETERMINATE: the declarers that would have been needed and did not
   * participate. Empty when the verdict is undecidable for another reason.
   */
  missingDeclarers: SurfaceSource[];
  /** What to do about an UNMET. Null when there is nothing to do. */
  remedy: string | null;
}

export interface ExpectedSurfaceReport {
  /**
   * Every expectation, always, in declaration order. A verdict is never
   * omitted: a reader who cannot see that we considered `SEARCH` cannot tell
   * whether we considered it and said no, or never looked.
   */
  results: ExpectationResult[];
  /** The findings — UNMET only, strongest confidence first. */
  unmet: ExpectationResult[];
  counts: {
    met: number;
    unmet: number;
    notApplicable: number;
    indeterminate: number;
  };
  participated: SurfaceSource[];
  /**
   * Declarers some expectation needed and did not get, deduplicated. The
   * actionable form of "we could not establish this": wire up a crawl and four
   * of these rows get a real verdict.
   */
  absentDeclarers: SurfaceSource[];
  /** Things a reader must know before quoting any row. Never empty by default. */
  caveats: string[];
}

// ─── Definitions ─────────────────────────────────────────────────────────────

/** What a trigger concluded. `applies: null` means it could not tell. */
interface TriggerVerdict {
  applies: boolean | null;
  why: string;
}

/**
 * A group of path tokens that together satisfy an expectation.
 *
 * ALL tokens in a group must be present, and the groups are alternatives. The
 * conjunction is not pedantry: `codebase.ts` already records that `/reset`
 * matches `/settings/reset-onboarding`, so a single-token `reset` rule would
 * report a password-reset page this application does not have — a false MET,
 * which hides a real gap and is just as damaging as a false UNMET in the other
 * direction.
 *
 * ─── AND YET A THIRD OF THE GROUPS BELOW HOLD ONE TOKEN ─────────────────────
 *
 * Because `['terms']`, `['privacy']`, `['health']` and the rest have no second
 * word to conjoin with: the thing is named by one word or it is not named at
 * all. The comment above was therefore true about the rule and false about the
 * file under it, and three false METs were demonstrable against a fixture app:
 *
 *   /glossary/search-terms   → TERMS_OF_SERVICE "present"
 *   /glossary/search-terms   → SEARCH "present"
 *   /health-coach/sessions   → HEALTH_CHECK "present"
 *
 * A fitness application was told it has a health endpoint because it has a
 * health coach. So a one-token group is matched against a SEGMENT rather than
 * against the whole path's token bag: the token must BE the segment, or the
 * segment's remaining words must all be qualifiers (`privacy-policy`,
 * `mfa-setup`, `health-check`, `logout-success`) rather than another noun. See
 * {@link QUALIFIER_TOKENS}, which is deliberately generous because the error it
 * prevents is a false GAP and that is the expensive one.
 */
type TokenGroup = readonly string[];

/**
 * Words that qualify the noun beside them instead of naming a second thing.
 *
 * The list errs LONG on purpose, and the asymmetry is the reason: a word
 * missing from it costs a MET (`/privacy-notice` read as no privacy policy — a
 * false gap, the error this whole file is organised against), while a word
 * wrongly ON it costs a false MET of the kind the three examples above show. A
 * noun that names a different feature — coach, search, orders, admin — must
 * never appear here.
 */
const QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  // Articles, prepositions and conjunctions, which hyphenated URLs keep:
  // /terms-of-service, /terms-and-conditions.
  'a', 'an', 'and', 'of', 'or', 'the', 'to', 'my', 'your', 'our',
  // The page a thing lives on.
  'page', 'pages', 'screen', 'view', 'index', 'home',
  // The document a thing is written in.
  'policy', 'policies', 'notice', 'notices', 'statement', 'agreement',
  'info', 'information', 'details', 'detail', 'faq', 'help', 'docs',
  // The act of configuring or doing it.
  'settings', 'setting', 'setup', 'configure', 'config', 'manage', 'edit', 'change',
  'new', 'create', 'add', 'start', 'begin', 'request', 'form', 'flow', 'wizard', 'step',
  'enroll', 'enrol', 'enrollment', 'enrolment', 'activate', 'enable',
  // How it ended.
  'complete', 'completed', 'success', 'successful', 'done', 'confirm', 'confirmed',
  'confirmation', 'callback', 'return', 'result', 'results', 'status', 'check', 'verify',
  // Service and API furniture.
  'service', 'services', 'api', 'v1', 'v2', 'v3', 'internal', 'public', 'use',
]);

/**
 * Exported because `EXPECTATIONS_IN_ORDER` is, and a public value whose type is
 * private is a value a consumer can read and cannot name — the API route that
 * renders the catalogue would have to re-declare this shape, which is how two
 * spellings of one vocabulary get started.
 */
export interface ExpectationDefinition {
  id: ExpectationId;
  label: string;
  axis: SurfaceKind;
  confidence: ExpectationConfidence;
  detectableBy: readonly SurfaceSource[];
  remedy: string | null;
  /** Satisfied when the enumeration holds an auth surface of one of these kinds. */
  satisfiedByAuthKind?: readonly AuthSurfaceKind[];
  /** Satisfied when a route or endpoint path contains every token of some group. */
  satisfiedByPath?: readonly TokenGroup[];
  /**
   * Satisfied by a recorded observation rather than by an item. Returns the
   * observation's own three states, so an inconclusive observation becomes
   * INDETERMINATE rather than a finding.
   */
  satisfiedByObservation?: (observations: CatalogueObservations) => boolean | null;
  trigger: (shape: AppShape) => TriggerVerdict;
}

/**
 * The catalogue.
 *
 * A `Record` keyed on the union, which is the compiler-enforced half of the
 * pattern this codebase requires for any vocabulary with readers: adding an id
 * to `EXPECTATION_IDS` without a definition breaks this line rather than
 * yielding an expectation that is silently never evaluated. The run-time half
 * is the parity test in surface-catalog.test.ts, which walks `EXPECTATION_IDS`
 * and asserts each entry exists and declares at least one satisfaction
 * mechanism. Both exist because each catches what the other cannot — eight
 * `GateRule` kinds shipped unsaveable for two slices with only one of the two
 * in place.
 */
const EXPECTATIONS: Record<ExpectationId, ExpectationDefinition> = {
  NOT_FOUND_PAGE: {
    id: 'NOT_FOUND_PAGE',
    label: 'A not-found page for an unknown URL',
    axis: 'ERROR_STATE',
    confidence: 'HIGH',
    // Only a crawl can establish this. A route table declares the URLs the
    // application serves; it cannot declare what happens at a URL it does not.
    detectableBy: ['CRAWL'],
    remedy: 'request a URL the application does not serve and assert its own not-found page answers',
    satisfiedByObservation: (observations) => observations.notFoundPage,
    trigger: (shape) =>
      shape.routeCount > 0
        ? {
            applies: true,
            why: `${shape.routeCount} route(s) were enumerated, so some URL outside that set will be requested`,
          }
        : {
            applies: false,
            why: 'no route was enumerated, so there is no URL space for an unknown URL to fall outside of',
          },
  },

  SERVER_ERROR_PAGE: {
    id: 'SERVER_ERROR_PAGE',
    label: 'An error page for a server failure',
    axis: 'ERROR_STATE',
    // MEDIUM and not HIGH: plenty of applications correctly let the platform
    // render a 5xx, and we cannot see a platform error page from here.
    confidence: 'MEDIUM',
    detectableBy: ['CRAWL'],
    remedy: 'confirm a server failure renders the application error page rather than a stack trace',
    satisfiedByObservation: (observations) => observations.serverErrorPage,
    trigger: (shape) =>
      shape.routeCount > 0
        ? { applies: true, why: `${shape.routeCount} route(s) were enumerated and any of them can fail` }
        : { applies: false, why: 'no route was enumerated, so no request can fail' },
  },

  PASSWORD_RESET: {
    id: 'PASSWORD_RESET',
    label: 'A password-reset flow',
    axis: 'AUTH_SURFACE',
    confidence: 'HIGH',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'add a password-recovery route, or record that recovery is handled outside this application',
    satisfiedByAuthKind: ['PASSWORD_RESET'],
    satisfiedByPath: [
      ['password', 'reset'],
      ['forgot', 'password'],
      ['recover', 'password'],
    ],
    /*
     * The SSO branch is the single most important NOT_APPLICABLE in this file.
     * An application whose only authentication is an identity provider has no
     * password of its own, so "you are missing password reset" is false AND
     * condescending — the exact sentence that makes a prospect discard the
     * whole report. The LOGIN check comes first because an application with
     * both has a local password that someone will forget.
     */
    trigger: (shape) => {
      if (shape.authKinds.has('LOGIN')) {
        return { applies: true, why: 'a login surface was enumerated, so some user will forget a password' };
      }
      if (shape.authKinds.has('SSO')) {
        return {
          applies: false,
          why: 'authentication is delegated to an identity provider; password recovery belongs to that provider, not to this application',
        };
      }
      return { applies: false, why: 'no login surface was enumerated, so there is no password to reset' };
    },
  },

  SIGNUP: {
    id: 'SIGNUP',
    label: 'A self-service signup',
    axis: 'AUTH_SURFACE',
    /*
     * LOW on purpose, and the lowest-confidence HIGH-value row in the file.
     * A great many applications are invite-only by design, so this expectation
     * is the one most likely to be wrong. It ships anyway because the opposite
     * failure — never mentioning that an application has a login and no way to
     * get an account — is a real gap in a consumer product. Low confidence plus
     * a named reason is the honest way to raise it.
     */
    confidence: 'LOW',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'confirm whether accounts are self-service; if they are created by invitation, record that',
    satisfiedByAuthKind: ['SIGNUP'],
    satisfiedByPath: [['signup'], ['register'], ['registration'], ['sign', 'up']],
    trigger: (shape) => {
      if (!shape.authKinds.has('LOGIN') && !shape.authKinds.has('SSO')) {
        return { applies: false, why: 'no login surface was enumerated, so there are no accounts to create' };
      }
      if (shape.observations.inviteOnlyAccounts === true) {
        return { applies: false, why: 'accounts are created by invitation, which was recorded for this project' };
      }
      if (shape.observations.inviteOnlyAccounts === null) {
        return {
          applies: true,
          why: 'a login surface was enumerated and nothing records whether accounts are invitation-only',
        };
      }
      return { applies: true, why: 'a login surface was enumerated and accounts are not invitation-only' };
    },
  },

  EMAIL_VERIFICATION: {
    id: 'EMAIL_VERIFICATION',
    label: 'Email-address verification',
    axis: 'AUTH_SURFACE',
    confidence: 'MEDIUM',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'verify the address a self-service signup collects, or record that verification is deliberate to omit',
    satisfiedByAuthKind: ['VERIFY'],
    satisfiedByPath: [
      ['verify', 'email'],
      ['email', 'verification'],
      ['confirm', 'email'],
      ['verify', 'account'],
    ],
    trigger: (shape) =>
      shape.authKinds.has('SIGNUP')
        ? { applies: true, why: 'a signup surface was enumerated, so this application collects addresses it has not verified' }
        : {
            applies: false,
            why: 'no self-service signup was enumerated, so no unverified address is collected at this surface',
          },
  },

  LOGOUT: {
    id: 'LOGOUT',
    label: 'A way to end the session',
    axis: 'AUTH_SURFACE',
    confidence: 'HIGH',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'add a logout surface',
    satisfiedByAuthKind: ['LOGOUT'],
    satisfiedByPath: [['logout'], ['signout'], ['sign', 'out'], ['log', 'out']],
    trigger: (shape) =>
      shape.authKinds.has('LOGIN') || shape.authKinds.has('SSO')
        ? { applies: true, why: 'an authentication surface was enumerated, so a session exists that must be endable' }
        : { applies: false, why: 'no authentication surface was enumerated, so there is no session to end' },
  },

  MFA: {
    id: 'MFA',
    label: 'A second authentication factor',
    axis: 'AUTH_SURFACE',
    confidence: 'MEDIUM',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'offer a second factor on the accounts that can reach privileged surface',
    satisfiedByPath: [['mfa'], ['2fa'], ['totp'], ['two', 'factor'], ['authenticator']],
    /*
     * Gated on PRIVILEGED surface rather than on a login, which is what keeps
     * this from firing on every brochure site with a members' area. "You have
     * an admin area and no second factor" is a defensible sentence; "you have a
     * login and no second factor" is a lecture, and most applications will
     * rightly ignore it.
     */
    trigger: (shape) => {
      if (!shape.authKinds.has('LOGIN') && !shape.authKinds.has('SSO')) {
        return { applies: false, why: 'no authentication surface was enumerated' };
      }
      if (!shape.privilegedPath) {
        return {
          applies: false,
          why: 'no privileged surface was enumerated; a second factor is a product decision here rather than an expected control',
        };
      }
      return {
        applies: true,
        why: `authentication and privileged surface were both enumerated (${shape.privilegedPath})`,
      };
    },
  },

  ACCOUNT_DELETION: {
    id: 'ACCOUNT_DELETION',
    label: 'Self-service account deletion',
    axis: 'ROUTE',
    confidence: 'MEDIUM',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'let a self-service account be closed without contacting support',
    satisfiedByPath: [
      ['delete', 'account'],
      ['account', 'deletion'],
      ['close', 'account'],
      ['deactivate', 'account'],
    ],
    trigger: (shape) =>
      shape.authKinds.has('SIGNUP')
        ? { applies: true, why: 'accounts are self-service, so closing one is expected to be self-service too' }
        : { applies: false, why: 'no self-service signup was enumerated, so account closure is an operator task' },
  },

  DATA_EXPORT: {
    id: 'DATA_EXPORT',
    label: 'A data export for the account holder',
    axis: 'ROUTE',
    // LOW: the matcher is the weakest in the file — an export surface can be a
    // button inside a settings page with no path of its own.
    confidence: 'LOW',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'confirm whether an account holder can obtain their own data, by export or on request',
    satisfiedByPath: [
      ['export', 'data'],
      ['data', 'export'],
      ['download', 'data'],
      ['export', 'account'],
    ],
    trigger: (shape) =>
      shape.authKinds.has('SIGNUP')
        ? { applies: true, why: 'accounts are self-service, so the data in them belongs to someone who may ask for it' }
        : { applies: false, why: 'no self-service signup was enumerated, so data requests are an operator task' },
  },

  CONSENT_COOKIE: {
    id: 'CONSENT_COOKIE',
    label: 'Consent handling for non-essential cookies',
    axis: 'ROUTE',
    confidence: 'MEDIUM',
    detectableBy: ['CRAWL', 'SOURCE', 'MANUAL'],
    remedy: 'obtain consent before setting the cookies that are not needed for the session',
    satisfiedByPath: [['cookie', 'policy'], ['cookie', 'consent'], ['consent'], ['cookies']],
    /*
     * The only trigger driven entirely by an observation, and the only one that
     * can return `applies: null`. Whether an application sets tracking cookies
     * is not readable from a route table, so when nothing established it the
     * answer is INDETERMINATE — not a finding, and not a clean bill either.
     */
    trigger: (shape) => {
      const cookies = shape.observations.nonEssentialCookies;
      if (cookies === true) {
        return { applies: true, why: 'cookies beyond the session were observed, so consent is required before they are set' };
      }
      if (cookies === false) {
        return { applies: false, why: 'only session-essential cookies were observed, so no consent is owed' };
      }
      return {
        applies: null,
        why: 'nothing established whether this application sets cookies beyond the session',
      };
    },
  },

  TERMS_OF_SERVICE: {
    id: 'TERMS_OF_SERVICE',
    label: 'Terms a user can read',
    axis: 'ROUTE',
    confidence: 'MEDIUM',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'publish the terms the signup flow asks users to accept',
    satisfiedByPath: [['terms'], ['tos'], ['eula'], ['terms', 'conditions']],
    trigger: (shape) =>
      shape.authKinds.has('SIGNUP')
        ? { applies: true, why: 'a self-service signup was enumerated, so users are entering an agreement here' }
        : { applies: false, why: 'no self-service signup was enumerated, so nobody accepts terms at this surface' },
  },

  PRIVACY_POLICY: {
    id: 'PRIVACY_POLICY',
    label: 'A privacy policy',
    axis: 'ROUTE',
    confidence: 'MEDIUM',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: 'publish what is done with the personal data a signup collects',
    satisfiedByPath: [['privacy']],
    trigger: (shape) =>
      shape.authKinds.has('SIGNUP')
        ? { applies: true, why: 'a self-service signup was enumerated, so personal data is being collected' }
        : { applies: false, why: 'no self-service signup was enumerated, so no personal data is collected at this surface' },
  },

  SESSION_TIMEOUT: {
    id: 'SESSION_TIMEOUT',
    label: 'A session that expires',
    axis: 'AUTH_SURFACE',
    // LOW because our evidence is poor in both directions: a declared session
    // surface is weak proof of an idle timeout, and its absence is weaker proof
    // of none. The remedy says so rather than pretending otherwise.
    confidence: 'LOW',
    // A crawl cannot sit still for thirty minutes, so CRAWL is deliberately
    // absent here: without a source read this row is INDETERMINATE, which is
    // the true answer.
    detectableBy: ['SOURCE', 'REQUIREMENT', 'MANUAL'],
    remedy: 'confirm sessions expire; QAAI can only see a session surface the source declares',
    satisfiedByAuthKind: ['SESSION'],
    satisfiedByPath: [
      ['session', 'timeout'],
      ['session', 'expired'],
      ['session', 'refresh'],
      ['refresh', 'token'],
    ],
    trigger: (shape) =>
      shape.authKinds.has('LOGIN') || shape.authKinds.has('SSO')
        ? { applies: true, why: 'an authentication surface was enumerated, so sessions are issued' }
        : { applies: false, why: 'no authentication surface was enumerated, so no session is issued' },
  },

  SEARCH: {
    id: 'SEARCH',
    label: 'Search',
    axis: 'ROUTE',
    confidence: 'LOW',
    detectableBy: ['SOURCE', 'CRAWL', 'SITEMAP', 'MANUAL'],
    remedy: null,
    satisfiedByPath: [['search']],
    /*
     * Deliberately never triggered, and this is the worked example of the
     * restraint the header describes. If a search path exists, satisfaction
     * fires first and the row reads MET. If one does not, we have no evidence
     * that this application HAS a corpus worth searching — so an UNMET would be
     * us inventing a requirement. The row still appears, as NOT_APPLICABLE with
     * this reason, because a reader who cannot see that we considered search
     * cannot tell whether we considered it or forgot it.
     */
    trigger: () => ({
      applies: false,
      why: 'nothing enumerated establishes a searchable corpus; an application with no search is making a product decision, not leaving a gap',
    }),
  },

  HEALTH_CHECK: {
    id: 'HEALTH_CHECK',
    label: 'A health-check endpoint',
    axis: 'ENDPOINT',
    // LOW: a health check is just as often a platform concern configured
    // outside the repository, where we cannot see it.
    confidence: 'LOW',
    detectableBy: ['SOURCE', 'OPENAPI', 'CRAWL', 'MANUAL'],
    remedy: 'expose a health endpoint, or record that liveness is checked by the platform',
    satisfiedByPath: [['health'], ['healthz'], ['readyz'], ['livez'], ['ping'], ['heartbeat']],
    trigger: (shape) =>
      shape.endpointCount > 0
        ? { applies: true, why: `${shape.endpointCount} HTTP endpoint(s) were enumerated, so something is serving them` }
        : {
            applies: false,
            why: 'no HTTP endpoint was enumerated; liveness is a deployment concern for an application with no API surface',
          },
  },
};

/** Every definition, in declaration order. */
export const EXPECTATIONS_IN_ORDER: readonly ExpectationDefinition[] = EXPECTATION_IDS.map(
  (id) => EXPECTATIONS[id],
);

// ─── Shape: what the enumerated items say about the application ──────────────

/** One enumerated path, with its tokens precomputed and its item key kept. */
interface PathFact {
  key: string;
  path: string;
  /** Every token in the whole path, for the multi-token groups. */
  tokens: ReadonlySet<string>;
  /** The same tokens, kept per segment, for the one-token groups. */
  segments: ReadonlySet<string>[];
}

/**
 * The derived facts the triggers and matchers read.
 *
 * Derived rather than taken as input, so there is exactly one place that knows
 * how an auth kind is read off an item and one place that decides what counts
 * as a privileged path. Two callers deriving these independently is how two
 * screens come to disagree about whether an application has a login.
 */
interface AppShape {
  authKinds: ReadonlySet<AuthSurfaceKind>;
  /** Item keys for each auth kind, so a MET row can name what satisfied it. */
  authKeys: ReadonlyMap<AuthSurfaceKind, string[]>;
  routeCount: number;
  endpointCount: number;
  paths: readonly PathFact[];
  /** The privileged path that triggered MFA, or null. Named, so the row can quote it. */
  privilegedPath: string | null;
  observations: CatalogueObservations;
  participated: ReadonlySet<SurfaceSource>;
}

/**
 * Path tokens: segments split on the separators a URL actually uses.
 *
 * `:param` and `*` are dropped — they are the canonicaliser's placeholders for
 * a value, not words the application chose, and leaving them in would let a
 * token group match on a parameter.
 */
export function pathTokens(path: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of path.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    if (raw === 'param') continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * The same tokens, kept per path segment.
 *
 * A one-token group is matched against these rather than against the whole
 * path's bag, which is what stops `/glossary/search-terms` satisfying
 * `['terms']`. Built from `pathTokens` segment by segment so there is one
 * tokeniser and not two — `:param` is dropped by that function, so a parameter
 * segment contributes an EMPTY set and can satisfy nothing.
 */
export function pathSegmentTokens(path: string): Set<string>[] {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => pathTokens(segment));
}

/**
 * True when some group is satisfied, and it returns the group so the row can
 * quote what matched. See {@link TokenGroup} for why the two arities differ.
 *
 *   two or more tokens   every token appears SOMEWHERE in the path, in any
 *                        order and any segment: `/auth/forgot-password`,
 *                        `/password/reset`.
 *   exactly one token    the token must be a SEGMENT, or a segment all of whose
 *                        other words are qualifiers: `/health`, `/api/health`,
 *                        `/health-check` yes; `/health-coach` no.
 */
function matchesAnyGroup(fact: PathFact, groups: readonly TokenGroup[]): TokenGroup | null {
  for (const group of groups) {
    if (group.length === 0) continue;
    if (group.length > 1) {
      if (group.every((token) => fact.tokens.has(token))) return group;
      continue;
    }
    const token = group[0];
    if (token === undefined) continue;
    const named = fact.segments.some(
      (segment) =>
        segment.has(token) &&
        [...segment].every((word) => word === token || QUALIFIER_TOKENS.has(word)),
    );
    if (named) return group;
  }
  return null;
}

/**
 * Words that mark a path as privileged.
 *
 * Deliberately short. A longer list ('internal', 'manage', 'console') produces
 * privileged-surface claims for ordinary user settings pages, and the only
 * consumer of this fact is the MFA expectation, where a false trigger yields a
 * security lecture an application does not need.
 *
 * A privileged ROLE row would be stronger evidence than a path — `ROLE`'s
 * `DimensionDetail` carries `privileged` exactly for this — but the dimension
 * table is not an input here, so the path is what we have. Stated rather than
 * silently approximated.
 */
const PRIVILEGED_TOKENS: readonly string[] = ['admin', 'admins', 'administrator', 'backoffice', 'superadmin'];

/**
 * Reads the auth-surface kind off an item.
 *
 * From the KEY, not from `meta.authKind`, and the choice matters: `meta` is
 * optional on `SurfaceItem` and absent on every `CoverageItem` row written
 * before it existed, whereas the key is the item's identity and is always
 * there. `authSurfaceIdentity` in surface-inventory.ts spells it `KIND@path`,
 * and the kind is validated against `AUTH_SURFACE_KINDS` so a key we do not
 * recognise yields null rather than a forged kind.
 */
export function authKindOfItem(item: Pick<SurfaceItem, 'kind' | 'key'>): AuthSurfaceKind | null {
  if (item.kind !== 'AUTH_SURFACE') return null;
  const parsed = parseSurfaceKey(item.key);
  if (parsed === null) return null;
  const at = parsed.identity.indexOf('@');
  const raw = at <= 0 ? parsed.identity : parsed.identity.slice(0, at);
  return (AUTH_SURFACE_KINDS as readonly string[]).includes(raw) ? (raw as AuthSurfaceKind) : null;
}

/**
 * The path an item occupies, for token matching, or null when it has none.
 *
 * ENDPOINT identities are `METHOD path`, so the method is stripped before
 * canonicalising — otherwise `GET` and `POST` would become path tokens and a
 * group could match on a verb.
 */
function pathOfItem(item: Pick<SurfaceItem, 'kind' | 'key' | 'label'>): string | null {
  const parsed = parseSurfaceKey(item.key);
  const identity = parsed?.identity ?? item.label;
  if (item.kind === 'ROUTE') return canonicalRoute(identity);
  if (item.kind === 'ENDPOINT') {
    const space = identity.indexOf(' ');
    return canonicalRoute(space < 0 ? identity : identity.slice(space + 1));
  }
  if (item.kind === 'AUTH_SURFACE') {
    const at = identity.indexOf('@');
    return at < 0 ? null : canonicalRoute(identity.slice(at + 1));
  }
  return null;
}

function buildShape(evidence: CatalogueEvidence): AppShape {
  const authKinds = new Set<AuthSurfaceKind>();
  const authKeys = new Map<AuthSurfaceKind, string[]>();
  const paths: PathFact[] = [];
  let routeCount = 0;
  let endpointCount = 0;
  let privilegedPath: string | null = null;

  for (const item of evidence.items) {
    if (item.kind === 'ROUTE') routeCount += 1;
    if (item.kind === 'ENDPOINT') endpointCount += 1;

    const authKind = authKindOfItem(item);
    if (authKind !== null) {
      authKinds.add(authKind);
      const existing = authKeys.get(authKind);
      if (existing === undefined) authKeys.set(authKind, [item.key]);
      else existing.push(item.key);
    }

    const path = pathOfItem(item);
    if (path === null) continue;
    const tokens = pathTokens(path);
    paths.push({ key: item.key, path, tokens, segments: pathSegmentTokens(path) });
    if (privilegedPath === null && PRIVILEGED_TOKENS.some((token) => tokens.has(token))) {
      privilegedPath = path;
    }
  }

  return {
    authKinds,
    authKeys,
    routeCount,
    endpointCount,
    paths,
    privilegedPath,
    observations: evidence.observations,
    participated: new Set(evidence.participated),
  };
}

// ─── Satisfaction ────────────────────────────────────────────────────────────

/** Three-valued, for the same reason the observations are. */
interface Satisfaction {
  met: boolean | null;
  keys: string[];
  why: string;
}

/**
 * Whether the enumerated surface already holds the expected thing.
 *
 * Order is auth kind, then path, then observation, and an item wins over an
 * observation because an item is the stronger evidence: it has a key, a file
 * and an evidence sentence of its own.
 *
 * AN ITEM SATISFIES THIS EXPECTATION WHATEVER ITS EXERCISABILITY. A logout
 * route the crawl REFUSED still proves the application has a logout — the
 * refusal is a fact about our harness, not about the application — so nothing
 * here reads `item.exercise`. Filtering refused items out would report a
 * missing logout to every customer whose crawl policy excluded `/logout`,
 * which is all of them.
 */
function satisfy(definition: ExpectationDefinition, shape: AppShape): Satisfaction {
  if (definition.satisfiedByAuthKind !== undefined) {
    for (const kind of definition.satisfiedByAuthKind) {
      if (!shape.authKinds.has(kind)) continue;
      return {
        met: true,
        keys: shape.authKeys.get(kind) ?? [],
        why: `a ${kind} auth surface was enumerated`,
      };
    }
  }

  if (definition.satisfiedByPath !== undefined) {
    const hits: string[] = [];
    let quoted: string | null = null;
    let matched: TokenGroup | null = null;
    for (const fact of shape.paths) {
      const group = matchesAnyGroup(fact, definition.satisfiedByPath);
      if (group === null) continue;
      hits.push(fact.key);
      if (quoted === null) {
        quoted = fact.path;
        matched = group;
      }
    }
    if (quoted !== null && matched !== null) {
      return {
        met: true,
        keys: hits,
        why: `${quoted} was enumerated and carries ${matched.join(' + ')}`,
      };
    }
  }

  if (definition.satisfiedByObservation !== undefined) {
    const observed = definition.satisfiedByObservation(shape.observations);
    if (observed === true) return { met: true, keys: [], why: 'an observation recorded it as present' };
    if (observed === null) {
      return { met: null, keys: [], why: 'the observation that would establish this was inconclusive' };
    }
    return { met: false, keys: [], why: 'an observation recorded it as absent' };
  }

  return { met: false, keys: [], why: 'nothing in the enumerated surface matches it' };
}

// ─── Confidence ──────────────────────────────────────────────────────────────

/**
 * One step down, floored at LOW.
 *
 * Applied to an UNMET when the enumeration disclosed that it did not finish.
 * An absence is only as strong as the search that failed to find it, and a
 * report that gave a truncated 60-page crawl the same confidence as a converged
 * one would be applying a cap without disclosing it — in the direction that
 * manufactures findings.
 */
export function downgradeConfidence(confidence: ExpectationConfidence): ExpectationConfidence {
  if (confidence === 'HIGH') return 'MEDIUM';
  if (confidence === 'MEDIUM') return 'LOW';
  return 'LOW';
}

const CONFIDENCE_RANK: Record<ExpectationConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// ─── The matcher ─────────────────────────────────────────────────────────────

/**
 * Matches the enumerated surface against the catalogue.
 *
 * ── THE ORDER OF THE FIVE CHECKS IS THE WHOLE ALGORITHM ─────────────────────
 *
 *   1. SATISFIED → MET. An expectation we can see fulfilled needs no trigger
 *      argument, and checking this first is what keeps a deliberately
 *      untriggered expectation like SEARCH from reading NOT_APPLICABLE on an
 *      application that plainly has search.
 *
 *   2. NO DECLARER THAT COULD HAVE SEEN IT PARTICIPATED → INDETERMINATE. Ahead
 *      of the trigger, because a declarer that could not see the thing probably
 *      could not see the thing's trigger either. Without this step an
 *      evaluation against an empty enumeration would conclude NOT_APPLICABLE
 *      for every expectation — "no login was enumerated, so no password to
 *      reset" — which reads as a clean bill of health for an application nobody
 *      looked at.
 *
 *   3. TRIGGER SAYS NO → NOT_APPLICABLE, with the trigger's reason.
 *   4. TRIGGER CANNOT TELL → INDETERMINATE.
 *   5. SATISFACTION WAS INCONCLUSIVE → INDETERMINATE. After the trigger,
 *      because "this application does not need one" is a better answer than
 *      "we could not tell whether it has one".
 *
 * Anything that survives all five is UNMET, which is the only verdict this
 * function is allowed to call a finding.
 */
export function matchExpectedSurface(evidence: CatalogueEvidence): ExpectedSurfaceReport {
  const shape = buildShape(evidence);
  const incomplete = evidence.enumerationComplete !== true;
  const results: ExpectationResult[] = [];

  for (const definition of EXPECTATIONS_IN_ORDER) {
    const detectableBy = [...definition.detectableBy];
    const base: Omit<ExpectationResult, 'verdict' | 'why' | 'metBy' | 'missingDeclarers' | 'confidence'> = {
      expectation: definition.id,
      label: definition.label,
      axis: definition.axis,
      detectableBy,
      remedy: definition.remedy,
    };
    const satisfaction = satisfy(definition, shape);

    // 1 ── found it.
    if (satisfaction.met === true) {
      results.push({
        ...base,
        verdict: 'MET',
        confidence: definition.confidence,
        why: satisfaction.why,
        metBy: satisfaction.keys,
        missingDeclarers: [],
      });
      continue;
    }

    // 2 ── nothing that could have seen it ran.
    const present = detectableBy.filter((source) => shape.participated.has(source));
    if (present.length === 0) {
      results.push({
        ...base,
        verdict: 'INDETERMINATE',
        confidence: definition.confidence,
        why:
          `not established: this needs ${detectableBy
            .map((source) => SURFACE_SOURCE_LABELS[source])
            .join(' or ')}, and no such declarer participated`,
        metBy: [],
        missingDeclarers: detectableBy,
      });
      continue;
    }

    const trigger = definition.trigger(shape);

    // 3 ── this application is not the shape that expects it.
    if (trigger.applies === false) {
      results.push({
        ...base,
        verdict: 'NOT_APPLICABLE',
        confidence: definition.confidence,
        why: trigger.why,
        metBy: [],
        missingDeclarers: [],
      });
      continue;
    }

    // 4 ── we cannot tell whether it applies.
    if (trigger.applies === null) {
      results.push({
        ...base,
        verdict: 'INDETERMINATE',
        confidence: definition.confidence,
        why: trigger.why,
        metBy: [],
        missingDeclarers: [],
      });
      continue;
    }

    // 5 ── it applies, and our look for it was inconclusive.
    if (satisfaction.met === null) {
      results.push({
        ...base,
        verdict: 'INDETERMINATE',
        confidence: definition.confidence,
        why: `${trigger.why}; ${satisfaction.why}`,
        metBy: [],
        missingDeclarers: [],
      });
      continue;
    }

    results.push({
      ...base,
      verdict: 'UNMET',
      confidence: incomplete ? downgradeConfidence(definition.confidence) : definition.confidence,
      why: trigger.why,
      metBy: [],
      missingDeclarers: [],
    });
  }

  const unmet = results
    .filter((result) => result.verdict === 'UNMET')
    .sort((left, right) => CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence]);

  const absentDeclarers: SurfaceSource[] = [];
  for (const result of results) {
    for (const source of result.missingDeclarers) {
      if (!absentDeclarers.includes(source)) absentDeclarers.push(source);
    }
  }

  return {
    results,
    unmet,
    counts: {
      met: results.filter((result) => result.verdict === 'MET').length,
      unmet: unmet.length,
      notApplicable: results.filter((result) => result.verdict === 'NOT_APPLICABLE').length,
      indeterminate: results.filter((result) => result.verdict === 'INDETERMINATE').length,
    },
    participated: [...evidence.participated],
    absentDeclarers,
    caveats: catalogueCaveats(evidence, results, incomplete),
  };
}

/**
 * The sentences a reader must have before quoting a row.
 *
 * Never empty: an expectation report with no caveats would be claiming that
 * fifteen heuristics over a partial enumeration are beyond question. The last
 * line is always there and says what the catalogue is.
 */
function catalogueCaveats(
  evidence: CatalogueEvidence,
  results: readonly ExpectationResult[],
  incomplete: boolean,
): string[] {
  const caveats: string[] = [];

  if (evidence.participated.length === 0) {
    caveats.push(
      'no declarer participated, so nothing here is a finding: every expectation is reported as not established',
    );
  }

  if (incomplete) {
    const bound =
      evidence.atLeastMoreSurfaces !== null
        ? `at least ${evidence.atLeastMoreSurfaces} more surface(s) were known and not enumerated`
        : 'no lower bound on the unenumerated remainder was recorded';
    const why =
      evidence.enumerationComplete === false
        ? 'the enumeration disclosed that it stopped early'
        : 'the enumeration did not account for its own completeness, which is not the same as being complete';
    caveats.push(
      `${why} — ${bound}; every "expected and not found" below has had its confidence lowered one step because an absence is only as strong as the search that missed it`,
    );
  }

  const indeterminate = results.filter((result) => result.verdict === 'INDETERMINATE').length;
  if (indeterminate > 0) {
    caveats.push(
      `${indeterminate} expectation(s) could not be established and are NOT counted as gaps; each row names the declarer that would decide it`,
    );
  }

  caveats.push(
    'these are expectations for an application of this shape, each triggered by named evidence — not a compliance checklist, and a "not found" row may be a deliberate product decision',
  );
  return caveats;
}
