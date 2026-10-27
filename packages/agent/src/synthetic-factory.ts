/**
 * The synthetic data factory, extended where the shared one stops: LOCALE, the
 * three shapes `FormFieldSemantic` has no name for, free text at several
 * lengths, a proof that a globally-unique value really is unique across runs,
 * and a cleanup ledger a runner can execute.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is NOT a second generator. `packages/shared/src/synthetic.ts` already does
 * the hard part — a seeded PRNG keyed on (seed, scope, field), constraint
 * fitting against the attributes the crawl read off the DOM, pattern
 * satisfaction, and the uniqueness/cleanup contract the keystone added — and
 * every semantic whose value does not depend on locale is DELEGATED to it
 * verbatim. Re-deriving an email address here would mean two modules deciding
 * what a run's email is, which is the defect one layer up from the one this
 * round is fixing.
 *
 * What is delegated and what is not is a single table, {@link LOCALE_SENSITIVE},
 * so the split is one thing to read rather than a judgement spread over a file.
 *
 * ─── THE FOUR GAPS THIS CLOSES ───────────────────────────────────────────────
 *
 * 1. NO LOCALE. Every value the shared factory produces is en-US-shaped: a
 *    five-digit postcode, a dot decimal separator, a given-name-first person.
 *    Point it at a German application and it generates `1234.56` for a currency
 *    field that wants `1234,56`, the form rejects it, and the failure is
 *    reported against the application. The decimal comma alone is a whole class
 *    of real defect — and the RTL case is not a string swap, it re-lays-out the
 *    page.
 *
 * 2. THREE SHAPES WITH NO SEMANTIC. `company`, `time` and `percentage` are
 *    asked for by name in this round's register and `FormFieldSemantic` has
 *    none of them; the nearest existing members are `freeform` and `number`,
 *    which generate a word and an integer. A 12-hour clock with AM/PM and a
 *    French percentage with a space before the sign are both field-level
 *    defects nothing could reach.
 *
 * 3. UNIQUENESS WAS DECLARED AND NEVER CHECKED. `SyntheticValue.uniqueness`
 *    says what a value NEEDS. Nothing in the repo verified that a
 *    GLOBALLY_UNIQUE value actually differs between two runs, which is the
 *    single commonest cross-run flake there is: run 2 cannot sign up as run 1's
 *    user. {@link auditUniquenessAcrossRuns} is that check, and it reports what
 *    it did NOT establish as loudly as what it did.
 *
 * 4. CLEANUP WAS A LABEL, NOT A PLAN. `CleanupObligation` names the obligation
 *    and nothing could execute it, so a nightly suite fills a customer's
 *    staging database with rows nobody can attribute until they turn the suite
 *    off. {@link buildCleanupLedger} turns the labels into ordered, attributable
 *    steps and {@link executeCleanupLedger} runs them against an injected
 *    executor.
 *
 * ─── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Every value here is a pure function of (seed, scope, semantic, index,
 * locale). No `Math.random`, no `Date.now`, no ambient clock: the clock arrives
 * as `now` and defaults to the shared frozen constant. A generator that is not
 * reproducible produces a suite nobody can debug, and it is the commonest cause
 * of the flake this product exists to eliminate.
 *
 * ─── NO I/O ──────────────────────────────────────────────────────────────────
 *
 * Nothing in this file touches the network, the filesystem or a browser. The
 * one place it needs an effect — actually deleting the rows a scenario created
 * — takes {@link CleanupExecutor}, a two-method interface defined here, so the
 * ordering and accounting logic is testable with a fake and the real adapter is
 * thin. 629 lines of crawler.ts went almost untested for want of exactly this.
 */

import {
  FORM_FIELD_SEMANTICS,
  SYNTHETIC_CLOCK,
  cleanupFor,
  syntheticValue,
  uniquenessAtLeast,
  uniquenessFor,
  type CleanupObligation,
  type FormFieldSemantic,
  type SyntheticField,
  type UniquenessScope,
} from '@qaai/shared';

// ─── Seeded randomness ───────────────────────────────────────────────────────

/*
 * FNV-1a and mulberry32, duplicated from `packages/shared/src/synthetic.ts`.
 *
 * DELIBERATE, and the same trade that file already documents against
 * `packages/runner/src/determinism.ts`: both functions are module-private
 * there, exporting them would widen a public API for an implementation detail,
 * and twenty lines of fixed-output arithmetic is the cheapest thing in this
 * repo to duplicate. The property that matters is that the output is pinned by
 * a test — see "is byte-identical for the same seed" below — so a divergence
 * from the shared implementation would be visible rather than silent.
 *
 * What is NOT duplicated is any decision about what a value should be. That
 * stays in one place; see the module header.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

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

// ─── The extended semantic axis ──────────────────────────────────────────────

/**
 * The three shapes this round names that `FormFieldSemantic` does not have.
 *
 * SEPARATE from `FORM_FIELD_SEMANTICS` and unioned with it rather than added to
 * it, because that list is owned by `flow-map.ts`: it is what the crawler
 * infers, what two `Record<FormFieldSemantic, …>` lookups in `synthetic.ts` are
 * keyed on, and what a Prisma enum mirrors. Widening it is a schema change and
 * a migration, which is a different file's decision. Unioning is additive and
 * costs one down-map, {@link BASE_SEMANTIC}.
 */
export const EXTENDED_SEMANTICS = [
  /** An organisation name. A billing form's "Company" field. */
  'company',
  /** A time of day, whose 12-vs-24-hour rendering is locale-dependent. */
  'time',
  /** A percentage, whose separator AND spacing before the sign are locale-dependent. */
  'percentage',
] as const;
export type ExtendedSemantic = (typeof EXTENDED_SEMANTICS)[number];

/** Compile-time half of the parity guard; the run-time half is in the test. */
const EXTENDED_SEMANTIC_PRESENT: Record<ExtendedSemantic, true> = {
  company: true,
  time: true,
  percentage: true,
};

/** Derived, never hand-listed. */
export const EXTENDED_SEMANTIC_LIST = Object.keys(
  EXTENDED_SEMANTIC_PRESENT,
) as ReadonlyArray<ExtendedSemantic>;

/** Everything this factory can generate: the crawler's vocabulary plus three. */
export type SyntheticSemantic = FormFieldSemantic | ExtendedSemantic;

/** Every member, derived from both halves so neither can drift out of it. */
export const SYNTHETIC_SEMANTICS: ReadonlyArray<SyntheticSemantic> = [
  ...FORM_FIELD_SEMANTICS,
  ...EXTENDED_SEMANTIC_LIST,
];

/**
 * The `FormFieldSemantic` each extended semantic stands in for.
 *
 * Needed because the keystone's two contract lookups — `uniquenessFor` and
 * `cleanupFor` — are total over `FormFieldSemantic` and this module must not
 * fork them. A `company` value gets `freeform`'s uniqueness and cleanup, which
 * is the right answer for both: nothing keys on a company name and typing one
 * creates nothing on its own.
 *
 * A `Record` keyed on the union, so a fourth extended semantic cannot be added
 * without deciding what it stands in for.
 */
