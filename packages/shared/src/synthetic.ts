/**
 * The synthetic data factory (§2) — deterministic values keyed on what a field
 * actually wants and bounded by what the page actually allows.
 *
 * THE DEFECT THIS FIXES: three separate comments in this repo promised a
 * "faker-based synthetic data generator" (`flow-map.ts` on FormField.semantic,
 * `crawler.ts` on semanticFor, `codebase.ts` on inferSemantic) and no such
 * thing existed. With nothing to call, the model invented literals inline, and
 * invented literals have two properties that make a suite rot:
 *
 *   1. NO UNIQUENESS. Two signup tests both get "test@example.com", the second
 *      hits the unique constraint, and the failure reads as an application bug.
 *   2. NO DETERMINISM. The value changes between generations, so a test that
 *      passed yesterday fails today and the diff shows nothing.
 *
 * Both are fixed by the same mechanism: every value is a pure function of
 * (seed, scope, field). Same inputs, same value, forever — and a different
 * field is a different input, so two fields in one form cannot collide.
 *
 * ─── Why no faker ───────────────────────────────────────────────────────────
 *
 * faker is ~5MB, and this package is the one the web app's bundler consumes
 * (see the note at the top of `index.ts`). More importantly faker's own seeded
 * output is stable only within a major version, so a dependency bump would
 * silently rewrite every value in every suite — which is the determinism defect
 * again, arriving via package.json. The generation here is a ~15-line PRNG and
 * a few word lists, and it will produce the same strings in ten years.
 *
 * ─── What this deliberately does NOT do ─────────────────────────────────────
 *
 * It does not invert regexes. Generating a string that satisfies an arbitrary
 * `pattern` is not a thing a few hundred lines can do correctly, so instead it
 * TRIES a short list of real-world formats for the field's semantic, checks
 * them against the pattern, and — when none match — says so in
 * `unsatisfiable` rather than returning a value that will be rejected and
 * blaming the application. An honest "I could not satisfy this pattern" is
 * actionable; a plausible value that fails validation is a day of debugging.
 */

import type { FormFieldSemantic } from './flow-map';
import { cardForOutcome } from './test-values';

// ─── The frozen clock ────────────────────────────────────────────────────────

/**
 * Wall-clock time is the other half of the determinism defect, and the sneakier
 * half: a date generated from `new Date()` makes a test that passed yesterday
 * fail today, and nothing in the diff explains it. So every date here is
 * derived from ONE constant.
 *
 * The cost is honest and stated rather than hidden: a card expiry derived from
 * this clock stops being a future date eventually. `CARD_EXPIRY_YEARS_AHEAD`
 * below puts that moment in 2034, and this constant is the single line to bump.
 * Callers who would rather have fresh dates than reproducible ones pass `now`
 * and accept that their values change day to day — which is a trade they should
 * make explicitly, in their own code, not one this module makes for them.
 */
export const SYNTHETIC_CLOCK = '2026-06-15T12:00:00.000Z';

/** Far enough ahead that a generated expiry is in the future. See the note above. */
const CARD_EXPIRY_YEARS_AHEAD = 8;

/**
 * RFC 2606 reserves example.com and it can never be registered, so no address
 * here can reach a human — which is the whole requirement for a signup test.
 * A real-looking address at a real domain is a stranger's inbox.
 */
export const SYNTHETIC_EMAIL_DOMAIN = 'example.com';

/** Shortest reserved fallback, for a maxlength too small for the default domain. */
const SHORT_EMAIL_DOMAIN = 'qa.test'; // .test is RFC 6761-reserved.

// ─── Seeded randomness ───────────────────────────────────────────────────────

/**
 * FNV-1a, 32-bit. Turns the (seed, scope, field) tuple into the PRNG's seed, so
 * the value depends on WHICH field it is and not on the order fields were
 * visited in. Order-dependence would mean inserting a field at the top of a
 * form rewrote every value below it, and a suite that re-randomises on an
 * unrelated markup change is a suite nobody trusts.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — the same algorithm `packages/runner/src/determinism.ts` uses.
 *
 * Duplicated rather than imported ON PURPOSE: `runner` depends on `shared`, so
 * importing the other way would be a cycle, and this package is the one the web
 * bundler eats. Ten lines of arithmetic with a fixed output is the cheapest
 * thing in this repo to duplicate, and it means a value generated here and a
 * run order chosen there are reproducible by the same mechanism.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)] ?? list[0]!;
}

function intBetween(low: number, high: number, rng: () => number): number {
  if (high <= low) return low;
  return low + Math.floor(rng() * (high - low + 1));
}

// ─── Word lists ──────────────────────────────────────────────────────────────

/*
 * Short, invented, and recognisably not a real person or a real street.
 *
 * Deliberately NOT a big realistic corpus. Synthetic data ends up in a staging
 * database, in a screenshot attached to a bug report, and sometimes in an
 * email; a value that looks like a real customer gets treated like one. These
 * read as fixtures at a glance, which is the property that matters.
 */
const FIRST_NAMES = [
  'Ada',
  'Bram',
  'Cleo',
  'Dara',
  'Esme',
  'Finn',
  'Gale',
  'Hana',
  'Idris',
  'Juno',
  'Kai',
  'Lior',
  'Mira',
  'Nael',
  'Oona',
  'Pax',
] as const;

const LAST_NAMES = [
  'Ashby',
  'Blyth',
  'Calder',
  'Dunmore',
  'Ellery',
  'Fairhaven',
  'Garrow',
  'Hollis',
  'Ingram',
  'Jessop',
  'Kettle',
  'Loxley',
  'Marchetti',
  'Novak',
  'Oakhurst',
  'Pendry',
] as const;

const STREETS = [
  'Alder Lane',
  'Birchwood Road',
  'Cobbler Street',
  'Dunlin Way',
  'Elmgrove Avenue',
  'Fennel Close',
  'Granary Road',
  'Hawthorn Street',
] as const;

const CITIES = [
  'Ashford Vale',
  'Brimley',
  'Castleton Rise',
  'Dunmere',
  'Easthollow',
  'Fairwater',
  'Glenmoor',
  'Harwick',
] as const;

const WORDS = [
  'anchor',
  'bramble',
  'cobalt',
  'driftwood',
  'ember',
  'fathom',
  'granite',
  'harbour',
  'inlet',
  'juniper',
  'kestrel',
  'lantern',
] as const;

