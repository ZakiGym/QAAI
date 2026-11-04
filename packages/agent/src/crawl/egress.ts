/**
 * THE CRAWL'S ADOPTION OF THE EGRESS GUARD, AND THE LEDGER THAT COUNTS IT.
 *
 * ─── WHY THE CRAWLER AND NOT SOMETHING SMALLER ─────────────────────────────
 *
 * The crawler is the largest outbound surface in the product and it classifies
 * nothing. `Environment.baseUrl` is validated by `httpUrl` in
 * `packages/shared/src/schemas.ts` — `z.string().url()` plus an http/https
 * check and nothing else (reproduced at HEAD 37498c1) — so loopback, RFC1918,
 * link-local and the cloud metadata address are all accepted at the door. A
 * MEMBER then drives a real browser at that URL, a FORM_LOGIN profile TYPES
 * VAULT PLAINTEXT into whatever answers, and the crawl's progress events report
 * what came back. That is an SSRF with a reporting feature attached.
 *
 * And it is not only the base URL. `harvest.ts` widens the frontier from
 * SITEMAPS, ROBOTS FILES, WEB MANIFESTS AND LINKS — documents the target
 * controls — so every URL it produces is attacker-influenced by definition. A
 * sitemap entry on an origin the policy's `additionalOrigins` permits reaches
 * the browser: `isOwnOrigin` in `@qaai/shared/flow-map` returns true for any
 * origin in that list, so "off-origin" is not the backstop somebody might
 * assume it is.
 *
 * ─── WHAT THIS FILE IS AND WHAT IT DELIBERATELY IS NOT ─────────────────────
 *
 * It is the GATE: a thing the crawl asks before it navigates, which answers
 * with a pinned permit or a counted refusal, and which keeps the ledger that
 * lets a report say "14 URLs refused by egress policy".
 *
 * It is NOT a second policy. Every decision comes from the guard
 * (`packages/shared/src/egress-guard.ts`), which comes from `decideEgress`,
 * which comes from `classifyAddress`. Two copies of a security classifier is
 * how one of them quietly stops matching the other — `private-address.ts` opens
 * with that exact argument — so there is no class list, no allowlist check and
 * no address parsing anywhere below.
 *
 * ─── THE PORT, AND WHY IT IS A PORT RATHER THAN AN IMPORT ──────────────────
 *
 * {@link CrawlEgressGuard} is a one-function interface and {@link GuardAnswer}
 * IS the guard's own verdict type, imported from `@qaai/shared` — no longer a
 * local structural copy of it.
 *
 * The history is worth one paragraph, because the shape of the mistake recurs.
 * For one round this file declared its own width subset of the verdict, because
 * `@qaai/shared`'s front door did not publish `egress-guard` and reaching
 * across the workspace boundary by relative path is the defect the barrel's own
 * header records nine files committing. The copy compiled, the tests passed,
 * and NOTHING in the file was compiler-checked against the real guard: the
 * match was reasoned field by field, which is a claim and not a fact. The
 * barrel line has since landed and the copy is deleted — not kept in sync,
 * deleted — so a field renamed in the guard is now a compile error here.
 *
 * ─── THE TENANT IS THE ADVERSARY, WHICH CHANGES WHERE DETAIL MAY GO ────────
 *
 * This is the sharpest rule in the file and it is easy to get backwards.
 * Everywhere else in this product, "operator detail" may be shown to the
 * customer because it is their own tenant and their own data. HERE IT MAY NOT.
 * The person who set the base URL to `http://169.254.169.254/` is a tenant of
 * ours, and the thing they are attacking is OUR network; a refusal that tells
 * them "that is a link-local address" and one that tells them "that host did
 * not resolve" are two different facts about the inside of our infrastructure,
 * handed to the attacker, in their own cockpit.
 *
 * So the split is:
 *
 *   TENANT-VISIBLE   {@link CrawlEgressExclusion.rule} — ONE constant, and
 *                    {@link CrawlEgressGate.progressNote} — the guard's one
 *                    sentence. No class, no address, no refusal code, no
 *                    distinction between a refused host and a closed port.
 *   INSTALL-VISIBLE  {@link CrawlEgressGate.operatorRows} — the class, the
 *                    refusal and the host, for a QAAI operator reading the
 *                    tally, never rendered into a crawl report.
 *
 * `egress.test.ts` asserts that a refused host and an unresolvable host produce
 * byte-identical tenant-visible output.
 */

