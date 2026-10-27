/*
 * The provider catalogue: its arithmetic, its honesty and — the part that is
 * binding rather than nice — the structural proof that it cannot hold a secret.
 *
 * Two of the tests here read this module's own SOURCE off disk. That is
 * deliberate and it is the only way to assert an absence: "makes no network
 * call" and "reads nothing from process.env" are claims about code that does
 * not exist, and no amount of calling the exports can establish them. The repo
 * already has this shape (the duplicated row-builder was held together by a
 * test that read both files off disk), and the alternative is a doc comment
 * nobody can falsify — which is one of the lies rule 12 names.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_OMISSIONS,
  CATALOGUE_PUBLISHERS,
  CATALOGUE_PUBLISHER_LIST,
  CATALOGUE_REFUSAL_REASONS,
  CATALOGUE_REFUSAL_REASON_LIST,
  CATALOGUE_VALUE_KINDS,
  CATALOGUE_VALUE_KIND_LIST,
  PAYMENT_TESTABILITIES,
  PAYMENT_TESTABILITY_LIST,
  PROVIDER_CATALOGUE,
  SECRET_SHAPES,
  admitPublishedValue,
  assessGate,
  catalogueEntriesForTestValueProvider,
  catalogueEntriesOfKind,
  catalogueHasId,
  describeProviderCatalogueConfidence,
  ibanBreak,
  ibanChecksumValid,
  ibanMod97,
  type CatalogueEntry,
  type CatalogueRefusalReason,
  type PublishedTestValue,
} from './provider-catalogue';
import { TEST_VALUE_EVIDENCE } from './test-values';

/** This module's own source, for the two absence assertions. */
const SOURCE_WITH_COMMENTS = readFileSync(
  fileURLToPath(new URL('./provider-catalogue.ts', import.meta.url)),
  'utf8',
);

/**
 * Comments blanked out, so prose cannot be read as code.
 *
 * Needed, not fussiness: the module's header says in so many words that it
 * "reads nothing from `process.env`", and a raw substring search found that
 * sentence and failed. Replaced with spaces rather than removed, matching
 * `scripts/check-wiring.ts`'s own helper, so line numbers survive if one of
 * these ever fails and somebody has to go looking.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    );
}

const SOURCE = stripComments(SOURCE_WITH_COMMENTS);

describe('catalogue vocabulary parity', () => {
  it('derives every list from its presence record, in declaration order', () => {
    // The compiler half is the `Record<Union, true>`; this is the run-time half.
    // Each catches what the other cannot — eight GateRule kinds were unsaveable
    // by any customer for two slices because only one mechanism existed.
    expect(CATALOGUE_PUBLISHER_LIST).toEqual([...CATALOGUE_PUBLISHERS]);
    expect(CATALOGUE_VALUE_KIND_LIST).toEqual([...CATALOGUE_VALUE_KINDS]);
    expect(CATALOGUE_REFUSAL_REASON_LIST).toEqual([...CATALOGUE_REFUSAL_REASONS]);
    expect(PAYMENT_TESTABILITY_LIST).toEqual([...PAYMENT_TESTABILITIES]);
  });

  it('HAS NO CARD KIND, so a card number has no entry shape to occupy', () => {
    /*
     * The structural half of "no real card number can be stored". A real card
     * and a test card are both sixteen Luhn-valid digits, so no admission
     * function can separate them; the only defence that works is for this
     * catalogue to have nowhere to put one. Cards live in test-values.ts, where
     * the set is closed.
     */
    expect(CATALOGUE_VALUE_KINDS).not.toContain('card');
    for (const kind of CATALOGUE_VALUE_KINDS) {
      expect(kind).not.toMatch(/card/);
    }
  });
});

