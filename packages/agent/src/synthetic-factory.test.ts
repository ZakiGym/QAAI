/*
 * The localised factory: determinism first, because it is the property the
 * whole file exists for and the one that rots silently.
 *
 * Two tests read this module's own SOURCE off disk. That is the only way to
 * assert an absence — "contains no Math.random" is a claim about code that is
 * not there, and no amount of calling the exports establishes it. A hundred
 * sampled calls could pass against a generator that reseeds itself from the
 * clock once an hour.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORM_FIELD_SEMANTICS, SYNTHETIC_CLOCK } from '@qaai/shared';
import {
  DEFAULT_SYNTHETIC_LOCALE,
  EXTENDED_SEMANTICS,
  EXTENDED_SEMANTIC_LIST,
  LOCALE_SENSITIVE,
  SYNTHETIC_LOCALES,
  SYNTHETIC_LOCALE_LIST,
  SYNTHETIC_SEMANTICS,
  TEXT_LENGTHS,
  TEXT_LENGTH_LIST,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_REASON_LIST,
  auditUniquenessAcrossRuns,
  buildCleanupLedger,
  createLocalisedFactory,
  describeCleanup,
  executeCleanupLedger,
  extendedCleanupFor,
  extendedUniquenessFor,
  localeProfile,
  localisedValue,
  type CleanupExecutor,
  type CleanupOutcome,
  type CleanupStep,
  type LocalisedValue,
  type SyntheticLocale,
  type SyntheticSemantic,
} from './synthetic-factory.js';
import type { CleanupObligation } from '@qaai/shared';

const SOURCE_WITH_COMMENTS = readFileSync(
  fileURLToPath(new URL('./synthetic-factory.ts', import.meta.url)),
  'utf8',
);

/** Comments blanked, so prose naming `Math.random` is not read as a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    );
}

const SOURCE = stripComments(SOURCE_WITH_COMMENTS);

const SEED = 'run-7f3a9c';

function allValues(seed: string, locale: SyntheticLocale): LocalisedValue[] {
  return SYNTHETIC_SEMANTICS.map((semantic) =>
    localisedValue(semantic, 0, { seed, scope: 'journey/checkout', locale, now: SYNTHETIC_CLOCK }),
  );
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

describe('vocabulary parity', () => {
  it('derives every list from its presence record, in declaration order', () => {
    expect(EXTENDED_SEMANTIC_LIST).toEqual([...EXTENDED_SEMANTICS]);
    expect(SYNTHETIC_LOCALE_LIST).toEqual([...SYNTHETIC_LOCALES]);
    expect(TEXT_LENGTH_LIST).toEqual([...TEXT_LENGTHS]);
    expect(UNAVAILABLE_REASON_LIST).toEqual([...UNAVAILABLE_REASONS]);
  });

  it('covers the crawler vocabulary plus the three it names, with no overlap', () => {
    // The union must not silently shadow a FormFieldSemantic: if `flow-map.ts`
    // ever adds `company`, this test goes red and the down-map in BASE_SEMANTIC
    // becomes wrong rather than redundant.
    for (const semantic of FORM_FIELD_SEMANTICS) {
      expect(SYNTHETIC_SEMANTICS).toContain(semantic);
      expect(EXTENDED_SEMANTIC_LIST).not.toContain(semantic as never);
    }
    expect(SYNTHETIC_SEMANTICS.length).toBe(FORM_FIELD_SEMANTICS.length + EXTENDED_SEMANTICS.length);
    expect(new Set(SYNTHETIC_SEMANTICS).size).toBe(SYNTHETIC_SEMANTICS.length);
  });

  it('answers uniqueness and cleanup for every semantic, including the extended three', () => {
    // Total lookups. The failure a partial one produces is a new semantic
    // defaulting to REUSABLE, and REUSABLE is the answer that collides.
    for (const semantic of SYNTHETIC_SEMANTICS) {
      expect(extendedUniquenessFor(semantic)).toBeTruthy();
      expect(extendedCleanupFor(semantic)).toBeTruthy();
    }
  });

  it('gives every locale-sensitive semantic a generation arm', () => {
    /*
     * THE TABLE AND THE SWITCH MUST AGREE. `LOCALE_SENSITIVE` says a semantic
     * is generated here; the switch is where it actually is. A semantic marked
     * true with no arm falls to the default and comes back unavailable with
     * NO_LOCALE_FORM — a field QAAI silently stops filling. This is the test
     * that catches the disagreement.
     */
    for (const semantic of SYNTHETIC_SEMANTICS) {
      if (!LOCALE_SENSITIVE[semantic]) continue;
      for (const locale of SYNTHETIC_LOCALES) {
        const produced = localisedValue(semantic, 0, {
          seed: SEED,
          scope: '',
          locale,
          now: SYNTHETIC_CLOCK,
        });
        if (!produced.available) {
          // The ONE legitimate unavailable case is a missing reserved phone
          // range. Anything else is a gap between the table and the switch.
          expect(`${semantic}/${locale}: ${produced.reason}`).toBe(
            `${semantic}/${locale}: NO_RESERVED_RANGE`,
          );
        }
      }
    }
  });

  it('marks every extended semantic locale-sensitive, which is what keeps the cast out', () => {
    // The delegation branch narrows with `!isExtended`, so an extended semantic
    // marked false would be recorded NO_LOCALE_FORM instead of delegated. That
    // is honest but useless, so the table is pinned here.
    for (const semantic of EXTENDED_SEMANTIC_LIST) {
      expect(LOCALE_SENSITIVE[semantic], semantic).toBe(true);
    }
  });
});

