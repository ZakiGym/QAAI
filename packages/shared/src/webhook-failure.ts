/**
 * A webhook delivery failure, described without the URL.
 *
 * Both places that POST to a customer's webhook — the API's send-a-test
 * endpoint and the worker's notify processor — deliberately refuse to record
 * `err.message`: undici embeds the full URL in it, and for an incoming-webhook
 * integration the URL IS the credential. What they recorded instead was the
 * single sentence "delivery failed", which protected the secret and abandoned
 * the operator: connection-refused, a DNS typo and a TLS mismatch all looked
 * identical, and each has a different fix.
 *
 * This is the middle ground: undici wraps the real network error in
 * `err.cause` with a syscall code, and the CODE names the failure class
 * without carrying the URL. One classifier, used by both senders, so the two
 * delivery logs never drift apart in vocabulary.
 */

/** The wrapped cause shapes undici and Node's TLS layer actually produce. */
interface CauseLike {
  code?: string;
  name?: string;
  message?: string;
}

export function describeWebhookFailure(err: unknown, timeoutSeconds: number): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `no answer within ${timeoutSeconds}s`;
  }

  const cause = (err instanceof Error ? (err.cause as CauseLike | undefined) : undefined) ?? {};
  const code = cause.code ?? '';

  if (code === 'ECONNREFUSED') return 'connection refused — nothing is listening at that address';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'DNS lookup failed — the hostname does not resolve';
  }
  if (code === 'ECONNRESET') return 'connection reset — the server hung up mid-request';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return 'connect timeout — the host did not answer the handshake';
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    // OpenSSL verification failures surface as bare reason codes.
    /CERT|SSL|TLS/i.test(code) ||
    /certificate|tls|ssl/i.test(cause.message ?? '')
  ) {
    return 'TLS handshake failed — check the certificate on the receiving end';
  }

  // Unrecognised: keep the old sentence rather than guessing, and still never
  // echo the message — an unknown error is exactly the kind most likely to
  // carry the URL somewhere unexpected.
  return 'delivery failed';
}
