/**
 * Tests for the DOCUMENT test type.
 *
 * Named by the lie each one prevents. The headline group is
 * "never reports a pass for a document it did not read", because that is the
 * single likeliest defect in a round of new plugins and it is the one a customer
 * cannot detect from the outside.
 *
 * No browser, no filesystem, no parser, no network: the five surfaces are
 * recorders built at the top of this file.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import { documentTestSpecSchema } from '@qaai/shared';
import {
  DOCUMENT_ASSERTIONS,
  DOCUMENT_ASSERTION_LIST,
  FILE_INPUT_SELECTOR,
  PLACEHOLDER_PATTERNS,
  captureDocument,
  checkDocumentText,
  checkPrintStylesheet,
  documentPlugin,
  guardDocumentUrl,
  runDocumentTest,
  setDocumentDeps,
  unavailableDocumentBrowser,
  unavailableStaging,
  unavailableTextExtractor,
  unavailableUpload,
} from './document.js';
import type {
  DocumentBrowserSurface,
  DocumentDeps,
  DocumentTextExtractor,
  MailAttachmentSurface,
  PrintStylesheetReport,
} from './document.js';
import type { DownloadCapture, FileStagingSurface, FileUploadSurface } from '../files.js';

const BASE_URL = 'https://app.example.test';

// ─── Recorders ───────────────────────────────────────────────────────────────

function capture(args: {
  filename?: string;
  mediaType?: string | null;
  bytes?: Uint8Array | null;
}): DownloadCapture {
  return {
    suggestedFilename: args.filename ?? 'invoice-9001.pdf',
    mediaType: args.mediaType === undefined ? 'application/pdf' : args.mediaType,
    readBytes: () =>
      Promise.resolve(
        args.bytes === undefined
          ? new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
          : args.bytes,
      ),
  };
}

function browser(overrides: Partial<DocumentBrowserSurface> = {}): DocumentBrowserSurface {
  return {
    download: () => Promise.resolve(capture({})),
    printToPdf: () => Promise.resolve(capture({})),
    fetchDocument: () => Promise.resolve(capture({})),
    inspectPrintStylesheet: () =>
      Promise.resolve<PrintStylesheetReport>({ hasPrintRules: true, visibleChromeSelectors: [] }),
    ...overrides,
  };
}

function extractor(
  result: { text: string; pageCount: number | null } | null,
): DocumentTextExtractor {
  return {
    describe: 'a recorder',
    extract: () => Promise.resolve(result),
  };
}

const mail: MailAttachmentSurface = { attachment: () => Promise.resolve(capture({})) };

function staging(): FileStagingSurface {
  const files = new Map<string, Uint8Array>();
  return {
    write(filename, bytes) {
      files.set(filename, bytes);
      return Promise.resolve({
        path: `/tmp/doc/${filename}`,
        filename,
        mediaType: 'application/octet-stream',
        byteLength: bytes.length,
      });
    },
    read: (path) => Promise.resolve(files.get(path.replace('/tmp/doc/', '')) ?? null),
  };
}

function upload(): { surface: FileUploadSurface; calls: string[] } {
  const calls: string[] = [];
  return {
    surface: {
      setInputFiles(selector) {
        calls.push(selector);
        return Promise.resolve();
      },
    },
    calls,
  };
}

function deps(overrides: Partial<DocumentDeps> = {}): DocumentDeps {
  return {
    browser: browser(),
    mail,
    extractor: extractor({ text: 'Total 42.00 Invoice 9001', pageCount: 1 }),
    staging: staging(),
    upload: upload().surface,
    stagingDir: '/tmp/doc',
    ...overrides,
  };
}

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: BASE_URL,
    secrets: {},
    storageState: null,
    artifacts: { put: vi.fn() } as unknown as RunContext['artifacts'],
    logger: { step: vi.fn(), log: vi.fn() } as unknown as RunContext['logger'],
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 20261026,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...overrides,
  };
}

function test(spec: unknown): ExecutableTest {
  return { id: 'test_1', name: 'invoice pdf', type: 'DOCUMENT', spec } as unknown as ExecutableTest;
}

/** An artefact with the required fields, parsed so defaults land. */
function artifact(overrides: Record<string, unknown> = {}): ReturnType<
  typeof documentTestSpecSchema.parse