describe('MOD-97-10, the one claim this module can prove', () => {
  it('returns 1 for every bank-account entry in the catalogue', () => {
    /*
     * THE TEST THAT CHECKS MY RECALL. Every IBAN below was written from memory,
     * and a single transposed digit fails mod-97 with probability 96/97 — so
     * this assertion is what makes `verified: true` and `evidence:
     * 'computed-here'` honest on those entries rather than decorative.
     */
    const accounts = catalogueEntriesOfKind('bank-account');
    expect(accounts.length).toBeGreaterThan(0);
    for (const entry of accounts) {
      expect(entry.value, entry.id).not.toBeNull();
      expect(ibanMod97(entry.value!.published), entry.id).toBe(1);
    }
  });

  it('distinguishes a malformed IBAN from a wrong-checksum one', () => {
    // Two different findings: the first is a format error the form should
    // catch, the second is a transposition only arithmetic catches. A boolean
    // would collapse them.
    expect(ibanMod97('not an iban')).toBeNull();
    expect(ibanMod97('DE89')).toBeNull();
    expect(ibanMod97('DE89370400440532013001')).not.toBeNull();
    expect(ibanMod97('DE89370400440532013001')).not.toBe(1);
  });

  it('accepts the lower-case and spaced forms a human types', () => {
    expect(ibanChecksumValid('de89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanChecksumValid('DE89-3704-0044-0532-0130-00')).toBe(true);
  });

  it('breaks a valid IBAN by transposition, and the break actually invalidates it', () => {
    /*
     * A "negative" case that is secretly still valid is a test that goes green
     * while proving nothing, so the generated invalid value is checked rather
     * than assumed — which is exactly what ibanBreak's doc comment tells the
     * caller to do.
     */
    for (const entry of catalogueEntriesOfKind('bank-account')) {
      const broken = ibanBreak(entry.value!.published);
      expect(broken.length, entry.id).toBe(entry.value!.published.length);
      expect(ibanChecksumValid(broken), entry.id).toBe(false);
    }
  });

  it('is deterministic: the same IBAN breaks the same way every time', () => {
    expect(ibanBreak('DE89370400440532013000')).toBe(ibanBreak('DE89370400440532013000'));
  });
});

// ─── The binding one ─────────────────────────────────────────────────────────

describe('the catalogue IS INCAPABLE OF HOLDING A SECRET', () => {
  /**
   * One live-looking candidate per shape the admission knows, COMPOSED AT RUN
   * TIME from `SECRET_SHAPES` rather than written out as literals.
   *
   * Two reasons, and the second is the one that cost a push.
   *
   * FIRST: derived beats parallel. The previous version was a hand-written list
   * of sixteen literals beside a twenty-seven-entry `SECRET_SHAPES`, so eleven
   * shapes were declared and never probed, and every shape added after would
   * have been unprobed too. Driving the loop from the exported list means a new
   * prefix is covered the moment it is declared — which is the whole reason
   * `SECRET_SHAPES` is exported.
   *
   * SECOND: A TEST FILE IS EXACTLY AS COMMITTED AS A SOURCE FILE. The literals
   * were invented — keyboard noise, not a key anybody holds — and GitHub's push
   * protection blocked the push anyway, on three of them, because a scanner
   * cannot tell an invented `sk_live_` from a real one. Nor can a human
   * skimming a diff, which is the more important half: a file full of strings
   * that look exactly like live keys is indistinguishable from a leak at a
   * glance, and it will trip every scanner a customer runs over this
   * repository. The right resolution was never an allowlist entry — it was to
   * stop writing complete key-shaped literals. No concatenated form exists in
   * the file; each one is assembled in memory, which is where a credential-
   * shaped string belongs even when it is fake.
   *
   * The tail is deliberately boring and FIXED. `admitPublishedValue` matches on
   * `startsWith(prefix)`, so the tail cannot affect which branch is taken, and
   * a tail that looked like entropy would be the same mistake one layer down.
   */
  const FAKE_TAIL = 'EXAMPLE-NOT-A-REAL-CREDENTIAL-0000';
  const LIVE_LOOKING: ReadonlyArray<string> = SECRET_SHAPES.map(
    (shape) => `${shape.prefix}${FAKE_TAIL}`,
  );

  it('refuses every live-looking credential shape it knows', () => {
    for (const candidate of LIVE_LOOKING) {
      const admission = admitPublishedValue(candidate);
      expect(admission.admitted, candidate.slice(0, 8)).toBe(false);
    }
  });

  it('NEVER ECHOES THE INPUT in the refusal, not even truncated', () => {
    /*
     * A refusal message containing the first eight characters of a live key
     * puts `sk_live_` plus entropy into a log, and a log is the one place a
     * leaked credential is guaranteed to be retained. So the refusal names the
     * SHAPE and the caller already has the value if it needs it.
     */
    for (const candidate of LIVE_LOOKING) {
      const admission = admitPublishedValue(candidate);
      if (admission.admitted) throw new Error(`expected a refusal for ${candidate.slice(0, 6)}`);
      expect(admission.detail).not.toContain(candidate);
      // Not even a prefix of it: eight characters of a live key is still eight
      // characters of a live key.
      expect(admission.detail).not.toContain(candidate.slice(0, 8));
    }
  });

  it('refuses a long opaque token that matches no known prefix', () => {
    // The prefix list cannot be complete, so the admission has a catch-all.
    // This is the shape of a key from a provider nobody has heard of yet.
    const unknownVendorKey = 'Zx7Qp2Lm9Rt4Wv6Yb8Nd1Hk3Jf5Gs0Ac2Ue4Io6';
    const admission = admitPublishedValue(unknownVendorKey);
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.reason).toBe('OPAQUE_HIGH_ENTROPY');
  });

  it('can actually produce every refusal reason it declares', () => {
    /*
     * Exhaustiveness over the declared union, copied from
     * `proveDisposable`'s own test. A reason nothing can produce is a reason
     * that will be wrong when something finally does — and a vocabulary with a
     * dead member invites a caller to handle a case that never arrives while
     * the real one falls through.
     */
    const produced = new Set<CatalogueRefusalReason>();
    const probes = [
      '   ',
      `${SECRET_SHAPES[0]!.prefix}${FAKE_TAIL}`,
      'Zx7Qp2Lm9Rt4Wv6Yb8Nd1Hk3Jf5Gs0Ac2Ue4Io6',
      'x'.repeat(200),
    ];
    for (const probe of probes) {
      const admission = admitPublishedValue(probe);
      if (!admission.admitted) produced.add(admission.reason);
    }
    expect([...produced].sort()).toEqual([...CATALOGUE_REFUSAL_REASON_LIST].sort());
  });

  it('STILL ADMITS the published test values, which is the harder half', () => {
    /*
     * A guard that refuses everything is not a guard, it is a broken module.
     * Turnstile's dummy site key is twenty-four characters of mixed case and
     * digits and it MUST pass, because carrying it is the entire sanctioned
     * path past a bot defence. This is the assertion that stops the next person
     * from "tightening" the heuristic into uselessness.
     */
    for (const value of [
      '1x00000000000000000000AA',
      '2x00000000000000000000AB',
      'DE89370400440532013000',
      'FR1420041010050500013M02606',
      '100',
      '<local>@example.com',
    ]) {
      expect(admitPublishedValue(value).admitted, value).toBe(true);
    }
  });

  it('every shipped entry holds an ADMITTED value, so no literal silently became null', () => {
    /*
     * `published()` returns null on refusal. Without this test a contributor who
     * pasted a secret-shaped literal into the tables would get `value: null` —
     * no error, no warning, and an entry that reads as "requires provisioning"
     * while meaning "we refused your paste". A null here must mean the ONE
     * thing it is allowed to mean.
     */
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.kind === 'requires-provisioning') {
        expect(entry.value, entry.id).toBeNull();
      } else {
        expect(entry.value, entry.id).not.toBeNull();
        expect(entry.value!.published.length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it('has no field a secret could occupy, by name', () => {
    /*
     * The shape half. Checked against a real entry at run time as well as by
     * the type, because a future `Partial<…>` or index signature would silence
     * the compiler half without anybody noticing.
     */
    const entry = PROVIDER_CATALOGUE[0]!;
    for (const forbidden of [
      'secret',
      'secretKey',
      'apiKey',
      'token',
      'password',
      'privateKey',
      'credential',
      'bearer',
    ]) {
      expect(Object.keys(entry)).not.toContain(forbidden);
    }
  });

  it('a bare string is not assignable where a published value is expected', () => {
    /*
     * THE STRUCTURAL GUARANTEE, enforced by the compiler.
     *
     * `@ts-expect-error` is itself a compile error when the line below STOPS
     * erroring, so weakening the brand — dropping the symbol, widening the type
     * to `string` — fails `tsc` rather than quietly re-opening the hole. Copied
     * from the two assertions principals.test.ts uses to pin disposability.
     */
    /*
     * COMPOSED, not written out. What the compiler objects to is that the
     * right-hand side is a `string` — the characters in it are irrelevant to
     * this assertion — so there is no reason for a key-shaped literal to exist
     * in the file. See `LIVE_LOOKING` above for what writing one costs.
     */
    const keyShaped: string = `${SECRET_SHAPES[0]!.prefix}${FAKE_TAIL}`;

    // @ts-expect-error a raw string cannot be a PublishedTestValue: the brand is
    // a module-private symbol, so admitPublishedValue is the only source.
    const forged: PublishedTestValue = keyShaped;
    expect(forged).toBeDefined();

    // @ts-expect-error and the same holds through the entry type, which is where
    // it matters: there is no expression that puts a live key into the catalogue.
    const value: CatalogueEntry['value'] = keyShaped;
    expect(value).toBeDefined();
  });

  it('reads nothing from process.env', () => {
    /*
     * Binding rule: a credential belongs on a customer-owned row, never in
     * process.env — and a catalogue that read one would be laundering a secret
     * into a shape that looks published. An absence can only be asserted
     * against the source.
     */
    expect(SOURCE).not.toContain('process.env');
  });

  it('makes no network call', () => {
    // Every PublicationRef says `fetched: false`; this is what makes that
    // claim true rather than aspirational.
    expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(SOURCE).not.toMatch(/from\s*'node:(https?|net|dns)'/);
    expect(SOURCE).not.toMatch(/require\s*\(\s*'node:(https?|net|dns)'/);
  });
});

describe('provenance, which is what makes a wrong value survivable', () => {
  it('gives every entry a publisher, a document and a sourceNote', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      expect(entry.publication.publisher, entry.id).toBe(entry.publisher);
      expect(entry.publication.document.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.sourceNote.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.expected.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.purpose.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('says `fetched: false` on every entry, because nothing was fetched', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      expect(entry.publication.fetched, entry.id).toBe(false);
    }
  });

  it('never marks a recalled entry verified', () => {
    /*
     * The same refusal the keystone put on `testValueEntrySchema`: recall is
     * the weakest evidence in these two files and claiming otherwise is the one
     * dishonesty the catalogue exists to prevent.
     */
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.evidence === 'published-recalled') {
        expect(entry.verified, entry.id).toBe(false);
      }
    }
  });

  it('only claims `computed-here` where arithmetic in this process proves it', () => {
    // Today that is the IBANs and nothing else. A tax id has twenty-seven
    // different per-state checksums and this module implements none of them, so
    // a VAT entry claiming computed-here would be claiming a check that does
    // not exist.
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.evidence === 'computed-here') {
        expect(entry.kind, entry.id).toBe('bank-account');
        expect(ibanChecksumValid(entry.value!.published), entry.id).toBe(true);
      }
    }
  });

  it('uses only the shared evidence vocabulary, so a card and an IBAN compare like with like', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      expect(TEST_VALUE_EVIDENCE, entry.id).toContain(entry.evidence);
    }
  });

  it('gives every entry a unique id, and catalogueHasId agrees', () => {
    const ids = PROVIDER_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(catalogueHasId(id)).toBe(true);
    expect(catalogueHasId('stripe.iban.sepa.failed')).toBe(false);
  });

  it('joins to the test-value catalogue wherever the publisher is a payment provider', () => {
    // The join is what keeps two tables one catalogue: a plan that found a
    // Stripe checkout asks one question and gets cards AND IBANs.
    expect(catalogueEntriesForTestValueProvider('stripe').map((e) => e.id)).toContain(
      'stripe.iban.sepa.success',
    );
    expect(catalogueEntriesForTestValueProvider('paypal').length).toBeGreaterThan(0);
    // And a standards registry is not a payment provider, so it joins to nothing.
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.publisher === 'iban-registry' || entry.publisher === 'ec-vies') {
        expect(entry.linkedTestValueProvider, entry.id).toBeNull();
      }
    }
  });

  it('marks every provider-behaviour entry testModeOnly, and every format-only entry not', () => {
    /*
     * The distinction a production run depends on. An IBAN carried as a FORMAT
     * a validator must accept is safe anywhere; one carried because a sandbox
     * returns a particular outcome for it is a landmine against live keys.
     */
    const byId = new Map(PROVIDER_CATALOGUE.map((e) => [e.id, e]));
    expect(byId.get('stripe.iban.sepa.success')!.testModeOnly).toBe(true);
    expect(byId.get('iban.registry.fr.alphanumeric')!.testModeOnly).toBe(false);
  });
});

