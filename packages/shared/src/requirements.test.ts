import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_CRITERION_FORMATS,
  ASSERTED_LINK_METHODS,
  AUTOMATION_BACKLOG_STATUSES,
  CONTENT_CHANGE_KINDS,
  LINK_METHOD_CONFIDENCE_CEILING,
  MANUAL_TEST_AUTOMATION_STATUSES,
  OBSOLETE_STATUSES,
  REQUIREMENT_LINK_METHODS,
  REQUIREMENT_LINK_STATES,
  REQUIREMENT_LINK_TARGET_KINDS,
  REQUIREMENT_STATUSES,
  SPEC_SOURCE_SYSTEMS,
  STRUCTURED_CRITERION_FORMATS,
  TEST_MANAGEMENT_SYSTEMS,
  TRACEABLE_LINK_CONFIDENCE,
  UNLINKED_STATES,
  type RequirementLinkMethod,
  type RequirementStatus,
  acceptanceCriterionSchema,
  classifyReimport,
  clampLinkConfidence,
  linkStateFrom,
  linkTargetOfRow,
  linkWasAsserted,
  manualBacklogTotals,
  manualTestCaseSchema,
  requirementCanonicalText,
  requirementContentHash,
  requirementCounts,
  requirementImportSchema,
  requirementLinkSchema,
  requirementLinkTargetSchema,
  requirementTestability,
} from './requirements';

/**
 * The spec-side vocabularies, pinned at the words they were introduced with.
 *
 * Every one of these is STORED — `Requirement.status`, `RequirementLink.method`,
 * `AcceptanceCriterion.format`, `ManualTestCase.automationStatus` — so a member
 * respelled in transit does not fail to compile. It fails to match a row
 * somebody already wrote, which is silent and permanent. That is why these are
 * literal lists rather than length assertions: the assertion has to be the
 * spelling.
 */
