/**
 * Editing a ticket that is already on the customer's board.
 *
 * `createIssue` has always been the only way out of this module, which is why
 * the re-file path could report nothing better than `providerBodyRefreshed:
 * false`: one ticket per cause was kept, and the ticket's body went on listing
 * the tests known at filing time. `updateIssue` closes that, and it carries a
 * request with a customer's personal access token on it — so the tests here are
 * mostly about what it refuses.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. THE HOST IS THE CONSTANT. A ticket's provider key is read back out of
 *      the database and interpolated into a path. If it could choose the host
 *      instead, a row an admin can edit would be able to point a request
 *      carrying the token at a server of their choosing.
 *   2. A 3xx IS AN ERROR, NOT A HOP. Following one re-sends the Authorization
 *      header to whatever Location names, which is precisely how a PAT walks
 *      out of the building.
 *   3. THE RIGHT METHOD, PER PROVIDER. A PATCH sent as a POST creates a second
 *      issue instead of editing the first — the forty-tickets defect, caused by
 *      the fix for it.
 *   4. A REFUSAL IS A REFUSAL. An empty patch, an unparseable key, a `success:
 *      false` inside a 200: each has to throw, because the caller turns "did
 *      not throw" into `providerBodyRefreshed: true` and tells the user their
 *      ticket was rewritten.
 *
 * `fetch` is stubbed globally; nothing here opens a socket.
 *
 * ── WHAT MOVED OUT OF THIS FILE, AND WHY ────────────────────────────────────
 *
 * THE JIRA PATH NO LONGER GOES THROUGH GLOBAL `fetch`. It threads the permit
 * `guardUrl` issued into `pinnedRequest`, which opens the connection to the
 * addresses the guard classified and does NOT resolve the name again — the half
 * of the control that was missing while this path got a permit and discarded
 * it. A stub of `fetch` therefore cannot observe a Jira send at all, and the two
 * tests here that asserted one by reading `sent[0]` have moved to
 * `issues.pin.test.ts`, where a real loopback server records which address the
 * socket actually went to.
 *
 * `expect(sent).toEqual([])` in the Jira blocks below is NOT vacuous because of
 * that: it is now also the assertion that the Jira path has not regressed to
 * global `fetch`. The refusals it guards are proven against a real socket as
 * well, in `issues.pin.test.ts`.
 *
 * It also removed a DNS query this file used to make. `updateIssue(jira, …)`
 * with no injected guard built the real `defaultTrackerEgressGuard`, which
 * resolved `acme.atlassian.net` through the system resolver; with the pin
 * enforced that would have gone on to open a TCP connection to Atlassian from
 * the unit suite. Every Jira test here now either injects a guard or refuses
 * before the guard runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPolicy } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import { IssueFilingError, createIssue, defaultTrackerEgressGuard, updateIssue } from './issues.js';
import type { IssueTrackerConfig, TrackerEgressGuard } from './issues.js';

const TOKEN = 'ghp_atokenthatmustneverappearanywhere';

interface Sent {
  url: string;
  method: string;
  redirect: string;
  headers: Record<string, string>;
  body: unknown;
  hasSignal: boolean;
}

let sent: Sent[] = [];

/** Answers every request with one canned response. */
function stubFetch(response: { status: number; body?: unknown }): void {
  vi.stubGlobal('fetch', async (url: string, init: Record<string, any>) => {
    sent.push({
      url: String(url),
      method: String(init.method),
      redirect: String(init.redirect),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
      hasSignal: Boolean(init.signal),
    });
    return {
      status: response.status,
      type: 'default',
      ok: response.status >= 200 && response.status < 300,
      text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
    } as unknown as Response;
  });
}

const github: IssueTrackerConfig = {
  kind: 'GITHUB',
  repo: 'acme/storefront',
  labels: [],
  keyVersion: 1,
};
const jira: IssueTrackerConfig = {
  kind: 'JIRA',
  site: 'https://acme.atlassian.net',
  projectKey: 'QA',
  issueType: 'Bug',
  email: 'bot@acme.test',
  keyVersion: 1,
};
const linear: IssueTrackerConfig = {
  kind: 'LINEAR',
  teamId: '11111111-2222-3333-4444-555555555555',
  labelIds: [],
  keyVersion: 1,
};

