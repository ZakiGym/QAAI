import { describe, expect, it } from 'vitest';
import { describeWebhookFailure } from './webhook-failure';

/**
 * The contract has two halves and both matter: the failure CLASS must come
 * through (an operator needs refused vs DNS vs TLS to debug), and the URL must
 * NOT — for an incoming-webhook integration the URL is the credential, and
 * undici embeds it in every error message it produces.
 */

/** An error the way undici actually throws it: wrapper + syscall cause. */
function fetchFailure(code: string, message = 'connect ECONNREFUSED 127.0.0.1:9099'): Error {
  const cause = new Error(message) as Error & { code: string };
  cause.code = code;
  return new Error('fetch failed https://hooks.example.com/T000/B000/secret', { cause });
}

describe('describeWebhookFailure', () => {
  it.each([
    ['ECONNREFUSED', /connection refused/],
    ['ENOTFOUND', /DNS lookup failed/],
    ['EAI_AGAIN', /DNS lookup failed/],
    ['ECONNRESET', /connection reset/],
    ['UND_ERR_CONNECT_TIMEOUT', /connect timeout/],
    ['ETIMEDOUT', /connect timeout/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /TLS handshake failed/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /TLS handshake failed/],
  ])('classifies %s', (code, expected) => {
    expect(describeWebhookFailure(fetchFailure(code), 15)).toMatch(expected);
  });

  it('names the timeout budget for an aborted request', () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    expect(describeWebhookFailure(err, 15)).toBe('no answer within 15s');
  });

  it('falls back to the old sentence for anything it does not recognise', () => {
    expect(describeWebhookFailure(new Error('who knows'), 15)).toBe('delivery failed');
    expect(describeWebhookFailure('not even an Error', 15)).toBe('delivery failed');
  });

  it('never echoes the URL, whatever the input carried', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'XX']) {
      const sentence = describeWebhookFailure(fetchFailure(code), 15);
      expect(sentence).not.toContain('hooks.example.com');
      expect(sentence).not.toContain('secret');
      expect(sentence).not.toContain('127.0.0.1');
    }
  });
});