>['artifacts'][number] {
  const parsed = documentTestSpecSchema.parse({
    artifacts: [
      {
        source: 'DOWNLOAD',
        path: '/invoices/9001',
        expectFilename: 'invoice-*.pdf',
        minBytes: 4,
        ...overrides,
      },
    ],
  });
  const first = parsed.artifacts[0];
  if (!first) throw new Error('unreachable: one artefact was parsed');
  return first;
}

function byName(execution: TestExecution): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of execution.steps) {
    const match = /· ([a-zA-Z:]+) —/.exec(step.title);
    if (match?.[1] !== undefined) out.set(match[1], step.status);
  }
  return out;
}

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('the assertion vocabulary carries both halves of its parity guard', () => {
  it('matches its presence record at run time', () => {
    expect([...DOCUMENT_ASSERTION_LIST].sort()).toEqual([...DOCUMENT_ASSERTIONS].sort());
  });

  it('omits `null` from the placeholder patterns on purpose', () => {
    /*
     * The judgement stated as a test. `null` is a legitimate substring of
     * "annulled" and "nullify", and a false positive on a customer's real
     * contract costs more trust than the true positives buy.
     */
    expect(PLACEHOLDER_PATTERNS).not.toContain('null');
    expect(PLACEHOLDER_PATTERNS).toContain('NaN');
    expect(PLACEHOLDER_PATTERNS).toContain('{{');
  });

  it('matches Lorem as a pair rather than as the bare surname', () => {
    expect(PLACEHOLDER_PATTERNS).toContain('Lorem ipsum');
    expect(PLACEHOLDER_PATTERNS).not.toContain('Lorem');
  });
});

// ─── The headline: never a pass for a document it did not read ──────────────

describe('never reports a pass for a document it did not read', () => {
  it('is SKIPPED, not PASSED, when every check was unverified', async () => {
    /*
     * THE LIE THIS WHOLE ROUND IS ABOUT. The capture fails, so nothing about the
     * document is established — and the result must not be a green row. A
     * percentage containing this as a pass is a percentage with a test in it
     * that can never fail.
     */
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'PRINT_TO_PDF',
            path: '/invoices/9001',
            expectFilename: 'invoice-*.pdf',
            minBytes: 1000,
          },
        ],
      }),
      deps({ browser: browser({ printToPdf: () => Promise.resolve(null) }) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.errorMessage).toContain('nothing is');
  });

  it('discloses the holes even on a PASS', async () => {
    /*
     * A pass with a stated hole in it, which is the point. The bytes and the
     * name are asserted; the text is not, because no extractor is configured.
     * The gate can refuse to count this. A silent pass cannot be refused.
     */
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/invoices/9001',
            expectFilename: 'invoice-*.pdf',
            minBytes: 4,
            expectText: ['Total 42.00'],
          },
        ],
      }),
      deps({ extractor: unavailableTextExtractor }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('were NOT verified');
    expect(execution.errorMessage).toContain('CAPABILITY_ABSENT');
  });

  it('says nothing in errorMessage when there is nothing to disclose', async () => {
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({ artifacts: [artifact()] }),
      deps({ extractor: extractor({ text: 'clean', pageCount: 1 }) }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toBeNull();
  });

  it('names every assertion a missing document left unasserted, one by one', async () => {
    /*
     * Without this, a missing capture produces ONE failed row and the four
     * assertions behind it silently do not exist — a shortfall no reader can see.
     */
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/invoices/9001',
            expectFilename: 'invoice-*.pdf',
            expectMediaType: 'application/pdf',
            expectMagicHex: '25504446',
            minBytes: 1000,
            expectPages: 3,
            expectText: ['Total'],
          },
        ],
      }),
      deps({ browser: browser({ download: () => Promise.resolve(null) }) }),
    );
    const statuses = byName(execution);
    expect(statuses.get('produced')).toBe('FAILED');
    for (const name of ['filename', 'mediaType', 'magic', 'size', 'expectPages', 'expectText']) {
      expect(statuses.get(name)).toBe('SKIPPED');
    }
  });

  it('records a declared hole from the spec alongside the ones it found', async () => {
    // A producer that already knows an assertion cannot be made here records it
    // on `notAsserted`; carrying it through is what makes a plan's promise and a
    // run's report the same list.
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/invoices/9001',
            expectFilename: 'invoice-*.pdf',
            minBytes: 4,
            notAsserted: [
              { assertion: 'the digital signature on the contract', reason: 'NOT_IMPLEMENTED' },
            ],
          },
        ],
      }),
      deps(),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('digital signature');
    expect(execution.errorMessage).toContain('NOT_IMPLEMENTED');
  });
});