const patch = { title: 'A new title', body: 'A new body' };

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateIssue — GitHub', () => {
  it('PATCHes the pinned API host, with the number taken out of the stored key', async () => {
    stubFetch({ status: 200, body: { number: 12 } });

    await updateIssue(github, TOKEN, 'acme/storefront#12', patch);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.github.com/repos/acme/storefront/issues/12');
    // POST would CREATE a second issue instead of editing the first.
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.body).toEqual({ title: 'A new title', body: 'A new body' });
  });

  it('builds the path from the CONFIG repo, never from the stored key', async () => {
    /*
     * The key is a value read back out of the database. If the repo on it
     * decided where the request went, a row an admin can edit would choose the
     * destination of a request carrying the customer's token. Only the trailing
     * number is taken from it.
     */
    stubFetch({ status: 200, body: { number: 9 } });

    await updateIssue(github, TOKEN, 'attacker/evil#9', patch);

    expect(sent[0]!.url).toBe('https://api.github.com/repos/acme/storefront/issues/9');
  });

  it('never follows a redirect, and never waits forever', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await updateIssue(github, TOKEN, 'acme/storefront#1', patch);

    // Following a 3xx would re-send the Authorization header to whatever
    // Location named.
    expect(sent[0]!.redirect).toBe('manual');
    expect(sent[0]!.hasSignal).toBe(true);
  });

  it('treats a 3xx as a failure rather than a hop', async () => {
    stubFetch({ status: 302 });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', patch)).rejects.toThrow(
      /redirect/i,
    );
  });

  it('says the ticket is GONE on a 404, which is a different fix from a 404 on create', async () => {
    // On a create a 404 means the repo is wrong; on an edit it means the TICKET
    // has been deleted or moved, and the honest advice is "file a new one"
    // rather than "fix your integration".
    stubFetch({ status: 404 });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', patch)).rejects.toThrow(
      /no longer has that issue/,
    );
  });

  it('refuses a stored key it cannot read a number out of', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await expect(updateIssue(github, TOKEN, 'acme/storefront', patch)).rejects.toBeInstanceOf(
      IssueFilingError,
    );
    // And it refuses BEFORE sending anything.
    expect(sent).toEqual([]);
  });

  it('sends only the fields the patch names', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await updateIssue(github, TOKEN, 'acme/storefront#1', { body: 'only the body' });

    expect(sent[0]!.body).toEqual({ body: 'only the body' });
  });
});

