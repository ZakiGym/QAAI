import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_DISPOSITIONS,
  ARTIFACT_OWNERSHIPS,
  ARTIFACT_ROLES,
  ARTIFACT_ROLE_RANK,
  APPLYABLE_STATES,
  CHANGE_ALTERS_BEHAVIOUR,
  CORRECTION_CLASSIFIER_VERSION,
  CORRECTION_IS_ACTIONABLE,
  CORRECTION_KINDS,
  MAX_ARTIFACTS_PER_SET,
  MAX_CORRECTION_ITEMS,
  MAX_CORRECTION_QUOTE_CHARS,
  OWNERSHIP_VERDICTS,
  PROBLEM_BLOCKS_SET,
  SHARED_ROLES,
  SUITE_CHANGE_KINDS,
  SUITE_CHANGE_STATES,
  WRITABLE_BY_DISPOSITION,
  WRITABLE_BY_OWNERSHIP,
  artifactSetProblems,
  classifyCorrection,
  corpusScope,
  corpusWhere,
  dependentsAffected,
  dependentsOf,
  dispositionFor,
  isRecordableCorrection,
  mayWriteDirectly,
  orderedForApply,
  proposalProblems,
  sharedSurfaceChange,
  singleFileArtifactSet,
  specArtifactOf,
  summariseCorrections,
} from './artifact-set';
import type {
  ArtifactLedgerEntry,
  ArtifactSet,
  CorrectionProbes,
  GeneratedArtifact,
  SuiteChangeProposal,
} from './artifact-set';
import {
  artifactDispositionSchema,
  artifactOwnershipSchema,
  artifactRoleSchema,
  artifactSetSchema,
  artifactSetOf,
  correctionKindSchema,
  generatedTestSchema,
  ownershipVerdictSchema,
  suiteChangeKindSchema,
  suiteChangeProposalSchema,
  suiteChangeStateSchema,
  testCorrectionSchema,
} from './schemas';

/**
 * ── The two halves, and why both ───────────────────────────────────────────
 *
 * Every `satisfies Record<K, V>` presence record in artifact-set.ts is the
 * COMPILE-TIME half of its union's parity: a member added to the list without a
 * decision in the record fails to compile. The tests in the first describe
 * below are the RUN-TIME half: zod's `.options` exist only at run time, so a
 * member added to a list and forgotten in the schema compiles fine and is
 * simply unsaveable. Eight GateRule kinds shipped unsaveable for two slices
 * because only one of the two halves existed, and `check:wiring` cannot see
 * that class of defect — the schema and the union are both reached, both tested
 * and both wrong.
 */

function artifact(over: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    role: 'SPEC',
    path: 'tests/checkout.spec.ts',
    content: "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
    disposition: 'NEW',
    ownership: 'UNRECORDED',
    imports: [],
    basedOnHash: null,
    why: 'the generated test',
    ...over,
  };
}

function set(artifacts: GeneratedArtifact[]): ArtifactSet {
  return { dialect: 'JS_EXPECT', artifacts };
}

function ledgerEntry(over: Partial<ArtifactLedgerEntry> = {}): ArtifactLedgerEntry {
  return {
    path: 'tests/pages/login.ts',
    role: 'PAGE_OBJECT',
    ownership: 'QAAI_OWNED',
    contentHash: 'h-login-1',
    imports: [],
    ...over,
  };
}

const kinds = (problems: readonly { kind: string }[]): string[] => problems.map((p) => p.kind);

