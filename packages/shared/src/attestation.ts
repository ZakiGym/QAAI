/**
 * The attestation envelope — the artefact a buyer is handed, and the one place
 * in this product where silence is read as a guarantee.
 *
 * WHY THIS FILE EXISTS
 *
 * The coverage number has never left one authenticated screen. grep for
 * coverage in `github-app.ts`, `badges.ts` and `digest.ts` returns nothing;
 * there is no export, no permalink, no fingerprint. The moment any of that
 * exists, a PDF with "87% coverage" on it starts arriving in procurement
 * folders and security questionnaires, and at that point the document is the
 * product.
 *
 * ── THE ASYMMETRY THAT GOVERNS EVERY DECISION BELOW ─────────────────────────
 *
 * AN ATTESTATION THAT DOES NOT SAY WHAT WAS NOT MEASURED IS WORSE THAN NO
 * ATTESTATION AT ALL.
 *
 * A reader given a percentage and no scope does not conclude "scope unknown".
 * They conclude "87% of the application, and the other 13% is ordinary
 * untested code" — because that is what every coverage number they have ever
 * seen meant. If in fact nine axes were never measured, four test types cannot
 * execute on this deployment and a page budget truncated the crawl at 1,000
 * URLs, the reader has been told something false by a document that contained
 * no false sentence. Omission is the lie, which is why the scope statement, the
 * unmeasured list and the cap list are not optional fields with sensible
 * defaults: they are REQUIRED INPUTS, and the envelope is unconstructable
 * without them.
 *
 * ── HOW "REQUIRED" IS ENFORCED AT THE TYPE LEVEL ────────────────────────────
 *
 * {@link CoverageAttestation} carries a private brand, so no object literal
 * anywhere can be assigned to it. {@link attest} is the only function that can
 * produce one, and its input declares `scopeStatement`, `unmeasured` and `caps`
 * as REQUIRED properties — not `?`, not defaulted. A caller who has not thought
 * about scope does not get a document with an empty scope section; they get a
 * compile error. The run-time checks in `attest` then refuse the shapes the
 * type system cannot see, which is an empty statement and a list of entries
 * missing their reasons.
 *
 * That is deliberately stronger than the convention used elsewhere in this
 * codebase. `SuiteHealthSnapshot.caveats` defaults to `[]` and that is correct
 * there, because an empty caveat list is a positive and verifiable claim that
 * nothing was truncated during a scan. Here the same default would be a claim
 * that nothing was unmeasured in a round that added thirteen axes and measured
 * none of them yet.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It renders nothing and reads nothing. No CSV, no HTML, no PDF, no clock and
 * no `node:crypto` — the digest is INJECTED, exactly as
 * `requirementContentHash` takes one, because `packages/shared/src/index.ts` is
 * what the web bundler consumes and a Node builtin in the barrel breaks every
 * page that imports a value from @qaai/shared. The canonicalisation is the part
 * that goes wrong and it is pure, so it lives here; hashing is ten lines of
 * somebody else's cryptography and it does not.
 */

import type {
  CoverageDimensionKind,
  DimensionCapBite,
  DimensionUnmeasuredReason,
} from './coverage-dimensions';
import { DIMENSION_UNMEASURED_REASON_LABELS } from './coverage-dimensions';
import type { ContentDigest } from './requirements';
import type { SurfaceKind } from './surface';

// ─── The scope: what was NOT measured ───────────────────────────────────────

/**
 * One axis this attestation did not measure, and why.
 *
 * `dimension` and `kind` are both nullable and at least one must be set,
 * because the two vocabularies name different things and an attestation has to
 * be able to disclose either: `SURFACE_KINDS` is the inventory axis ("we do not
 * enumerate background jobs") and `COVERAGE_DIMENSIONS` is the breakdown axis
 * ("we do not measure validation rules"). Forcing one of the two would have
 * meant silently dropping half the disclosures.
 *
 * `reason` is the same closed vocabulary the measurements use, so the sentence
 * in the document and the sentence on the screen cannot diverge — a buyer who
 * reads the PDF and then logs in must not find a different explanation.
 */
export interface AttestationUnmeasured {
  /** The breakdown axis, when that is what was unmeasured. */
  dimension: CoverageDimensionKind | null;
  /** The inventory axis, when that is what was unmeasured. */
  kind: SurfaceKind | null;
  reason: DimensionUnmeasuredReason;
  /**
   * The sentence the document prints. Required, and refused when empty: a
   * reason code with no sentence is a disclosure only somebody holding this
   * repository can read.
   */
  detail: string;
  /** Cells known to exist and not measured, when the count is known at all. */
  cells: number | null;
}

