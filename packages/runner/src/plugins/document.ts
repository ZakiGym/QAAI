/**
 * The DOCUMENT test type (§4) — a produced file: an invoice, a statement, a
 * shipping label, a signed contract, an export.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * No plugin in this runner called `page.pdf()` and nothing anywhere asserted a
 * produced document. So the artefacts a business is LEGALLY JUDGED ON were
 * untested: an invoice with the wrong total, a statement that lost a page, a
 * label with no address on it, a contract rendering `{{customer_name}}` to the
 * person signing it. The product's only assertion about any of them was that the
 * button could be clicked.
 *
 * And a click is the one thing that is almost never broken. The failures are
 * downstream of it, and every single one of them passed:
 *
 *   · A handler that errors server-side and returns a 0-byte file, or an HTML
 *     error page carrying a `.pdf` name and a 200. The download event fires, the
 *     name matches, the click "worked".
 *   · A total on the document that disagrees with the total on the screen. This
 *     is THE invoice bug, and it is invisible to every assertion that does not
 *     read the document.
 *   · Placeholder text reaching a customer: `Lorem ipsum`, `undefined`, `NaN`,
 *     an unrendered `{{ }}` tag. Each one is a template that was shipped
 *     half-wired, and each one is a screenshot a customer puts on social media.
 *   · A print stylesheet nobody wrote, so the invoice prints with the navigation
 *     bar, the cookie banner and a "Back to dashboard" button on it.
 *
 * ── WHAT IS ASSERTED, AND WHAT IS HONESTLY NOT ──────────────────────────────
 *
 * Five assertions, in {@link DOCUMENT_ASSERTIONS}, and the split between them is
 * the whole design. Four need only the BYTES and are available on any image:
 * produced-at-all, the name and media type, the size floor, the magic number.
 * The fifth — anything about the document's TEXT — needs a parser this image
 * does not carry, so {@link DocumentTextExtractor} is INJECTED and its absence
 * is reported `UNAVAILABLE` with `CAPABILITY_ABSENT` and an install line.
 *
 * It is never guessed at. Scanning a PDF's raw bytes for "Total: 42.00" finds it
 * only when the content stream happens to be uncompressed, so such a check
 * passes on some PDFs and fails on others for reasons that have nothing to do
 * with the document being right. A green row produced that way is worse than no
 * row. See `checkContent` in ../files.ts, which refuses the same thing for the
 * same reason.
 *
 * ── A PASS WITH A STATED HOLE IN IT ─────────────────────────────────────────
 *
 * Every assertion that could not be made is recorded by name with an
 * `UnassertedReason`, and the execution's `errorMessage` carries the disclosure
 * even when the status is PASSED. That is the keystone's `notAsserted` discipline
 * applied here: a pass with a non-empty hole list is a pass the gate can refuse
 * to count, and a pass with nothing recorded is the lie. When NOTHING could be
 * asserted the result is SKIPPED, never PASSED — see {@link runDocumentTest}.
 *
 * ── INJECTED SURFACES (rule 8) ──────────────────────────────────────────────
 *
 * Nothing here imports playwright, spawns a process or opens a socket. The
 * browser (download, print-to-PDF, print-stylesheet inspection), the document
 * fetch, the mail sink, the staging filesystem and the text extractor are five
 * narrow interfaces. The whole decision table is tested against recorders.
 */

import { z } from 'zod';
import type { ExecutableTest, RunContext, StepResult, TestExecution } from '@qaai/shared';
import { documentTestSpecSchema } from '@qaai/shared';
/*
 * The SUBPATH import and not the barrel, matching ../contract-broker.ts. It is
 * deliberate on both sides: private-address.ts reaches for `node:dns`, and the
 * barrel is what the web app's bundler eats — so pulling this module through
 * `@qaai/shared` would 500 every page that reads a value from the package. The
 * same reasoning preflight.ts states at its own `await import` of this module.
 */
import { classifyHost } from '@qaai/shared/private-address';
import {
  acceptanceIsMeaningful,
  checkDownload,
  decodeUtf8,
  discloseHoles,
  errorText,
  generateFixture,
  met,
  namedFixture,
  readCapture,
  stageFixture,
  summariseChecks,
  unmet,
  unverified,
  uploadStaged,
} from '../files.js';
import type {
  DownloadCapture,
  FileCheck,
  FileStagingSurface,
  FileUploadSurface,
  UnassertedReasonValue,
} from '../files.js';

export type DocumentTestSpec = z.infer<typeof documentTestSpecSchema>;
type DocumentArtifact = DocumentTestSpec['artifacts'][number];

// ─── The assertion axis ─────────────────────────────────────────────────────

/**
 * The five things worth asserting about a produced document.
 *
 * A member rather than a boolean field for each, for the reason the PWA checks
 * are members: `PRODUCED` passing while `TEXT_FIELDS` is unavailable is a real
 * and common state, and one status per artefact could not express it.
 */
