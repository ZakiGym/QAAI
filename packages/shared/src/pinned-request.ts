/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE PIN, ENFORCED AT THE SOCKET.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `guardUrl` hands back an {@link EgressPermit} carrying a PINNED ADDRESS SET,
 * and the pin is the half that turns a check into a control: whoever opens the
 * connection must connect to those addresses and must not resolve the name
 * again. Until this module existed, nothing did — five credential-carrying
 * paths called `guardUrl`, got a permit, and then called global `fetch(url)` by
 * name, which resolves independently.
 *
 * ── WHY THAT WAS NOT A TIMING RACE ──────────────────────────────────────────
 *
 * An adversary measured it end to end. Patching `dns.promises.lookup` — the
 * exact function the guards close over — to answer a public address to query #1
 * and `127.0.0.1` to query #2 produced, on a loopback server:
 *
 *     INTERNAL SERVER RECEIVED: POST /rest/api/2/issue
 *     host: jira.attacker.test | authorization present: true
 *
 * Exactly two DNS queries per request with no cache between them, because the
 * guard uses `dns.promises.lookup` and the transport resolves independently and
 * Node core caches neither. So an attacker who owns the authoritative
 * nameserver simply answers the second query differently. No timing precision
 * is needed and the bypass is 100% reliable.
 *
 * ── THE CLAIM THAT STOPPED THIS BEING FIXED, AND WHY IT WAS WRONG ───────────
 *
 * Three modules carried the same MEASURED note, used to justify leaving the pin
 * unenforced: "`fetch(url, { agent: new http.Agent({ lookup }) })` answered 200
 * and NEVER CALLED THE LOOKUP, while `{ dispatcher: … }` threw. There is no
 * supported way to hand global `fetch` a resolver."
 *
 * RE-MEASURED on Node v25.6.1 against a loopback server. The part about `fetch`
 * reproduces exactly — the `agent` option is silently IGNORED, 0 lookup calls,
 * which is the worst kind of failure because it looks like it worked. The
 * CONCLUSION was wrong:
 *
 *     http.request({ host, port, path, lookup })   ->  200, lookup called ONCE
 *
 * Node core honours it, with no dependency change. `undici`'s
 * `{ dispatcher: new undici.Agent({ connect: { lookup } }) }` also works and
 * keeps `fetch`, but `undici` resolves only out of the dev tree (an optional
 * dependency of `@electron/get`, under a devDependency of apps/desktop) and no
 * package.json declares it, so it would be ABSENT under `npm ci --omit=dev`.
 * The core option costs nothing, so that is the one taken.
 *
 * ── WHY THIS FILE IS NOT IN THE BARREL ──────────────────────────────────────
 *
 * It imports `node:http` and `node:https`. `packages/shared/src/index.ts` is
 * imported by `apps/web`, and the same rule already applies to
 * `private-address.ts`, which imports `node:dns` and is exported TYPE-ONLY for
 * exactly this reason. Import this module by path from a server workspace.
 * Nothing here may be re-exported from the barrel.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type { LookupFunction } from 'node:net';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

import { pinnedLookup } from './egress-guard';
import type { EgressPermit } from './egress-guard';

/** What a caller gets back. Deliberately not a `Response`. */
export interface PinnedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /**
   * The body as text, capped. Never parsed here: a caller that wants JSON knows
   * what it asked for, and a parser in this file would be a second place that
   * decides what an error page is.
   */
  readonly text: string;
  /**
   * True when the cap bit. A truncated body reported as a whole one is how a
   * reader comes to believe a provider answered something it did not.
   */
  readonly truncated: boolean;
}

export interface PinnedRequestInit {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * The TOTAL deadline for the call, not an inactivity window.
   *
   * Both are enforced and the distinction matters: Node's socket `timeout`
   * measures idleness between reads, so a host trickling bytes held a 1,200ms
   * budget open for 12,840ms when this was the only bound. A caller whose prose
   * says "did not answer within 15s" needs the elapsed meaning, so that is what
   * this field is.
   */
  readonly timeoutMs: number;
  /**
   * The cap on the body this reads, in bytes. Required rather than defaulted:
   * every caller already has a documented cap of its own and two different
   * numbers in two places is how one of them stops being the real one.
   */
  readonly maxBytes: number;
}

/**
 * Why a pinned request could not be made. A closed vocabulary, because callers
 * render these and a refusal assembled as a sentence is one that drifts.
 *
 * NOT_PINNED is the one worth reading twice: an OBSERVED permit authorised NO
 * addresses, so there is nothing to connect to. A caller in observe mode must
 * connect the way it did before this control existed — it may not borrow a pin
 * it was not given — and that is a decision for the caller, not a default here.
 */
export const PINNED_REQUEST_REFUSALS = [
  'NOT_PINNED',
  'UNPARSEABLE_URL',
  'SCHEME_NOT_SUPPORTED',
  'HOST_NOT_THE_PINNED_ONE',
  'TRANSPORT_FAILED',
  'TIMED_OUT',
] as const;
export type PinnedRequestRefusal = (typeof PINNED_REQUEST_REFUSALS)[number];