// ─── The two failure modes that must not be conflated ────────────────────────

describe('keeps the application not producing a document apart from us not asking', () => {
  it('reports no download as NOT_PRODUCED — the application', async () => {
    const outcome = await captureDocument(
      artifact(),
      BASE_URL,
      deps({ browser: browser({ download: () => Promise.resolve(null) }) }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('NOT_PRODUCED');
  });

  it('reports a failed print-to-PDF as UNAVAILABLE and blames the engine, not the app', async () => {
    /*
     * Playwright implements `page.pdf()` on Chromium only. Reporting a null here
     * as NOT_PRODUCED would be QAAI filing a defect against a working print path
     * because the run happened to use webkit — the most expensive kind of wrong
     * this product can be.
     */
    const outcome = await captureDocument(
      artifact({ source: 'PRINT_TO_PDF' }),
      BASE_URL,
      deps({ browser: browser({ printToPdf: () => Promise.resolve(null) }) }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('UNAVAILABLE');
      if (outcome.kind === 'UNAVAILABLE') expect(outcome.reason).toBe('CAPABILITY_ABSENT');
      expect(outcome.why).toContain('Chromium only');
    }
  });

  it('reports an adapter that threw as UNAVAILABLE rather than as a finding', async () => {
    const outcome = await captureDocument(
      artifact(),
      BASE_URL,
      deps({
        browser: browser({ download: () => Promise.reject(new Error('context closed')) }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('UNAVAILABLE');
      expect(outcome.why).toContain('context closed');
    }
  });

  it('uses SURFACE_UNREACHED for the app\'s fault and CAPABILITY_ABSENT for ours', async () => {
    // Two different remedies, so two different reasons on the downstream holes.
    const appsFault = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          { source: 'DOWNLOAD', path: '/x', expectFilename: '*.pdf', minBytes: 10, expectPages: 2 },
        ],
      }),
      deps({ browser: browser({ download: () => Promise.resolve(null) }) }),
    );
    expect(appsFault.steps.some((s) => s.title.includes('SURFACE_UNREACHED'))).toBe(true);

    const ourFault = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'PRINT_TO_PDF',
            path: '/x',
            expectFilename: '*.pdf',
            minBytes: 10,
            expectPages: 2,
          },
        ],
      }),
      deps({ browser: browser({ printToPdf: () => Promise.resolve(null) }) }),
    );
    expect(ourFault.steps.some((s) => s.title.includes('CAPABILITY_ABSENT'))).toBe(true);
  });
});

// ─── The bytes ───────────────────────────────────────────────────────────────

