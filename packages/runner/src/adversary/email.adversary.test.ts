/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import {
  waitForMail,
  redactLink,
  describeLinkToken,
  notDeliveredWhy,
  EMAIL_NOT_DELIVERED,
  type MailboxReader,
  type MailClock,
} from '../plugins/email.js';

/* A token-shaped tail composed at run time: rule E forbids a complete
 * key-shaped literal anywhere, including a probe file. */
const FAKE_TAIL = ['a1b2c3', 'd4e5f6', 'a7b8c9', 'd0e1f2'].join('');

describe('ADVERSARY — EMAIL: a mail that never came is NOT_DELIVERED with the wait', () => {
  it('returns NOT_DELIVERED and the elapsed wait, never ARRIVED', async () => {
    let t = 0;
    const clock: MailClock = {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
    const emptySink: MailboxReader = { list: () => Promise.resolve([]) };
    const r = await waitForMail(
      emptySink,
      { to: 'buyer@example.test', since: '2026-10-27T00:00:00.000Z', templateId: null },
      5_000,
      1_000,
      new AbortController().signal,
      clock,
    );
    expect(r.outcome).toBe(EMAIL_NOT_DELIVERED);
    expect(r.mail).toBeNull();
    expect(r.waitedMs).toBe(5_000);
    expect(r.polls).toBeGreaterThan(1);
  });

  it('never sleeps past the budget, so the printed wait is true', async () => {
    let t = 0;
    const clock: MailClock = {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
    const r = await waitForMail(
      { list: () => Promise.resolve([]) },
      { to: 'x@example.test', since: '2026-10-27T00:00:00.000Z', templateId: null },
      200,
      1_000,
      new AbortController().signal,
      clock,
    );
    expect(r.waitedMs).toBe(200);
    expect(r.waitedMs).toBeLessThanOrEqual(200);
  });

  it('the non-delivery sentence names the elapsed wait and the budget', () => {
    const why = notDeliveredWhy({ kind: 'QAAI_DRIVEN', path: '/signup' } as never, 5_000, 5_000, 6);
    expect(why).toMatch(/5000|5,000|5s|5 s/);
    expect(why.length).toBeGreaterThan(40);
  });
});

describe('ADVERSARY — EMAIL: a token value must never be printed', () => {
  it('describes a token by shape and never returns its value', () => {
    const href = `https://app.example.com/reset/${FAKE_TAIL}`;
    const token = describeLinkToken(href, 'PATH_SEGMENT');
    expect(token).not.toBeNull();
    expect(token?.length).toBe(FAKE_TAIL.length);
    // The whole object must not carry the value anywhere.
    expect(JSON.stringify(token)).not.toContain(FAKE_TAIL);
  });

  it('redacts a long path token, every query value, and the whole fragment', () => {
    const long = redactLink(`https://app.example.com/reset/${FAKE_TAIL}`);
    expect(long).not.toContain(FAKE_TAIL);

    const query = redactLink(`https://app.example.com/verify?token=${FAKE_TAIL}&email=a@b.test`);
    expect(query).not.toContain(FAKE_TAIL);
    expect(query).not.toContain('a@b.test');

    const frag = redactLink(`https://app.example.com/cb#access_token=${FAKE_TAIL}`);
    expect(frag).not.toContain(FAKE_TAIL);

    const scheme = redactLink(`shopapp://reset/${FAKE_TAIL}`);
    expect(scheme).not.toContain(FAKE_TAIL);

    const creds = redactLink(`https://user:${FAKE_TAIL}@app.example.com/x`);
    expect(creds).not.toContain(FAKE_TAIL);
  });

  it('redacts a SHORT all-digit path segment — the OTP the length rule let through', () => {
    /*
     * The finding this probe was written for. `length > 12` let a six-digit
     * one-time code through verbatim, and EMAIL_OTP is a sibling test type in
     * this same runner, so the shape is the product's own.
     */
    for (const code of ['418203', '9021', '00000000']) {
      const out = redactLink(`https://app.example.com/verify/${code}`);
      expect(out, code).not.toContain(code);
    }
    // And the readability the length rule was chosen for is preserved.
    const readable = redactLink('https://app.example.com/v1/en/invoices/reset/unsubscribe');
    for (const word of ['v1', 'en', 'invoices', 'reset', 'unsubscribe']) {
      expect(readable, word).toContain(word);
    }
    // Three digits or fewer stay: no code worth mailing is three digits.
    expect(redactLink('https://app.example.com/page/404')).toContain('404');
  });

  it('does not describe a token in a non-http scheme, so an address is not a token', () => {
    expect(describeLinkToken('mailto:support@shop.example.com', 'PATH_SEGMENT')).toBeNull();
    expect(describeLinkToken(`shopapp://reset/${FAKE_TAIL}`, 'PATH_SEGMENT')).toBeNull();
  });
});