export const DOCUMENT_ASSERTIONS = [
  /** It exists at all, with a name and a non-trivial size. */
  'PRODUCED',
  /** The name, the media type and the leading bytes agree with the expectation. */
  'IDENTITY',
  /** The page count, for a multi-page document. Needs a parser. */
  'PAGE_COUNT',
  /** Named fields appear with the right VALUES. Needs a parser. */
  'TEXT_FIELDS',
  /** No `Lorem`, `undefined`, `NaN` or `{{` reached the customer. Needs a parser. */
  'NO_PLACEHOLDERS',
] as const;
export type DocumentAssertion = (typeof DOCUMENT_ASSERTIONS)[number];

export const DOCUMENT_ASSERTION_PRESENT: Record<DocumentAssertion, true> = {
  PRODUCED: true,
  IDENTITY: true,
  PAGE_COUNT: true,
  TEXT_FIELDS: true,
  NO_PLACEHOLDERS: true,
};

export const DOCUMENT_ASSERTION_LIST = Object.keys(
  DOCUMENT_ASSERTION_PRESENT,
) as ReadonlyArray<DocumentAssertion>;

export const DOCUMENT_ASSERTION_LABELS: Record<DocumentAssertion, string> = {
  PRODUCED: 'The document was produced',
  IDENTITY: 'Its name, type and leading bytes are right',
  PAGE_COUNT: 'It has the expected number of pages',
  TEXT_FIELDS: 'The expected fields appear with the right values',
  NO_PLACEHOLDERS: 'No placeholder text reached the customer',
};

/**
 * PLACEHOLDER TEXT, AND WHY THE LIST IS SHORT ON PURPOSE.
 *
 * Each entry is a string that cannot plausibly be intended on an invoice, a
 * statement, a label or a contract, and each one is a specific failure:
 *
 *   `Lorem ipsum`  design copy that was never replaced. Matched as the PAIR and
 *                  not as the bare word `Lorem`, which is a surname.
 *   `undefined`    a JavaScript value rendered as text. The signature of a
 *                  template field wired to a key that does not exist.
 *   `NaN`          arithmetic on a missing number. On an invoice this is the
 *                  total, and it is the worst one on the list.
 *   `{{`           an unrendered template tag — Handlebars, Jinja, Liquid, Vue.
 *   `[object Object]`  an object interpolated into a string.
 *   `null`         is NOT on this list. It is a legitimate substring of
 *                  "annulled", "nullify" and several surnames, and a false
 *                  positive on a customer's real contract costs more trust than
 *                  the true positives buy.
 *
 * The list is NOT configurable, because the spec is `.strict()` and adding an
 * allowlist field is an edit to packages/shared/src/schemas.ts, which this change
 * does not own. It is named in the handover rather than worked around here — a
 * plugin-local override would be a second vocabulary for a spec field.
 */
export const PLACEHOLDER_PATTERNS: readonly string[] = [
  'Lorem ipsum',
  'undefined',
  'NaN',
  '{{',
  '[object Object]',
];

// ─── The injected surfaces ──────────────────────────────────────────────────

/**
 * A document's text layer, as this plugin needs it.
 *
 * THE ONE GENUINELY EXTERNAL CAPABILITY. Extracting text from a PDF needs a
 * parser, the image has none, and the DOCUMENT declaration in
 * packages/shared/src/test-type-decl.ts marks `pdftotext` SPEC-scoped for exactly
 * this. The interface is here so the plugin's logic is complete and testable, and
 * `unavailableTextExtractor` below is what the product actually ships until an
 * adapter is configured.
 *
 * `null` from `extract` means COULD NOT EXTRACT. It never means "the document has
 * no text", which is a different fact about a different document.
 */
export interface DocumentTextExtractor {
  /** A sentence naming the implementation, for the UNAVAILABLE message. */
  readonly describe: string;
  extract(
    bytes: Uint8Array,
    mediaType: string | null,
  ): Promise<{ readonly text: string; readonly pageCount: number | null } | null>;
}

/** A print stylesheet, as the browser reports it. */
export interface PrintStylesheetReport {
  /** Does the document declare any `@media print` rule at all? */
  readonly hasPrintRules: boolean;
  /**
   * Elements still visible under print emulation that almost certainly should
   * not be: the navigation, a cookie banner, a floating action button.
   *
   * Selectors the ADAPTER found, treated as data. This plugin does not decide
   * what a navigation is; it reports what it was handed.
   */
  readonly visibleChromeSelectors: readonly string[];
}

/**
 * The browser, as this plugin needs it. Four methods, one per document source
 * plus the print inspection.
 *
 * Narrow on purpose and nothing like a `Page`: each method is satisfiable in a
 * handful of lines against a real Playwright context, and the logic above is
 * tested with no browser at all.
 */
export interface DocumentBrowserSurface {
  /** Navigate to `path` and capture the download it produces. */
  download(path: string): Promise<DownloadCapture | null>;
  /**
   * `page.pdf()` — print-to-PDF of the rendered page, under print emulation.
   *
   * The call that appears nowhere in this runner today. `null` means the engine
   * could not do it, which is the honest answer for firefox and webkit:
   * Playwright implements `page.pdf()` on Chromium only.
   */
  printToPdf(path: string): Promise<DownloadCapture | null>;
  /** A direct GET of a document URL with the session's own cookies. */
  fetchDocument(url: string): Promise<DownloadCapture | null>;
  /** Inspect the print stylesheet of `path`. `null` when the adapter cannot. */
  inspectPrintStylesheet(path: string): Promise<PrintStylesheetReport | null>;
}