describe('asserts the bytes, not the click', () => {
  it('fails an HTML error page wearing a .pdf name', async () => {
    /*
     * The assertion the whole type exists for. The name matches, the size is
     * plausible, the download event fired, and the leading bytes are `<!DOCTYPE`.
     */
    const html = new TextEncoder().encode('<!DOCTYPE html><title>500 Server Error</title>');
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/invoices/9001',
            expectFilename: 'invoice-*.pdf',
            minBytes: 10,
            expectMagicHex: '25504446',
          },
        ],
      }),
      deps({ browser: browser({ download: () => Promise.resolve(capture({ bytes: html })) }) }),
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('HTML error page');
  });

  it('fails a zero-byte document against its byte floor', async () => {
    const execution = await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [{ source: 'DOWNLOAD', path: '/x', expectFilename: '*.pdf', minBytes: 1 }],
      }),
      deps({
        browser: browser({
          download: () => Promise.resolve(capture({ filename: 'a.pdf', bytes: new Uint8Array(0) })),
        }),
      }),
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('0 bytes');
  });
});

// ─── The text ────────────────────────────────────────────────────────────────

describe('asserts the document text only when it genuinely read it', () => {
  it('reports UNAVAILABLE with an install line when no extractor is configured', async () => {
    const checks = await checkDocumentText(
      artifact({ expectText: ['Total 42.00'], expectPages: 2 }),
      new Uint8Array([0x25, 0x50]),
      'application/pdf',
      unavailableTextExtractor,
    );
    expect(checks.map((c) => c.verdict)).toEqual(['UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED']);
    expect(checks.every((c) => c.reason === 'CAPABILITY_ABSENT')).toBe(true);
    // A refusal that does not say what to install is a wall.
    expect(checks[0]?.detail).toContain('poppler');
  });

  it('names the expectText, expectPages and placeholder holes separately', async () => {
    // Not one merged hole: a reader counting holes needs all three.
    const checks = await checkDocumentText(
      artifact({ expectText: ['Total'], expectPages: 2 }),
      new Uint8Array([1]),
      'application/pdf',
      unavailableTextExtractor,
    );
    expect(checks.map((c) => c.name)).toEqual(['expectText', 'expectPages', 'placeholders']);
  });

  it('catches an invoice total that disagrees with the screen', async () => {
    // The headline invoice bug, and it is invisible to every assertion that does
    // not read the document.
    const checks = await checkDocumentText(
      artifact({ expectText: ['Total 42.00'] }),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: 'Invoice 9001 Total 41.00', pageCount: 1 }),
    );
    const text = checks.find((c) => c.name === 'expectText');
    expect(text?.verdict).toBe('UNMET');
    expect(text?.detail).toContain('Total 42.00');
  });

  it("never quotes the document's own text into a failure", async () => {
    /*
     * A statement or a contract is exactly the kind of document that carries
     * somebody's name, address and account number, and a failure message travels
     * into logs, reports and a Slack channel.
     */
    const checks = await checkDocumentText(
      artifact({ expectText: ['Total 42.00'] }),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: 'Ada Lovelace, 12 Mill Road, acct 0099887766', pageCount: 1 }),
    );
    const text = checks.find((c) => c.name === 'expectText');
    expect(text?.verdict).toBe('UNMET');
    expect(text?.detail).not.toContain('Ada Lovelace');
    expect(text?.detail).not.toContain('0099887766');
  });

  it.each(PLACEHOLDER_PATTERNS)('catches %j reaching the customer', async (pattern) => {
    const checks = await checkDocumentText(
      artifact({ expectText: ['Invoice'] }),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: `Invoice 9001 — amount due ${pattern}`, pageCount: 1 }),
    );
    const placeholders = checks.find((c) => c.name === 'placeholders');
    expect(placeholders?.verdict).toBe('UNMET');
    expect(placeholders?.detail).toContain(pattern);
  });

  it('reports a missing page count as unverified rather than as zero pages', async () => {
    // A null that became a 0 is the archetypal lie in this product. An extractor
    // that read text and no page count has not said the document has no pages.
    const checks = await checkDocumentText(
      artifact({ expectPages: 3 }),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: 'something', pageCount: null }),
    );
    const pages = checks.find((c) => c.name === 'expectPages');
    expect(pages?.verdict).toBe('UNVERIFIED');
    expect(pages?.detail).toContain('was not assumed');
  });

  it('fails a statement that lost a page', async () => {
    const checks = await checkDocumentText(
      artifact({ expectPages: 3 }),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: 'something', pageCount: 2 }),
    );
    expect(checks.find((c) => c.name === 'expectPages')?.verdict).toBe('UNMET');
  });

  it('asserts nothing about text when the spec asked nothing about it', async () => {
    /*
     * And in particular runs NO placeholder scan. Reporting a PASS for "no
     * placeholders" on a document whose text was never read is the
     * "pass that means we did not check" this round is about.
     */
    const checks = await checkDocumentText(
      artifact(),
      new Uint8Array([1]),
      'application/pdf',
      extractor({ text: 'NaN {{ undefined', pageCount: 1 }),
    );
    expect(checks).toEqual([]);
  });

  it('treats an extractor that threw as unverified, not as empty text', async () => {
    const throwing: DocumentTextExtractor = {
      describe: 'a throwing recorder',
      extract: () => Promise.reject(new Error('parser crashed')),
    };
    const checks = await checkDocumentText(
      artifact({ expectText: ['Total'] }),
      new Uint8Array([1]),
      'application/pdf',
      throwing,
    );
    expect(checks.every((c) => c.verdict === 'UNVERIFIED')).toBe(true);
  });
});