// ─── Uniqueness and cleanup: the contract half of this module ────────────────

/*
 * WHAT WAS MISSING, AND WHY IT IS A CONTRACT RATHER THAN MORE GENERATION.
 *
 * Everything above this line generates values well: seeded, pure, bounded by
 * what the page declared. What it could not do is tell a caller WHAT KIND OF
 * UNIQUENESS a value has, or WHETHER USING IT LEAVES A ROW BEHIND. Both are
 * facts the generator already knows — they fall straight out of the semantic —
 * and neither reached the caller, so every consumer had to guess.
 *
 * The cost of guessing, in the two directions:
 *
 *   · A value treated as more unique than it is collides. The run's third
 *     signup test reuses a reusable city name as though it were a fresh
 *     identifier, hits a unique constraint, and the failure reads as an
 *     application bug.
 *   · A value treated as less unique than it is is thrown away and regenerated,
 *     which costs the determinism the whole file is built on.
 *
 * And the cost of not stating cleanup is a staging database that fills with
 * rows nobody can attribute, until a customer turns the suite off. The `token`
 * on the factory was built for exactly that attribution and nothing declared
 * which values carry it.
 */

/**
 * How widely a generated value must not repeat.
 *
 * Four members, ordered from strictest to loosest, and the ordering is
 * load-bearing: {@link uniquenessAtLeast} compares them, so a caller that needs
 * at least UNIQUE_PER_RUN can accept a GLOBALLY_UNIQUE value without a special
 * case.
 *
 * GLOBALLY_UNIQUE is NOT "unique across the universe" — nothing here can
 * promise that, and a contract that overclaims is worse than one that is
 * narrow. It means "must not repeat across runs, so it is derived from the run
 * seed AND carries the run token". A caller that needs a guarantee stronger
 * than a 32-bit hash can give must say so and supply its own value; see the
 * note on {@link SyntheticValue.uniqueness}.
 */
export const UNIQUENESS_SCOPES = [
  /** Must not repeat across runs. Derived from the run seed and token-bearing. */
  'GLOBALLY_UNIQUE',
  /** Must not repeat within one run. Two tests in a run get different values. */
  'UNIQUE_PER_RUN',
  /** Must not repeat within one test. Two fields in one form get different values. */
  'UNIQUE_PER_TEST',
  /** May repeat freely. A city, a country, a search term — nothing keys on it. */
  'REUSABLE',
] as const;
export type UniquenessScope = (typeof UNIQUENESS_SCOPES)[number];

/**
 * Compile-time half of the parity guard. A `Record` keyed on the union cannot
 * be written without naming every member; the run-time half compares
 * `uniquenessScopeSchema.options` against the derived list, in
 * `synthetic.contract.test.ts`.
 */
const UNIQUENESS_SCOPE_PRESENT: Record<UniquenessScope, true> = {
  GLOBALLY_UNIQUE: true,
  UNIQUE_PER_RUN: true,
  UNIQUE_PER_TEST: true,
  REUSABLE: true,
};

/** Derived, never hand-listed. */
export const UNIQUENESS_SCOPE_LIST = Object.keys(
  UNIQUENESS_SCOPE_PRESENT,
) as ReadonlyArray<UniquenessScope>;

/** Strictness rank, for comparison. Keyed on the union so a fifth scope has no rank by default. */
const UNIQUENESS_RANK: Record<UniquenessScope, number> = {
  GLOBALLY_UNIQUE: 4,
  UNIQUE_PER_RUN: 3,
  UNIQUE_PER_TEST: 2,
  REUSABLE: 1,
};

/** Is `actual` at least as strict as `required`? */
export function uniquenessAtLeast(actual: UniquenessScope, required: UniquenessScope): boolean {
  return UNIQUENESS_RANK[actual] >= UNIQUENESS_RANK[required];
}

/**
 * What using this value obliges the suite to clean up afterwards.
 *
 * UNKNOWN is a real member and the most important one. A value typed into a
 * form the crawl never submitted leaves behind whatever that form does, and
 * this module cannot know what that is. Reporting UNKNOWN makes the obligation
 * visible and unresolved; reporting NONE would be a claim that nothing was
 * created, which is the kind of quiet false statement that fills a customer's
 * database.
 */
export const CLEANUP_OBLIGATIONS = [
  /** Nothing persists. A search term, a value typed into a form that was never submitted. */
  'NONE',
  /** A row was created and must be deleted. A signup, an invite, an order. */
  'DELETE_ENTITY',
  /** A unique identifier was consumed and must be released before it can be reused. */
  'RELEASE_IDENTIFIER',
  /** A session or token was minted and must be revoked. */
  'REVOKE_CREDENTIAL',
  /** This module cannot tell. Visible and unresolved, never silently NONE. */
  'UNKNOWN',
] as const;
export type CleanupObligation = (typeof CLEANUP_OBLIGATIONS)[number];

/** Compile-time half of the parity guard. */
const CLEANUP_OBLIGATION_PRESENT: Record<CleanupObligation, true> = {
  NONE: true,
  DELETE_ENTITY: true,
  RELEASE_IDENTIFIER: true,
  REVOKE_CREDENTIAL: true,
  UNKNOWN: true,
};

/** Derived, never hand-listed. */
export const CLEANUP_OBLIGATION_LIST = Object.keys(
  CLEANUP_OBLIGATION_PRESENT,
) as ReadonlyArray<CleanupObligation>;

/**
 * The uniqueness each semantic needs, as a total function.
 *
 * A `Record` keyed on `FormFieldSemantic`, so a twentieth semantic cannot be
 * added to flow-map.ts without deciding this — which is the point. The failure
 * mode a partial lookup produces is a new semantic defaulting to REUSABLE, and
 * REUSABLE is the answer that collides.
 *
 * The judgements worth arguing with, stated rather than buried:
 *
 *   · `email` and `username` are GLOBALLY_UNIQUE because an application holds a
 *     unique index on them and a collision ACROSS runs is the commonest
 *     cross-run flake there is — run 2 cannot sign up as run 1's user.
 *   · `phone` is UNIQUE_PER_RUN and not global, because the supply of valid
 *     reserved test numbers is small and genuinely exhaustible; promising
 *     global uniqueness over a finite pool would be a promise this module
 *     breaks on the two-hundredth run.
 *   · `credit_card` is REUSABLE, which looks wrong and is the only correct
 *     answer: the value is a PROVIDER'S PUBLISHED TEST NUMBER from
 *     test-values.ts, every caller must use the same one, and generating a
 *     "unique" card number means generating one the provider will not honour.
 *   · `person_name`, `street_address` and `city` are REUSABLE because nothing
 *     keys on them; making them unique would churn values for no benefit and
 *     make every diff unreadable.
 *   · `password` is UNIQUE_PER_TEST, not global: it is never a key, but two
 *     accounts in one test sharing a password makes a lockout scenario
 *     ambiguous about which account it locked.
 */