import { EXCLUSION_KINDS } from '@qaai/shared';
import type { EgressGuardVerdict, ExcludedPath, ExclusionKind } from '@qaai/shared';
/*
 * TYPE-ONLY, and through the SUBPATH rather than the barrel:
 * `private-address.ts` reaches for `node:dns`. A type-only import is erased
 * entirely, so this adds no runtime edge at all — but the subpath is what every
 * other caller in the repo uses and a value import added here later would
 * otherwise look blessed.
 */
import type { AddressClass } from '@qaai/shared/private-address';

// ─── The port ───────────────────────────────────────────────────────────────

/**
 * The guard's answer. THE REAL TYPE, not a copy of it.
 *
 * This was a locally-declared width subset of `GuardVerdict` for exactly one
 * round, for one reason: `@qaai/shared`'s front door did not publish
 * `egress-guard`, so there was no way to name the real type without reaching
 * across the workspace boundary by relative path — the thing the barrel's own
 * header records nine files doing, compiling, and leaving the front door shut.
 *
 * The barrel line has landed, so the copy is GONE rather than maintained. That
 * ordering is the point: a hand-copied projection is the defect that let a fix
 * ship unreachable in an earlier round, because an internal map re-listed three
 * of four fields and every test passed. A structural match that is REASONED is
 * a claim; one the compiler checks is a fact, and this is now the fact.
 *
 * It is published under `EgressGuardVerdict` rather than `GuardVerdict`
 * because `@qaai/shared` already had a `GuardVerdict` — the static-analysis
 * GUARDED / UNGUARDED / UNKNOWN verdict from `codebase.ts`, which means nothing
 * like this one. The barrel disambiguates the two by alias; see its header.
 */
export type GuardAnswer = EgressGuardVerdict;

/**
 * ASK THE GUARD. One function, so the gate cannot grow a second decision path.
 *
 * The URL goes in whole — the guard needs the scheme, the port and the userinfo
 * to refuse what it refuses — and nothing but the host and origin comes back
 * out, because {@link GuardAnswer} has no field a path could land in.
 */
export type CrawlEgressGuard = (url: string) => Promise<GuardAnswer>;

/** The clock, injected, so a pin's age and a TTL are testable without waiting. */
export type MonotonicClock = () => number;

// ─── The ledger ─────────────────────────────────────────────────────────────

/**
 * THE ONE RULE STRING A TENANT SEES, for every egress refusal there is.
 *
 * A single constant and not a function of the refusal, for the reason the
 * module header gives at length: for a CRAWL the tenant is the adversary, and
 * "that is a loopback address" / "that host did not resolve" / "that redirect
 * left the allowlist" are three different facts about the inside of OUR
 * network. `exclusionsByRule` in `@qaai/shared/flow-map` groups the ledger BY
 * THIS STRING, so one constant also means one group and one count, which is
 * exactly the "14 URLs refused by egress policy" line this is for.
 *
 * It names the environment's egress policy because that is the one actionable
 * thing a tenant can do about it — add an allowlist entry with an owner and a
 * reason — and that instruction reveals nothing, since it is the same
 * instruction whatever the refusal was.
 */
export const EGRESS_EXCLUSION_RULE = 'egressPolicy: refused by this environment’s egress policy';

/**
 * The `ExclusionKind` this ledger WANTS and the shared vocabulary does not have.
 *
 * `EXCLUSION_KINDS` in `packages/shared/src/flow-map.ts` has seven members —
 * SESSION_ENDING, DESTRUCTIVE, POLICY_EXCLUDE, POLICY_NOT_INCLUDED, OFF_ORIGIN,
 * UNSAFE_METHOD, UNSUPPORTED_SCHEME — and NONE of them is true of a URL refused
 * by egress policy. `OFF_ORIGIN` is false (`http://169.254.169.254/` can be the
 * configured origin itself), and `POLICY_EXCLUDE`'s label is "excluded by the
 * crawl policy", which would send an operator to read `excludeGlobs` and find
 * nothing — a label that lies about which rule fired is worse than no label.
 *
 * So this file does NOT render into `ExcludedPath` by default.
 * {@link CrawlEgressGate.asExcludedPaths} requires the caller to NAME a kind,
 * typed `ExclusionKind`, which means the correct answer cannot be passed until
 * `EGRESS_REFUSED` is a member and a wrong answer can only be passed on
 * purpose. The exact edit is in this round's handover; `flow-map.ts` is not
 * this agent's file.
 */
