/**
 * "Is this address inside our own network?" — asked once, answered here.
 *
 * QAAI makes outbound requests on behalf of things it does not trust: a
 * customer-registered webhook URL, a Jira site, a plugin's mediated `http`
 * call. Every one of those is a string somebody else wrote, and every one of
 * them is turned into a connection FROM OUR ADDRESS SPACE. `169.254.169.254`
 * is not an exotic attack, it is the first thing anyone tries, and
 * `localhost:5432` is the second.
 *
 * ─── Why this file exists rather than a third copy ───────────────────────────
 *
 * The logic below was written for outbound event actions
 * (apps/worker/src/processors/actions.ts) and was, at the time this file was
 * added, the ONLY address classifier in the product — while the runner's plugin
 * sandbox, which also makes requests for untrusted code, had none at all. Two
 * copies of a security classifier is how one of them quietly stops matching the
 * other: somebody adds a range to the copy they are looking at, ships, and the
 * other path keeps accepting what was just refused. So the classification moved
 * here, to a module both a worker and the runner can import, and the callers
 * become the thin part.
 *
 * This module is deliberately NOT re-exported from packages/shared/src/index.ts:
 * `resolvesPublicly` reaches for `node:dns`, and the barrel is what the web
 * app's bundler consumes. Import it by path, the same way plugin-manifest.ts
 * (which needs `node:crypto`) is imported.
 *
 * ─── The rule every function here follows ────────────────────────────────────
 *
 * FAIL CLOSED ON AMBIGUITY. An address string that two parsers would read
 * differently is not "probably fine" — the disagreement IS the bypass. So
 * `0177.0.0.1` (127.0.0.1 to anything that honours octal, a hostname to
 * anything that does not) comes back `unparseable`, and every caller treats
 * `unparseable` the way it treats `loopback`. There is no reading of an
 * ambiguous literal that is worth the range of ways it can be wrong.
 */

import { promises as dns } from 'node:dns';

/**
 * What an address is, for the purpose of "may we open a connection to it from
 * inside our network on somebody else's say-so".
 *
 * Only `public` is ever a yes. Everything else — including `unparseable` — is a
 * no, which is why the union has no `unknown` member: there is nothing a caller
 * would do with it that it does not already do with `unparseable`.
 */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'link-local'
  | 'private'
  | 'multicast'
  | 'reserved'
  | 'unspecified'
  | 'unparseable';

/**
 * Classify a dotted-quad.
 *
 * Anything that is not exactly four plain decimal octets is `unparseable`, and
 * `unparseable` is refused — including octets with leading zeros, which some
 * resolvers and many parsers read as octal (`0177.0.0.1` is 127.0.0.1 to one
 * library and a nonsense hostname to the next). Disagreement between two
 * parsers about what an address means is the entire mechanism of this class of
 * bypass, so the only safe reading of an ambiguous string is "no".
 */
export function classifyIpv4(ip: string): AddressClass {
  const parts = ip.split('.');
  if (parts.length !== 4) return 'unparseable';

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return 'unparseable';
    if (part.length > 1 && part.startsWith('0')) return 'unparseable';
    const value = Number(part);
    if (value > 255) return 'unparseable';
    octets.push(value);
  }

  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT. Not "the internet" by any useful definition, and it is
  // where a surprising number of container networks land.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  // 169.254.0.0/16. The cloud metadata service — 169.254.169.254 on AWS, GCP
  // and Azure alike — lives here. This single line is most of the point of
  // this function.
  if (a === 169 && b === 254) return 'link-local';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'reserved';
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';

  return 'public';
}

/**
 * Expand an IPv6 literal into its eight groups, or null if it is not one.
 *
 * Written out rather than delegated to `net.isIP` because knowing that a string
 * IS an IPv6 address tells us nothing about WHICH address, and the whole
 * question here is which. Handles `::` once, and a trailing embedded IPv4
 * (`::ffff:127.0.0.1`), and refuses a zone index outright — `%eth0` only ever
 * appears on a link-local address, and an address that needs to name an
 * interface is by definition not on the public internet.
 */
