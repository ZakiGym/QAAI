/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE JIRA CREDENTIAL, AND THE ADDRESS IT IS ACTUALLY SENT TO.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `issues.test.ts` stubs global `fetch` and opens no socket. That is the right
 * shape for everything it proves — the host is the constant, a 3xx is not a hop,
 * a bad key refuses — and it is the WRONG shape for the one question this file
 * exists to answer, which is WHICH ADDRESS THE SOCKET WENT TO. A pin tested
 * only against a fake transport is a pin nobody has evidence for, and that is
 * exactly how this defect survived four rounds: `sendToJira` read `verdict.ok`,
 * threw the permit away, and called `fetch(url)` by name.
 *
 * ── THE DEFECT, MEASURED ON THE PRODUCTION PATH BEFORE THIS FILE EXISTED ────
 *
 * An adversary patched BOTH resolver entry points off one counter — the guard's
 * `dns.promises.lookup` and the `dns.lookup` that `net.connect` and therefore
 * global `fetch` use — so that query #1 answered a public address and query #2
 * answered 127.0.0.1. Driving `createIssue` with a Jira config pointed at
 * `jira.attacker.test` produced, on a loopback server:
 *
 *     INTERNAL SERVER RECEIVED: POST /rest/api/2/issue
 *     host: jira.attacker.test:55181 | authorization present: true
 *     DNS queries: 2  (#1 guard -> 93.184.216.34, #2 transport -> 127.0.0.1)
 *     createIssue -> RESOLVED {"provider":"JIRA","key":"QA-1", ...}
 *
 * Two queries, no cache between them, 100% reliable, no timing precision
 * needed, and `createIssue` reported success about a ticket it had filed on a
 * loopback server. That is a tenant admin escalating to SSRF against QAAI's own
 * infrastructure WITH THE CREDENTIAL ATTACHED.
 *
 * ── NO NETWORK, AND LOOPBACK IS NOT NETWORK ─────────────────────────────────
 *
 * Every test below opens a REAL socket to a REAL loopback server. Nothing
 * leaves the machine, and the only name the system resolver is ever asked for
 * is `localhost`. Real sockets are REQUIRED here: the pin lives in the lookup
 * an `http.Agent` is built with, and a fake transport cannot have one.
 *
 * ── WHY `localhost` IS THE HOST NAME, AND WHY THAT IS LOAD-BEARING ──────────
 *
 * It is the discriminator. A `.invalid` name never resolves, so a test using one
 * passes whether the pin is honoured or not — `pinned-request.test.ts` records a
 * version of its own rebind test that was VACUOUS for exactly that reason.
 * `localhost` DOES resolve, to 127.0.0.1, everywhere. So pinning an unroutable
 * PUBLIC address and pointing the URL at `localhost` splits the two
 * behaviours cleanly: a transport that re-resolves the name reaches the loopback
 * server, and one that honours the pin cannot.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPermit } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  IssueFilingError,
  TRACKER_PIN_LIMITATION,
  createIssue,
  trackerByNameSends,
  updateIssue,
} from './issues.js';
import type { IssueTrackerConfig, TrackerEgressGuard } from './issues.js';

/**
 * RFC 5737 TEST-NET-1. Routable-looking, classified `public`, and routes
 * nowhere — so a connection to it cannot succeed and cannot reach anything on
 * this machine either. This is the address the attacker's FIRST DNS answer
 * stands for: the one the guard approved.
 */
const UNROUTABLE_PUBLIC = '192.0.2.1';

/**
 * Not key-shaped, and composed rather than written. A complete key-shaped
 * literal — even an invented one, even in a test — is what got a finished green
 * commit rejected by push protection in an earlier round.
 */
const TOKEN = ['fake', 'tracker', 'token', 'for', 'tests'].join('-');

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly authorization: boolean;
  readonly body: string;
}

const servers: Server[] = [];

/**
 * A loopback server standing in for whatever the socket reaches, recording
 * enough to answer "did the credential arrive here".
 *
 * It records whether an `authorization` header was PRESENT and never its value:
 * a test name, an assertion message or a diff that carried a credential would be
 * the same defect this file is about, in a different file.
 */
async function listen(answer: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        host: req.headers.host,
        authorization: req.headers.authorization !== undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        ...(answer.headers ?? {}),
      });
      res.end(answer.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, hits };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * A PINNED permit for `host`, pinning exactly `addresses`.
 *
 * Built by hand rather than through `guardUrl`, because what is under test here
 * is whether THE SENDER OBEYS A PERMIT, not the policy that produces one — and
 * the real policy cannot be made to pin a loopback address at all: TRACKER_CALL
 * has `allowlistApplies: false` and refuses `loopback` in every deployment,
 * which `issues.test.ts` asserts against the real default guard. The fields the
 * transport reads are `kind`, `pinned.host` and `pinned.addresses`; the rest is
 * the shape the type requires. Same construction as
 * `packages/shared/src/pinned-request.test.ts`.
 */