export const WANTED_EXCLUSION_KIND = 'EGRESS_REFUSED';

/**
 * One URL the crawl did not open, and why — in the words a tenant may read.
 *
 * Shaped like `ExcludedPath` minus its `kind`, deliberately, so the handover's
 * one-line change turns this into that with no reshaping. `url` is the URL AS
 * THE CRAWL DISCOVERED IT, which is the customer's own application surface and
 * is already what `ExcludedPath.url` carries for the other seven kinds; the
 * REFUSED host's own path never appears, because {@link GuardAnswer} has no
 * field it could have come through.
 */
export interface CrawlEgressExclusion {
  readonly url: string;
  readonly route: string | null;
  /** Always {@link EGRESS_EXCLUSION_RULE}. One group, one count, no oracle. */
  readonly rule: string;
  readonly discoveredFrom: string | null;
}

/**
 * ONE COUNTED BUCKET, FOR A QAAI OPERATOR AND NOT FOR THE TENANT.
 *
 * Mirrors the guard's `GuardTally` buckets — (outcome, class, refusal) — with
 * the HOST added, because the operator question this answers is "which internal
 * host is a tenant pointing our crawler at", and that cannot be answered by a
 * class alone. `hosts` is a capped sample beside a `count`, so a truncated list
 * can never be mistaken for the whole one.
 */
export interface CrawlEgressRow {
  readonly outcome: 'ALLOWED' | 'REFUSED' | 'WOULD_REFUSE';
  readonly addressClass: AddressClass | null;
  readonly refusal: string | null;
  readonly count: number;
  /** At most {@link HOST_SAMPLE_CAP}. The count beside it is the real total. */
  readonly hosts: readonly string[];
}

/** How many distinct hosts one operator row keeps. The count is unbounded. */
export const HOST_SAMPLE_CAP = 10;

/**
 * How long a host's pin is good for.
 *
 * ── Why a pin is cached per host at all, which is not an optimisation ──────
 *
 * A crawl visits hundreds of URLs across one or two hosts. Deciding per URL
 * would mean a resolver round trip per URL — but far more importantly it would
 * mean a DIFFERENT PIN PER URL, and Chromium's pinning mechanism is a LAUNCH
 * ARGUMENT (`--host-resolver-rules`, see the guard's
 * `chromiumHostResolverRules`). A pin that changes mid-crawl cannot be
 * delivered to a browser that is already running. So the pin is per host, taken
 * once, and that is what makes browser pinning possible at all rather than a
 * nice extra.
 *
 * ── The cost, which is real ────────────────────────────────────────────────
 *
 * A pin held for a long crawl is a STALE pin: a legitimate DNS change mid-crawl
 * sends the browser to the old address until the TTL expires. Fifteen minutes
 * is the trade — short enough that a deploy that moves an address recovers
 * within one, long enough that a crawl is not re-deciding constantly. The
 * expiry is REPORTED through {@link CrawlEgressGate.pins} (each pin carries its
 * age) rather than being silent, so "the browser was pinned to an address that
 * is 14 minutes old" is answerable.
 */
export const DEFAULT_PIN_TTL_MS = 15 * 60 * 1_000;

// ─── What the gate answers ──────────────────────────────────────────────────

/** A host this crawl is pinned to, and how old the pin is. */
export interface CrawlPin {
  readonly host: string;
  readonly addresses: readonly string[];
  readonly ageMs: number;
}

/**
 * MAY THE CRAWL OPEN THIS URL.
 *
 * On a refusal the caller gets the LEDGER ENTRY, already written, rather than a
 * reason to compose one from — so there is no call site at which a refusal can
 * be dropped silently while looking handled.
 */
export type CrawlEgressVerdict =
  | {
      readonly ok: true;
      /** Null exactly when the permit was OBSERVED, i.e. nothing was authorised. */
      readonly pinned: readonly string[] | null;
      /** True when the brake let through what enforcement would have refused. */
      readonly observed: boolean;
    }
  | { readonly ok: false; readonly exclusion: CrawlEgressExclusion };

/**
 * THE GATE.
 *
 * Every URL the crawl is about to visit goes through {@link admit} — the base
 * URL, the frontier's queue, and above all the URLs harvested from sitemaps,
 * robots files, manifests, links and redirects, which are the ones the target
 * controls.
 *
 * It is a class and not a function because it owns three pieces of state that
 * must not be re-derived at a call site: the per-host pin cache (which the
 * browser's launch argument is built from), the tenant-visible exclusion ledger
 * and the operator-visible tally. A free function would have made every caller
 * responsible for threading all three, and the thing nobody does is the extra
 * step.
 */
