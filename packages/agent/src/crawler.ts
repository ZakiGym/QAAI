/**
 * The Explorer's crawl step (§3.1) — deterministic, no LLM.
 *
 * Walks the app breadth-first with Playwright, reading the DOM and the
 * accessibility tree (screenshots only as a fallback, per spec) and building a
 * Flow Map: pages, states, forms, roles, and the transitions between them.
 *
 * Keeping this LLM-free matters. The model's job is to decide what is worth
 * testing; deciding what *exists* is a graph traversal, and doing it in code
 * makes it cheap, repeatable, and diffable version to version.
 */

import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { FlowEdge, FlowMap, FlowNode, FormField, FormModel, Selector } from '@qaai/shared';

export interface CrawlOptions {
  baseUrl: string;
  projectId: string;
  environmentId: string;
  version: number;
  /** Hard caps so a crawl of a large app terminates. */
  maxPages: number;
  maxDepth: number;
  maxMillis: number;
  /** Playwright storageState, when an auth profile applies (§2). */
  storageState?: unknown;
  /** Paths never visited — logout links would end the session mid-crawl. */
  excludePatterns?: RegExp[];
  onProgress?: (message: string) => void;
}

const DEFAULT_EXCLUDES = [
  /\/logout\b/i,
  /\/sign[-_]?out\b/i,
  /\/__reset\b/,
  // Destructive-looking verbs — never followed, even if linked.
  /\/delete\b/i,
  /\/destroy\b/i,
];

/** Collapses `/orders/ORD-1001` → `/orders/:id` so states group sensibly. */
export function normaliseRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment))
        return ':id';
      // Mixed alphanumerics with digits: ORD-1001, cus_a1b2, sku12345.
      if (/\d/.test(segment) && /[a-z]/i.test(segment) && segment.length > 3) return ':id';
      return segment;
    })
    .join('/');
}

/** Guesses what a field wants so the faker can fill it sensibly (§2). */
export function semanticFor(name: string, type: string, label: string): FormField['semantic'] {
  const hay = `${name} ${label} ${type}`.toLowerCase();
  if (type === 'email' || /\bemail\b/.test(hay)) return 'email';
  if (type === 'password' || /\bpassword\b|\bpasswd\b/.test(hay)) return 'password';
  if (type === 'search' || /\bsearch\b|\bquery\b/.test(hay)) return 'search';
  if (type === 'tel' || /\bphone\b|\btel\b|\bmobile\b/.test(hay)) return 'phone';
  if (/\bcvc\b|\bcvv\b|security ?code/.test(hay)) return 'card_cvc';
  if (/\bexp(iry|iration)?\b/.test(hay)) return 'card_expiry';
  if (/\bcard\b|\bcc[-_]?number\b/.test(hay)) return 'credit_card';
  if (/\bpostal\b|\bzip\b|\bpostcode\b/.test(hay)) return 'postal_code';
  if (/\bcountry\b/.test(hay)) return 'country';
  if (/\bcity\b|\btown\b/.test(hay)) return 'city';
  if (/\baddress\b|\bstreet\b/.test(hay)) return 'street_address';
  if (/\bname\b/.test(hay)) return 'person_name';
  if (type === 'date' || /\bdate\b|\bdob\b/.test(hay)) return 'date';
  if (type === 'number' || /\bquantity\b|\bqty\b|\bamount\b/.test(hay)) return 'number';
  if (type === 'textarea' || /\bmessage\b|\bcomment\b|\bnotes?\b/.test(hay)) return 'freeform';
  if (type === 'text') return 'freeform';
  return 'unknown';
}

/**
 * Builds the most resilient locator available for an element (§3.2).
 *
 * Order matters: role+name survives restyling and re-layout; a CSS path breaks
 * the first time someone touches the markup. Confidence is the number the
 * Generator uses to decide whether to flag a test for human review.
 */