const BASE_SEMANTIC: Record<ExtendedSemantic, FormFieldSemantic> = {
  company: 'freeform',
  // `time` is not `date`: shared's `date` arm formats against an input type and
  // a time has its own locale rendering. It borrows `date`'s CONTRACT only.
  time: 'date',
  percentage: 'number',
};

/** The uniqueness a value of this semantic needs. Total over the union. */
export function extendedUniquenessFor(semantic: SyntheticSemantic): UniquenessScope {
  return isExtended(semantic)
    ? uniquenessFor(BASE_SEMANTIC[semantic])
    : uniquenessFor(semantic);
}

/** The cleanup a value of this semantic obliges. Total over the union. */
export function extendedCleanupFor(semantic: SyntheticSemantic): CleanupObligation {
  return isExtended(semantic) ? cleanupFor(BASE_SEMANTIC[semantic]) : cleanupFor(semantic);
}

function isExtended(semantic: SyntheticSemantic): semantic is ExtendedSemantic {
  return (EXTENDED_SEMANTIC_LIST as readonly string[]).includes(semantic);
}

// ─── Locale ──────────────────────────────────────────────────────────────────

/**
 * The locales this factory can generate for.
 *
 * SIX, chosen for coverage of the things that actually break rather than for
 * market size. Each one is here because it reaches a defect the others cannot:
 *
 *   · `en-US` — the baseline, and the only one the shared factory produces.
 *   · `en-GB` — an ALPHANUMERIC postcode. An application whose postcode field
 *     is `inputMode="numeric"` or validated `/^\d{5}$/` rejects every UK
 *     address, and nothing in an en-US run can find that.
 *   · `de-DE` — the DECIMAL COMMA. `1234,56` into a field that parses with
 *     `parseFloat` silently becomes 1234, and a billing form that loses the
 *     cents is a money defect.
 *   · `fr-FR` — a decimal comma AND a space before the percent sign, plus an
 *     accented character set that catches a latin-1 round-trip.
 *   · `ja-JP` — FAMILY NAME FIRST, a hyphenated seven-digit postcode, and
 *     multi-byte characters that break a `maxlength` counted in bytes rather
 *     than code points.
 *   · `ar-EG` — RIGHT TO LEFT. Not a string swap: the page re-lays-out, and a
 *     form whose labels are positioned absolutely breaks visibly.
 */
export const SYNTHETIC_LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'ar-EG'] as const;
export type SyntheticLocale = (typeof SYNTHETIC_LOCALES)[number];

/** Compile-time half of the parity guard. */
const SYNTHETIC_LOCALE_PRESENT: Record<SyntheticLocale, true> = {
  'en-US': true,
  'en-GB': true,
  'de-DE': true,
  'fr-FR': true,
  'ja-JP': true,
  'ar-EG': true,
};

/** Derived, never hand-listed. */
export const SYNTHETIC_LOCALE_LIST = Object.keys(
  SYNTHETIC_LOCALE_PRESENT,
) as ReadonlyArray<SyntheticLocale>;

/** The locale the shared factory implicitly generates, and this one's default. */
export const DEFAULT_SYNTHETIC_LOCALE: SyntheticLocale = 'en-US';

/**
 * Why a locale cannot produce a value of some semantic.
 *
 * The existence of this union is the honesty mechanism of the whole file. There
 * is no universally reserved test phone range for Germany, France, Japan or
 * Egypt the way there is for the NANP (555-01XX) and the UK (Ofcom's 07700
 * 900xxx) — so generating a plausible German mobile number means generating a
 * number that, if a test ever actually sends to it, rings a stranger's phone.
 *
 * The answer is not a fabricated value with a comment. It is NO VALUE and a
 * reason, which is rule 12's "UNAVAILABLE, never PASS / 0": a field QAAI cannot
 * fill must be reported as unfilled, not filled with something unsafe.
 */