/**
 * A cap that bit while this measurement was taken.
 *
 * The same shape the measurements carry, re-exported through this module's
 * input rather than redefined, so "at least 240 more form fields existed" is
 * one sentence with one source. Rule 10: every budget, take, limit, page size
 * and timeout that BIT is reported as a count AND as a reason.
 */
export type AttestationCap = DimensionCapBite;

// ─── The envelope ───────────────────────────────────────────────────────────

/**
 * Everything an attestation is built from.
 *
 * Note which fields are nullable and which are not, because the split is the
 * contract. `percent` is nullable — a measurement with an empty denominator has
 * no figure and printing 0 or 100 would be a claim assembled from our own
 * silence. `scopeStatement`, `unmeasured` and `caps` are NOT nullable and NOT
 * optional, for the reason in the header.
 */
export interface AttestationInput {
  projectId: string;
  /** The stored snapshot this attests to. Null for an unsaved computation. */
  snapshotId: string | null;
  /** ISO-8601, passed in. This module never reads a clock. */
  issuedAtIso: string;
  /** Who asked for it, when a user did. Null for a scheduled export. */
  issuedByUserId: string | null;

  /**
   * The version of the enumerator that produced the inventory. Required: two
   * attestations from different crawl versions are not comparable, and a
   * document that does not say which crawl produced it cannot be checked
   * against a later one.
   */
  crawlVersion: string;
  /**
   * The fingerprint of the crawl itself, when one was recorded. Null for a
   * source-only measurement, which has no crawl — not for a crawl whose
   * fingerprint nobody wrote down, which is a writer bug the reader must be
   * able to see as `UNCOMPARABLE_FINGERPRINT_MISSING`.
   */
  crawlFingerprint: string | null;
  /**
   * THE SENTENCE THAT SAYS WHAT WAS DIVIDED BY: which axes are in the
   * denominator, which waivers were applied, which scope rules the customer
   * configured. Without it the percentage is a number with no units.
   */
  denominatorDefinition: string;

  /** The headline, or null when there was nothing to divide. */
  percent: number | null;
  denominator: number;
  covered: number;

  /**
   * THE MANDATORY SCOPE STATEMENT, in the customer's terms: what this document
   * does and does not claim. Refused when empty.
   */
  scopeStatement: string;
  /** Every axis not measured, each with its reason. May be empty only truthfully. */
  unmeasured: readonly AttestationUnmeasured[];
  /** Every cap that bit. May be empty only truthfully. */
  caps: readonly AttestationCap[];
}

/**
 * The brand. Private to this module, so `CoverageAttestation` is nominal: an
 * object literal with every field right still cannot be assigned to it, and
 * {@link attest} is the only door.
 *
 * This is the mechanism that makes the scope statement a type-level
 * requirement rather than a convention. Without it the next writer in a hurry
 * assembles the envelope by hand with no unmeasured list, it compiles, and the
 * document ships claiming nothing was unmeasured.
 *
 * A REAL symbol and not a `declare const`, which is the form this started as
 * and is a bug: a declared-only symbol has no runtime value, so the
 * destructuring in `attestationPayload` would have thrown a ReferenceError the
 * first time anything serialised an attestation — a type-level guard that
 * breaks the run-time path it was protecting. `Symbol()` in a module-private
 * `const` is inferred as `unique symbol`, so the nominality is identical and
 * the value exists; `JSON.stringify` drops symbol keys, which is why
 * `attestationPayload` is a function rather than a cast.
 */
const ATTESTED = Symbol('qaai.coverage.attestation');

/**
 * A signed, dated, scoped coverage statement.
 *
 * `fingerprint` is stable over (denominator definition, crawl version, item
 * set) — see {@link attestationCanonicalText} for exactly what goes into it and
 * what deliberately does not.
 */
export interface CoverageAttestation {
  /** The brand. Not serialised; `attestationPayload` strips it. */
  readonly [ATTESTED]: true;

  projectId: string;
  snapshotId: string | null;
  issuedAtIso: string;
  issuedByUserId: string | null;

  crawlVersion: string;
  crawlFingerprint: string | null;
  denominatorDefinition: string;

  percent: number | null;
  denominator: number;
  covered: number;

  scopeStatement: string;
  unmeasured: readonly AttestationUnmeasured[];
  caps: readonly AttestationCap[];

  /**
   * The identity of the claim, so two attestations can be compared without
   * reading them. Computed by {@link attestationFingerprint} under a digest the
   * caller supplies.
   */
  fingerprint: string;
}