export class CrawlEgressGate {
  private readonly guard: CrawlEgressGuard;
  private readonly clock: MonotonicClock;
  private readonly ttlMs: number;

  /** host → the decision taken for it, and when. Keyed on the NORMALISED host. */
  private readonly pinCache = new Map<
    string,
    { readonly addresses: readonly string[]; readonly takenAt: number }
  >();

  /** Keyed by URL, so one refused URL offered from fifty pages is ONE refusal. */
  private readonly ledger = new Map<string, CrawlEgressExclusion>();

  private readonly rows = new Map<
    string,
    { row: Omit<CrawlEgressRow, 'hosts'>; hosts: Set<string> }
  >();

  constructor(input: {
    readonly guard: CrawlEgressGuard;
    readonly clock: MonotonicClock;
    readonly pinTtlMs?: number;
  }) {
    this.guard = input.guard;
    this.clock = input.clock;
    this.ttlMs = input.pinTtlMs ?? DEFAULT_PIN_TTL_MS;
  }

  /**
   * ASK, AND RECORD WHATEVER THE ANSWER WAS.
   *
   * FAILS CLOSED. A guard that THROWS is a refusal, not a pass: a crawl that
   * treated an exception as permission would be a control that is off for
   * exactly as long as something is broken, which is when it is needed most.
   * That arm is `egress.test.ts`'s 'refuses when the guard itself THROWS,
   * rather than treating it as permission' — the full title, because the
   * shortened one it used to name matched NOTHING, and `vitest -t` answers a
   * name that matches nothing by SKIPPING every test in the file and exiting
   * non-zero. A mutation run against the old spelling therefore reported this
   * arm as surviving when it is in fact covered.
   */
  async admit(input: {
    readonly url: string;
    readonly route?: string | null;
    readonly discoveredFrom?: string | null;
  }): Promise<CrawlEgressVerdict> {
    let answer: GuardAnswer;
    try {
      answer = await this.guard(input.url);
    } catch {
      /*
       * No detail from the exception, deliberately. An error thrown by a
       * resolver carries the hostname and sometimes the address in its message,
       * and this arm's output is tenant-visible. The operator row records the
       * refusal with no class, which is the truthful reading: nothing was
       * classified.
       */
      this.count('REFUSED', null, 'GUARD_THREW', null);
      return { ok: false, exclusion: this.exclude(input) };
    }

    if (!answer.ok) {
      this.count(
        'REFUSED',
        answer.decision?.decidedByClass ?? null,
        answer.refusal,
        answer.target?.host ?? null,
      );
      return { ok: false, exclusion: this.exclude(input) };
    }

    const permit = answer.permit;

    if (permit.kind === 'OBSERVED') {
      /*
       * THE BRAKE. The connection happens the way it did before this control
       * existed — by name, with the rebinding window open — and it is COUNTED
       * as what enforcement would have refused. A mode that does not count is
       * an off switch with a reassuring name.
       */
      this.count(
        'WOULD_REFUSE',
        permit.decision.decidedByClass,
        permit.wouldRefuse,
        permit.target.host,
      );
      return { ok: true, pinned: null, observed: true };
    }

    if (permit.pinned.addresses.length === 0) {
      /*
       * A PIN THAT AUTHORISES NOTHING, which is as dangerous as no pin at all.
       *
       * This arm USED to read `permit.pinned === null`, and the change is worth
       * recording because the compiler is what found it. While this file
       * carried its own width-subset copy of the verdict, `pinned` was typed
       * `… | null` on BOTH permit arms, so that check compiled and a test
       * constructed a PINNED permit with a null pin to cover it. Against the
       * real `EgressPermit` the PINNED arm guarantees a `PinnedResolution`, so
       * `permit.pinned === null` narrowed `permit` to `never`: the arm was
       * UNREACHABLE and the test that "covered" it was only passing because the
       * local copy was wider than the thing it stood for.
       *
       * An EMPTY ADDRESS LIST is the same hazard in a shape the type permits,
       * so this is the check that can actually fire. Both pinned adapters do
       * the wrong thing with it and neither does it loudly:
       * `chromiumHostResolverRules` would emit a MAP TO NOTHING for the host
       * and `pinnedLookup` would answer with an empty array, which is precisely
       * the case where a resolver falls back to the system one — the rebinding
       * window the pin exists to close, reopened by an empty success.
       *
       * So the safe reading is a refusal, not a navigation. A success arm that
       * falls through to "unpinned" is the same defect as an exception arm that
       * falls through to "allow".
       */
      this.count('REFUSED', permit.decision.decidedByClass, 'RESOLUTION_NOT_PINNED', permit.target.host);
      return { ok: false, exclusion: this.exclude(input) };
    }

    const addresses = permit.pinned.addresses.map((pin) => pin.address);
    this.rememberPin(permit.pinned.host, addresses);
    this.count('ALLOWED', permit.decision.decidedByClass, null, permit.target.host);
    return { ok: true, pinned: addresses, observed: false };
  }