export function expandIpv6(ip: string): number[] | null {
  const raw = ip.trim().toLowerCase();
  if (raw.includes('%')) return null;
  if (raw.length === 0 || raw.includes(':::')) return null;

  // A trailing dotted-quad contributes two groups.
  let tail: number[] = [];
  let head = raw;
  const lastColon = raw.lastIndexOf(':');
  const suffix = lastColon >= 0 ? raw.slice(lastColon + 1) : '';
  if (suffix.includes('.')) {
    if (classifyIpv4(suffix) === 'unparseable') return null;
    const [a = 0, b = 0, c = 0, d = 0] = suffix.split('.').map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    head = raw.slice(0, lastColon);
    // `::1.2.3.4` leaves head as `:`, which must still parse as the `::` form.
    if (head === '') head = ':';
  }

  const doubleColon = head.indexOf('::');
  if (doubleColon !== head.lastIndexOf('::')) return null;

  const toGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const out: number[] = [];
    for (const piece of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleColon >= 0) {
    const left = toGroups(head.slice(0, doubleColon));
    const right = toGroups(head.slice(doubleColon + 2));
    if (!left || !right) return null;
    const fill = 8 - (left.length + right.length + tail.length);
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
  } else {
    const only = toGroups(head);
    if (!only) return null;
    groups = [...only, ...tail];
  }

  return groups.length === 8 ? groups : null;
}

/**
 * Classify an IPv6 address.
 *
 * The embedded-IPv4 forms are the interesting ones and each gets handled rather
 * than falling through to `public`: `::ffff:169.254.169.254`, the 6to4 encoding
 * `2002:a9fe:a9fe::`, and NAT64's `64:ff9b::a9fe:a9fe` all name the metadata
 * service, and all three look like ordinary global unicast if you only check
 * the first group. Unique-local `fc00::/7` covers `fd00:ec2::254`, which is
 * exactly the IPv6 metadata endpoint on EC2.
 */
export function classifyIpv6(ip: string): AddressClass {
  const g = expandIpv6(ip);
  if (!g) return 'unparseable';

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  if (g.every((group) => group === 0)) return 'unspecified';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'loopback';
  }

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyIpv4(embedded(g6, g7));
  }
  // 64:ff9b::/96 — NAT64. Same trick, different prefix.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embedded(g6, g7));
  }
  // 2002::/16 — 6to4 carries the IPv4 address in groups 1 and 2.
  if (g0 === 0x2002) return classifyIpv4(embedded(g1, g2));
  // 100::/64 — the discard-only prefix.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved';
  // 2001:db8::/32 — documentation.
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xffc0) === 0xfec0) return 'private';
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';

  return 'public';
}

/** Classify whatever a resolver handed back, v4 or v6. */
export function classifyAddress(ip: string): AddressClass {
  return ip.includes(':') ? classifyIpv6(ip) : classifyIpv4(ip);
}

/**
 * Names that resolve inside a private network and must never receive a request
 * made on somebody else's behalf.
 *
 * `.svc` and `.cluster.local` are on the list because this product commonly
 * runs in Kubernetes, where `kubernetes.default.svc` is the cluster API server
 * and is reachable from every pod — a name that looks like an ordinary DNS name
 * to every check that only knows about IP literals.
 *
 * A SINGLE-LABEL name is on the list by construction rather than by suffix:
 * `redis`, `postgres`, `metadata` and every other service name in a compose
 * file or a search domain is one label, and none of them is a public
 * destination.
 */
const INTERNAL_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.intranet|.+\.lan|.+\.corp|.+\.private|.+\.svc|.+\.cluster\.local|.+\.home\.arpa)$/i;