/**
 * The only way to build an attestation.
 *
 * Throws rather than returning a result union, and that is a judgement about
 * where this is called: by an export route and a scheduled digest, both of
 * which already have an error path, and in both cases a thrown error produces a
 * 500 or a failed job while a silently-degraded envelope produces a PDF in a
 * procurement folder. Of the two failures only one is recoverable.
 *
 * `itemKeys` is taken separately from the input and does NOT become a field: it
 * is hashed into the fingerprint and discarded, because a document carrying 412
 * route keys is not a document anybody reads and the fingerprint is what makes
 * the item set checkable.
 */
export function attest(
  input: AttestationInput,
  /** Every `CoverageItem.key` the denominator was taken over. Order-insensitive. */
  itemKeys: readonly string[],
  digest: ContentDigest,
): CoverageAttestation {
  if (input.scopeStatement.trim().length === 0) {
    throw new Error(
      'an attestation needs a scope statement — a buyer reads silence about scope as zero risk, ' +
        'so a document with an empty scope section is worse than no document',
    );
  }
  if (input.denominatorDefinition.trim().length === 0) {
    throw new Error(
      'an attestation needs the definition of what was divided by, or the percentage on it is a ' +
        'number with no units',
    );
  }
  if (input.crawlVersion.trim().length === 0) {
    throw new Error(
      'an attestation needs the crawl version that produced the inventory, or no later ' +
        'attestation can be compared against it',
    );
  }
  if (input.covered > input.denominator) {
    throw new Error(
      `an attestation cannot cover ${input.covered} of ${input.denominator} — a numerator above ` +
        'its denominator is the arithmetic a customer reproduces in a spreadsheet and never ' +
        'trusts us again after',
    );
  }
  if (input.denominator === 0 && input.percent !== null) {
    throw new Error(
      'an empty denominator has no percentage — null is not 0 and it is not 100',
    );
  }
  for (const entry of input.unmeasured) {
    if (entry.detail.trim().length === 0) {
      throw new Error(
        `the unmeasured entry for ${entry.dimension ?? entry.kind ?? 'an unnamed axis'} has no ` +
          'sentence — a reason code alone is a disclosure only we can read',
      );
    }
    if (entry.dimension === null && entry.kind === null) {
      throw new Error(
        'an unmeasured entry must name the axis it is about, on one of the two vocabularies',
      );
    }
  }
  for (const cap of input.caps) {
    if (cap.detail.trim().length === 0) {
      throw new Error(
        `the cap ${cap.cap} bit and carries no sentence — a cap applied without being disclosed ` +
          'is a truncated denominator presented as a whole application',
      );
    }
  }

  return {
    [ATTESTED]: true,
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    issuedAtIso: input.issuedAtIso,
    issuedByUserId: input.issuedByUserId,
    crawlVersion: input.crawlVersion,
    crawlFingerprint: input.crawlFingerprint,
    denominatorDefinition: input.denominatorDefinition,
    percent: input.percent,
    denominator: input.denominator,
    covered: input.covered,
    scopeStatement: input.scopeStatement.trim(),
    unmeasured: [...input.unmeasured],
    caps: [...input.caps],
    fingerprint: attestationFingerprint(input, itemKeys, digest),
  };
}

// ─── The fingerprint ────────────────────────────────────────────────────────

/** A separator no field of an attestation can contain. Same choice as requirements.ts. */
const CANONICAL_SEPARATOR = '\u001f';
/** The separator between items of one list, one level down. */
const LIST_SEPARATOR = '\u001e';

function canonicaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** `null` and the string "null" must not canonicalise the same way. */
function canonicaliseNullable(raw: string | null): string {
  return raw === null ? '\u0000' : canonicaliseText(raw);
}

function canonicaliseNumber(value: number | null): string {
  return value === null ? '\u0000' : String(value);
}

/**
 * THE CANONICAL TEXT THE FINGERPRINT IS TAKEN OVER, and the five decisions in
 * it.
 *
 * The fingerprint answers exactly one question: "are these two attestations
 * about the same claim?" So what goes in is what would make the claim
 * different, and what stays out is what would make two identical claims look
 * different.
 *
 *   1. THE DENOMINATOR DEFINITION IS IN. It is the units on the percentage. Two
 *      attestations with the same number and different definitions are two
 *      different claims, and a fingerprint that matched across them would let a
 *      scope change pass as an unchanged measurement.
 *   2. THE CRAWL VERSION IS IN, and the crawl fingerprint with it. A different
 *      enumerator measured a different application, which is the whole basis of
 *      `UNCOMPARABLE_CRAWL_CHANGED`.
 *   3. THE ITEM SET IS IN, SORTED. Sorted because the enumerator's output order
 *      is not stable across runs and an unsorted hash would report every re-run
 *      as a new claim. Hashed rather than carried, because 412 route keys is not
 *      a document anybody reads — but the customer can recompute it, which is
 *      what makes the denominator auditable rather than asserted.
 *   4. THE UNMEASURED LIST AND THE CAPS ARE IN. An attestation that starts
 *      disclosing a cap is a different claim from one that did not, even at the
 *      same percentage — arguably especially at the same percentage.
 *   5. `issuedAtIso`, `issuedByUserId` AND `snapshotId` ARE OUT. Two exports of
 *      the same measurement on different days by different people are the same
 *      claim, and putting the clock in the hash would make every export unique
 *      and the fingerprint useless for the only thing it is for.
 *
 * `percent` is also OUT, deliberately: it is DERIVED from `covered` and
 * `denominator`, both of which are in, so including it would only create a way
 * for the hash to disagree with itself if a writer ever rounded differently.
 */