  /**
   * THE SENTENCE A PROGRESS EVENT MAY CARRY.
   *
   * The crawl's progress events are ALREADY a port-reachability oracle — they
   * report what a navigation found — so this one takes no argument at all.
   * There is nothing to branch on, which is one fewer edit away from being an
   * oracle than a function that received a verdict and ignored it.
   */
  progressNote(): string {
    return EGRESS_EXCLUSION_RULE;
  }

  /** The tenant-visible ledger. One entry per refused URL. */
  exclusions(): readonly CrawlEgressExclusion[] {
    return [...this.ledger.values()];
  }

  /**
   * The ledger as `ExcludedPath` rows, under a kind THE CALLER MUST NAME.
   *
   * There is no default, and that is the whole design: see
   * {@link WANTED_EXCLUSION_KIND}. None of the seven existing kinds is true of
   * an egress refusal, so a default would have been a label that lies about
   * which rule fired. Typed `ExclusionKind`, so `'EGRESS_REFUSED'` does not
   * compile until it is a member — and once it is, this is the whole
   * integration.
   */
  asExcludedPaths(kind: ExclusionKind): readonly ExcludedPath[] {
    if (!(EXCLUSION_KINDS as readonly string[]).includes(kind)) {
      /*
       * A run-time check beside the compile-time one, because the two can
       * disagree: this function is reachable from a JSON-shaped caller whose
       * `kind` came off the wire, and a row with a kind the panel cannot render
       * is a refusal that disappears from the report.
       */
      throw new Error(`"${kind}" is not one of the crawl's exclusion kinds.`);
    }
    return this.exclusions().map((entry) => ({
      url: entry.url,
      route: entry.route,
      kind,
      rule: entry.rule,
      discoveredFrom: entry.discoveredFrom,
    }));
  }

  /**
   * THE LINE A REPORT PRINTS. Never a silent drop.
   *
   * `refused` and `wouldRefuse` are separate because they are opposite facts
   * about whether anything was actually stopped, and `allowed` is here so the
   * refusal count has a denominator — "we would have refused 1,204
   * connections" is only interesting beside how many there were.
   */
  summary(): {
    readonly refused: number;
    readonly wouldRefuse: number;
    readonly allowed: number;
    readonly total: number;
    readonly sentence: string;
  } {
    let refused = 0;
    let wouldRefuse = 0;
    let allowed = 0;
    for (const { row } of this.rows.values()) {
      if (row.outcome === 'REFUSED') refused += row.count;
      else if (row.outcome === 'WOULD_REFUSE') wouldRefuse += row.count;
      else allowed += row.count;
    }
    const total = refused + wouldRefuse + allowed;
    /*
     * The URL count and the CONNECTION count are different numbers and the
     * sentence says which it is quoting. `this.ledger` is keyed by URL, so it
     * is the number of distinct URLs refused; `refused` counts decisions, and
     * one URL offered from fifty pages is one ledger entry and one decision
     * only because `admit` is called once per frontier entry. Naming the
     * smaller, defensible number is the point.
     */
    const parts = [`${this.ledger.size} URL(s) refused by egress policy`];
    if (wouldRefuse > 0) {
      parts.push(
        `${wouldRefuse} more would have been refused if this environment’s egress policy were enforcing`,
      );
    }
    return { refused, wouldRefuse, allowed, total, sentence: parts.join('; ') };
  }

