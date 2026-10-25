/**
 * Suite import / the migration wedge (§7).
 *
 * "Upload your Cypress/Selenium suite → get a maintained Playwright suite." The
 * work splits cleanly along a line that matters for what runs without an API
 * key:
 *
 *  - **Detection and structural understanding are deterministic.** Figuring out
 *    which framework a file is written in, and pulling the tests out of a
 *    Postman collection or a Gherkin feature, is pattern-matching and parsing.
 *    No model, fully testable, and it is the part that has to be *right* — a
 *    wrong framework guess wastes the whole conversion.
 *  - **Idiomatic code conversion is the model's job.** Turning Cypress's
 *    `cy.get().click()` into a resilient Playwright `getByRole().click()` while
 *    preserving intent is exactly what an LLM is good at and a regex is not.
 *
 * So detection is deterministic here; Postman (whose tests are data, not code)
 * converts deterministically too; everything code-based goes through the model.
 */

import { z } from 'zod';
import {
  classifyReimport,
  manualTestCaseSchema,
  requirementCanonicalText,
  TEST_MANAGEMENT_SYSTEMS,
  type ApiTestSpec,
  type ContentChange,
  type ContentDigest,
  type ManualTestAutomationStatus,
  type ManualTestCaseInput,
  type SpecSourceSystem,
} from '@qaai/shared';
import { LlmError } from './llm.js';
import type { CallContext, LlmService } from './llm.js';
/*
 * The Postman path reader used to be a private `extractPath` in this file. It
 * moved to `api-surface.ts` when the enumeration side needed the same answer,
 * and is imported rather than copied: two implementations of "which path does
 * this request address" would eventually disagree, and then the migration wedge
 * and the coverage denominator would describe different endpoints from one
 * collection. The edge runs this way round because api-surface.ts holds no
 * model and no SDK, and this file holds both.
 */
import { postmanRequestPath } from './api-surface.js';

// ─── Framework detection ─────────────────────────────────────────────────────

export const SOURCE_FRAMEWORKS = [
  'CYPRESS',
  'PLAYWRIGHT',
  'WEBDRIVERIO',
  'PUPPETEER',
  'SELENIUM_JAVA',
  'SELENIUM_PYTHON',
  'SELENIUM_CSHARP',
  'SELENIUM_RUBY',
  'SELENIUM_JS',
  'TESTCAFE',
  'NIGHTWATCH',
  'ROBOT',
  'POSTMAN',
  'KARATE',
  'GHERKIN',
  'CODECEPTJS',
  'VITEST',
  'JEST',
  'MOCHA',
  'JASMINE',
  'AVA',
  'TAP',
  'NODE_TEST',
  'SUPERTEST',
  'PACTUM',
  'BRUNO',
  'HURL',
  'PACT',
  'K6',
  'APPIUM',
  'MAESTRO',
  'DETOX',
  'ESPRESSO',
  'XCUITEST',
  'BACKSTOPJS',
  'PA11Y',
  'LIGHTHOUSE',
  'UNKNOWN',
] as const;
export type SourceFramework = (typeof SOURCE_FRAMEWORKS)[number];

export const FRAMEWORK_LABELS: Record<SourceFramework, string> = {
  CYPRESS: 'Cypress',
  PLAYWRIGHT: 'Playwright',
  WEBDRIVERIO: 'WebdriverIO',
  PUPPETEER: 'Puppeteer',
  SELENIUM_JAVA: 'Selenium (Java)',
  SELENIUM_PYTHON: 'Selenium (Python)',
  SELENIUM_CSHARP: 'Selenium (C#)',
  SELENIUM_RUBY: 'Selenium (Ruby)',
  SELENIUM_JS: 'Selenium (JavaScript)',
  TESTCAFE: 'TestCafe',
  NIGHTWATCH: 'Nightwatch',
  ROBOT: 'Robot Framework',
  POSTMAN: 'Postman / Newman',
  KARATE: 'Karate',
  GHERKIN: 'Cucumber / Gherkin',
  CODECEPTJS: 'CodeceptJS',
  VITEST: 'Vitest',
  JEST: 'Jest',
  MOCHA: 'Mocha',
  JASMINE: 'Jasmine',
  AVA: 'AVA',
  TAP: 'Tape / uvu (TAP)',
  NODE_TEST: 'node:test / Bun / Deno',
  SUPERTEST: 'Supertest',
  PACTUM: 'PactumJS',
  BRUNO: 'Bruno',
  HURL: 'Hurl',
  PACT: 'Pact (contract)',
  K6: 'k6 (load)',
  APPIUM: 'Appium',
  MAESTRO: 'Maestro',
  DETOX: 'Detox',
  ESPRESSO: 'Espresso',
  XCUITEST: 'XCUITest',
  BACKSTOPJS: 'BackstopJS',
  PA11Y: 'Pa11y',
  LIGHTHOUSE: 'Lighthouse CI',
  UNKNOWN: 'Unknown',
};

export interface SourceFile {
  path: string;
  content: string;
}

interface Rule {
  framework: SourceFramework;
  /** Filename patterns worth points on their own. */
  filenames?: RegExp[];
  /** Content patterns; each match adds to the score. */
  patterns: RegExp[];
  /** Weight per matched pattern — the discriminating ones score higher. */
  weight?: number;
}

/**
 * Ordered so that when two frameworks share a signal, the more specific rule
 * has already claimed the file with a higher-weight discriminator. `cy.` is
 * unique to Cypress; `browser.$(` to WebdriverIO; a `page.$(` with a puppeteer
 * import to Puppeteer; and so on.
 */