export function attestationCanonicalText(
  input: AttestationInput,
  itemKeys: readonly string[],
): string {
  const unmeasured = [...input.unmeasured]
    .map((entry) =>
      [
        canonicaliseNullable(entry.dimension),
        canonicaliseNullable(entry.kind),
        entry.reason,
        canonicaliseNumber(entry.cells),
      ].join(':'),
    )
    // Sorted for the same reason the item keys are: the order a report happens
    // to assemble its disclosures in is not part of the claim.
    .sort()
    .join(LIST_SEPARATOR);

  const caps = [...input.caps]
    .map((cap) =>
      [canonicaliseText(cap.cap), String(cap.limit), canonicaliseNumber(cap.atLeastMore)].join(':'),
    )
    .sort()
    .join(LIST_SEPARATOR);

  return [
    canonicaliseText(input.projectId),
    canonicaliseText(input.crawlVersion),
    canonicaliseNullable(input.crawlFingerprint),
    canonicaliseText(input.denominatorDefinition),
    String(input.denominator),
    String(input.covered),
    canonicaliseText(input.scopeStatement),
    unmeasured,
    caps,
    [...itemKeys].sort().join(LIST_SEPARATOR),
  ].join(CANONICAL_SEPARATOR);
}

/**
 * The fingerprint of an attestation, under a caller-supplied digest.
 *
 * Injected rather than imported — see the note at the head of this file, and
 * rule 8: a module's cryptography is an adapter, and a module that reaches for
 * one directly cannot be tested without it.
 */
export function attestationFingerprint(
  input: AttestationInput,
  itemKeys: readonly string[],
  digest: ContentDigest,
): string {
  return digest(attestationCanonicalText(input, itemKeys));
}

// ─── Reading one back ───────────────────────────────────────────────────────

/**
 * The envelope without its brand, for serialisation.
 *
 * A function and not a cast, because `JSON.stringify` would drop the symbol
 * anyway and a reader who did not know that would reasonably assume the brand
 * survived a round trip. It does not, which is why {@link attest} is the only
 * way back IN: a stored attestation read from the database is data and must be
 * re-attested, not asserted.
 */
export type AttestationPayload = Omit<CoverageAttestation, typeof ATTESTED>;

export function attestationPayload(attestation: CoverageAttestation): AttestationPayload {
  const { [ATTESTED]: _brand, ...payload } = attestation;
  return payload;
}

/**
 * Whether two attestations are about the same claim.
 *
 * The fingerprint comparison, named, so that no caller writes `a.fingerprint
 * === b.fingerprint` beside one that writes `a.percent === b.percent` and
 * produces two answers to one question.
 */
export function sameClaim(a: CoverageAttestation, b: CoverageAttestation): boolean {
  return a.fingerprint === b.fingerprint;
}

/**
 * The scope section as the lines a document prints, worst first.
 *
 * Here rather than in the renderer because three renderers are coming — CSV,
 * JSON and a print-ready HTML — and a scope section worded differently in each
 * is three documents making three different disclosures about one measurement.
 * The ordering puts OUR limits first: a reader who stops after one line should
 * read the one that says we did not look.
 */
export function attestationScopeLines(attestation: CoverageAttestation): string[] {
  const lines: string[] = [attestation.scopeStatement];
  for (const entry of attestation.unmeasured) {
    const axis = entry.dimension ?? entry.kind ?? 'an unnamed axis';
    const count = entry.cells === null ? 'an unknown number of' : String(entry.cells);
    lines.push(
      `${axis}: NOT MEASURED — ${DIMENSION_UNMEASURED_REASON_LABELS[entry.reason]} ` +
        `(${count} cell(s)). ${entry.detail}`,
    );
  }
  for (const cap of attestation.caps) {
    const more =
      cap.atLeastMore === null
        ? 'an unknown number more existed'
        : `at least ${cap.atLeastMore} more existed`;
    lines.push(`${cap.cap} capped at ${cap.limit}: ${more}. ${cap.detail}`);
  }
  return lines;
}