export const UNAVAILABLE_REASONS = [
  /** No regulator-reserved test range exists for this locale, so any number we invented could be real. */
  'NO_RESERVED_RANGE',
  /** The semantic has no locale-specific form this module knows how to produce. */
  'NO_LOCALE_FORM',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** Compile-time half of the parity guard. */
const UNAVAILABLE_REASON_PRESENT: Record<UnavailableReason, true> = {
  NO_RESERVED_RANGE: true,
  NO_LOCALE_FORM: true,
};

/** Derived, never hand-listed. */
export const UNAVAILABLE_REASON_LIST = Object.keys(
  UNAVAILABLE_REASON_PRESENT,
) as ReadonlyArray<UnavailableReason>;

/**
 * One locale's formatting facts and word pools.
 *
 * Word pools are short, invented and recognisably not a real person or street,
 * for the reason `synthetic.ts` records against its own: synthetic data ends up
 * in a staging database, in a screenshot on a bug report and sometimes in an
 * email, and a value that looks like a real customer gets treated like one.
 */
interface LocaleProfile {
  tag: SyntheticLocale;
  /** RTL locales re-lay-out the page. Matches `DimensionDetail`'s LOCALE arm. */
  rtl: boolean;
  /** True where the family name is written first. */
  familyNameFirst: boolean;
  givenNames: readonly string[];
  familyNames: readonly string[];
  streets: readonly string[];
  cities: readonly string[];
  /** ISO 3166-1 alpha-2, for a country field that wants a code. */
  countryCode: string;
  /** The country as the locale writes it, for a field that wants a name. */
  countryName: string;
  decimalSeparator: ',' | '.';
  groupSeparator: ',' | '.' | ' ' | '';
  /** The currency symbol and which side of the number it sits. */
  currencySymbol: string;
  currencyAfter: boolean;
  /** A space between the number and the percent sign, as fr-FR requires. */
  percentSpace: boolean;
  /** 12-hour with a meridiem, versus 24-hour. */
  twelveHourClock: boolean;
  /** Company suffixes, which are jurisdiction-specific. */
  companySuffixes: readonly string[];
  /** Freeform words, in the locale's own script. */
  words: readonly string[];
  /**
   * Builds a postcode. A function and not a format string because the shapes
   * genuinely differ in kind: UK interleaves letters and digits, JP hyphenates.
   */
  postcode: (rng: () => number) => string;
  /**
   * A phone number from a REGULATOR-RESERVED range, or the reason there is
   * none. Null is the honest answer for four of the six locales.
   */
  phone: ((rng: () => number) => string) | null;
}

const DIGITS = '0123456789';
const UK_POSTCODE_LETTERS = 'ABDEFGHJLNPQRSTUWXYZ'; // No C/I/K/M/O/V in some positions; this subset is safe everywhere.

function digitRun(length: number, rng: () => number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += pick(DIGITS.split(''), rng);
  return out;
}

const LOCALE_PROFILES: Record<SyntheticLocale, LocaleProfile> = {
  'en-US': {
    tag: 'en-US',
    rtl: false,
    familyNameFirst: false,
    givenNames: ['Ada', 'Bram', 'Cleo', 'Dara', 'Esme', 'Finn', 'Gale', 'Hana'],
    familyNames: ['Ashby', 'Blyth', 'Calder', 'Dunmore', 'Ellery', 'Garrow', 'Hollis', 'Ingram'],
    streets: ['Alder Lane', 'Birchwood Road', 'Cobbler Street', 'Dunlin Way'],
    cities: ['Ashford Vale', 'Brimley', 'Castleton Rise', 'Easthollow'],
    countryCode: 'US',
    countryName: 'United States',
    decimalSeparator: '.',
    groupSeparator: ',',
    currencySymbol: '$',
    currencyAfter: false,
    percentSpace: false,
    twelveHourClock: true,
    companySuffixes: ['LLC', 'Inc.'],
    words: ['anchor', 'bramble', 'cobalt', 'driftwood', 'ember', 'fathom'],
    postcode: (rng) => digitRun(5, rng),
    // The 555-01XX line number inside any area code is a NANPA allocation held
    // back for fictional use — a standard, not a vendor convention.
    phone: (rng) => `+1 555 555 01${digitRun(2, rng)}`,
  },
  'en-GB': {
    tag: 'en-GB',
    rtl: false,
    familyNameFirst: false,
    givenNames: ['Alfie', 'Bryn', 'Clara', 'Dilys', 'Eira', 'Ffion', 'Gwyn', 'Huw'],
    familyNames: ['Attwood', 'Beddowes', 'Caldicott', 'Dewhurst', 'Enys', 'Fairhaven'],
    streets: ['Alder Close', 'Beechcroft Terrace', 'Chandlers Walk', 'Dovecote Rise'],
    cities: ['Ashwell', 'Brackenthorpe', 'Cheddington', 'Dunmere'],
    countryCode: 'GB',
    countryName: 'United Kingdom',
    decimalSeparator: '.',
    groupSeparator: ',',
    currencySymbol: '£',
    currencyAfter: false,
    percentSpace: false,
    twelveHourClock: false,
    companySuffixes: ['Ltd', 'PLC'],
    words: ['anchor', 'bramble', 'cobalt', 'driftwood', 'ember', 'fathom'],
    // Outward code, space, inward code: two letters, a digit, then a digit and
    // two letters. The alphanumeric shape is the whole reason this locale is here.
    postcode: (rng) =>
      `${pick(UK_POSTCODE_LETTERS.split(''), rng)}${pick(UK_POSTCODE_LETTERS.split(''), rng)}${digitRun(1, rng)} ${digitRun(1, rng)}${pick(UK_POSTCODE_LETTERS.split(''), rng)}${pick(UK_POSTCODE_LETTERS.split(''), rng)}`,
    // Ofcom reserves 07700 900000-900999 for drama use.
    phone: (rng) => `+44 7700 900${digitRun(3, rng)}`,
  },
  'de-DE': {
    tag: 'de-DE',
    rtl: false,
    familyNameFirst: false,
    givenNames: ['Anneke', 'Bodo', 'Carsta', 'Detlev', 'Elke', 'Falk', 'Gesa', 'Hark'],
    familyNames: ['Ahlers', 'Brauer', 'Cordes', 'Dreyer', 'Emmrich', 'Fiedler'],
    streets: ['Ahornweg', 'Birkenallee', 'Cuxhavener Straße', 'Deichstraße'],
    cities: ['Altenfeld', 'Bergheide', 'Clausthal Rode', 'Dorfmark'],
    countryCode: 'DE',
    countryName: 'Deutschland',
    decimalSeparator: ',',
    groupSeparator: '.',
    currencySymbol: '€',
    currencyAfter: true,
    percentSpace: false,
    twelveHourClock: false,
    companySuffixes: ['GmbH', 'AG'],
    words: ['Anker', 'Brombeere', 'Kobalt', 'Treibholz', 'Glut', 'Hafen'],
    postcode: (rng) => digitRun(5, rng),
    // The Bundesnetzagentur allocates ranges for drama use, and I cannot
    // reproduce them with confidence. An invented German mobile number may well
    // be somebody's, so there is no value here and the reason travels instead.
    phone: null,
  },
  'fr-FR': {
    tag: 'fr-FR',
    rtl: false,
    familyNameFirst: false,
    givenNames: ['Amélie', 'Bastien', 'Céline', 'Damien', 'Élodie', 'Fabrice', 'Gaël', 'Hélène'],
    familyNames: ['Aubriot', 'Bélanger', 'Chastain', 'Devaux', 'Éloi', 'Fourcade'],
    streets: ['Allée des Aulnes', 'Boulevard Bérenger', 'Chemin du Clos', 'Rue Delacroix'],
    cities: ['Aubagne Rive', 'Bellecour', 'Chantemerle', 'Doucette'],
    countryCode: 'FR',
    countryName: 'France',
    decimalSeparator: ',',
    groupSeparator: ' ',
    currencySymbol: '€',
    currencyAfter: true,
    // French typography puts a space before the percent sign. A validator with
    // /^\d+%$/ rejects it, which is the defect this flag reaches.
    percentSpace: true,
    twelveHourClock: false,
    companySuffixes: ['SARL', 'SAS'],
    words: ['ancre', 'ronce', 'cobalt', 'bois flotté', 'braise', 'brasse'],
    postcode: (rng) => digitRun(5, rng),
    phone: null,
  },
  'ja-JP': {
    tag: 'ja-JP',
    rtl: false,
    // Family name first. A form that concatenates given + family in this locale
    // prints every name backwards, and no en-US run can see it.
    familyNameFirst: true,
    givenNames: ['アオイ', 'ハルト', 'ミサキ', 'ユウタ', 'サクラ', 'レン'],
    familyNames: ['青木', '井上', '榎本', '桜井', '滝沢', '村田'],
    streets: ['一丁目1-1', '二丁目2-3', '三丁目4-5', '四丁目6-7'],
    cities: ['港区', '中央区', '西区', '北区'],
    countryCode: 'JP',
    countryName: '日本',
    decimalSeparator: '.',
    groupSeparator: ',',
    currencySymbol: '¥',
    currencyAfter: false,
    percentSpace: false,
    twelveHourClock: false,
    companySuffixes: ['株式会社', '合同会社'],
    words: ['いかり', 'きいちご', 'コバルト', 'りゅうぼく', 'おきび', 'みなと'],
    // Seven digits with a hyphen after the third. A field with maxlength 5 or a
    // digits-only validator rejects every Japanese address.
    postcode: (rng) => `${digitRun(3, rng)}-${digitRun(4, rng)}`,
    phone: null,
  },
  'ar-EG': {
    tag: 'ar-EG',
    // The one that re-lays-out the page rather than swapping strings.
    rtl: true,
    familyNameFirst: false,
    givenNames: ['أمينة', 'بشير', 'ثريا', 'جميل', 'حسناء', 'خالد'],
    familyNames: ['الأنصاري', 'البكري', 'التلمساني', 'الجوهري', 'الحسيني'],
    streets: ['شارع النيل', 'شارع الهرم', 'شارع الجمهورية', 'شارع البحر'],
    cities: ['المعادي', 'الزمالك', 'مصر الجديدة', 'الدقي'],
    countryCode: 'EG',
    countryName: 'مصر',
    decimalSeparator: '.',
    groupSeparator: ',',
    currencySymbol: 'ج.م',
    currencyAfter: true,
    percentSpace: false,
    twelveHourClock: true,
    companySuffixes: ['ش.م.م'],
    words: ['مرساة', 'عليق', 'كوبالت', 'خشب', 'جمرة', 'ميناء'],
    postcode: (rng) => digitRun(5, rng),
    phone: null,
  },
};

/** The locale's facts, for a caller that needs them without generating a value. */
export function localeProfile(locale: SyntheticLocale): {
  tag: SyntheticLocale;
  rtl: boolean;
  decimalSeparator: string;
  twelveHourClock: boolean;
  hasReservedPhoneRange: boolean;
} {
  const p = LOCALE_PROFILES[locale];
  return {
    tag: p.tag,
    rtl: p.rtl,
    decimalSeparator: p.decimalSeparator,
    twelveHourClock: p.twelveHourClock,
    hasReservedPhoneRange: p.phone !== null,
  };
}

/**
 * Which semantics this module generates itself, and which it delegates.
 *
 * ONE TABLE rather than a judgement spread over the file, so "does locale
 * change this value?" has a single answer a reader can check. A `Record` over
 * the whole union, so a new semantic cannot be added without deciding.
 *
 * The `false` rows are the interesting ones. An email address is NOT locale
 * sensitive — it is an RFC-reserved domain and a token, and localising it would
 * mean inventing an internationalised domain name, which is a different test
 * (and one `synthetic.ts`'s pattern machinery should own, not this file). A card
 * number is a provider's published test value and must be byte-identical
 * everywhere. A password is generated to a policy, not to a culture.
 */
export const LOCALE_SENSITIVE: Record<SyntheticSemantic, boolean> = {
  person_name: true,
  street_address: true,
  city: true,
  postal_code: true,
  country: true,
  phone: true,
  currency: true,
  number: true,
  date: true,
  freeform: true,
  company: true,
  time: true,
  percentage: true,
  // Delegated verbatim to the shared factory.
  email: false,
  username: false,
  password: false,
  credit_card: false,
  card_expiry: false,
  card_cvc: false,
  url: false,
  search: false,
  unknown: false,
};

// ─── Free text at several lengths ────────────────────────────────────────────

/**
 * The length ladder, as named rungs.
 *
 * Named rather than numeric because the name ends up in a test title: "accepts a
 * paragraph in the notes field" is reviewable and "accepts a 280-character
 * string" is not. The numbers are deliberately NOT boundary values — one over a
 * maxlength is `packages/agent/src/boundaries.ts`'s job and duplicating it here
 * would put two modules in charge of the same assertion. These are ordinary
 * lengths a real user produces, which is the gap: every free-text field in the
 * suite currently gets one word.
 */
export const TEXT_LENGTHS = ['tiny', 'short', 'sentence', 'paragraph', 'long'] as const;
export type TextLength = (typeof TEXT_LENGTHS)[number];

/** Compile-time half of the parity guard. */
const TEXT_LENGTH_PRESENT: Record<TextLength, true> = {
  tiny: true,
  short: true,
  sentence: true,
  paragraph: true,
  long: true,
};

/** Derived, never hand-listed. */
export const TEXT_LENGTH_LIST = Object.keys(TEXT_LENGTH_PRESENT) as ReadonlyArray<TextLength>;

/** Target character counts. Approximate by design: word boundaries win. */
const TEXT_TARGET_CHARS: Record<TextLength, number> = {
  tiny: 3,
  short: 24,
  sentence: 90,
  paragraph: 320,
  long: 1200,
};

// ─── The value ───────────────────────────────────────────────────────────────

/** The facts every generated value carries, available or not. */
interface ValueFacts {
  semantic: SyntheticSemantic;
  locale: SyntheticLocale;
  /** The (seed, scope, semantic, index, locale) identity. Stable and greppable. */
  key: string;
  uniqueness: UniquenessScope;
  cleanup: CleanupObligation;
}

/**
 * A generated value, or a recorded refusal to generate one.
 *
 * A DISCRIMINATED UNION and not a nullable string, so a caller cannot read
 * `.value` without having handled the unavailable case. That is the difference
 * between a German phone field reported as unfilled-and-why and one quietly
 * filled with a number that might ring somebody.
 */
export type LocalisedValue =
  | (ValueFacts & {
      available: true;
      value: string;
      /** The run token, so a stray staging row can be traced back to a run. */
      token: string;
    })
  | (ValueFacts & {
      available: false;
      reason: UnavailableReason;
      /** One sentence naming what is missing and what would fix it. */
      detail: string;
    });

/** What the factory needs. Every source of non-determinism is an argument. */
export interface LocalisedFactoryOptions {
  /** The run seed. Uniqueness across runs comes from here and nowhere else. */
  seed: string | number;
  /** Narrows below the run: a test id, a journey, a form. */
  scope?: string;
  locale?: SyntheticLocale;
  /** ISO instant every date and time is derived from. Defaults to the frozen clock. */
  now?: string;
  /** Override the reserved mail domain, e.g. to point at a local mail sink. */
  emailDomain?: string;
}

export interface LocalisedFactory {
  readonly seed: string;
  readonly scope: string;
  readonly locale: SyntheticLocale;
  readonly token: string;
  /** One value for a semantic. `index` makes two of the same semantic differ. */
  value(semantic: SyntheticSemantic, index?: number): LocalisedValue;
  /** Free text at a named length. */
  text(length: TextLength, index?: number): LocalisedValue;
  /** A narrower factory — `factory.scoped(testId)` per test. */
  scoped(key: string): LocalisedFactory;
  /** The same factory in another locale, for a locale sweep. */
  inLocale(locale: SyntheticLocale): LocalisedFactory;
}

/** Six base-36 characters of the key's hash. Stable, short, greppable. */
function tokenFor(key: string): string {
  return fnv1a32(key).toString(36).padStart(6, '0').slice(-6);
}

/**
 * The identity of a value: (seed, scope, semantic, index, locale).
 *
 * LOCALE IS IN THE KEY, which is a decision worth stating. It means the same
 * field generates a different value in a German run than in an American one.
 * That is correct — they are different cells of the device-and-locale axis and
 * a shared value would make a collision between them look like a product bug —
 * and it is the reason "two steps of one journey agree" holds only WITHIN a
 * locale. A journey that switched locale mid-flight would be two journeys.
 *
 * NUL-separated so no component can forge another: a scope called `a\u0000b`
 * is not a thing, where a scope called `a/b` would be ambiguous with a nested
 * scope.
 */
function keyFor(
  seed: string,
  scope: string,
  locale: SyntheticLocale,
  semantic: string,
  index: number,
): string {
  return `${seed}\u0000${scope}\u0000${locale}\u0000${semantic}\u0000${index}`;
}

export function createLocalisedFactory(options: LocalisedFactoryOptions): LocalisedFactory {
  const seed = String(options.seed);
  const scope = options.scope ?? '';
  const locale = options.locale ?? DEFAULT_SYNTHETIC_LOCALE;
  const now = options.now ?? SYNTHETIC_CLOCK;

  return {
    seed,
    scope,
    locale,
    token: tokenFor(keyFor(seed, scope, locale, '', 0)),
    value: (semantic, index = 0) =>
      localisedValue(semantic, index, { seed, scope, locale, now, emailDomain: options.emailDomain }),
    text: (length, index = 0) =>
      localisedText(length, index, { seed, scope, locale, now }),
    scoped: (key) =>
      createLocalisedFactory({
        ...options,
        seed,
        locale,
        scope: scope === '' ? key : `${scope}/${key}`,
      }),
    inLocale: (next) => createLocalisedFactory({ ...options, seed, scope, locale: next }),
  };
}

interface GenOptions {
  seed: string;
  scope: string;
  locale: SyntheticLocale;
  now: string;
  emailDomain?: string;
}

/**
 * One value. Pure: the same arguments give the same result in every process,
 * forever.
 */
export function localisedValue(
  semantic: SyntheticSemantic,
  index: number,
  options: GenOptions,
): LocalisedValue {
  const { seed, scope, locale, now } = options;
  const key = keyFor(seed, scope, locale, semantic, index);
  const facts: ValueFacts = {
    semantic,
    locale,
    key,
    uniqueness: extendedUniquenessFor(semantic),
    cleanup: extendedCleanupFor(semantic),
  };
  const token = tokenFor(key);

  // ── Delegate everything locale does not change ────────────────────────────
  //
  // The shared factory owns constraint fitting, pattern satisfaction and the
  // reserved-domain email, and re-deriving any of it here would mean two
  // modules deciding what a run's email is.
  // `!isExtended` narrows the union to `FormFieldSemantic`, which is what makes
  // this branch type-safe with NO CAST. An earlier draft wrote
  // `semantic as FormFieldSemantic` and justified it in a comment — i.e. it was
  // correct by convention, and would have become a lie the moment somebody
  // marked an extended semantic locale-insensitive. If that happens now, the
  // value falls through to the switch's default and is recorded
  // NO_LOCALE_FORM: honest, and not a cast that quietly hands the shared
  // factory a semantic it has no arm for.
  if (!LOCALE_SENSITIVE[semantic] && !isExtended(semantic)) {
    const field: SyntheticField = {
      name: `${semantic}#${index}`,
      semantic,
    };
    const delegated = syntheticValue(field, {
      seed,
      // The locale rides in the scope so a locale sweep gets distinct values
      // from the shared generator without it needing to know about locales.
      scope: `${scope}\u0000${locale}`,
      now,
      emailDomain: options.emailDomain,
    });
    return { ...facts, available: true, value: delegated.value, token };
  }

  const rng = mulberry32(fnv1a32(key));
  const p = LOCALE_PROFILES[locale];

  switch (semantic) {
    case 'person_name': {
      const given = pick(p.givenNames, rng);
      const family = pick(p.familyNames, rng);
      // Japanese writes the family name first. A form that concatenates
      // given + family unconditionally prints every name backwards here.
      const value = p.familyNameFirst ? `${family} ${given}` : `${given} ${family}`;
      return { ...facts, available: true, value, token };
    }

    case 'street_address': {
      const street = pick(p.streets, rng);
      const number = 1 + Math.floor(rng() * 98);
      // Japan numbers the block, not the building, and the number comes first
      // in the written form — so the street string already carries it.
      const value = locale === 'ja-JP' ? `${pick(p.cities, rng)}${street}` : `${number} ${street}`;
      return { ...facts, available: true, value, token };
    }

    case 'city':
      return { ...facts, available: true, value: pick(p.cities, rng), token };

    case 'postal_code':
      return { ...facts, available: true, value: p.postcode(rng), token };

    case 'country':
      return { ...facts, available: true, value: p.countryName, token };

    case 'phone': {
      /*
       * THE REFUSAL THAT MAKES THIS FILE HONEST.
       *
       * Four of six locales have no reserved range I can vouch for, and an
       * invented German mobile number may well be somebody's. So there is no
       * value and the reason travels in its place.
       */
      if (p.phone === null) {
        return {
          ...facts,
          available: false,
          reason: 'NO_RESERVED_RANGE',
          detail: `No regulator-reserved test phone range is known for ${locale}, so any number generated here could belong to a real person. Fill this field from a customer-supplied test number on an AuthProfile row, or drive the flow in en-US or en-GB where NANPA and Ofcom publish reserved ranges.`,
        };
      }
      return { ...facts, available: true, value: p.phone(rng), token };
    }

    case 'currency': {
      const amount = formatDecimal(1 + Math.floor(rng() * 98_765) / 100, p);
      const value = p.currencyAfter ? `${amount} ${p.currencySymbol}` : `${p.currencySymbol}${amount}`;
      return { ...facts, available: true, value, token };
    }

    case 'number':
      // The decimal separator is the point. `1234,56` through `parseFloat`
      // silently becomes 1234, and a billing form that loses the cents is a
      // money defect.
      return {
        ...facts,
        available: true,
        value: formatDecimal(1 + Math.floor(rng() * 9_999) / 100, p),
        token,
      };

    case 'percentage': {
      const magnitude = formatDecimal(Math.floor(rng() * 10_000) / 100, p);
      // French typography puts a space before the sign; /^\d+%$/ rejects it.
      return {
        ...facts,
        available: true,
        value: `${magnitude}${p.percentSpace ? '\u00a0' : ''}%`,
        token,
      };
    }

    case 'date': {
      const base = new Date(now);
      if (Number.isNaN(base.getTime())) {
        return {
          ...facts,
          available: false,
          reason: 'NO_LOCALE_FORM',
          detail: `The injected clock "${now}" is not a parseable ISO instant, so no date could be derived from it. Pass a valid \`now\`; this module has no ambient clock to fall back on, deliberately.`,
        };
      }
      // Deterministic offset, then the locale's written order. Not an ISO
      // string: the whole point is the order a human types.
      const day = new Date(base.getTime() + Math.floor(rng() * 300) * 86_400_000);
      return { ...facts, available: true, value: writeDate(day, locale), token };
    }

    case 'time': {
      const hour = Math.floor(rng() * 24);
      const minute = Math.floor(rng() * 60);
      return { ...facts, available: true, value: writeTime(hour, minute, p), token };
    }

    case 'company': {
      const word = pick(p.words, rng);
      const suffix = pick(p.companySuffixes, rng);
      const head = `${word.charAt(0).toLocaleUpperCase(locale)}${word.slice(1)}`;
      // Japanese puts the company type first: 株式会社ミナト, not ミナト株式会社.
      const value = locale === 'ja-JP' ? `${suffix}${word}` : `${head} ${suffix}`;
      return { ...facts, available: true, value: `${value} ${token}`, token };
    }

    case 'freeform':
      return { ...facts, available: true, value: buildText('short', p, rng), token };

    default: {
      /*
       * Unreachable while LOCALE_SENSITIVE and this switch agree, and the
       * module's test asserts they do — every locale-sensitive semantic has an
       * arm. Reported rather than thrown, because a generator that throws on a
       * new semantic takes down a whole run where one that records an
       * unavailable value loses one field.
       */
      return {
        ...facts,
        available: false,
        reason: 'NO_LOCALE_FORM',
        detail: `"${semantic}" is marked locale-sensitive in LOCALE_SENSITIVE and has no generation arm, so nothing could be produced for it. This is a gap in QAAI, not in the application.`,
      };
    }
  }
}

/** Free text at a named length, in the locale's own script. */
export function localisedText(
  length: TextLength,
  index: number,
  options: Omit<GenOptions, 'emailDomain'>,
): LocalisedValue {
  const { seed, scope, locale } = options;
  const key = keyFor(seed, scope, locale, `text:${length}`, index);
  const rng = mulberry32(fnv1a32(key));
  const p = LOCALE_PROFILES[locale];
  return {
    semantic: 'freeform',
    locale,
    key,
    uniqueness: extendedUniquenessFor('freeform'),
    cleanup: extendedCleanupFor('freeform'),
    available: true,
    value: buildText(length, p, rng),
    token: tokenFor(key),
  };
}

function buildText(length: TextLength, p: LocaleProfile, rng: () => number): string {
  const target = TEXT_TARGET_CHARS[length];
  // A word-joined string rather than a repeated character: a validator that
  // strips whitespace, or a renderer that cannot wrap, is only reachable with
  // real word boundaries. CJK and Arabic words come from the locale's own pool,
  // so a byte-counted maxlength is reachable too.
  const words: string[] = [];
  let size = 0;
  while (size < target) {
    const word = pick(p.words, rng);
    words.push(word);
    size += word.length + 1;
  }
  const joined = words.join(' ');
  return joined.length > target * 1.2 ? joined.slice(0, target) : joined;
}

function formatDecimal(value: number, p: LocaleProfile): string {
  const [whole = '0', fraction = '00'] = value.toFixed(2).split('.');
  const grouped =
    p.groupSeparator === ''
      ? whole
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, p.groupSeparator);
  return `${grouped}${p.decimalSeparator}${fraction}`;
}