export type PinnedRequestResult =
  | { readonly ok: true; readonly response: PinnedResponse }
  | {
      readonly ok: false;
      readonly refusal: PinnedRequestRefusal;
      /**
       * For an operator, never for a caller's error message. It may name the
       * host and the transport's own words; it must not be rendered to whoever
       * supplied the URL, because a message that distinguishes "that address
       * refused the connection" from "that name does not resolve" is a port
       * scanner with a readable report.
       */
      readonly operatorDetail: string;
    };

/**
 * Make the request the permit authorised, to the addresses it pinned.
 *
 * ── WHAT IS AND IS NOT PRESERVED ────────────────────────────────────────────
 *
 * The NAME stays in the request: `host` in the options is the pinned hostname,
 * so the Host header, SNI and the certificate check all keep working, and only
 * the ADDRESS the socket goes to is decided by us. That is the whole reason to
 * pin the lookup rather than rewrite the URL to a literal — a rewritten URL
 * breaks TLS verification, and a Host header bolted back on top is two facts in
 * one request.
 *
 * REDIRECTS ARE NOT FOLLOWED, ever, and this is not configurable. Following one
 * would re-send the body — and the credential in the header, and for a webhook
 * the token in the path — to whatever `Location` names, which is a host nothing
 * classified. A 3xx comes back as a 3xx and the caller decides.
 */