const SEMANTIC_UNIQUENESS: Record<FormFieldSemantic, UniquenessScope> = {
  email: 'GLOBALLY_UNIQUE',
  username: 'GLOBALLY_UNIQUE',
  password: 'UNIQUE_PER_TEST',
  person_name: 'REUSABLE',
  phone: 'UNIQUE_PER_RUN',
  street_address: 'REUSABLE',
  city: 'REUSABLE',
  postal_code: 'REUSABLE',
  country: 'REUSABLE',
  credit_card: 'REUSABLE',
  card_expiry: 'REUSABLE',
  card_cvc: 'REUSABLE',
  date: 'REUSABLE',
  number: 'REUSABLE',
  currency: 'REUSABLE',
  url: 'UNIQUE_PER_RUN',
  search: 'REUSABLE',
  freeform: 'UNIQUE_PER_TEST',
  unknown: 'UNIQUE_PER_TEST',
};

/**
 * The cleanup each semantic implies, as a total function for the same reason.
 *
 * Every identity-shaped semantic is UNKNOWN rather than DELETE_ENTITY, and that
 * is deliberate. Whether typing an email into a form creates a row depends on
 * whether the form was submitted and what it does, and this module sees a FIELD
 * — it never sees the submission. UNKNOWN is the honest answer and it is
 * actionable: the scenario that submits the form knows, and
 * {@link withCleanup} is how it says so.
 */
const SEMANTIC_CLEANUP: Record<FormFieldSemantic, CleanupObligation> = {
  email: 'UNKNOWN',
  username: 'UNKNOWN',
  password: 'NONE',
  person_name: 'NONE',
  phone: 'UNKNOWN',
  street_address: 'NONE',
  city: 'NONE',
  postal_code: 'NONE',
  country: 'NONE',
  credit_card: 'NONE',
  card_expiry: 'NONE',
  card_cvc: 'NONE',
  date: 'NONE',
  number: 'NONE',
  currency: 'NONE',
  url: 'NONE',
  search: 'NONE',
  freeform: 'NONE',
  unknown: 'UNKNOWN',
};

/** The uniqueness scope a value of this semantic carries. Total, by construction. */
export function uniquenessFor(semantic: FormFieldSemantic): UniquenessScope {
  return SEMANTIC_UNIQUENESS[semantic];
}

/** The cleanup obligation a value of this semantic carries. Total, by construction. */
export function cleanupFor(semantic: FormFieldSemantic): CleanupObligation {
  return SEMANTIC_CLEANUP[semantic];
}

/**
 * Restate a value's cleanup obligation, for a caller that knows what the
 * submission does.
 *
 * The narrow, deliberate way to resolve an UNKNOWN: the scenario that submits
 * the form knows whether a row was created, and this is how it records that
 * without the generator pretending to know. Returns a new value; nothing here
 * mutates.
 */
export function withCleanup(value: SyntheticValue, cleanup: CleanupObligation): SyntheticValue {
  return { ...value, cleanup };
}

// ─── Public shape ────────────────────────────────────────────────────────────

/**
 * What the factory needs to know about a field.
 *
 * Structurally a subset of `FormField`, so a crawled field can be passed
 * straight in, but every constraint is optional so a hand-written caller (or an
 * old FlowMap that predates constraint capture) still works. `semantic` and
 * `name` are the only required members because they are the only two the
 * generation keys on.
 */
export interface SyntheticField {
  name: string;
  semantic: FormFieldSemantic;
  label?: string | null;
  /** HTML input type, or 'select'/'textarea'. Changes the FORMAT of dates. */
  inputType?: string;
  required?: boolean;
  options?: readonly string[];
  maxLength?: number | null;
  minLength?: number | null;
  min?: string | null;
  max?: string | null;
  step?: string | null;
  pattern?: string | null;
  inputMode?: string | null;
  autocomplete?: string | null;
}

export interface SyntheticOptions {
  /**
   * The run seed. A string or a number; both are hashed, so a run id works.
   *
   * THIS is where uniqueness comes from, and it is worth being precise about
   * what kind. The same seed gives the same email forever — that is replay, and
   * it is the point. A FRESH run passes a fresh seed (its run id) and gets a
   * fresh email, which is what lets a signup test run twice. There is no hidden
   * clock or counter: if two runs collide on an email, they were given the same
   * seed, and that is visible in the run record rather than mysterious.
   */
  seed: string | number;
  /**
   * Narrows the value space below the run: a test id, a form id, a journey.
   *
   * Two tests in one run share a seed, so without a scope they would generate
   * the same email and race on it — the exact defect in the register. Pass the
   * test id here and they cannot.
   */
  scope?: string;
  /** Override the reserved mail domain, e.g. to point at a local mail sink. */
  emailDomain?: string;
  /** ISO instant all dates are derived from. Defaults to the frozen clock. */
  now?: string;
}

export interface SyntheticValue {
  field: string;
  semantic: FormFieldSemantic;
  /** The value to type into the field. */
  value: string;
  /**
   * Constraints the value was shaped to satisfy, named. Lets a reviewer see
   * that the 10-character string is 10 characters *because the page said so*.
   */
  honoured: string[];
  /**
   * Constraints the value does NOT satisfy, named. Empty means the value is
   * valid under everything the page declared.
   *
   * A non-empty entry here is a finding in its own right as often as it is a
   * limitation of this module: `maxLength 8` on a card-number field, or a
   * `pattern` no real-world format for that semantic can match, is a bug in the
   * application, and surfacing it beats silently returning something invalid.
   */
  unsatisfiable: string[];
  /** One sentence for a human, when there is something to say. */
  note: string | null;
  /**
   * How widely this value must not repeat, so a caller never has to guess.
   *
   * Derived from the semantic by {@link uniquenessFor}. It describes what the
   * value NEEDS, not a proof that the generation achieved it: uniqueness here
   * rests on a 32-bit hash of (seed, scope, field), which is ample for the
   * dozens-of-values-per-run case this module serves and is not a cryptographic
   * guarantee. Saying which it is beats letting a reader assume the stronger
   * one.
   */
  uniqueness: UniquenessScope;
  /**
   * What using this value obliges the suite to clean up.
   *
   * UNKNOWN wherever submitting the form MIGHT have created a row, because this
   * module sees a field and never a submission. A scenario that knows resolves
   * it with {@link withCleanup}.
   */
  cleanup: CleanupObligation;
}