// ─── Determinism: the point of the file ──────────────────────────────────────

describe('determinism', () => {
  it('is byte-identical for the same seed, across every semantic and every locale', () => {
    /*
     * THE HEADLINE PROPERTY. A generator that is not reproducible produces a
     * suite nobody can debug, and it is the commonest cause of the flake this
     * product exists to eliminate. 22 semantics x 6 locales, twice, deep-equal.
     */
    for (const locale of SYNTHETIC_LOCALES) {
      expect(allValues(SEED, locale)).toEqual(allValues(SEED, locale));
    }
  });

  it('is stable within a run, so two steps of one journey agree', () => {
    const factory = createLocalisedFactory({ seed: SEED, scope: 'signup' });
    const stepOne = factory.value('email');
    const stepTwo = factory.value('email');
    expect(stepOne).toEqual(stepTwo);
    // And a second factory built from the same inputs agrees with the first,
    // which is what lets the login step be written in a different file from the
    // signup step.
    expect(createLocalisedFactory({ seed: SEED, scope: 'signup' }).value('email')).toEqual(stepOne);
  });

  it('separates two values of the same semantic by index', () => {
    const factory = createLocalisedFactory({ seed: SEED });
    // "Invite two members" needs two emails, and the whole uniqueness
    // apparatus is worthless if they are the same one.
    const first = factory.value('email', 0);
    const second = factory.value('email', 1);
    expect(first.available && second.available && first.value).not.toBe(
      second.available ? second.value : null,
    );
  });

  it('separates two scopes, so two tests in one run do not race', () => {
    const run = createLocalisedFactory({ seed: SEED });
    const a = run.scoped('test-a').value('email');
    const b = run.scoped('test-b').value('email');
    expect(a.available && b.available && a.value === b.value).toBe(false);
  });

  it('separates two locales, so a locale sweep does not collide with itself', () => {
    const factory = createLocalisedFactory({ seed: SEED, scope: 'sweep' });
    const us = factory.inLocale('en-US').value('email');
    const de = factory.inLocale('de-DE').value('email');
    expect(us.available && de.available && us.value === de.value).toBe(false);
  });

  it('separates two locales that SHARE a word pool, which isolates the key itself', () => {
    /*
     * WHY THIS IS A SEPARATE TEST, found by mutation rather than by review.
     *
     * The test above uses `email`, which is DELEGATED to the shared factory —
     * and the delegation passes the locale inside `scope`. So removing the
     * locale from `keyFor` entirely left that test green: it was proving the
     * delegation path and nothing about the key. Every other locale-sensitive
     * semantic differs anyway because the word pools differ, which hides the
     * same hole.
     *
     * `en-US` and `en-GB` share one `words` pool byte for byte, so `freeform`
     * under those two locales is the ONE case where the locale component of the
     * key is the only thing that can separate the values. Two locale cells that
     * generate the same value make a collision between them look like a product
     * bug, and the `key` is what a ledger and a report identify a step by — two
     * values under one key are indistinguishable in both.
     */
    const factory = createLocalisedFactory({ seed: SEED, scope: 'sweep' });
    const us = factory.inLocale('en-US').value('freeform');
    const gb = factory.inLocale('en-GB').value('freeform');
    expect(us.available && gb.available && us.value === gb.value).toBe(false);
    // And the identity carries the locale, so the two are distinguishable in a
    // ledger even where the values coincide.
    expect(us.key).not.toBe(gb.key);
    expect(us.key).toContain('en-US');
    expect(gb.key).toContain('en-GB');
  });

  it('CONTAINS NO AMBIENT SOURCE OF NON-DETERMINISM', () => {
    /*
     * Rule 10, asserted against the source because that is the only place it
     * can be. `new Date(now)` IS allowed and present — `now` is an injected
     * argument; `new Date()` with no argument is not, and neither is a clock
     * or a PRNG this module reaches for itself.
     */
    expect(SOURCE).not.toContain('Math.random');
    expect(SOURCE).not.toContain('Date.now');
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toContain('performance.now');
    expect(SOURCE).not.toContain('crypto.randomUUID');
  });

  it('derives dates from UTC parts, so the host timezone cannot change a value', () => {
    // getMonth() reads the host zone: the same seed would produce a different
    // date in Auckland than in London, which is an ambient clock arriving by
    // the back door.
    expect(SOURCE).not.toMatch(/\.getMonth\(\)/);
    expect(SOURCE).not.toMatch(/\.getDate\(\)/);
    expect(SOURCE).not.toMatch(/\.getFullYear\(\)/);
  });

  it('takes its I/O as an injected interface: no browser, no network', () => {
    expect(SOURCE).not.toContain('playwright');
    expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(SOURCE).not.toContain('node:fs');
    expect(SOURCE).not.toContain('process.env');
  });
});