  /**
   * THE OPERATOR'S ROWS: the class, the refusal and the host.
   *
   * NOT FOR THE TENANT. For a CRAWL the tenant is the adversary — they chose
   * the base URL — so this is read inside the install, beside the
   * `EgressDecisionTally` rows, and never rendered into a crawl report. The
   * module header has the full argument.
   */
  operatorRows(): readonly CrawlEgressRow[] {
    return [...this.rows.values()]
      .map(({ row, hosts }) => ({ ...row, hosts: [...hosts].slice(0, HOST_SAMPLE_CAP) }))
      .sort((left, right) => right.count - left.count);
  }

  /**
   * The hosts this crawl is pinned to, with each pin's AGE.
   *
   * The age is the honest half: a pin is cached for {@link DEFAULT_PIN_TTL_MS}
   * because a browser's pinning is a launch argument, so "the browser went to
   * an address that was decided 14 minutes ago" is a fact a report should be
   * able to state rather than one a reader has to infer.
   */
  pins(): readonly CrawlPin[] {
    const now = this.clock();
    const live: CrawlPin[] = [];
    for (const [host, entry] of this.pinCache) {
      const ageMs = now - entry.takenAt;
      if (ageMs > this.ttlMs) continue;
      live.push({ host, addresses: entry.addresses, ageMs });
    }
    return live;
  }

  /**
   * THE BROWSER'S PINNING ARGUMENT, built from the live pins.
   *
   * `MAP host address` per pinned address, which is what Chromium's
   * `--host-resolver-rules` takes and what the guard's
   * `chromiumHostResolverRules` produces for a single permit. It is rebuilt
   * here from the gate's cache because the crawl launches ONE browser for many
   * hosts, so the argument is the union — and an EXPIRED pin contributes
   * nothing, which means a stale map entry cannot outlive its TTL.
   *
   * A host with no rule is resolved NORMALLY by the browser. So this function
   * pins and does not decide, and {@link admit} must be called for every URL
   * regardless: a launch argument is not a gate. Saying it twice because
   * getting it backwards is a control that looks applied and is not.
   */
  hostResolverRules(): string {
    const rules: string[] = [];
    const seen = new Set<string>();
    for (const pin of this.pins()) {
      for (const address of pin.addresses) {
        const rule = `MAP ${pin.host} ${address}`;
        if (seen.has(rule)) continue;
        seen.add(rule);
        rules.push(rule);
      }
    }
    return rules.join(',');
  }

  // ── the private half ──────────────────────────────────────────────────────

  private exclude(input: {
    readonly url: string;
    readonly route?: string | null;
    readonly discoveredFrom?: string | null;
  }): CrawlEgressExclusion {
    const entry: CrawlEgressExclusion = {
      // Capped the way `frontier.ts` caps a ledger URL, for the same reason: a
      // discovered URL is attacker-influenced and its length is not bounded.
      url: input.url.slice(0, 2_000),
      route: input.route ?? null,
      rule: EGRESS_EXCLUSION_RULE,
      discoveredFrom: input.discoveredFrom ?? null,
    };
    // Keyed by URL: one refused path offered from fifty pages is ONE refusal,
    // because the count a report prints is "31 URLs refused" and not "1,400
    // links ignored". `frontier.ts` does the same and says so.
    if (!this.ledger.has(entry.url)) this.ledger.set(entry.url, entry);
    return entry;
  }

  private count(
    outcome: CrawlEgressRow['outcome'],
    addressClass: AddressClass | null,
    refusal: string | null,
    host: string | null,
  ): void {
    const key = [outcome, addressClass ?? 'none', refusal ?? 'none'].join('\u001f');
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, {
        row: { outcome, addressClass, refusal, count: 1 },
        hosts: new Set(host === null ? [] : [host]),
      });
      return;
    }
    existing.row = { ...existing.row, count: existing.row.count + 1 };
    // The SET is capped, not the count: `hosts` is a sample and `count` is the
    // total, and conflating the two is how a truncated list gets read as a
    // complete one.
    if (host !== null && existing.hosts.size < HOST_SAMPLE_CAP) existing.hosts.add(host);
  }

  private rememberPin(host: string, addresses: readonly string[]): void {
    const existing = this.pinCache.get(host);
    const now = this.clock();
    /*
     * A live pin is KEPT rather than refreshed on every admit. Refreshing would
     * slide the TTL forward for as long as a crawl keeps visiting the host,
     * which is a TTL that never expires — the pin would be as old as the crawl
     * and `pins()` would report it as new.
     */
    if (existing !== undefined && now - existing.takenAt <= this.ttlMs) return;
    this.pinCache.set(host, { addresses: [...addresses], takenAt: now });
  }
}