/**
 * An outbound email's attachment, read back from a mail sink.
 *
 * Separate from the browser surface because it is a different transport on a
 * different host — the same mail catcher `plugins/email-otp.ts` reaches, which is
 * named by the test and lives on the tenant's network.
 */
export interface MailAttachmentSurface {
  /** `null` means no matching message or no attachment on it. */
  attachment(args: { readonly path: string }): Promise<DownloadCapture | null>;
}

/** Everything `runDocumentTest` needs from the outside world. */
export interface DocumentDeps {
  browser: DocumentBrowserSurface;
  mail: MailAttachmentSurface;
  extractor: DocumentTextExtractor;
  staging: FileStagingSurface;
  upload: FileUploadSurface;
  /** Where an upload fixture is staged. Supplied by the worker per run. */
  stagingDir: string;
}

// ─── Capture ────────────────────────────────────────────────────────────────

export type CaptureOutcome =
  | { readonly ok: true; readonly capture: DownloadCapture }
  /** UNMET: the application did not produce the document. */
  | { readonly ok: false; readonly kind: 'NOT_PRODUCED'; readonly why: string }
  /** UNVERIFIED: we could not ask. Never scored against the application. */
  | {
      readonly ok: false;
      readonly kind: 'UNAVAILABLE';
      readonly reason: UnassertedReasonValue;
      readonly why: string;
    };

/**
 * Get the document, by whichever of the four routes the artefact names.
 *
 * ── THE TWO FAILURE MODES THAT MUST NOT BE CONFLATED ────────────────────────
 *
 * `NOT_PRODUCED` is the application's fault: the click produced no download, the
 * URL returned nothing, the mail had no attachment. That is the finding.
 * `UNAVAILABLE` is ours: this engine cannot print to PDF, no mail sink is
 * configured, the host was refused. Reporting the second as the first is QAAI
 * filing a defect against a working application, which is the most expensive
 * kind of wrong this product can be.
 */
export async function captureDocument(
  artifact: DocumentArtifact,
  baseUrl: string,
  deps: DocumentDeps,
): Promise<CaptureOutcome> {
  try {
    switch (artifact.source) {
      case 'DOWNLOAD': {
        const capture = await deps.browser.download(artifact.path);
        return capture === null
          ? {
              ok: false,
              kind: 'NOT_PRODUCED',
              why: `no download was produced by "${artifact.path}"`,
            }
          : { ok: true, capture };
      }
      case 'PRINT_TO_PDF': {
        const capture = await deps.browser.printToPdf(artifact.path);
        return capture === null
          ? {
              ok: false,
              kind: 'UNAVAILABLE',
              /*
               * UNAVAILABLE and not NOT_PRODUCED. Playwright implements
               * `page.pdf()` on Chromium only, so a null here on firefox or
               * webkit is an engine limitation and says nothing whatever about
               * the customer's print path.
               */
              reason: 'CAPABILITY_ABSENT',
              why:
                `print-to-PDF of "${artifact.path}" produced nothing. page.pdf() is implemented ` +
                'on Chromium only, so this is an engine limitation rather than a result about ' +
                'your application. Nothing is asserted',
            }
          : { ok: true, capture };
      }
      case 'DIRECT_FETCH': {
        const guard = guardDocumentUrl(artifact.path, baseUrl);
        if (!guard.ok) {
          return { ok: false, kind: 'UNAVAILABLE', reason: guard.reason, why: guard.why };
        }
        const capture = await deps.browser.fetchDocument(guard.url);
        return capture === null
          ? { ok: false, kind: 'NOT_PRODUCED', why: `GET ${guard.url} returned no document` }
          : { ok: true, capture };
      }
      case 'EMAIL_ATTACHMENT': {
        const capture = await deps.mail.attachment({ path: artifact.path });
        return capture === null
          ? {
              ok: false,
              kind: 'NOT_PRODUCED',
              why: `no attachment was found for "${artifact.path}" in the mail sink`,
            }
          : { ok: true, capture };
      }
    }
  } catch (err) {
    /*
     * An adapter that threw told us nothing about the application. This is the
     * branch that, written the other way, turns every transport hiccup in the
     * product into a defect report about a customer's invoice.
     */
    return {
      ok: false,
      kind: 'UNAVAILABLE',
      reason: 'CAPABILITY_ABSENT',
      why: `the ${artifact.source} adapter failed: ${errorText(err)}. Nothing is asserted`,
    };
  }
}

