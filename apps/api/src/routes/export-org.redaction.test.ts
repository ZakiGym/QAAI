/**
 * THE COLUMN REDACTION ON THE ORG EXPORT, WHICH HAD NO TEST AT ALL.
 *
 * `isExcludedColumn` and `redactRow` decide what leaves the building in a file
 * an owner downloads and then mails around. Until this file there was not one
 * assertion on either of them anywhere in the repository, and the cost showed
 * up immediately: the sealing round added `AuthProfile.storageStateSealed` and
 * the pattern guarding it was `/^storageState$/`, ANCHORED — so the sealed
 * session was exported while `EXCLUSION_NOTES` told the recipient it had been
 * withheld.
 *
 * The tests below are therefore written against the SCHEMA rather than against
 * the pattern list: the second test reads every column name out of
 * `schema.prisma` and asserts that every one whose name marks it as a
 * credential is excluded. A test that only restated the patterns would have
 * passed on the day the defect shipped.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXCLUSION_NOTES, isExcludedColumn, redactRow } from './export-org.js';

/**
 * Every column name in the Prisma schema, from the lines that declare one.
 *
 * Read from the file rather than from the generated client, because the
 * question is "what does this schema contain" and the client would answer it
 * only for models that are also generated.
 *
 * At module scope because TWO blocks below need it — the credential sweep and
 * the manifest's account of the `storageState` family — and the alternative was
 * a second hand-typed list of the columns under test, which is how a list stops
 * covering the tenth one.
 */