export async function pinnedRequest(
  permit: EgressPermit,
  url: string,
  init: PinnedRequestInit,
): Promise<PinnedRequestResult> {
  if (permit.kind !== 'PINNED') {
    return {
      ok: false,
      refusal: 'NOT_PINNED',
      operatorDetail: `the permit is ${permit.kind}, so no address was authorised`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echoes the URL: an unparseable value is where a pasted
    // `https://user:secret@host/x` ends up.
    return { ok: false, refusal: 'UNPARSEABLE_URL', operatorDetail: 'the URL could not be parsed' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      refusal: 'SCHEME_NOT_SUPPORTED',
      operatorDetail: `${parsed.protocol} is not a scheme this transport opens`,
    };
  }

  /*
   * THE URL MUST BE THE ONE THAT WAS DECIDED ABOUT. A caller that pinned
   * `a.example.com` and then passed a URL for `b.example.com` would otherwise
   * send b's path to a's addresses with b's name in the Host header, which is
   * worse than no pin at all. `pinnedRequestTarget` makes the same check for
   * the same reason.
   */
  const asked = parsed.hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (asked !== permit.pinned.host) {
    return {
      ok: false,
      refusal: 'HOST_NOT_THE_PINNED_ONE',
      operatorDetail: `the permit pinned ${permit.pinned.host} and this URL names ${asked}`,
    };
  }

  const secure = parsed.protocol === 'https:';
  /*
   * ── ADAPTED, NOT CAST ───────────────────────────────────────────────────────
   *
   * `PinnedLookup` is the structural truth about what Node calls: on the error
   * path the address argument really is absent, and the array form it answers is
   * `readonly`. Node's own `LookupFunction` declares the address REQUIRED and the
   * array MUTABLE, so the two are not assignable in either direction.
   *
   * A cast would have silenced that and meant nothing. This adapter is three
   * lines and states which side gives: the error arm forwards the error and no
   * address, which is what Node's own resolvers do, and the array is copied so
   * nothing downstream can mutate a permit's pinned set.
   */
  const pinned = pinnedLookup(permit);
  const lookup: LookupFunction = (hostname, options, callback) => {
    pinned(hostname, options, (err, addressOrAddresses, family) => {
      if (err) {
        callback(err, '', undefined);
        return;
      }
      if (typeof addressOrAddresses === 'string') {
        callback(null, addressOrAddresses, family);
        return;
      }
      callback(null, [...(addressOrAddresses ?? [])]);
    });
  };
  /*
   * A FRESH AGENT PER REQUEST, deliberately. An agent is a connection pool, and
   * a pooled socket outlives the permit that authorised it — reusing one across
   * two permits for the same host would carry the first decision's addresses
   * into the second request. The cost is a TCP and TLS handshake per call,
   * which these paths already pay today through `fetch` without keep-alive, and
   * `keepAlive: false` says so rather than leaving it to a default.
   */
  const agent = secure
    ? new HttpsAgent({ lookup, keepAlive: false })
    : new HttpAgent({ lookup, keepAlive: false });

  const options: RequestOptions = {
    // THE NAME, not the address. See the doc block above.
    host: permit.pinned.host,
    port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    method: init.method,
    headers: { ...init.headers },
    agent,
    timeout: init.timeoutMs,
  };

  try {
    return await new Promise<PinnedRequestResult>((resolve) => {
      let settled = false;
      /*
       * ── A REAL DEADLINE, BECAUSE `timeout` IS NOT ONE ─────────────────────
       *
       * `RequestOptions.timeout` is Node's SOCKET timeout: it measures IDLENESS
       * between reads, not elapsed time. MEASURED against a server trickling 20
       * bytes every 400ms with `timeoutMs: 1200` — the call returned
       * SUCCESSFULLY after 12,840ms, because no single gap ever reached 1200ms.
       * A slow host therefore holds the connection for up to
       * (maxBytes / bytes-per-tick) x timeoutMs, which at the protocol plugin's
       * 8 MiB cap is effectively unbounded, inside an Express handler.
       *
       * THIS WOULD HAVE BEEN A REGRESSION. The `fetch` calls these paths
       * replaced passed `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, which IS a
       * deadline — so moving to this transport without one would have taken a
       * real bound away while every caller's prose, and the sentence one of them
       * renders to a user ("Jira did not answer within 15s"), still promised it.
       *
       * Both are kept: the socket timeout catches a host that accepts and says
       * nothing, and this catches one that says a little, forever. `unref` is
       * NOT used — this timer must keep the loop alive until it fires, or a
       * short-lived process could exit mid-request and call that a deadline.
       */
      /*
       * A one-field HOLDER rather than a `let`, because `finish` has to be able
       * to clear a timer that is created after it is defined — the timer's own
       * callback calls `finish`, so one of the two must come second. A `let`
       * read before its assignment is what `prefer-const` objects to, and the
       * holder is the honest answer to that rather than a disabled rule.
       */
      const deadline: { timer?: NodeJS.Timeout } = {};
      const finish = (result: PinnedRequestResult): void => {
        if (settled) return;
        settled = true;
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
        agent.destroy();
        resolve(result);
      };

      const req = (secure ? httpsRequest : httpRequest)(options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          bytes += chunk.length;
          if (bytes > init.maxBytes) {
            /*
             * REFUSED AT THE CAP AND REPORTED, not silently cut. The response is
             * destroyed so a hostile server cannot stream forever, and
             * `truncated` tells the caller the body it has is a floor.
             *
             * ── AND IT SETTLES HERE, WHICH IT DID NOT ─────────────────────────
             *
             * This block used to `res.destroy()` and then wait. MEASURED on Node
             * v25.6.1: after `destroy()` the events that fire are the response's
             * `aborted` and `close` and the request's `close`. `end` NEVER
             * fires, `error` never fires, and the socket `timeout` never fires
             * because the socket is already gone — so the promise was ORPHANED
             * FOR THE LIFE OF THE PROCESS.
             *
             * It only looked fine because of where the boundary sits. A body
             * small enough to be fully parsed before `destroy()` runs still
             * emits `end`: a 5 KiB answer against an 8 KiB cap settled in 7ms,
             * while 64 KiB and 256 KiB never settled at all. The boundary is the
             * socket receive buffer, not a number anyone chose — so over a real
             * network, where a large answer always arrives over many segments,
             * THE HANG IS THE NORMAL CASE AND NOT THE EDGE. Every caller plain-
             * `await`s this, so it wedged an Express handler and a worker
             * processor, reachable by any host that answers more than the cap.
             *
             * Settling explicitly rather than listening for `aborted`/`close`,
             * which would also fire on a server-side reset and would report that
             * as a successful truncated answer — the distinction the `error`
             * arm below exists to keep.
             */
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, init.maxBytes - (bytes - chunk.length))));
            res.destroy();
            finish({
              ok: true,
              response: {
                status: res.statusCode ?? 0,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
                truncated: true,
              },
            });
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          finish({
            ok: true,
            response: {
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
              truncated,
            },
          });
        });

        res.on('error', (err: Error) => {
          /*
           * A body that failed mid-stream is NOT a response: reporting the bytes
           * so far as a whole answer is the lie this arm exists to prevent, and
           * `finish` being idempotent means the cap's own settle above already
           * won if that is why we are here.
           *
           * There used to be a `if (truncated)` branch here returning a
           * successful truncated answer. It was DEAD — nothing set `truncated`
           * and then reached this handler, because the cap now settles itself —
           * and a dead branch in an error path reads as a live one to the next
           * reader. Removed rather than left.
           */
          finish({ ok: false, refusal: 'TRANSPORT_FAILED', operatorDetail: err.message });
        });
      });

      req.on('timeout', () => {
        // `timeout` does not abort on its own; destroying is what makes the
        // deadline real, and the refusal is reported as a timeout rather than as
        // whatever socket error the destroy produces.
        req.destroy();
        finish({
          ok: false,
          refusal: 'TIMED_OUT',
          operatorDetail: `no answer within ${init.timeoutMs}ms`,
        });
      });

      req.on('error', (err: Error) => {
        /*
         * This is also where a REFUSED PIN surfaces: `pinnedLookup` calls back
         * with an Error rather than an empty success, and the agent turns that
         * into a request error. So a permit that pinned another host, or an
         * OBSERVED one, fails the connection instead of falling through to the
         * system resolver — which is the entire point.
         */
        finish({ ok: false, refusal: 'TRANSPORT_FAILED', operatorDetail: err.message });
      });

      deadline.timer = setTimeout(() => {
        req.destroy();
        finish({
          ok: false,
          refusal: 'TIMED_OUT',
          operatorDetail: `no answer within ${init.timeoutMs}ms`,
        });
      }, init.timeoutMs);

      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  } finally {
    agent.destroy();
  }
}
