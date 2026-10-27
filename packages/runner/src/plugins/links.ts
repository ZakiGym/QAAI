/**
 * Link and asset integrity (§4 LINKS).
 *
 * The crawler sees every `<a href>`, every `<script src>` and every
 * `<img src>` on every page it reaches, and until this file nothing in the
 * product ever asked whether those edges RESOLVE. The denominator counted the
 * graph; nobody checked the arrows. So a site could enumerate 3,000 routes,
 * score a coverage number, and ship with a 404 in the footer of all 3,000 —
 * because "covered" meant a test mentioned the page, not that the page worked.
 *
 * This is the cheapest wide layer QAAI can have: no model, no browser, one
 * conditional request per DISTINCT target, and it applies to every crawled URL
 * of every customer.
 *
 * ── Six defects, and why each is separate ───────────────────────────────────
 *
 *   DEAD_LINK        an `<a>` target the server says is gone.
 *   DEAD_ASSET       a script, stylesheet or image the server says is gone.
 *                    Separate from DEAD_LINK because it is worse: a dead link
 *                    disappoints a visitor who clicks it, a dead script breaks
 *                    the page for everyone who loads it.
 *   REDIRECT_LOOP    a chain that comes back to a URL it already visited. The
 *                    page is unreachable and every crawler burns its budget on
 *                    it.
 *   HTTPS_DOWNGRADE  an `https` page linking to `http`, or a chain that steps
 *                    down mid-flight. The request leaves the tunnel.
 *   MIXED_CONTENT    the same downgrade on a SUBRESOURCE, which browsers
 *                    block outright — so this one is a broken page, not a
 *                    warning.
 *   ORPHAN_PAGE      enumerated and reachable by no link. Nobody can navigate
 *                    to it, and it is the one defect in this list that is
 *                    invisible to a crawl on its own: it needs the ENUMERATION
 *                    to compare against.
 *
 * ── DEDUPE BY TARGET, COUNT THE OCCURRENCES ─────────────────────────────────
 *
 * One broken footer link on 400 pages is ONE finding with 400 occurrences, not
 * 400 findings. This is not tidiness. A report with 400 rows for one defect is
 * a report nobody reads to the end, so the other nineteen defects underneath it
 * are never seen — the noise does the same damage as a miss. It also means the
 * same URL is requested ONCE no matter how many pages carry it, which is what
 * makes this layer cheap enough to run on every crawl.
 *
 * ── AN EXTERNAL LINK THAT TIMES OUT IS UNKNOWN, NOT BROKEN ──────────────────
 *
 * QAAI must never report a customer's partner site as the customer's defect.
 * A request that did not complete says nothing — our network, their network,
 * their firewall, a bot wall — and a 403, 408 or 429 from somebody else's
 * origin is indistinguishable from bot-blocking. Those are UNKNOWN. So is an
 * external 5xx, which is a third party's outage rather than a dead link. What
 * IS the customer's defect: an external 404 or 410, because the server is
 * stating positively that the thing they linked to is gone.
 *
 * See {@link classifyTarget}, which is the whole of that judgement in one pure
 * function, tested directly.
 *
 * ── NO QUERY STRING IS EVER REPORTED ────────────────────────────────────────
 *
 * The full URL is REQUESTED and is the dedupe key; the printed form has its
 * query and fragment dropped. A crawl of a password-reset page carries
 * `?token=…` on the page URL and a `<script src>` carries `?key=…`, and both
 * reached `Finding.location` verbatim before {@link printableUrl} existed —
 * from where they are stored on the result row, exported into a SARIF file
 * teams upload to GitHub, and rendered in the cockpit. Redirect hops and a
 * prober's own error text get the same treatment, because a `Location` header
 * is where an OAuth code lives. The count of URLs this shortened is disclosed.
 *
 * ── Injected transport (rule 8) ─────────────────────────────────────────────
 *
 * There is no network in this file's tests and no browser anywhere in it. The
 * prober and the clock are injected; the one real adapter is thin and reports
 * UNAVAILABLE when it is absent, because a stub that answered 200 would make
 * every link in the product resolve against nothing at all.
 */

import { z } from 'zod';
import type {
  ConsoleEntry,
  ExecutableTest,
  Finding,
  FindingKind,
  FindingSeverity,
  RunContext,
  StepResult,
  TestExecution,
} from '@qaai/shared';

// ─── The defect axis ─────────────────────────────────────────────────────────

/** The six integrity defects a resolved edge can have. See the header. */
export const LINK_DEFECTS = [
  'DEAD_LINK',
  'DEAD_ASSET',
  'REDIRECT_LOOP',
  'HTTPS_DOWNGRADE',
  'MIXED_CONTENT',
  'ORPHAN_PAGE',
] as const;
export type LinkDefect = (typeof LINK_DEFECTS)[number];

/**
 * The compiler-enforced presence record this codebase requires beside a
 * vocabulary with a write path, paired with the run-time parity test in
 * links.test.ts.
 *
 * Both halves, because eight GateRule kinds shipped unsaveable for two slices
 * when only one of them existed: the zod enum accepted a kind no branch
 * honoured, and `check:wiring` cannot see that class of defect. `checks` on the
 * spec below IS a write path — a stored test names the defects it asks for — so
 * the compiler refuses to let this record drift from the union, and the test
 * refuses to let either drift from `linkDefectSchema.options`.
 */
export const LINK_DEFECT_PRESENCE: Record<LinkDefect, true> = {
  DEAD_LINK: true,
  DEAD_ASSET: true,
  REDIRECT_LOOP: true,
  HTTPS_DOWNGRADE: true,
  MIXED_CONTENT: true,
  ORPHAN_PAGE: true,
};

export const LINK_DEFECT_LABELS: Record<LinkDefect, string> = {
  DEAD_LINK: 'Dead link',
  DEAD_ASSET: 'Dead asset',
  REDIRECT_LOOP: 'Redirect loop',
  HTTPS_DOWNGRADE: 'HTTPS downgrade',
  MIXED_CONTENT: 'Mixed content',
  ORPHAN_PAGE: 'Orphan page',
};

/**
 * How bad each defect is, in the plugins' own four-word vocabulary.
 *
 * MIXED_CONTENT outranks HTTPS_DOWNGRADE because a browser BLOCKS a
 * subresource over http on an https page — the page is already broken for
 * every visitor — whereas a downgraded `<a>` is a link that still works and
 * should not.
 */
export const LINK_DEFECT_SEVERITY: Record<LinkDefect, FindingSeverity> = {
  DEAD_ASSET: 'SERIOUS',
  MIXED_CONTENT: 'SERIOUS',
  DEAD_LINK: 'MODERATE',
  REDIRECT_LOOP: 'MODERATE',
  HTTPS_DOWNGRADE: 'MODERATE',
  ORPHAN_PAGE: 'MINOR',
};