describe('the stored vocabularies', () => {
  it('SPEC_SOURCE_SYSTEMS is these eleven, in this order', () => {
    expect([...SPEC_SOURCE_SYSTEMS]).toEqual([
      'JIRA',
      'LINEAR',
      'AZURE_DEVOPS',
      'GITHUB_ISSUES',
      'XRAY',
      'ZEPHYR',
      'TESTRAIL',
      'QTEST',
      'MARKDOWN',
      'CSV',
      'MANUAL',
    ]);
  });

  it('REQUIREMENT_STATUSES is these seven, in this order', () => {
    expect([...REQUIREMENT_STATUSES]).toEqual([
      'DRAFT',
      'READY',
      'IN_PROGRESS',
      'DONE',
      'OBSOLETE',
      'UNMAPPED',
      'NOT_STATED',
    ]);
  });

  it('keeps UNMAPPED and NOT_STATED apart', () => {
    // The two members that make the normalisation honest. UNMAPPED means the
    // source said something we do not recognise (and `statusRaw` holds it);
    // NOT_STATED means it said nothing. One of them is a mapping table to
    // improve and the other is a field the source does not have, and merging
    // them would hide the first behind the second.
    expect(REQUIREMENT_STATUSES).toContain('UNMAPPED');
    expect(REQUIREMENT_STATUSES).toContain('NOT_STATED');
  });

  it('ACCEPTANCE_CRITERION_FORMATS survives check-enums.ts’s member regex', () => {
    /*
     * A regression test for a defect this file's own doc comment caused.
     * `tsConstMembers` in apps/api/scripts/check-enums.ts reads the array with
     * a character class that stops at the first closing square bracket, so one
     * such bracket anywhere in the literal — in a member or in a comment —
     * truncates the parse and the drift guard reports agreement on half the
     * list. It did exactly that when CHECKBOX's comment quoted Markdown's
     * task-list syntax: three of six members were compared and it passed.
     */
    expect([...ACCEPTANCE_CRITERION_FORMATS]).toEqual([
      'GIVEN_WHEN_THEN',
      'BULLET',
      'NUMBERED',
      'CHECKBOX',
      'TABLE_ROW',
      'UNSTRUCTURED',
    ]);
    const source = requirementsSource();
    const truncated = /export const ACCEPTANCE_CRITERION_FORMATS\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(truncated, 'the array literal is no longer readable at all').not.toBeNull();
    expect([...truncated![1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!)).toEqual([
      ...ACCEPTANCE_CRITERION_FORMATS,
    ]);
  });

  it('MANUAL_TEST_AUTOMATION_STATUSES is these six, in this order', () => {
    expect([...MANUAL_TEST_AUTOMATION_STATUSES]).toEqual([
      'NOT_AUTOMATED',
      'AUTOMATION_PLANNED',
      'AUTOMATED',
      'CANNOT_AUTOMATE',
      'OBSOLETE',
      'NOT_STATED',
    ]);
  });

  it('REQUIREMENT_LINK_METHODS is ranked strongest first', () => {
    expect([...REQUIREMENT_LINK_METHODS]).toEqual([
      'MANUAL',
      'ID_IN_ANNOTATION',
      'ID_IN_TEST_NAME',
      'SURFACE_MATCH',
    ]);
  });

  it('REQUIREMENT_LINK_STATES keeps our silence apart from the finding', () => {
    expect([...REQUIREMENT_LINK_STATES]).toEqual([
      'NOT_SEARCHED',
      'NOT_LINKED',
      'INFERRED',
      'ASSERTED',
    ]);
    // Only one of the four is a gap. NOT_SEARCHED is an admission about us.
    expect([...UNLINKED_STATES]).toEqual(['NOT_LINKED']);
  });

  it('TEST_MANAGEMENT_SYSTEMS is a subset of the source systems', () => {
    for (const system of TEST_MANAGEMENT_SYSTEMS) expect(SPEC_SOURCE_SYSTEMS).toContain(system);
  });

  it('STRUCTURED_CRITERION_FORMATS excludes the one that is an estimate', () => {
    for (const format of STRUCTURED_CRITERION_FORMATS) {
      expect(ACCEPTANCE_CRITERION_FORMATS).toContain(format);
    }
    expect(STRUCTURED_CRITERION_FORMATS).not.toContain('UNSTRUCTURED');
  });
});

/**
 * The module's own source, for the two assertions that are about its text.
 *
 * `node:fs` in a TEST file is fine and in `requirements.ts` is not: this file
 * is never bundled for the browser, and the barrel's standing rule is about
 * what the web app's bundler eats.
 */
function requirementsSource(): string {
  return readFileSync(fileURLToPath(new URL('./requirements.ts', import.meta.url)), 'utf8');
}

describe('requirementCounts', () => {
  it('holds only the withdrawn ones out of the denominator', () => {
    expect([...OBSOLETE_STATUSES]).toEqual(['OBSOLETE']);
    expect(requirementCounts('OBSOLETE')).toBe(false);
  });

  it('counts the two statuses our own parsing failed on', () => {
    /*
     * The direction that matters. Dropping UNMAPPED and NOT_STATED would make
     * OUR parsing errors raise the coverage percentage — the fewer statuses we
     * recognise, the smaller the denominator — which is the single most
     * flattering bug this feature could have.
     */
    expect(requirementCounts('UNMAPPED')).toBe(true);
    expect(requirementCounts('NOT_STATED')).toBe(true);
  });

  it('counts every status that is not withdrawn', () => {
    const counted = REQUIREMENT_STATUSES.filter(requirementCounts);
    expect(counted).toHaveLength(REQUIREMENT_STATUSES.length - 1);
  });
});

describe('requirementTestability', () => {
  it('expects a test to pass only once the behaviour is built', () => {
    expect(requirementTestability('DONE')).toBe('TESTABLE_NOW');
  });

  it('says NOT_YET_BUILT for the three states before DONE', () => {
    // A READY requirement's test SHOULD fail. A generator that treats that
    // failure as a defect files a bug against an unwritten feature; a gate that
    // treats it as coverage goes green on a test asserting something that does
    // not exist.
    expect(requirementTestability('DRAFT')).toBe('NOT_YET_BUILT');
    expect(requirementTestability('READY')).toBe('NOT_YET_BUILT');
    expect(requirementTestability('IN_PROGRESS')).toBe('NOT_YET_BUILT');
  });

  it('says UNKNOWN and never guesses, for the three that are not a position', () => {
    for (const status of ['OBSOLETE', 'UNMAPPED', 'NOT_STATED'] as RequirementStatus[]) {
      expect(requirementTestability(status)).toBe('UNKNOWN');
    }
  });

  it('answers for every status', () => {
    for (const status of REQUIREMENT_STATUSES) {
      expect(['TESTABLE_NOW', 'NOT_YET_BUILT', 'UNKNOWN']).toContain(
        requirementTestability(status),
      );
    }
  });
});

describe('clampLinkConfidence', () => {
  it('lets a human assert certainty', () => {
    expect(clampLinkConfidence('MANUAL', 1)).toEqual({ confidence: 1, clamped: false, rule: null });
  });

  it('caps a guess below the traceability threshold', () => {
    /*
     * THE invariant of the whole traceability feature: a link the machine
     * guessed cannot be the reason a requirement reads as covered. If
     * SURFACE_MATCH's ceiling ever rises above TRACEABLE_LINK_CONFIDENCE, a
     * regex noticing that a spec visits /checkout becomes an audit claim.
     */
    const clamped = clampLinkConfidence('SURFACE_MATCH', 0.99);
    expect(clamped.confidence).toBe(0.5);
    expect(clamped.clamped).toBe(true);
    expect(clamped.rule).toContain('capped at 0.5');
    expect(clamped.confidence).toBeLessThan(TRACEABLE_LINK_CONFIDENCE);
  });

  it('reports the cap rather than applying it silently', () => {
    // An undisclosed cap on a confidence score is an undisclosed change to the
    // coverage number. `rule` is what the importer stores in `evidence`.
    expect(clampLinkConfidence('ID_IN_TEST_NAME', 0.95).rule).toContain('claimed 0.95');
    expect(clampLinkConfidence('ID_IN_TEST_NAME', 0.5).rule).toBeNull();
  });

  it('stores a non-numeric confidence as 0 and says so', () => {
    // `Math.min(NaN, x)` is NaN; a NaN confidence fails every `>=` comparison
    // silently and reaches the database as a Float the UI renders as "NaN"
    // beside an audit claim.
    const bad = clampLinkConfidence('MANUAL', Number.NaN);
    expect(bad.confidence).toBe(0);
    expect(bad.clamped).toBe(true);
    expect(bad.rule).toContain('not a number');
    expect(clampLinkConfidence('MANUAL', -1).confidence).toBe(0);
  });

  it('has a ceiling for every method, and only MANUAL may reach 1', () => {
    for (const method of REQUIREMENT_LINK_METHODS) {
      const ceiling = LINK_METHOD_CONFIDENCE_CEILING[method];
      expect(ceiling).toBeGreaterThan(0);
      expect(ceiling).toBeLessThanOrEqual(1);
      expect(clampLinkConfidence(method, 1).confidence).toBe(ceiling);
      if (method !== 'MANUAL') expect(ceiling).toBeLessThan(1);
    }
  });

  it('only a human-asserted method clears the traceability threshold', () => {
    const clears = REQUIREMENT_LINK_METHODS.filter(
      (method) => LINK_METHOD_CONFIDENCE_CEILING[method] >= TRACEABLE_LINK_CONFIDENCE,
    );
    expect(clears).toEqual(['MANUAL', 'ID_IN_ANNOTATION', 'ID_IN_TEST_NAME']);
    expect([...ASSERTED_LINK_METHODS]).toEqual(['MANUAL']);
    expect(linkWasAsserted('MANUAL')).toBe(true);
    expect(linkWasAsserted('SURFACE_MATCH')).toBe(false);
  });
});

describe('linkStateFrom', () => {
  it('does not read an empty link list as a finding', () => {
    /*
     * The lie this function exists to refuse. Zero links means NOT_LINKED only
     * if something LOOKED; otherwise it is NOT_SEARCHED, and reporting our
     * silence as the customer's gap manufactures findings — which is the same
     * sin as hiding them and much harder to notice.
     */
    expect(linkStateFrom(false, [])).toBe('NOT_SEARCHED');
    expect(linkStateFrom(true, [])).toBe('NOT_LINKED');
  });

  it('is INFERRED when every link was a machine’s guess', () => {
    expect(linkStateFrom(true, ['SURFACE_MATCH'])).toBe('INFERRED');
    expect(linkStateFrom(true, ['ID_IN_TEST_NAME', 'SURFACE_MATCH'])).toBe('INFERRED');
  });

  it('is ASSERTED as soon as one link is a human’s', () => {
    expect(linkStateFrom(true, ['SURFACE_MATCH', 'MANUAL'])).toBe('ASSERTED');
  });

  it('ignores `searched` once links exist', () => {
    // A link cannot exist without something having looked, so the pair
    // (searched: false, links: [...]) is unreachable rather than meaningful —
    // and resolving it to NOT_SEARCHED would hide a real link.
    expect(linkStateFrom(false, ['MANUAL'])).toBe('ASSERTED');
  });

  it('returns a member of the stored vocabulary for every input', () => {
    for (const method of REQUIREMENT_LINK_METHODS) {
      expect(REQUIREMENT_LINK_STATES).toContain(linkStateFrom(true, [method]));
    }
  });
});

describe('linkTargetOfRow', () => {
  it('reads a test link and a surface link', () => {
    expect(linkTargetOfRow({ testId: 't1', coverageItemId: null })).toEqual({
      target: 'TEST',
      testId: 't1',
    });
    expect(linkTargetOfRow({ testId: null, coverageItemId: 'c1' })).toEqual({
      target: 'SURFACE',
      coverageItemId: 'c1',
    });
  });

  it('returns null for a row with both targets or neither', () => {
    /*
     * Not an error to swallow. A link with no target claims a requirement is
     * covered by nothing; a link with two has a meaning that depends on which
     * column the reader checks first. Picking whichever happened to be non-null
     * is how a malformed row silently becomes a test link in an audit artifact.
     */
    expect(linkTargetOfRow({ testId: null, coverageItemId: null })).toBeNull();
    expect(linkTargetOfRow({ testId: 't1', coverageItemId: 'c1' })).toBeNull();
  });

  it('treats an empty string as absent', () => {
    // Postgres will happily store ''. A zero-length id is not an id, and
    // `row.testId !== null` alone would read it as one.
    expect(linkTargetOfRow({ testId: '', coverageItemId: 'c1' })).toEqual({
      target: 'SURFACE',
      coverageItemId: 'c1',
    });
    expect(linkTargetOfRow({ testId: '', coverageItemId: '' })).toBeNull();
  });
});

/**
 * The write path, and both halves of the guard eight unsaveable GateRule kinds
 * earned this codebase.
 *
 * The compiler enforces `REQUIREMENT_LINK_TARGET_KINDS` against the union; this
 * enforces zod's own options against that list at run time. Two mechanisms,
 * because each catches what the other cannot — a union member with no write
 * path is live code in a reached file, which `check:wiring` cannot see.
 */
function zodTargetKinds(): string[] {
  return requirementLinkTargetSchema.options.map((option) => option.shape.target.value as string);
}

describe('requirementLinkTargetSchema ⇄ RequirementLinkTarget parity', () => {
  it('has one arm for every target the union names, and no others', () => {
    expect(zodTargetKinds().slice().sort()).toEqual([...REQUIREMENT_LINK_TARGET_KINDS].sort());
  });

  it('accepts each arm and refuses a third target', () => {
    expect(requirementLinkTargetSchema.safeParse({ target: 'TEST', testId: 't1' }).success).toBe(
      true,
    );
    expect(
      requirementLinkTargetSchema.safeParse({ target: 'SURFACE', coverageItemId: 'c1' }).success,
    ).toBe(true);
    expect(
      requirementLinkTargetSchema.safeParse({ target: 'REQUIREMENT', requirementId: 'r1' }).success,
    ).toBe(false);
  });

  it('refuses a target with no id, so the XOR cannot be written round', () => {
    expect(requirementLinkTargetSchema.safeParse({ target: 'TEST' }).success).toBe(false);
    expect(requirementLinkTargetSchema.safeParse({ target: 'TEST', testId: '' }).success).toBe(
      false,
    );
  });
});

describe('requirementImportSchema', () => {
  const valid = {
    externalId: 'PROJ-412',
    sourceSystem: 'JIRA',
    title: 'Refunds must be reversible',
    status: 'DONE',
  };

  it('accepts a requirement with no body and no criteria', () => {
    const parsed = requirementImportSchema.parse(valid);
    expect(parsed.body).toBe('');
    expect(parsed.criteria).toEqual([]);
    expect(parsed.statusRaw).toBeNull();
  });

  it('refuses UNMAPPED with nothing to show', () => {
    // "We could not map it" with no raw value is indistinguishable from a bug
    // in our mapping table, and a reader's only response to that is to stop
    // believing the number. Same argument as `CoverageItem.refusedByRule`.
    expect(requirementImportSchema.safeParse({ ...valid, status: 'UNMAPPED' }).success).toBe(false);
    expect(
      requirementImportSchema.safeParse({ ...valid, status: 'UNMAPPED', statusRaw: 'Awaiting UAT' })
        .success,
    ).toBe(true);
  });

  it('refuses a status outside the vocabulary', () => {
    expect(requirementImportSchema.safeParse({ ...valid, status: 'TRIAGED' }).success).toBe(false);
  });
});

describe('acceptanceCriterionSchema and requirementLinkSchema', () => {
  it('defaults a criterion’s external id to null rather than synthesising one', () => {
    // A synthesised id changes when a bullet is inserted above it, which would
    // retire every link to every criterion below the insertion.
    const parsed = acceptanceCriterionSchema.parse({
      ordinal: 0,
      text: 'Given a settled charge, When a refund is issued, Then the balance falls',
      format: 'GIVEN_WHEN_THEN',
    });
    expect(parsed.externalId).toBeNull();
  });

  it('defaults a link’s criterion to the requirement as a whole', () => {
    // A ticket id in a test name proves something about the requirement and
    // nothing about which criterion; promoting it to criterion granularity
    // would answer the enterprise question with a link nobody made.
    const parsed = requirementLinkSchema.parse({
      method: 'ID_IN_TEST_NAME',
      confidence: 0.8,
      target: { target: 'TEST', testId: 't1' },
      evidence: 'the spec title contains PROJ-412',
    });
    expect(parsed.criterionOrdinal).toBeNull();
  });

  it('refuses a confidence outside 0–1', () => {
    const base = {
      method: 'MANUAL' as RequirementLinkMethod,
      target: { target: 'TEST' as const, testId: 't1' },
      evidence: 'asserted in review',
    };
    expect(requirementLinkSchema.safeParse({ ...base, confidence: 1.4 }).success).toBe(false);
    expect(requirementLinkSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
  });

  it('requires evidence on every link', () => {
    // An unexplained claim in an audit artifact is worse than no claim.
    expect(
      requirementLinkSchema.safeParse({
        method: 'MANUAL',
        confidence: 1,
        target: { target: 'TEST', testId: 't1' },
        evidence: '   ',
      }).success,
    ).toBe(false);
  });
});

describe('manualTestCaseSchema', () => {
  it('defaults lastExecutedAt to null, which is not "never run"', () => {
    const parsed = manualTestCaseSchema.parse({
      externalId: 'C-18',
      sourceSystem: 'TESTRAIL',
      title: 'Refund a settled charge',
      automationStatus: 'NOT_STATED',
    });
    expect(parsed.lastExecutedAt).toBeNull();
    expect(parsed.steps).toEqual([]);
    expect(parsed.expectedResult).toBeNull();
  });

  it('keeps steps as rows, with per-step expectations optional', () => {
    const parsed = manualTestCaseSchema.parse({
      externalId: 'C-18',
      sourceSystem: 'TESTRAIL',
      title: 'Refund a settled charge',
      automationStatus: 'NOT_AUTOMATED',
      steps: [
        { ordinal: 0, action: 'Open the charge', expected: 'The charge detail is shown' },
        { ordinal: 1, action: 'Click Refund' },
      ],
    });
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1]?.expected).toBeNull();
  });
});