describe('updateIssue — Jira', () => {
  /*
   * THE URL, THE METHOD, THE BODY AND THE 204 ARE ASSERTED IN
   * `issues.pin.test.ts`, against a real loopback server, because the Jira path
   * now sends through `pinnedRequest` and a `fetch` stub cannot see it. What is
   * left here is the refusal that happens BEFORE any transport is chosen.
   */
  it('refuses a key that is not a key, before sending anything', async () => {
    stubFetch({ status: 204 });

    await expect(
      updateIssue(jira, TOKEN, '../../../rest/api/2/myself', patch),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });
});

describe('updateIssue — Linear', () => {
  const ok = { data: { issueUpdate: { success: true, issue: { identifier: 'ENG-12' } } } };

  it('posts the update mutation to the pinned GraphQL host', async () => {
    stubFetch({ status: 200, body: ok });

    await updateIssue(linear, TOKEN, 'ENG-12', patch);

    expect(sent[0]!.url).toBe('https://api.linear.app/graphql');
    expect(sent[0]!.method).toBe('POST');
    const body = sent[0]!.body as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('issueUpdate');
    expect(body.variables.id).toBe('ENG-12');
    expect(body.variables.input).toEqual({ title: 'A new title', description: 'A new body' });
  });

  it('reads the failure Linear reports inside a 200', async () => {
    // GraphQL reports failure in a 200, so an unknown issue id looks exactly
    // like success until the errors array is read.
    stubFetch({ status: 200, body: { errors: [{ message: 'Entity not found' }] } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/Entity not found/);
  });

  it('refuses to call a `success: false` a success', async () => {
    /*
     * Linear's other way of saying no: a 200, no errors array, and
     * `success: false`. The caller turns "did not throw" into
     * `providerBodyRefreshed: true`, so swallowing this would tell a user their
     * ticket was rewritten when it was not.
     */
    stubFetch({ status: 200, body: { data: { issueUpdate: { success: false } } } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/did not confirm/);
  });

  it('redacts anything token-shaped out of a provider message', async () => {
    stubFetch({ status: 200, body: { errors: [{ message: `bad auth for ${TOKEN}` }] } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/\[redacted\]/);
  });
});

describe('updateIssue refuses an empty patch', () => {
  it('throws rather than issuing a no-op request', async () => {
    /*
     * A caller that believes it refreshed a ticket and sent nothing is the
     * caller that reports `providerBodyRefreshed: true` about a ticket it never
     * touched.
     */
    stubFetch({ status: 200, body: { number: 1 } });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', {})).rejects.toThrow(
      /has to change the title, the body, or both/,
    );
    expect(sent).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The egress guard on the Jira path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THESE PROVE, AND WHY THE OLD CHECK DID NOT.
 *
 * `jiraSite` refuses the names it can RECOGNISE — `localhost`, `*.internal`,
 * `*.svc`, an IP literal, a single label. It decides nothing about where an
 * ordinary name points, and MEASURED on this tree before the change:
 * `jiraSite('https://jira.attacker.test/')` returned
 * `https://jira.attacker.test` and the vault-unsealed Jira credential went
 * there. `classifyHost('jira.attacker.test')` is
 * `{kind:'name', internal:false}`, which is not permission — it is the
 * statement that nothing has been decided.
 *
 * So the tests below drive the REAL `guardUrl` with a FAKE resolver. The
 * decision logic is the shipped one; only DNS, the clock and the sleep are
 * injected, because a control that cannot be tested with a fake is a control
 * nobody trusts. NOTHING HERE OPENS A SOCKET OR CONSULTS A RESOLVER.
 */

/**
 * A resolver that answers from a table and THROWS on anything else.
 *
 * Throwing rather than returning an empty answer is the point: a fake that
 * quietly resolves an unlisted host is a fake that makes a deleted call site
 * undetectable, which is how a fix shipped unreachable in an earlier round.
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
    now: () => new Date('2026-10-30T00:00:00.000Z'),
    monotonicMs: () => 0,
    // The refusal floor is injected away: asserting the pad is `egress-guard`'s
    // job, and a real 250ms sleep per refusal would cost this file a second.
    delay: async () => {},
  };
}

/** The Jira fixture, repointed at one host. The rest of the config is irrelevant here. */
function jira2(site: string): IssueTrackerConfig {
  return { ...(jira as Extract<IssueTrackerConfig, { kind: 'JIRA' }>), site };
}

/** A guard over the real decision logic and a fake zone. */
function guardWith(
  zone: Readonly<Record<string, readonly string[]>>,
  policy: EgressPolicy = resolveEgressPolicy(undefined),
): TrackerEgressGuard {
  const io = fakeIo(zone);
  return (url) => guardUrl({ url, context: 'TRACKER_CALL', policy, io });
}

describe('the Jira path resolves its host before it sends the token', () => {
  it('refuses a public-looking Jira host that resolves to the cloud metadata address', async () => {
    stubFetch({ status: 204 });
    const egress = guardWith({ 'jira.attacker.test': ['169.254.169.254'] });

    await expect(
      updateIssue(jira2('https://jira.attacker.test'), TOKEN, 'QA-12', patch, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    // Nothing was sent. "Refused" has to mean the request never happened, not
    // that it happened and failed — the token is already unsealed by here.
    expect(sent).toEqual([]);
  });

  it('refuses a public-looking Jira host that resolves inside an RFC1918 range', async () => {
    stubFetch({ status: 204 });
    const egress = guardWith({ 'jira.attacker.test': ['10.0.0.5'] });

    await expect(
      updateIssue(jira2('https://jira.attacker.test'), TOKEN, 'QA-12', patch, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });

  it('refuses a split DNS answer with the public record FIRST', async () => {
    /*
     * The order is the attack. A positional read of `addresses[0]` lets whoever
     * runs the zone choose the outcome by record order, and an adversary found
     * exactly that last round. Both orders must refuse.
     */
    stubFetch({ status: 204 });
    const egress = guardWith({ 'jira.attacker.test': ['93.184.216.34', '10.0.0.5'] });

    await expect(
      updateIssue(jira2('https://jira.attacker.test'), TOKEN, 'QA-12', patch, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });

  it('refuses a split DNS answer with the private record FIRST', async () => {
    stubFetch({ status: 204 });
    const egress = guardWith({ 'jira.attacker.test': ['10.0.0.5', '93.184.216.34'] });

    await expect(
      updateIssue(jira2('https://jira.attacker.test'), TOKEN, 'QA-12', patch, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });

  it('refuses a Jira host that does not resolve at all', async () => {
    // A name we cannot vouch for is not a name we send a credential to. There
    // is no reading of a failed lookup that makes the destination safer.
    stubFetch({ status: 204 });
    const egress = guardWith({});

    await expect(
      updateIssue(jira2('https://jira.attacker.test'), TOKEN, 'QA-12', patch, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });

  it('still PERMITS a Jira site that resolves publicly, and pins what it resolved', async () => {
    /*
     * The product keeps working: a real Jira Cloud site is allowed, and the
     * permit carries the address the guard classified so the socket can be held
     * to it. ASSERTED ON THE VERDICT AND NOT BY SENDING, deliberately — with the
     * pin enforced, driving the send here would open a TCP connection to
     * 93.184.216.34 from the unit suite. That the send then goes to the pinned
     * address and nowhere else is proven in `issues.pin.test.ts` against a
     * loopback server.
     */
    const verdict = await guardWith({ 'acme.atlassian.net': ['93.184.216.34'] })(
      'https://acme.atlassian.net/rest/api/2/issue/QA-12',
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.permit.kind).toBe('PINNED');
    if (verdict.permit.kind !== 'PINNED') return;
    expect(verdict.permit.pinned.host).toBe('acme.atlassian.net');
    expect(verdict.permit.pinned.addresses.map((pin) => pin.address)).toEqual(['93.184.216.34']);
  });

  it('guards the CREATE path too, not only the edit', async () => {
    /*
     * Both Jira requests go through one `sendToJira`, so a fourth caller cannot
     * forget the guard. If the create path were ever given its own `sendJson`
     * call, this is the test that notices.
     */
    stubFetch({ status: 201, body: { key: 'QA-13' } });
    const egress = guardWith({ 'jira.attacker.test': ['169.254.169.254'] });

    await expect(
      createIssue(jira2('https://jira.attacker.test'), TOKEN, { title: 't', body: 'b' }, egress),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });

  it('says the SAME sentence whatever the reason, so it is not a port scanner', async () => {
    /*
     * "that is a link-local address" / "that host did not resolve" / "that host
     * resolves inside a private range" are three different facts about the
     * inside of a network, handed to whoever can edit the integration row. One
     * constant means one answer.
     */
    stubFetch({ status: 204 });
    const reasons: Array<Record<string, readonly string[]>> = [
      { 'jira.attacker.test': ['169.254.169.254'] },
      { 'jira.attacker.test': ['10.0.0.5'] },
      { 'jira.attacker.test': ['127.0.0.1'] },
      { 'jira.attacker.test': [] },
      {},
    ];
    const messages = new Set<string>();
    for (const zone of reasons) {
      await updateIssue(
        jira2('https://jira.attacker.test'),
        TOKEN,
        'QA-12',
        patch,
        guardWith(zone),
      ).catch((err: unknown) => {
        messages.add(err instanceof Error ? err.message : String(err));
      });
    }
    expect(messages).toEqual(new Set([EGRESS_REFUSAL_SENTENCE]));
  });

  it('never puts any part of the token in the refusal', async () => {
    stubFetch({ status: 204 });
    const egress = guardWith({ 'jira.attacker.test': ['10.0.0.5'] });

    const err = await updateIssue(
      jira2('https://jira.attacker.test'),
      TOKEN,
      'QA-12',
      patch,
      egress,
    ).catch((caught: unknown) => caught);

    const text = err instanceof Error ? `${err.message}${err.stack ?? ''}` : String(err);
    expect(text).not.toContain(TOKEN);
    // Not truncated either: a prefix of a credential is still a credential.
    expect(text).not.toContain(TOKEN.slice(0, 8));
  });

  it('leaves GitHub and Linear unguarded, because their host is a compile-time constant', async () => {
    /*
     * The guard is applied where the attack surface is. `API_HOST` cannot be
     * influenced by config, so resolving it would buy nothing and would put a
     * real resolver into every test that files a GitHub issue. The fake throws
     * on any host it was not given, so a guard call on these paths would fail
     * this test loudly rather than silently.
     */
    stubFetch({ status: 200, body: { number: 7 } });
    const egress = guardWith({});

    await updateIssue(github, TOKEN, 'acme/storefront#7', patch, egress);
    expect(sent[0]!.url).toBe('https://api.github.com/repos/acme/storefront/issues/7');
  });
});

describe('defaultTrackerEgressGuard — the guard production actually gets', () => {
  /*
   * IP LITERALS ONLY in this block, deliberately: `classifyHost` answers
   * `kind: 'address'` for a literal and `decideEgress` consults no resolver at
   * all, so these exercise the REAL default guard — the real policy, the real
   * classifier, the real `node:dns` import — with NO DNS QUERY and no socket.
   */
  it('refuses the cloud metadata address with no policy configured', async () => {
    const guard = await defaultTrackerEgressGuard();
    const verdict = await guard('https://169.254.169.254/rest/api/2/issue');
    expect(verdict.ok).toBe(false);
  });

  it('refuses an RFC1918 address with no policy configured — HOSTED is the fallback', async () => {
    // An absent policy must be the STRICTEST reading and not an open one.
    const guard = await defaultTrackerEgressGuard();
    expect((await guard('https://10.0.0.5/x')).ok).toBe(false);
    expect((await guard('https://127.0.0.1/x')).ok).toBe(false);
  });

  it('refuses a private address even when the stored policy says SELF_HOSTED', async () => {
    /*
     * TRACKER_CALL has `allowlistApplies: false` and
     * `targetsApplicationUnderTest: false`. There is no deployment in which
     * calling an issue tracker legitimately reaches a private address, so
     * neither a permissive deployment mode nor an allowlist entry widens it —
     * "add your internal host to the allowlist" would be advice to build an
     * SSRF with paperwork.
     */
    const guard = await defaultTrackerEgressGuard({
      deployment: 'SELF_HOSTED',
      permittedClasses: ['public', 'private', 'loopback', 'reserved'],
      allowlist: [
        {
          host: '10.0.0.5',
          contexts: ['TRACKER_CALL'],
          ownerEmail: 'someone@acme.test',
          reason: 'our internal Jira',
          expiresAt: null,
        },
      ],
    });
    expect((await guard('https://10.0.0.5/x')).ok).toBe(false);
  });

  it('permits a public address, so a real Jira Cloud site is reachable', async () => {
    const guard = await defaultTrackerEgressGuard();
    expect((await guard('https://93.184.216.34/x')).ok).toBe(true);
  });

  it('refuses an octal-spelt loopback literal rather than handing it to a resolver', async () => {
    // `0177.0.0.1` is 127.0.0.1 to something downstream, and a resolver would
    // give the octal form a second chance.
    const guard = await defaultTrackerEgressGuard();
    expect((await guard('https://0177.0.0.1/x')).ok).toBe(false);
  });

  it('refuses a URL carrying userinfo before it looks at the host at all', async () => {
    // `https://acme.atlassian.net@10.0.0.1/` reads as a trusted host to a human
    // and to every log line, and the parser correctly calls the host 10.0.0.1.
    const guard = await defaultTrackerEgressGuard();
    expect((await guard('https://acme.atlassian.net@93.184.216.34/x')).ok).toBe(false);
  });
});