/**
 * True for a name that resolves inside a private network.
 *
 * Deliberately NOT called `isInternalHostname`: apps/api/src/lib/issues.ts
 * exports a function under that name which covers the suffix list only, and its
 * callers apply the single-label rule separately. This one folds both in, so
 * giving it the same name would leave the codebase with one word meaning two
 * things — the exact defect this module exists to undo.
 *
 * Callers must strip trailing dots first — `localhost.` resolves exactly like
 * `localhost` and this pattern is anchored, so one character would otherwise
 * defeat it. `normalizeHost` below is the function that does that; use it.
 */
export function isPrivateNetworkName(host: string): boolean {
  return INTERNAL_HOST.test(host) || !host.includes('.');
}

/**
 * Lower-case and strip the trailing dot(s) a fully-qualified name may carry.
 *
 * `new URL('https://localhost./x').hostname` is `'localhost.'`, and DNS
 * resolves it to exactly the same address as `localhost`. Every anchored check
 * in this file assumes it is looking at the normalised form.
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * What a URL's hostname is, before any resolver is consulted.
 *
 * The three outcomes exist because a caller needs to tell them apart:
 *
 *  - `address` — an unambiguous IP literal, already classified. No DNS needed
 *    and none should be attempted; the answer cannot change.
 *  - `name` — an ordinary DNS name. Nothing is decided yet: a name is not a
 *    promise about where it points, so a caller that will actually connect has
 *    to resolve it (`resolvesPublicly`) before it may.
 *  - `ambiguous` — a host QAAI declines to read. This is the member that earns
 *    its keep. `0177.0.0.1`, `0x7f.0.0.1`, `2130706433` and `1.1` are all
 *    127.0.0.1 or 1.0.0.1 to something in the stack below us, and a hostname to
 *    something else. A caller MUST treat `ambiguous` exactly as it treats a
 *    loopback address, never as "a name we could look up" — handing one of
 *    these to a resolver is how the octal form gets a second chance.
 */
export type HostClass =
  | { kind: 'address'; class: AddressClass; host: string }
  | { kind: 'name'; host: string; internal: boolean }
  | { kind: 'ambiguous'; host: string; why: string };

/** Every label is digits, or the whole thing is one integer, or it starts 0x. */
const NUMERIC_ISH = /^(\d+|0x[0-9a-f]+)(\.(\d+|0x[0-9a-f]+))*$/i;

/**
 * Classify a URL hostname without resolving it.
 *
 * The ordering is the point. IPv6 first (it is unambiguous or it is nothing),
 * then the dotted-quad, then the numeric-looking residue — and that residue is
 * refused rather than handed on as a name. Reverse the last two and
 * `0177.0.0.1` becomes "a DNS name", which some resolvers will cheerfully
 * answer with 127.0.0.1.
 */
export function classifyHost(rawHost: string): HostClass {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: 'ambiguous', host, why: 'the URL has no host' };

  // A bracketed IPv6 literal as `URL.hostname` reports it.
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    const kind = classifyIpv6(inner);
    if (kind === 'unparseable') {
      return { kind: 'ambiguous', host, why: 'that is not an IPv6 address QAAI can read' };
    }
    return { kind: 'address', class: kind, host };
  }
  if (host.includes(':')) {
    const kind = classifyIpv6(host);
    if (kind === 'unparseable') {
      return { kind: 'ambiguous', host, why: 'that is not an IPv6 address QAAI can read' };
    }
    return { kind: 'address', class: kind, host };
  }

  // Characters outside the DNS alphabet mean the URL parser and the resolver
  // are about to disagree about what this string is. They may not.
  if (!/^[a-z0-9._-]+$/.test(host) || host.includes('..')) {
    return { kind: 'ambiguous', host, why: 'that is not a hostname QAAI can read' };
  }

  const quad = classifyIpv4(host);
  if (quad !== 'unparseable') return { kind: 'address', class: quad, host };

  /*
   * Anything that still looks like a number is one of the alternate encodings.
   * `2130706433`, `0177.0.0.1`, `0x7f.0.0.1`, `127.1` — every one of them is
   * loopback to some parser, and none of them is a hostname anybody registers.
   *
   * Worth knowing where this branch does and does not fire: a caller that got
   * its host out of `new URL(...).hostname` will never reach it, because the
   * WHATWG parser has already normalised all four of those to `127.0.0.1`
   * (verified, Node 25) and `classifyIpv4` above answers `loopback`. It fires
   * for the caller that has a bare host string — a config field, a header, a
   * hostname split off by hand — which is precisely the caller that has no
   * normaliser in front of it and most needs one.
   */
  if (NUMERIC_ISH.test(host)) {
    return { kind: 'ambiguous', host, why: 'that is an IP address written in a form QAAI will not guess at' };
  }

  return { kind: 'name', host, internal: isPrivateNetworkName(host) };
}