describe('vocabulary parity: the run-time half', () => {
  it.each([
    ['artifactRoleSchema', artifactRoleSchema.options, ARTIFACT_ROLES],
    ['artifactDispositionSchema', artifactDispositionSchema.options, ARTIFACT_DISPOSITIONS],
    ['artifactOwnershipSchema', artifactOwnershipSchema.options, ARTIFACT_OWNERSHIPS],
    ['ownershipVerdictSchema', ownershipVerdictSchema.options, OWNERSHIP_VERDICTS],
    ['correctionKindSchema', correctionKindSchema.options, CORRECTION_KINDS],
    ['suiteChangeKindSchema', suiteChangeKindSchema.options, SUITE_CHANGE_KINDS],
    ['suiteChangeStateSchema', suiteChangeStateSchema.options, SUITE_CHANGE_STATES],
  ])('%s carries exactly its vocabulary', (_name, options, list) => {
    expect([...options].sort()).toEqual([...list].sort());
  });

  it('every presence record is keyed on exactly its union', () => {
    // The compiler already proves no key is MISSING. This proves none is EXTRA,
    // which a `satisfies Record<K, V>` also catches — but only while the key is
    // spelled wrong, not while a member has been REMOVED from the list and left
    // in the record, which widens nothing and silently keeps a dead decision.
    expect(Object.keys(ARTIFACT_ROLE_RANK).sort()).toEqual([...ARTIFACT_ROLES].sort());
    expect(Object.keys(SHARED_ROLES).sort()).toEqual([...ARTIFACT_ROLES].sort());
    expect(Object.keys(WRITABLE_BY_OWNERSHIP).sort()).toEqual([...OWNERSHIP_VERDICTS].sort());
    expect(Object.keys(WRITABLE_BY_DISPOSITION).sort()).toEqual([...ARTIFACT_DISPOSITIONS].sort());
    expect(Object.keys(CORRECTION_IS_ACTIONABLE).sort()).toEqual([...CORRECTION_KINDS].sort());
    expect(Object.keys(CHANGE_ALTERS_BEHAVIOUR).sort()).toEqual([...SUITE_CHANGE_KINDS].sort());
    expect(Object.keys(APPLYABLE_STATES).sort()).toEqual([...SUITE_CHANGE_STATES].sort());
  });

  it('OWNERSHIP_VERDICTS is the recordable states plus exactly one that is not', () => {
    expect(OWNERSHIP_VERDICTS).toEqual([...ARTIFACT_OWNERSHIPS, 'UNRECORDED']);
    // A row cannot say there is no row. If UNRECORDED ever reaches the Prisma
    // enum, a missing record becomes a recorded permission.
    expect(ARTIFACT_OWNERSHIPS).not.toContain('UNRECORDED');
  });

  it('exactly one ownership verdict is writable, and it is the one that proves the bytes', () => {
    const writable = OWNERSHIP_VERDICTS.filter((v) => WRITABLE_BY_OWNERSHIP[v]);
    expect(writable).toEqual(['QAAI_OWNED']);
  });

  it('exactly one proposal state is applyable, and it is not the producer\u2019s own', () => {
    const applyable = SUITE_CHANGE_STATES.filter((s) => APPLYABLE_STATES[s]);
    expect(applyable).toEqual(['APPROVED']);
    expect(APPLYABLE_STATES.PROPOSED).toBe(false);
  });

  it('has no DELETE member, which is suite-health rule ONE as a type', () => {
    // suite-health.ts: nothing deletes a test and nothing may say deleting one
    // is safe. A DELETE_TEST kind here would be that rule repealed in a list.
    expect(SUITE_CHANGE_KINDS.filter((k) => /DELETE|REMOVE_TEST|DROP/.test(k))).toEqual([]);
  });

  it('counts a correction the classifier could not read rather than dropping it', () => {
    expect(CORRECTION_KINDS).toContain('UNCLASSIFIED');
    expect(CORRECTION_IS_ACTIONABLE.UNCLASSIFIED).toBe(false);
    // A reviewer weakening our assertion is not a lesson to assert less.
    expect(CORRECTION_IS_ACTIONABLE.ASSERTION_WEAKENED).toBe(false);
  });
});