export interface SyntheticFormFill {
  /** field name → value, ready to drive a form fill. */
  values: Record<string, string>;
  /** Per-field detail, in the order the fields were given. */
  fields: SyntheticValue[];
  /**
   * Things a reader must know about this fill: a confirmation field that was
   * mirrored, a collision that was broken, a constraint nothing could satisfy.
   */
  notes: string[];
}

export interface SyntheticFactory {
  readonly seed: string;
  readonly scope: string;
  /** The value, for the common case where nothing else is wanted. */
  value(field: SyntheticField): string;
  /** The value plus what shaped it. */
  describe(field: SyntheticField): SyntheticValue;
  /**
   * A whole form at once. Prefer this over per-field calls: it is the only path
   * that can mirror "confirm password" onto "password" and break a collision
   * between two same-semantic fields, because both need to see all the fields.
   */
  fillForm(fields: readonly SyntheticField[]): SyntheticFormFill;
  /** A narrower factory — `factory.scoped(testId)` per test. */
  scoped(key: string): SyntheticFactory;
  /**
   * The short token that appears inside generated emails and usernames, so a
   * stray row in a staging database can be traced back to a run.
   */
  readonly token: string;
}

// ─── Entry points ────────────────────────────────────────────────────────────

export function createSyntheticFactory(options: SyntheticOptions): SyntheticFactory {
  const seed = String(options.seed);
  const scope = options.scope ?? '';
  return {
    seed,
    scope,
    token: tokenFor(seed, scope, ''),
    value: (field) => syntheticValue(field, { ...options, seed, scope }).value,
    describe: (field) => syntheticValue(field, { ...options, seed, scope }),
    fillForm: (fields) => fillForm(fields, { ...options, seed, scope }),
    scoped: (key) =>
      createSyntheticFactory({ ...options, seed, scope: scope === '' ? key : `${scope}/${key}` }),
  };
}

/** Six base-36 characters of the (seed, scope, field) hash. Stable, short, greppable. */
function tokenFor(seed: string, scope: string, fieldKey: string): string {
  return fnv1a32(`${seed}\u0000${scope}\u0000${fieldKey}`).toString(36).padStart(6, '0').slice(-6);
}

/**
 * One field's value. Pure: the same arguments give the same result in every
 * process, forever.
 */