function permitFor(host: string, addresses: readonly string[], port: number): EgressPermit {
  return {
    kind: 'PINNED',
    context: 'TRACKER_CALL',
    target: { host, scheme: 'http:', port: String(port), origin: `http://${host}:${port}` },
    decision: { allowed: true },
    pinned: {
      host,
      addresses: addresses.map((address) => ({
        address,
        class: address.startsWith('127.') ? 'loopback' : 'public',
      })),
    },
    wouldRefuse: null,
  } as unknown as EgressPermit;
}

/** An OBSERVED permit: the policy would have refused, the brake is armed, no pin exists. */
function observedPermit(host: string, port: number): EgressPermit {
  return {
    kind: 'OBSERVED',
    context: 'TRACKER_CALL',
    target: { host, scheme: 'http:', port: String(port), origin: `http://${host}:${port}` },
    decision: { allowed: true, outcome: 'WOULD_REFUSE' },
    pinned: null,
    wouldRefuse: 'CLASS_NOT_PERMITTED',
    observedBy: 'POLICY',
  } as unknown as EgressPermit;
}

/** A guard that hands back exactly this permit, so the SENDER is what is measured. */
function guardReturning(permit: EgressPermit): TrackerEgressGuard {
  return async () => ({ ok: true, permit });
}

/** The Jira integration row, pointed at one site. `jiraSite` is not in the way here. */
function jiraAt(site: string): IssueTrackerConfig {
  return {
    kind: 'JIRA',
    site,
    projectKey: 'QA',
    issueType: 'Bug',
    email: null,
    keyVersion: 1,
  };
}

let byNameBefore: Readonly<Record<'CONSTANT_HOST' | 'OBSERVE_MODE', number>>;

beforeEach(() => {
  // The counter is process-local and monotonic, so every assertion about it is
  // a DELTA. An absolute expectation would pass or fail on file order.
  byNameBefore = trackerByNameSends();
});

