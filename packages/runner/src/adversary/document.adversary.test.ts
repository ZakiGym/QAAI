/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it, vi } from 'vitest';
import { documentTestSpecSchema, type RunContext } from '@qaai/shared';
import {
  checkDocumentText,
  runDocumentTest,
  unavailableTextExtractor,
  PLACEHOLDER_PATTERNS,
  type DocumentDeps,
  type DocumentTextExtractor,
} from '../plugins/document.js';

function ctx(): RunContext {
  return {
    baseUrl: 'https://app.example.com',
    signal: new AbortController().signal,
    logger: { step: vi.fn(), log: vi.fn(), finding: vi.fn() },
    determinism: { randomSeed: 3, timezone: 'UTC', locale: 'en-GB' },
  } as unknown as RunContext;
}

const ARTIFACT = {
  source: 'DOWNLOAD' as const,
  path: '/invoices/1/pdf',
  minBytes: 1_000,
  expectText: ['Total', '£42.00'],
  expectPages: 2,
  expectFilename: 'invoice-*.pdf',
  notAsserted: [],
  expectMediaType: undefined,
  maxBytes: undefined,
  expectMagicHex: undefined,
  uploadFixture: undefined,
} as never;

/** Bytes that exist and a parser that cannot read them. */
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe('ADVERSARY — DOCUMENT: unextractable text is UNVERIFIED, never a pass', () => {
  it('produces one UNVERIFIED hole per assertion and not one MET', async () => {
    const checks = await checkDocumentText(ARTIFACT, BYTES, 'application/pdf', unavailableTextExtractor);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    for (const c of checks) {
      expect(c.verdict, c.name).toBe('UNVERIFIED');
      expect(c.verdict).not.toBe('MET');
      expect(c.verdict).not.toBe('UNMET');
    }
    expect(checks.map((c) => c.name).sort()).toEqual(['expectPages', 'expectText', 'placeholders']);
  });

  it('an extractor that THROWS is also UNVERIFIED, not a pass and not a crash', async () => {
    const throwing: DocumentTextExtractor = {
      describe: 'a parser that explodes',
      extract: () => Promise.reject(new Error('segfault in poppler')),
    };
    const checks = await checkDocumentText(ARTIFACT, BYTES, 'application/pdf', throwing);
    for (const c of checks) expect(c.verdict).toBe('UNVERIFIED');
  });

  it('a whole test whose every check is UNVERIFIED is SKIPPED, never PASSED', async () => {
    const spec = documentTestSpecSchema.parse({
      artifacts: [{ source: 'DOWNLOAD', path: '/invoices/1/pdf', minBytes: 1_000, expectText: ['Total'] }],
    });
    const deps: DocumentDeps = {
      browser: {
        visit: () => Promise.reject(new Error('no browser adapter')),
        clickAndCaptureDownload: () => Promise.reject(new Error('no browser adapter')),
        printToPdf: () => Promise.reject(new Error('no browser adapter')),
        printStylesheet: () => Promise.reject(new Error('no browser adapter')),
        setInputFiles: () => Promise.reject(new Error('no browser adapter')),
      } as never,
      mail: { attachmentsFor: () => Promise.resolve(null) } as never,
      extractor: unavailableTextExtractor,
      staging: { stage: () => Promise.reject(new Error('no staging')) } as never,
      upload: { read: () => Promise.reject(new Error('no upload')) } as never,
      stagingDir: '/tmp/none',
    };
    const out = await runDocumentTest(ctx(), { id: 'd1', name: 'invoice', type: 'DOCUMENT', spec: {} } as never, spec, deps);
    expect(out.status).not.toBe('PASSED');
    expect(out.status).toBe('SKIPPED');
    expect(out.notRun).not.toBeNull();
  });
});

describe('ADVERSARY — DOCUMENT: the placeholder detectors genuinely fire', () => {
  const seeded: Array<[string, string]> = [
    ['undefined', 'Invoice for undefined — Total £42.00'],
    ['NaN', 'Amount due: £NaN'],
    ['{{', 'Dear {{customer_name}},'],
    ['Lorem ipsum', 'Lorem ipsum dolor sit amet'],
    ['[object Object]', 'Ship to: [object Object]'],
  ];

  for (const [pattern, text] of seeded) {
    it(`fires on a document containing ${JSON.stringify(pattern)}`, async () => {
      const extractor: DocumentTextExtractor = {
        describe: 'a fixture extractor',
        extract: () => Promise.resolve({ text: `${text}\nTotal\n£42.00`, pageCount: 2 }),
      };
      const checks = await checkDocumentText(ARTIFACT, BYTES, 'application/pdf', extractor);
      const placeholder = checks.find((c) => c.name === 'placeholders');
      expect(placeholder, 'a placeholders check must exist').toBeDefined();
      expect(placeholder?.verdict, pattern).toBe('UNMET');
      // It quotes QAAI's own pattern and NOT the customer's surrounding text.
      expect(placeholder?.detail).toContain(pattern);
    });
  }

  it('does NOT fire on "null", which is a substring of real words', async () => {
    const extractor: DocumentTextExtractor = {
      describe: 'a fixture extractor',
      extract: () =>
        Promise.resolve({ text: 'This contract is annulled. Total £42.00', pageCount: 2 }),
    };
    const checks = await checkDocumentText(
      { ...(ARTIFACT as object), expectText: ['Total'] } as never,
      BYTES,
      'application/pdf',
      extractor,
    );
    const placeholder = checks.find((c) => c.name === 'placeholders');
    expect(placeholder?.verdict).toBe('MET');
    expect(PLACEHOLDER_PATTERNS).not.toContain('null');
  });

  it('a clean document does not have the placeholder check silently skipped', async () => {
    const extractor: DocumentTextExtractor = {
      describe: 'a fixture extractor',
      extract: () => Promise.resolve({ text: 'Total\n£42.00\nThank you', pageCount: 2 }),
    };
    const checks = await checkDocumentText(ARTIFACT, BYTES, 'application/pdf', extractor);
    const placeholder = checks.find((c) => c.name === 'placeholders');
    expect(placeholder?.verdict).toBe('MET');
  });

  it('the placeholder scan is ABSENT, not MET, when nobody asked about the text', async () => {
    // The honest distinction: "we did not look" must not be reported as "clean".
    const noTextWanted = { ...(ARTIFACT as object), expectText: undefined, expectPages: null } as never;
    const checks = await checkDocumentText(noTextWanted, BYTES, 'application/pdf', unavailableTextExtractor);
    expect(checks).toEqual([]);
  });
});