/**
 * Classify a document URL's host before connecting (rule 11).
 *
 * A `DIRECT_FETCH` path may be an absolute URL, and an absolute URL is a host
 * the SPEC named rather than the environment's own. So it goes through
 * `classifyHost` from packages/shared/src/private-address.ts first, and a
 * loopback, private or link-local target is refused with a named reason — the
 * same gate `EGRESS_NEEDS.CUSTOMER_NAMED_HOST` exists to require.
 *
 * A RELATIVE path is resolved against the environment's own base URL and is not
 * re-classified: that host is the environment's, the customer configured it, and
 * a self-hosted install pointed at `localhost` is the normal case rather than an
 * attack. Refusing it here would break every on-prem deployment.
 */
export function guardDocumentUrl(
  path: string,
  baseUrl: string,
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: UnassertedReasonValue; readonly why: string } {
  let resolved: URL;
  try {
    resolved = new URL(path, baseUrl);
  } catch {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why: `"${path}" is not a URL and could not be resolved against the environment's base URL`,
    };
  }

  // Relative paths land on the environment's own host; see the note above.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
  if (!isAbsolute) return { ok: true, url: resolved.toString() };

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why:
        `"${resolved.protocol}" is not a scheme this plugin fetches. A document is fetched over ` +
        'http or https; file: would read this worker\'s own disk',
    };
  }

  const verdict = classifyHost(resolved.hostname);
  if (verdict.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why: `the host "${resolved.hostname}" could not be classified (${verdict.why}), so it was not fetched`,
    };
  }
  if (verdict.kind === 'address' && verdict.class !== 'public') {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why:
        `"${resolved.hostname}" is a ${verdict.class} address, which this plugin refuses to fetch ` +
        'from a spec-supplied URL. Point the artefact at a relative path to use the ' +
        "environment's own host instead",
    };
  }
  if (verdict.kind === 'name' && verdict.internal) {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why:
        `"${resolved.hostname}" is an internal name, which this plugin refuses to fetch from a ` +
        'spec-supplied URL. Use a relative path for the environment\'s own host',
    };
  }
  return { ok: true, url: resolved.toString() };
}

// ─── The text assertions ────────────────────────────────────────────────────

/**
 * Assert the document's text: the expected fields, the page count, and the
 * absence of placeholders.
 *
 * ── TEXT IS DATA (rule 11) ──────────────────────────────────────────────────
 *
 * The extracted text is the customer's own invoice, statement or contract. It is
 * searched and it is NEVER interpreted as an instruction, and it is never echoed
 * into a step title or an error message — a statement is exactly the kind of
 * document that carries somebody's name, address and account number, and a
 * failure message travels into logs, reports and a Slack channel.
 *
 * The one exception is deliberate and narrow: a placeholder finding quotes the
 * PATTERN it matched (`NaN`, `{{`), which is QAAI's own string, never the
 * surrounding text.
 */
export async function checkDocumentText(
  artifact: DocumentArtifact,
  bytes: Uint8Array,
  mediaType: string | null,
  extractor: DocumentTextExtractor,
): Promise<FileCheck[]> {
  const wantsText = artifact.expectText !== undefined && artifact.expectText.length > 0;
  const wantsPages = artifact.expectPages !== null;
  if (!wantsText && !wantsPages) {
    /*
     * NO PLACEHOLDER CHECK EITHER, and this is a judgement worth stating. The
     * placeholder scan is only as good as the extraction, so running it on a
     * document whose text nobody asked about would mean extracting every
     * document on the chance of finding `NaN` — and reporting a PASS for
     * "no placeholders" on an artefact whose text was never read is the
     * "pass that means we did not check" this round is about.
     */
    return [];
  }

  let extracted: Awaited<ReturnType<DocumentTextExtractor['extract']>>;
  try {
    extracted = await extractor.extract(bytes, mediaType);
  } catch (err) {
    extracted = null;
    void err;
  }

  if (extracted === null) {
    /*
     * The parser is absent or could not read this document. One UNVERIFIED check
     * PER ASSERTION rather than one merged hole: a reader counting holes must
     * know that the field values AND the page count AND the placeholder scan
     * each went unasserted.
     */
    const why =
      `the document's text could not be extracted (${extractor.describe}), so nothing about its ` +
      'content is asserted. Install a PDF text extractor — `brew install poppler` or ' +
      '`apt-get install poppler-utils` — to assert the values on your invoices';
    const holes: FileCheck[] = [];
    if (wantsText) holes.push(unverified('expectText', why, 'CAPABILITY_ABSENT'));
    if (wantsPages) holes.push(unverified('expectPages', why, 'CAPABILITY_ABSENT'));
    holes.push(unverified('placeholders', why, 'CAPABILITY_ABSENT'));
    return holes;
  }

  const checks: FileCheck[] = [];
  const text = extracted.text;

  if (wantsText) {
    const expected = artifact.expectText ?? [];
    const missing = expected.filter((needle) => !text.includes(needle));
    checks.push(
      missing.length === 0
        ? met('expectText', `all ${expected.length} expected value(s) appear in the document`)
        : unmet(
            'expectText',
            `${missing.length} of ${expected.length} expected value(s) are absent from the ` +
              `document: ${missing.map((m) => JSON.stringify(m)).join(', ')}. An invoice total ` +
              "that disagrees with the screen is this type's headline bug. The document's own " +
              "text is not quoted here — it is the customer's data",
          ),
    );
  }

  if (wantsPages) {
    const want = artifact.expectPages;
    if (extracted.pageCount === null) {
      checks.push(
        unverified(
          'expectPages',
          `the extractor read the text and reported no page count, so the expected ${want} ` +
            'page(s) were NOT asserted. A page count of 0 was not assumed',
          'CAPABILITY_ABSENT',
        ),
      );
    } else {
      checks.push(
        extracted.pageCount === want
          ? met('expectPages', `${extracted.pageCount} page(s), as expected`)
          : unmet(
              'expectPages',
              `expected ${want} page(s) and the document has ${extracted.pageCount}`,
            ),
      );
    }
  }

  const found = PLACEHOLDER_PATTERNS.filter((pattern) => text.includes(pattern));
  checks.push(
    found.length === 0
      ? met('placeholders', `none of the ${PLACEHOLDER_PATTERNS.length} placeholder patterns appear`)
      : unmet(
          'placeholders',
          `placeholder text reached the document: ${found.map((f) => JSON.stringify(f)).join(', ')}. ` +
            'This is a template that was shipped half-wired, and it is on a document a customer ' +
            'reads',
        ),
  );

  return checks;
}

