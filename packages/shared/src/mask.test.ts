/**
 * Tests for the secret-masking chokepoint.
 *
 * WHY THIS FILE EXISTS: `mask.ts` describes itself as the single chokepoint
 * that "the pino serialiser, the artifact writer, and packages/agent/llm.ts all
 * run their payload through before it leaves the process", and it had NO TESTS.
 * A guard with no test is not a guard, and this one was already failing: a
 * Playwright `storageState` — the cookie jar that IS the logged-in session —
 * travelled verbatim through `maskDeep`, because the key match is exact and
 * `storagestate` was not on the list. `RunContext.sessions` then turned one
 * leak into one per principal.
 *
 * The cases below are written against KEY NAMES rather than against a vault,
 * deliberately: a storageState is minted by the browser and never becomes a
 * `Secret` row, so value-masking cannot reach it and the key list is the only
 * thing standing between it and a log line.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from './constants';
import { maskDeep, maskSecrets, maskUrl } from './mask';

/** A storageState in exactly the shape Playwright writes one. */
const SESSION_COOKIE = 'eyJhbGciOiJIUzI1NiJ9.a-real-looking-session-token.sig';
const STORAGE_STATE = JSON.stringify({
  cookies: [{ name: 'sid', value: SESSION_COOKIE, domain: 'app.example.com', path: '/' }],
  origins: [],
});

describe('maskDeep redacts every credential-bearing key this repo actually uses', () => {
  /*
   * One case per spelling, so a reader can see which name failed rather than
   * "the object leaked". Each of these was NOT REDACTED before this list grew.
   */
  it.each([
    'storageState',
    'storage_state',
    'sessions',
    'session_state',
    'bypassToken',
    'bypass_token',
    'totpSecret',
    'resetToken',
    'otpCode',
    'recoveryCode',
    'api_key',
  ])('redacts %s, which the exact-match key list used to miss', (key) => {
    const masked = maskDeep({ [key]: 'a-credential-value' }) as Record<string, string>;
    expect(masked[key]).toBe(SECRET_MASK);
  });

  it('redacts the keys that were already covered, so the list only grew', () => {
    const masked = maskDeep({
      authorization: 'Bearer abc123456',
      cookie: 'sid=abc123456',
      password: 'hunter22222',
      token: 'abc123456789',
      totp: '123456789',
      session: 'abc123456789',
    }) as Record<string, string>;
    for (const value of Object.values(masked)) expect(value).toBe(SECRET_MASK);
  });

  it('REDACTS A WHOLE RunContext.sessions MAP — the leak this round introduced', () => {
    /*
     * The precise payload the worker's pino formatter receives. Note that NO
     * vault values are supplied: that is the realistic case, and it is why the
     * key list rather than value-masking has to catch this.
     */
    const serialised = JSON.stringify(
      maskDeep({
        runId: 'run_1',
        storageState: STORAGE_STATE,
        sessions: {
          default: { principal: { name: 'default' }, storageState: STORAGE_STATE },
          admin: { principal: { name: 'admin' }, storageState: STORAGE_STATE },
        },
      }),
    );
    expect(serialised).not.toContain(SESSION_COOKIE);
    expect(serialised).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    // The run id is not a secret and must survive, or the log is useless.
    expect(serialised).toContain('run_1');
  });

  it('still masks known secret VALUES wherever they appear, under any key', () => {
    const masked = maskDeep(
      { note: 'the deploy used s3cret-value-here', nested: ['s3cret-value-here'] },
      ['s3cret-value-here'],
    ) as { note: string; nested: string[] };
    expect(masked.note).not.toContain('s3cret-value-here');
    expect(masked.nested[0]).not.toContain('s3cret-value-here');
  });

  it('does not redact ordinary fields, so a masked log is still readable', () => {
    const masked = maskDeep({
      runId: 'run_1',
      status: 'PASSED',
      durationMs: 1234,
      // Names that merely CONTAIN a listed word are left alone: the match is
      // exact, and over-redaction would hide the report's own numbers.
      tokenCount: 4096,
      sessionCount: 3,
    }) as Record<string, unknown>;
    expect(masked.runId).toBe('run_1');
    expect(masked.status).toBe('PASSED');
    expect(masked.durationMs).toBe(1234);
    expect(masked.tokenCount).toBe(4096);
    expect(masked.sessionCount).toBe(3);
  });

  it('redacts a credential key however it is cased, since keys arrive from JSON', () => {
    const masked = maskDeep({
      StorageState: 'x-credential',
      BYPASSTOKEN: 'y-credential',
    }) as Record<string, string>;
    expect(masked.StorageState).toBe(SECRET_MASK);
    expect(masked.BYPASSTOKEN).toBe(SECRET_MASK);
  });

  it('survives a cycle without stack-overflowing the serialiser', () => {
    const node: Record<string, unknown> = { storageState: STORAGE_STATE };
    node.self = node;
    const masked = maskDeep(node) as Record<string, unknown>;
    expect(masked.storageState).toBe(SECRET_MASK);
    expect(masked.self).toBe(masked);
  });

  it('keeps an Error readable while masking its message and stack', () => {
    const masked = maskDeep(new Error('login failed for s3cret-value-here'), [
      's3cret-value-here',
    ]) as { name: string; message: string };
    expect(masked.name).toBe('Error');
    expect(masked.message).not.toContain('s3cret-value-here');
  });
});

describe('maskSecrets and maskUrl', () => {
  it('masks the longest secret first, so a secret containing another is masked whole', () => {
    expect(maskSecrets('value=abcdef-longer', ['abcdef', 'abcdef-longer'])).not.toContain('abcdef');
  });

  it('strips credentials and sensitive query parameters from a URL', () => {
    const masked = maskUrl('https://user:pw@example.com/p?token=abc123456&page=2');
    expect(masked).not.toContain('abc123456');
    expect(masked).not.toContain('pw@');
    expect(masked).toContain('page=2');
  });

  it('returns a non-URL unchanged rather than throwing inside a log formatter', () => {
    expect(maskUrl('not a url')).toBe('not a url');
  });
});
