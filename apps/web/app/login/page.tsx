'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api';

/**
 * The seeded demo account was prefilled into the email box and its password
 * printed under the form on every build, so every production deployment of QAAI
 * handed working credentials to anyone who opened the sign-in page. `NODE_ENV`
 * is substituted at build time, so a production bundle never renders either.
 */
const SHOW_DEMO_ACCOUNT = process.env.NODE_ENV !== 'production';

/**
 * Sign in.
 *
 * The password form is untouched — same fields, same handler, same behaviour on
 * Enter — because SSO must never be able to break the way most people get in.
 * The SSO path is a second button under it, and it works the way every
 * enterprise login does: ask for the email first, and only send the browser to
 * an identity provider if that email's domain has a verified connection.
 *
 * Nothing here decides anything. `/sso/discover` answers `{ available }` and
 * the server is the only thing that knows which org a domain belongs to; the
 * page never learns an org name from an address it was handed.
 */
export default function LoginPage() {
  const [email, setEmail] = useState(SHOW_DEMO_ACCOUNT ? 'owner@qaai.local' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);

  /*
   * The API redirects failures back here with ?sso_error=… — the message is
   * written by the server, never by a provider. Read from location rather than
   * useSearchParams so the page does not need a Suspense boundary, and stripped
   * from the URL afterwards so a refresh does not resurrect a stale error.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get('sso_error');
    if (!ssoError) return;
    setError(ssoError);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      /*
       * A full navigation, not router.push. ProjectProvider and the top bar's
       * session both live at the root layout and fetch exactly once on mount;
       * a client-side push does not remount them, so signing in as a second
       * user left the previous user's project list, selected project and
       * avatar on screen, and every context-driven screen went on querying a
       * project id in an org this session cannot see.
       *
       * This is the same call the org switcher already makes, for the same
       * reason it gives: every cached list on every screen belongs to the
       * previous identity.
       */
      window.location.assign('/runs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function startSso() {
    setSsoBusy(true);
    setError(null);
    try {
      const result = await api<{ available: boolean; startUrl?: string }>('/sso/discover', {
        method: 'POST',
        // POST, not a query string: an email address does not belong in a URL,
        // a proxy log or a Referer header.
        body: JSON.stringify({ email }),
      });

      if (!result.available || !result.startUrl) {
        setError(
          'No single sign-on is set up for that email domain. Sign in with your password instead.',
        );
        return;
      }
      // A full navigation, not fetch: the response is a 302 to the identity
      // provider and the browser has to follow it itself.
      window.location.assign(result.startUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start single sign-on');
    } finally {
      setSsoBusy(false);
    }
  }

  return (
    <>
      <div className="app-drag-strip" />
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to QAAI</h1>
        <p className="text-ink-dim mt-1 mb-8 text-sm">Supervise the agent.</p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
          </div>

          <div>
            {/*
              On the password field's own label row, because that is where a
              person looks the moment the password fails — and until now there
              was no link to a reset anywhere in the product, so the only exit
              from a forgotten password was asking someone with database access.
            */}
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Link href="/reset-password" className="text-accent text-xs hover:underline">
                Forgot password?
              </Link>
            </div>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
          </div>

          {error && (
            <p role="alert" className="text-fail text-sm">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="bg-accent w-full rounded-md py-2 font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="my-6 flex items-center gap-3" aria-hidden="true">
          <span className="bg-line h-px flex-1" />
          <span className="text-ink-faint text-xs">or</span>
          <span className="bg-line h-px flex-1" />
        </div>

        {/*
          Outside the form on purpose. Inside it, the browser's required-field
          validation would demand a password before it would let this run, and
          an SSO user does not have one.
        */}
        <button
          type="button"
          onClick={startSso}
          disabled={ssoBusy || email.trim().length === 0}
          className="border-line text-ink-dim hover:text-ink hover:border-line-strong w-full rounded-md border py-2 font-medium transition-colors disabled:opacity-50"
        >
          {ssoBusy ? 'Checking…' : 'Sign in with SSO'}
        </button>
        <p className="text-ink-faint mt-2 text-xs">
          Uses the identity provider configured for your email domain.
        </p>

        <p className="text-ink-faint mt-6 text-sm">
          New here?{' '}
          <Link href="/signup" className="text-accent hover:underline">
            Create an account
          </Link>
        </p>

        {SHOW_DEMO_ACCOUNT && (
          <p className="text-ink-faint mt-4 text-xs">
            Seeded demo account: <code className="font-mono">owner@qaai.local</code> /{' '}
            <code className="font-mono">qaai-demo-password-1</code>
          </p>
        )}
      </main>
    </>
  );
}