/**
 * Which defects become a `Finding` row, and which ride on steps alone.
 *
 * `FINDING_KINDS` has five members — ACCESSIBILITY, SECURITY, PERFORMANCE,
 * LOCALIZATION, VISUAL — and link integrity is none of them. Two of these six
 * genuinely ARE security defects and are filed as such: a request that leaves
 * the TLS tunnel is the same class of problem `security-smoke.ts` files for a
 * missing `Strict-Transport-Security`. The other four have no honest kind in
 * that vocabulary, and `null` here is that fact rather than a shrug — filing a
 * dead image as ACCESSIBILITY to get it a row would be a measurement attributed
 * to an axis that did not measure it, which is the one thing this product
 * cannot do.
 *
 * Those four are still fully reported: a FAILED step per distinct target, with
 * the occurrence count and the reason. What they lack is the cross-run dedupe
 * that `Finding.code` gives, and the handover for this round asks for a
 * `LINK_INTEGRITY` member of `FINDING_KINDS` (shared + the Prisma enum + a
 * migration, none of which this change owns). When it arrives this map is the
 * only place that changes.
 */
export const LINK_DEFECT_FINDING_KIND: Record<LinkDefect, FindingKind | null> = {
  HTTPS_DOWNGRADE: 'SECURITY',
  MIXED_CONTENT: 'SECURITY',
  DEAD_LINK: null,
  DEAD_ASSET: null,
  REDIRECT_LOOP: null,
  ORPHAN_PAGE: null,
};

/** Stable `Finding.code` per defect. Prefixed, so it cannot collide with another plugin's. */
export const LINK_DEFECT_CODES: Record<LinkDefect, string> = {
  DEAD_LINK: 'link-dead-link',
  DEAD_ASSET: 'link-dead-asset',
  REDIRECT_LOOP: 'link-redirect-loop',
  HTTPS_DOWNGRADE: 'link-https-downgrade',
  MIXED_CONTENT: 'link-mixed-content',
  ORPHAN_PAGE: 'link-orphan-page',
};

export const linkDefectSchema = z.enum(LINK_DEFECTS);

// ─── The spec ────────────────────────────────────────────────────────────────

/** `<a>` or a subresource. The distinction decides two of the six defects. */
export const LINK_EDGE_KINDS = ['LINK', 'ASSET'] as const;
export type LinkEdgeKind = (typeof LINK_EDGE_KINDS)[number];
export const linkEdgeKindSchema = z.enum(LINK_EDGE_KINDS);

export const linkEdgeSchema = z.object({
  /** As written in the document — relative hrefs are resolved against the page. */
  href: z.string().min(1).max(4000),
  kind: linkEdgeKindSchema.default('LINK'),
  /** Where on the page, so a report can point at it. */
  selector: z.string().max(500).nullable().default(null),
});
export type LinkEdge = z.infer<typeof linkEdgeSchema>;

export const linkPageSchema = z.object({
  /** Absolute URL of the page the edges were found on. */
  url: z.string().min(1).max(4000),
  edges: z.array(linkEdgeSchema).default([]),
});

export const linksTestSpecSchema = z.object({
  /**
   * The pages the crawl reached and the edges each one carried.
   *
   * Passed IN rather than re-crawled: the crawl already did this work, and a
   * second crawl here would be a different graph measured at a different
   * moment, which is how two surfaces come to disagree about the same site.
   */
  pages: z.array(linkPageSchema).min(1),
  /**
   * Every URL the ENUMERATION knows about, for the orphan check.
   *
   * Empty is the normal state for a project with no enumeration yet, and an
   * empty list means the orphan check is NOT MEASURED — never "zero orphans".
   * A zero-denominator check reporting a clean result is the same lie as a
   * coverage percentage of 100 over nothing.
   */
  enumerated: z.array(z.string().min(1).max(4000)).default([]),
  /**
   * Which defects to check for. Opt-out rather than opt-in, because all six
   * come off the same probes and cost nothing extra — but a check that is NOT
   * in this list is disclosed as unchecked rather than silently passing.
   */
  checks: z
    .array(linkDefectSchema)
    .min(1)
    .default([...LINK_DEFECTS]),
  /** Origins to treat as the customer's own besides the base URL's. */
  internalOrigins: z.array(z.string().min(1).max(500)).default([]),
  /** Probe targets on origins other than the internal ones at all. */
  checkExternal: z.boolean().default(true),
  /**
   * The most DISTINCT targets to probe. When it bites the remainder are
   * UNCHECKED and the count and the reason are both reported (rule 10).
   */
  maxTargets: z.number().int().min(1).max(20_000).default(500),
  /** Redirect hops to follow before giving up. Giving up is UNKNOWN, not a loop. */
  maxRedirectHops: z.number().int().min(1).max(20).default(5),
  /** The rate limit. Disclosed in the result whether or not it cost anything. */
  requestsPerSecond: z.number().min(0.1).max(200).default(10),
  /** Wall-clock budget for the whole probe phase. Also a disclosed cap. */
  budgetMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
  /** Example occurrences listed per target. The TRUE count is always reported. */
  maxOccurrencesPerTarget: z.number().int().min(1).max(500).default(20),
});
export type LinksTestSpec = z.infer<typeof linksTestSpecSchema>;

// ─── The injected transport ──────────────────────────────────────────────────

/**
 * One request's outcome, as the prober reports it.
 *
 * `status: null` is "the request did not complete" and is NOT a status of 0.
 * Every judgement downstream reads null as UNKNOWN, which is the only reading
 * that cannot turn our own failed request into the customer's bug.
 */
export interface LinkProbeResult {
  status: number | null;
  /** `Location` exactly as the server sent it, when the status is a redirect. */
  location: string | null;
  /** Why the request did not complete. Null when it did. */
  error: string | null;
}

/**
 * The network, as this plugin needs it.
 *
 * One method, because one method is all six defects need: a conditional
 * request that reports a status and a `Location`. Narrow enough to be satisfied
 * by `fetch`, by a Playwright `APIRequestContext`, by an http.Agent with a
 * proxy, and by a fake in a test — which is the point.
 */
export interface LinkProber {
  probe(url: string, signal: AbortSignal): Promise<LinkProbeResult>;
}

/** Injected so tests do not sleep and a cancelled run stops pacing. */
export interface LinkClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realLinkClock: LinkClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

export interface LinksDeps {
  prober: LinkProber;
  clock?: LinkClock;
}

/**
 * The prober this plugin uses when nothing configured one.
 *
 * Not built, and reported as not built. Reaching a customer's origins means
 * their allow-list, their proxy and often their credentials — none of which is
 * a `process.env` entry (rule 4). A stub that returned `{ status: 200 }` would
 * declare every link in the product healthy on the strength of a fake, which is
 * worse than having no plugin: it would move a number.
 */
