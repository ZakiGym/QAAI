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
import type { ApiTestSpec } from '@qaai/shared';
import { LlmError } from './llm.js';
import type { CallContext, LlmService } from './llm.js';

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
 * Pulls the path (and query) out of a Postman raw URL.
 *
 * Two things a naive implementation gets wrong, both caught in review:
 *  - A leading `{{baseUrl}}` maps to the environment's base URL and is stripped.
 *  - But a `{{var}}` *inside* the path (`/users/{{userId}}`) is a real template
 *    variable the QAAI API runner interpolates, so it is preserved verbatim.
 *    Replacing every `{{var}}` to force the string through `new URL()` baked the
 *    placeholder scheme into the middle of the path — the earlier bug.
 */
function extractPath(raw: string | undefined): string {
  if (!raw) return '/';

  // Drop a single leading base-URL variable, e.g. `{{baseUrl}}`.
  let rest = raw.replace(/^\s*\{\{[^}]+\}\}/, '');

  // If what remains still starts with a real scheme+host, parse that off —
  // mid-path `{{var}}` tokens survive because they are never at the front.
  if (/^https?:\/\//i.test(rest)) {
    try {
      const url = new URL(rest);
      rest = url.pathname + url.search;
    } catch {
      /* fall through to the string handling below */
    }
  }

  if (!rest) return '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
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
      const path = extractPath(raw);
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
}

/**
 * Converts code-based source files with the model. Postman is handled
 * deterministically by the caller before this is reached.
 *
 * One structured call per source file: batching several files into one prompt
 * saves round trips but loses the file→file mapping the coverage report needs,
 * and a single failed file should not sink the batch.
 */
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

  for (const file of args.files) {
    // Config and helper files carry no tests; converting them wastes tokens and
    // produces noise. The detector already told us the framework.
    if (/\.(config|conf)\.[jt]s$/.test(file.path)) continue;

    const prompt = `Source framework: ${FRAMEWORK_LABELS[args.framework]}
Source file: ${file.path}

${args.knownLocators?.length ? `Locators present on the live app (prefer these where they fit):\n${args.knownLocators.slice(0, 30).join('\n')}\n` : ''}
SOURCE:
${file.content.slice(0, 20000)}

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
          notes: t.notes,
        });
      }
      summaries.push(`${file.path}: ${result.summary}`);
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

  return {
    tests,
    summary: `Converted ${tests.length} test(s) from ${args.files.length} source file(s).\n${summaries.join('\n')}`,
  };
}