/**
 * Assert the print stylesheet, for a print-to-PDF artefact.
 *
 * Only for `PRINT_TO_PDF`: a downloaded PDF was rendered server-side and has no
 * stylesheet to be right or wrong about, so running this on one would be
 * reporting a verdict about a thing that does not exist.
 *
 * A document route with NO `@media print` rule at all is a real defect — the
 * invoice prints with the navigation, the cookie banner and a "Back to
 * dashboard" button on it — and it is reported UNMET. The adapter being unable
 * to look is UNVERIFIED.
 */
export async function checkPrintStylesheet(
  artifact: DocumentArtifact,
  browser: DocumentBrowserSurface,
): Promise<FileCheck[]> {
  if (artifact.source !== 'PRINT_TO_PDF') return [];

  let report: PrintStylesheetReport | null;
  try {
    report = await browser.inspectPrintStylesheet(artifact.path);
  } catch (err) {
    return [
      unverified(
        'printStylesheet',
        `the print stylesheet could not be inspected: ${errorText(err)}`,
        'CAPABILITY_ABSENT',
      ),
    ];
  }
  if (report === null) {
    return [
      unverified(
        'printStylesheet',
        'this browser adapter cannot inspect stylesheets, so print-stylesheet correctness was ' +
          'NOT asserted',
        'CAPABILITY_ABSENT',
      ),
    ];
  }

  const checks: FileCheck[] = [];
  checks.push(
    report.hasPrintRules
      ? met('printStylesheet', 'the page declares at least one @media print rule')
      : unmet(
          'printStylesheet',
          `"${artifact.path}" produces a document and declares no @media print rule at all, so ` +
            'it prints with the application chrome on it — navigation, banners and buttons on a ' +
            'page a customer files',
        ),
  );
  if (report.visibleChromeSelectors.length > 0) {
    checks.push(
      unmet(
        'printChrome',
        `${report.visibleChromeSelectors.length} application-chrome element(s) are still visible ` +
          `under print emulation: ${report.visibleChromeSelectors.join(', ')}`,
      ),
    );
  }
  return checks;
}

// ─── The upload leg ─────────────────────────────────────────────────────────

/**
 * Upload the artefact's fixture, when it names one.
 *
 * `uploadFixture` on the spec is a FIXTURE KEY and never a path off this
 * machine, which the schema's own comment says and this honours: it resolves
 * through `RunContext.fixtures` only. A spec-supplied absolute path would be a
 * file-read primitive aimed at the worker's own disk.
 *
 * When the key is absent from the run's fixtures, this falls back to a GENERATED
 * fixture of the same name — and says so in the step, because a generated file is
 * not the customer's data and an application that parses its uploads may
 * legitimately reject it. See `acceptanceIsMeaningful` in ../files.ts.
 */
export async function uploadArtifactFixture(
  artifact: DocumentArtifact,
  deps: DocumentDeps,
  ctx: RunContext,
): Promise<FileCheck[]> {
  const key = artifact.uploadFixture;
  if (key === undefined) return [];

  const basename = key.split('/').pop() ?? key;
  let outcome = namedFixture(key, basename, 'application/octet-stream', ctx.fixtures);
  let substituted = false;
  if (!outcome.ok && outcome.reason === 'REQUIRES_PROVISIONED_SANDBOX') {
    outcome = generateFixture(
      {
        kind: 'GENERATED',
        basename,
        mediaType: 'text/csv',
        byteLength: 256,
      },
      ctx.determinism.randomSeed,
    );
    substituted = true;
  }
  if (!outcome.ok) {
    return [unverified('uploadFixture', outcome.why, outcome.reason)];
  }

  const staged = await stageFixture(outcome.fixture, deps.stagingDir, deps.staging);
  if (!staged.ok) {
    return [unverified('uploadFixture', staged.why, staged.reason)];
  }

  const check = await uploadStaged(staged.staged, FILE_INPUT_SELECTOR, deps.upload);
  if (!substituted || check.verdict !== 'MET') return [check];

  /*
   * The substitution is DISCLOSED rather than being a silent default. A
   * generated fixture is not the customer's data: if their handler parses
   * uploads, it may reject this correctly, and a reader needs to know which file
   * the result is about.
   */
  return [
    met(
      check.name,
      `${check.detail} — NOTE: fixture "${key}" was not in this run's workspace, so a generated ` +
        `file was used instead (${outcome.fixture.provenance}). It is ` +
        `${acceptanceIsMeaningful(outcome.fixture) ? 'a valid file of its type' : 'NOT a parseable file of its type'}`,
    ),
  ];
}