describe('manualBacklogTotals', () => {
  it('keeps NOT_STATED out of the backlog', () => {
    /*
     * The number this function exists to protect. TestRail's automation field
     * is optional and most installs leave it empty; folding empty into
     * NOT_AUTOMATED would let us quote a backlog at a customer whose suite
     * never claimed anything about most of it.
     */
    const totals = manualBacklogTotals([
      'NOT_AUTOMATED',
      'NOT_AUTOMATED',
      'AUTOMATION_PLANNED',
      'AUTOMATED',
      'NOT_STATED',
      'NOT_STATED',
      'NOT_STATED',
      'CANNOT_AUTOMATE',
      'OBSOLETE',
    ]);
    expect(totals.total).toBe(9);
    expect(totals.backlog).toBe(3);
    expect(totals.automated).toBe(1);
    expect(totals.notStated).toBe(3);
    expect(totals.cannotAutomate).toBe(1);
    expect(totals.obsolete).toBe(1);
    // 1 automated of the 4 cases that state a position.
    expect(totals.automatedPercent).toBe(25);
    expect(totals.rule).toContain('3 case(s) say nothing');
  });

  it('every case lands in exactly one bucket', () => {
    const totals = manualBacklogTotals([...MANUAL_TEST_AUTOMATION_STATUSES]);
    const buckets =
      totals.backlog +
      totals.automated +
      totals.cannotAutomate +
      totals.obsolete +
      totals.notStated;
    expect(buckets).toBe(totals.total);
    expect([...AUTOMATION_BACKLOG_STATUSES]).toEqual(['NOT_AUTOMATED', 'AUTOMATION_PLANNED']);
  });

  it('is null and not 0 when nothing states a position', () => {
    // A suite of nothing but NOT_STATED cases has no automation ratio. Printing
    // 0% would be a claim about the customer's suite made from its silence; the
    // same argument `coveragePercent` makes for an empty denominator.
    const totals = manualBacklogTotals(['NOT_STATED', 'OBSOLETE', 'CANNOT_AUTOMATE']);
    expect(totals.automatedPercent).toBeNull();
    expect(manualBacklogTotals([]).automatedPercent).toBeNull();
  });
});

