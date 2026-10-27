/**
 * Secret masking (§1: "Secrets never appear in logs, LLM prompts, or artifacts").
 *
 * This is the single chokepoint. The pino serialiser, the artifact writer, and
 * `packages/agent/llm.ts` all run their payload through `maskSecrets` before it
 * leaves the process. Getting a secret out of QAAI should require bypassing
 * this function, not merely forgetting to call a logger helper.
 */

import { SECRET_MASK } from './constants';

/** Values shorter than this are too likely to be substrings of ordinary text. */
const MIN_MASKABLE_LENGTH = 6;

/**
 * Header and field names whose values are redacted regardless of vault contents.
 *
 * ── THE TRAP IN THIS LIST, AND THE LEAK IT ALREADY CAUSED ──────────────────
 *
 * The match is EXACT on the lower-cased key (see {@link maskDeep}), not a
 * substring. So `totp` redacts and `totpSecret` DID NOT; `token` redacts and
 * `bypassToken` DID NOT; `session` redacts and `sessions` DID NOT. The list
 * reads as though it covers a family of names and it covers precisely the
 * spellings written here, which is the worst shape a safety list can have:
 * comprehensive-looking and narrow.
 *
 * `storageState` IS the session — a JSON blob of cookies minted by the browser.
 * It is not a `Secret` row, so value-masking cannot reach it either, and it was
 * travelling verbatim through the pino formatter
 * (apps/worker/src/context.ts: `log: (o) => maskDeep(o)`) and every artifact
 * writer. `RunContext.sessions` then made one storageState into one per
 * principal, multiplying the same leak.
 *
 * Every spelling a credential-bearing field actually uses in this repo is
 * therefore listed explicitly, snake_case included. When you add a field that
 * holds a credential, add its exact key here — and prefer naming it after
 * something already on this list.
 */
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
    'sessions',
    'session_id',
    'sessionstate',
    'session_state',
    // THE SESSION ITSELF. A Playwright storageState is a cookie jar: handing it
    // to anyone is handing them the logged-in account.
    'storagestate',
    'storage_state',
    'totp',
    'otp',
    'totpsecret',
    'totp_secret',
    'otpcode',
    'otp_code',
    'recoverycode',
    'recovery_code',
    // A reset token is a one-shot account takeover, and a bypass token is the
    // customer's own signed permission to skip their bot defence. Both are
    // named in the round's security rules and neither was matched.
    'resettoken',
    'reset_token',
    'bypasstoken',
    'bypass_token',
    'api_key',
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