/**
 * The selector an artefact's upload is set on.
 *
 * A constant because the spec has nowhere to carry one: `documentArtifactSchema`
 * is `.strict()` and has `uploadFixture` but no `uploadSelector`. The first file
 * input on the page is the right default for the invoice/import flows this type
 * is for, and a per-artefact selector is a one-field edit to
 * packages/shared/src/schemas.ts named in the handover — not invented here,
 * where it would be a second vocabulary for a spec field.
 */
export const FILE_INPUT_SELECTOR = 'input[type="file"]';

// ─── One artefact ───────────────────────────────────────────────────────────

export interface ArtifactResult {
  readonly artifact: DocumentArtifact;
  readonly checks: readonly FileCheck[];
}

/** Drive one artefact end to end: upload, capture, identity, bytes, text, print. */
export async function runArtifact(
  artifact: DocumentArtifact,
  ctx: RunContext,
  deps: DocumentDeps,
): Promise<ArtifactResult> {
  const checks: FileCheck[] = [];

  checks.push(...(await uploadArtifactFixture(artifact, deps, ctx)));

  const captured = await captureDocument(artifact, ctx.baseUrl, deps);
  if (!captured.ok) {
    checks.push(
      captured.kind === 'NOT_PRODUCED'
        ? unmet('produced', captured.why)
        : unverified('produced', captured.why, captured.reason),
    );
    /*
     * No document means every downstream assertion is unasserted rather than
     * failed, and each is named. Without this a missing capture would produce
     * ONE row and the four assertions behind it would silently not exist — the
     * shortfall a reader cannot see.
     */
    checks.push(...unassertedWithoutDocument(artifact, captured.kind === 'NOT_PRODUCED'));
    return { artifact, checks };
  }

  checks.push(met('produced', `the document was produced by "${artifact.path}"`));

  /*
   * The byte-level assertions come from ../files.ts rather than being
   * reimplemented: the filename glob, the media type, the size range and the
   * magic number are the same assertions a DOWNLOAD step makes, and two copies
   * is how one of them comes to be the weaker one.
   */
  checks.push(
    ...(await checkDownload(captured.capture, {
      ...(artifact.expectFilename !== undefined
        ? { filenamePattern: artifact.expectFilename }
        : {}),
      ...(artifact.expectMediaType !== undefined ? { mediaType: artifact.expectMediaType } : {}),
      minBytes: artifact.minBytes,
      ...(artifact.maxBytes !== undefined ? { maxBytes: artifact.maxBytes } : {}),
      ...(artifact.expectMagicHex !== undefined ? { magicHex: artifact.expectMagicHex } : {}),
    })),
  );

  const read = await readCapture(captured.capture);
  if (!read.ok) {
    checks.push(...unassertedTextChecks(artifact, read.why, read.reason));
  } else {
    checks.push(
      ...(await checkDocumentText(artifact, read.bytes, captured.capture.mediaType, deps.extractor)),
    );
  }

  checks.push(...(await checkPrintStylesheet(artifact, deps.browser)));

  return { artifact, checks };
}

/** Name every assertion that a missing document left unasserted. */
function unassertedWithoutDocument(
  artifact: DocumentArtifact,
  applicationsFault: boolean,
): FileCheck[] {
  /*
   * When the application did not produce the document, the downstream
   * assertions are `SURFACE_UNREACHED` — the thing they needed never existed.
   * When WE could not capture it, they are `CAPABILITY_ABSENT`. Two different
   * remedies, so two different reasons.
   */
  const reason: UnassertedReasonValue = applicationsFault
    ? 'SURFACE_UNREACHED'
    : 'CAPABILITY_ABSENT';
  const why = 'there is no document, so nothing about its bytes or content is asserted';
  const holes: FileCheck[] = [];
  if (artifact.expectFilename !== undefined) holes.push(unverified('filename', why, reason));
  if (artifact.expectMediaType !== undefined) holes.push(unverified('mediaType', why, reason));
  holes.push(unverified('size', why, reason));
  if (artifact.expectMagicHex !== undefined) holes.push(unverified('magic', why, reason));
  holes.push(...unassertedTextChecks(artifact, why, reason));
  return holes;
}