// ─── The print stylesheet ────────────────────────────────────────────────────

describe('asserts print-stylesheet correctness, and only where one exists', () => {
  it('fails a document route with no @media print rule at all', async () => {
    // The invoice prints with the navigation, the cookie banner and a "Back to
    // dashboard" button on it.
    const checks = await checkPrintStylesheet(
      artifact({ source: 'PRINT_TO_PDF' }),
      browser({
        inspectPrintStylesheet: () =>
          Promise.resolve({ hasPrintRules: false, visibleChromeSelectors: [] }),
      }),
    );
    expect(checks[0]?.verdict).toBe('UNMET');
    expect(checks[0]?.detail).toContain('@media print');
  });

  it('reports chrome still visible under print emulation', async () => {
    const checks = await checkPrintStylesheet(
      artifact({ source: 'PRINT_TO_PDF' }),
      browser({
        inspectPrintStylesheet: () =>
          Promise.resolve({ hasPrintRules: true, visibleChromeSelectors: ['nav', '#cookie'] }),
      }),
    );
    expect(checks.map((c) => c.verdict)).toEqual(['MET', 'UNMET']);
    expect(checks[1]?.detail).toContain('nav');
  });

  it('asserts nothing about a downloaded PDF, which has no stylesheet', async () => {
    // It was rendered server-side; a verdict about its print stylesheet would be
    // a verdict about a thing that does not exist.
    expect(await checkPrintStylesheet(artifact({ source: 'DOWNLOAD' }), browser())).toEqual([]);
    expect(
      await checkPrintStylesheet(artifact({ source: 'EMAIL_ATTACHMENT' }), browser()),
    ).toEqual([]);
  });

  it('reports an adapter that cannot look as unverified', async () => {
    const checks = await checkPrintStylesheet(
      artifact({ source: 'PRINT_TO_PDF' }),
      browser({ inspectPrintStylesheet: () => Promise.resolve(null) }),
    );
    expect(checks[0]?.verdict).toBe('UNVERIFIED');
    expect(checks[0]?.reason).toBe('CAPABILITY_ABSENT');
  });
});

// ─── Egress ──────────────────────────────────────────────────────────────────

