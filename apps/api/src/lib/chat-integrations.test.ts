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

import { describe, expect, it } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE, guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  ChatWebhookError,
  DEFAULT_NOTIFY_PREFS,
  chatPayload,
  checkChatDestination,
  defaultChatEgressGuard,
  guardChatDestination,
  type ChatEgressGuard,
  decodeChatCredentials,
  encodeChatCredentials,
  integrationAad,
  isChatIntegrationKind,
  notifyPrefsOf,
  parseChatConfig,
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

  it('still delivers to a generic webhook that resolves publicly', async () => {
    const answer = await guardChatDestination(
      'WEBHOOK',
      'https://hook.acme.test/p/abcdefgh',
      guardWith({ 'hook.acme.test': ['93.184.216.34'] }),
    );
    expect(answer).toEqual({ ok: true, url: 'https://hook.acme.test/p/abcdefgh' });
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