/** The text-side assertions, as holes, when the bytes are not available. */
function unassertedTextChecks(
  artifact: DocumentArtifact,
  why: string,
  reason: UnassertedReasonValue,
): FileCheck[] {
  const holes: FileCheck[] = [];
  if (artifact.expectText !== undefined && artifact.expectText.length > 0) {
    holes.push(unverified('expectText', why, reason));
  }
  if (artifact.expectPages !== null) holes.push(unverified('expectPages', why, reason));
  return holes;
}

// ─── Steps and the execution ────────────────────────────────────────────────

/**
 * Record one check as a step.
 *
 * UNVERIFIED is a SKIPPED step and never a failed one, because `error` on a
 * StepResult means "this failed" and an unverified check did not. Only UNMET is
 * a statement about the customer's application, and only UNMET carries an error.
 * The same rule as `StepRecorder` in ./jobs.ts, deliberately.
 */
function toStep(check: FileCheck, index: number, artifactPath: string, startedAt: number): StepResult {
  const status: StepResult['status'] =
    check.verdict === 'MET' ? 'PASSED' : check.verdict === 'UNMET' ? 'FAILED' : 'SKIPPED';
  const title =
    check.verdict === 'MET'
      ? `${artifactPath} · ${check.name} — ${check.detail}`
      : `${artifactPath} · ${check.name} — ${check.verdict}${
          check.reason !== null ? ` (${check.reason})` : ''
        }: ${check.detail}`;
  return {
    index,
    title,
    status,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error:
      check.verdict === 'UNMET'
        ? { message: check.detail, stack: null, selector: null, expected: null, actual: null }
        : null,
  };
}

/**
 * Run a DOCUMENT test.
 *
 * ── THE THREE OUTCOMES, AND WHY "NOTHING MEASURED" IS NOT A PASS ────────────
 *
 * FAILED   at least one assertion was UNMET. That is a statement about the
 *          application, and the message names every one of them plus the holes.
 * SKIPPED  nothing at all was established — every check came back UNVERIFIED.
 *          This is the result that must never be PASSED: a green DOCUMENT row
 *          that read no bytes and extracted no text is exactly the lie this
 *          round exists to remove, and it is the single likeliest defect in a
 *          round of new plugins.
 * PASSED   something was proved and nothing was disproved — and the holes still
 *          travel in `errorMessage`, so a pass with an unasserted page count
 *          says so. The gate can refuse to count it; a silent pass cannot be
 *          refused by anything.
 */
export async function runDocumentTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: DocumentTestSpec,
  deps: DocumentDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const steps: StepResult[] = [];
  const all: FileCheck[] = [];

  for (const artifact of spec.artifacts) {
    if (ctx.signal.aborted) break;
    const result = await runArtifact(artifact, ctx, deps);
    for (const check of result.checks) {
      const step = toStep(check, steps.length, artifact.path, Date.now());
      ctx.logger.step({
        testId: test.id,
        index: step.index,
        title: step.title,
        status: step.status,
      });
      steps.push(step);
      all.push(check);
    }
    /*
     * The artefact's OWN declared holes, from the spec. A producer that already
     * knows an assertion cannot be made here records it on `notAsserted`, and
     * carrying it into the result is what makes a plan's promise and a run's
     * report the same list.
     */
    for (const declared of artifact.notAsserted) {
      all.push(unverified(`declared:${declared.assertion}`, declared.assertion, declared.reason));
    }
  }

  const summary = summariseChecks(all);
  const disclosure = discloseHoles(summary);
  const base = {
    testId: test.id,
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  };

  if (ctx.signal.aborted) {
    return {
      ...base,
      status: 'SKIPPED' as const,
      durationMs: Date.now() - startedAt,
      steps,
      notRun: { kind: 'CANCELLED', why: 'the run was cancelled before every artefact was driven' },
      errorMessage: 'the run was cancelled before every artefact was driven',
    };
  }

  if (summary.unmet > 0) {
    const failures = all.filter((c) => c.verdict === 'UNMET').map((c) => c.detail);
    return {
      ...base,
      status: 'FAILED' as const,
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage: [failures.join(' | '), disclosure].filter((s) => s.length > 0).join(' ── '),
    };
  }

  if (!summary.provedSomething) {
    const why =
      `None of this test's ${summary.unverified} check(s) could be verified, so nothing is ` +
      `claimed about the document(s) at ${spec.artifacts.map((a) => a.path).join(', ')}. ` +
      disclosure;
    return {
      ...base,
      status: 'SKIPPED' as const,
      durationMs: Date.now() - startedAt,
      steps,
      /*
       * NOT_RUN, the weakest of the four kinds. BLOCKED_BY_ENV would claim the
       * environment was broken, which a missing PDF parser does not establish,
       * and UNSUPPORTED would be wrong the other way — this deployment supports
       * the type, it merely cannot read a text layer.
       */
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED' as const,
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: disclosure.length > 0 ? disclosure : null,
  };
}

// ─── The shipped adapters ───────────────────────────────────────────────────