describe('classifies a spec-named host before fetching a document from it', () => {
  it.each([
    'http://127.0.0.1/invoice.pdf',
    'http://localhost/invoice.pdf',
    'http://10.0.0.5/invoice.pdf',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/invoice.pdf',
    'http://0177.0.0.1/invoice.pdf',
  ])('refuses %s with a named reason', (url) => {
    /*
     * Rule 11. `0177.0.0.1` is in the list on purpose: it is the octal form that
     * a naive classifier hands on as a DNS name and some resolvers cheerfully
     * answer with 127.0.0.1. `169.254.169.254` is the cloud metadata endpoint,
     * which is the whole reason this gate exists.
     */
    const verdict = guardDocumentUrl(url, BASE_URL);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why.length).toBeGreaterThan(20);
  });

  it('refuses a file: URL, which would read this worker\'s own disk', () => {
    const verdict = guardDocumentUrl('file:///etc/passwd', BASE_URL);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('file:');
  });

  it("allows a relative path against the environment's own base URL", () => {
    /*
     * NOT re-classified, and deliberately: that host is the environment's, the
     * customer configured it, and a self-hosted install pointed at localhost is
     * the normal case. Refusing it here would break every on-prem deployment.
     */
    const verdict = guardDocumentUrl('/invoices/9001.pdf', 'http://localhost:3000');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url).toBe('http://localhost:3000/invoices/9001.pdf');
  });

  it('allows an absolute public URL', () => {
    const verdict = guardDocumentUrl('https://cdn.example.com/invoice.pdf', BASE_URL);
    expect(verdict.ok).toBe(true);
  });

  it('refuses the fetch rather than performing it, when the host is refused', async () => {
    // The gate must run BEFORE the connection, so the adapter is never called.
    const fetchDocument = vi.fn(() => Promise.resolve(capture({})));
    const outcome = await captureDocument(
      artifact({ source: 'DIRECT_FETCH', path: 'http://169.254.169.254/x' }),
      BASE_URL,
      deps({ browser: browser({ fetchDocument }) }),
    );
    expect(outcome.ok).toBe(false);
    expect(fetchDocument).not.toHaveBeenCalled();
  });
});

// ─── The upload leg ──────────────────────────────────────────────────────────

describe('uploads a fixture through setInputFiles', () => {
  it("uses the customer's own fixture when the run carries it", async () => {
    const recorder = upload();
    const execution = await runDocumentTest(
      ctx({ fixtures: { 'fixtures/rows.csv': 'a,b\n1,2\n' } }),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/import',
            expectFilename: '*.pdf',
            minBytes: 4,
            uploadFixture: 'fixtures/rows.csv',
          },
        ],
      }),
      deps({ upload: recorder.surface }),
    );
    expect(recorder.calls).toEqual([FILE_INPUT_SELECTOR]);
    expect(execution.status).toBe('PASSED');
  });

  it('discloses that it substituted a generated file for a missing fixture', async () => {
    /*
     * Not a silent default. A generated file is not the customer's data: if their
     * handler parses uploads, it may reject it correctly, and a reader needs to
     * know which file the result is about.
     */
    const execution = await runDocumentTest(
      ctx({ fixtures: {} }),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/import',
            expectFilename: '*.pdf',
            minBytes: 4,
            uploadFixture: 'fixtures/absent.csv',
          },
        ],
      }),
      deps(),
    );
    const step = execution.steps.find((s) => s.title.includes('upload'));
    expect(step?.title).toContain('was not in this run');
    expect(step?.title).toContain('a valid file of its type');
  });

  it('reports a staging failure as unverified, not as a broken file input', async () => {
    // A filesystem we could not write to says nothing about the customer's page.
    const execution = await runDocumentTest(
      ctx({ fixtures: { 'fixtures/rows.csv': 'a,b\n' } }),
      test({}),
      documentTestSpecSchema.parse({
        artifacts: [
          {
            source: 'DOWNLOAD',
            path: '/import',
            expectFilename: '*.pdf',
            minBytes: 4,
            uploadFixture: 'fixtures/rows.csv',
          },
        ],
      }),
      deps({ staging: unavailableStaging }),
    );
    const step = execution.steps.find((s) => s.title.includes('uploadFixture'));
    expect(step?.status).toBe('SKIPPED');
    expect(step?.title).toContain('CAPABILITY_ABSENT');
  });

  it('asserts nothing about uploads when the artefact names no fixture', async () => {
    const recorder = upload();
    await runDocumentTest(
      ctx(),
      test({}),
      documentTestSpecSchema.parse({ artifacts: [artifact()] }),
      deps({ upload: recorder.surface }),
    );
    expect(recorder.calls).toEqual([]);
  });
});

