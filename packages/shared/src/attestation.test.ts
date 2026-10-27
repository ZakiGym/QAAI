import { describe, expect, it } from 'vitest';
import {
  attest,
  attestationCanonicalText,
  attestationFingerprint,
  attestationPayload,
  attestationScopeLines,
  sameClaim,
  type AttestationInput,
  type CoverageAttestation,
} from './attestation';
import { DIMENSION_UNMEASURED_REASON_LABELS } from './coverage-dimensions';
import type { ContentDigest } from './requirements';

/**
 * A deterministic stand-in for a real digest.
 *
 * NOT a hash, and that is the point of the injection: this module owns the
 * CANONICALISATION, which is the part that goes wrong, and takes the hashing as
 * an argument because `packages/shared/src/index.ts` is what the web bundler
 * consumes and a `node:crypto` import there breaks every page that reads a
 * value from @qaai/shared. Returning the canonical text verbatim also makes
 * every assertion below readable: a fingerprint difference is visible as a text
 * difference rather than as two unequal hex strings.
 */
const identityDigest: ContentDigest = (canonical) => canonical;

/**
 * A digest that behaves like a real one, for the equality assertions.
 *
 * FNV-1a rather than a length-and-prefix stub, and the first draft of this file
 * WAS the stub — which passed every "same claim" assertion and silently failed
 * the "changes when the crawl version changes" one, because `crawl-7` and
 * `crawl-8` have the same length and the same first eight characters. A fake
 * insensitive to the content it is handed hides exactly the defects it is
 * standing in for; this one is cheap, deterministic and sensitive to every byte.
 */