describe('classifyReimport', () => {
  it('tells NEW from CHANGED from UNCHANGED', () => {
    expect(classifyReimport(undefined, 'h1').kind).toBe('NEW');
    expect(classifyReimport('h1', 'h1').kind).toBe('UNCHANGED');
    expect(classifyReimport('h1', 'h2').kind).toBe('CHANGED');
  });

  it('refuses to call an unhashed row either', () => {
    /*
     * The fourth member, and it makes the other three safe. A stored row with
     * no hash cannot be diffed: UNCHANGED drops the customer's edit silently,
     * CHANGED re-opens every link on every import until people stop reading the
     * matrix. Neither is true.
     */
    expect(classifyReimport(null, 'h1').kind).toBe('NOT_COMPARABLE');
    expect(classifyReimport('', 'h1').kind).toBe('NOT_COMPARABLE');
    expect(classifyReimport(null, 'h1').detail).toContain('no content hash');
  });

  it('always writes a detail, and a kind from the vocabulary', () => {
    for (const previous of [undefined, null, '', 'h1', 'h2']) {
      const change = classifyReimport(previous, 'h1');
      expect(CONTENT_CHANGE_KINDS).toContain(change.kind);
      expect(change.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('requirementCanonicalText', () => {
  const base = {
    externalId: 'PROJ-412',
    title: 'Refunds must be reversible',
    body: 'A refund may be reversed within 24 hours.',
    criteria: ['Given a refund, When reversed, Then the balance returns'],
  };

  it('is insensitive to line endings', () => {
    // A tracker's web editor and its REST API disagree about line endings on
    // the same unedited ticket, which would be reported as an edit on every
    // import.
    expect(
      requirementCanonicalText({ ...base, body: 'one\r\ntwo\rthree' }),
    ).toBe(requirementCanonicalText({ ...base, body: 'one\ntwo\nthree' }));
  });

  it('is insensitive to trailing whitespace and surrounding blank lines', () => {
    expect(requirementCanonicalText({ ...base, title: '  Refunds must be reversible  ' })).toBe(
      requirementCanonicalText(base),
    );
    expect(requirementCanonicalText({ ...base, body: 'one   \ntwo\t\n' })).toBe(
      requirementCanonicalText({ ...base, body: 'one\ntwo' }),
    );
  });

  it('is SENSITIVE to interior indentation', () => {
    // Collapsing interior whitespace would make a re-indentation invisible, and
    // in a Gherkin criterion indentation is structure.
    expect(
      requirementCanonicalText({ ...base, criteria: ['Given a refund\n    And a balance'] }),
    ).not.toBe(requirementCanonicalText({ ...base, criteria: ['Given a refund\nAnd a balance'] }));
  });

  it('cannot have two criteria rearranged into one', () => {
    // The separator is a character no tracker emits, so `['a','b']` and
    // `['a\u001fb']` — and `['ab']` — are three different canonical texts.
    expect(requirementCanonicalText({ ...base, criteria: ['a', 'b'] })).not.toBe(
      requirementCanonicalText({ ...base, criteria: ['ab'] }),
    );
    expect(requirementCanonicalText({ ...base, criteria: ['a', 'b'] })).not.toBe(
      requirementCanonicalText({ ...base, criteria: ['b', 'a'] }),
    );
  });

  it('changes when the body changes', () => {
    expect(requirementCanonicalText({ ...base, body: 'something else' })).not.toBe(
      requirementCanonicalText(base),
    );
  });

  it('takes its digest as an argument rather than importing one', () => {
    /*
     * The shape rule, asserted rather than assumed: `requirements.ts` is in the
     * @qaai/shared barrel, which the web app's bundler consumes, and a
     * `node:crypto` import there breaks every page that reads a value from the
     * package — which is why plugin-manifest.ts is reachable only by subpath.
     * A fake digest proves the module does no hashing of its own.
     */
    const calls: string[] = [];
    const fake = (canonical: string): string => {
      calls.push(canonical);
      return `digest:${canonical.length}`;
    };
    expect(requirementContentHash(base, fake)).toBe(
      `digest:${requirementCanonicalText(base).length}`,
    );
    expect(calls).toEqual([requirementCanonicalText(base)]);
    /*
     * An IMPORT of a `node:` builtin, not a mention of one. The module's own
     * doc comment explains why `node:crypto` is absent, so a substring search
     * for the name matches the explanation and fails on the file that is
     * correct — which this assertion did, the first time it was written.
     */
    expect(requirementsSource()).not.toMatch(/(?:from|import)\s*\(?\s*['"]node:/);
  });
});
