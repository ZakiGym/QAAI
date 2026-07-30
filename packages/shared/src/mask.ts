/**
 * Secret masking (§1: "Secrets never appear in logs, LLM prompts, or artifacts").
 *
 * This is the single chokepoint. The pino serialiser, the artifact writer, and
 * `packages/agent/llm.ts` all run their payload through `maskSecrets` before it
 * leaves the process. Getting a secret out of QAAI should require bypassing
 * this function, not merely forgetting to call a logger helper.
 */

import { SECRET_MASK } from './constants.js';

/** Values shorter than this are too likely to be substrings of ordinary text. */
const MIN_MASKABLE_LENGTH = 6;

/** Header and field names whose values are redacted regardless of vault contents. */
const ALWAYS_REDACT_KEYS = new Set(
  [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'apikey',
    'password',
    'passwd',
    'secret',
    'token',
    'access_token',
    'refresh_token',
    'client_secret',
    'private_key',
    'session',
    'sessionid',
    'totp',
    'otp',
    'card',
    'cardnumber',
    'cvc',
    'cvv',
    'ssn',
  ].map((k) => k.toLowerCase()),
);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a reusable masker for one set of secret values. Constructing the regex
 * once matters: this runs on every log line and every network body of a run.
 */
export function createMasker(secretValues: Iterable<string>): (input: string) => string {
  const values = [...new Set(secretValues)]
    .filter((v) => typeof v === 'string' && v.length >= MIN_MASKABLE_LENGTH)
    // Longest first, so a secret that contains another is masked whole.
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) return (input) => input;

  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'g');
  return (input: string) =>
    typeof input === 'string' ? input.replace(pattern, SECRET_MASK) : input;
}

/** One-shot convenience wrapper around {@link createMasker}. */
export function maskSecrets(input: string, secretValues: Iterable<string>): string {
  return createMasker(secretValues)(input);
}

/**
 * Deep-clones `value`, masking any string that contains a known secret and any
 * value whose key looks sensitive. Cycles are handled; functions are dropped.
 */
export function maskDeep<T>(value: T, secretValues: Iterable<string> = []): T {
  const mask = createMasker(secretValues);
  const seen = new WeakMap<object, unknown>();

  const walk = (node: unknown, keyHint: string | null): unknown => {
    if (typeof node === 'string') {
      if (keyHint && ALWAYS_REDACT_KEYS.has(keyHint.toLowerCase())) return SECRET_MASK;
      return mask(node);
    }
    if (node === null || typeof node !== 'object') return node;

    const asObject = node as object;
    const cached = seen.get(asObject);
    if (cached !== undefined) return cached;

    if (Array.isArray(node)) {
      const out: unknown[] = [];
      seen.set(asObject, out);
      for (const item of node) out.push(walk(item, keyHint));
      return out;
    }

    // Error instances lose their properties under a naive spread.
    if (node instanceof Error) {
      return {
        name: node.name,
        message: mask(node.message),
        stack: node.stack ? mask(node.stack) : null,
      };
    }

    const out: Record<string, unknown> = {};
    seen.set(asObject, out);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'function') continue;
      out[k] = ALWAYS_REDACT_KEYS.has(k.toLowerCase()) && v != null ? SECRET_MASK : walk(v, k);
    }
    return out;
  };

  return walk(value, null) as T;
}

/**
 * Masks a URL's credentials and any query parameter with a sensitive name.
 * Returns the input unchanged if it does not parse as a URL.
 */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.username) url.username = SECRET_MASK;
  if (url.password) url.password = SECRET_MASK;
  for (const key of [...url.searchParams.keys()]) {
    if (ALWAYS_REDACT_KEYS.has(key.toLowerCase())) url.searchParams.set(key, SECRET_MASK);
  }
  return url.toString();
}