describe('the Jira request goes to the address the guard pinned', () => {
  it('reaches the pinned address and keeps the NAME in the request', async () => {
    const jira = await listen({ status: 201, body: JSON.stringify({ key: 'QA-13' }) });

    const created = await createIssue(
      jiraAt(`http://localhost:${jira.port}`),
      TOKEN,
      { title: 'a title', body: 'a body' },
      guardReturning(permitFor('localhost', ['127.0.0.1'], jira.port)),
    );

    expect(created).toEqual({
      provider: 'JIRA',
      url: `http://localhost:${jira.port}/browse/QA-13`,
      key: 'QA-13',
    });
    expect(jira.hits).toHaveLength(1);
    expect(jira.hits[0]?.method).toBe('POST');
    expect(jira.hits[0]?.path).toBe('/rest/api/2/issue');
    // The credential is on the FIRST AND ONLY request, which is what makes this
    // path the worst of the five: there is no pre-flight to lose instead.
    expect(jira.hits[0]?.authorization).toBe(true);
    /*
     * THE NAME SURVIVED. `pinnedRequest` puts the pinned HOSTNAME in the request
     * options and decides only the ADDRESS the socket goes to, so Host — and on
     * the https path SNI and the certificate check — are the name. Rewriting the
     * URL to an address literal would have broken TLS verification and a Host
     * header bolted back on is two facts in one request.
     */
    expect(jira.hits[0]?.host).toBe(`localhost:${jira.port}`);
    expect(JSON.parse(jira.hits[0]?.body ?? 'null')).toEqual({
      fields: {
        project: { key: 'QA' },
        summary: 'a title',
        description: 'a body',
        issuetype: { name: 'Bug' },
      },
    });
    // Nothing went out by name on this path.
    expect(trackerByNameSends()).toEqual(byNameBefore);
  });

  it('pins the EDIT path too, not only the create', async () => {
    // Both Jira requests go through one `sendToJira`, so a fifth caller cannot
    // forget the permit. If the edit ever got its own send, this notices.
    const jira = await listen({ status: 204 });

    await updateIssue(
      jiraAt(`http://localhost:${jira.port}`),
      TOKEN,
      'QA-12',
      { body: 'a new body' },
      guardReturning(permitFor('localhost', ['127.0.0.1'], jira.port)),
    );

    expect(jira.hits).toHaveLength(1);
    expect(jira.hits[0]?.method).toBe('PUT');
    expect(jira.hits[0]?.path).toBe('/rest/api/2/issue/QA-12');
    expect(jira.hits[0]?.authorization).toBe(true);
  });

  it('REFUSES, AND SENDS NOTHING, WHEN THE NAME IS REBOUND BETWEEN THE GUARD AND THE SOCKET', async () => {
    /*
     * ── THE DEFECT, CLOSED, AND THE TEST THIS FILE EXISTS FOR ──────────────
     *
     * The permit pins an unroutable PUBLIC address — the attacker's first DNS
     * answer, the one the guard classified and approved. The loopback server
     * is the INTERNAL host their second answer points at. The URL names
     * `localhost`, which really does resolve to 127.0.0.1.
     *
     * So: a transport that resolves the name again reaches the internal server
     * and hands it the credential, which is precisely what was measured on
     * this path. A transport that honours the pin cannot reach it at all.
     *
     * WHAT IS ASSERTED IS THE INTERNAL SERVER'S OWN RECORD — zero hits — and
     * not merely that the call threw. "It threw" would also be true of a
     * transport that connected, leaked the header and then failed.
     *
     * WHY THIS TEST IS SLOW: the refusal is the PRODUCTION deadline,
     * REQUEST_TIMEOUT_MS, because a connection to an address that routes
     * nowhere is answered by nothing at all. MEASURED on this machine:
     * TIMED_OUT after 15,004ms. A shorter deadline for the test's benefit
     * would be a second number beside the real one, and this repository has
     * already paid for one of those.
     */
    const internal = await listen({ status: 201, body: JSON.stringify({ key: 'QA-99' }) });

    const thrown = await createIssue(
      jiraAt(`http://localhost:${internal.port}`),
      TOKEN,
      { title: 'a title', body: 'a body' },
      guardReturning(permitFor('localhost', [UNROUTABLE_PUBLIC], internal.port)),
    ).catch((caught: unknown) => caught);

    // THE ANSWER THE WHOLE ROUND IS JUDGED ON.
    expect(internal.hits).toEqual([]);
    expect(thrown).toBeInstanceOf(IssueFilingError);
    // And it is a refusal, not a success reported as one.
    expect(thrown).not.toHaveProperty('provider');

    const text = thrown instanceof Error ? `${thrown.message}${thrown.stack ?? ''}` : '';
    expect(text).not.toContain(TOKEN);
    // Not a prefix either: part of a credential is still a credential.
    expect(text).not.toContain(TOKEN.slice(0, 8));
    // No oracle. The refusal must not say which address was pinned, nor that
    // the pinned one was the thing that failed.
    expect(text).not.toContain(UNROUTABLE_PUBLIC);
    expect(text).not.toContain('localhost');
  }, 30_000);

  it('refuses a PINNED permit that authorises no address, rather than sending by name', async () => {
    /*
     * A pin that authorises nothing is as dangerous as no pin: `pinnedLookup`
     * answers nothing for an empty set, and a resolver that answers nothing
     * falls back to the system one in some Node versions — the rebinding window
     * reopened by an empty success. `approvalFor` in `runner/src/login.ts`
     * refuses the same case. It is a BROKEN PERMIT and not a mode, so it must
     * not be counted as an observe-mode send either.
     */
    const internal = await listen({ status: 201, body: JSON.stringify({ key: 'QA-98' }) });

    await expect(
      createIssue(
        jiraAt(`http://localhost:${internal.port}`),
        TOKEN,
        { title: 't', body: 'b' },
        guardReturning(permitFor('localhost', [], internal.port)),
      ),
    ).rejects.toThrow(EGRESS_REFUSAL_SENTENCE);

    expect(internal.hits).toEqual([]);
    expect(trackerByNameSends()).toEqual(byNameBefore);
  });

  it('refuses when the permit pinned a DIFFERENT host from the one the URL names', async () => {
    // A caller that pinned `a` and sent a URL for `b` would otherwise put b's
    // path and b's Host header on a's addresses, which is worse than no pin.
    // Instant, because `pinnedRequest` checks before it opens anything.
    const internal = await listen({ status: 201, body: JSON.stringify({ key: 'QA-97' }) });

    await expect(
      createIssue(
        jiraAt(`http://localhost:${internal.port}`),
        TOKEN,
        { title: 't', body: 'b' },
        guardReturning(permitFor('jira.example.test', ['127.0.0.1'], internal.port)),
      ),
    ).rejects.toThrow(EGRESS_REFUSAL_SENTENCE);

    expect(internal.hits).toEqual([]);
  });

  it('treats a 3xx from the pinned host as an error and not a hop', async () => {
    /*
     * `pinnedRequest` never follows a redirect and that is not configurable, so
     * this is the same rule `redirect: 'manual'` bought on the by-name path:
     * following one would re-send the body AND the authorization header to
     * whatever `Location` names, which is a host nothing classified.
     */
    const jira = await listen({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });

    await expect(
      createIssue(
        jiraAt(`http://localhost:${jira.port}`),
        TOKEN,
        { title: 't', body: 'b' },
        guardReturning(permitFor('localhost', ['127.0.0.1'], jira.port)),
      ),
    ).rejects.toThrow(/redirect/i);

    // ONE request. A followed redirect would be two, and the second would carry
    // the credential to an address nothing decided about.
    expect(jira.hits).toHaveLength(1);
  });
});