const countingDigest: ContentDigest = (canonical) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv:${hash.toString(16)}`;
};

const INPUT: AttestationInput = {
  projectId: 'p_1',
  snapshotId: 's_1',
  issuedAtIso: '2026-10-26T09:00:00.000Z',
  issuedByUserId: 'u_1',
  crawlVersion: 'crawl-7',
  crawlFingerprint: 'cf-1',
  denominatorDefinition: 'routes and endpoints, minus 4 waivers',
  percent: 61.2,
  denominator: 103,
  covered: 63,
  scopeStatement: 'This attestation covers routes and endpoints only.',
  unmeasured: [
    {
      dimension: 'COMPONENT_STATE',
      kind: null,
      reason: 'NO_EXTRACTOR',
      detail: 'QAAI does not enumerate component states in this build',
      cells: null,
    },
    {
      dimension: null,
      kind: 'BACKGROUND_JOB',
      reason: 'NOT_ENUMERATED',
      detail: 'no job catalogue was read for this project',
      cells: 12,
    },
  ],
  caps: [
    { cap: 'pageBudget', limit: 1_000, atLeastMore: 240, detail: 'at least 240 more URLs existed' },
  ],
};

const ITEMS = ['ROUTE:/orders', 'ROUTE:/checkout', 'ENDPOINT:POST /api/refunds'];

// ─── The refusals ───────────────────────────────────────────────────────────

/**
 * `attest` is the only door, and these are the shapes it will not let through.
 *
 * Every one of them is a document that could be handed to a buyer and read as a
 * guarantee it does not make. A reader given a percentage and no scope does not
 * conclude "scope unknown" — they conclude "87% of the application, and the
 * other 13% is ordinary untested code". Omission is the lie, so the constructor
 * throws rather than degrading: of a 500 and a PDF in a procurement folder,
 * only one is recoverable.
 */
describe('attest refuses a document that would mislead', () => {
  it('builds a well-formed attestation', () => {
    const attestation = attest(INPUT, ITEMS, identityDigest);
    expect(attestation.scopeStatement).toBe(INPUT.scopeStatement);
    expect(attestation.unmeasured).toHaveLength(2);
    expect(attestation.caps).toHaveLength(1);
    expect(attestation.fingerprint.length).toBeGreaterThan(0);
  });

  it('refuses an empty or whitespace-only scope statement', () => {
    expect(() => attest({ ...INPUT, scopeStatement: '' }, ITEMS, identityDigest)).toThrow(
      /scope statement/,
    );
    expect(() => attest({ ...INPUT, scopeStatement: '   \n ' }, ITEMS, identityDigest)).toThrow(
      /scope statement/,
    );
  });

  it('refuses a percentage with no definition of what was divided by', () => {
    // Without it the number on the document has no units, and a scope change
    // between two attestations is invisible.
    expect(() => attest({ ...INPUT, denominatorDefinition: ' ' }, ITEMS, identityDigest)).toThrow(
      /divided by/,
    );
  });

  it('refuses an attestation that does not say which crawl produced it', () => {
    expect(() => attest({ ...INPUT, crawlVersion: '' }, ITEMS, identityDigest)).toThrow(
      /crawl version/,
    );
  });

  it('refuses a numerator above its denominator', () => {
    expect(() => attest({ ...INPUT, covered: 104 }, ITEMS, identityDigest)).toThrow(/spreadsheet/);
  });

  it('refuses a percentage on an empty denominator', () => {
    // NULL IS NOT 0 AND NOT 100. An empty denominator means our extractor found
    // nothing, and either number would be a claim about the customer's
    // application made from our own silence.
    expect(() =>
      attest({ ...INPUT, denominator: 0, covered: 0, percent: 0 }, ITEMS, identityDigest),
    ).toThrow(/null is not 0/);
    expect(() =>
      attest({ ...INPUT, denominator: 0, covered: 0, percent: null }, ITEMS, identityDigest),
    ).not.toThrow();
  });

  it('refuses an unmeasured entry with a reason code and no sentence', () => {
    expect(() =>
      attest(
        {
          ...INPUT,
          unmeasured: [
            { dimension: 'PAGE_STATE', kind: null, reason: 'NO_EXTRACTOR', detail: '', cells: null },
          ],
        },
        ITEMS,
        identityDigest,
      ),
    ).toThrow(/only we can read/);
  });

  it('refuses an unmeasured entry that names no axis', () => {
    expect(() =>
      attest(
        {
          ...INPUT,
          unmeasured: [
            { dimension: null, kind: null, reason: 'NO_EXTRACTOR', detail: 'something', cells: null },
          ],
        },
        ITEMS,
        identityDigest,
      ),
    ).toThrow(/name the axis/);
  });

  it('refuses a cap that bit and carries no sentence', () => {
    // Rule 10: a cap applied without being disclosed is a truncated
    // denominator presented as a whole application.
    expect(() =>
      attest(
        { ...INPUT, caps: [{ cap: 'pageBudget', limit: 1_000, atLeastMore: 240, detail: '' }] },
        ITEMS,
        identityDigest,
      ),
    ).toThrow(/without being disclosed/);
  });

  it('accepts an empty unmeasured list only because the caller stated it', () => {
    /*
     * The list may be empty — truthfully. What the TYPE refuses is OMITTING it,
     * and that is a compile-time guarantee rather than a run-time one: the two
     * lines below would not compile without `unmeasured` and `caps`, which is
     * what makes the scope statement a requirement rather than a convention.
     */
    const attestation = attest({ ...INPUT, unmeasured: [], caps: [] }, ITEMS, identityDigest);
    expect(attestation.unmeasured).toEqual([]);
  });
});

/**
 * THE TYPE-LEVEL HALF, asserted by the compiler rather than by vitest.
 *
 * `@ts-expect-error` fails the TYPECHECK if the error it expects does not
 * occur, so these two lines are real assertions: the first proves an object
 * literal cannot be passed off as an attestation (the brand is module-private,
 * so `attest` is the only door), and the second proves `AttestationInput`
 * genuinely requires its scope.
 *
 * Without this, the next writer in a hurry assembles the envelope by hand with
 * no unmeasured list, it compiles, and the document ships claiming nothing was
 * unmeasured.
 */
describe('the brand makes attest the only door', () => {
  it('refuses a hand-assembled envelope at compile time', () => {
    const handMade = {
      projectId: 'p_1',
      snapshotId: null,
      issuedAtIso: INPUT.issuedAtIso,
      issuedByUserId: null,
      crawlVersion: 'crawl-7',
      crawlFingerprint: null,
      denominatorDefinition: 'everything',
      percent: 100,
      denominator: 1,
      covered: 1,
      scopeStatement: 'everything is measured',
      unmeasured: [],
      caps: [],
      fingerprint: 'forged',
    };
    // @ts-expect-error an object literal is not a CoverageAttestation — only attest() makes one
    const forged: CoverageAttestation = handMade;
    expect(forged.fingerprint).toBe('forged');
  });

  it('requires the scope list on the input', () => {
    const { unmeasured: _omitted, ...withoutScope } = INPUT;
    // @ts-expect-error AttestationInput requires `unmeasured`; silence about scope is refused
    const incomplete: AttestationInput = withoutScope;
    expect(incomplete.caps).toHaveLength(1);
  });
});

// ─── The fingerprint ────────────────────────────────────────────────────────

/**
 * The fingerprint answers exactly one question: are these two attestations
 * about the same CLAIM?
 *
 * So what goes in is what would make the claim different, and what stays out is
 * what would make two identical claims look different. Each test below is one
 * of those five decisions.
 */
describe('attestationFingerprint', () => {
  it('is pure — the same input twice gives the same answer', () => {
    expect(attestationFingerprint(INPUT, ITEMS, countingDigest)).toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('ignores the order the item set arrives in', () => {
    /*
     * The enumerator's output order is not stable across runs, so an unsorted
     * hash would report every re-run of an unchanged application as a new
     * claim — and a fingerprint that changes for no reason is one nobody
     * compares.
     */
    expect(attestationFingerprint(INPUT, [...ITEMS].reverse(), countingDigest)).toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('ignores the order the disclosures arrive in', () => {
    const swapped: AttestationInput = {
      ...INPUT,
      unmeasured: [...INPUT.unmeasured].reverse(),
    };
    expect(attestationFingerprint(swapped, ITEMS, countingDigest)).toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('ignores the clock, the issuer and the snapshot id', () => {
    /*
     * Two exports of the same measurement on different days by different people
     * are the SAME CLAIM. Putting the clock in the hash would make every export
     * unique and the fingerprint useless for the only thing it is for.
     */
    const reissued: AttestationInput = {
      ...INPUT,
      issuedAtIso: '2027-01-01T00:00:00.000Z',
      issuedByUserId: 'u_2',
      snapshotId: 's_2',
    };
    expect(attestationFingerprint(reissued, ITEMS, countingDigest)).toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
    expect(sameClaim(attest(reissued, ITEMS, countingDigest), attest(INPUT, ITEMS, countingDigest))).toBe(
      true,
    );
  });

  it('changes when the denominator definition changes, at the same percentage', () => {
    // The definition is the units on the percentage. A fingerprint that matched
    // across two definitions would let a scope change pass as an unchanged
    // measurement, which is the most valuable thing this fingerprint prevents.
    const rescoped: AttestationInput = {
      ...INPUT,
      denominatorDefinition: 'routes only, minus 4 waivers',
    };
    expect(attestationFingerprint(rescoped, ITEMS, countingDigest)).not.toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('changes when the crawl version changes', () => {
    expect(
      attestationFingerprint({ ...INPUT, crawlVersion: 'crawl-8' }, ITEMS, countingDigest),
    ).not.toBe(attestationFingerprint(INPUT, ITEMS, countingDigest));
  });

  it('changes when the item set changes', () => {
    expect(
      attestationFingerprint(INPUT, [...ITEMS, 'ROUTE:/admin'], countingDigest),
    ).not.toBe(attestationFingerprint(INPUT, ITEMS, countingDigest));
  });

  it('changes when a cap starts being disclosed, at the same percentage', () => {
    // An attestation that begins disclosing a cap is a different claim from one
    // that did not — arguably especially at the same percentage.
    expect(attestationFingerprint({ ...INPUT, caps: [] }, ITEMS, countingDigest)).not.toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('changes when the unmeasured list changes', () => {
    expect(
      attestationFingerprint({ ...INPUT, unmeasured: [] }, ITEMS, countingDigest),
    ).not.toBe(attestationFingerprint(INPUT, ITEMS, countingDigest));
  });

  it('changes when the scope statement changes', () => {
    expect(
      attestationFingerprint(
        { ...INPUT, scopeStatement: 'This covers everything.' },
        ITEMS,
        countingDigest,
      ),
    ).not.toBe(attestationFingerprint(INPUT, ITEMS, countingDigest));
  });

  it('does not change when only the derived percentage is restated', () => {
    // `percent` is DERIVED from covered and denominator, both of which are in
    // the hash, so including it would only create a way for the fingerprint to
    // disagree with itself if a writer ever rounded differently.
    expect(attestationFingerprint({ ...INPUT, percent: 61.3 }, ITEMS, countingDigest)).toBe(
      attestationFingerprint(INPUT, ITEMS, countingDigest),
    );
  });

  it('keeps a null apart from the string "null"', () => {
    /*
     * `crawlFingerprint: null` means no crawl was recorded, which is
     * UNCOMPARABLE_FINGERPRINT_MISSING; a crawl literally fingerprinted "null"
     * is a different claim. Canonicalising both to the same text would merge
     * them, and the merge is in the flattering direction.
     */
    const asNull = attestationCanonicalText({ ...INPUT, crawlFingerprint: null }, ITEMS);
    const asText = attestationCanonicalText({ ...INPUT, crawlFingerprint: 'null' }, ITEMS);
    expect(asNull).not.toBe(asText);
  });

  it('normalises line endings and trailing whitespace in the scope statement', () => {
    // A tracker's web editor and its REST API disagree about line endings on
    // the same unedited text, so a re-export would otherwise look like a new
    // claim. Same three rules as `requirementCanonicalText`.
    expect(
      attestationCanonicalText(
        { ...INPUT, scopeStatement: 'This attestation covers routes and endpoints only.  ' },
        ITEMS,
      ),
    ).toBe(attestationCanonicalText(INPUT, ITEMS));
  });
});

// ─── Reading one back ───────────────────────────────────────────────────────

describe('attestationPayload', () => {
  it('drops the brand and survives a JSON round trip', () => {
    /*
     * A function and not a cast, because `JSON.stringify` drops the symbol
     * anyway and a reader who did not know that would reasonably assume the
     * brand survived. It does not, which is why `attest` is the only way back
     * IN: a stored attestation read from the database is DATA and must be
     * re-attested, not asserted.
     */
    const attestation = attest(INPUT, ITEMS, countingDigest);
    const payload = attestationPayload(attestation);
    const round = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(round.fingerprint).toBe(attestation.fingerprint);
    expect(round.scopeStatement).toBe(attestation.scopeStatement);
    expect(Object.getOwnPropertySymbols(payload)).toEqual([]);
  });
});

describe('attestationScopeLines', () => {
  const lines = attestationScopeLines(attest(INPUT, ITEMS, countingDigest));

  it('leads with the scope statement', () => {
    // A reader who stops after one line should read the one that says what this
    // document does not claim.
    expect(lines[0]).toBe(INPUT.scopeStatement);
  });

  it('names every unmeasured axis with its reason', () => {
    expect(lines.join('\n')).toContain('COMPONENT_STATE');
    expect(lines.join('\n')).toContain('BACKGROUND_JOB');
    expect(lines.join('\n')).toContain(DIMENSION_UNMEASURED_REASON_LABELS.NO_EXTRACTOR);
    expect(lines.join('\n')).toContain(DIMENSION_UNMEASURED_REASON_LABELS.NOT_ENUMERATED);
  });

  it('says "an unknown number of" rather than 0 when the count is unknown', () => {
    // The whole file's rule in one sentence: a null that became 0 is one of the
    // lies this product cannot afford, and on an export it is the one a buyer
    // reads as "nothing here".
    expect(lines.join('\n')).toContain('an unknown number of cell(s)');
    expect(lines.join('\n')).toContain('12 cell(s)');
    expect(lines.join('\n')).not.toContain('0 cell(s)');
  });

  it('reports a cap as a count and as a reason', () => {
    expect(lines.join('\n')).toContain('pageBudget capped at 1000');
    expect(lines.join('\n')).toContain('at least 240 more existed');
  });

  it('says a cap could not tell how much it hid rather than claiming zero', () => {
    const vague = attest(
      {
        ...INPUT,
        caps: [
          { cap: 'wallClockMillis', limit: 600_000, atLeastMore: null, detail: 'stopped early' },
        ],
      },
      ITEMS,
      countingDigest,
    );
    expect(attestationScopeLines(vague).join('\n')).toContain('an unknown number more existed');
  });
});