export const unavailableLinkProber: LinkProber = {
  probe() {
    return Promise.resolve({
      status: null,
      location: null,
      error:
        'No HTTP prober is configured for this environment, so no link was requested. QAAI can ' +
        'check dead links, dead assets, redirect loops, HTTPS downgrades, mixed content and ' +
        'orphan pages — it needs a prober that is allowed to reach your origins to do it. ' +
        'Nothing was measured.',
    });
  },
};

// ─── The rate limit ──────────────────────────────────────────────────────────

/**
 * A minimum interval between probes, and a record of what it cost.
 *
 * The record is the part that matters. Rule 10: a cap that BIT must be reported
 * as a count and as a reason. A pacer that silently slowed a run would turn
 * into "the link check takes four minutes" with nothing in the report saying
 * why, and the first person to debug it would look at the customer's servers.
 */
export class ProbePacer {
  private lastStartedAt: number | null = null;
  private pausedMs = 0;
  private pauses = 0;

  constructor(
    readonly minIntervalMs: number,
    private readonly clock: LinkClock,
  ) {}

  /** Wait until the next probe is allowed. */
  async pace(signal: AbortSignal): Promise<void> {
    const last = this.lastStartedAt;
    if (last !== null) {
      const wait = this.minIntervalMs - (this.clock.now() - last);
      if (wait > 0) {
        this.pausedMs += wait;
        this.pauses += 1;
        await this.clock.sleep(wait, signal);
      }
    }
    this.lastStartedAt = this.clock.now();
  }

  /** Null when the limiter never had to pause — "it did not bite", not "0ms". */
  get cost(): { pausedMs: number; pauses: number } | null {
    return this.pauses === 0 ? null : { pausedMs: this.pausedMs, pauses: this.pauses };
  }
}

// ─── Resolving edges to targets ──────────────────────────────────────────────

/**
 * Why an href produced no HTTP target.
 *
 * Reported rather than dropped, and split three ways because the three mean
 * different things to the reader: a `mailto:` is correct and uncheckable, an
 * unparseable href is probably a bug in the page, and a fragment-only href
 * points at the document it is already in.
 */
export const UNRESOLVED_HREF_REASONS = ['NOT_HTTP', 'UNPARSEABLE', 'SAME_DOCUMENT'] as const;
export type UnresolvedHrefReason = (typeof UNRESOLVED_HREF_REASONS)[number];

export const UNRESOLVED_HREF_LABELS: Record<UnresolvedHrefReason, string> = {
  NOT_HTTP: 'not an http(s) URL (mailto:, tel:, javascript:, data: …)',
  UNPARSEABLE: 'could not be parsed as a URL',
  SAME_DOCUMENT: 'points at the page it was found on',
};

export type ResolvedHref =
  { ok: true; target: string } | { ok: false; reason: UnresolvedHrefReason };

/**
 * Resolve one href against the page that carried it.
 *
 * The fragment is DROPPED, because `/pricing#plans` and `/pricing#faq` are one
 * document and one request. Keeping them apart would have requested the same
 * page twice and reported one dead link as two.
 */
export function resolveHref(href: string, pageUrl: string): ResolvedHref {
  let resolved: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ok: false, reason: 'UNPARSEABLE' };
  }
  try {
    resolved = new URL(href, page);
  } catch {
    return { ok: false, reason: 'UNPARSEABLE' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, reason: 'NOT_HTTP' };
  }
  resolved.hash = '';
  const target = resolved.toString();

  const self = new URL(page.toString());
  self.hash = '';
  if (target === self.toString()) return { ok: false, reason: 'SAME_DOCUMENT' };

  return { ok: true, target };
}

/**
 * A URL as it is safe to PRINT, with the query string and the fragment gone.
 *
 * Every string this plugin REPORTS goes through here — a step title, a
 * `Finding.message`, a `Finding.location`, an example site, a redirect hop. The
 * full URL survives only where it is needed for the REQUEST and for the dedupe
 * key, neither of which leaves this module.
 *
 * ── The defect this removes ─────────────────────────────────────────────────
 *
 * A crawl of a password-reset page carries `?token=…` on the PAGE url, and an
 * `<script src="…?key=…">` carries an API key on the TARGET. Before this, both
 * reached `Finding.location` and the step titles verbatim — and those are
 * stored on the TestResult row, exported through the SARIF reporter into a file
 * teams upload to GitHub code scanning, and rendered in the cockpit. A reset
 * token in a third party's alert database is not a QA finding, it is a
 * disclosure.
 *
 * The harness's own observer has dropped the query since the day it was
 * written, for exactly this reason (`__qaaiSafeUrl`). This file was the half of
 * the same round that did not, and the leak was reachable on the success path,
 * not only in an error branch.
 *
 * DROPPED, not masked and not truncated: a truncated token is still a token,
 * and the path is the whole of what a reader needs to find the link.
 */
export function printableUrl(raw: string): { url: string; dropped: boolean } {
  try {
    const parsed = new URL(raw);
    const dropped = parsed.search !== '' || parsed.hash !== '';
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.toString(), dropped };
  } catch {
    // Unparseable, so the query cannot be removed structurally. Cut at the
    // first delimiter instead — the one case where a string compare has to do.
    const cut = raw.replace(/[?#].*$/s, '');
    return { url: cut, dropped: cut.length !== raw.length };
  }
}

/** Shorthand for the many report strings that only need the safe form. */
function printed(raw: string): string {
  return printableUrl(raw).url;
}

/**
 * The same removal applied to free text QAAI did not write.
 *
 * A prober's own error message quotes the URL it failed on — `fetch failed:
 * https://host/reset?token=…` — and that message is printed verbatim in the
 * UNKNOWN detail. Redacting the target and then printing the token back out in
 * the reason beside it would have been a leak with a straight face, and this is
 * the ERROR path, which is where they actually survive review.
 */
export function scrubUrlsInText(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, (match) => printed(match));
}

export interface TargetOccurrence {
  /** The page the edge was found on, ALREADY query-stripped: it is only printed. */
  page: string;
  kind: LinkEdgeKind;
  selector: string | null;
  /** True when the page itself was served over https — decides the two downgrades. */
  pageWasSecure: boolean;
}

export interface TargetGroup {
  /** The absolute target, fragment removed. Requested exactly once. */
  target: string;
  /** On one of the customer's own origins. Decides how a 5xx is read. */
  internal: boolean;
  /**
   * Example occurrences, CAPPED at `maxOccurrencesPerTarget`. Never use its
   * length as the count — that is what `occurrenceCount` is for, and confusing
   * the two is how "400 pages" becomes "20 pages" in a report.
   */
  occurrences: TargetOccurrence[];
  /** The true number of edges pointing here, cap or no cap. */
  occurrenceCount: number;
  /** Distinct pages carrying it. */
  pageCount: number;
  /** True when at least one occurrence was a subresource. */
  asAsset: boolean;
  /** True when at least one occurrence was an `<a>`. */
  asLink: boolean;
  /**
   * Occurrences on an `https` page, by kind, counted over EVERY edge.
   *
   * The two downgrade defects are decided from these and never from
   * `occurrences`, which is capped at `maxOccurrencesPerTarget`. Reading them
   * off the capped list is how an http script on the 21st page of a site —
   * mixed content, which browsers block outright — went unreported while the
   * first twenty http pages filled the example list: QAAI's own display cap
   * silently deciding whether a defect exists. Measured and confirmed before
   * this field existed.
   */
  secureAssetCount: number;
  secureLinkCount: number;
}