async function bestSelector(locator: Locator, fallbackCss: string): Promise<Selector> {
  const info = await locator
    .evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const labels = (el as HTMLInputElement).labels;
      return {
        role: el.getAttribute('role'),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        ariaLabel: el.getAttribute('aria-label'),
        testId: el.getAttribute('data-testid') ?? el.getAttribute('data-test-id'),
        placeholder: el.getAttribute('placeholder'),
        label: labels && labels.length > 0 ? (labels[0]?.textContent ?? '').trim() : null,
        text: (htmlEl.innerText ?? el.textContent ?? '').trim().slice(0, 80),
      };
    })
    .catch(() => null);

  if (!info) return { strategy: 'CSS', value: fallbackCss, confidence: 0.3 };

  const implicitRole =
    info.role ??
    (
      {
        a: 'link',
        button: 'button',
        select: 'combobox',
        textarea: 'textbox',
        h1: 'heading',
        h2: 'heading',
        h3: 'heading',
      } as Record<string, string>
    )[info.tag] ??
    (info.tag === 'input'
      ? info.type === 'checkbox'
        ? 'checkbox'
        : info.type === 'radio'
          ? 'radio'
          : info.type === 'submit' || info.type === 'button'
            ? 'button'
            : 'textbox'
      : null);

  const accessibleName = info.ariaLabel ?? info.label ?? info.text;

  if (implicitRole && accessibleName) {
    return { strategy: 'ROLE', value: implicitRole, name: accessibleName, confidence: 0.95 };
  }
  if (info.label) return { strategy: 'LABEL', value: info.label, confidence: 0.9 };
  if (info.testId) return { strategy: 'TEST_ID', value: info.testId, confidence: 0.85 };
  if (info.placeholder)
    return { strategy: 'PLACEHOLDER', value: info.placeholder, confidence: 0.7 };
  if (info.text) return { strategy: 'TEXT', value: info.text, confidence: 0.6 };
  return { strategy: 'CSS', value: fallbackCss, confidence: 0.3 };
}

async function extractForms(page: Page): Promise<FormModel[]> {
  const forms: FormModel[] = [];
  const formLocators = await page.locator('form').all();

  for (const [formIndex, form] of formLocators.entries()) {
    const action = (await form.getAttribute('action')) ?? '';
    const method = ((await form.getAttribute('method')) ?? 'get').toLowerCase();
    const cssPath = `form:nth-of-type(${formIndex + 1})`;

    const fields: FormField[] = [];
    const controls = await form.locator('input, select, textarea').all();

    for (const [controlIndex, control] of controls.entries()) {
      const type = (
        (await control.getAttribute('type')) ??
        (await control.evaluate((el) => el.tagName.toLowerCase()))
      ).toLowerCase();
      // Hidden inputs are real but not something a human fills in; the
      // Generator does not need them and they clutter the plan prompt.
      if (type === 'hidden') continue;

      const name = (await control.getAttribute('name')) ?? `field-${controlIndex}`;
      const label = await control
        .evaluate((el: Element) => {
          const labels = (el as HTMLInputElement).labels;
          return labels && labels.length > 0 ? (labels[0]?.textContent ?? '').trim() : null;
        })
        .catch(() => null);

      const options =
        type === 'select'
          ? await control
              .locator('option')
              .allTextContents()
              .then((texts) => texts.map((t) => t.trim()).filter(Boolean))
              .catch(() => undefined)
          : undefined;

      fields.push({
        name,
        label,
        inputType: type,
        required: (await control.getAttribute('required')) !== null,
        selector: await bestSelector(control, `${cssPath} [name="${name}"]`),
        semantic: semanticFor(name, type, label ?? ''),
        ...(options && options.length > 0 ? { options } : {}),
      });
    }

    const submit = form
      .locator('button[type="submit"], input[type="submit"], button:not([type])')
      .first();
    const hasSubmit = (await submit.count()) > 0;

    forms.push({
      id: `form-${formIndex}`,
      name: action ? `${method.toUpperCase()} ${action}` : `Form ${formIndex + 1}`,
      selector: { strategy: 'CSS', value: cssPath, confidence: 0.5 },
      fields,
      submit: hasSubmit ? await bestSelector(submit, `${cssPath} [type="submit"]`) : null,
    });
  }

  return forms;
}