describe('assessGate — the answer that replaces "skipped — no test card"', () => {
  it('reports a published value as testable, naming the entries', () => {
    const assessment = assessGate('stripe', 'bank-account');
    expect(assessment.testability).toBe('TESTABLE_WITH_PUBLISHED_VALUE');
    expect(assessment.entries.map((e) => e.id)).toContain('stripe.iban.sepa.success');
    expect(assessment.remedy).toContain('stripe.iban.sepa.success');
  });

  it('reports a credential-gated flow as REQUIRES_PROVISIONED_SANDBOX, not as skipped', () => {
    const assessment = assessGate('paypal', 'requires-provisioning');
    expect(assessment.testability).toBe('REQUIRES_PROVISIONED_SANDBOX');
    // The honest words, verbatim: a flow nobody could drive is not a pass.
    expect(assessment.remedy).toContain('UNEXERCISABLE');
    // And it is the sentence this whole module exists to replace that must not
    // appear. Asserting on the word "skipped" alone was brittle and wrong — the
    // remedy legitimately says "not skipped, and not passed".
    expect(assessment.remedy).not.toContain('no test card');
    // The remedy is one sentence, not the same sentence twice: a plan prints
    // this verbatim.
    expect(assessment.remedy).toBe(assessment.entries[0]!.expected);
  });

  it('distinguishes "we have no entry" from "there is no way"', () => {
    /*
     * NOT_CATALOGUED is a gap in QAAI's own data. Reporting it as untestable
     * would be reporting a limitation of this file as a fact about the
     * customer's application — rule 12's "a REFUSED or UNEXERCISABLE surface
     * recorded the same way as one that does not exist".
     */
    const assessment = assessGate('okta', 'oauth-sandbox-user');
    expect(assessment.testability).toBe('NOT_CATALOGUED');
    expect(assessment.entries).toEqual([]);
    expect(assessment.remedy).toContain('CATALOGUE_OMISSIONS');
    // And the omission is genuinely recorded, so the remedy sends the reader
    // somewhere real.
    expect(CATALOGUE_OMISSIONS.some((o) => o.publisher === 'okta')).toBe(true);
  });

  it('refuses to attempt a bot-gated flow when nobody established the test key', () => {
    /*
     * The default must be the cautious one. An unestablished fact treated as
     * true produces the worst possible outcome: a plan that drives a CAPTCHA
     * gated form, fails, and reports a form defect.
     */
    const unknown = assessGate('cloudflare', 'bot-protection-test-key');
    expect(unknown.testability).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    expect(unknown.remedy).toContain('nobody established');
  });

  it('reports a bot defence with no configured key as unreachable, and offers no workaround', () => {
    const notConfigured = assessGate('cloudflare', 'bot-protection-test-key', {
      botProtectionConfigured: false,
    });
    expect(notConfigured.testability).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    expect(notConfigured.remedy).toContain('will not and cannot work around');
    // The remedy is the CUSTOMER's to apply: setting a key on their own
    // environment is a change to their application, not something a run may do.
    expect(notConfigured.remedy).toContain('CUSTOMER');
  });

  it('flips to testable once the customer has configured the published key', () => {
    const configured = assessGate('cloudflare', 'bot-protection-test-key', {
      botProtectionConfigured: true,
    });
    expect(configured.testability).toBe('TESTABLE_WITH_PUBLISHED_VALUE');
    expect(configured.entries.length).toBeGreaterThan(0);
  });

  it('can reach every testability it declares', () => {
    const reached = new Set([
      assessGate('stripe', 'bank-account').testability,
      assessGate('paypal', 'requires-provisioning').testability,
      assessGate('cloudflare', 'bot-protection-test-key').testability,
      assessGate('okta', 'oauth-sandbox-user').testability,
    ]);
    expect([...reached].sort()).toEqual([...PAYMENT_TESTABILITY_LIST].sort());
  });
});