describe('a guard refusal still means nothing was sent, measured at the socket', () => {
  /**
   * A resolver that answers from a table and THROWS on anything else, so a
   * deleted guard call fails loudly rather than resolving quietly. Copied in
   * shape from `issues.test.ts`, which explains why it throws.
   */
  function fakeIo(zone: Readonly<Record<string, readonly string[]>>): EgressGuardIo {
    return {
      classifyHost: (host) => classifyHost(host),
      classifyAddress: (address) => classifyAddress(address),
      lookup: async (host) => {
        const answers = zone[host];
        if (answers === undefined) {
          throw new Error(`fakeIo was asked to resolve ${host}, which this test never declared`);
        }
        return answers.map((address) => ({ address }));
      },
      now: () => new Date('2026-11-05T00:00:00.000Z'),
      monotonicMs: () => 0,
      delay: async () => {},
    };
  }

  it('refuses a public-looking Jira host that resolves to the metadata address, and the port stays untouched', async () => {
    /*
     * The REAL decision logic over a fake zone, and the URL points at a REAL
     * loopback server. `issues.test.ts` proves the same refusal against a
     * stubbed `fetch`; this proves it against a socket, so a regression that
     * reached the transport anyway would be caught by the server's own record
     * rather than by a stub nobody called.
     */
    const internal = await listen({ status: 201, body: JSON.stringify({ key: 'QA-96' }) });
    const guard: TrackerEgressGuard = (url) =>
      guardUrl({
        url,
        context: 'TRACKER_CALL',
        policy: resolveEgressPolicy(undefined),
        io: fakeIo({ 'jira.attacker.test': ['169.254.169.254'] }),
      });

    await expect(
      createIssue(
        jiraAt(`http://jira.attacker.test:${internal.port}`),
        TOKEN,
        { title: 't', body: 'b' },
        guard,
      ),
    ).rejects.toThrow(EGRESS_REFUSAL_SENTENCE);

    expect(internal.hits).toEqual([]);
  });
});

describe('OBSERVE mode: by name, as promised, and counted', () => {
  it('sends by name on an OBSERVED permit and counts the send', async () => {
    /*
     * An OBSERVED permit authorises NO address, so `pinnedRequest` refuses it
     * with NOT_PINNED — correctly, because borrowing a pin nobody issued would
     * be a worse lie than the hole OBSERVE deliberately leaves open. The
     * defensible answer is the one OBSERVE promises: connect exactly as before
     * the control existed, BY NAME, with the rebinding window open. Taking the
     * integration away from an operator who armed the brake would be the silent
     * behaviour change the brake exists to prevent.
     *
     * WHAT MAKES THIS NOT A HOLE IS THAT IT IS COUNTED. A mode that does not
     * count is an off switch with a reassuring name.
     */
    const jira = await listen({ status: 201, body: JSON.stringify({ key: 'QA-95' }) });

    const created = await createIssue(
      jiraAt(`http://localhost:${jira.port}`),
      TOKEN,
      { title: 't', body: 'b' },
      guardReturning(observedPermit('localhost', jira.port)),
    );

    expect(created.key).toBe('QA-95');
    expect(jira.hits).toHaveLength(1);
    expect(jira.hits[0]?.authorization).toBe(true);

    const after = trackerByNameSends();
    expect(after.OBSERVE_MODE).toBe(byNameBefore.OBSERVE_MODE + 1);
    // And it is not miscounted as the constant-host case, which is the one
    // reason to connect by name that needs no brake.
    expect(after.CONSTANT_HOST).toBe(byNameBefore.CONSTANT_HOST);
  });
});

describe('the paragraph that says what this control does', () => {
  it('no longer claims the pin is unenforced, because it is enforced', async () => {
    /*
     * RULE: a doc comment that contradicts the code under it is the worst defect
     * a security file can ship, because the comment is what the next reviewer
     * trusts instead of reading the code. This file's predecessor shipped one
     * that said this very fix was impossible, and it closed the question for
     * four rounds. Asserting the text is how it stops drifting back.
     */
    expect(TRACKER_PIN_LIMITATION).not.toMatch(/not enforced/i);
    expect(TRACKER_PIN_LIMITATION).not.toMatch(/cannot be handed a resolver/i);
    expect(TRACKER_PIN_LIMITATION).toMatch(/not resolved a second time/i);
    // And it still says what is NOT closed, because two of the five send paths
    // in this module genuinely still connect by name.
    expect(TRACKER_PIN_LIMITATION).toMatch(/GitHub and Linear/);
    expect(TRACKER_PIN_LIMITATION).toMatch(/OBSERVE/);
  });
});