/**
 * Distinguishes states that share a route. Two visits to /cart are different
 * nodes if one has items and one does not — and that difference is exactly
 * where the interesting tests live.
 */
async function stateKeyFor(page: Page): Promise<string> {
  const signals = await page
    .evaluate(() => {
      const body = document.body;
      return {
        headings: Array.from(document.querySelectorAll('h1'))
          .map((h) => (h.textContent ?? '').trim())
          .join('|'),
        formCount: document.querySelectorAll('form').length,
        rowCount: document.querySelectorAll('tbody tr').length,
        empty: /your cart is empty|no orders yet|no products match/i.test(body.innerText ?? ''),
      };
    })
    .catch(() => null);

  if (!signals) return 'default';
  return [
    signals.headings.slice(0, 40),
    `f${signals.formCount}`,
    `r${signals.rowCount > 0 ? 'many' : 'none'}`,
    signals.empty ? 'empty' : 'populated',
  ].join('/');
}

/** A page is behind an auth wall when we were bounced to a sign-in screen. */
function looksLikeAuthWall(finalUrl: string, requestedUrl: string): boolean {
  if (finalUrl === requestedUrl) return false;
  return /\/(login|signin|sign-in|auth)\b/i.test(new URL(finalUrl).pathname);
}

export async function crawl(options: CrawlOptions): Promise<FlowMap> {
  const excludes = [...DEFAULT_EXCLUDES, ...(options.excludePatterns ?? [])];
  const origin = new URL(options.baseUrl).origin;
  const deadline = Date.now() + options.maxMillis;
  const progress = options.onProgress ?? (() => {});

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const seenStates = new Map<string, string>(); // route+stateKey → nodeId
  const queued = new Set<string>();
  const queue: Array<{ url: string; depth: number; from: string | null; action: string }> = [];

  let browser: Browser | null = null;
  let truncatedReason: string | null = null;

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      ...(options.storageState ? { storageState: options.storageState as never } : {}),
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    queue.push({ url: options.baseUrl, depth: 0, from: null, action: 'start' });
    queued.add(options.baseUrl);

    while (queue.length > 0) {
      if (nodes.length >= options.maxPages) {
        truncatedReason = `Stopped at the ${options.maxPages}-page cap`;
        break;
      }
      if (Date.now() > deadline) {
        truncatedReason = `Stopped after ${Math.round(options.maxMillis / 1000)}s`;
        break;
      }

      const item = queue.shift()!;
      progress(`Visiting ${item.url}`);

      let finalUrl = item.url;
      try {
        const response = await page.goto(item.url, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        finalUrl = page.url();
        // 4xx/5xx pages are still states worth knowing about, but they have no
        // outgoing journeys worth following.
        if (response && response.status() >= 400) {
          progress(`  ${response.status()} at ${item.url}`);
        }
      } catch {
        progress(`  could not load ${item.url}`);
        continue;
      }

      const route = normaliseRoute(new URL(finalUrl).pathname);
      const stateKey = await stateKeyFor(page);
      const stateId = `${route}#${stateKey}`;

      let nodeId = seenStates.get(stateId);
      if (!nodeId) {
        nodeId = `node-${nodes.length}`;
        seenStates.set(stateId, nodeId);

        nodes.push({
          id: nodeId,
          route,
          url: finalUrl,
          title: await page.title().catch(() => route),
          stateKey,
          requiresRoles: [],
          behindAuth: looksLikeAuthWall(finalUrl, item.url),
          forms: await extractForms(page),
          affordances: [],
          screenshotKey: null,
          a11yViolationCount: 0,
        });
      }

      if (item.from) {
        edges.push({
          id: `edge-${edges.length}`,
          from: item.from,
          to: nodeId,
          action: item.action,
          selector: null,
        });
      }

      if (item.depth >= options.maxDepth) continue;

      // Same-origin links only. Following outbound links would crawl the
      // internet, and the app under test ends at its own origin.
      const hrefs = await page
        .locator('a[href]')
        .evaluateAll((anchors) =>
          anchors.map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: ((a as HTMLAnchorElement).innerText ?? '').trim().slice(0, 60),
          })),
        )
        .catch(() => []);

      for (const { href, text } of hrefs) {
        let target: URL;
        try {
          target = new URL(href);
        } catch {
          continue;
        }
        if (target.origin !== origin) continue;
        target.hash = '';
        const normalised = target.toString();
        if (queued.has(normalised)) continue;
        if (excludes.some((re) => re.test(target.pathname))) continue;

        queued.add(normalised);
        queue.push({
          url: normalised,
          depth: item.depth + 1,
          from: nodeId,
          action: text ? `click "${text}"` : `open ${target.pathname}`,
        });
      }

      // Buttons are recorded as affordances rather than followed: clicking an
      // arbitrary button during discovery can mutate state or place an order.
      const node = nodes.find((n) => n.id === nodeId)!;
      if (node.affordances.length === 0) {
        const buttons = await page.locator('button, input[type="submit"]').all();
        for (const button of buttons.slice(0, 20)) {
          const label = (await button.innerText().catch(() => '')).trim();
          if (!label) continue;
          node.affordances.push({
            label,
            selector: await bestSelector(button, 'button'),
            kind: 'button',
          });
        }
      }
    }

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
  }

  return {
    projectId: options.projectId,
    environmentId: options.environmentId,
    version: options.version,
    baseUrl: options.baseUrl,
    nodes,
    edges,
    journeys: deriveJourneys(nodes, edges),
    features: groupIntoFeatures(nodes),
    exploredAt: new Date().toISOString(),
    truncatedReason,
  };
}