describe('the confidence report', () => {
  it('leads with what was not fetched and ends with the omissions', () => {
    const described = describeProviderCatalogueConfidence();
    expect(described).toContain('fetched: false');
    expect(described).toContain(String(CATALOGUE_OMISSIONS.length));
    expect(described).toContain('CATALOGUE_OMISSIONS');
  });

  it('counts the no-value entries rather than hiding them', () => {
    // An entry with no value is a gate QAAI cannot pass today. Leaving it out
    // of the report would make the catalogue look more capable than it is.
    const provisioning = catalogueEntriesOfKind('requires-provisioning').length;
    expect(provisioning).toBeGreaterThan(0);
    expect(describeProviderCatalogueConfidence()).toContain(String(provisioning));
  });

  it('gives every omission a publisher and a reason a reader can act on', () => {
    for (const omission of CATALOGUE_OMISSIONS) {
      expect(CATALOGUE_PUBLISHERS).toContain(omission.publisher);
      expect(omission.what.trim().length).toBeGreaterThan(0);
      // Long enough to actually say why. A one-word reason is how an omission
      // becomes indistinguishable from an oversight.
      expect(omission.why.length, omission.what).toBeGreaterThan(60);
    }
  });

  it('names a shape for every secret prefix it refuses', () => {
    for (const shape of SECRET_SHAPES) {
      expect(shape.prefix.length).toBeGreaterThan(2);
      expect(shape.what.trim().length).toBeGreaterThan(0);
    }
    // pk_live_ is deliberately absent: a publishable key ships in the
    // customer's own HTML, and refusing it would make the admission reject the
    // kind of value this catalogue exists to carry.
    expect(SECRET_SHAPES.map((s) => s.prefix)).not.toContain('pk_live_');
  });
});