// ─── Locale ──────────────────────────────────────────────────────────────────

describe('locale, where the real defects are', () => {
  function valueOf(semantic: SyntheticSemantic, locale: SyntheticLocale): string {
    const produced = localisedValue(semantic, 0, {
      seed: SEED,
      scope: '',
      locale,
      now: SYNTHETIC_CLOCK,
    });
    if (!produced.available) throw new Error(`${semantic}/${locale} was unavailable`);
    return produced.value;
  }

  it('uses a decimal COMMA where the locale does', () => {
    // `1234,56` through parseFloat silently becomes 1234, and a billing form
    // that loses the cents is a money defect. This is the single highest-value
    // row in the locale table.
    for (const locale of ['de-DE', 'fr-FR'] as const) {
      expect(valueOf('number', locale), locale).toMatch(/,\d{2}$/);
      expect(valueOf('currency', locale), locale).toContain(',');
    }
    for (const locale of ['en-US', 'en-GB'] as const) {
      expect(valueOf('number', locale), locale).toMatch(/\.\d{2}$/);
    }
  });

  it('produces an ALPHANUMERIC UK postcode and a hyphenated Japanese one', () => {
    // A postcode field validated /^\d{5}$/ rejects every UK and Japanese
    // address, and no en-US run can find that.
    expect(valueOf('postal_code', 'en-GB')).toMatch(/^[A-Z]{2}\d \d[A-Z]{2}$/);
    expect(valueOf('postal_code', 'ja-JP')).toMatch(/^\d{3}-\d{4}$/);
    expect(valueOf('postal_code', 'en-US')).toMatch(/^\d{5}$/);
  });

  it('writes the family name first in ja-JP and not elsewhere', () => {
    const japanese = valueOf('person_name', 'ja-JP');
    // The family-name pool is kanji and the given-name pool is katakana, so the
    // ORDER is observable: kanji first means family first.
    expect(japanese).toMatch(/^[一-鿿]/);
    expect(localeProfile('ja-JP').rtl).toBe(false);
  });

  it('puts a space before the percent sign in fr-FR only', () => {
    // French typography requires it and /^\d+%$/ rejects it.
    // `\u00a0` rather than the character itself: a literal NO-BREAK SPACE inside a
    // regex is invisible in every diff and every review, and `no-irregular-whitespace`
    // flags it for that reason. The escape is the same code point and says which one it is.
    expect(valueOf('percentage', 'fr-FR')).toMatch(/\u00a0%$/);
    expect(valueOf('percentage', 'en-US')).toMatch(/\d%$/);
    expect(valueOf('percentage', 'en-US')).not.toContain(' ');
  });

  it('writes a 12-hour clock with a meridiem where the locale does', () => {
    expect(valueOf('time', 'en-US')).toMatch(/^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/);
    expect(valueOf('time', 'de-DE')).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    // Never "0:30 AM" or "13:00 PM": the two values an `hour % 12` renderer
    // gets wrong are exactly why a time is generated rather than hardcoded.
    for (const locale of SYNTHETIC_LOCALES) {
      const written = valueOf('time', locale);
      if (written.includes('M')) expect(written).not.toMatch(/^0:/);
    }
  });

  it('writes the date in the order the locale writes it', () => {
    // 03/04 is two different days in two of these locales, and a suite that
    // only runs one never finds out.
    expect(valueOf('date', 'de-DE')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(valueOf('date', 'ja-JP')).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    expect(valueOf('date', 'en-US')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('flags ar-EG as RTL, because the page re-lays-out rather than swapping strings', () => {
    expect(localeProfile('ar-EG').rtl).toBe(true);
    expect(valueOf('person_name', 'ar-EG')).toMatch(/[؀-ۿ]/);
    for (const locale of SYNTHETIC_LOCALES) {
      if (locale !== 'ar-EG') expect(localeProfile(locale).rtl, locale).toBe(false);
    }
  });

  it('localises a company name, including the Japanese prefix form', () => {
    expect(valueOf('company', 'de-DE')).toMatch(/(GmbH|AG)/);
    expect(valueOf('company', 'en-GB')).toMatch(/(Ltd|PLC)/);
    // 株式会社ミナト, not ミナト株式会社.
    expect(valueOf('company', 'ja-JP')).toMatch(/^(株式会社|合同会社)/);
  });

  it('defaults to the locale the shared factory implicitly generates', () => {
    expect(DEFAULT_SYNTHETIC_LOCALE).toBe('en-US');
    expect(createLocalisedFactory({ seed: SEED }).locale).toBe('en-US');
  });
});

describe('the phone refusal, which is what makes the locale table honest', () => {
  it('REFUSES to invent a number for a locale with no reserved range', () => {
    /*
     * Rule 12: UNAVAILABLE, never a fabricated value. An invented German
     * mobile number may well be somebody's, and if a test ever actually sends
     * to it, it rings a stranger's phone. So there is no value and the reason
     * travels in its place.
     */
    for (const locale of ['de-DE', 'fr-FR', 'ja-JP', 'ar-EG'] as const) {
      const produced = localisedValue('phone', 0, {
        seed: SEED,
        scope: '',
        locale,
        now: SYNTHETIC_CLOCK,
      });
      expect(produced.available, locale).toBe(false);
      if (produced.available) continue;
      expect(produced.reason).toBe('NO_RESERVED_RANGE');
      // A refusal with no remedy is a dead end. This one names two.
      expect(produced.detail).toContain('AuthProfile');
      expect(produced.detail).toContain('en-US');
      expect(localeProfile(locale).hasReservedPhoneRange).toBe(false);
    }
  });

  it('generates ONLY from inside the published reserved range where one exists', () => {
    /*
     * The other half, and the one that would be easy to get wrong: a locale
     * that CAN produce a phone number must produce one from the regulator's
     * reserved block, not merely one that looks local. 555-01XX is a NANPA
     * allocation; 07700 900xxx is Ofcom's drama range.
     */
    for (let index = 0; index < 40; index++) {
      const us = localisedValue('phone', index, {
        seed: SEED,
        scope: '',
        locale: 'en-US',
        now: SYNTHETIC_CLOCK,
      });
      const gb = localisedValue('phone', index, {
        seed: SEED,
        scope: '',
        locale: 'en-GB',
        now: SYNTHETIC_CLOCK,
      });
      expect(us.available && /^\+1 555 555 01\d{2}$/.test(us.value), `us#${index}`).toBe(true);
      expect(gb.available && /^\+44 7700 900\d{3}$/.test(gb.value), `gb#${index}`).toBe(true);
    }
    expect(localeProfile('en-US').hasReservedPhoneRange).toBe(true);
    expect(localeProfile('en-GB').hasReservedPhoneRange).toBe(true);
  });

  it('refuses a date rather than inventing one when the injected clock is unparseable', () => {
    // No ambient clock to fall back on, deliberately — so an unusable `now` is
    // reported, not silently replaced with today.
    const produced = localisedValue('date', 0, {
      seed: SEED,
      scope: '',
      locale: 'en-US',
      now: 'not-an-instant',
    });
    expect(produced.available).toBe(false);
    if (produced.available) return;
    expect(produced.reason).toBe('NO_LOCALE_FORM');
    expect(produced.detail).toContain('ambient clock');
  });
});

// ─── Free text ───────────────────────────────────────────────────────────────

describe('free text at several lengths', () => {
  it('grows monotonically up the ladder', () => {
    // Every free-text field in the suite currently gets one word, so a
    // textarea's wrapping, a byte-counted maxlength and a truncating renderer
    // are all unreachable.
    const factory = createLocalisedFactory({ seed: SEED });
    const lengths = TEXT_LENGTHS.map((rung) => {
      const produced = factory.text(rung);
      if (!produced.available) throw new Error(`${rung} was unavailable`);
      return produced.value.length;
    });
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]!, TEXT_LENGTHS[i]).toBeGreaterThan(lengths[i - 1]!);
    }
  });

  it('uses the locale own script, so a byte-counted maxlength is reachable', () => {
    const japanese = createLocalisedFactory({ seed: SEED, locale: 'ja-JP' }).text('sentence');
    const arabic = createLocalisedFactory({ seed: SEED, locale: 'ar-EG' }).text('sentence');
    expect(japanese.available && /[぀-ヿ一-鿿]/.test(japanese.value)).toBe(true);
    expect(arabic.available && /[؀-ۿ]/.test(arabic.value)).toBe(true);
  });

  it('has real word boundaries, not a repeated character', () => {
    // A validator that strips whitespace, or a renderer that cannot wrap, is
    // only reachable with spaces in the string.
    const paragraph = createLocalisedFactory({ seed: SEED }).text('paragraph');
    expect(paragraph.available && paragraph.value).toContain(' ');
  });

  it('is deterministic per rung and per index', () => {
    const factory = createLocalisedFactory({ seed: SEED });
    expect(factory.text('paragraph')).toEqual(factory.text('paragraph'));
    const a = factory.text('short', 0);
    const b = factory.text('short', 1);
    expect(a.available && b.available && a.value === b.value).toBe(false);
  });
});

// ─── Uniqueness, checked rather than declared ────────────────────────────────

describe('uniqueness across runs', () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => `nightly-${i}`);

  it('NEVER repeats a globally-unique value across 60 runs', () => {
    /*
     * THE TEST THE REGISTER ASKED FOR. A factory that produces a colliding
     * email on the second run is the single commonest cause of the flake this
     * product exists to eliminate: the signup hits a unique constraint, the
     * failure reads as an application bug, somebody spends a morning on it and
     * then deletes the test.
     */
    const audit = auditUniquenessAcrossRuns(
      [{ semantic: 'email' }, { semantic: 'username' }],
      SEEDS,
    );
    expect(audit.collisions).toEqual([]);
    for (const finding of audit.findings) {
      expect(finding.distinct, finding.semantic).toBe(SEEDS.length);
    }
  });

  it('holds for the SECOND run specifically, which is the one that breaks', () => {
    const first = createLocalisedFactory({ seed: 'run-1', scope: 'signup' }).value('email');
    const second = createLocalisedFactory({ seed: 'run-2', scope: 'signup' }).value('email');
    expect(first.available && second.available && first.value === second.value).toBe(false);
  });

  it('DISCLOSES what it did not establish', () => {
    /*
     * An audit that reports zero collisions and no caveat reads as a proof of
     * global uniqueness, which a 32-bit hash cannot give. Rule 12: a cap that
     * bit is reported as a count AND a reason.
     */
    const audit = auditUniquenessAcrossRuns([{ semantic: 'email' }], SEEDS);
    expect(audit.seedsCompared).toBe(SEEDS.length);
    expect(audit.caveat).toContain('32-bit');
    expect(audit.caveat).toContain(String(SEEDS.length));
    expect(audit.caveat).toContain('not that no two seeds ever can');
  });

  it('does not count an unavailable value as a collision', () => {
    /*
     * A German phone number is refused, so there is no value to collide.
     * Counting the refusals as identical would turn an honest refusal into a
     * reported defect — a REFUSED surface recorded the same way as a broken one.
     */
    const audit = auditUniquenessAcrossRuns([{ semantic: 'phone' }], SEEDS, { locale: 'de-DE' });
    expect(audit.collisions).toEqual([]);
    expect(audit.findings[0]!.distinct).toBe(0);
    /*
     * And it says so EXPLICITLY rather than leaving `distinct: 0` to be
     * interpreted. A genuine total collision is `distinct: 1`, so the two are
     * distinguishable — but only by a reader who already knows the invariant,
     * and a report should not depend on that.
     */
    expect(audit.findings[0]!.unavailable).toBe(SEEDS.length);
  });

  it('keeps the accounting invariant: distinct never exceeds the seeds that produced a value', () => {
    /*
     * The guard on the collision denominator. It compares against
     * `seeds - unavailable`, because comparing against `seeds` reports a
     * collision that did not happen whenever SOME seeds refuse — an honest
     * refusal re-reported as a defect.
     *
     * No GLOBALLY_UNIQUE semantic can currently be unavailable, so the partial
     * case is latent and cannot be constructed through the public API today.
     * The invariant is asserted across every semantic anyway, so the arithmetic
     * is pinned before the first semantic that makes it live arrives.
     */
    const audit = auditUniquenessAcrossRuns(
      SYNTHETIC_SEMANTICS.map((semantic) => ({ semantic })),
      SEEDS,
      { locale: 'de-DE' },
    );
    for (const finding of audit.findings) {
      expect(finding.distinct, finding.semantic).toBeLessThanOrEqual(
        finding.seeds - finding.unavailable,
      );
      expect(finding.unavailable, finding.semantic).toBeLessThanOrEqual(finding.seeds);
    }
    expect(audit.collisions).toEqual([]);
  });

  it('reports a reusable value repeating as no collision at all', () => {
    // A city name is REUSABLE: nothing keys on it, and making it unique would
    // churn values for no benefit. It is allowed to repeat.
    const audit = auditUniquenessAcrossRuns([{ semantic: 'city' }], SEEDS);
    expect(audit.collisions).toEqual([]);
    expect(audit.findings[0]!.required).toBe('REUSABLE');
  });
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** A hand-built value, for the cases the generator cannot be made to produce. */
function value(over: Partial<LocalisedValue> & { semantic: SyntheticSemantic }): LocalisedValue {
  return {
    locale: 'en-US',
    key: `k:${over.semantic}`,
    uniqueness: 'GLOBALLY_UNIQUE',
    cleanup: 'DELETE_ENTITY',
    available: true,
    value: `v:${over.semantic}`,
    token: 'abc123',
    ...over,
  } as LocalisedValue;
}

describe('the cleanup ledger', () => {
  it('orders revoke before delete before release', () => {
    /*
     * LOAD-BEARING. A live session re-creates rows behind a delete, and a
     * unique index still holds an identifier until the owning row is gone — so
     * releasing first simply fails and leaves exactly the orphaned identifiers
     * that make the NEXT run collide.
     */
    const ledger = buildCleanupLedger([
      value({ semantic: 'phone', cleanup: 'RELEASE_IDENTIFIER', key: 'k:3' }),
      value({ semantic: 'email', cleanup: 'DELETE_ENTITY', key: 'k:2' }),
      value({ semantic: 'username', cleanup: 'REVOKE_CREDENTIAL', key: 'k:1' }),
    ]);
    expect(ledger.steps.map((s) => s.obligation)).toEqual([
      'REVOKE_CREDENTIAL',
      'DELETE_ENTITY',
      'RELEASE_IDENTIFIER',
    ]);
    expect(ledger.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('is deterministic: the same values give the same ledger in the same order', () => {
    const values = [
      value({ semantic: 'email', key: 'k:b' }),
      value({ semantic: 'username', key: 'k:a' }),
    ];
    expect(buildCleanupLedger(values)).toEqual(buildCleanupLedger(values));
    // Sorted by key within an obligation, so an input reorder does not reorder
    // the plan — a cleanup plan that reshuffles between runs is one nobody can diff.
    expect(buildCleanupLedger(values).steps.map((s) => s.key)).toEqual(['k:a', 'k:b']);
    expect(buildCleanupLedger([...values].reverse()).steps.map((s) => s.key)).toEqual([
      'k:a',
      'k:b',
    ]);
  });

  it('records an UNKNOWN obligation as unresolved and NEVER as nothing-to-do', () => {
    /*
     * The quiet false statement this prevents: reporting UNKNOWN as NONE is a
     * claim that nothing was created, and that claim is what fills a customer's
     * database until they turn the suite off.
     */
    const ledger = buildCleanupLedger([value({ semantic: 'email', cleanup: 'UNKNOWN' })]);
    expect(ledger.unresolved).toHaveLength(1);
    expect(ledger.nothingToDo).toBe(0);
    expect(ledger.steps).toEqual([]);
    expect(ledger.unresolved[0]!.detail).toContain('withCleanup');
  });

  it('NEVER WRITES A CREDENTIAL INTO THE LEDGER', () => {
    /*
     * BINDING. A ledger is written to a report and often committed, so it is
     * exactly the artefact "never log, echo, return or embed a password" has to
     * hold for. `cleanupFor('password')` is already NONE, so this is the belt
     * to that braces: if the shared lookup ever changes, the step is REFUSED
     * and recorded as refused rather than written out.
     */
    const secret = 'Corr3ct-H0rse-Battery';
    const ledger = buildCleanupLedger([
      value({ semantic: 'password', cleanup: 'REVOKE_CREDENTIAL', value: secret }),
      value({ semantic: 'credit_card', cleanup: 'DELETE_ENTITY', value: '4242424242424242' }),
      value({ semantic: 'card_cvc', cleanup: 'DELETE_ENTITY', value: '123' }),
    ]);
    expect(ledger.steps).toEqual([]);
    expect(ledger.refused).toHaveLength(3);
    for (const refusal of ledger.refused) expect(refusal.reason).toBe('CREDENTIAL_SHAPED');
    // The whole serialised ledger, because a value can leak through any field.
    const serialised = JSON.stringify(ledger);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('4242424242424242');
  });

  it('records an unavailable value as refused rather than dropping it', () => {
    // Dropping it would make the counts stop summing, and a count that does not
    // sum is how a suppressed failure hides.
    const ledger = buildCleanupLedger([
      {
        semantic: 'phone',
        locale: 'de-DE',
        key: 'k:phone',
        uniqueness: 'UNIQUE_PER_RUN',
        cleanup: 'DELETE_ENTITY',
        available: false,
        reason: 'NO_RESERVED_RANGE',
        detail: 'no reserved range',
      },
    ]);
    expect(ledger.refused).toHaveLength(1);
    expect(ledger.refused[0]!.reason).toBe('NO_VALUE_GENERATED');
    expect(ledger.steps).toEqual([]);
  });

  it('accounts for every value it considered: the parts sum to the whole', () => {
    /*
     * The accounting invariant. Every value lands in exactly one of four
     * buckets, so a value that quietly vanished — the shape of a suppressed
     * failure — makes this test red.
     */
    const values = [
      ...allValues(SEED, 'en-US'),
      ...allValues(SEED, 'de-DE'),
      value({ semantic: 'email', cleanup: 'UNKNOWN', key: 'k:u' }),
      value({ semantic: 'password', cleanup: 'REVOKE_CREDENTIAL', key: 'k:p' }),
    ];
    const ledger = buildCleanupLedger(values);
    expect(
      ledger.steps.length + ledger.refused.length + ledger.unresolved.length + ledger.nothingToDo,
    ).toBe(ledger.considered);
    expect(ledger.considered).toBe(values.length);
  });

  it('turns a real generated signup into a ledger with real steps', () => {
    // End to end against the generator rather than hand-built values: an email
    // and a username are UNKNOWN out of the generator (it sees a field, never a
    // submission), and a scenario that submitted resolves them.
    const factory = createLocalisedFactory({ seed: SEED, scope: 'signup' });
    const generated = [factory.value('email'), factory.value('username')];
    const resolved = generated.map((v) => ({ ...v, cleanup: 'DELETE_ENTITY' }) as LocalisedValue);
    const ledger = buildCleanupLedger(resolved);
    expect(ledger.steps).toHaveLength(2);
    for (const step of ledger.steps) {
      expect(step.identifier.length).toBeGreaterThan(0);
      // Attribution: a stray staging row traces back to a run without guessing.
      expect(step.runToken.length).toBe(6);
    }
  });
});

describe('executing the ledger', () => {
  function fake(
    outcomes: Record<string, CleanupOutcome | 'THROW'>,
  ): CleanupExecutor & { seen: CleanupStep[] } {
    const seen: CleanupStep[] = [];
    return {
      seen,
      async perform(step) {
        seen.push(step);
        const outcome = outcomes[step.key] ?? 'DELETED';
        if (outcome === 'THROW') throw new Error('connection reset');
        return { outcome, detail: outcome === 'FAILED' ? 'row is locked' : undefined };
      },
    };
  }

  const threeSteps = () =>
    buildCleanupLedger([
      value({ semantic: 'username', cleanup: 'REVOKE_CREDENTIAL', key: 'k:1' }),
      value({ semantic: 'email', cleanup: 'DELETE_ENTITY', key: 'k:2' }),
      value({ semantic: 'phone', cleanup: 'RELEASE_IDENTIFIER', key: 'k:3' }),
    ]);

  it('DOES NOT STOP at the first failure', async () => {
    /*
     * A cleanup that aborts on the first error leaves every later row behind —
     * and the later rows carry the unique identifiers the next run needs, so
     * aborting converts one failure into a permanent collision.
     */
    const executor = fake({ 'k:1': 'FAILED' });
    const report = await executeCleanupLedger(threeSteps(), executor);
    expect(executor.seen).toHaveLength(3);
    expect(report.failed).toBe(1);
    expect(report.deleted).toBe(2);
    expect(report.complete).toBe(false);
  });

  it('treats a throwing executor as a failed step, not as the end of the run', async () => {
    const executor = fake({ 'k:2': 'THROW' });
    const report = await executeCleanupLedger(threeSteps(), executor);
    expect(executor.seen).toHaveLength(3);
    expect(report.failed).toBe(1);
    expect(report.failures[0]!.detail).toContain('connection reset');
  });

  it('counts every failure and suppresses none', async () => {
    // Rule 12: a failure suppressed without being counted.
    const executor = fake({ 'k:1': 'FAILED', 'k:2': 'THROW', 'k:3': 'FAILED' });
    const report = await executeCleanupLedger(threeSteps(), executor);
    expect(report.failed).toBe(3);
    expect(report.failures).toHaveLength(3);
    for (const failure of report.failures) expect(failure.detail.length).toBeGreaterThan(0);
  });

  it('counts an already-absent row as a success, because cleanup is idempotent', async () => {
    // The second cleanup of the same run must not report failures: a ledger
    // that cannot be re-run is a ledger nobody dares re-run.
    const report = await executeCleanupLedger(
      threeSteps(),
      fake({ 'k:1': 'ALREADY_ABSENT', 'k:2': 'ALREADY_ABSENT', 'k:3': 'ALREADY_ABSENT' }),
    );
    expect(report.alreadyAbsent).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.complete).toBe(true);
  });

  it('IS NOT COMPLETE when an obligation was never resolved, even with zero failures', async () => {
    /*
     * The "pass that means we did not check". An unresolved obligation means
     * rows MAY have been left behind, so a run carrying one is not complete
     * however many steps succeeded.
     */
    const ledger = buildCleanupLedger([
      value({ semantic: 'email', cleanup: 'DELETE_ENTITY', key: 'k:1' }),
      value({ semantic: 'username', cleanup: 'UNKNOWN', key: 'k:2' }),
    ]);
    const report = await executeCleanupLedger(ledger, fake({}));
    expect(report.failed).toBe(0);
    expect(report.unresolved).toBe(1);
    expect(report.complete).toBe(false);
  });

  it('carries the ledger refusals into the report rather than losing them', async () => {
    const ledger = buildCleanupLedger([
      value({ semantic: 'password', cleanup: 'REVOKE_CREDENTIAL', key: 'k:p' }),
    ]);
    const report = await executeCleanupLedger(ledger, fake({}));
    expect(report.refused).toBe(1);
  });

  it('describes a run leading with what was NOT done', async () => {
    const ledger = buildCleanupLedger([
      value({ semantic: 'email', cleanup: 'DELETE_ENTITY', key: 'k:1' }),
      value({ semantic: 'username', cleanup: 'UNKNOWN', key: 'k:2' }),
    ]);
    const described = describeCleanup(
      await executeCleanupLedger(ledger, fake({ 'k:1': 'FAILED' })),
    );
    expect(described).toContain('FAILED');
    expect(described).toContain('still there');
    expect(described).toContain('not reported complete');
  });

  it('never puts a credential in the describe output either', async () => {
    const secret = 'Tr0ub4dor-&3';
    const ledger = buildCleanupLedger([
      value({ semantic: 'password', cleanup: 'REVOKE_CREDENTIAL', value: secret, key: 'k:p' }),
    ]);
    const report = await executeCleanupLedger(ledger, fake({}));
    expect(describeCleanup(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

/*
 * ── AN OBLIGATION THE LEDGER CANNOT ORDER IS REFUSED, NOT EMITTED ───────────
 *
 * `buildCleanupLedger` excluded the two non-actions by comparing against the
 * literals 'NONE' and 'UNKNOWN', and TypeScript narrowed the rest to the three
 * executable members — correct for the five obligations that exist, and
 * silently wrong the day a sixth is added. A new member passes both literal
 * checks, lands in `pending`, and is sorted by `OBLIGATION_ORDER[newMember]`,
 * which is `undefined`: `undefined - number` is `NaN`, and a comparator that
 * returns `NaN` leaves the order UNSPECIFIED. That is exactly the failure this
 * function's own doc comment warns about — "a cleanup plan that reorders
 * between runs is a plan nobody can diff" — arriving by the one route nothing
 * checked.
 *
 * The compiler cannot reach this: `CleanupObligation` comes from
 * @qaai/shared, so the sixth member arrives as a valid value of a widened
 * union, not as a type error here. Hence a run-time guard and this test.
 */
describe('an obligation outside the executable three', () => {
  const sixth = 'ARCHIVE_SNAPSHOT' as CleanupObligation;

  it('is refused and RECORDED, never emitted as a step', () => {
    const ledger = buildCleanupLedger([value({ semantic: 'email', cleanup: sixth })]);
    expect(ledger.steps).toEqual([]);
    expect(ledger.refused).toHaveLength(1);
    expect(ledger.refused[0]!.reason).toBe('NOT_EXECUTABLE');
    expect(ledger.refused[0]!.detail).toContain('ARCHIVE_SNAPSHOT');
  });

  it('is not counted as nothing-to-do, which would claim nothing was created', () => {
    const ledger = buildCleanupLedger([value({ semantic: 'email', cleanup: sixth })]);
    expect(ledger.nothingToDo).toBe(0);
    expect(ledger.unresolved).toEqual([]);
  });

  /*
   * The counts have to keep summing: every value considered lands in exactly
   * one of steps / refused / unresolved / nothingToDo. A silently dropped
   * obligation is how a ledger stops accounting for the run.
   */
  it('keeps the ledger accounting for every value it was given', () => {
    const ledger = buildCleanupLedger([
      value({ semantic: 'email', cleanup: sixth, key: 'k:1' }),
      value({ semantic: 'username', cleanup: 'DELETE_ENTITY', key: 'k:2' }),
      value({ semantic: 'city', cleanup: 'NONE', key: 'k:3' }),
      value({ semantic: 'phone', cleanup: 'UNKNOWN', key: 'k:4' }),
    ]);
    expect(
      ledger.steps.length + ledger.refused.length + ledger.unresolved.length + ledger.nothingToDo,
    ).toBe(4);
  });

  it('still orders the executable three, so the guard did not change the happy path', () => {
    const ledger = buildCleanupLedger([
      value({ semantic: 'phone', cleanup: 'RELEASE_IDENTIFIER', key: 'k:3' }),
      value({ semantic: 'email', cleanup: 'DELETE_ENTITY', key: 'k:2' }),
      value({ semantic: 'username', cleanup: 'REVOKE_CREDENTIAL', key: 'k:1' }),
    ]);
    expect(ledger.steps.map((st) => st.order)).toEqual([1, 2, 3]);
    expect(ledger.refused).toEqual([]);
  });
});