describe('ownership is a recorded fact', () => {
  it('answers UNRECORDED for a path nothing recorded, and UNRECORDED is not writable', () => {
    expect(dispositionFor({ verdict: 'UNRECORDED', ledgerHash: null, onDiskHash: 'x' })).toBe(
      'PROPOSED_EDIT',
    );
    expect(WRITABLE_BY_OWNERSHIP.UNRECORDED).toBe(false);
  });

  it('downgrades to PROPOSED_EDIT when a human has changed a file QAAI wrote', () => {
    // THE DEFECT THIS WHOLE FILE EXISTS FOR. `pushRepo` would overwrite here.
    expect(
      dispositionFor({ verdict: 'QAAI_OWNED', ledgerHash: 'ours', onDiskHash: 'theirs' }),
    ).toBe('PROPOSED_EDIT');
    expect(dispositionFor({ verdict: 'HUMAN_EDITED', ledgerHash: 'ours', onDiskHash: 'ours' })).toBe(
      'PROPOSED_EDIT',
    );
  });

  it('is NEW when the ledger owns a path and nothing is on disk', () => {
    // Somebody deleted the file. UPDATE_OWNED would carry a basedOnHash for
    // bytes that do not exist.
    expect(dispositionFor({ verdict: 'QAAI_OWNED', ledgerHash: 'ours', onDiskHash: null })).toBe(
      'NEW',
    );
  });

  it('is UPDATE_OWNED only when the bytes on disk are the bytes we wrote', () => {
    expect(dispositionFor({ verdict: 'QAAI_OWNED', ledgerHash: 'ours', onDiskHash: 'ours' })).toBe(
      'UPDATE_OWNED',
    );
  });

  it('needs BOTH halves of the permission to write', () => {
    expect(mayWriteDirectly(artifact({ disposition: 'NEW', ownership: 'QAAI_OWNED' }))).toBe(true);
    // A stale disposition against a recorded human edit must not be a permission.
    expect(mayWriteDirectly(artifact({ disposition: 'NEW', ownership: 'HUMAN_EDITED' }))).toBe(
      false,
    );
    expect(
      mayWriteDirectly(artifact({ disposition: 'PROPOSED_EDIT', ownership: 'QAAI_OWNED' })),
    ).toBe(false);
  });

  it('reads the dependency edge off the dependents, not off the shared file', () => {
    const ledger = [
      ledgerEntry(),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
      ledgerEntry({ path: 'tests/b.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
      ledgerEntry({ path: 'tests/c.spec.ts', role: 'SPEC', imports: ['tests/pages/cart.ts'] }),
    ];
    expect(dependentsOf(ledger, 'tests/pages/login.ts').map((e) => e.path)).toEqual([
      'tests/a.spec.ts',
      'tests/b.spec.ts',
    ]);
    // A file never counts as its own dependent, even if it self-imports.
    expect(dependentsOf([ledgerEntry({ imports: ['tests/pages/login.ts'] })], 'tests/pages/login.ts')).toEqual(
      [],
    );
  });
});

describe('artifactSetProblems', () => {
  it('refuses a write to a file QAAI does not own', () => {
    const problems = artifactSetProblems(
      set([artifact({ disposition: 'UPDATE_OWNED', ownership: 'HUMAN_AUTHORED', basedOnHash: 'h' })]),
      { ledger: [ledgerEntry({ path: 'tests/checkout.spec.ts', ownership: 'HUMAN_AUTHORED' })] },
    );
    expect(kinds(problems)).toContain('WRITE_TO_UNOWNED');
  });

  it('refuses a set whose ledger has moved since it was computed', () => {
    const problems = artifactSetProblems(
      set([artifact({ disposition: 'UPDATE_OWNED', ownership: 'QAAI_OWNED', basedOnHash: 'old' })]),
      {
        ledger: [
          ledgerEntry({ path: 'tests/checkout.spec.ts', role: 'SPEC', contentHash: 'new' }),
        ],
      },
    );
    expect(kinds(problems)).toContain('STALE_BASE');
  });

  it('refuses two artifacts at one path', () => {
    const problems = artifactSetProblems(
      set([artifact({ ownership: 'QAAI_OWNED' }), artifact({ ownership: 'QAAI_OWNED' })]),
    );
    expect(kinds(problems)).toContain('DUPLICATE_PATH');
  });

  it.each([
    ['..', 'tests/../../etc/passwd'],
    ['absolute', '/etc/passwd'],
    ['backslash', 'tests\\win.spec.ts'],
    ['drive', 'C:/tests/x.spec.ts'],
  ])('refuses a %s path', (_what, path) => {
    const problems = artifactSetProblems(set([artifact({ path, ownership: 'QAAI_OWNED' })]));
    expect(kinds(problems)).toContain('PATH_ESCAPE');
  });

  it('refuses a change computed against unknown bytes, and a creation that claims to know them', () => {
    expect(
      kinds(
        artifactSetProblems(
          set([artifact({ disposition: 'UPDATE_OWNED', ownership: 'QAAI_OWNED', basedOnHash: null })]),
        ),
      ),
    ).toContain('MISSING_BASE_HASH');
    expect(
      kinds(
        artifactSetProblems(
          set([artifact({ disposition: 'NEW', ownership: 'QAAI_OWNED', basedOnHash: 'h' })]),
        ),
      ),
    ).toContain('BASE_HASH_ON_NEW');
  });

  it('refuses an import that resolves neither in the set nor in the ledger', () => {
    const problems = artifactSetProblems(
      set([artifact({ ownership: 'QAAI_OWNED', imports: ['tests/pages/nowhere.ts'] })]),
    );
    expect(kinds(problems)).toContain('UNRESOLVED_IMPORT');
  });

  it('accepts an import satisfied inside the same set', () => {
    const problems = artifactSetProblems(
      set([
        artifact({ role: 'PAGE_OBJECT', path: 'tests/pages/login.ts', ownership: 'QAAI_OWNED' }),
        artifact({ ownership: 'QAAI_OWNED', imports: ['tests/pages/login.ts'] }),
      ]),
    );
    expect(kinds(problems)).not.toContain('UNRESOLVED_IMPORT');
  });

  it('refuses a dependency listed after the file that imports it', () => {
    const problems = artifactSetProblems(
      set([
        artifact({ ownership: 'QAAI_OWNED', imports: ['tests/pages/login.ts'] }),
        artifact({ role: 'PAGE_OBJECT', path: 'tests/pages/login.ts', ownership: 'QAAI_OWNED' }),
      ]),
    );
    expect(kinds(problems)).toContain('APPLY_ORDER');
  });

  it('refuses a shared replacement that would remove a name a dependent imports', () => {
    const ledger = [
      ledgerEntry({ contentHash: 'h1' }),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
    ];
    const problems = artifactSetProblems(
      set([
        artifact({
          role: 'PAGE_OBJECT',
          path: 'tests/pages/login.ts',
          ownership: 'QAAI_OWNED',
          disposition: 'UPDATE_OWNED',
          basedOnHash: 'h1',
          content: 'export class LoginPage {}\n',
        }),
      ]),
      { ledger, priorContent: () => 'export class LoginPage {}\nexport const SELECTORS = {};\n' },
    );
    const problem = problems.find((p) => p.kind === 'SHARED_EXPORT_REMOVED');
    expect(problem?.why).toContain('SELECTORS');
    expect(problem?.why).toContain('tests/a.spec.ts');
  });

  it('refuses a shared replacement whose prior bytes could not be read at all', () => {
    // UNREADABLE is not "nothing was removed". With no `priorContent` the
    // decision cannot be made, and the fail-closed answer is a refusal.
    const ledger = [
      ledgerEntry({ contentHash: 'h1' }),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
    ];
    const problems = artifactSetProblems(
      set([
        artifact({
          role: 'PAGE_OBJECT',
          path: 'tests/pages/login.ts',
          ownership: 'QAAI_OWNED',
          disposition: 'UPDATE_OWNED',
          basedOnHash: 'h1',
          content: 'export class LoginPage {}\n',
        }),
      ]),
      { ledger },
    );
    expect(kinds(problems)).toContain('SHARED_SURFACE_UNREADABLE');
  });

  it('refuses a shared replacement whose prior bytes are present and unreadable', () => {
    /*
     * The OTHER unreadable case, and the one a mutation survived: the bytes WERE
     * supplied and no export form could be read from them. UNREADABLE is not
     * "nothing was removed" — nothing can be said about what a dependent would
     * lose, so the set may not be applied blindly. The test above covers the
     * bytes being absent; this one covers them being unparseable, which is the
     * branch `sharedSurfaceChange` returns UNREADABLE from.
     */
    const ledger = [
      ledgerEntry({ contentHash: 'h1' }),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
    ];
    const problems = artifactSetProblems(
      set([
        artifact({
          role: 'PAGE_OBJECT',
          path: 'tests/pages/login.ts',
          ownership: 'QAAI_OWNED',
          disposition: 'UPDATE_OWNED',
          basedOnHash: 'h1',
          content: 'export class LoginPage {}\n',
        }),
      ]),
      // Prior bytes that declare nothing a scanner recognises.
      { ledger, priorContent: () => '// the previous page object was all comments\n' },
    );
    const problem = problems.find((p) => p.kind === 'SHARED_SURFACE_UNREADABLE');
    expect(problem?.why).toContain('no export form could be read');
    expect(problem?.why).toContain('UNREADABLE is not');
  });

  it('says nothing about a shared artifact nothing imports yet', () => {
    const problems = artifactSetProblems(
      set([
        artifact({
          role: 'PAGE_OBJECT',
          path: 'tests/pages/login.ts',
          ownership: 'QAAI_OWNED',
          disposition: 'UPDATE_OWNED',
          basedOnHash: 'h1',
          content: 'export class LoginPage {}\n',
        }),
      ]),
      { ledger: [ledgerEntry({ contentHash: 'h1' })] },
    );
    expect(kinds(problems)).not.toContain('SHARED_SURFACE_UNREADABLE');
    expect(kinds(problems)).not.toContain('SHARED_EXPORT_REMOVED');
  });

  it('fails closed with no inputs at all', () => {
    // Every omitted input is a refusal, not a permission. A caller that forgets
    // the ledger gets a refusal.
    const problems = artifactSetProblems(set([artifact({ ownership: 'QAAI_OWNED' })]));
    expect(kinds(problems)).toContain('STALE_BASE');
  });

  it('refuses an empty set and a set past the cap, and discloses the number', () => {
    expect(kinds(artifactSetProblems(set([])))).toEqual(['SET_SIZE']);
    const many = Array.from({ length: MAX_ARTIFACTS_PER_SET + 1 }, (_, i) =>
      artifact({ path: `tests/s${i}.spec.ts`, ownership: 'QAAI_OWNED' }),
    );
    const problems = artifactSetProblems(set(many));
    expect(problems[0]?.kind).toBe('SET_SIZE');
    expect(problems[0]?.why).toContain(String(MAX_ARTIFACTS_PER_SET + 1));
    expect(problems[0]?.why).toContain('nothing was truncated');
  });

  it('treats every problem as blocking the whole set', () => {
    // One logical change. Applying four files of a five-file set leaves a
    // repository that does not build.
    expect(Object.values(PROBLEM_BLOCKS_SET).every((blocks) => blocks)).toBe(true);
  });
});

describe('sharedSurfaceChange', () => {
  it('reads exports across the languages this product generates', () => {
    const before = 'export class LoginPage {}\nexport const A = 1;\nexport { b, c as d };\n';
    const after = 'export class LoginPage {}\nexport { b };\n';
    const change = sharedSurfaceChange(before, after);
    expect(change.state).toBe('READ');
    if (change.state !== 'READ') throw new Error('unreachable');
    expect([...change.removed].sort()).toEqual(['A', 'd']);
  });

  it('reads a Python module and a Go file', () => {
    expect(sharedSurfaceChange('def login(page):\n    pass\n', 'def login(page):\n    pass\n')).toEqual(
      { state: 'READ', removed: [], added: [] },
    );
    const go = sharedSurfaceChange('func TestLogin(t *testing.T) {}\n', 'func TestOut(t *testing.T) {}\n');
    expect(go.state).toBe('READ');
  });

  it('says UNREADABLE rather than "nothing was removed"', () => {
    expect(sharedSurfaceChange('// just a comment\n', 'export const A = 1;\n')).toEqual({
      state: 'UNREADABLE',
    });
  });

  it('does not carry regex state between calls', () => {
    // A module-level /g regex keeps lastIndex, which would make the SECOND file
    // scanned report half its exports. Two identical calls must agree.
    const content = 'export const A = 1;\nexport const B = 2;\n';
    const first = sharedSurfaceChange(content, 'export const A = 1;\n');
    const second = sharedSurfaceChange(content, 'export const A = 1;\n');
    expect(second).toEqual(first);
    if (first.state !== 'READ') throw new Error('unreachable');
    expect(first.removed).toEqual(['B']);
  });
});

describe('the single-file migration path', () => {
  it('round-trips through generatedTestSchema with no set at all', () => {
    const parsed = generatedTestSchema.parse({
      name: 'adds an item to the cart',
      filePath: 'tests/cart.spec.ts',
      code: "test('x', async () => {});",
    });
    expect(parsed.artifacts).toBeUndefined();
    // And the consumer never branches.
    expect(artifactSetOf(parsed).artifacts).toHaveLength(1);
    expect(specArtifactOf(artifactSetOf(parsed))?.path).toBe('tests/cart.spec.ts');
  });

  it('refuses a set whose SPEC disagrees with `code` or `filePath`', () => {
    const base = {
      name: 'x',
      filePath: 'tests/cart.spec.ts',
      code: 'A',
      artifacts: {
        dialect: 'JS_EXPECT' as const,
        artifacts: [
          {
            role: 'SPEC' as const,
            path: 'tests/cart.spec.ts',
            content: 'A',
            disposition: 'NEW' as const,
            ownership: 'QAAI_OWNED' as const,
            imports: [],
            basedOnHash: null,
            why: 'the test',
          },
        ],
      },
    };
    expect(generatedTestSchema.safeParse(base).success).toBe(true);

    const wrongPath = structuredClone(base);
    wrongPath.artifacts.artifacts[0]!.path = 'tests/elsewhere.spec.ts';
    expect(generatedTestSchema.safeParse(wrongPath).success).toBe(false);

    const wrongCode = structuredClone(base);
    wrongCode.artifacts.artifacts[0]!.content = 'B';
    expect(generatedTestSchema.safeParse(wrongCode).success).toBe(false);
  });

  it('refuses a set with no SPEC or with two', () => {
    const withRole = (role: 'SPEC' | 'FIXTURE', path: string) => ({
      role,
      path,
      content: 'A',
      disposition: 'NEW' as const,
      ownership: 'QAAI_OWNED' as const,
      imports: [],
      basedOnHash: null,
      why: 'x',
    });
    const none = generatedTestSchema.safeParse({
      name: 'x',
      filePath: 'tests/cart.spec.ts',
      code: 'A',
      artifacts: { dialect: null, artifacts: [withRole('FIXTURE', 'tests/fixtures/a.ts')] },
    });
    expect(none.success).toBe(false);

    const two = generatedTestSchema.safeParse({
      name: 'x',
      filePath: 'tests/cart.spec.ts',
      code: 'A',
      artifacts: {
        dialect: null,
        artifacts: [withRole('SPEC', 'tests/cart.spec.ts'), withRole('SPEC', 'tests/other.spec.ts')],
      },
    });
    expect(two.success).toBe(false);
  });

  it('produces a set the write path accepts, from the producer that builds it', () => {
    // LESSON H: a test over a producer must END AT THE VALIDATOR the write path
    // runs. `singleFileArtifactSet` is the migration shim every existing caller
    // will reach for, so it is pushed through `artifactSetSchema` itself.
    const built = singleFileArtifactSet({
      filePath: 'tests/cart.spec.ts',
      code: "test('x', async () => {});",
      dialect: 'JS_EXPECT',
    });
    expect(artifactSetSchema.safeParse(built).success).toBe(true);
  });

  it('refuses the producer\u2019s output at the schema\u2019s own FLOOR, not only its ceiling', () => {
    // The floor, which an adversary found last round: an EMPTY string where
    // min(1) is expected. `content` and `why` are both min(1).
    const empty = singleFileArtifactSet({ filePath: 'tests/cart.spec.ts', code: '', why: '' });
    expect(artifactSetSchema.safeParse(empty).success).toBe(false);
    const blankPath = singleFileArtifactSet({ filePath: '', code: 'A' });
    expect(artifactSetSchema.safeParse(blankPath).success).toBe(false);
  });

  it('orders a set so dependencies land first, stably', () => {
    const ordered = orderedForApply(
      set([
        artifact({ role: 'SPEC', path: 'tests/b.spec.ts' }),
        artifact({ role: 'PAGE_OBJECT', path: 'tests/pages/z.ts' }),
        artifact({ role: 'SPEC', path: 'tests/a.spec.ts' }),
        artifact({ role: 'FIXTURE', path: 'tests/fixtures/f.ts' }),
      ]),
    );
    expect(ordered.artifacts.map((a) => a.path)).toEqual([
      'tests/fixtures/f.ts',
      'tests/pages/z.ts',
      'tests/a.spec.ts',
      'tests/b.spec.ts',
    ]);
  });
});

describe('the correction corpus', () => {
  const probes: CorrectionProbes = {
    assertionCount: (code) => (code.match(/expect\(/g) ?? []).length,
    assertionLines: (code) => code.split('\n').filter((line) => line.includes('expect(')),
    hasFixedSleep: (code) => /waitForTimeout|sleep\(/.test(code),
  };

  const classify = (before: string, after: string, over: Record<string, unknown> = {}) =>
    classifyCorrection(
      {
        before,
        after,
        beforePath: 'tests/cart.spec.ts',
        afterPath: 'tests/cart.spec.ts',
        testId: 't1',
        generatedVersion: 1,
        humanVersion: 2,
        ...over,
      },
      probes,
    );

  it('names a locator rewrite', () => {
    const result = classify(
      "await page.locator('div.sc-x7f2 > span:nth-child(3)').click();\n",
      "await page.getByRole('button', { name: 'Pay' }).click();\n",
    );
    expect(result.kinds).toContain('LOCATOR_CHANGED');
    expect(result.items[0]?.before).toContain('sc-x7f2');
  });

  it('names a strengthened and a weakened assertion by direction', () => {
    expect(classify('expect(a).toBe(1);\n', 'expect(a).toBe(1);\nexpect(b).toBe(2);\n').kinds).toContain(
      'ASSERTION_STRENGTHENED',
    );
    expect(classify('expect(a).toBe(1);\nexpect(b).toBe(2);\n', 'expect(a).toBe(1);\n').kinds).toContain(
      'ASSERTION_WEAKENED',
    );
  });

  it('names a removed fixed sleep through the probe the gate uses', () => {
    const result = classify(
      'await page.waitForTimeout(3000);\nexpect(a).toBe(1);\n',
      'await expect(x).toBeVisible();\nexpect(a).toBe(1);\n',
    );
    expect(result.kinds).toContain('WAIT_REMOVED');
  });

  it('names a move, a split and a rename', () => {
    expect(
      classify('x', 'x', { afterPath: 'e2e/cart.spec.ts' }).kinds,
    ).toContain('FILE_MOVED');
    expect(
      classify("test('a', () => {});\n", "test('a', () => {});\ntest('b', () => {});\n").kinds,
    ).toContain('TEST_SPLIT');
    expect(
      classify("test('adds item', () => {});\n", "test('adds an item to the cart', () => {});\n")
        .kinds,
    ).toContain('NAMING_CHANGED');
  });

  it('calls a reformat FORMATTING_ONLY and nothing else', () => {
    const result = classify('expect( a ).toBe( 1 );\n', 'expect(a).toBe(1);\n');
    expect(result.kinds).toEqual(['FORMATTING_ONLY']);
  });

  it('never classifies a diff that exists as nothing', () => {
    // THE RULE. An empty `kinds` would read as "the reviewer changed nothing",
    // which is a null that became zero.
    const result = classify('const unremarkable = 1;\n', 'const totallyDifferent = 2;\n');
    expect(result.kinds.length).toBeGreaterThan(0);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(0);
  });

  it('counts what it could not name rather than bucketing or dropping it', () => {
    const result = classify('const q = 1;\n', 'const z = 9;\n');
    expect(result.kinds).toContain('UNCLASSIFIED');
    expect(result.unclassifiedCount).toBe(
      result.items.filter((i) => i.kind === 'UNCLASSIFIED').length,
    );
  });

  it('is not recordable for an identical pair, and the schema agrees', () => {
    const result = classify('same\n', 'same\n');
    expect(result.kinds).toEqual([]);
    expect(isRecordableCorrection(result)).toBe(false);
    // The producer and the validator must agree about this one shape.
    expect(
      testCorrectionSchema.safeParse({ orgId: 'o', projectId: 'p', ...result }).success,
    ).toBe(false);
  });

  it('discloses the item cap as a count rather than swallowing it', () => {
    const before = Array.from({ length: 200 }, (_, i) => `await page.locator('#a${i}').click();`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `await page.getByTestId('a${i}').click();`).join('\n');
    const result = classify(before, after);
    expect(result.items.length).toBe(MAX_CORRECTION_ITEMS);
    expect(result.itemsOmitted).toBeGreaterThan(0);
    // And the row still parses: the cap is reported, not a refusal.
    expect(
      testCorrectionSchema.safeParse({ orgId: 'o', projectId: 'p', ...result }).success,
    ).toBe(true);
  });

  it('bounds every quote at the schema\u2019s own ceiling', () => {
    const long = `await page.locator('${'x'.repeat(5_000)}').click();`;
    const result = classify(`${long}\n`, "await page.getByRole('button').click();\n");
    for (const item of result.items) {
      expect(item.before.length).toBeLessThanOrEqual(MAX_CORRECTION_QUOTE_CHARS);
      expect(item.after.length).toBeLessThanOrEqual(MAX_CORRECTION_QUOTE_CHARS);
    }
    expect(
      testCorrectionSchema.safeParse({ orgId: 'o', projectId: 'p', ...result }).success,
    ).toBe(true);
  });

  it('is stored by the validator for every kind it can produce', () => {
    // LESSON H again, and the broadest form of it: everything the classifier
    // emits is pushed through the validator the write path actually runs. A test
    // that only asserted the SPELLING of a kind would not have asserted that a
    // row carrying it can be stored.
    const pairs: [string, string][] = [
      ["await page.locator('.x').click();\n", "await page.getByRole('link').click();\n"],
      ['expect(a).toBe(1);\n', 'expect(a).toBe(1);\nexpect(b).toBe(2);\n'],
      ['expect(a).toBe(1);\nexpect(b).toBe(2);\n', 'expect(a).toBe(1);\n'],
      ['await page.waitForTimeout(1);\nexpect(a).toBe(1);\n', 'await expect(a).toBe(1);\n'],
      ["test('a', () => {});\n", "test('a', () => {});\ntest('b', () => {});\n"],
      ['expect( a ).toBe( 1 );\n', 'expect(a).toBe(1);\n'],
      ['const q = 1;\n', 'const z = 9;\n'],
      ['x\n', ''],
    ];
    const seen = new Set<string>();
    for (const [before, after] of pairs) {
      const result = classify(before, after);
      for (const kind of result.kinds) seen.add(kind);
      const parsed = testCorrectionSchema.safeParse({ orgId: 'o', projectId: 'p', ...result });
      expect(parsed.success, `${result.kinds.join(',')}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it('refuses a row whose human version precedes the generated one', () => {
    const result = classify('a\n', 'b\n');
    const reversed = { ...result, generatedVersion: 5, humanVersion: 2 };
    expect(
      testCorrectionSchema.safeParse({ orgId: 'o', projectId: 'p', ...reversed }).success,
    ).toBe(false);
  });

  it('refuses a kind with no item behind it, and a repeated kind', () => {
    const result = classify('a\n', 'b\n');
    expect(
      testCorrectionSchema.safeParse({
        orgId: 'o',
        projectId: 'p',
        ...result,
        kinds: ['LOCATOR_CHANGED'],
      }).success,
    ).toBe(false);
    expect(
      testCorrectionSchema.safeParse({
        orgId: 'o',
        projectId: 'p',
        ...result,
        kinds: [...result.kinds, ...result.kinds],
      }).success,
    ).toBe(false);
  });

  it('refuses an unclassifiedCount computed independently of its items', () => {
    const result = classify('const q = 1;\n', 'const z = 9;\n');
    expect(
      testCorrectionSchema.safeParse({
        orgId: 'o',
        projectId: 'p',
        ...result,
        unclassifiedCount: 0,
      }).success,
    ).toBe(false);
  });

  it('refuses a row claiming a classifier that does not exist', () => {
    const result = classify('a\n', 'b\n');
    expect(
      testCorrectionSchema.safeParse({
        orgId: 'o',
        projectId: 'p',
        ...result,
        classifierVersion: CORRECTION_CLASSIFIER_VERSION + 1,
      }).success,
    ).toBe(false);
  });

  it('refuses a row with no project, which is the privacy boundary as a constraint', () => {
    const result = classify('a\n', 'b\n');
    expect(testCorrectionSchema.safeParse({ orgId: 'o', projectId: '', ...result }).success).toBe(
      false,
    );
    expect(
      testCorrectionSchema.safeParse({ orgId: 'o', ...result }).success,
    ).toBe(false);
  });
});

describe('the corpus boundary', () => {
  it('cannot build a scope without both ids', () => {
    expect(() => corpusScope('', 'p')).toThrow();
    expect(() => corpusScope('o', '')).toThrow();
    /*
     * WHITESPACE IS BLANK. The check was `length === 0` under a doc comment
     * that said "neither may be blank", so a scope over two spaces was built,
     * `corpusWhere` asked Prisma for an org whose id is two spaces, and the
     * corpus came back EMPTY — which reads as "this project's reviewers have
     * changed nothing" rather than as a bad id. The floor of this input, not
     * its ceiling.
     */
    expect(() => corpusScope('  ', 'p')).toThrow();
    expect(() => corpusScope('o', '\t\n')).toThrow();
    expect(corpusWhere(corpusScope('o', 'p'))).toEqual({ orgId: 'o', projectId: 'p' });
  });

  it('hands Prisma a plain object with no symbol key on it', () => {
    const where = corpusWhere(corpusScope('o', 'p'));
    // A symbol key in a `where` is a field Prisma does not know.
    expect(Reflect.ownKeys(where)).toEqual(['orgId', 'projectId']);
  });

  it('rejects and COUNTS a row from another project rather than averaging it in', () => {
    const scope = corpusScope('o', 'p');
    const row = (projectId: string, kind: 'LOCATOR_CHANGED' | 'UNCLASSIFIED') => ({
      orgId: 'o',
      projectId,
      testId: 't',
      generatedVersion: 1,
      humanVersion: 2,
      kinds: [kind] as const,
      items: [],
      surface: null,
      addedLines: 1,
      removedLines: 1,
      unclassifiedCount: kind === 'UNCLASSIFIED' ? 1 : 0,
      classifierVersion: 1,
      itemsOmitted: 0,
    });
    const summary = summariseCorrections(scope, [
      row('p', 'LOCATOR_CHANGED'),
      row('p', 'LOCATOR_CHANGED'),
      row('other', 'LOCATOR_CHANGED'),
      row('p', 'UNCLASSIFIED'),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.rowsRejected).toBe(1);
    expect(summary.byKind.LOCATOR_CHANGED).toBe(2);
    expect(summary.actionable).toBe(2);
    expect(summary.unclassified).toBe(1);
  });

  it('starts every kind at 0 so a group-by has no holes in it', () => {
    const summary = summariseCorrections(corpusScope('o', 'p'), []);
    expect(Object.keys(summary.byKind).sort()).toEqual([...CORRECTION_KINDS].sort());
    expect(Object.values(summary.byKind).every((n) => n === 0)).toBe(true);
  });
});

describe('suite-change proposals', () => {
  const page = (content: string, over: Partial<GeneratedArtifact> = {}) =>
    artifact({
      role: 'PAGE_OBJECT',
      path: 'tests/pages/login.ts',
      content,
      ownership: 'QAAI_OWNED',
      disposition: 'UPDATE_OWNED',
      basedOnHash: 'h1',
      ...over,
    });

  const proposal = (over: Partial<SuiteChangeProposal> = {}): SuiteChangeProposal => ({
    kind: 'EXTRACT_PAGE_OBJECT',
    state: 'PROPOSED',
    title: 'Move the login locators behind a page object',
    rationale: 'suite-health reported 4 near-duplicate login flows',
    before: set([page('export class LoginPage { a() {} }\n')]),
    after: set([page('export class LoginPage { a() {} b() {} }\n')]),
    dependentTestIds: [],
    dependentPaths: [],
    revert: {
      paths: ['tests/pages/login.ts'],
      entries: [
        {
          path: 'tests/pages/login.ts',
          existed: true,
          priorContent: 'export class LoginPage { a() {} }\n',
          priorHash: 'h1',
          priorOwnership: 'QAAI_OWNED',
        },
      ],
    },
    ...over,
  });

  it('accepts a complete proposal', () => {
    expect(proposalProblems(proposal())).toEqual([]);
    expect(suiteChangeProposalSchema.safeParse(proposal()).success).toBe(true);
  });

  it('refuses a proposal whose revert record misses a file it changes', () => {
    const p = proposal({ revert: { paths: [], entries: [] } });
    // The schema's own min(1) catches the empty case; proposalProblems catches
    // the subtler one, where entries exist and one path is missing.
    expect(suiteChangeProposalSchema.safeParse(p).success).toBe(false);

    const partial = proposal({
      after: set([
        page('export class LoginPage { a() {} b() {} }\n'),
        artifact({ path: 'tests/login.spec.ts', ownership: 'QAAI_OWNED' }),
      ]),
    });
    expect(kinds(proposalProblems(partial))).toContain('REVERT_INCOMPLETE');
    expect(suiteChangeProposalSchema.safeParse(partial).success).toBe(false);
  });

  it('refuses a revert record that names a file the proposal does not touch', () => {
    const p = proposal({
      revert: {
        paths: ['tests/pages/login.ts', 'tests/elsewhere.ts'],
        entries: [
          {
            path: 'tests/pages/login.ts',
            existed: true,
            priorContent: 'x',
            priorHash: 'h1',
            priorOwnership: null,
          },
          { path: 'tests/elsewhere.ts', existed: false },
        ],
      },
    });
    expect(kinds(proposalProblems(p))).toContain('REVERT_OVERREACH');
  });

  it('refuses prior bytes for a file the proposal creates, and the reverse', () => {
    const creates = proposal({
      before: set([]),
      after: set([artifact({ path: 'tests/new.spec.ts', ownership: 'QAAI_OWNED' })]),
      revert: {
        paths: ['tests/new.spec.ts'],
        entries: [
          {
            path: 'tests/new.spec.ts',
            existed: true,
            priorContent: 'x',
            priorHash: 'h',
            priorOwnership: null,
          },
        ],
      },
    });
    expect(kinds(proposalProblems(creates))).toContain('REVERT_INCOHERENT');

    const claimsAbsent = proposal({
      revert: {
        paths: ['tests/pages/login.ts'],
        entries: [{ path: 'tests/pages/login.ts', existed: false }],
      },
    });
    expect(kinds(proposalProblems(claimsAbsent))).toContain('REVERT_INCOHERENT');
  });

  it('refuses a proposal that proposes nothing', () => {
    const same = proposal({ after: set([page('export class LoginPage { a() {} }\n')]) });
    expect(kinds(proposalProblems(same))).toContain('NO_CHANGE');
    expect(suiteChangeProposalSchema.safeParse(same).success).toBe(false);
  });

  it('refuses an APPLIED proposal with no revert entries', () => {
    // The record is written BEFORE the apply, never after it.
    const applied = {
      ...proposal({ state: 'APPLIED' }),
      revert: { paths: ['tests/pages/login.ts'], entries: [] as never[] },
    };
    expect(suiteChangeProposalSchema.safeParse(applied).success).toBe(false);
  });

  it('refuses a traversal in every path field, not only the ones inside a set', () => {
    /*
     * `artifactPath` guards FIVE fields and `artifactSetProblems`' PATH_ESCAPE
     * only ever sees one of them. A mutation that gutted the refinement survived
     * this file's first pass, because every path it tested was inside an
     * artifact set and therefore caught twice. These four are the fields with no
     * second line of defence — a revert entry, a declared revert path, a
     * disclosed dependent, and a helper's import path — and each one is joined
     * against a working tree or interpolated into a generated import.
     */
    const hostile = '../../etc/passwd';
    const base = proposal();

    expect(
      suiteChangeProposalSchema.safeParse({ ...base, dependentPaths: [hostile] }).success,
    ).toBe(false);
    expect(
      suiteChangeProposalSchema.safeParse({
        ...base,
        revert: { ...base.revert, paths: [...base.revert.paths, hostile] },
      }).success,
    ).toBe(false);
    expect(
      suiteChangeProposalSchema.safeParse({
        ...base,
        revert: { ...base.revert, entries: [{ path: hostile, existed: false }] },
      }).success,
    ).toBe(false);
  });

  it('computes the blast radius from the ledger so the schema can check it was disclosed', () => {
    const ledger = [
      ledgerEntry({ contentHash: 'h1' }),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
      ledgerEntry({ path: 'tests/b.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
    ];
    expect(dependentsAffected(proposal(), ledger)).toEqual(['tests/a.spec.ts', 'tests/b.spec.ts']);
  });

  it('never counts a file the proposal itself rewrites as its own dependent', () => {
    const ledger = [
      ledgerEntry({ contentHash: 'h1' }),
      ledgerEntry({ path: 'tests/a.spec.ts', role: 'SPEC', imports: ['tests/pages/login.ts'] }),
    ];
    const p = proposal({
      after: set([
        page('export class LoginPage { a() {} b() {} }\n'),
        artifact({ path: 'tests/a.spec.ts', ownership: 'QAAI_OWNED' }),
      ]),
      revert: {
        paths: ['tests/pages/login.ts', 'tests/a.spec.ts'],
        entries: [
          {
            path: 'tests/pages/login.ts',
            existed: true,
            priorContent: 'x',
            priorHash: 'h1',
            priorOwnership: 'QAAI_OWNED',
          },
          { path: 'tests/a.spec.ts', existed: false },
        ],
      },
    });
    expect(dependentsAffected(p, ledger)).toEqual([]);
  });

  it('marks a merge as behaviour-altering and a rename as not', () => {
    expect(CHANGE_ALTERS_BEHAVIOUR.MERGE_NEAR_DUPLICATES).toBe(true);
    expect(CHANGE_ALTERS_BEHAVIOUR.MOVE_FILE).toBe(false);
  });
});