/**
 * Every shortest path from the entry node to a leaf is a candidate journey.
 * These are raw material for the plan prompt, not the plan itself — the model
 * decides which ones are worth a test and what to assert.
 */
function deriveJourneys(nodes: FlowNode[], edges: FlowEdge[]): FlowMap['journeys'] {
  if (nodes.length === 0) return [];

  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const journeys: FlowMap['journeys'] = [];
  const root = nodes[0]!.id;
  const seen = new Set<string>([root]);
  const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: root, path: [] }];

  while (queue.length > 0 && journeys.length < 40) {
    const { nodeId, path } = queue.shift()!;
    const next = outgoing.get(nodeId) ?? [];

    if (next.length === 0 && path.length > 0) {
      const target = nodes.find((n) => n.id === nodeId);
      journeys.push({
        id: `journey-${journeys.length}`,
        name: target ? `Reach ${target.title || target.route}` : `Path ${journeys.length}`,
        description: `${path.length}-step path ending at ${target?.route ?? nodeId}`,
        edgeIds: path,
        // Anything gated is on a critical path almost by definition; depth is a
        // rough proxy for importance beyond that.
        priority: target?.behindAuth
          ? 'CRITICAL_PATH'
          : path.length <= 2
            ? 'IMPORTANT'
            : 'NICE_TO_HAVE',
        roles: target?.requiresRoles ?? [],
      });
      continue;
    }

    for (const edge of next) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ nodeId: edge.to, path: [...path, edge.id] });
    }
  }

  return journeys;
}

/** First path segment as the feature name — crude, but it matches how apps are laid out. */
function groupIntoFeatures(nodes: FlowNode[]): FlowMap['features'] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const segment = node.route.split('/').filter(Boolean)[0] ?? 'home';
    const name = segment.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    groups.set(name, [...(groups.get(name) ?? []), node.id]);
  }
  return [...groups.entries()].map(([name, nodeIds]) => ({ name, nodeIds }));
}