const RULES: Rule[] = [
  // ── Unit & component runners ──────────────────────────────────────────────
  {
    framework: 'VITEST',
    filenames: [/vitest\.config\.[jt]s$/, /\.test\.[jt]sx?$/],
    patterns: [/from\s+['"]vitest['"]/, /require\(['"]vitest['"]\)/, /\bvi\.(fn|mock|spyOn)\(/],
    weight: 3,
  },
  {
    framework: 'JEST',
    filenames: [/jest\.config\.[cm]?[jt]s$/, /\.test\.[jt]sx?$/],
    patterns: [/\bjest\.(fn|mock|spyOn|requireActual)\(/, /@jest\/globals/, /['"]ts-jest['"]/],
    weight: 3,
  },
  {
    framework: 'NODE_TEST',
    patterns: [
      /from\s+['"]node:test['"]/,
      /require\(['"]node:test['"]\)/,
      /from\s+['"]bun:test['"]/,
      /\bDeno\.test\(/,
    ],
    weight: 3,
  },
  {
    framework: 'MOCHA',
    filenames: [/\.mocharc\.(json|ya?ml|[jc]s)$/],
    patterns: [/require\(['"]mocha['"]\)/, /from\s+['"]mocha['"]/, /\bthis\.timeout\(/],
    weight: 2,
  },
  {
    framework: 'JASMINE',
    filenames: [/jasmine\.json$/, /karma\.conf\.[jt]s$/],
    patterns: [/\bjasmine\.\w+/, /\bbeforeAll\(.*done/, /require\(['"]karma['"]\)/],
    weight: 2,
  },
  { framework: 'AVA', patterns: [/from\s+['"]ava['"]/, /require\(['"]ava['"]\)/, /\btest\(['"].*['"],\s*async\s*\(t\)/], weight: 2 },
  {
    framework: 'TAP',
    patterns: [/require\(['"]tape['"]\)/, /from\s+['"]tape['"]/, /from\s+['"]uvu['"]/, /from\s+['"]uvu\/assert['"]/],
    weight: 2,
  },
  // ── API & contract ────────────────────────────────────────────────────────
  {
    framework: 'SUPERTEST',
    patterns: [/require\(['"]supertest['"]\)/, /from\s+['"]supertest['"]/, /\brequest\(app\)\s*\./],
    weight: 3,
  },
  { framework: 'PACTUM', patterns: [/require\(['"]pactum['"]\)/, /from\s+['"]pactum['"]/, /\bspec\(\)\s*\.get\(/], weight: 3 },
  { framework: 'BRUNO', filenames: [/\.bru$/, /bruno\.json$/], patterns: [/^\s*meta\s*\{/m, /^\s*(get|post|put|delete)\s*\{/m], weight: 4 },
  { framework: 'HURL', filenames: [/\.hurl$/], patterns: [/^(GET|POST|PUT|DELETE|PATCH)\s+https?:\/\//m, /^HTTP\/?\d*\s+\d{3}/m], weight: 4 },
  {
    framework: 'PACT',
    patterns: [/@pact-foundation/, /\bPact\s*\(/, /pactWith\(/, /willRespondWith/],
    weight: 3,
  },
  // ── Load ──────────────────────────────────────────────────────────────────
  {
    framework: 'K6',
    patterns: [/from\s+['"]k6\/http['"]/, /from\s+['"]k6['"]/, /export\s+const\s+options\s*=/, /\b__VU\b/, /\bhttp\.batch\(/],
    weight: 4,
  },
  // ── Mobile ────────────────────────────────────────────────────────────────
  { framework: 'MAESTRO', filenames: [/\.ya?ml$/], patterns: [/^appId:\s*\S+/m, /^\s*-\s*(launchApp|tapOn|assertVisible|inputText):/m], weight: 4 },
  { framework: 'DETOX', filenames: [/\.detoxrc\.[jt]s(on)?$/], patterns: [/require\(['"]detox['"]\)/, /\bdevice\.launchApp\(/, /\belement\(by\./], weight: 3 },
  {
    framework: 'APPIUM',
    patterns: [/appium/i, /desiredCapabilities/, /\bMobileBy\./, /appium:automationName/],
    weight: 3,
  },
  { framework: 'ESPRESSO', filenames: [/\.java$/, /\.kt$/], patterns: [/androidx\.test\.espresso/, /\bonView\(/, /\bwithId\(/], weight: 3 },
  { framework: 'XCUITEST', filenames: [/\.swift$/], patterns: [/import\s+XCTest/, /XCUIApplication\(/, /XCTAssert/], weight: 3 },
  // ── Visual & accessibility ────────────────────────────────────────────────
  { framework: 'BACKSTOPJS', filenames: [/backstop\.json$/], patterns: [/["']scenarios["']\s*:/, /backstopjs/i, /misMatchThreshold/], weight: 4 },
  { framework: 'PA11Y', filenames: [/\.pa11yci(\.json)?$/, /pa11y\.json$/], patterns: [/require\(['"]pa11y['"]\)/, /pa11y-ci/, /["']standard["']\s*:\s*["']WCAG/], weight: 3 },
  { framework: 'LIGHTHOUSE', filenames: [/lighthouserc\.(json|[jc]s|ya?ml)$/], patterns: [/@lhci\/cli/, /["']assertions["']\s*:/, /lighthouse:recommended/], weight: 3 },
  // ── Other E2E ─────────────────────────────────────────────────────────────
  {
    framework: 'CODECEPTJS',
    filenames: [/codecept\.conf\.[jt]s$/, /_test\.[jt]s$/],
    patterns: [/\bFeature\(['"]/, /\bScenario\(['"]/, /\bI\.(amOnPage|click|see|fillField)\(/],
    weight: 3,
  },
  {
    framework: 'CYPRESS',
    filenames: [/\.cy\.[jt]sx?$/, /cypress\.config\.[jt]s$/, /cypress\/e2e\//],
    patterns: [/\bcy\.\w+\(/, /\bCypress\.\w+/, /['"]cypress['"]/, /cy\.get\(/, /cy\.visit\(/],
    weight: 3,
  },
  {
    framework: 'PLAYWRIGHT',
    filenames: [/\.spec\.[jt]sx?$/, /playwright\.config\.[jt]s$/],
    patterns: [
      /@playwright\/test/,
      /test\.describe\(/,
      /page\.getByRole\(/,
      /await\s+page\.goto\(/,
    ],
    weight: 3,
  },
  {
    framework: 'WEBDRIVERIO',
    filenames: [/wdio\.conf\.[jt]s$/],
    patterns: [/\bbrowser\.\w+\(/, /\$\(['"`]/, /@wdio\//, /browser\.url\(/],
    weight: 3,
  },
  {
    framework: 'PUPPETEER',
    patterns: [
      /require\(['"]puppeteer['"]\)/,
      /from\s+['"]puppeteer['"]/,
      /puppeteer\.launch\(/,
      /browser\.newPage\(/,
      /page\.\$\(/,
    ],
    weight: 3,
  },
  {
    framework: 'SELENIUM_JAVA',
    filenames: [/\.java$/],
    patterns: [
      /org\.openqa\.selenium/,
      /\bWebDriver\b/,
      /driver\.findElement\(By\./,
      /@Test\b/,
      /new\s+ChromeDriver\(/,
    ],
    weight: 3,
  },
  {
    framework: 'SELENIUM_PYTHON',
    filenames: [/\.py$/],
    patterns: [
      /from\s+selenium/,
      /webdriver\.\w+\(/,
      /\.find_element\(/,
      /import\s+selenium/,
      /By\.\w+/,
    ],
    weight: 3,
  },
  {
    framework: 'SELENIUM_CSHARP',
    filenames: [/\.cs$/],
    patterns: [/OpenQA\.Selenium/, /IWebDriver\b/, /new\s+ChromeDriver\(/, /\.FindElement\(By\./],
    weight: 3,
  },
  {
    framework: 'SELENIUM_RUBY',
    filenames: [/\.rb$/],
    patterns: [
      /selenium-webdriver/,
      /Selenium::WebDriver/,
      /\.find_element\(/,
      /driver\s*=\s*Selenium/,
    ],
    weight: 3,
  },
  {
    framework: 'SELENIUM_JS',
    patterns: [
      /selenium-webdriver/,
      /new\s+Builder\(\)/,
      /\bBy\.\w+\(/,
      /driver\.findElement\(/,
      /until\.\w+/,
    ],
    weight: 2,
  },
  {
    framework: 'TESTCAFE',
    patterns: [
      /\bfixture\s*[`(]/,
      /Selector\(['"`]/,
      /import\s+.*\btestcafe\b/,
      /\.typeText\(/,
      /\.expect\(Selector/,
    ],
    weight: 3,
  },
  {
    framework: 'NIGHTWATCH',
    filenames: [/nightwatch\.conf\.[jt]s$/],
    patterns: [
      /browser\.waitForElementVisible\(/,
      /module\.exports\s*=\s*\{[\s\S]*['"]@tags['"]/,
      /client\.\w+\(/,
      /nightwatch/,
    ],
    weight: 3,
  },
  {
    framework: 'ROBOT',
    filenames: [/\.robot$/],
    patterns: [
      /\*\*\*\s*Test Cases\s*\*\*\*/,
      /\*\*\*\s*Settings\s*\*\*\*/,
      /\*\*\*\s*Keywords\s*\*\*\*/,
      /Library\s+SeleniumLibrary/,
    ],
    weight: 3,
  },
  {
    framework: 'KARATE',
    filenames: [/\.feature$/],
    // Karate and Cucumber share the .feature extension and Gherkin keywords, so
    // detection keys on Karate's HTTP-DSL steps — `Given url`, `When method`,
    // `Then status`, `And match`, `And request` — plus the `*`-shorthand. These
    // never appear in a natural-language Cucumber scenario. Weighted high enough
    // to win outright, not just on a filename tie (the earlier gap).
    patterns: [
      /\bkarate\.\w+/,
      /\*\s+def\s+\w+/,
      /\*\s+(url|method|path|request|header)\b/i,
      /Given\s+url\b/i,
      /Given\s+path\b/i,
      /When\s+method\s+(get|post|put|delete|patch|head|options)/i,
      /Then\s+status\s+\d/i,
      /And\s+(match|request|path|header)\b/i,
    ],
    weight: 4,
  },
  {
    framework: 'GHERKIN',
    filenames: [/\.feature$/],
    patterns: [
      /^\s*Feature:/m,
      /^\s*Scenario:/m,
      /^\s*(Given|When|Then|And|But)\s+/m,
      /^\s*Background:/m,
    ],
    weight: 2,
  },
];

export interface DetectionResult {
  framework: SourceFramework;
  confidence: number;
  /** Runner-up frameworks, for the "not this? pick another" affordance. */
  alternatives: Array<{ framework: SourceFramework; score: number }>;
  perFile: Array<{ path: string; framework: SourceFramework; score: number }>;
  /** Concrete signals, so the UI can show why it decided what it did. */
  evidence: string[];
}

/** Postman collections are JSON, detected structurally rather than by pattern. */
function isPostmanCollection(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const info = parsed.info as Record<string, unknown> | undefined;
    return (
      Array.isArray(parsed.item) &&
      (info?.schema?.toString().includes('getpostman.com') === true ||
        info?._postman_id !== undefined ||
        info?.name !== undefined)
    );
  } catch {
    return false;
  }
}

function scoreFile(file: SourceFile): {
  framework: SourceFramework;
  score: number;
  hits: string[];
} {
  if (file.path.endsWith('.json') && isPostmanCollection(file.content)) {
    return { framework: 'POSTMAN', score: 10, hits: ['Postman collection schema'] };
  }

  let best: { framework: SourceFramework; score: number; hits: string[] } = {
    framework: 'UNKNOWN',
    score: 0,
    hits: [],
  };

  for (const rule of RULES) {
    const weight = rule.weight ?? 1;
    let score = 0;
    const hits: string[] = [];

    for (const pattern of rule.filenames ?? []) {
      if (pattern.test(file.path)) {
        score += weight;
        hits.push(`${file.path} matches ${pattern.source}`);
      }
    }
    for (const pattern of rule.patterns) {
      if (pattern.test(file.content)) {
        score += weight;
        hits.push(pattern.source);
      }
    }

    if (score > best.score) best = { framework: rule.framework, score, hits };
  }

  return best;
}

export function detectFramework(files: SourceFile[]): DetectionResult {
  const perFile = files.map((file) => {
    const { framework, score } = scoreFile(file);
    return { path: file.path, framework, score };
  });

  // Aggregate across files: the framework with the most total evidence wins,
  // which is robust to a stray helper file that looks like something else.
  const totals = new Map<SourceFramework, number>();
  const evidence: string[] = [];
  for (const file of files) {
    const { framework, score, hits } = scoreFile(file);
    if (framework === 'UNKNOWN') continue;
    totals.set(framework, (totals.get(framework) ?? 0) + score);
    evidence.push(...hits.slice(0, 2));
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const totalScore = ranked.reduce((sum, [, s]) => sum + s, 0);

  return {
    framework: top?.[0] ?? 'UNKNOWN',
    confidence: top && totalScore > 0 ? Math.min(1, top[1] / totalScore) : 0,
    alternatives: ranked.slice(1, 4).map(([framework, score]) => ({ framework, score })),
    perFile,
    evidence: [...new Set(evidence)].slice(0, 8),
  };
}

// ─── Deterministic: Postman → API test specs ─────────────────────────────────

export interface ConvertedTest {
  name: string;
  filePath: string;
  type: 'E2E' | 'API';
  /** Source code for E2E; empty for API tests (which are spec-driven). */
  code: string;
  spec?: ApiTestSpec;
  sourceFile: string;
  /** Anything that could not be converted faithfully — a custom command, a plugin. */
  notes: string[];
}

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: {
    method?: string;
    url?: { raw?: string } | string;
    header?: Array<{ key: string; value: string; disabled?: boolean }>;
    body?: { mode?: string; raw?: string };
  };
  event?: Array<{ listen?: string; script?: { exec?: string[] } }>;
}

/**
 * Reads a status assertion out of a Postman test script.
 *
 * Postman scripts express the same check several ways, and the earlier regex
 * only matched two of them — a `.to.equal(200)` was silently dropped, leaving
 * the imported test asserting nothing about status. Handles the common Chai
 * and pm.* forms.
 */
function extractStatusAssertion(events: PostmanItem['event']): number | undefined {
  const script = events?.find((e) => e.listen === 'test')?.script?.exec?.join('\n') ?? '';

  const patterns = [
    /\.to\.have\.status\((\d{3})\)/,
    /\bstatus\((\d{3})\)/,
    // pm.expect(pm.response.code).to.equal(200) — and .eql / .eq / .be.equal
    /\.code\b[\s\S]{0,24}?\.to\.(?:be\.)?(?:eql|equal|equals|eq)\((\d{3})\)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(script);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export function convertPostmanCollection(json: string): ConvertedTest[] {
  const collection = JSON.parse(json) as { info?: { name?: string }; item?: PostmanItem[] };
  const out: ConvertedTest[] = [];

  const walk = (items: PostmanItem[] | undefined, trail: string[]): void => {
    for (const item of items ?? []) {
      if (item.item) {
        walk(item.item, [...trail, item.name ?? 'group']);
        continue;
      }
      if (!item.request) continue;

      const rawMethod = (item.request.method ?? 'GET').toUpperCase();
      // The API runner accepts any letters-only method; a method with spaces or
      // symbols is malformed, so fall back to GET and say so rather than emit a
      // spec that fails validation.
      const method = /^[A-Z]+$/.test(rawMethod) ? rawMethod : 'GET';
      const raw = typeof item.request.url === 'string' ? item.request.url : item.request.url?.raw;
      const path = postmanRequestPath(raw);
      const status = extractStatusAssertion(item.event);
      const notes: string[] = [];
      if (method !== rawMethod) notes.push(`Unusual HTTP method "${rawMethod}" replaced with GET`);

      const headers: Record<string, string> = {};
      for (const h of item.request.header ?? []) {
        if (!h.disabled) headers[h.key] = h.value;
      }

      let body: unknown;
      if (item.request.body?.mode === 'raw' && item.request.body.raw) {
        try {
          body = JSON.parse(item.request.body.raw);
        } catch {
          notes.push('Request body was not JSON and was dropped');
        }
      }

      // A Postman test script can assert far more than a status; we lift the
      // status deterministically and flag the rest so no coverage is silently
      // dropped. Count assertion-shaped calls; anything beyond the one status
      // check we ported is a note.
      const script = item.event?.find((e) => e.listen === 'test')?.script?.exec?.join('\n') ?? '';
      const assertionCount = (script.match(/pm\.(expect|response\.to)\b|\bexpect\(/g) ?? []).length;
      const portedAssertions = status !== undefined ? 1 : 0;
      if (assertionCount > portedAssertions) {
        notes.push(
          `${assertionCount - portedAssertions} assertion(s) beyond the status check were not ported — review the Postman test script`,
        );
      }

      const name = [...trail, item.name ?? `${method} ${path}`].filter(Boolean).join(' / ');

      out.push({
        name,
        type: 'API',
        filePath: `imported/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.api.json`,
        code: '',
        spec: {
          variables: {},
          steps: [
            {
              name: item.name ?? `${method} ${path}`,
              method,
              path,
              headers,
              ...(body !== undefined ? { body } : {}),
              assertions: status !== undefined ? { status } : {},
              extract: {},
            },
          ],
        },
        sourceFile: collection.info?.name ?? 'postman-collection.json',
        notes,
      });
    }
  };

  walk(collection.item, []);
  return out;
}

// ─── LLM: code-based frameworks → Playwright ─────────────────────────────────

const convertedFileSchema = z.object({
  summary: z.string(),
  tests: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        filePath: z
          .string()
          .min(1)
          .refine((p) => !p.includes('..') && !p.startsWith('/'), 'must be a relative path'),
        code: z.string().min(1),
        notes: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const CONVERT_SYSTEM = `You migrate an existing automated test to Playwright
(TypeScript, @playwright/test). The customer owns the result and runs it in
their own CI, so it must be a standalone, idiomatic Playwright spec — never
import anything QAAI-specific.

Rules:
- Preserve the test's intent exactly. If the original checks an order total,
  the Playwright version checks the same order total, not merely that a page
  loaded.
- Convert locators to Playwright's resilient forms: getByRole with a name,
  getByLabel, getByTestId. A raw CSS/XPath selector from the source becomes a
  role/label/text locator wherever the intent is clear; keep the CSS only when
  nothing else can express it, and note it.
- One test.step() per meaningful action, titled in plain English — those become
  the timeline a human reads on failure.
- Replace explicit sleeps / implicit waits with Playwright's auto-waiting and
  web-first assertions. Never emit waitForTimeout.
- Make URLs relative (page.goto('/checkout')) so the test runs against any
  environment, unless the original hard-codes a full URL for a reason.

Report honestly in notes what did not convert cleanly: custom Cypress commands,
framework plugins, page objects you inlined, fixtures you could not resolve,
assertions whose meaning was unclear. A migration that silently drops coverage
is worse than one that flags it.`;

export interface ConvertResult {
  tests: ConvertedTest[];
  summary: string;
  /**
   * Source files whose content the prompt cap TRUNCATED, with how much of each
   * the model never saw.
   *
   * ── WHY A MIGRATION NEEDS THIS DISCLOSED ──────────────────────────────────
   *
   * The prompt sends `file.content.slice(0, CONVERT_SOURCE_LIMIT)`, so a 60KB
   * spec file is converted from its first 20KB and every test declared after
   * that point is simply not there. The summary then read "Converted 7 test(s)
   * from 1 source file(s)" — a count of what the model saw presented as a count
   * of what the file holds, which is the same shape of lie as an undisclosed
   * ingest cap: the tests that were never seen stop being unconverted and
   * become absent, and absent costs nothing.
   *
   * Empty means no file was truncated, which is a measurement rather than an
   * empty list because nobody looked.
   */
  truncatedSources: Array<{ path: string; charsSeen: number; charsNotSeen: number }>;
  /** Files skipped before any call, so the file count can be reconciled. */
  skippedSources: Array<{ path: string; reason: string }>;
}

/**
 * Converts code-based source files with the model. Postman is handled
 * deterministically by the caller before this is reached.
 *
 * One structured call per source file: batching several files into one prompt
 * saves round trips but loses the file→file mapping the coverage report needs,
 * and a single failed file should not sink the batch.
 */
/**
 * How much of one source file the prompt carries.
 *
 * Named rather than inline so it can be disclosed: see
 * {@link ConvertResult.truncatedSources}.
 */
export const CONVERT_SOURCE_LIMIT = 20_000;

export async function convertSuiteWithLlm(
  llm: LlmService,
  ctx: CallContext,
  args: {
    framework: SourceFramework;
    files: SourceFile[];
    /** Optional: recent flow-map locators, so conversions target real elements. */
    knownLocators?: string[];
    onFile?: (path: string, testCount: number) => void;
  },
): Promise<ConvertResult> {
  const tests: ConvertedTest[] = [];
  const summaries: string[] = [];
  const truncatedSources: ConvertResult['truncatedSources'] = [];
  const skippedSources: ConvertResult['skippedSources'] = [];

  for (const file of args.files) {
    // Config and helper files carry no tests; converting them wastes tokens and
    // produces noise. The detector already told us the framework.
    //
    // RECORDED, because `args.files.length` is in the summary: "from 9 source
    // file(s)" over a list that contains two configs is a file count nobody can
    // reconcile against the tests, and a skip that leaves no trace is
    // indistinguishable from a file that converted to nothing.
    if (/\.(config|conf)\.[jt]s$/.test(file.path)) {
      skippedSources.push({
        path: file.path,
        reason: 'a config file: it declares no tests, so no conversion was attempted',
      });
      continue;
    }

    const source = file.content.slice(0, CONVERT_SOURCE_LIMIT);
    const notSeen = file.content.length - source.length;
    if (notSeen > 0) {
      truncatedSources.push({
        path: file.path,
        charsSeen: source.length,
        charsNotSeen: notSeen,
      });
    }

    const prompt = `Source framework: ${FRAMEWORK_LABELS[args.framework]}
Source file: ${file.path}

${args.knownLocators?.length ? `Locators present on the live app (prefer these where they fit):\n${args.knownLocators.slice(0, 30).join('\n')}\n` : ''}
SOURCE:
${source}
${
  notSeen > 0
    ? `\n[TRUNCATED: ${notSeen} more characters of this file were not sent. Convert only what is above and say in your notes that the file was truncated.]\n`
    : ''
}
Convert every test in this file to Playwright. Return one entry per resulting
Playwright test, each a complete standalone spec, plus a one-line summary and
honest notes on anything that did not convert cleanly.`;

    try {
      const result = await llm.structured(ctx, {
        tier: 'strong',
        effort: 'high',
        system: CONVERT_SYSTEM,
        prompt,
        schema: convertedFileSchema,
        schemaName: 'ConvertedFile',
        maxTokens: 16000,
        cacheSystem: true,
      });

      for (const t of result.tests) {
        tests.push({
          name: t.name,
          type: 'E2E',
          filePath: t.filePath,
          code: t.code,
          sourceFile: file.path,
          /*
           * The truncation note goes on EVERY test from a truncated file, not
           * only in the summary. A converted test is reviewed on its own, in a
           * diff, by somebody who will never see the run summary — and the one
           * thing they need to know about this file is that part of it was
           * never read.
           */
          notes:
            notSeen > 0
              ? [
                  ...t.notes,
                  `the source file was truncated for conversion: ${notSeen} character(s) of ` +
                    `${file.path} were not sent, so any test declared past that point is NOT in ` +
                    'this migration',
                ]
              : t.notes,
        });
      }
      summaries.push(
        `${file.path}: ${result.summary}` +
          (notSeen > 0
            ? ` [TRUNCATED: ${notSeen} of ${file.content.length} characters were not sent, so ` +
              'this is a conversion of a PREFIX of the file]'
            : ''),
      );
      args.onFile?.(file.path, result.tests.length);
    } catch (err) {
      // An auth failure (no key, rejected key, budget) will hit every remaining
      // file identically — stop and let the caller report the real cause,
      // rather than grinding through the whole suite and 3x job retries against
      // a key that will never work.
      if (err instanceof LlmError && err.kind === 'AUTH') throw err;
      summaries.push(
        `${file.path}: conversion failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /*
   * The file count names what was ATTEMPTED, not what was handed in: the
   * skipped configs are a separate number with a separate list, because
   * "from 9 source file(s)" over a set containing two configs is a figure
   * nobody can reconcile against the tests below it.
   */
  const attempted = args.files.length - skippedSources.length;
  const truncationLine =
    truncatedSources.length === 0
      ? ''
      : `\n${truncatedSources.length} source file(s) were TRUNCATED for conversion and at least ` +
        `${truncatedSources.reduce((sum, entry) => sum + entry.charsNotSeen, 0)} character(s) ` +
        'were never read, so any test declared past the cut is missing from this migration: ' +
        truncatedSources.map((entry) => entry.path).join(', ');
  return {
    tests,
    summary:
      `Converted ${tests.length} test(s) from ${attempted} of ${args.files.length} source ` +
      `file(s)${skippedSources.length > 0 ? ` (${skippedSources.length} skipped)` : ''}.` +
      `${truncationLine}\n${summaries.join('\n')}`,
    truncatedSources,
    skippedSources,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The manual suite nobody could read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * READING a test-management suite, which until now was impossible.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * TestRail is WRITE-ONLY here: results are pushed to it and nothing has ever
 * been pulled back. Xray, Zephyr and qTest cannot be touched at all. So the
 * largest existing record of "what must be tested" — for most teams with a QA
 * function, by a wide margin the largest — is invisible to the denominator. A
 * customer with 1,840 TestRail cases, 210 of them automated, currently sees a
 * coverage number computed as though those 1,630 cases did not exist, which
 * flatters it in the one direction that matters.
 *
 * ── WHY EVERY READER BELOW IS A PURE MAPPER ─────────────────────────────────
 *
 * Each vendor function takes an ALREADY-FETCHED payload and returns rows. The
 * paging, the credential and the retries are {@link importManualSuite}'s, and
 * it takes a one-method {@link ManualSuiteTransport}, so all four vendor
 * dialects — and the three places each of them can be silent — are driven by
 * literals in `importer.test.ts` with no network and no vendor SDK anywhere.
 *
 * ── THE THREE SILENCES THESE READERS REFUSE TO SPELL AS ANSWERS ─────────────
 *
 *   · `steps: []` is produced by THREE different facts and only one of them is
 *     "this case has no steps". {@link ManualStepsState} separates them, because
 *     a case whose steps are one prose blob is a case we could not COUNT, and
 *     reporting zero steps for it would make a conversion look complete.
 *   · An empty automation field is `NOT_STATED` and never `NOT_AUTOMATED`.
 *     TestRail's automation column is optional and most installs leave it
 *     empty; folding empty into not-automated would let us quote a backlog of
 *     1,630 at a customer whose suite never claimed anything about 1,400 of
 *     them. `manualBacklogTotals` in @qaai/shared keeps the two counts apart
 *     and never sums them.
 *   · `lastExecutedAt: null` is "the suite does not say", not "never run".
 *
 * ── RE-IMPORT ───────────────────────────────────────────────────────────────
 *
 * A nightly import must not churn the table, so every row carries a content
 * hash and {@link manualCaseContentHash} canonicalises exactly the fields that
 * are the SPECIFICATION. The automation status and the last-executed date are
 * deliberately OUT of it: a case being run, or being marked automated, is not
 * an edit to the test, and hashing either would re-open every link in a project
 * on the night its regression pass finished.
 */

/** The four suites, plus the CSV that needs no credential at all. */
export const MANUAL_SUITE_SOURCES = ['TESTRAIL', 'XRAY', 'ZEPHYR', 'QTEST', 'CSV'] as const;
export type ManualSuiteSource = (typeof MANUAL_SUITE_SOURCES)[number];

/**
 * Compiler-enforced proof that every reader's source is a `SpecSourceSystem`.
 *
 * Not a cast. A member added here with no home in the shared vocabulary breaks
 * this line, which is the only thing standing between a new reader and rows
 * that `manualTestCaseSchema` refuses at the write path — the exact shape of
 * the GateRule defect this codebase keeps re-learning.
 */
export const MANUAL_SUITE_AS_SPEC_SOURCE = {
  TESTRAIL: 'TESTRAIL',
  XRAY: 'XRAY',
  ZEPHYR: 'ZEPHYR',
  QTEST: 'QTEST',
  CSV: 'CSV',
} as const satisfies Record<ManualSuiteSource, SpecSourceSystem>;

/**
 * Whether a source holds a MANUAL SUITE rather than a backlog.
 *
 * Derived from `TEST_MANAGEMENT_SYSTEMS` rather than relisted, so the sentence
 * "your TestRail suite has 1,840 cases" cannot come to include a Jira project's
 * issue count. CSV is the honest exception: an exported sheet may hold either,
 * and only the person who exported it knows which.
 */
export function holdsManualSuite(source: ManualSuiteSource): boolean {
  return TEST_MANAGEMENT_SYSTEMS.includes(MANUAL_SUITE_AS_SPEC_SOURCE[source]);
}

/**
 * How a case's steps arrived, which decides what `steps.length` means.
 *
 * ROWS is the only state in which the count is a measurement. The other three
 * all produce an empty array and are three different facts:
 *
 *   PROSE_NOT_SPLIT  the suite gave one text blob. TestRail's `custom_steps`
 *                    and Zephyr's `testScript.text` are exactly this. We could
 *                    not COUNT the steps; the prose is handed back whole on
 *                    {@link ImportedManualCase.stepProse} so a human — or a
 *                    later model-driven conversion — can still use it.
 *   DECLARED_EMPTY   the suite HAS a steps field for this case and it is empty.
 *                    The one state where "this case has no steps" is true.
 *   NO_FIELD         the payload carries no steps field at all. Our silence.
 */
export const MANUAL_STEPS_STATES = [
  'ROWS',
  'PROSE_NOT_SPLIT',
  'DECLARED_EMPTY',
  'NO_FIELD',
] as const;
export type ManualStepsState = (typeof MANUAL_STEPS_STATES)[number];

export const MANUAL_STEPS_STATE_LABELS: Record<ManualStepsState, string> = {
  ROWS: 'the suite supplied steps as rows, and the count is a measurement',
  PROSE_NOT_SPLIT: 'the suite supplied one prose blob; the steps were not counted',
  DECLARED_EMPTY: 'the suite has a steps field for this case and it is empty',
  NO_FIELD: 'the payload carries no steps field, so nothing was read',
};

/** One imported case: the row, how its steps arrived, and what changed. */
export interface ImportedManualCase {
  /** Ready for the write path: already through `manualTestCaseSchema`. */
  case: ManualTestCaseInput;
  steps: ManualStepsState;
  /** The unsplit prose, when `steps` is PROSE_NOT_SPLIT. Null otherwise. */
  stepProse: string | null;
  /** The content hash, over the specification fields only. */
  contentHash: string;
  /**
   * NEW / UNCHANGED / CHANGED / NOT_COMPARABLE against the stored row.
   *
   * Null when the caller supplied no previous hashes at all — which is a
   * different fact from NEW, and conflating them would report a first import of
   * 1,840 cases as 1,840 edits.
   */
  change: ContentChange | null;
  /** Anything the reader could not take from this case. Never silently empty. */
  notes: string[];
}

/** Where one reader fell short of the payload. */
export interface ManualImportGap {
  /** The case this is about, or null for a payload-level gap. */
  externalId: string | null;
  detail: string;
}

export interface ManualImportReport {
  source: ManualSuiteSource;
  cases: ImportedManualCase[];
  gaps: ManualImportGap[];
  /**
   * How many cases the payload claimed to hold, when it says.
   *
   * Null when it does not say, and the null is load-bearing: TestRail's
   * `/get_cases` reports a `size` and an `offset`, so a truncated read is
   * DETECTABLE; a bare array is not, and claiming we read all of a suite we
   * paged out of would be the undisclosed cap this product may not ship.
   */
  claimedTotal: number | null;
  /** True when the reader stopped before the payload said it was done. */
  truncated: boolean;
  caveats: string[];
}

/** A transport that can GET one page from a suite's API. Injected; see rule 8. */
export interface ManualSuiteTransport {
  get(request: ManualSuiteRequest): Promise<ManualSuiteResponse>;
}

export interface ManualSuiteRequest {
  /** The vendor path, relative to whatever base the adapter holds. */
  path: string;
  /** Query parameters. The adapter encodes them; the reader never builds a URL. */
  query: Record<string, string | number>;
}

export interface ManualSuiteResponse {
  status: number | null;
  /** The decoded body, or null when there was none. */
  body: unknown;
  /** A transport-level failure. Null on any answer, including a 500. */
  error: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A date a suite reported, or null.
 *
 * Handles the two shapes the four vendors use — an ISO-8601 string and
 * TestRail's UNIX seconds — and returns null for anything else rather than an
 * Invalid Date. `new Date(undefined)` is an Invalid Date that passes a
 * `instanceof Date` check, serialises to null in JSON and lands in the column
 * as a null that nobody can tell from "the suite does not say".
 */
function suiteDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1_000);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** One step row, before it reaches the schema. */
interface RawStep {
  action: string | null;
  expected: string | null;
}

/** The outcome of reading a case's steps: the state AND what was read. */
interface StepReading {
  state: ManualStepsState;
  steps: Array<{ ordinal: number; action: string; expected: string | null }>;
  prose: string | null;
  note: string | null;
}

/**
 * Turns whatever a vendor supplied into the three-state reading.
 *
 * `rows: null` means the payload HAS NO FIELD; `rows: []` means the field is
 * there and empty. The caller must pass the right one, and that is the whole
 * reason this takes a nullable array rather than defaulting — `?? []` at a call
 * site here is how NO_FIELD silently becomes DECLARED_EMPTY, which turns our
 * silence into a claim about the customer's suite.
 */
function readSteps(rows: readonly RawStep[] | null, prose: string | null): StepReading {
  if (rows === null) {
    if (prose !== null) {
      return {
        state: 'PROSE_NOT_SPLIT',
        steps: [],
        prose,
        note:
          'the suite holds this case\'s steps as one text blob; they were NOT counted, and the ' +
          'prose is kept whole rather than guessed apart',
      };
    }
    return {
      state: 'NO_FIELD',
      steps: [],
      prose: null,
      note: 'the payload carries no steps field for this case, so no steps were read',
    };
  }

  const steps: Array<{ ordinal: number; action: string; expected: string | null }> = [];
  for (const row of rows) {
    const action = row.action;
    if (action === null) continue;
    steps.push({ ordinal: steps.length, action, expected: row.expected });
  }
  if (steps.length === 0) {
    /*
     * The field was present and yielded nothing. If a prose blob also exists,
     * PROSE_NOT_SPLIT is the truer answer than DECLARED_EMPTY: the case has
     * steps, written somewhere we cannot count them.
     */
    if (prose !== null) {
      return {
        state: 'PROSE_NOT_SPLIT',
        steps: [],
        prose,
        note:
          'the structured steps field is empty and a prose blob is not; the steps were not ' +
          'counted and the prose is kept whole',
      };
    }
    return { state: 'DECLARED_EMPTY', steps: [], prose: null, note: null };
  }
  return { state: 'ROWS', steps, prose: null, note: null };
}

/**
 * Normalises a suite's automation field.
 *
 * ── WHY THIS IS A TABLE AND NOT A `.toUpperCase()` ──────────────────────────
 *
 * Because the default decides a count a customer will quote. An unrecognised
 * word must not land on NOT_AUTOMATED — that is a claim the suite never made —
 * and it must not land on AUTOMATED either. It lands on NOT_STATED, which
 * `manualBacklogTotals` counts separately and never adds to the backlog, and
 * the raw word goes in a gap so a human can extend this table.
 */
const AUTOMATION_WORDS: Record<string, ManualTestAutomationStatus> = {
  // Shared across vendors and CSV exports.
  none: 'NOT_AUTOMATED',
  manual: 'NOT_AUTOMATED',
  'not automated': 'NOT_AUTOMATED',
  no: 'NOT_AUTOMATED',
  planned: 'AUTOMATION_PLANNED',
  'to be automated': 'AUTOMATION_PLANNED',
  'to automate': 'AUTOMATION_PLANNED',
  'in progress': 'AUTOMATION_PLANNED',
  automated: 'AUTOMATED',
  yes: 'AUTOMATED',
  automation: 'AUTOMATED',
  'cannot automate': 'CANNOT_AUTOMATE',
  'not automatable': 'CANNOT_AUTOMATE',
  'manual only': 'CANNOT_AUTOMATE',
  obsolete: 'OBSOLETE',
  deprecated: 'OBSOLETE',
  retired: 'OBSOLETE',
};

function automationStatus(raw: unknown): {
  status: ManualTestAutomationStatus;
  unrecognised: string | null;
} {
  const word = text(raw);
  if (word === null) return { status: 'NOT_STATED', unrecognised: null };
  const mapped = AUTOMATION_WORDS[word.toLowerCase()];
  if (mapped === undefined) return { status: 'NOT_STATED', unrecognised: word };
  return { status: mapped, unrecognised: null };
}

// ─── The content hash: what counts as an edit ────────────────────────────────

/**
 * The canonical text a manual case's content hash is taken over.
 *
 * ── WHY IT CALLS `requirementCanonicalText` ─────────────────────────────────
 *
 * Because canonicalisation is the part that goes wrong and @qaai/shared has
 * already got it right: `\r\n` and `\r` become `\n` (a tracker's web editor and
 * its REST API disagree about line endings on the same unedited case), trailing
 * whitespace per line goes, interior whitespace does NOT (in a step's
 * indentation, structure is meaning), and the field separator is a character no
 * field can contain. A second canonicaliser here would drift from that one, and
 * the symptom would be a nightly import reporting every case as CHANGED — at
 * which point people stop reading the traceability matrix, which is the whole
 * asset.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE HASH ────────────────────────────────────
 *
 * `automationStatus` and `lastExecutedAt`. A case being run last night, or
 * being ticked off as automated, is not an edit to the specification. Hashing
 * either would re-open every link in a project on the morning after a
 * regression pass — the same argument the shared comment makes for keeping a
 * requirement's STATUS out of its hash.
 *
 * ── WHAT THE ORDINAL PREFIX IS ACTUALLY FOR ─────────────────────────────────
 *
 * NOT for detecting a reorder: the shared canonicaliser joins criteria IN
 * ORDER with a separator no field can contain, so swapping two steps already
 * changes the text. The ordinal stops a different collision — a forged step
 * BOUNDARY. A per-step expected result is emitted as its own criterion, so
 * without the prefix a case with one step (`action: 'a'`, `expected: 'b'`)
 * canonicalises to exactly the same text as a case with two steps whose second
 * action is literally `expected: b`. Those are different specifications, and
 * one hashing as the other means an edit between them re-imports as UNCHANGED
 * and the customer's change is dropped silently.
 */
export function manualCaseCanonicalText(input: ManualTestCaseInput): string {
  const criteria: string[] = [];
  for (const step of input.steps) {
    criteria.push(`${step.ordinal}. ${step.action}`);
    if (step.expected !== null) criteria.push(`${step.ordinal}. expected: ${step.expected}`);
  }
  return requirementCanonicalText({
    externalId: input.externalId,
    title: input.title,
    body: input.expectedResult ?? '',
    criteria,
  });
}

/**
 * The content hash of a manual case, under a caller-supplied digest.
 *
 * The digest is INJECTED for the reason `requirements.ts` states: there is no
 * `node:crypto` import in @qaai/shared because its barrel is what the web app's
 * bundler consumes. This module is Node-only and could import it, and does not,
 * so that the hash a worker computes and the hash a test asserts come from the
 * same seam.
 */
export function manualCaseContentHash(
  input: ManualTestCaseInput,
  digest: ContentDigest,
): string {
  return digest(manualCaseCanonicalText(input));
}

// ─── The five readers ────────────────────────────────────────────────────────

/** What every reader needs: the digest, and the hashes a re-import compares to. */
export interface ManualReaderOptions {
  digest: ContentDigest;
  /**
   * The stored hash per external id, for change detection.
   *
   * UNDEFINED (the whole map absent) means the caller is not comparing, and
   * `change` comes back null. A PRESENT map with no entry for an id means that
   * id is NEW. A present entry of null means the stored row was never hashed,
   * which `classifyReimport` calls NOT_COMPARABLE — three inputs, not two, and
   * the shared function is what keeps them apart.
   */
  previousHashes?: ReadonlyMap<string, string | null>;
}

/** Assembles one case: schema, hash, change classification. */
function assemble(
  source: ManualSuiteSource,
  options: ManualReaderOptions,
  fields: {
    externalId: string;
    title: string;
    reading: StepReading;
    expectedResult: string | null;
    automation: ManualTestAutomationStatus;
    lastExecutedAt: Date | null;
    url: string | null;
    notes: string[];
  },
): ImportedManualCase {
  const parsed = manualTestCaseSchema.parse({
    externalId: fields.externalId,
    sourceSystem: MANUAL_SUITE_AS_SPEC_SOURCE[source],
    title: fields.title,
    steps: fields.reading.steps,
    expectedResult: fields.expectedResult,
    automationStatus: fields.automation,
    lastExecutedAt: fields.lastExecutedAt,
    url: fields.url,
  } satisfies ManualTestCaseInput);

  const contentHash = manualCaseContentHash(parsed, options.digest);
  const notes = [...fields.notes];
  if (fields.reading.note !== null) notes.push(fields.reading.note);

  return {
    case: parsed,
    steps: fields.reading.state,
    stepProse: fields.reading.prose,
    contentHash,
    change:
      options.previousHashes === undefined
        ? null
        : classifyReimport(
            options.previousHashes.has(fields.externalId)
              ? options.previousHashes.get(fields.externalId)
              : undefined,
            contentHash,
          ),
    notes,
  };
}

/**
 * TestRail's `/get_cases` payload.
 *
 * Two step fields and they are not interchangeable: `custom_steps_separated` is
 * rows (`{ content, expected }`) and `custom_steps` is one blob. An install
 * that uses the blob — which is the TestRail default template — yields
 * PROSE_NOT_SPLIT, and reporting zero steps for every case in such a project
 * would make a conversion look complete when it has read nothing.
 *
 * `custom_automation_type` is an integer id whose MEANING IS PER-INSTALL: the
 * labels live in that TestRail's own configuration, which this payload does not
 * carry. So an integer is NOT mapped — it becomes NOT_STATED with the value in
 * a gap. Guessing that 1 means automated is exactly the kind of mapping nobody
 * reviewed that moves a coverage percentage.
 */
export function readTestRailCases(
  payload: unknown,
  options: ManualReaderOptions,
): ManualImportReport {
  const envelope = isPlainRecord(payload) ? payload : null;
  const rows = Array.isArray(envelope?.cases)
    ? envelope.cases
    : Array.isArray(payload)
      ? payload
      : null;
  if (rows === null) {
    return emptyReport('TESTRAIL', 'the payload is neither a `cases` envelope nor an array');
  }

  const cases: ImportedManualCase[] = [];
  const gaps: ManualImportGap[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      gaps.push({ externalId: null, detail: 'a `cases` entry is not an object' });
      continue;
    }
    const id = text(row.id);
    const title = text(row.title);
    if (id === null || title === null) {
      gaps.push({
        externalId: id,
        detail: 'a case with no `id` or no `title`; TestRail guarantees both, so this row is broken',
      });
      continue;
    }
    const externalId = `C${id}`;
    const notes: string[] = [];

    const separated = row.custom_steps_separated;
    const structured = Array.isArray(separated)
      ? separated.map((step): RawStep => ({
          action: isPlainRecord(step) ? text(step.content) : null,
          expected: isPlainRecord(step) ? text(step.expected) : null,
        }))
      : null;
    const reading = readSteps(structured, text(row.custom_steps));

    const automation = automationStatus(row.custom_automation_type);
    if (automation.unrecognised !== null) {
      gaps.push({
        externalId,
        detail:
          `\`custom_automation_type\` is \`${automation.unrecognised}\`, which this install ` +
          'defines in its own configuration and the payload does not carry; recorded as ' +
          'NOT_STATED rather than guessed, so it is counted and never added to the backlog',
      });
    }

    cases.push(
      assemble('TESTRAIL', options, {
        externalId,
        title,
        reading,
        expectedResult: text(row.custom_expected),
        automation: automation.status,
        /*
         * `null` and not "never run": TestRail omits this field for a case with
         * no execution history, and a case the install has no such field for
         * looks identical. One of those is a finding.
         */
        lastExecutedAt: suiteDate(row.last_executed_on ?? row.updated_on_execution),
        url: null,
        notes,
      }),
    );
  }

  const claimedTotal = typeof envelope?.size === 'number' ? envelope.size : null;
  return finishReport('TESTRAIL', cases, gaps, claimedTotal, envelope?._links);
}

/**
 * Xray's test payload (Jira-backed, so the key is the identity).
 *
 * `steps` rows carry `action`, `data` and `result`. `data` is test DATA, not an
 * action, so it is appended to the action rather than dropped or silently
 * promoted to a step of its own — dropping it loses the only part of the step a
 * generated test can actually use.
 */
export function readXrayTests(payload: unknown, options: ManualReaderOptions): ManualImportReport {
  const envelope = isPlainRecord(payload) ? payload : null;
  const rows = Array.isArray(envelope?.tests)
    ? envelope.tests
    : Array.isArray(payload)
      ? payload
      : null;
  if (rows === null) {
    return emptyReport('XRAY', 'the payload is neither a `tests` envelope nor an array');
  }

  const cases: ImportedManualCase[] = [];
  const gaps: ManualImportGap[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      gaps.push({ externalId: null, detail: 'a `tests` entry is not an object' });
      continue;
    }
    const key = text(row.key) ?? text(row.issueId);
    const fields = isPlainRecord(row.fields) ? row.fields : null;
    const title = text(row.summary) ?? (fields ? text(fields.summary) : null);
    if (key === null || title === null) {
      gaps.push({ externalId: key, detail: 'an Xray test with no key or no summary' });
      continue;
    }

    const notes: string[] = [];
    const rawSteps = Array.isArray(row.steps) ? row.steps : null;
    const structured =
      rawSteps === null
        ? null
        : rawSteps.map((step): RawStep => {
            if (!isPlainRecord(step)) return { action: null, expected: null };
            const action = text(step.action);
            const data = text(step.data);
            return {
              action: action === null ? null : data === null ? action : `${action}\n(data: ${data})`,
              expected: text(step.result),
            };
          });
    const reading = readSteps(structured, text(row.definition));

    /*
     * Xray's test TYPE is the automation signal and it is not an automation
     * field: `Manual` means a human runs it, `Cucumber` and `Generic` mean
     * something else does. A type we do not recognise is NOT_STATED.
     */
    const testType = text(row.testType) ?? (fields ? text(fields.testType) : null);
    let automation: ManualTestAutomationStatus = 'NOT_STATED';
    if (testType !== null) {
      const lowered = testType.toLowerCase();
      if (lowered === 'manual') automation = 'NOT_AUTOMATED';
      else if (lowered === 'cucumber' || lowered === 'generic' || lowered === 'automated') {
        automation = 'AUTOMATED';
      } else {
        gaps.push({
          externalId: key,
          detail:
            `\`testType\` is \`${testType}\`, which this reader does not map; recorded as ` +
            'NOT_STATED rather than assumed manual',
        });
      }
    }

    cases.push(
      assemble('XRAY', options, {
        externalId: key,
        title,
        reading,
        expectedResult: null,
        automation,
        lastExecutedAt: suiteDate(row.lastTestRun ?? (fields ? fields.lastTestRun : undefined)),
        url: text(row.self),
        notes,
      }),
    );
  }

  const claimedTotal = typeof envelope?.total === 'number' ? envelope.total : null;
  return finishReport('XRAY', cases, gaps, claimedTotal, envelope?.isLast === false);
}

/**
 * Zephyr Scale's testcases payload.
 *
 * `testScript` is one field with two shapes: `{ type: 'STEP_BY_STEP', steps }`
 * and `{ type: 'PLAIN_TEXT', text }`. Reading only the first makes every
 * plain-text project import as "no steps", which is why the type is READ rather
 * than the `steps` key being probed for.
 */
export function readZephyrTests(payload: unknown, options: ManualReaderOptions): ManualImportReport {
  const envelope = isPlainRecord(payload) ? payload : null;
  const rows = Array.isArray(envelope?.values)
    ? envelope.values
    : Array.isArray(payload)
      ? payload
      : null;
  if (rows === null) {
    return emptyReport('ZEPHYR', 'the payload is neither a `values` envelope nor an array');
  }

  const cases: ImportedManualCase[] = [];
  const gaps: ManualImportGap[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      gaps.push({ externalId: null, detail: 'a `values` entry is not an object' });
      continue;
    }
    const key = text(row.key);
    const title = text(row.name);
    if (key === null || title === null) {
      gaps.push({ externalId: key, detail: 'a Zephyr test case with no key or no name' });
      continue;
    }

    const script = isPlainRecord(row.testScript) ? row.testScript : null;
    const scriptType = script ? text(script.type) : null;
    let structured: RawStep[] | null = null;
    let prose: string | null = null;
    if (script === null) {
      // No field at all. NO_FIELD, which readSteps produces from null + null.
    } else if (Array.isArray(script.steps)) {
      structured = script.steps.map((step): RawStep => ({
        action: isPlainRecord(step) ? text(step.description) : null,
        expected: isPlainRecord(step) ? text(step.expectedResult) : null,
      }));
    } else {
      prose = text(script.text);
      if (prose === null) {
        gaps.push({
          externalId: key,
          detail:
            `\`testScript.type\` is \`${scriptType ?? 'absent'}\` and it carries neither \`steps\` ` +
            'nor `text`, so this case\'s steps were not read at all',
        });
      }
    }
    const reading = readSteps(structured, prose);

    const automation = automationStatus(row.customFields && isPlainRecord(row.customFields)
      ? row.customFields.Automation ?? row.customFields.automation
      : undefined);
    if (automation.unrecognised !== null) {
      gaps.push({
        externalId: key,
        detail:
          `the \`Automation\` custom field is \`${automation.unrecognised}\`, which this reader ` +
          'does not map; recorded as NOT_STATED',
      });
    }

    cases.push(
      assemble('ZEPHYR', options, {
        externalId: key,
        title,
        reading,
        expectedResult: null,
        automation: automation.status,
        lastExecutedAt: suiteDate(row.lastExecutionDate),
        url: text(row.self),
        notes: [],
      }),
    );
  }

  const claimedTotal = typeof envelope?.total === 'number' ? envelope.total : null;
  return finishReport('ZEPHYR', cases, gaps, claimedTotal, envelope?.isLast === false);
}

/**
 * qTest's test-case payload.
 *
 * Steps live on `test_steps` with `description` and `expected_result`. The
 * automation signal is a PROPERTY in a `properties` array keyed by
 * `field_name`, which is why this reader searches rather than indexes: the
 * array's order is not stable across qTest projects, and reading
 * `properties[3]` would attribute one project's "Automation" to another's
 * "Priority".
 */
export function readQTestCases(payload: unknown, options: ManualReaderOptions): ManualImportReport {
  const envelope = isPlainRecord(payload) ? payload : null;
  const rows = Array.isArray(envelope?.items)
    ? envelope.items
    : Array.isArray(payload)
      ? payload
      : null;
  if (rows === null) {
    return emptyReport('QTEST', 'the payload is neither an `items` envelope nor an array');
  }

  const cases: ImportedManualCase[] = [];
  const gaps: ManualImportGap[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      gaps.push({ externalId: null, detail: 'an `items` entry is not an object' });
      continue;
    }
    const pid = text(row.pid) ?? text(row.id);
    const title = text(row.name);
    if (pid === null || title === null) {
      gaps.push({ externalId: pid, detail: 'a qTest case with no pid/id or no name' });
      continue;
    }

    const rawSteps = Array.isArray(row.test_steps) ? row.test_steps : null;
    const structured =
      rawSteps === null
        ? null
        : rawSteps.map((step): RawStep => ({
            action: isPlainRecord(step) ? text(step.description) : null,
            expected: isPlainRecord(step) ? text(step.expected_result) : null,
          }));
    const reading = readSteps(structured, text(row.description));

    const properties = Array.isArray(row.properties) ? row.properties : [];
    const automationProperty = properties.find(
      (property) =>
        isPlainRecord(property) &&
        typeof property.field_name === 'string' &&
        /automat/i.test(property.field_name),
    );
    const automation = automationStatus(
      isPlainRecord(automationProperty) ? automationProperty.field_value : undefined,
    );
    if (automation.unrecognised !== null) {
      gaps.push({
        externalId: pid,
        detail:
          `the automation property is \`${automation.unrecognised}\`, which this reader does not ` +
          'map; recorded as NOT_STATED',
      });
    }

    cases.push(
      assemble('QTEST', options, {
        externalId: pid,
        title,
        reading,
        expectedResult: null,
        automation: automation.status,
        lastExecutedAt: suiteDate(row.last_executed_date),
        url: text(row.web_url),
        notes: [],
      }),
    );
  }

  const claimedTotal = typeof envelope?.total === 'number' ? envelope.total : null;
  return finishReport('QTEST', cases, gaps, claimedTotal, false);
}

// ─── CSV: the import that needs no credential ────────────────────────────────

/**
 * Splits CSV text into rows of fields, RFC 4180 style.
 *
 * Written out rather than taken from a dependency, and it handles the four
 * things a `split(',')` does not: a quoted field containing a comma, a quoted
 * field containing a NEWLINE (which is what makes a test case's steps column
 * work at all), a doubled quote as an escaped quote, and a UTF-8 BOM — which
 * Excel writes on every export and which otherwise becomes part of the first
 * header's name, so `id` is read as `\uFEFFid` and the whole import reports
 * "no id column".
 */
export function parseCsvRows(raw: string): string[][] {
  // Written as an escape, not as the character itself: a literal U+FEFF in
  // source is invisible in every editor, and a reader cannot review it.
  const text = raw.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF and a bare CR both end the row; the \n is consumed with it.
      if (text[index + 1] === '\n') index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  // A trailing newline must not produce a phantom empty row, and a file with no
  // trailing newline must not lose its last row. Both are this one condition.
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * The column names this reader looks for, in priority order.
 *
 * A list rather than one name per field because every export tool spells them
 * differently and a customer should not have to rename columns to be measured.
 * Matching is case-insensitive and ignores spaces and underscores, so
 * `Test Case ID`, `test_case_id` and `testcaseid` are one column.
 */
export const CSV_COLUMN_ALIASES = {
  externalId: ['id', 'key', 'caseid', 'testcaseid', 'testid', 'reference'],
  title: ['title', 'name', 'summary', 'testcasename'],
  steps: ['steps', 'teststeps', 'stepaction', 'action', 'testscript'],
  expected: ['expected', 'expectedresult', 'expectedresults', 'result'],
  automation: ['automation', 'automationstatus', 'automated', 'automationtype'],
  lastExecuted: ['lastexecuted', 'lastexecutedon', 'lastrun', 'lastexecutiondate'],
  url: ['url', 'link', 'weburl'],
} as const satisfies Record<string, readonly string[]>;

function normaliseHeader(raw: string): string {
  return raw.toLowerCase().replace(/[\s_\-.]/g, '');
}

/**
 * Reads a CSV export into cases.
 *
 * ── THE STEPS COLUMN, AND WHY IT IS NOT SPLIT BY DEFAULT ────────────────────
 *
 * A `steps` cell is prose. Some exports put one step per line, some put a
 * paragraph, and splitting on `\n` turns a two-sentence description into two
 * steps — a count that is wrong in the direction that makes a conversion look
 * complete. So the default is PROSE_NOT_SPLIT, and `splitStepsOnNewline` is an
 * opt-in the customer takes when they know their own export. Either way the
 * state says which happened, so the number is never silently one or the other.
 */
export function readCsvCases(
  raw: string,
  options: ManualReaderOptions & { splitStepsOnNewline?: boolean },
): ManualImportReport {
  const rows = parseCsvRows(raw);
  const header = rows[0];
  if (header === undefined || header.length === 0) {
    return emptyReport('CSV', 'the file has no header row, so no column could be identified');
  }

  const normalised = header.map((name) => normaliseHeader(name));
  const columnOf = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const index = normalised.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };
  const columns = {
    externalId: columnOf(CSV_COLUMN_ALIASES.externalId),
    title: columnOf(CSV_COLUMN_ALIASES.title),
    steps: columnOf(CSV_COLUMN_ALIASES.steps),
    expected: columnOf(CSV_COLUMN_ALIASES.expected),
    automation: columnOf(CSV_COLUMN_ALIASES.automation),
    lastExecuted: columnOf(CSV_COLUMN_ALIASES.lastExecuted),
    url: columnOf(CSV_COLUMN_ALIASES.url),
  };

  const gaps: ManualImportGap[] = [];
  if (columns.externalId < 0 || columns.title < 0) {
    return emptyReport(
      'CSV',
      'no id column and/or no title column was found among ' +
        `[${header.join(', ')}]; a case with no stable id cannot be re-imported without ` +
        'duplicating itself every night',
    );
  }
  if (columns.automation < 0) {
    /*
     * A payload-level gap and not a per-case one: the COLUMN is missing, so
     * every case is NOT_STATED for one reason, and saying it 1,840 times would
     * bury the per-case gaps that matter.
     */
    gaps.push({
      externalId: null,
      detail:
        'the export has no automation column, so every case is NOT_STATED; that is a count, ' +
        'never part of the automation backlog',
    });
  }

  const cell = (row: readonly string[], index: number): string | null => {
    if (index < 0) return null;
    const value = row[index];
    return value !== undefined && value.trim().length > 0 ? value.trim() : null;
  };

  const cases: ImportedManualCase[] = [];
  for (let line = 1; line < rows.length; line += 1) {
    const row = rows[line];
    if (row === undefined) continue;
    if (row.every((value) => value.trim().length === 0)) continue;

    const externalId = cell(row, columns.externalId);
    const title = cell(row, columns.title);
    if (externalId === null || title === null) {
      gaps.push({
        externalId,
        detail: `row ${line + 1} has no id and/or no title, so it was not imported`,
      });
      continue;
    }

    const stepsCell = cell(row, columns.steps);
    let structured: RawStep[] | null = null;
    let prose: string | null = null;
    if (columns.steps < 0) {
      // NO_FIELD: there is no steps column at all.
    } else if (stepsCell === null) {
      structured = [];
    } else if (options.splitStepsOnNewline === true) {
      structured = stepsCell
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry): RawStep => ({ action: entry, expected: null }));
    } else {
      prose = stepsCell;
    }
    const reading = readSteps(structured, prose);

    const automation = automationStatus(cell(row, columns.automation));
    if (automation.unrecognised !== null) {
      gaps.push({
        externalId,
        detail:
          `the automation column says \`${automation.unrecognised}\`, which this reader does not ` +
          'map; recorded as NOT_STATED rather than assumed',
      });
    }

    const url = cell(row, columns.url);
    cases.push(
      assemble('CSV', options, {
        externalId,
        title,
        reading,
        expectedResult: cell(row, columns.expected),
        automation: automation.status,
        lastExecutedAt: suiteDate(cell(row, columns.lastExecuted)),
        /*
         * A URL that is not a URL is dropped with a gap rather than passed to
         * the schema, which would throw and take the other 1,839 rows with it.
         */
        url: url !== null && /^https?:\/\//i.test(url) ? url : null,
        notes:
          url !== null && !/^https?:\/\//i.test(url)
            ? [`the url column holds \`${url}\`, which is not an http(s) URL; dropped`]
            : [],
      }),
    );
  }

  /*
   * A CSV never says how many cases it holds, so `claimedTotal` is null — and
   * that null is the honest answer rather than `cases.length`, which would
   * claim the file told us a total it never did and make a truncated export
   * undetectable.
   */
  return finishReport('CSV', cases, gaps, null, false);
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function emptyReport(source: ManualSuiteSource, reason: string): ManualImportReport {
  return {
    source,
    cases: [],
    gaps: [{ externalId: null, detail: reason }],
    claimedTotal: null,
    truncated: false,
    caveats: [
      `nothing was read from this ${source} payload: ${reason}. Zero cases here is OUR silence ` +
        'and must never be rendered as a suite with no cases',
    ],
  };
}

/**
 * Assembles a report and writes the caveats nobody should have to derive.
 *
 * `moreToFetch` is whatever the vendor's own "there is another page" signal is —
 * TestRail's `_links.next`, Zephyr's and Xray's `isLast: false`. A reader that
 * returns one page and reports no truncation is the undisclosed cap this
 * product may not ship, because the missing cases make the automation ratio go
 * UP.
 */
function finishReport(
  source: ManualSuiteSource,
  cases: ImportedManualCase[],
  gaps: ManualImportGap[],
  claimedTotal: number | null,
  moreToFetch: unknown,
): ManualImportReport {
  const more =
    moreToFetch === true ||
    (isPlainRecord(moreToFetch) && text(moreToFetch.next) !== null) ||
    (claimedTotal !== null && cases.length < claimedTotal);

  const caveats: string[] = [];
  if (more) {
    caveats.push(
      claimedTotal === null
        ? `this ${source} payload says another page exists; at least one more page of cases was ` +
          'not read'
        : `this ${source} payload reports ${claimedTotal} case(s) and ${cases.length} were read; ` +
          `at least ${claimedTotal - cases.length} more exist`,
    );
  }
  const prose = cases.filter((entry) => entry.steps === 'PROSE_NOT_SPLIT').length;
  if (prose > 0) {
    caveats.push(
      `${prose} case(s) hold their steps as prose and were NOT counted; their step count is ` +
        'unknown rather than zero',
    );
  }
  const noField = cases.filter((entry) => entry.steps === 'NO_FIELD').length;
  if (noField > 0) {
    caveats.push(
      `${noField} case(s) came from a payload with no steps field at all; that is our silence, ` +
        'not a suite with stepless cases',
    );
  }
  const notStated = cases.filter(
    (entry) => entry.case.automationStatus === 'NOT_STATED',
  ).length;
  if (notStated > 0) {
    caveats.push(
      `${notStated} case(s) carry no automation status; they are counted separately and must ` +
        'never be added to the automation backlog',
    );
  }
  if (!holdsManualSuite(source)) {
    caveats.push(
      `${source} is not a test-management system, so these cases must not be quoted as "your ` +
        'suite has N cases" alongside a tracker\'s issue count',
    );
  }

  return { source, cases, gaps, claimedTotal, truncated: more, caveats };
}

// ─── The paged fetch ─────────────────────────────────────────────────────────

/** Where each reader's pages come from, and how its paging is spelled. */
const SUITE_ENDPOINTS = {
  TESTRAIL: { path: 'index.php?/api/v2/get_cases', offsetKey: 'offset', limitKey: 'limit' },
  XRAY: { path: '/api/v2/graphql/tests', offsetKey: 'start', limitKey: 'limit' },
  ZEPHYR: { path: '/v2/testcases', offsetKey: 'startAt', limitKey: 'maxResults' },
  QTEST: { path: '/api/v3/test-cases', offsetKey: 'page', limitKey: 'pageSize' },
} as const satisfies Record<
  Exclude<ManualSuiteSource, 'CSV'>,
  { path: string; offsetKey: string; limitKey: string }
>;

/**
 * The vendor's OWN "is there another page" signal, read from the raw body.
 *
 * ── WHY THE FETCH LOOP CANNOT USE A PAGE'S `truncated` ──────────────────────
 *
 * `finishReport` judges a WHOLE payload: it compares the cases it holds against
 * the total the suite claims. Applied to one page of a multi-page read that
 * comparison is always true — page 2 of 3 holds fewer cases than the suite has
 * — so a loop driven by it fetches one extra page every time and then reports
 * `pages: 3` for a two-page suite. That is an extra unsolicited request at a
 * customer's API per import, and a page count nobody can reconcile.
 *
 * Three-valued, and the null is what keeps the loop honest: TRUE and FALSE are
 * the suite speaking (`isLast`, a `next` link), null means it said nothing and
 * the loop has to fall back to the short-page rule.
 */
function vendorHasMorePages(body: unknown): boolean | null {
  if (!isPlainRecord(body)) return null;
  if (typeof body.isLast === 'boolean') return !body.isLast;
  const links = isPlainRecord(body._links) ? body._links : null;
  if (links !== null) return text(links.next) !== null;
  return null;
}

/** The per-vendor mapper, so the fetch loop does not know four dialects. */
const SUITE_READERS = {
  TESTRAIL: readTestRailCases,
  XRAY: readXrayTests,
  ZEPHYR: readZephyrTests,
  QTEST: readQTestCases,
} as const satisfies Record<
  Exclude<ManualSuiteSource, 'CSV'>,
  (payload: unknown, options: ManualReaderOptions) => ManualImportReport
>;

export interface ManualImportCapBite {
  cap: 'PAGE_BUDGET';
  limit: number;
  bites: number;
  /** Cases the cap left unread, as a LOWER bound. */
  discarded: number;
  reason: string;
}

export interface ManualSuiteImport extends ManualImportReport {
  /** How many pages were fetched. */
  pages: number;
  /** The page cap, when it bit. Empty when it did not. */
  caps: ManualImportCapBite[];
}

/**
 * Fetches and reads a whole suite, one page at a time.
 *
 * ── THE ONE RULE THIS FUNCTION EXISTS TO HOLD ───────────────────────────────
 *
 * It stops for exactly three reasons and says which: the vendor said there is
 * no more, the page budget bit, or a page failed to load. The third is the one
 * that matters most, because "we read your suite and found 1,200 cases" said
 * about a suite whose fourth page 500'd is the lie rule 10 of this slice names:
 * "reconciled" claimed when a source failed to load and was skipped. A failed
 * page sets `truncated` AND files a gap AND writes a caveat, and the cases from
 * the pages that DID load are still returned — because throwing them away would
 * be a second wrong answer.
 */
export async function importManualSuite(input: {
  transport: ManualSuiteTransport;
  source: Exclude<ManualSuiteSource, 'CSV'>;
  options: ManualReaderOptions;
  /** Cases per page. The vendor's own maximum, when the caller knows it. */
  pageSize?: number;
  /** How many pages one import may fetch. Disclosed when it bites. */
  pageBudget?: number;
  /** Extra query parameters: a project id, a JQL filter. */
  query?: Record<string, string | number>;
}): Promise<ManualSuiteImport> {
  const pageSize = input.pageSize ?? 250;
  const pageBudget = input.pageBudget ?? 40;
  const endpoint = SUITE_ENDPOINTS[input.source];
  const read = SUITE_READERS[input.source];

  const cases: ImportedManualCase[] = [];
  const gaps: ManualImportGap[] = [];
  const caveats: string[] = [];
  const caps: ManualImportCapBite[] = [];
  let claimedTotal: number | null = null;
  let truncated = false;
  let pages = 0;

  for (let page = 0; ; page += 1) {
    if (pages >= pageBudget) {
      /*
       * `discarded` is a LOWER bound and is computed rather than guessed: when
       * the vendor told us a total we know exactly how many we left; when it
       * did not, we know only that at least one more page exists.
       */
      const left = claimedTotal === null ? 1 : Math.max(0, claimedTotal - cases.length);
      caps.push({
        cap: 'PAGE_BUDGET',
        limit: pageBudget,
        bites: 1,
        discarded: left,
        reason:
          `the page budget of ${pageBudget} was spent after ${cases.length} case(s); at least ` +
          `${left} more exist in this ${input.source} suite and were not read`,
      });
      truncated = true;
      break;
    }

    const offset = input.source === 'QTEST' ? page + 1 : page * pageSize;
    let response: ManualSuiteResponse;
    try {
      response = await input.transport.get({
        path: endpoint.path,
        query: {
          ...input.query,
          [endpoint.offsetKey]: offset,
          [endpoint.limitKey]: pageSize,
        },
      });
    } catch (err) {
      response = {
        status: null,
        body: null,
        error: `the page request threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    pages += 1;

    if (response.error !== null || response.status === null || response.status >= 400) {
      const why =
        response.error ??
        (response.status === null
          ? 'nothing answered'
          : `the suite answered ${response.status}`);
      gaps.push({
        externalId: null,
        detail: `page ${page + 1} failed to load: ${why}; the pages before it are still reported`,
      });
      caveats.push(
        `page ${page + 1} of this ${input.source} suite failed to load (${why}), so this import ` +
          'is PARTIAL: the case count below is a lower bound and nothing here is reconciled',
      );
      truncated = true;
      break;
    }

    const report = read(response.body, input.options);
    cases.push(...report.cases);
    gaps.push(...report.gaps);
    if (report.claimedTotal !== null) claimedTotal = report.claimedTotal;

    /*
     * FOUR STOPPING CONDITIONS, in the order that costs the fewest requests at
     * somebody else's API. Each one is a different fact and none of them is a
     * guess:
     *
     *  1. the suite said this is the last page;
     *  2. the page held nothing, so there is nothing after it either;
     *  3. we now hold every case the suite says exists;
     *  4. the suite said nothing about paging AND the page came back short,
     *     which is the only remaining evidence that it is the last one.
     *
     * A SHORT PAGE IS NOT ASSUMED TO BE THE LAST ONE when the suite does
     * report a total (case 3 handles that), because some installs return fewer
     * rows than asked for under load and stopping there would silently drop
     * the rest of the suite — the undisclosed cap this product may not ship.
     */
    const more = vendorHasMorePages(response.body);
    if (more === false) break;
    if (report.cases.length === 0) break;
    if (claimedTotal !== null && cases.length >= claimedTotal) break;
    if (more === null && claimedTotal === null && report.cases.length < pageSize) break;
  }

  const finished = finishReport(input.source, cases, gaps, claimedTotal, truncated);
  return {
    ...finished,
    truncated: truncated || finished.truncated,
    caveats: [...caveats, ...finished.caveats],
    pages,
    caps,
  };
}
