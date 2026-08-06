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
import {
  ChatWebhookError,
  DEFAULT_NOTIFY_PREFS,
  chatPayload,
  checkChatDestination,
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