export interface GroupedEdges {
  /** One per distinct target, ordered most-referenced first then by URL. */
  groups: TargetGroup[];
  /** Hrefs that produced no target, counted by reason. Disclosed, never dropped. */
  unresolved: Record<UnresolvedHrefReason, number>;
  /** Pages whose own URL could not be parsed, so their edges could not be resolved. */
  unparseablePages: string[];
  /**
   * URLs whose query string or fragment was dropped before being reported.
   *
   * Disclosed as a count, like every other thing this plugin removes from its
   * own answer: a reader comparing a reported target against their HTML has to
   * know why the two do not match character for character.
   */
  redactedUrls: number;
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Group every edge on every page by its resolved target.
 *
 * Pure, and exported so the dedupe can be tested without a prober: this is the
 * function that decides one broken footer link is one finding, and a regression
 * in it is invisible from the outside until a report has 400 rows in it.
 *
 * The ORDER is part of the contract. Most-referenced first, ties broken by the
 * URL itself, because `maxTargets` truncates this list — so when the cap bites
 * it keeps the link that appears on 400 pages and drops the one that appears on
 * 1, and it does so identically on every run.
 */
export function groupEdgesByTarget(
  pages: readonly z.infer<typeof linkPageSchema>[],
  options: {
    baseUrl: string;
    internalOrigins: readonly string[];
    maxOccurrencesPerTarget: number;
  },
): GroupedEdges {
  const internal = new Set<string>();
  const baseOrigin = originOf(options.baseUrl);
  if (baseOrigin !== null) internal.add(baseOrigin);
  for (const raw of options.internalOrigins) {
    const origin = originOf(raw);
    if (origin !== null) internal.add(origin);
  }

  const unresolved: Record<UnresolvedHrefReason, number> = {
    NOT_HTTP: 0,
    UNPARSEABLE: 0,
    SAME_DOCUMENT: 0,
  };
  const unparseablePages: string[] = [];
  const byTarget = new Map<string, TargetGroup & { pages: Set<string> }>();
  let redactedUrls = 0;

  // Query-stripped once per URL, counted once per URL. See `printableUrl`.
  const safe = (raw: string): string => {
    const { url, dropped } = printableUrl(raw);
    if (dropped) redactedUrls += 1;
    return url;
  };

  for (const page of pages) {
    let pageSecure: boolean;
    try {
      pageSecure = new URL(page.url).protocol === 'https:';
    } catch {
      unparseablePages.push(safe(page.url));
      unresolved.UNPARSEABLE += page.edges.length;
      continue;
    }
    const pagePrinted = safe(page.url);

    for (const edge of page.edges) {
      const resolution = resolveHref(edge.href, page.url);
      if (!resolution.ok) {
        unresolved[resolution.reason] += 1;
        continue;
      }

      const targetOrigin = originOf(resolution.target);
      let group = byTarget.get(resolution.target);
      if (group === undefined) {
        // Counted once per DISTINCT target, which is the unit this plugin deals
        // in: a target is requested once and reported once however many edges
        // point at it. Counting per edge would report 400 redactions for one
        // link and make the disclosure useless.
        if (printableUrl(resolution.target).dropped) redactedUrls += 1;
        group = {
          target: resolution.target,
          internal: targetOrigin !== null && internal.has(targetOrigin),
          occurrences: [],
          occurrenceCount: 0,
          pageCount: 0,
          asAsset: false,
          asLink: false,
          secureAssetCount: 0,
          secureLinkCount: 0,
          pages: new Set<string>(),
        };
        byTarget.set(resolution.target, group);
      }

      group.occurrenceCount += 1;
      group.pages.add(page.url);
      if (edge.kind === 'ASSET') group.asAsset = true;
      else group.asLink = true;
      // Counted here, outside the cap below, because a verdict may not depend
      // on how many examples we chose to keep.
      if (pageSecure) {
        if (edge.kind === 'ASSET') group.secureAssetCount += 1;
        else group.secureLinkCount += 1;
      }
      if (group.occurrences.length < options.maxOccurrencesPerTarget) {
        group.occurrences.push({
          page: pagePrinted,
          kind: edge.kind,
          selector: edge.selector,
          pageWasSecure: pageSecure,
        });
      }
    }
  }

  const groups: TargetGroup[] = [...byTarget.values()].map((group) => ({
    target: group.target,
    internal: group.internal,
    occurrences: group.occurrences,
    occurrenceCount: group.occurrenceCount,
    pageCount: group.pages.size,
    asAsset: group.asAsset,
    asLink: group.asLink,
    secureAssetCount: group.secureAssetCount,
    secureLinkCount: group.secureLinkCount,
  }));

  groups.sort((left, right) => {
    if (left.occurrenceCount !== right.occurrenceCount) {
      return right.occurrenceCount - left.occurrenceCount;
    }
    return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
  });

  return { groups, unresolved, unparseablePages, redactedUrls };
}

// ─── Following a redirect chain ──────────────────────────────────────────────

/**
 * What a bounded redirect walk concluded. Three outcomes, and the middle one is
 * the reason this type exists.
 *
 * `HOP_LIMIT` IS NOT `LOOP`. A chain of six redirects under a five-hop budget
 * is a long chain, not a cycle, and reporting it as a loop would put a defect
 * on the customer's site on the strength of OUR cap. A loop is only a loop when
 * a URL repeats — that is evidence, and nothing else is.
 */
export type RedirectOutcome = 'RESOLVED' | 'LOOP' | 'HOP_LIMIT';

export interface RedirectChain {
  /** Every URL requested, starting with the target itself. */
  hops: string[];
  /** The last response received. */
  final: LinkProbeResult;
  outcome: RedirectOutcome;
  /** The hop pair where https became http, when one did. */
  downgradeAt: { from: string; to: string } | null;
}

function isRedirect(status: number | null): boolean {
  return status !== null && status >= 300 && status < 400;
}

/**
 * Walk a redirect chain, bounded by `maxHops`.
 *
 * Exported and tested directly with a fake prober: the loop/limit distinction
 * above is honesty-critical, and getting it wrong invents redirect loops across
 * every LINKS test at once.
 *
 * A redirect whose `Location` is missing or unparseable ends the walk as
 * RESOLVED with that response as the final one — the server sent a 3xx and no
 * usable destination, and the status itself is then the fact to report rather
 * than a chain we invented a next step for.
 */
export async function followRedirects(
  target: string,
  prober: LinkProber,
  maxHops: number,
  pacer: ProbePacer,
  signal: AbortSignal,
): Promise<RedirectChain> {
  const hops: string[] = [target];
  const seen = new Set<string>([target]);
  let current = target;
  let downgradeAt: { from: string; to: string } | null = null;

  for (;;) {
    await pacer.pace(signal);
    const result = await prober.probe(current, signal);

    if (!isRedirect(result.status) || result.location === null) {
      return { hops, final: result, outcome: 'RESOLVED', downgradeAt };
    }

    let next: string;
    try {
      const resolved = new URL(result.location, current);
      resolved.hash = '';
      next = resolved.toString();
    } catch {
      return { hops, final: result, outcome: 'RESOLVED', downgradeAt };
    }

    if (
      downgradeAt === null &&
      new URL(current).protocol === 'https:' &&
      new URL(next).protocol === 'http:'
    ) {
      downgradeAt = { from: current, to: next };
    }

    if (seen.has(next)) {
      return { hops: [...hops, next], final: result, outcome: 'LOOP', downgradeAt };
    }
    if (hops.length > maxHops) {
      return { hops, final: result, outcome: 'HOP_LIMIT', downgradeAt };
    }

    hops.push(next);
    seen.add(next);
    current = next;
  }
}

// ─── Classifying one target ──────────────────────────────────────────────────

/**
 * What a probed target turned out to be. Five states, not two.
 *
 * UNKNOWN and UNCHECKED are both "we did not find out", kept apart because the
 * remedies differ: UNKNOWN means the request happened and told us nothing,
 * UNCHECKED means one of our own caps stopped us asking. Neither is a pass.
 */
export type TargetVerdict = 'OK' | 'BROKEN' | 'LOOP' | 'UNKNOWN' | 'UNCHECKED';

/**
 * Statuses from somebody ELSE'S origin that are not evidence of a dead link.
 *
 * 401/403/407 are an auth or bot wall, 408/425/429 are a rate limit, 451 is a
 * legal block. Every one of them is what a partner site returns to an unknown
 * client that is fine for a human with a browser — so treating them as broken
 * would file the customer's perfectly good link as their defect, at scale,
 * across every outbound link they have.
 */
export const EXTERNAL_INCONCLUSIVE_STATUSES: readonly number[] = [
  401, 403, 407, 408, 425, 429, 451,
];

/**
 * The entire external/internal judgement, in one pure function.
 *
 * Kept separate from the probing so it can be tested exhaustively with no
 * transport at all — and so the rule is READABLE, because it is the rule a
 * customer will argue with.
 */
export function classifyTarget(input: {
  internal: boolean;
  /** Null when no probe was made: a cap bit, or the origin was skipped. */
  chain: RedirectChain | null;
  /** When `chain` is null, why. Printed verbatim. */
  uncheckedReason?: string;
}): { verdict: TargetVerdict; detail: string } {
  const { internal, chain } = input;
  if (chain === null) {
    return {
      verdict: 'UNCHECKED',
      detail: input.uncheckedReason ?? 'not probed, and no reason was recorded',
    };
  }

  /*
   * The hops are PRINTED, so they are query-stripped first. A redirect chain is
   * the likeliest place in this whole plugin for a credential to appear: an
   * OAuth hand-off puts `?code=…` in a `Location` header, and a signed download
   * puts the signature there. See `printableUrl`.
   */
  const hopTrail = chain.hops.map(printed).join(' → ');

  if (chain.outcome === 'LOOP') {
    return {
      verdict: 'LOOP',
      detail: `redirect loop: ${hopTrail} revisits a URL it already served`,
    };
  }
  if (chain.outcome === 'HOP_LIMIT') {
    return {
      verdict: 'UNKNOWN',
      detail:
        `UNKNOWN, not failed: the chain was still redirecting after ${chain.hops.length - 1} ` +
        `hop(s) (${hopTrail}) and QAAI's maxRedirectHops budget stopped the walk. ` +
        'No URL repeated, so this is NOT a loop — raise `maxRedirectHops` to find out what it is.',
    };
  }

  const { status, error } = chain.final;
  if (status === null) {
    return {
      verdict: 'UNKNOWN',
      detail:
        'UNKNOWN, not broken: the request did not complete' +
        (error === null ? '' : ` (${scrubUrlsInText(error)})`) +
        '. QAAI cannot tell its own network from the far end, so nothing is asserted either way.',
    };
  }

  if (status < 400) {
    return { verdict: 'OK', detail: `answered ${status}` };
  }

  if (!internal) {
    if (EXTERNAL_INCONCLUSIVE_STATUSES.includes(status)) {
      return {
        verdict: 'UNKNOWN',
        detail:
          `UNKNOWN, not broken: this is somebody else's origin and it answered ${status}, which ` +
          'is what a bot wall, an auth wall or a rate limit returns to an unknown client. A ' +
          'visitor with a browser may well reach it.',
      };
    }
    if (status >= 500) {
      return {
        verdict: 'UNKNOWN',
        detail:
          `UNKNOWN, not broken: this is somebody else's origin and it answered ${status} — a ` +
          'third party having a bad minute is not your defect.',
      };
    }
  }

  return {
    verdict: 'BROKEN',
    detail:
      `the server answered ${status}` +
      (chain.hops.length > 1 ? ` after ${chain.hops.length - 1} redirect(s)` : '') +
      (internal ? '' : ' — an external origin stating positively that this is gone'),
  };
}

// ─── Orphan pages ────────────────────────────────────────────────────────────

export interface OrphanReport {
  /** Enumerated URLs that no `<a>` on any crawled page points at. */
  orphans: string[];
  /** The denominator: enumerated URLs the check could consider. */
  considered: number;
  /** Enumerated entries that could not be parsed as a URL, so were excluded. */
  unparseable: string[];
}

/**
 * Enumerated, and reachable by no link.
 *
 * ASSET edges are deliberately excluded from the "reachable" side: a page that
 * is only ever loaded as an `<img src>` is not navigable, and counting it as
 * reachable would hide the exact defect this check exists for.
 *
 * The base URL is never an orphan — it is where every crawl starts, so it is
 * reachable by definition and reporting it would be noise on every single run.
 *
 * Returns `considered: 0` when the enumeration is empty. The CALLER must read
 * that as unmeasured: a zero denominator reporting "no orphans" is the same lie
 * as a coverage percentage of 100 over nothing.
 */
export function findOrphanPages(
  enumerated: readonly string[],
  groups: readonly TargetGroup[],
  baseUrl: string,
): OrphanReport {
  const linkTargets = new Set<string>();
  for (const group of groups) {
    if (group.asLink) linkTargets.add(group.target);
  }

  const normalise = (raw: string): string | null => {
    try {
      const url = new URL(raw, baseUrl);
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  };

  const base = normalise(baseUrl);
  const orphans: string[] = [];
  const unparseable: string[] = [];
  const seen = new Set<string>();
  let considered = 0;

  for (const raw of enumerated) {
    const url = normalise(raw);
    if (url === null) {
      unparseable.push(raw);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    considered += 1;
    if (url === base) continue;
    if (!linkTargets.has(url)) orphans.push(url);
  }

  orphans.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { orphans, considered, unparseable };
}

// ─── The defects a grouped, probed graph produces ────────────────────────────

export interface LinkIssue {
  defect: LinkDefect;
  /** The deduped subject: a target URL, or an orphan's URL. */
  target: string;
  /** How many edges point at it. One finding, N occurrences. */
  occurrenceCount: number;
  /** Distinct pages carrying it. */
  pageCount: number;
  /** Example occurrence sites, already capped by `maxOccurrencesPerTarget`. */
  examples: string[];
  detail: string;
}

/**
 * Turn one classified target into the defects it demonstrates.
 *
 * A single target can be more than one defect at once — an `http://` script on
 * an `https://` page that also 404s is MIXED_CONTENT and DEAD_ASSET — and
 * collapsing that to one would drop whichever the reader needed.
 *
 * `enabled` gates the defects a spec asked for. A defect NOT in that set is
 * absent from the output and disclosed by the caller as unchecked, which is not
 * the same as absent from the site.
 */
export function issuesForTarget(
  group: TargetGroup,
  verdict: TargetVerdict,
  detail: string,
  chain: RedirectChain | null,
  enabled: ReadonlySet<LinkDefect>,
): LinkIssue[] {
  const issues: LinkIssue[] = [];
  const base = {
    // The REPORTED target is query-stripped; `group.target` keeps the full URL
    // because that is what was requested and what the dedupe is keyed on.
    target: printed(group.target),
    occurrenceCount: group.occurrenceCount,
    pageCount: group.pageCount,
    // `o.page` is already safe — `groupEdgesByTarget` stripped it on the way in.
    examples: group.occurrences.map((o) =>
      o.selector === null ? o.page : `${o.page} (${o.selector})`,
    ),
  };

  if (verdict === 'BROKEN') {
    // Asset-ness decides which defect, and a target used BOTH ways earns both:
    // "the logo is missing" and "the nav link is dead" are two bug reports.
    if (group.asAsset && enabled.has('DEAD_ASSET')) {
      issues.push({ ...base, defect: 'DEAD_ASSET', detail });
    }
    if (group.asLink && enabled.has('DEAD_LINK')) {
      issues.push({ ...base, defect: 'DEAD_LINK', detail });
    }
  }

  if (verdict === 'LOOP' && enabled.has('REDIRECT_LOOP')) {
    issues.push({ ...base, defect: 'REDIRECT_LOOP', detail });
  }

  // The two downgrades are statements about the EDGE, not about the response,
  // so they stand whatever the status turned out to be — including UNKNOWN. A
  // request that leaves the TLS tunnel left it whether or not it was answered.
  const insecureTarget = group.target.startsWith('http://');
  /*
   * The EXAMPLES come from the capped occurrence list; the DECISION comes from
   * the uncapped counts. When the cap kept no https example of a defect the
   * counts prove exists, the issue is still reported and says so — a missing
   * example is a gap in the illustration, never a reason to drop the defect.
   */
  const secureAssetSites = group.occurrences.filter((o) => o.pageWasSecure && o.kind === 'ASSET');
  const secureLinkSites = group.occurrences.filter((o) => o.pageWasSecure && o.kind === 'LINK');
  const beyondCap = (shown: number, counted: number): string =>
    shown > 0
      ? ''
      : `. No example page is listed: all ${counted} https occurrence(s) fell outside this ` +
        'target’s `maxOccurrencesPerTarget` example list, which caps the illustration and not ' +
        'the defect';

  if (insecureTarget && group.secureAssetCount > 0 && enabled.has('MIXED_CONTENT')) {
    issues.push({
      ...base,
      defect: 'MIXED_CONTENT',
      examples: secureAssetSites.map((o) => o.page),
      detail:
        'loaded over http as a subresource of an https page — browsers block this, so the page ' +
        'is already broken for every visitor' +
        beyondCap(secureAssetSites.length, group.secureAssetCount),
    });
  }
  if (insecureTarget && group.secureLinkCount > 0 && enabled.has('HTTPS_DOWNGRADE')) {
    issues.push({
      ...base,
      defect: 'HTTPS_DOWNGRADE',
      examples: secureLinkSites.map((o) => o.page),
      detail:
        'linked over http from an https page, so following it leaves the TLS tunnel' +
        beyondCap(secureLinkSites.length, group.secureLinkCount),
    });
  }
  if (chain?.downgradeAt && enabled.has('HTTPS_DOWNGRADE')) {
    issues.push({
      ...base,
      defect: 'HTTPS_DOWNGRADE',
      detail:
        `the redirect chain steps down from https to http: ${printed(chain.downgradeAt.from)} → ` +
        `${printed(chain.downgradeAt.to)}`,
    });
  }

  return issues;
}

// ─── Execution ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

/** Every cap that BIT, as a count and a reason. Empty when none did. */
export interface CapDisclosure {
  cap: string;
  count: number;
  reason: string;
}

export interface LinksMeasurement {
  issues: LinkIssue[];
  /** Per-verdict counts over the distinct targets. */
  verdicts: Record<TargetVerdict, number>;
  /** Defects the spec did not ask for. Unchecked is not absent. */
  unchecked: LinkDefect[];
  /** The orphan check's answer, or null when its denominator was zero. */
  orphans: OrphanReport | null;
  caps: CapDisclosure[];
  unresolved: Record<UnresolvedHrefReason, number>;
}

/**
 * Probe and classify every distinct target, then collect the defects.
 *
 * Exported separately from the plugin so the whole measurement can be driven
 * with a fake prober and a fake clock, which is every test in links.test.ts.
 */
export async function measureLinks(
  spec: LinksTestSpec,
  baseUrl: string,
  deps: { prober: LinkProber; clock: LinkClock },
  signal: AbortSignal,
): Promise<LinksMeasurement> {
  const enabled = new Set<LinkDefect>(spec.checks);
  const grouped = groupEdgesByTarget(spec.pages, {
    baseUrl,
    internalOrigins: spec.internalOrigins,
    maxOccurrencesPerTarget: spec.maxOccurrencesPerTarget,
  });

  const pacer = new ProbePacer(1000 / spec.requestsPerSecond, deps.clock);
  const caps: CapDisclosure[] = [];
  const verdicts: Record<TargetVerdict, number> = {
    OK: 0,
    BROKEN: 0,
    LOOP: 0,
    UNKNOWN: 0,
    UNCHECKED: 0,
  };
  const issues: LinkIssue[] = [];

  const startedAt = deps.clock.now();
  let budgetExpiredAfter: number | null = null;
  let probed = 0;
  let skippedByTargetCap = 0;
  let skippedByBudget = 0;
  let skippedExternal = 0;
  let skippedByCancel = 0;

  for (const group of grouped.groups) {
    let chain: RedirectChain | null = null;
    let uncheckedReason: string | undefined;

    if (signal.aborted) {
      skippedByCancel += 1;
      uncheckedReason = 'the run was cancelled before this target was probed';
    } else if (!spec.checkExternal && !group.internal) {
      skippedExternal += 1;
      uncheckedReason =
        'checkExternal is false, so targets outside your own origins were not requested';
    } else if (probed >= spec.maxTargets) {
      skippedByTargetCap += 1;
      uncheckedReason =
        `QAAI's maxTargets cap of ${spec.maxTargets} distinct target(s) was reached before this ` +
        'one. Raise `maxTargets` to check it.';
    } else if (budgetExpiredAfter !== null) {
      skippedByBudget += 1;
      uncheckedReason =
        `QAAI's budgetMs cap of ${spec.budgetMs}ms expired after ${budgetExpiredAfter} target(s). ` +
        'Raise `budgetMs` to check it.';
    } else {
      probed += 1;
      try {
        chain = await followRedirects(
          group.target,
          deps.prober,
          spec.maxRedirectHops,
          pacer,
          signal,
        );
      } catch (err) {
        // A prober that threw told us nothing about the customer's site. Shaped
        // as a completed request with no status so `classifyTarget` reads it as
        // UNKNOWN by the same rule as every other incomplete request.
        chain = {
          hops: [group.target],
          final: { status: null, location: null, error: errorText(err) },
          outcome: 'RESOLVED',
          downgradeAt: null,
        };
      }
      if (deps.clock.now() - startedAt >= spec.budgetMs) budgetExpiredAfter = probed;
    }

    const classification = classifyTarget({ internal: group.internal, chain, uncheckedReason });
    verdicts[classification.verdict] += 1;
    issues.push(
      ...issuesForTarget(group, classification.verdict, classification.detail, chain, enabled),
    );
  }

  if (skippedByTargetCap > 0) {
    caps.push({
      cap: 'maxTargets',
      count: skippedByTargetCap,
      reason:
        `${skippedByTargetCap} distinct target(s) were NOT checked because maxTargets is ` +
        `${spec.maxTargets}. They are UNCHECKED, not healthy. The targets kept were the ` +
        'most-referenced ones; raise `maxTargets` to check the rest.',
    });
  }
  if (skippedByBudget > 0) {
    caps.push({
      cap: 'budgetMs',
      count: skippedByBudget,
      reason:
        `${skippedByBudget} distinct target(s) were NOT checked because the ${spec.budgetMs}ms ` +
        'budgetMs expired. They are UNCHECKED, not healthy.',
    });
  }
  if (skippedExternal > 0) {
    caps.push({
      cap: 'checkExternal',
      count: skippedExternal,
      reason:
        `${skippedExternal} target(s) on other people's origins were not requested because ` +
        'checkExternal is false. Nothing is claimed about them.',
    });
  }
  if (skippedByCancel > 0) {
    caps.push({
      cap: 'cancellation',
      count: skippedByCancel,
      reason:
        `the run was cancelled, so ${skippedByCancel} remaining target(s) were never ` +
        'requested. They are UNCHECKED, not healthy.',
    });
  }
  const pacing = pacer.cost;
  if (pacing !== null) {
    caps.push({
      cap: 'requestsPerSecond',
      count: pacing.pauses,
      reason:
        `the ${spec.requestsPerSecond}/s rate limit paused this check ${pacing.pauses} time(s) ` +
        `for ${pacing.pausedMs}ms in total. Nothing was skipped because of it; it is disclosed ` +
        'so the run duration is explainable.',
    });
  }
  /*
   * The example cap, disclosed. It is listed even though it removes no DEFECT —
   * `issuesForTarget` decides the downgrades from the uncapped counts — because
   * a reader counting the example pages under a finding that says "400
   * occurrence(s)" and finding twenty of them is entitled to know which number
   * is the measurement.
   */
  const occurrencesDropped = grouped.groups.reduce(
    (total, group) => total + (group.occurrenceCount - group.occurrences.length),
    0,
  );
  if (occurrencesDropped > 0) {
    caps.push({
      cap: 'maxOccurrencesPerTarget',
      count: occurrencesDropped,
      reason:
        `${occurrencesDropped} occurrence(s) are not listed as examples because ` +
        `maxOccurrencesPerTarget is ${spec.maxOccurrencesPerTarget}. Every occurrence IS counted: ` +
        'the per-defect `occurrenceCount` and `pageCount` are the true totals, and no defect was ' +
        'decided from the example list.',
    });
  }
  if (grouped.redactedUrls > 0) {
    caps.push({
      cap: 'query string redaction',
      count: grouped.redactedUrls,
      reason:
        `${grouped.redactedUrls} URL(s) carried a query string or fragment, which was DROPPED ` +
        'before anything was reported, because a reset link, an OAuth code and a signed ' +
        'download all live in one. The full URL was still requested; only the printed form is ' +
        'shortened, so a reported target may not match your HTML character for character.',
    });
  }
  if (grouped.unparseablePages.length > 0) {
    caps.push({
      cap: 'unparseable page URL',
      count: grouped.unparseablePages.length,
      reason:
        `${grouped.unparseablePages.length} page(s) had a URL that could not be parsed, so ` +
        `their edges were not resolved at all: ${grouped.unparseablePages.slice(0, 5).join(', ')}`,
    });
  }

  // The orphan check. NULL rather than an empty report when there is nothing to
  // compare against: "no orphans" and "we had no enumeration" are different
  // facts and the caller reports them differently.
  let orphans: OrphanReport | null = null;
  if (enabled.has('ORPHAN_PAGE')) {
    const report = findOrphanPages(spec.enumerated, grouped.groups, baseUrl);
    if (report.considered > 0) {
      orphans = report;
      for (const url of report.orphans) {
        issues.push({
          defect: 'ORPHAN_PAGE',
          // Printed, so query-stripped like every other reported URL. An
          // enumerated route can carry a token too.
          target: printed(url),
          occurrenceCount: 0,
          pageCount: 0,
          examples: [],
          detail:
            'enumerated, and no <a> on any crawled page points at it — a visitor cannot ' +
            'navigate to this page',
        });
      }
      if (report.unparseable.length > 0) {
        caps.push({
          cap: 'unparseable enumerated URL',
          count: report.unparseable.length,
          reason:
            `${report.unparseable.length} enumerated entr(ies) could not be parsed as a URL and ` +
            'were excluded from the orphan check',
        });
      }
    }
  }

  return {
    issues,
    verdicts,
    unchecked: LINK_DEFECTS.filter((defect) => !enabled.has(defect)),
    orphans,
    caps,
    unresolved: grouped.unresolved,
  };
}

function issueTitle(issue: LinkIssue): string {
  const where =
    issue.occurrenceCount === 0
      ? ''
      : ` — ${issue.occurrenceCount} occurrence(s) on ${issue.pageCount} page(s)`;
  return `${LINK_DEFECT_LABELS[issue.defect]}: ${issue.target}${where}`;
}

/**
 * Run a links test against an injected prober.
 *
 * The status rule, which is the point of the plugin:
 *
 *   · any defect                → FAILED. A statement about the application.
 *   · nothing classified at all → SKIPPED with `notRun`, because nothing was
 *                                 measured. A green LINKS test that requested
 *                                 nothing is the lie this file exists to
 *                                 prevent.
 *   · targets classified, none  → PASSED, with every cap and every unchecked
 *     defective                   axis disclosed on the result.
 */
export async function runLinksTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: LinksTestSpec,
  deps: LinksDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const notes: ConsoleEntry[] = [];
  const clock = deps.clock ?? realLinkClock;

  const measurement = await measureLinks(
    spec,
    ctx.baseUrl,
    { prober: deps.prober, clock },
    ctx.signal,
  );

  const steps: StepResult[] = [];
  const findings: Finding[] = [];

  // durationMs is 0 on every step here on purpose: these are REPORT ROWS over
  // one measurement, not timed operations. One probe can produce two defects
  // and one defect can span 400 pages, so any per-row duration would be a
  // number nothing measured.
  const record = (title: string, status: StepResult['status'], detail: string | null): void => {
    const index = steps.length;
    ctx.logger.step({ testId: test.id, index, title, status });
    steps.push({
      index,
      title: detail === null ? title : `${title} — ${detail}`,
      status,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error:
        status === 'FAILED'
          ? { message: detail ?? title, stack: null, selector: null, expected: null, actual: null }
          : null,
    });
  };

  for (const issue of measurement.issues) {
    record(issueTitle(issue), 'FAILED', issue.detail);
    const kind = LINK_DEFECT_FINDING_KIND[issue.defect];
    if (kind !== null) {
      findings.push({
        kind,
        severity: LINK_DEFECT_SEVERITY[issue.defect],
        code: LINK_DEFECT_CODES[issue.defect],
        message:
          `${LINK_DEFECT_LABELS[issue.defect]}: ${issue.target} — ${issue.detail}. ` +
          `${issue.occurrenceCount} occurrence(s) on ${issue.pageCount} page(s)` +
          (issue.examples.length > 0 ? `, e.g. ${issue.examples.slice(0, 3).join(', ')}` : ''),
        location: issue.target,
        helpUrl: null,
      });
    }
  }

  // Every cap that bit gets a SKIPPED step of its own, so it is in the report
  // and not only in a summary sentence somebody may not read.
  for (const cap of measurement.caps) {
    record(`Cap applied: ${cap.cap} (${cap.count})`, 'SKIPPED', cap.reason);
  }

  for (const defect of measurement.unchecked) {
    record(
      `${LINK_DEFECT_LABELS[defect]} NOT CHECKED`,
      'SKIPPED',
      'this test’s `checks` list does not include it, so nothing is claimed about it. ' +
        'Unchecked is not absent.',
    );
  }

  if (measurement.orphans === null && spec.checks.includes('ORPHAN_PAGE')) {
    record(
      'Orphan pages NOT MEASURED',
      'SKIPPED',
      'the orphan check compares the ENUMERATION against the links the crawl found, and this ' +
        'test carries no enumerated URLs. Zero enumerated routes is not zero orphans.',
    );
  }

  const { verdicts } = measurement;
  const classified = verdicts.OK + verdicts.BROKEN + verdicts.LOOP;
  const unresolvedTotal = Object.values(measurement.unresolved).reduce((a, b) => a + b, 0);

  if (unresolvedTotal > 0) {
    notes.push({
      level: 'info',
      text:
        `${unresolvedTotal} href(s) produced no HTTP target: ` +
        UNRESOLVED_HREF_REASONS.map(
          (reason) => `${measurement.unresolved[reason]} ${UNRESOLVED_HREF_LABELS[reason]}`,
        ).join('; '),
      at: new Date().toISOString(),
    });
  }
  for (const cap of measurement.caps) {
    notes.push({ level: 'warn', text: cap.reason, at: new Date().toISOString() });
  }

  const disclosure =
    ` Checked ${classified} of ${classified + verdicts.UNKNOWN + verdicts.UNCHECKED} distinct ` +
    `target(s): ${verdicts.UNKNOWN} UNKNOWN, ${verdicts.UNCHECKED} UNCHECKED.` +
    (measurement.caps.length > 0
      ? ` Caps that bit: ${measurement.caps.map((c) => `${c.cap} (${c.count})`).join(', ')}.`
      : '') +
    (measurement.unchecked.length > 0
      ? ` NOT checked for: ${measurement.unchecked.join(', ')}.`
      : '');

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings,
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  if (measurement.issues.length > 0) {
    const counts = new Map<LinkDefect, number>();
    for (const issue of measurement.issues) {
      counts.set(issue.defect, (counts.get(issue.defect) ?? 0) + 1);
    }
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage:
        `${measurement.issues.length} link-integrity defect(s): ` +
        [...counts.entries()]
          .map(([defect, n]) => `${n} ${LINK_DEFECT_LABELS[defect]}`)
          .join(', ') +
        `.${disclosure}`,
    };
  }

  if (classified === 0 && measurement.orphans === null) {
    /*
     * Nothing was measured. This is the result that must never be PASSED: a
     * green links test over a prober that answered nothing is exactly the "no
     * drift since the last crawl, because the comparison did not run" lie.
     *
     * NOT_RUN rather than BLOCKED_BY_ENV: an incomplete request does not
     * establish that the environment is broken, and claiming it did would be a
     * stronger statement than the evidence supports.
     */
    const why =
      'No link target was classified, so nothing is claimed about this site’s links.' + disclosure;
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: `No link-integrity defect found.${disclosure}`,
  };
}

let deps: LinksDeps = { prober: unavailableLinkProber };

/** Install the prober/clock. Returns the previous set, so a test restores it. */
export function setLinksDeps(next: LinksDeps): LinksDeps {
  const previous = deps;
  deps = next;
  return previous;
}

export const linksPlugin = {
  type: 'LINKS' as const,

  validate(test: ExecutableTest): void {
    const parsed = linksTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Links test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * Caught HERE rather than at run time: a test whose only check is
     * ORPHAN_PAGE and which carries no enumeration can measure NOTHING, and a
     * test author who learns that from a SKIPPED result has waited for a run to
     * be told about a typo.
     */
    const spec = parsed.data;
    if (
      spec.checks.length === 1 &&
      spec.checks[0] === 'ORPHAN_PAGE' &&
      spec.enumerated.length === 0
    ) {
      throw new Error(
        `Links test "${test.name}" asks only for ORPHAN_PAGE and carries no \`enumerated\` ` +
          'URLs, so it could not measure anything. Add the enumerated routes, or add another check.',
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runLinksTest(ctx, test, linksTestSpecSchema.parse(test.spec), deps);
  },
};