/** Injectable for tests; the real one is Node's resolver. */
export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

const nodeLookup: LookupFn = (host) => dns.lookup(host, { all: true, verbatim: true, family: 0 });

export interface ResolutionVerdict {
  ok: boolean;
  /** Populated on success; the addresses that were checked. */
  addresses: string[];
  /** Populated on refusal; a sentence naming the host, the address and the class. */
  reason: string;
}

/**
 * EVERY address a name answers with must be public — not the first, and not any.
 *
 * A hostname is not a promise about where it points, and a record set that mixes
 * one routable address with `169.254.169.254` is not a misconfiguration, it is
 * the attack written down. An empty answer is refused too: no addresses is not
 * "no problem".
 *
 * ── The honest limitation ────────────────────────────────────────────────────
 *
 * This is a CHECK, not a PIN. Whoever opens the connection afterwards resolves
 * the name again, so a resolver that answers differently the second time (DNS
 * rebinding, a one-second TTL, a poisoned cache) can still steer the request
 * somewhere this function refused. Closing that window means handing the
 * connecting code a pinned address, which is a property of the fetch call and
 * not of this module. Callers must not describe this as a guarantee.
 */
export async function resolvesPublicly(
  rawHost: string,
  lookup: LookupFn = nodeLookup,
  timeoutMs = 3_000,
): Promise<ResolutionVerdict> {
  const host = normalizeHost(rawHost);

  // A literal never reaches a resolver: the answer is already known, and asking
  // would give an alternate encoding a second chance at being interpreted.
  const staticVerdict = classifyHost(host);
  if (staticVerdict.kind === 'ambiguous') {
    return { ok: false, addresses: [], reason: `Refusing ${host}: ${staticVerdict.why}.` };
  }
  if (staticVerdict.kind === 'address') {
    return staticVerdict.class === 'public'
      ? { ok: true, addresses: [host], reason: '' }
      : {
          ok: false,
          addresses: [],
          reason: `Refusing ${host}: that is a ${staticVerdict.class} address.`,
        };
  }
  if (staticVerdict.internal) {
    return {
      ok: false,
      addresses: [],
      reason: `Refusing ${host}: that name resolves inside a private network.`,
    };
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await withTimeout(lookup(host), timeoutMs);
  } catch {
    // A name we could not resolve is a name we cannot vouch for. There is no
    // reading of a failed lookup that makes the destination safer.
    return { ok: false, addresses: [], reason: `Refusing ${host}: it could not be resolved.` };
  }

  const addresses = answers.map((answer) => answer.address).filter(Boolean);
  if (addresses.length === 0) {
    return { ok: false, addresses: [], reason: `Refusing ${host}: it resolved to no addresses.` };
  }

  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind !== 'public') {
      /*
       * Naming the address is deliberate: the host is already known to whoever
       * reads this, and the address it resolved to is the one fact that makes
       * the refusal actionable instead of baffling. The PATH never appears —
       * for a webhook the path IS the bearer credential.
       */
      return {
        ok: false,
        addresses,
        reason: `Refusing ${host}: it resolves to ${address}, which is a ${kind} address.`,
      };
    }
  }

  return { ok: true, addresses, reason: '' };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