function schemaColumnNames(): string[] {
  const schema = readFileSync(
    join(import.meta.dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const names = new Set<string>();
  for (const line of schema.split('\n')) {
    const match = /^\s{2}([a-z][A-Za-z0-9_]*)\s+\S/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

describe('isExcludedColumn', () => {
  it('EXCLUDES THE SEALED SESSION, not only the plaintext one', () => {
    /*
     * The defect, named. `storageState` was excluded and `storageStateSealed`
     * was not, and nothing else in the list reaches it: it does not end in
     * `Enc` or `Hash`, and it contains neither "secret", "token" nor
     * "password". Ciphertext leaving the building is an offline target, and the
     * manifest claiming it had been withheld was the worse half.
     */
    expect(isExcludedColumn('storageState')).toBe(true);
    expect(isExcludedColumn('storageStateSealed')).toBe(true);
    expect(isExcludedColumn('storageStateKeyVersion')).toBe(true);
    expect(isExcludedColumn('storageStateSealedAt')).toBe(true);
    expect(isExcludedColumn('storageStateNeedsReseal')).toBe(true);
  });

  it('excludes the key reference, which names a customer key in their own cloud', () => {
    expect(isExcludedColumn('providerRef')).toBe(true);
  });

  it('excludes the login tables’ hashed identifier and the recovery-code hash', () => {
    // Both reach the list through `/Hash$/`. Asserted anyway, because these two
    // columns arrived in the same round as the one the prefix defect was in.
    expect(isExcludedColumn('identifierHash')).toBe(true);
    expect(isExcludedColumn('codeHash')).toBe(true);
  });

  it('still lets the ordinary columns through, so the export is not empty', () => {
    for (const name of ['id', 'name', 'createdAt', 'baseUrl', 'kind', 'role', 'keyVersion']) {
      expect(isExcludedColumn(name), name).toBe(false);
    }
  });

  it('is what redactRow applies, and redactRow REPORTS what it dropped', () => {
    const dropped = new Set<string>();
    const out = redactRow(
      {
        id: 'prof_1',
        name: 'admin',
        storageState: { cookies: [] },
        storageStateSealed: 'qs1.local-1.1.AES_256_GCM.AAAA',
        valueEnc: 'ciphertext',
      },
      dropped,
    );
    expect(Object.keys(out).sort()).toEqual(['id', 'name']);
    expect([...dropped].sort()).toEqual(['storageState', 'storageStateSealed', 'valueEnc']);
  });
});

describe('the schema, not the pattern list', () => {
  it('excludes EVERY column whose name marks it as a credential', () => {
    /*
     * The rule in one place: a column whose name says it holds or verifies a
     * credential must not be exported. Driven off the schema so that adding one
     * in a future round fails HERE rather than in an org export somebody has
     * already sent.
     *
     * `secretId`, `secretName` and `secretNames` are REFERENCES — a row id and
     * an environment-variable name — and are exported on purpose, which is why
     * the credential test is a name test and not a substring test.
     */
    const credentialish = (name: string): boolean =>
      /Enc$/.test(name) ||
      /Hash$/.test(name) ||
      name.startsWith('storageState') ||
      name === 'providerRef' ||
      name === 'hint' ||
      name === 'signature' ||
      name.startsWith('pkceVerifier') ||
      /password/i.test(name) ||
      /token$/i.test(name);

    const columns = schemaColumnNames();
    // A guard on the reader itself: a regex that matched nothing would make
    // every assertion below vacuous, which is the "pass that means we did not
    // check" this product may not print.
    expect(columns.length).toBeGreaterThan(300);

    const leaking = columns.filter((name) => credentialish(name) && !isExcludedColumn(name));
    expect(leaking).toEqual([]);
  });
});

describe('the manifest and the code agree', () => {
  it('names the session exclusion it actually performs', () => {
    /*
     * A doc comment that contradicts the code under it is a defect, and in this
     * file it is the SHIPPED ARTEFACT: `EXCLUSION_NOTES` is written into the
     * export and is what the recipient reads instead of the source. For one
     * round it promised the session had been withheld while the sealed column
     * went out.
     */
    const note = EXCLUSION_NOTES.find((entry) => entry.what.includes('storageState'));
    expect(note).toBeDefined();
    for (const column of ['storageState', 'storageStateSealed']) {
      expect(isExcludedColumn(column), `${column} is promised withheld`).toBe(true);
    }
  });

  /**
   * AND IT NAMES THE WHOLE FAMILY, NOT THE FIRST MEMBER OF IT.
   *
   * The test above passed while `redactRow` dropped NINE columns and this entry
   * named one — the anchored-pattern defect inverted, and in the direction that
   * matters more, because `EXCLUSION_NOTES` travels inside the export and is
   * what the recipient reads instead of this source file. Seven of those nine
   * are not credentials (an expiry, a key version, a seal time, a re-seal flag,
   * two refresh timestamps and a failure counter), so an entry that mentioned
   * only `storageState` destroyed the one distinction `redactRow`'s doc comment
   * says the dropped set exists to preserve: "QAAI does not have this" against
   * "QAAI would not give me this".
   *
   * The family is read OUT OF THE SCHEMA and not typed here, for the reason the
   * `schemaColumnNames` block above gives and the reason rule 9 gives: a
   * hand-copied list of the columns under test is a list that silently stops
   * covering the tenth one.
   */
  it('names the WHOLE storageState family it withholds, not just the first column', () => {
    const family = schemaColumnNames()
      .filter((name) => name.startsWith('storageState'))
      .sort();
    // Not vacuous: the sealing round minted the family, so there is more than one.
    expect(family.length).toBeGreaterThan(2);

    const dropped = new Set<string>();
    const kept = redactRow(Object.fromEntries(family.map((c) => [c, 'x'])), dropped);
    // Every one of them really is withheld, which is what the note must describe.
    expect([...dropped].sort()).toEqual(family);
    expect(Object.keys(kept)).toEqual([]);

    const note = EXCLUSION_NOTES.find((entry) => entry.what.includes('storageState'));
    expect(note).toBeDefined();
    /*
     * The sentence must say that the exclusion is the PREFIX and not the single
     * column, and it must name the non-credential members a recipient would
     * otherwise go looking for. Asserted on the prose because the prose is the
     * artefact; a note that merely repeated the column name would be the
     * version this test was written to fail.
     */
    const prose = `${note!.what} ${note!.why}`;
    /*
     * ── THIS ASSERTED ONE ENGLISH SENTENCE AND THE PROSE SAYS IT DIFFERENTLY ──
     *
     * It was `toContain('EVERY AuthProfile column whose name begins')`, a
     * phrase that is not in export-org.ts and, on the evidence of the prose
     * that IS there, never was — a test written against an earlier draft of the
     * note. The behaviour assertions above all pass: every member of the family
     * really is withheld. Only the wording pin failed, and a test that breaks
     * when a correct sentence is rephrased trains people to edit the test.
     *
     * The CLAIMS are asserted instead, which is what the pin was standing in
     * for and is strictly more than it checked:
     *   · the note talks about the FAMILY and not one column,
     *   · it names each non-credential member a recipient would go looking for,
     *   · and it says the exclusion holds for members added LATER, which is the
     *     forward-compatibility promise that makes the prefix reading matter.
     */
    expect(prose.toLowerCase()).toContain('family');
    for (const promised of ['expiry', 'key version', 'refresh', 're-seal']) {
      expect(prose.toLowerCase(), `the note accounts for the ${promised}`).toContain(promised);
    }
    expect(
      /added|future|by default/i.test(prose),
      'the note promises the exclusion covers columns added to the family later',
    ).toBe(true);
    // And it is about the family, so it cannot be the single column alone.
    expect(prose).toContain('storageState');
  });
});