/**
 * The date in the order the locale writes it.
 *
 * Built from UTC parts on purpose: `getMonth()` reads the HOST timezone, so the
 * same seed would produce a different date on a machine in Auckland than on one
 * in London — an ambient clock arriving through the back door, and exactly the
 * non-determinism rule 10 forbids.
 */
function writeDate(date: Date, locale: SyntheticLocale): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  switch (locale) {
    // Month first, which is the ambiguity: 03/04 is two different days in two
    // of these locales, and a suite that only runs one never finds out.
    case 'en-US':
      return `${month}/${day}/${year}`;
    case 'en-GB':
      return `${day}/${month}/${year}`;
    case 'de-DE':
      return `${day}.${month}.${year}`;
    case 'fr-FR':
      return `${day}/${month}/${year}`;
    case 'ja-JP':
      return `${year}/${month}/${day}`;
    case 'ar-EG':
      return `${day}/${month}/${year}`;
  }
}

function writeTime(hour: number, minute: number, p: LocaleProfile): string {
  const mm = String(minute).padStart(2, '0');
  if (!p.twelveHourClock) return `${String(hour).padStart(2, '0')}:${mm}`;
  // Midnight is 12 AM and noon is 12 PM: the two values a 12-hour renderer
  // written with `hour % 12` gets wrong, and the reason a time field is worth
  // generating rather than hardcoding.
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${mm} ${meridiem}`;
}

// ─── Does uniqueness actually hold? ──────────────────────────────────────────

/** One value's identity across the runs it was generated in. */
export interface UniquenessFinding {
  semantic: SyntheticSemantic;
  index: number;
  required: UniquenessScope;
  /** How many DISTINCT values the audited seeds produced. */
  distinct: number;
  /** How many seeds were audited. Equal to `distinct` when nothing collided. */
  seeds: number;
  /**
   * How many seeds produced NO VALUE — a refused phone number, an unparseable
   * clock.
   *
   * Carried explicitly because without it `distinct: 0` is ambiguous in exactly
   * the way rule 12 forbids: a reader has to infer whether it means "nothing
   * was generated" or "every run produced the same value". A genuine total
   * collision is `distinct: 1`, so the two are distinguishable — but only by
   * someone who knows that, and a report should not depend on its reader
   * reconstructing the invariant. With this field the parts sum:
   * `distinct <= seeds - unavailable`.
   */
  unavailable: number;
}

/** What the audit established, and — as loudly — what it did not. */
export interface UniquenessAudit {
  findings: readonly UniquenessFinding[];
  /**
   * The values that must not repeat across runs and did. Empty is the only
   * acceptable result: a non-empty entry here is the cross-run flake.
   */
  collisions: readonly UniquenessFinding[];
  /** Seeds compared. Stated because the strength of the result depends on it. */
  seedsCompared: number;
  /**
   * The honest limit of the result, in a sentence a report prints verbatim.
   *
   * Required rather than optional because an audit that reports zero collisions
   * and no caveat reads as a proof of global uniqueness, which a 32-bit hash
   * cannot give. A cap that bit must be reported as a count AND a reason.
   */
  caveat: string;
}

/**
 * Generate the same fields under several run seeds and report what repeated.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `SyntheticValue.uniqueness` says what a value NEEDS and nothing checked that
 * it got it. The failure mode is specific and expensive: the second nightly run
 * generates run 1's email, the signup hits a unique constraint, and the failure
 * reads as an application bug. Somebody spends a morning on it, finds the
 * fixture, and deletes the test.
 *
 * Takes the seeds as an ARGUMENT — it does not invent them — because an audit
 * that generated its own seeds would be testing its own seed generator.
 */
export function auditUniquenessAcrossRuns(
  requests: ReadonlyArray<{ semantic: SyntheticSemantic; index?: number }>,
  seeds: readonly string[],
  options: { scope?: string; locale?: SyntheticLocale; now?: string } = {},
): UniquenessAudit {
  const scope = options.scope ?? '';
  const locale = options.locale ?? DEFAULT_SYNTHETIC_LOCALE;
  const now = options.now ?? SYNTHETIC_CLOCK;

  const findings: UniquenessFinding[] = [];
  for (const request of requests) {
    const index = request.index ?? 0;
    const values = new Set<string>();
    let unavailable = 0;
    for (const seed of seeds) {
      const produced = localisedValue(request.semantic, index, { seed, scope, locale, now });
      // An unavailable value is not a collision — there is no value to collide.
      // Counting it as one would turn an honest refusal into a reported defect.
      if (produced.available) values.add(produced.value);
      else unavailable++;
    }
    findings.push({
      semantic: request.semantic,
      index,
      required: extendedUniquenessFor(request.semantic),
      distinct: values.size,
      seeds: seeds.length,
      unavailable,
    });
  }

  /*
   * A collision is: of the seeds that PRODUCED a value, two produced the same
   * one.
   *
   * The denominator is `seeds - unavailable`, not `seeds`, and that correction
   * is not cosmetic. The first version compared `distinct < seeds` and guarded
   * the all-unavailable case with `distinct > 0`, which is wrong for PARTIAL
   * unavailability: 60 seeds where 11 refuse and the other 49 all produce
   * different values gives `49 < 60`, and the audit would report a collision
   * that did not happen — an honest refusal re-reported as a defect, which is
   * the same class of lie as recording an unexercisable surface as a failing
   * one. No semantic that is GLOBALLY_UNIQUE can currently be unavailable, so
   * the path is latent rather than live; it is written correctly because the
   * next locale or semantic to arrive is what makes it live.
   */
  const collisions = findings.filter(
    (f) =>
      uniquenessAtLeast(f.required, 'GLOBALLY_UNIQUE') && f.distinct < f.seeds - f.unavailable,
  );

  return {
    findings,
    collisions,
    seedsCompared: seeds.length,
    caveat:
      `Checked ${seeds.length} seed(s). Uniqueness here rests on a 32-bit hash of ` +
      `(seed, scope, semantic, index, locale), which is ample for the dozens of values a run ` +
      `generates and is NOT a cryptographic guarantee — so this audit establishes that these ` +
      `seeds do not collide, not that no two seeds ever can. A caller needing a stronger ` +
      `promise must supply its own values.`,
  };
}

// ─── Cleanup the runner can actually execute ─────────────────────────────────

/**
 * Semantics whose value must never appear in a cleanup step.
 *
 * BINDING. A password, a TOTP secret and a session cookie are never logged,
 * echoed, returned or embedded — not truncated, not in an error path, not in a
 * fixture file. A cleanup ledger is written to a report and often committed, so
 * it is exactly the artefact that rule must hold for.
 *
 * In practice `cleanupFor('password')` is already NONE, so no password reaches
 * a step by the ordinary path. This set is the belt to that braces: if the
 * shared lookup ever changes, a step carrying a password is REFUSED and
 * recorded as refused rather than written out.
 */
const NEVER_IN_A_LEDGER: ReadonlySet<SyntheticSemantic> = new Set<SyntheticSemantic>([
  'password',
  'card_cvc',
  'credit_card',
]);

/** The obligations that are an ACTION. `NONE` and `UNKNOWN` are not steps. */
const EXECUTABLE_OBLIGATIONS = [
  'REVOKE_CREDENTIAL',
  'DELETE_ENTITY',
  'RELEASE_IDENTIFIER',
] as const satisfies ReadonlyArray<CleanupObligation>;
type ExecutableObligation = (typeof EXECUTABLE_OBLIGATIONS)[number];

const EXECUTABLE_OBLIGATION_SET: ReadonlySet<string> = new Set<string>(EXECUTABLE_OBLIGATIONS);

/**
 * Is this obligation one of the three that is an ACTION?
 *
 * THE LATENT DEFECT THIS CLOSES, which the lint rule found before a customer
 * did. `buildCleanupLedger` excluded the two non-actions by comparing against
 * the literals `'NONE'` and `'UNKNOWN'`, and TypeScript narrowed the rest to
 * {@link ExecutableObligation} — correct today, and silently wrong the day
 * `CLEANUP_OBLIGATIONS` grows a sixth member. A new obligation would pass both
 * literal checks, land in `pending`, and be sorted by
 * `OBLIGATION_ORDER[newMember]`, which is `undefined`: `undefined - number` is
 * `NaN`, and a comparator that returns `NaN` leaves the order UNSPECIFIED. That
 * is precisely the failure {@link buildCleanupLedger}'s own doc comment warns
 * about — "a cleanup plan that reorders between runs is a plan nobody can diff"
 * — arriving by the one route nothing checked.
 *
 * Deriving the guard from the array rather than from a second list of literals
 * is the whole point: the array, `OBLIGATION_ORDER` and this predicate cannot
 * drift, because `OBLIGATION_ORDER` is a `Record<ExecutableObligation, number>`
 * and the type comes from the array. Add a member and the compiler demands an
 * order for it; add one to `CLEANUP_OBLIGATIONS` alone and this refuses it and
 * RECORDS the refusal rather than producing an unordered plan.
 */
function isExecutableObligation(obligation: CleanupObligation): obligation is ExecutableObligation {
  return EXECUTABLE_OBLIGATION_SET.has(obligation);
}

/**
 * The order cleanup must run in, and it is load-bearing.
 *
 *   1. REVOKE_CREDENTIAL first. A live session can re-create rows behind a
 *      delete, and a token that outlives the run is a security finding of its
 *      own.
 *   2. DELETE_ENTITY next. The row has to go before the identifier it holds
 *      can be freed.
 *   3. RELEASE_IDENTIFIER last, because a unique index usually still holds the
 *      value until the owning row is gone — releasing first simply fails.
 *
 * Reversing 2 and 3 produces a cleanup that half-works and leaves exactly the
 * orphaned identifiers that make the NEXT run collide, which is the defect this
 * whole mechanism exists to prevent.
 */
const OBLIGATION_ORDER: Record<ExecutableObligation, number> = {
  REVOKE_CREDENTIAL: 1,
  DELETE_ENTITY: 2,
  RELEASE_IDENTIFIER: 3,
};

/** One thing a runner must undo. */
export interface CleanupStep {
  obligation: ExecutableObligation;
  /** Position in the ledger, 1-based. The ledger is sorted; this pins it. */
  order: number;
  semantic: SyntheticSemantic;
  /**
   * The IDENTIFIER to act on — an email, a username, a phone number. Never a
   * credential: see {@link NEVER_IN_A_LEDGER}.
   */
  identifier: string;
  /** The run token, so a stray row is attributable without guessing. */
  runToken: string;
  /** The value's full key, for a report that needs to say which step this was. */
  key: string;
}

/** A step that was NOT built, and why. Recorded, never dropped. */
export interface CleanupRefusal {
  semantic: SyntheticSemantic;
  key: string;
  reason: 'CREDENTIAL_SHAPED' | 'NO_VALUE_GENERATED' | 'NOT_EXECUTABLE';
  detail: string;
}

/** An obligation nobody could resolve. Visible and unresolved, never NONE. */
export interface CleanupUnresolved {
  semantic: SyntheticSemantic;
  key: string;
  detail: string;
}

export interface CleanupLedger {
  steps: readonly CleanupStep[];
  /** Obligations this module refused to turn into steps. */
  refused: readonly CleanupRefusal[];
  /**
   * `UNKNOWN` obligations: the generator could not tell whether a row was
   * created, so there is an obligation and nobody knows what it is.
   *
   * NOT folded into `NONE`, which would be a claim that nothing was created —
   * the quiet false statement that fills a customer's database. The scenario
   * that submitted the form knows, and `withCleanup` is how it says so.
   */
  unresolved: readonly CleanupUnresolved[];
  /** Values that needed nothing. Counted so the parts sum to the whole. */
  nothingToDo: number;
  /** Values considered, so a reader can check the accounting. */
  considered: number;
}

/**
 * Turn generated values into an ordered plan.
 *
 * Deterministic: the sort is by (obligation order, key), both of which are pure
 * functions of the inputs, so the same values give the same ledger in the same
 * order. A cleanup plan that reorders between runs is a plan nobody can diff.
 */
export function buildCleanupLedger(values: readonly LocalisedValue[]): CleanupLedger {
  const pending: Array<Omit<CleanupStep, 'order'>> = [];
  const refused: CleanupRefusal[] = [];
  const unresolved: CleanupUnresolved[] = [];
  let nothingToDo = 0;

  for (const value of values) {
    if (value.cleanup === 'NONE') {
      nothingToDo++;
      continue;
    }

    if (value.cleanup === 'UNKNOWN') {
      unresolved.push({
        semantic: value.semantic,
        key: value.key,
        detail:
          'The generator sees a FIELD and never a submission, so whether this value created a row is unknown. Resolve it with withCleanup() from the scenario that submitted the form — recording it as NONE would be a claim that nothing was created.',
      });
      continue;
    }

    if (!value.available) {
      // No value was generated, so there is nothing to clean up — but the
      // obligation existed, and silently dropping it would make the ledger's
      // counts stop summing.
      refused.push({
        semantic: value.semantic,
        key: value.key,
        reason: 'NO_VALUE_GENERATED',
        detail: `The value was unavailable (${value.reason}), so nothing was created and nothing can be cleaned up. Recorded rather than dropped so the ledger's counts account for every value considered.`,
      });
      continue;
    }

    if (NEVER_IN_A_LEDGER.has(value.semantic)) {
      refused.push({
        semantic: value.semantic,
        key: value.key,
        reason: 'CREDENTIAL_SHAPED',
        detail: `A "${value.semantic}" value is a credential and is never written into a ledger, which is reported, often committed, and read by people who are not the owner. Clean this up by revoking the account that holds it, keyed on its identifier.`,
      });
      continue;
    }

    /*
     * The belt to the two literal checks above. They are the braces: they cover
     * every member `CLEANUP_OBLIGATIONS` has today. This covers the member it
     * does not have yet — see `isExecutableObligation` for why an unordered
     * cleanup plan is the failure that would otherwise arrive here.
     */
    if (!isExecutableObligation(value.cleanup)) {
      refused.push({
        semantic: value.semantic,
        key: value.key,
        reason: 'NOT_EXECUTABLE',
        detail: `"${value.cleanup}" is not one of the three obligations this module knows how to turn into a step (${EXECUTABLE_OBLIGATIONS.join(', ')}), and it is not one of the two that mean there is nothing to do. It has no place in the running order, so emitting it would produce a plan whose steps sort unpredictably. Give it an order in OBLIGATION_ORDER and add it to EXECUTABLE_OBLIGATIONS, or decide it is not an action.`,
      });
      continue;
    }

    pending.push({
      obligation: value.cleanup,
      semantic: value.semantic,
      identifier: value.value,
      runToken: value.token,
      key: value.key,
    });
  }

  pending.sort((a, b) => {
    const byObligation = OBLIGATION_ORDER[a.obligation] - OBLIGATION_ORDER[b.obligation];
    return byObligation !== 0 ? byObligation : a.key.localeCompare(b.key);
  });

  return {
    steps: pending.map((step, i) => ({ ...step, order: i + 1 })),
    refused,
    unresolved,
    nothingToDo,
    considered: values.length,
  };
}