/**
 * The text extractor this product ships with: none.
 *
 * Reported rather than faked. A stub that returned `{ text: '', pageCount: 1 }`
 * would make `expectText` fail on every correct document and `placeholders` pass
 * on every broken one, which is worse than having no plugin — it would move
 * numbers on the strength of a fake. `null` means COULD NOT EXTRACT and every
 * caller turns it into UNVERIFIED with an install line.
 *
 * The one thin real adapter is NOT built here: `pdftotext` is a `node:child_process`
 * call, the DOCUMENT declaration already marks it SPEC-scoped so the preflight
 * reports it, and a `spawn` in this file would put a process launch in logic that
 * rule 8 keeps free of one. It is named in the handover.
 */
export const unavailableTextExtractor: DocumentTextExtractor = {
  describe: 'no document text extractor is configured on this deployment',
  extract() {
    return Promise.resolve(null);
  },
};

/**
 * A browser surface that cannot do anything, for a deployment with no browser.
 *
 * Every method returns `null`, and the four call sites read `null` differently
 * and correctly: `download` and `fetchDocument` null is NOT_PRODUCED, which
 * would be wrong here — so this adapter is NOT the default. {@link documentDeps}
 * requires a browser to be installed before a DOCUMENT test runs, and the
 * registry's preflight refuses the type when Chromium is absent. This exists for
 * the tests and for an explicit "no browser" configuration, and its presence in
 * production would be a bug the comment on `setDocumentDeps` names.
 */
export const unavailableMailSurface: MailAttachmentSurface = {
  attachment() {
    return Promise.resolve(null);
  },
};

/**
 * A staging surface that refuses, for a deployment with no writable workspace.
 *
 * A rejection and not a silent success: `stageFixture` turns a throw into
 * UNVERIFIED with `CAPABILITY_ABSENT`, where a fake success would hand
 * `uploadStaged` a path that does not exist and report the resulting Playwright
 * error as a broken file input on the customer's page.
 */
export const unavailableStaging: FileStagingSurface = {
  write() {
    return Promise.reject(
      new Error(
        'no staging directory is configured for this run, so no fixture can be written to disk ' +
          'for an upload. Nothing was measured.',
      ),
    );
  },
  read() {
    return Promise.resolve(null);
  },
};

/** An upload surface with no browser behind it. */
export const unavailableUpload: FileUploadSurface = {
  setInputFiles() {
    return Promise.reject(new Error('no browser context is configured for this run.'));
  },
};

/** A browser surface with nothing behind it. See {@link unavailableMailSurface}. */
export const unavailableDocumentBrowser: DocumentBrowserSurface = {
  download() {
    return Promise.reject(new Error('no browser context is configured for this run.'));
  },
  printToPdf() {
    return Promise.reject(new Error('no browser context is configured for this run.'));
  },
  fetchDocument() {
    return Promise.reject(new Error('no browser context is configured for this run.'));
  },
  inspectPrintStylesheet() {
    return Promise.resolve(null);
  },
};

let deps: DocumentDeps = {
  browser: unavailableDocumentBrowser,
  mail: unavailableMailSurface,
  extractor: unavailableTextExtractor,
  staging: unavailableStaging,
  upload: unavailableUpload,
  stagingDir: '',
};

/**
 * Install the surfaces a run executes against. Returns the previous set, so a
 * test restores exactly what it found.
 *
 * The same module-level injection point as `setJobsDeps` in ./jobs.ts, for the
 * same reason: a plugin's `execute` signature is fixed by `RunnerPlugin` and
 * cannot take a deps argument, so the worker installs them before the run and
 * the tests install recorders.
 */
export function setDocumentDeps(next: DocumentDeps): DocumentDeps {
  const previous = deps;
  deps = next;
  return previous;
}

export const documentPlugin = {
  type: 'DOCUMENT' as const,

  validate(test: ExecutableTest): void {
    const parsed = documentTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Document test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * Caught HERE and not at run time, because a test author who gets an
     * UNAVAILABLE back after waiting for a run has waited to be told about
     * something `validate` could see before anything was driven. The spec's own
     * refinements already cover the contradictions inside one artefact; this
     * covers the one that needs the whole list.
     */
    const duplicatePaths = new Map<string, number>();
    for (const artifact of parsed.data.artifacts) {
      const key = `${artifact.source}\u0000${artifact.path}`;
      duplicatePaths.set(key, (duplicatePaths.get(key) ?? 0) + 1);
    }
    const repeated = [...duplicatePaths.entries()].filter(([, count]) => count > 1);
    if (repeated.length > 0) {
      throw new Error(
        `Document test "${test.name}" names the same source and path more than once ` +
          `(${repeated.map(([key]) => key.replace('\u0000', ' ')).join(', ')}). Two artefacts ` +
          'driving the same route assert the same document twice and report it as two results, ' +
          'which doubles its weight in every count that reads them.',
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runDocumentTest(ctx, test, documentTestSpecSchema.parse(test.spec), deps);
  },
};

/*
 * `decodeUtf8` is re-exported because a DOCUMENT adapter written against this
 * interface needs exactly the fatal-decode discipline ../files.ts implements, and
 * an adapter author reaching for `new TextDecoder()` with the default options
 * would reintroduce the lossy-decode bug that file refuses. One import, one
 * correct behaviour.
 */
export { decodeUtf8 };