export function syntheticValue(
  field: SyntheticField,
  options: SyntheticOptions,
  /**
   * Breaks a collision between two fields that generated the same value.
   *
   * Not part of the public contract on purpose — `fillForm` is the only caller
   * that can know a collision happened, and a caller that passes a nonce by
   * hand has reintroduced the order-dependence the hash exists to avoid.
   */
  nonce = 0,
): SyntheticValue {
  const seed = String(options.seed);
  const scope = options.scope ?? '';
  const fieldKey = `${field.name}\u0000${field.semantic}${nonce === 0 ? '' : `\u0000${nonce}`}`;
  const token = tokenFor(seed, scope, fieldKey);
  const rng = mulberry32(fnv1a32(`${seed}\u0000${scope}\u0000${fieldKey}`));
  const now = parseClock(options.now);

  const honoured: string[] = [];
  const unsatisfiable: string[] = [];
  const notes: string[] = [];

  // A select or radio does not take a typed value — it takes one of ITS values.
  // Generating a plausible country name for a <select> of two options is how a
  // "the form rejected our input" failure gets reported against the app.
  if (field.options && field.options.length > 0) {
    const chosen = pickOption(field.options, rng);
    if (chosen === null) {
      return {
        field: field.name,
        semantic: field.semantic,
        value: '',
        honoured: ['options'],
        unsatisfiable: ['options'],
        uniqueness: uniquenessFor(field.semantic),
        cleanup: cleanupFor(field.semantic),
        note: 'Every option on this control looks like a placeholder ("Select…"), so there is no valid value to choose. That is worth looking at.',
      };
    }
    return {
      field: field.name,
      semantic: field.semantic,
      value: chosen,
      honoured: ['options'],
      unsatisfiable: [],
      uniqueness: uniquenessFor(field.semantic),
      cleanup: cleanupFor(field.semantic),
      note: `Chosen from the ${field.options.length} option(s) the control offers rather than generated.`,
    };
  }

  const candidates = candidatesFor(field, { token, rng, now, options });

  // Pattern first, because it is the one constraint we cannot bend a value to
  // satisfy — we can only find out which of our candidates already does.
  const pattern = compilePattern(field.pattern);
  let chosen = candidates[0] ?? '';
  if (field.pattern != null && field.pattern !== '') {
    if (pattern === null) {
      notes.push(
        `The page declares pattern="${field.pattern}", which is not a regex this runtime can compile. Left unchecked rather than guessed at — and an uncompilable pattern is itself a bug, since the browser will not enforce it either.`,
      );
    } else {
      const realistic = candidates.find((c) => pattern.test(c)) ?? literalOf(field.pattern);
      if (realistic !== null && realistic !== undefined) {
        chosen = realistic;
        honoured.push('pattern');
      } else {
        /*
         * No realistic format fits, so fall back to building a value out of the
         * pattern itself — and then CHECK IT against the real compiled regex
         * before trusting it. That check is what makes the narrow parser in
         * `synthesiseForPattern` safe: a bug in it degrades to the honest
         * "could not satisfy" branch below, and can never dress an invalid
         * value up as a valid one.
         */
        const built = synthesiseForPattern(field.pattern, rng);
        if (built !== null && pattern.test(built)) {
          chosen = built;
          honoured.push('pattern');
          notes.push(
            `No realistic ${field.semantic} value satisfies pattern="${field.pattern}", so this value was built from the pattern itself: it is valid, but it will not look like real data in a screenshot.`,
          );
        } else {
          unsatisfiable.push('pattern');
          notes.push(
            `Neither the real-world formats for a "${field.semantic}" field nor a value built from the pattern satisfies pattern="${field.pattern}". Arbitrary regex inversion is out of scope here, so this is reported rather than guessed at — and note that every OTHER field's boundary case submits this value too, so the whole form's cases are weakened until it is resolved.`,
          );
        }
      }
    }
  }

  // Length last, because shortening is the one adjustment that can invalidate
  // everything above it — so it reports what it broke.
  const fitted = fitLength(chosen, field, { token, rng });
  honoured.push(...fitted.honoured);
  unsatisfiable.push(...fitted.unsatisfiable);
  if (fitted.note) notes.push(fitted.note);

  if (pattern !== null && fitted.value !== chosen && honoured.includes('pattern')) {
    if (!pattern.test(fitted.value)) {
      unsatisfiable.push('pattern');
      notes.push(
        'Shortening the value to fit maxlength broke the declared pattern. A maxlength that cannot hold any value the pattern accepts is a contradiction in the markup.',
      );
    }
  }

  /*
   * Only claimed for the semantics whose generator actually CONSULTS them.
   *
   * The first version pushed 'min/max' whenever the attributes were present,
   * which meant a free-text field carrying a stray `min="5"` came back saying
   * the constraint had been honoured when nothing had looked at it. An
   * `honoured` list that overstates itself is worse than an empty one: it is
   * the file's own honesty rule broken by two lines of convenience.
   */
  const consultsBounds = ['number', 'currency', 'date'].includes(field.semantic);
  if (consultsBounds && (field.min != null || field.max != null)) honoured.push('min/max');
  if (consultsBounds && field.step != null && field.step !== '' && field.step !== 'any') {
    honoured.push('step');
  }

  return {
    field: field.name,
    semantic: field.semantic,
    value: fitted.value,
    honoured: [...new Set(honoured)],
    unsatisfiable: [...new Set(unsatisfiable)],
    uniqueness: uniquenessFor(field.semantic),
    cleanup: cleanupFor(field.semantic),
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

/**
 * A whole form. Three passes, each one a bug this had on its first draft:
 *
 *  1. generate per field;
 *  2. MIRROR confirmation fields onto their base — "Confirm password" must hold
 *     the same value as "Password", and a factory that guarantees uniqueness
 *     across all fields guarantees that every signup test fails validation;
 *  3. BREAK remaining collisions — two same-semantic fields that happened to
 *     draw the same word from a list, where the form plainly wants two
 *     different things.
 *
 * Deterministic throughout: the mirror is decided by field names and the break
 * re-draws with an incrementing nonce, so the same form gives the same fill.
 */
export function fillForm(
  fields: readonly SyntheticField[],
  options: SyntheticOptions,
): SyntheticFormFill {
  const notes: string[] = [];
  const generated = fields.map((f) => syntheticValue(f, options));

  // ── 2. Mirror confirmations ────────────────────────────────────────────────
  const byNormalisedName = new Map<string, number>();
  fields.forEach((f, i) => byNormalisedName.set(normaliseName(f.name), i));
  const mirrored = new Set<number>();

  fields.forEach((field, index) => {
    const baseName = confirmationBaseOf(field);
    if (baseName === null) return;
    const baseIndex = byNormalisedName.get(baseName);
    if (baseIndex === undefined || baseIndex === index) return;
    const base = generated[baseIndex];
    const self = generated[index];
    if (!base || !self) return;
    generated[index] = {
      ...self,
      value: base.value,
      note: `Mirrors "${fields[baseIndex]!.name}" — this reads as a confirmation field, and a confirmation that does not match turns every submission into a validation failure.`,
    };
    mirrored.add(index);
    notes.push(`"${field.name}" was filled to match "${fields[baseIndex]!.name}".`);
  });

  // ── 3. Break collisions ────────────────────────────────────────────────────
  const seen = new Map<string, number>();
  for (let index = 0; index < generated.length; index++) {
    const current = generated[index];
    const field = fields[index];
    if (!current || !field || mirrored.has(index)) continue;
    if (current.value === '') continue; // Nothing to collide with.

    const first = seen.get(current.value);
    if (first === undefined) {
      seen.set(current.value, index);
      continue;
    }

    let redrawn = current;
    let broke = false;
    for (let nonce = 1; nonce <= 8; nonce++) {
      redrawn = syntheticValue(field, options, nonce);
      if (!seen.has(redrawn.value)) {
        broke = true;
        break;
      }
    }
    generated[index] = redrawn;
    if (broke) {
      seen.set(redrawn.value, index);
      notes.push(
        `"${field.name}" drew the same value as "${fields[first]!.name}" and was re-drawn, so a failure can only name one field.`,
      );
    } else {
      notes.push(
        `"${field.name}" collides with "${fields[first]!.name}" and eight re-draws could not separate them — the value space for a "${field.semantic}" field under these constraints is too small. Said out loud because two fields holding one value makes a failure ambiguous.`,
      );
    }
  }

  const values: Record<string, string> = {};
  fields.forEach((field, index) => {
    values[field.name] = generated[index]?.value ?? '';
  });

  for (const value of generated) {
    if (value.unsatisfiable.length > 0) {
      notes.push(`"${value.field}": could not satisfy ${value.unsatisfiable.join(', ')}.`);
    }
  }

  return { values, fields: generated, notes };
}

// ─── Per-semantic generation ─────────────────────────────────────────────────

interface GenContext {
  token: string;
  rng: () => number;
  now: Date;
  options: SyntheticOptions;
}

/**
 * The candidate values for a field, best first.
 *
 * A LIST rather than one value, because of `pattern`: a postal-code input might
 * declare a US, UK or Canadian format, and the only way to find out which
 * without inverting the regex is to have one of each ready and test them. When
 * there is no pattern the first entry is simply used.
 */
function candidatesFor(field: SyntheticField, ctx: GenContext): string[] {
  const { token, rng, now } = ctx;
  const hay = `${field.name} ${field.label ?? ''} ${field.autocomplete ?? ''}`.toLowerCase();

  switch (field.semantic) {
    case 'email': {
      const domain = ctx.options.emailDomain ?? SYNTHETIC_EMAIL_DOMAIN;
      const slug = slugOf(field.name).slice(0, 12) || 'field';
      // The local part says WHERE IT CAME FROM: a stray row in a staging
      // database is traceable to the run that made it, which is the difference
      // between cleaning up after a test and guessing.
      return [
        `qaai-${slug}-${token}@${domain}`,
        `qaai-${token}@${domain}`,
        `qaai-${token}@${SHORT_EMAIL_DOMAIN}`,
      ];
    }

    case 'username':
      return [
        `qaai_${slugOf(field.name).slice(0, 10).replace(/-/g, '_') || 'user'}_${token}`,
        `qaai_${token}`,
        `qaai${token}`,
      ];

    case 'password': {
      // Upper + lower + digit + symbol and 14 characters, so it clears the
      // common policy without the test having to know the policy.
      const base = `Qa${token}-${pick(WORDS, rng)}7!`;
      return [base, `Qa${token}7!`, `${token}Aa7!`];
    }

    case 'person_name': {
      const first = pick(FIRST_NAMES, rng);
      const last = pick(LAST_NAMES, rng);
      if (/\b(first|given|fore)/.test(hay) || field.autocomplete === 'given-name') return [first];
      if (/\b(last|sur|family)/.test(hay) || field.autocomplete === 'family-name') return [last];
      return [`${first} ${last}`, first];
    }

    case 'phone': {
      // 555-01xx inside any NANP area code is reserved for fiction, so this
      // number is well-formed and cannot ring anybody.
      const line = String(intBetween(100, 199, rng));
      return [`+1 555 555 0${line}`, `+1555555 0${line}`, `+15555550${line}`, `5555550${line}`];
    }

    case 'street_address':
      return [
        `${intBetween(1, 299, rng)} ${pick(STREETS, rng)}`,
        `${intBetween(1, 99, rng)} Alder Lane`,
      ];

    case 'city':
      return [pick(CITIES, rng), 'Brimley'];

    case 'postal_code':
      // One per major format, so a `pattern` picks its own.
      return [
        String(intBetween(10000, 99998, rng)),
        `SW1A ${intBetween(1, 9, rng)}AA`,
        `K1A 0B${intBetween(1, 9, rng)}`,
        `${intBetween(1000, 9999, rng)}`,
      ];

    case 'country':
      return ['United States', 'US', 'USA'];

    case 'credit_card': {
      // From the catalogue, never invented: a made-up card number is either
      // Luhn-invalid (so the form refuses it and the test proves nothing) or
      // Luhn-valid and belonging to a real BIN.
      const card = cardForOutcome('success');
      const digits = (card?.value ?? '4242424242424242').replace(/\s/g, '');
      return [digits, digits.replace(/(\d{4})(?=\d)/g, '$1 ')];
    }

    case 'card_expiry': {
      const year = now.getUTCFullYear() + CARD_EXPIRY_YEARS_AHEAD;
      const mm = '12';
      if ((field.inputType ?? '') === 'month') return [`${year}-${mm}`];
      return [`${mm}/${String(year).slice(-2)}`, `${mm}/${year}`, `${mm}${String(year).slice(-2)}`];
    }

    case 'card_cvc':
      return /amex|american/.test(hay) || field.maxLength === 4 ? ['1234', '123'] : ['123', '1234'];

    case 'date':
      return dateCandidates(field, ctx, hay);

    case 'number':
      return numberCandidates(field, ctx, 0);

    case 'currency':
      return numberCandidates(field, ctx, 2);

    case 'url':
      return [
        `https://app.${SYNTHETIC_EMAIL_DOMAIN}/qaai/${token}`,
        `https://${SYNTHETIC_EMAIL_DOMAIN}/${token}`,
        `https://${SYNTHETIC_EMAIL_DOMAIN}`,
      ];

    case 'search':
      // There is no way to know a term that MATCHES something in this app, and
      // pretending otherwise is how "search returns no results" becomes a
      // permanently red test. A caller that knows the data should override.
      return [pick(WORDS, rng), 'a'];

    case 'freeform': {
      const sentence = `QAAI ${pick(WORDS, rng)} ${pick(WORDS, rng)} ${token}`;
      return [sentence, `QAAI ${token}`, token];
    }

    case 'unknown':
    default:
      // The crawl could not tell what this field wants. The value says so, in
      // the value itself, so a screenshot of a failed submission is legible.
      return [`qaai-${token}`, token];
  }
}

function dateCandidates(field: SyntheticField, ctx: GenContext, hay: string): string[] {
  const { now, rng } = ctx;
  const type = (field.inputType ?? 'date').toLowerCase();

  const lower = parseDateAttr(field.min);
  const upper = parseDateAttr(field.max);

  let chosen: Date;
  if (/\b(dob|birth)/.test(hay) || (field.autocomplete ?? '').startsWith('bday')) {
    // A birth date must clear an age gate; 30 years back clears every one of
    // them, and a DOB of "next Tuesday" is the kind of fixture that makes an
    // age check look broken when it is working.
    chosen = addDays(now, -365 * 30 - 7);
  } else if (lower && upper) {
    const span = Math.max(0, Math.floor((upper.getTime() - lower.getTime()) / 86_400_000));
    chosen = addDays(lower, Math.min(span, intBetween(0, span, rng)));
  } else if (lower) {
    chosen = addDays(lower, intBetween(1, 30, rng));
  } else if (upper) {
    chosen = addDays(upper, -intBetween(1, 30, rng));
  } else {
    chosen = addDays(now, intBetween(1, 60, rng));
  }

  return [formatDate(chosen, type), formatDate(chosen, 'date')];
}

/**
 * A number inside `[min, max]`, aligned to `step`.
 *
 * Alignment matters more than it looks: a `step="5"` input rejects 12 in the
 * browser with a message the test never sees, and the resulting failure reads
 * as "the form would not submit" with no cause attached.
 */
function numberCandidates(field: SyntheticField, ctx: GenContext, decimals: number): string[] {
  const { rng } = ctx;
  const min = parseNumberAttr(field.min);
  const max = parseNumberAttr(field.max);
  const step = parseNumberAttr(field.step);

  const low = min ?? (decimals > 0 ? 1 : 1);
  const high = max ?? low + (decimals > 0 ? 99 : 999);

  let value = low + (high - low) * rng();
  if (step !== null && step > 0) {
    const base = min ?? 0;
    value = base + Math.round((value - base) / step) * step;
    if (max !== null && value > max) value -= step;
    if (value < low) value = low;
  }
  if (max !== null && value > max) value = max;
  if (value < low) value = low;

  const decimalsFromStep =
    step !== null && !Number.isInteger(step)
      ? (String(step).split('.')[1]?.length ?? decimals)
      : decimals;
  const places = Math.max(decimals, decimalsFromStep);

  const primary = places > 0 ? value.toFixed(places) : String(Math.round(value));
  return [primary, String(Math.round(value)), String(Math.round(low))];
}

// ─── Constraints ─────────────────────────────────────────────────────────────

/**
 * Makes the value fit `minlength`/`maxlength` while keeping it plausible.
 *
 * "Plausible" is the requirement that makes this more than a `slice()`: an
 * email cut to ten characters is not an email, so the candidate list already
 * holds progressively shorter real formats and this picks the longest one that
 * fits before it resorts to cutting. When nothing fits it SAYS SO instead of
 * returning a mangled string, because a maxlength too small for the field's own
 * semantic is a defect in the page.
 */
function fitLength(
  value: string,
  field: SyntheticField,
  ctx: { token: string; rng: () => number },
): { value: string; honoured: string[]; unsatisfiable: string[]; note: string | null } {
  const honoured: string[] = [];
  const unsatisfiable: string[] = [];
  let out = value;
  let note: string | null = null;

  const max = field.maxLength;
  if (typeof max === 'number' && max > 0 && out.length > max) {
    const shortened = shortenPlausibly(out, field, max, ctx);
    if (shortened === null) {
      unsatisfiable.push('maxLength');
      out = out.slice(0, max);
      note = `maxlength=${max} is too small to hold any valid ${field.semantic} value, so the value was truncated and is NOT valid. A maxlength that excludes every legal value for the field is a bug in the page, not in this generator.`;
    } else {
      out = shortened;
      honoured.push('maxLength');
    }
  } else if (typeof max === 'number') {
    honoured.push('maxLength');
  }

  const min = field.minLength;
  if (typeof min === 'number' && min > 0 && out.length < min) {
    const padded = padPlausibly(out, field, min, ctx);
    if (padded === null || padded.length < min) {
      unsatisfiable.push('minLength');
      note = [
        note,
        `minlength=${min} cannot be reached without making the value invalid for a ${field.semantic} field.`,
      ]
        .filter(Boolean)
        .join(' ');
    } else {
      out = padded;
      honoured.push('minLength');
      if (typeof max === 'number' && out.length > max) {
        unsatisfiable.push('minLength', 'maxLength');
        note = [
          note,
          `minlength=${min} and maxlength=${max} leave no room for a valid ${field.semantic} value. The two attributes contradict each other.`,
        ]
          .filter(Boolean)
          .join(' ');
      }
    }
  } else if (typeof min === 'number') {
    honoured.push('minLength');
  }

  return { value: out, honoured, unsatisfiable, note };
}

/** Shortens while keeping the value a legal member of its semantic, or gives up. */
function shortenPlausibly(
  value: string,
  field: SyntheticField,
  max: number,
  ctx: { token: string },
): string | null {
  switch (field.semantic) {
    case 'email': {
      for (const domain of [SYNTHETIC_EMAIL_DOMAIN, SHORT_EMAIL_DOMAIN]) {
        for (let localLength = ctx.token.length + 5; localLength >= 1; localLength--) {
          const local = `qaai-${ctx.token}`.slice(0, localLength).replace(/[-.]$/, '');
          const candidate = `${local}@${domain}`;
          if (local.length > 0 && candidate.length <= max) return candidate;
        }
      }
      return null;
    }
    case 'url': {
      /*
       * Shortens the PATH before it gives up the token. Returning a bare
       * `https://example.com` would fit almost any maxlength and be identical
       * for every URL field on the page — so two URL fields would collide, and
       * `fillForm` would be left reporting a collision it could not break.
       * Keeping even one character of the token keeps them distinguishable.
       */
      for (const base of [`https://${SYNTHETIC_EMAIL_DOMAIN}`, 'https://qa.test']) {
        for (let length = ctx.token.length; length >= 1; length--) {
          const candidate = `${base}/${ctx.token.slice(0, length)}`;
          if (candidate.length <= max) return candidate;
        }
        if (base.length <= max) return base;
      }
      return null;
    }
    case 'credit_card':
      // A card number cannot be shortened and stay a card number. 16 digits is
      // the floor, so a smaller maxlength is a real defect in the form.
      return null;
    case 'phone': {
      const digits = value.replace(/\D/g, '');
      return digits.length <= max ? digits : null;
    }
    case 'card_expiry':
    case 'card_cvc':
    case 'date':
    case 'number':
    case 'currency':
      // Formats with a fixed width. Cutting a digit changes the meaning
      // silently, which is worse than failing loudly.
      return null;
    default: {
      const cut = value.slice(0, max).trimEnd();
      return cut.length > 0 ? cut : null;
    }
  }
}

/** Lengthens while keeping the value legal, or gives up. */
function padPlausibly(
  value: string,
  field: SyntheticField,
  min: number,
  ctx: { token: string; rng: () => number },
): string | null {
  switch (field.semantic) {
    case 'email': {
      const at = value.indexOf('@');
      if (at < 0) return null;
      const local = value.slice(0, at);
      const domain = value.slice(at);
      const need = min - value.length;
      return `${local}${'x'.repeat(Math.max(0, need))}${domain}`;
    }
    case 'credit_card':
    case 'card_cvc':
    case 'card_expiry':
    case 'date':
      return null;
    case 'number':
    case 'currency':
      // Zero-padding a number changes nothing about its value but may change
      // what the field accepts, so it is reported rather than done quietly.
      return null;
    case 'password': {
      let out = value;
      while (out.length < min) out += pick(WORDS, ctx.rng);
      return out.slice(0, Math.max(min, value.length));
    }
    default: {
      let out = value;
      while (out.length < min) out += ` ${pick(WORDS, ctx.rng)}`;
      // Trim back to exactly `min` only when the last word overshot badly;
      // a value a few characters over the minimum reads better than one cut
      // mid-word, and both satisfy the constraint.
      return out.length > min + 12 ? out.slice(0, min) : out;
    }
  }
}

/**
 * Compiles a `pattern` the way the HTML spec says a browser does: anchored at
 * both ends. Returns null rather than throwing — an invalid pattern in the
 * markup must not take the crawl down with it, and a page CAN ship one.
 */
function compilePattern(pattern: string | null | undefined): RegExp | null {
  if (pattern == null || pattern === '') return null;
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`);
    } catch {
      return null;
    }
  }
}

/**
 * When a `pattern` contains no regex metacharacters it IS a literal, and that
 * literal is the one value guaranteed to satisfy it. Cheap, and it covers the
 * surprisingly common `pattern="[0-9]{5}"`-adjacent case of a fixed code.
 */
function literalOf(pattern: string): string | null {
  return /^[A-Za-z0-9 _-]+$/.test(pattern) ? pattern : null;
}

const ESCAPE_CLASSES: Record<string, string> = {
  d: '0123456789',
  w: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_',
  s: ' ',
};

/**
 * Builds a value for the SIMPLE shape that real `pattern` attributes almost
 * always have: a flat sequence of character classes with counts.
 * `[0-9]{5}`, `[A-Z]{4}[0-9]{2}`, `\d{3}-\d{4}`, `[A-Za-z0-9_]{3,16}`.
 *
 * ─── Why this exists, given the "we do not invert regexes" rule above ────────
 *
 * The rule stands for the general case, and this is not the general case. The
 * cost of not having this was concrete and worse than the complexity: a single
 * field with `pattern="[A-Z]{4}[0-9]{2}"` made its own value invalid, and
 * because every boundary case submits the WHOLE form, every case for every
 * other field then carried a second known-bad value — so no failure could be
 * attributed to the field under test. One unsatisfiable pattern poisoned the
 * entire expansion.
 *
 * ─── What makes it safe ─────────────────────────────────────────────────────
 *
 * Two things. It bails to null on anything it does not fully understand —
 * alternation, groups, unbounded repeats, negated classes, anchors, lookahead —
 * rather than approximating. And the caller VERIFIES the result against the
 * real compiled regex before using it, so a bug in this parser can only ever
 * produce "could not satisfy pattern", never a wrong value presented as valid.
 */
function synthesiseForPattern(pattern: string, rng: () => number): string | null {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    let choices: string | null;

    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) return null;
      const body = pattern.slice(i + 1, end);
      // A negated class is a set defined by what it excludes; picking from it
      // correctly means knowing the universe, so it is declined instead.
      if (body.startsWith('^')) return null;
      choices = expandCharClass(body);
      i = end + 1;
    } else if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return null;
      choices = ESCAPE_CLASSES[next] ?? (/[.\-/+*?()[\]{}|^$\\]/.test(next) ? next : null);
      i += 2;
    } else if (ch === '.') {
      choices = 'abcdefghijklmnopqrstuvwxyz';
      i += 1;
    } else if ('|()*+?^$'.includes(ch)) {
      return null; // Beyond this parser, on purpose.
    } else {
      choices = ch;
      i += 1;
    }

    if (choices === null || choices.length === 0) return null;

    let count = 1;
    if (pattern[i] === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) return null;
      const spec = /^(\d+)(?:,(\d*))?$/.exec(pattern.slice(i + 1, end));
      if (!spec) return null;
      // The LOW end of a range: the shortest legal value is the one most likely
      // to fit alongside a maxlength, and length is tested by its own classes.
      count = Number(spec[1]);
      i = end + 1;
    }
    if (count > 256 || count < 1) return null;

    for (let n = 0; n < count; n++) {
      out += choices[Math.floor(rng() * choices.length)] ?? choices[0]!;
    }
  }

  return out === '' ? null : out;
}

/** `A-Z0-9_` → every character it stands for. Null when it cannot be expanded. */
function expandCharClass(body: string): string | null {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === undefined) return null;
      out += ESCAPE_CLASSES[next] ?? next;
      i += 2;
      continue;
    }
    const dash = body[i + 1];
    const upper = body[i + 2];
    if (dash === '-' && upper !== undefined) {
      const from = ch.charCodeAt(0);
      const to = upper.charCodeAt(0);
      if (to < from || to - from > 128) return null;
      for (let code = from; code <= to; code++) out += String.fromCharCode(code);
      i += 3;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out === '' ? null : out;
}

/** An option that is a real choice, not a "Select…" prompt. */
function pickOption(options: readonly string[], rng: () => number): string | null {
  const real = options.filter(
    (o) =>
      o.trim() !== '' &&
      !/^(-+|…|\.\.\.)$/.test(o.trim()) &&
      !/^(please\s+)?(select|choose|pick|any|none|all)\b/i.test(o.trim()),
  );
  if (real.length === 0) return null;
  return pick(real, rng);
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function slugOf(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * "confirm_password" → "password". Returns null when the field is not a
 * confirmation at all, which is the common case.
 *
 * Name-based rather than semantic-based because the SEMANTIC is identical for
 * both halves — that is exactly why uniqueness-by-default broke signup forms.
 */
function confirmationBaseOf(field: SyntheticField): string | null {
  const hay = `${field.name} ${field.label ?? ''}`.toLowerCase();
  if (!/(confirm|confirmation|repeat|re-?enter|re-?type|verify|again|_?2$)/.test(hay)) return null;
  const stripped = normaliseName(
    field.name.replace(
      /confirmation|confirm|repeat|reenter|re-enter|retype|re-type|verify|again|2$/gi,
      '',
    ),
  );
  return stripped === '' ? null : stripped;
}

function parseClock(now: string | undefined): Date {
  const parsed = new Date(now ?? SYNTHETIC_CLOCK);
  // A caller passing a junk clock gets the frozen one rather than Invalid Date
  // spreading NaN through every date in the suite.
  return Number.isNaN(parsed.getTime()) ? new Date(SYNTHETIC_CLOCK) : parsed;
}

function parseDateAttr(value: string | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const parsed = new Date(/^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNumberAttr(value: string | null | undefined): number | null {
  if (value == null || value === '' || value === 'any') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/** The format each date-ish input type actually accepts. */
export function formatDate(date: Date, inputType: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');

  switch (inputType) {
    case 'month':
      return `${y}-${m}`;
    case 'time':
      return `${hh}:${mm}`;
    case 'datetime-local':
      return `${y}-${m}-${d}T${hh}:${mm}`;
    case 'week': {
      // ISO week of the Thursday in this date's week — the definition the
      // `week` input uses, and getting it wrong means a silently rejected value.
      const thursday = new Date(date.getTime());
      thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
      const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    default:
      return `${y}-${m}-${d}`;
  }
}