/** How one step ended. `ALREADY_ABSENT` is a success: cleanup is idempotent. */
export type CleanupOutcome = 'DELETED' | 'ALREADY_ABSENT' | 'FAILED';

/**
 * The one effect this module needs, as a narrow injected interface.
 *
 * ONE METHOD, and it takes a {@link CleanupStep} rather than a URL or a Prisma
 * client, so the ordering and accounting here is testable with a fake and the
 * real adapter — which does know about HTTP or Prisma — is thin. Never a
 * playwright `Page`, never a top-level `fetch`.
 */
export interface CleanupExecutor {
  perform(step: CleanupStep): Promise<{ outcome: CleanupOutcome; detail?: string }>;
}

/** What a cleanup run actually did. Every number here is a real count. */
export interface CleanupReport {
  deleted: number;
  alreadyAbsent: number;
  failed: number;
  /** Steps this module declined to build. Carried through from the ledger. */
  refused: number;
  /** Obligations nobody resolved. Carried through from the ledger. */
  unresolved: number;
  /**
   * Each failure, so none is suppressed without being counted. A cleanup that
   * swallows errors is how a staging database fills up while the report is
   * green.
   */
  failures: ReadonlyArray<{ key: string; semantic: SyntheticSemantic; detail: string }>;
  /** True only when every step succeeded AND nothing was left unresolved. */
  complete: boolean;
}

