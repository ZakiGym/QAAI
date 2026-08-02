/**
 * The broker publisher sends a vault-held token to a URL an org admin typed in.
 *
 * That is the precise shape of two security bugs this repo has already shipped:
 * a PAT that reached an attacker host read out of config, and a trailing-dot
 * FQDN that defeated every hostname guard at once. This suite exists so it is
 * not three.
 *
 * The lookalike case is the one that needed a new idea. Every other guard
 * refuses a host we can NAME as bad; none of them can refuse
 * `github.com.evil.com`, because a Pact broker is legitimately self-hosted and
 * that string is indistinguishable from `broker.mycompany.com`. So the token is
 * bound to a host by its own secret name, and repointing the URL fails closed.
 *
 * The CONTROL matters as much as the attacks: a publisher that refuses
 * everything passes an attack suite and does not work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brokerHostFromSecretName, publishVerification } from './contract-broker.js';

const TOKEN = 'pactflow-secret-token-DO-NOT-LEAK-42';
const BOUND = 'PACT_BROKER_TOKEN__broker_acme_com';

let sent: Array<{ url: string; auth: string | null }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  globalThis.fetch = vi.fn(async (input: unknown, init: { headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers ?? {});
    sent.push({
      url: typeof input === 'string' ? input : String((input as { url?: string }).url),
      auth: headers.get('authorization'),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = () =>
  ({
    secrets: { [BOUND]: TOKEN },
    logger: { step: () => {} },
    baseUrl: 'http://x',
    fixtures: {},
    signal: new AbortController().signal,
  }) as never;

const config = (brokerUrl: string) =>
  ({
    brokerUrl,
    pactVersion: 'deadbeefcafe',
    auth: { secretName: BOUND, scheme: 'bearer' },
  }) as never;

const input = () =>
  ({
    consumerName: 'fulfilment-dashboard',
    providerName: 'demo-store',
    success: true,
    results: [],
  }) as never;

const tokenLeaked = (): boolean => sent.some((r) => (r.auth ?? '').includes(TOKEN));

describe('a secret names the host it belongs to', () => {
  it('reads the host out of the secret name', () => {
    expect(brokerHostFromSecretName(BOUND)).toBe('broker.acme.com');
  });

  it('treats an unnamed secret as unbound, so existing setups keep working', () => {
    expect(brokerHostFromSecretName('PACT_BROKER_TOKEN')).toBeNull();
  });
});

describe('the token reaches a legitimate broker', () => {
  it('publishes when the bound host matches the URL', async () => {
    const out = await publishVerification(ctx(), config('https://broker.acme.com/pact'), input());
    expect(out.status).toBe('PUBLISHED');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('broker.acme.com');
  });
});

describe('and never reaches anywhere else', () => {
  it.each([
    ['a lookalike host', 'https://github.com.evil.com/pact'],
    ['an unrelated attacker host', 'https://evil.example.net/'],
    ['a trailing-dot FQDN', 'https://localhost.:9292/'],
    ['credentials embedded in the URL', 'https://qa:hunter2@broker.acme.com/'],
    ['an internal cluster name', 'https://kubernetes.default.svc/'],
    ['a cloud metadata address', 'https://169.254.169.254/'],
    ['plain http', 'http://broker.acme.com/'],
  ])('refuses %s without sending the token', async (_label, url) => {
    const out = await publishVerification(ctx(), config(url), input());
    expect(out.status).not.toBe('PUBLISHED');
    expect(tokenLeaked()).toBe(false);
  });
});
