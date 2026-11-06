/**
 * Tests for the pure half of chat/webhook integrations (§7).
 *
 * Everything asserted here is a rule the API's write path, the worker's send
 * path and the digest all inherit from this one module, which is why the tests
 * live against the module rather than against any one caller: a hole in
 * `validateChatWebhookUrl` is a hole in three places at once.
 *
 * The recurring assertion style — "the error names the host, never the URL" —
 * is the module's own contract: a webhook URL IS the credential, and the
 * validation error is the most likely place for one to leak into a response,
 * a log line, or a delivery row.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPermit } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  ChatWebhookError,
  DEFAULT_NOTIFY_PREFS,
  chatPayload,
  checkChatDestination,
  configureChatTransport,
  defaultChatEgressGuard,
  guardChatDestination,
  type ChatEgressGuard,
  decodeChatCredentials,
  encodeChatCredentials,
  integrationAad,
  isChatIntegrationKind,
  notifyPrefsOf,
  parseChatConfig,
  sendChatPayload,
  validateChatWebhookUrl,
  wantsRunFinished,
} from './chat-integrations.js';

/** A realistic Slack hook: the path is the secret the assertions watch for. */
const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/tok3nTOK3Ntok3n';

describe('validateChatWebhookUrl', () => {
  it('accepts a real Slack hook and returns the host', () => {
    expect(validateChatWebhookUrl('SLACK', SLACK_URL)).toEqual({
      url: SLACK_URL,
      host: 'hooks.slack.com',
    });
  });

  it('refuses a non-Slack host for SLACK, naming the host and never the path', () => {
    let thrown: unknown;
    try {
      validateChatWebhookUrl('SLACK', 'https://evil.example.com/services/T0001/B0001/tok3n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChatWebhookError);
    const message = (thrown as Error).message;
    expect(message).toContain('evil.example.com');
    // The path is the credential; it must never survive into the message.
    expect(message).not.toContain('tok3n');
    expect(message).not.toContain('/services');
  });

  it('normalises a trailing-dot host instead of letting it defeat the pin', () => {
    // `hooks.slack.com.` resolves identically in DNS; accepted, but the dot
    // must not survive into the stored URL (the digest.ts lesson).
    const { url, host } = validateChatWebhookUrl(
      'SLACK',
      'https://HOOKS.SLACK.COM./services/T1/B1/x'.replace('x', 'abcdefgh'),
    );
    expect(host).toBe('hooks.slack.com');
    expect(url).toBe('https://hooks.slack.com/services/T1/B1/abcdefgh');
  });

  it('refuses http, embedded credentials, and a non-default port on a pinned kind', () => {
    expect(() => validateChatWebhookUrl('SLACK', 'http://hooks.slack.com/services/T/B/x')).toThrow(
      /https/,
    );
    expect(() =>
      validateChatWebhookUrl('SLACK', 'https://user:pass@hooks.slack.com/services/T/B/x'),
    ).toThrow(/credentials/);
    expect(() =>
      validateChatWebhookUrl('SLACK', 'https://hooks.slack.com:8443/services/T/B/x'),
    ).toThrow(/default https port/);
  });

  it('accepts both Teams webhook shapes and keeps the query string', () => {
    // Power Automate puts the signature in the query; dropping it would store
    // a URL that passes every check and 401s on every send.
    const flow =
      'https://prod-27.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=s1gs1g';
    expect(validateChatWebhookUrl('MSTEAMS', flow).url).toBe(flow);
    expect(
      validateChatWebhookUrl('MSTEAMS', 'https://acme.webhook.office.com/webhookb2/x-y-z').host,
    ).toBe('acme.webhook.office.com');
    expect(() =>
      validateChatWebhookUrl('MSTEAMS', 'https://outlook.evil.com/webhook/x'),
    ).toThrow(ChatWebhookError);
  });

  it('accepts both Discord hosts', () => {
    expect(
      validateChatWebhookUrl('DISCORD', 'https://discord.com/api/webhooks/1/abc').host,
    ).toBe('discord.com');
    expect(
      validateChatWebhookUrl('DISCORD', 'https://discordapp.com/api/webhooks/1/abc').host,
    ).toBe('discordapp.com');
  });

  describe('generic WEBHOOK', () => {
    it('accepts a public https receiver, custom port included', () => {
      expect(validateChatWebhookUrl('WEBHOOK', 'https://hooks.example.com:8443/qaai')).toEqual({
        url: 'https://hooks.example.com:8443/qaai',
        host: 'hooks.example.com',
      });
    });

    it.each([
      ['localhost', 'https://localhost/hook'],
      ['a .svc name (the in-cluster API server)', 'https://kubernetes.default.svc/hook'],
      ['an IPv4 literal', 'https://10.0.0.1/hook'],
      ['a single-label name', 'https://redis/hook'],
      ['a single-label name with a trailing dot', 'https://redis./hook'],
      ['a .internal name', 'https://metadata.google.internal/hook'],
    ])('refuses %s', (_label, url) => {
      expect(() => validateChatWebhookUrl('WEBHOOK', url)).toThrow(ChatWebhookError);
    });

    it('still requires https', () => {
      expect(() => validateChatWebhookUrl('WEBHOOK', 'http://hooks.example.com/qaai')).toThrow(
        /https/,
      );
    });
  });
});

describe('checkChatDestination', () => {
  it('mirrors validation as a skip-and-record shape', () => {
    expect(checkChatDestination('SLACK', SLACK_URL)).toEqual({ ok: true, url: SLACK_URL });

    const refused = checkChatDestination('SLACK', 'https://evil.example.com/services/T/B/tok3n');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('evil.example.com');
      expect(refused.reason).not.toContain('tok3n');
    }
  });

  it('refuses a kind that is not a chat destination at all', () => {
    const refused = checkChatDestination('GITHUB', SLACK_URL);
    expect(refused).toEqual({ ok: false, reason: 'GITHUB is not a chat destination.' });
  });
});

describe('credential envelope', () => {
  it('round-trips URL and secret, and omits an absent secret entirely', () => {
    expect(decodeChatCredentials(encodeChatCredentials({ url: SLACK_URL }))).toEqual({
      url: SLACK_URL,
    });
    expect(
      decodeChatCredentials(encodeChatCredentials({ url: SLACK_URL, secret: 'shh-secret' })),
    ).toEqual({ url: SLACK_URL, secret: 'shh-secret' });
  });

  it('fails closed on garbage and on an envelope without a URL', () => {
    expect(() => decodeChatCredentials('not json')).toThrow(/JSON envelope/);
    expect(() => decodeChatCredentials('{"secret":"x"}')).toThrow(/no URL/);
  });

  it('namespaces the AAD so a chat envelope can never open as an environment secret', () => {
    expect(integrationAad('abc123')).toBe('integration:abc123');
  });
});

describe('notification preference', () => {
  it('reads an absent or partial preference as today’s behaviour', () => {
    expect(notifyPrefsOf(null)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(notifyPrefsOf({})).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(notifyPrefsOf({ notify: { digest: false } })).toEqual({
      runFinished: 'failures',
      digest: false,
    });
  });

  it('shrugs off a value typed straight into the database', () => {
    expect(notifyPrefsOf({ notify: { runFinished: 'LOUDLY', digest: 'yes' } })).toEqual(
      DEFAULT_NOTIFY_PREFS,
    );
  });

  it('wantsRunFinished: off hears nothing, failures hears red, all hears both', () => {
    expect(wantsRunFinished({ runFinished: 'off', digest: true }, true)).toBe(false);
    expect(wantsRunFinished({ runFinished: 'off', digest: true }, false)).toBe(false);
    expect(wantsRunFinished({ runFinished: 'failures', digest: true }, true)).toBe(true);
    expect(wantsRunFinished({ runFinished: 'failures', digest: true }, false)).toBe(false);
    expect(wantsRunFinished({ runFinished: 'all', digest: true }, true)).toBe(true);
    expect(wantsRunFinished({ runFinished: 'all', digest: true }, false)).toBe(true);
  });
});

describe('parseChatConfig', () => {
  it('reads the stored non-secret half with safe fallbacks', () => {
    expect(
      parseChatConfig({
        host: 'hooks.slack.com',
        keyVersion: 2,
        hasSecret: true,
        notify: { runFinished: 'all', digest: false },
      }),
    ).toEqual({
      host: 'hooks.slack.com',
      keyVersion: 2,
      hasSecret: true,
      notify: { runFinished: 'all', digest: false },
    });
    expect(parseChatConfig(null)).toEqual({
      host: '',
      keyVersion: 1,
      hasSecret: false,
      notify: DEFAULT_NOTIFY_PREFS,
    });
  });
});

describe('chatPayload', () => {
  it('puts the text where each provider looks for it', () => {
    expect(JSON.parse(chatPayload('SLACK', 'test', 'hi'))).toEqual({ text: 'hi' });
    expect(JSON.parse(chatPayload('MSTEAMS', 'test', 'hi'))).toEqual({ text: 'hi' });
    expect(JSON.parse(chatPayload('DISCORD', 'test', 'hi'))).toEqual({ content: 'hi' });
    expect(JSON.parse(chatPayload('WEBHOOK', 'run.finished', 'hi'))).toEqual({
      event: 'run.finished',
      text: 'hi',
    });
  });
});

describe('isChatIntegrationKind', () => {
  it('covers exactly the four deliverable kinds — PAGERDUTY stays out until it can fire', () => {
    for (const kind of ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK']) {
      expect(isChatIntegrationKind(kind)).toBe(true);
    }
    expect(isChatIntegrationKind('PAGERDUTY')).toBe(false);
    expect(isChatIntegrationKind('GITHUB')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The egress guard on a generic WEBHOOK destination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT `validateChatWebhookUrl` DECIDES FOR THE GENERIC KIND, AND WHAT IT DOES
 * NOT.
 *
 * It refuses the internal names it can RECOGNISE and decides nothing about
 * where an ordinary name points. MEASURED on this tree before the change:
 * `validateChatWebhookUrl('WEBHOOK', 'https://hook.attacker.test/p/abc')`
 * returned `{url, host: 'hook.attacker.test'}`, and the sealed envelope's URL —
 * which IS the credential, since Slack, Teams and Discord all put the secret in
 * the path — was posted to whatever that name resolved to.
 *
 * ALSO MEASURED, and the reason the named providers are left alone: SLACK,
 * DISCORD and MSTEAMS all refuse `hook.attacker.test`,
 * `hooks.slack.com.attacker.test` and `evil.example.net` already, through
 * `webhookHostAllowed`, which is a real host allowlist and not a pattern.
 *
 * The tests below drive the REAL `guardUrl` with a FAKE resolver. NOTHING HERE
 * OPENS A SOCKET OR CONSULTS A REAL RESOLVER.
 */
describe('guardChatDestination resolves a generic webhook host before delivering', () => {
  /** Answers from a table and THROWS on anything else. */
  function guardWith(zone: Readonly<Record<string, readonly string[]>>): ChatEgressGuard {
    const io: EgressGuardIo = {
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
      delay: async () => {},
    };
    return (url) =>
      guardUrl({ url, context: 'WEBHOOK_DELIVERY', policy: resolveEgressPolicy(undefined), io });
  }

  it.each([
    ['the cloud metadata address', ['169.254.169.254']],
    ['an RFC1918 address', ['10.0.0.5']],
    ['loopback', ['127.0.0.1']],
    ['a split answer, public record FIRST', ['93.184.216.34', '10.0.0.5']],
    ['a split answer, private record FIRST', ['10.0.0.5', '93.184.216.34']],
    ['no addresses at all', []],
  ])('refuses a generic webhook host that resolves to %s', async (_label, addresses) => {
    /*
     * The ORDER of a split answer is the attack: a positional read of the first
     * address lets whoever runs the zone choose the outcome by reordering their
     * own records. Both orders must refuse.
     */
    const answer = await guardChatDestination(
      'WEBHOOK',
      'https://hook.attacker.test/p/abc',
      guardWith({ 'hook.attacker.test': addresses }),
    );
    expect(answer.ok).toBe(false);
  });

  it('refuses a generic webhook host that does not resolve', async () => {
    const answer = await guardChatDestination(
      'WEBHOOK',
      'https://hook.attacker.test/p/abc',
      guardWith({}),
    );
    expect(answer.ok).toBe(false);
  });

  it('still delivers to a generic webhook that resolves publicly, AND HANDS BACK THE PERMIT', async () => {
    /*
     * THE PERMIT IS THE DELIVERABLE OF THIS FUNCTION, not a side effect.
     *
     * MEASURED before this round: this call returned an object whose keys were
     * exactly `['ok', 'url']` while the verdict behind it carried
     * `permit.kind: 'PINNED'` with the classified address right there. Both
     * senders read `ok`, dropped the permit and called global `fetch(url)` by
     * name — which resolves independently. The pin is the half that turns a
     * check into a control, so a destination that arrives without one cannot be
     * sent to safely.
     */
    const answer = await guardChatDestination(
      'WEBHOOK',
      'https://hook.acme.test/p/abcdefgh',
      guardWith({ 'hook.acme.test': ['93.184.216.34'] }),
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.url).toBe('https://hook.acme.test/p/abcdefgh');
    expect(answer.permit).not.toBeNull();
    expect(answer.permit?.kind).toBe('PINNED');
    expect(answer.permit?.pinned?.addresses.map((a) => a.address)).toEqual(['93.184.216.34']);
    // The pinned host is the NORMALISED one the guard decided about, which is
    // what `pinnedRequest` compares the URL against.
    expect(answer.permit?.pinned?.host).toBe('hook.acme.test');
  });

  it('keeps every synchronous refusal checkChatDestination already made', async () => {
    // The guard is ADDED, not substituted. The fake throws on every host, so
    // these all refuse before any lookup is attempted.
    const guard = guardWith({});
    for (const [kind, url] of [
      ['WEBHOOK', 'http://hook.acme.test/p'],
      ['WEBHOOK', 'https://qa:hunter2@hook.acme.test/p'],
      ['WEBHOOK', 'https://localhost/p'],
      ['WEBHOOK', 'https://kubernetes.default.svc/p'],
      ['WEBHOOK', 'not a url at all'],
      ['NOT_A_KIND', 'https://hook.acme.test/p'],
    ] as const) {
      const answer = await guardChatDestination(kind, url, guard);
      expect(answer.ok).toBe(false);
    }
  });

  it('consults NO resolver for the named providers, whose hosts are allowlisted', async () => {
    /*
     * The pairing this asserts: `webhookHostAllowed` names hosts and never
     * takes one from config, which is what makes it safe for these three to
     * skip the lookup. The fake throws on every host, so a guard call here
     * would fail this test loudly rather than silently. If `webhookHostAllowed`
     * ever accepts a config-chosen host, this test is what notices.
     */
    const guard = guardWith({});
    const slack = await guardChatDestination(
      'SLACK',
      'https://hooks.slack.com/services/T000/B000/xxxxxxxx',
      guard,
    );
    expect(slack.ok).toBe(true);
    const discord = await guardChatDestination(
      'DISCORD',
      'https://discord.com/api/webhooks/1/xxxxxxxx',
      guard,
    );
    expect(discord.ok).toBe(true);
    /*
     * AND THEY CARRY NO PERMIT, which `sendChatPayload` must not paper over.
     * `permit: null` means "no guard decided about this host", because these
     * hosts are allowlisted constants — it never means "pin waived".
     */
    if (slack.ok) expect(slack.permit).toBeNull();
    if (discord.ok) expect(discord.permit).toBeNull();
  });

  it('says the SAME sentence whatever the reason, so the cockpit is not a port scanner', async () => {
    const zones: Array<Record<string, readonly string[]>> = [
      { 'hook.attacker.test': ['169.254.169.254'] },
      { 'hook.attacker.test': ['10.0.0.5'] },
      { 'hook.attacker.test': ['127.0.0.1'] },
      { 'hook.attacker.test': [] },
      {},
    ];
    const reasons = new Set<string>();
    for (const zone of zones) {
      const answer = await guardChatDestination(
        'WEBHOOK',
        'https://hook.attacker.test/p/abc',
        guardWith(zone),
      );
      if (!answer.ok) reasons.add(answer.reason);
    }
    expect(reasons).toEqual(new Set([EGRESS_REFUSAL_SENTENCE]));
    expect([...reasons][0]).not.toMatch(/10\.0\.0\.5|169\.254|loopback|private|link-local/);
  });

  it('never puts the webhook URL — which IS the credential — in the refusal', async () => {
    const answer = await guardChatDestination(
      'WEBHOOK',
      'https://hook.attacker.test/p/THE-SECRET-PATH-TOKEN',
      guardWith({ 'hook.attacker.test': ['10.0.0.5'] }),
    );
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.reason).not.toContain('THE-SECRET-PATH-TOKEN');
      expect(answer.reason).not.toContain('hook.attacker.test');
    }
  });
});

describe('defaultChatEgressGuard — the guard production actually gets', () => {
  /*
   * IP LITERALS ONLY: `classifyHost` answers `kind: 'address'` for a literal
   * and `decideEgress` consults no resolver at all for one, so these exercise
   * the REAL default guard with NO DNS QUERY and no socket.
   */
  it('refuses private, loopback and link-local with no policy configured', async () => {
    const guard = await defaultChatEgressGuard();
    expect((await guard('https://169.254.169.254/p')).ok).toBe(false);
    expect((await guard('https://10.0.0.5/p')).ok).toBe(false);
    expect((await guard('https://127.0.0.1/p')).ok).toBe(false);
  });

  it('refuses a private address even on a SELF_HOSTED policy with an allowlist entry', async () => {
    // An operator who allowlists an internal host for webhook delivery has
    // built an SSRF with paperwork, so WEBHOOK_DELIVERY ignores the allowlist.
    const guard = await defaultChatEgressGuard({
      deployment: 'SELF_HOSTED',
      permittedClasses: ['public', 'private', 'loopback', 'reserved'],
      allowlist: [
        {
          host: '10.0.0.5',
          contexts: ['WEBHOOK_DELIVERY'],
          ownerEmail: 'someone@acme.test',
          reason: 'our internal chat bridge',
          expiresAt: null,
        },
      ],
    });
    expect((await guard('https://10.0.0.5/p')).ok).toBe(false);
  });

  it('permits a public address', async () => {
    const guard = await defaultChatEgressGuard();
    expect((await guard('https://93.184.216.34/p')).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PIN, ENFORCED AT THE SOCKET — AGAINST REAL SOCKETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THESE TESTS OPEN REAL LOOPBACK SOCKETS, AND WHY THEY HAVE TO.
 *
 * Nothing leaves the machine, and no name is resolved by the system resolver
 * except `localhost`. That is not a loophole in "no network in tests": a pin
 * tested only against a fake transport is a pin nobody has evidence for, and
 * that is exactly how this defect survived four rounds. `guardChatDestination`
 * returned a permit with a classified address set, both senders read `ok`,
 * dropped the permit and called global `fetch(url)` by name — and every test
 * passed, because the fake they asserted against never resolved anything.
 *
 * ── THE DISCRIMINATOR, AND THE VACUOUS VERSION OF IT ────────────────────────
 *
 * The loopback server plays QAAI's OWN INTERNAL HOST. The destination names
 * `localhost`, which DOES resolve — to 127.0.0.1, everywhere — and the permit
 * pins 192.0.2.1 (RFC 5737 TEST-NET-1, which routes nowhere). So a transport
 * that re-resolves the name reaches the internal server, and one that honours
 * the pin cannot. A `.invalid` name here would have been VACUOUS: a name that
 * never resolves fails whether the pin is honoured or not, which
 * `pinned-request.test.ts` records having learned the hard way.
 *
 * MEASURED both ways on this tree. With the transport reverted to
 * `fetch(destination.url)` — the exact code this round replaced — the internal
 * server recorded `POST /services/T0001/B0001/<token>`, Host `localhost:<port>`,
 * with the signature header present. With the pin enforced it recorded nothing.
 *
 * ── WHY THEY ENTER AT `sendChatPayload` AND NOT AT A ROUTE ──────────────────
 *
 * `validateChatWebhookUrl` forces a WEBHOOK destination to be https on a name
 * with a dot, and it refuses `localhost` by name — correctly, and those rules
 * are asserted above. So the only reachable spelling of a real-socket
 * discriminator is http on `localhost`, which means entering at the function
 * both senders call with the destination `chatDestinationFor` hands them. The
 * route and the processor are driven in their own files; what is proven here is
 * the socket.
 */
describe('sendChatPayload connects to the pinned address, not to the name', () => {
  const servers: Server[] = [];

  afterEach(() => {
    // The REAL transport, restored, so no test here or later can pass because
    // a fake was left installed.
    configureChatTransport(null);
    for (const server of servers.splice(0)) server.close();
  });

  /** A loopback server standing in for an internal host; it records every hit. */
  async function internalHost(status = 200): Promise<{
    port: number;
    hits: Array<{ method: string; path: string; host: string | undefined; signed: boolean }>;
  }> {
    const hits: Array<{ method: string; path: string; host: string | undefined; signed: boolean }> =
      [];
    const server = createServer((req, res) => {
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        host: req.headers.host,
        signed: req.headers['x-qaai-signature-256'] !== undefined,
      });
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return { port: address.port, hits };
  }

  /**
   * A PINNED permit for `host`, pinning exactly `addresses`.
   *
   * Built by hand rather than through `guardUrl`, because what is under test is
   * the TRANSPORT's obedience to a permit and not the policy that issues one —
   * and because `classifyAddress('192.0.2.1')` is `reserved` on this tree, so
   * no real policy would ever issue this permit. The real attack is the mirror
   * image of it: the guard sees a genuinely public address and the attacker's
   * SECOND answer is 127.0.0.1. Inverting it is what makes a loopback server
   * usable as the internal host, and `pinned-request.test.ts` inverts it the
   * same way for the same reason.
   */
  function pinned(host: string, addresses: string[], port: number): EgressPermit {
    return {
      kind: 'PINNED',
      context: 'WEBHOOK_DELIVERY',
      target: { host, scheme: 'http:', port: String(port) },
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

  function observed(host: string, port: number): EgressPermit {
    return {
      kind: 'OBSERVED',
      context: 'WEBHOOK_DELIVERY',
      target: { host, scheme: 'http:', port: String(port) },
      decision: { outcome: 'WOULD_REFUSE' },
      pinned: null,
      wouldRefuse: 'CLASS_NOT_PERMITTED',
      observedBy: 'POLICY',
    } as unknown as EgressPermit;
  }

  /** The webhook token, in the path, which is where a chat webhook keeps it. */
  const TOKEN = 'T0001-B0001-cafebabed00d';
  const SIGNED = {
    'content-type': 'application/json',
    'user-agent': 'qaai',
    'x-qaai-signature-256': 'sha256=00',
  } as const;
  const SEND = { headers: SIGNED, body: JSON.stringify({ event: 'test', text: 'hi' }) };

  it('REFUSES when the name is rebound between the guard and the socket, and the internal host records nothing', async () => {
    const internal = await internalHost();
    const url = `http://localhost:${internal.port}/services/${TOKEN}`;

    const outcome = await sendChatPayload(
      { url, permit: pinned('localhost', ['192.0.2.1'], internal.port) },
      { ...SEND, timeoutMs: 1_200 },
    );

    // THE ASSERTION THE WHOLE ROUND IS FOR.
    expect(internal.hits).toEqual([]);
    expect(outcome.status).toBeNull();
    expect(outcome.error).not.toBeNull();
    // The pin was the transport that carried it; it did not quietly fall back.
    expect(outcome.transport).toBe('PINNED');
    /*
     * Either the connection to the pinned address failed or it timed out — a
     * host that routes nowhere does one or the other depending on the kernel,
     * and both are refusals. What must never happen is a send.
     */
    expect(['TRANSPORT_FAILED', 'TIMED_OUT']).toContain(outcome.refusal);
    expect(['delivery failed', 'no answer within 1.2s']).toContain(outcome.error);
    // The URL IS the credential: the path token may not survive into anything a
    // delivery row, an audit row or a log line is built from.
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain('/services');
    expect(JSON.stringify(outcome)).not.toContain('192.0.2.1');
    expect(JSON.stringify(outcome)).not.toContain('localhost');
  });

  it('DELIVERS to the pinned address with the NAME still in the request', async () => {
    /*
     * Without this arm the test above would also pass if sendChatPayload had
     * simply stopped working. Here the pin and the resolver agree, so the send
     * must land — and the Host header must be the NAME, because that is what
     * keeps SNI and the certificate check working on the https path.
     */
    const receiver = await internalHost();
    const url = `http://localhost:${receiver.port}/services/${TOKEN}`;

    const outcome = await sendChatPayload(
      { url, permit: pinned('localhost', ['127.0.0.1'], receiver.port) },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(outcome).toMatchObject({ status: 200, error: null, transport: 'PINNED', refusal: null });
    expect(receiver.hits).toHaveLength(1);
    expect(receiver.hits[0]).toEqual({
      method: 'POST',
      path: `/services/${TOKEN}`,
      host: `localhost:${receiver.port}`,
      signed: true,
    });
  });

  it('reports a 3xx and does NOT follow it, so the token cannot be re-sent elsewhere', async () => {
    const receiver = await internalHost(302);
    const outcome = await sendChatPayload(
      {
        url: `http://localhost:${receiver.port}/services/${TOKEN}`,
        permit: pinned('localhost', ['127.0.0.1'], receiver.port),
      },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(outcome).toMatchObject({ status: 302, error: 'redirected; not followed' });
    // One request. A followed redirect would be two.
    expect(receiver.hits).toHaveLength(1);
  });

  it('reports a provider refusal as HTTP <status>, the way both senders already did', async () => {
    const receiver = await internalHost(404);
    const outcome = await sendChatPayload(
      {
        url: `http://localhost:${receiver.port}/services/${TOKEN}`,
        permit: pinned('localhost', ['127.0.0.1'], receiver.port),
      },
      { ...SEND, timeoutMs: 2_000 },
    );
    expect(outcome).toMatchObject({ status: 404, error: 'HTTP 404', transport: 'PINNED' });
  });

  it('connects BY NAME for an OBSERVED permit, and SAYS it did', async () => {
    /*
     * OBSERVE promises that the connection happens exactly as it did before the
     * control existed, so this must reach the server — and it must not be a
     * silent default. `pinnedRequest` would refuse an OBSERVED permit with
     * NOT_PINNED; retrying by name in an exception handler is the
     * "send it anyway" shape that rule exists to outlaw, so the by-name branch
     * is taken on purpose and named in the outcome for the caller to count.
     */
    const receiver = await internalHost();
    const outcome = await sendChatPayload(
      {
        url: `http://localhost:${receiver.port}/services/${TOKEN}`,
        permit: observed('localhost', receiver.port),
      },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(outcome).toMatchObject({ status: 200, error: null, transport: 'BY_NAME_OBSERVE_MODE' });
    expect(receiver.hits).toHaveLength(1);
    // The refusal code belongs to the pinned transport; nothing refused here.
    expect(outcome.refusal).toBeNull();
  });

  it('connects BY NAME when there is no permit at all, and distinguishes that from observe mode', async () => {
    // The three allowlisted provider kinds never reach the guard, so they hold
    // no permit. That is a different fact from "a permit authorised nothing",
    // and collapsing the two would hide the rollout brake being used.
    const receiver = await internalHost();
    const outcome = await sendChatPayload(
      { url: `http://localhost:${receiver.port}/services/${TOKEN}`, permit: null },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(outcome).toMatchObject({ status: 200, transport: 'BY_NAME_ALLOWLISTED_HOST' });
    expect(receiver.hits).toHaveLength(1);
  });

  it('refuses a destination whose URL is not the one the permit decided about', async () => {
    // Defence in depth behind the two senders: a caller that pinned `a` and
    // passed a URL for `b` would otherwise send b's path to a's addresses under
    // b's Host header, which is worse than no pin at all.
    const internal = await internalHost();
    const outcome = await sendChatPayload(
      {
        url: `http://localhost:${internal.port}/services/${TOKEN}`,
        permit: pinned('elsewhere.example', ['127.0.0.1'], internal.port),
      },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(internal.hits).toEqual([]);
    expect(outcome.refusal).toBe('HOST_NOT_THE_PINNED_ONE');
    // ONE SENTENCE, the same one every guard refusal produces: a message that
    // distinguished this from "that address refused the connection" would be a
    // port scanner with a readable report.
    expect(outcome.error).toBe(EGRESS_REFUSAL_SENTENCE);
  });

  it('turns a transport that THROWS into a refusal, and never retries by name', async () => {
    /*
     * `http.request` validates its options synchronously, so a transport can
     * reject rather than answer. The send must not happen, and above all it
     * must not be retried by name in the handler — an exception handler that
     * falls through to "send it anyway" would re-open this defect from the
     * other side. The loopback server here is the one a by-name retry would
     * reach, and it must record nothing.
     */
    const internal = await internalHost();
    configureChatTransport(() => {
      throw new Error('synchronous option validation failed');
    });

    const outcome = await sendChatPayload(
      {
        url: `http://localhost:${internal.port}/services/${TOKEN}`,
        permit: pinned('localhost', ['127.0.0.1'], internal.port),
      },
      { ...SEND, timeoutMs: 2_000 },
    );

    expect(internal.hits).toEqual([]);
    expect(outcome).toMatchObject({
      status: null,
      error: 'delivery failed',
      transport: 'PINNED',
      refusal: 'TRANSPORT_FAILED',
    });
  });

  it('uses the configured transport when one is installed, and the REAL one when it is not', async () => {
    /*
     * The seam exists for the route and processor tests either side of this
     * file, and a seam nobody checks is a seam that can be left installed. The
     * tests above run with NO transport configured, which is what makes them
     * evidence about `pinnedRequest`; this one proves the stub is reachable and
     * that `configureChatTransport(null)` really goes back.
     */
    const receiver = await internalHost();
    const permit = pinned('localhost', ['127.0.0.1'], receiver.port);
    const url = `http://localhost:${receiver.port}/services/${TOKEN}`;

    const seen: string[] = [];
    configureChatTransport(async (_permit, asked) => {
      seen.push(asked);
      return { ok: true, response: { status: 201, headers: {}, text: '', truncated: false } };
    });
    expect(await sendChatPayload({ url, permit }, { ...SEND, timeoutMs: 2_000 })).toMatchObject({
      status: 201,
    });
    expect(seen).toEqual([url]);
    // The fake answered, so no socket was opened.
    expect(receiver.hits).toEqual([]);

    configureChatTransport(null);
    expect(await sendChatPayload({ url, permit }, { ...SEND, timeoutMs: 2_000 })).toMatchObject({
      status: 200,
    });
    expect(receiver.hits).toHaveLength(1);
  });
});