// ─── Validate ────────────────────────────────────────────────────────────────

describe('refuses a spec before anything is driven', () => {
  it('names the offending field on an invalid spec', () => {
    expect(() => documentPlugin.validate(test({ artifacts: [] }))).toThrow(
      /invalid spec/,
    );
  });

  it('refuses a byte floor of zero, which asserts nothing', () => {
    // The schema's own rule, asserted here because `validate` is the surface a
    // test author meets.
    expect(() =>
      documentPlugin.validate(
        test({ artifacts: [{ source: 'DOWNLOAD', path: '/x', minBytes: 0, expectFilename: '*' }] }),
      ),
    ).toThrow(/invalid spec/);
  });

  it('refuses two artefacts naming the same source and path', () => {
    /*
     * Two artefacts driving the same route assert the same document twice and
     * report it as two results, which doubles its weight in every count that
     * reads them.
     */
    expect(() =>
      documentPlugin.validate(
        test({
          artifacts: [
            { source: 'DOWNLOAD', path: '/invoices/9001', minBytes: 4, expectFilename: '*.pdf' },
            { source: 'DOWNLOAD', path: '/invoices/9001', minBytes: 9, expectFilename: '*.pdf' },
          ],
        }),
      ),
    ).toThrow(/more than once/);
  });

  it('accepts the same path under two different sources', () => {
    // A download and a print-to-PDF of one route are two different documents.
    expect(() =>
      documentPlugin.validate(
        test({
          artifacts: [
            { source: 'DOWNLOAD', path: '/invoices/9001', minBytes: 4, expectFilename: '*.pdf' },
            { source: 'PRINT_TO_PDF', path: '/invoices/9001', minBytes: 4, expectFilename: '*.pdf' },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// ─── The shipped defaults ────────────────────────────────────────────────────

describe('ships adapters that report rather than fake', () => {
  it('extracts nothing and says so, instead of returning empty text', async () => {
    /*
     * A stub returning `{ text: '', pageCount: 1 }` would make `expectText` fail
     * on every correct document and `placeholders` PASS on every broken one —
     * numbers moving on the strength of a fake.
     */
    expect(await unavailableTextExtractor.extract(new Uint8Array([1]), 'application/pdf')).toBeNull();
  });

  it('rejects rather than silently succeeding, on every unavailable surface', async () => {
    await expect(unavailableStaging.write('x', new Uint8Array([1]))).rejects.toThrow();
    await expect(unavailableUpload.setInputFiles('#x', [])).rejects.toThrow();
    await expect(unavailableDocumentBrowser.download('/x')).rejects.toThrow();
    await expect(unavailableDocumentBrowser.printToPdf('/x')).rejects.toThrow();
    await expect(unavailableDocumentBrowser.fetchDocument('/x')).rejects.toThrow();
    // The one that returns null rather than throwing: "cannot inspect" is an
    // honest UNVERIFIED and not an error.
    expect(await unavailableDocumentBrowser.inspectPrintStylesheet('/x')).toBeNull();
  });

  it('defaults to surfaces that measure nothing, and setDocumentDeps restores', () => {
    const previous = setDocumentDeps(deps());
    expect(previous.extractor).toBe(unavailableTextExtractor);
    const restored = setDocumentDeps(previous);
    expect(restored.extractor).not.toBe(unavailableTextExtractor);
  });
});

// ─── Cancellation ────────────────────────────────────────────────────────────

describe('stops when the run is cancelled', () => {
  it('reports CANCELLED rather than a pass over the artefacts it did reach', async () => {
    // Nobody wanted the answer, so there is no answer — not a partial pass.
    const controller = new AbortController();
    controller.abort();
    const execution = await runDocumentTest(
      ctx({ signal: controller.signal }),
      test({}),
      documentTestSpecSchema.parse({ artifacts: [artifact()] }),
      deps(),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('CANCELLED');
  });
});