/**
 * Run the ledger.
 *
 * ─── IT DOES NOT STOP AT THE FIRST FAILURE ──────────────────────────────────
 *
 * On purpose. A cleanup that aborts on the first error leaves every later row
 * behind, and the later rows are the ones carrying the unique identifiers the
 * next run needs. So every step is attempted, failures are COUNTED and
 * REPORTED, and `complete` is false — rather than an exception that loses both
 * the work done and the work outstanding.
 *
 * A throwing executor is treated as a FAILED step and not allowed to end the
 * run, for the same reason.
 */
export async function executeCleanupLedger(
  ledger: CleanupLedger,
  executor: CleanupExecutor,
): Promise<CleanupReport> {
  let deleted = 0;
  let alreadyAbsent = 0;
  const failures: Array<{ key: string; semantic: SyntheticSemantic; detail: string }> = [];

  for (const step of ledger.steps) {
    try {
      const result = await executor.perform(step);
      if (result.outcome === 'DELETED') deleted++;
      else if (result.outcome === 'ALREADY_ABSENT') alreadyAbsent++;
      else {
        failures.push({
          key: step.key,
          semantic: step.semantic,
          detail: result.detail ?? 'the executor reported FAILED and gave no detail',
        });
      }
    } catch (error) {
      failures.push({
        key: step.key,
        semantic: step.semantic,
        detail: `the executor threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    deleted,
    alreadyAbsent,
    failed: failures.length,
    refused: ledger.refused.length,
    unresolved: ledger.unresolved.length,
    failures,
    // An unresolved obligation means rows MAY have been left behind, so a run
    // with one is not complete. Reporting it complete would be the "pass that
    // means we did not check".
    complete: failures.length === 0 && ledger.unresolved.length === 0,
  };
}

/**
 * One paragraph a human reads after a cleanup run, leading with what was NOT
 * done.
 */
export function describeCleanup(report: CleanupReport): string {
  const parts = [
    `${report.deleted} cleaned up, ${report.alreadyAbsent} already gone.`,
  ];
  if (report.failed > 0) {
    parts.push(
      `${report.failed} FAILED and the rows are still there: ${report.failures.map((f) => `${f.semantic} (${f.detail})`).join('; ')}.`,
    );
  }
  if (report.unresolved > 0) {
    parts.push(
      `${report.unresolved} obligation(s) could not be resolved, so rows may have been left behind that nobody can attribute — this is why the run is not reported complete.`,
    );
  }
  if (report.refused > 0) {
    parts.push(
      `${report.refused} obligation(s) were refused rather than executed (a credential-shaped value, or no value generated); see the ledger for which and why.`,
    );
  }
  return parts.join(' ');
}
