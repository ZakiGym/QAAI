'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Skeleton } from '../../components/ui/layout';

/**
 * Reset a password.
 *
 * Two halves of one journey separated by an email, so they are two modes of one
 * route rather than two screens: without `?token=` this is where "Forgot
 * password?" on /login goes, and with one it is where the link in the mail
 * lands.
 *
 * The thing this screen must not do is promise an email. `/auth/password/forgot`
 * reports how it delivered, and on an install with no SMTP host it wrote the
 * link to the API log instead — telling that person to check their inbox leaves
 * them waiting for a message nobody is going to send.
 *
 * Nothing here learns whether an account exists. `/forgot` answers identically
 * for every address on purpose, so that it cannot be used to ask "does this
 * person use QAAI?", and the copy below stays in the conditional the API's own
 * message is written in.
 */

/** POST /auth/password/forgot — always 200, whether or not the address is known. */
interface ForgotResponse {
  ok: true;
  message: string;
  /** `console` means this deployment has no mail server. It has to be said out loud. */
  delivery: 'smtp' | 'console';
}

export default function ResetPasswordPage() {
  /*
   * `useSearchParams` without a Suspense boundary fails `next build` outright.
   * Same shape as /heals, for the same reason.
   */
  return (
    <Suspense fallback={<Loading />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  /*
   * `?token=` with nothing after it is not a token. Treating it as one would
   * show a set-a-password form whose only possible outcome is a 400.
   */
  const token = useSearchParams().get('token') || null;

  return token ? <SetNewPassword token={token} /> : <RequestLink />;
}

/**
 * The frame /login and /signup use. This route is signed-out — it is in
 * SHELL_EXCLUDED — so it draws its own page, including the desktop build's drag
 * strip, which is the only way to move a window on a screen with no sidebar.
 */
function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="app-drag-strip" />
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-ink-dim mt-1 text-sm">{subtitle}</p>}
        </header>
        {children}
      </main>
    </>
  );
}

function Loading() {
  return (
    <AuthFrame title="Reset your password">
      <div className="space-y-4" role="status" aria-label="Loading">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </AuthFrame>
  );
}

/** No token: ask for a link. */
function RequestLink() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<ForgotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<ForgotResponse>('/auth/password/forgot', {
          method: 'POST',
          body: JSON.stringify({ email }),
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a password reset');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <AuthFrame title="Reset your password">
        {/*
          The API's own words, unedited. They are careful ones — "if an account
          exists for that address" — and rewriting them here is how a screen
          ends up confirming which addresses are real.
        */}
        <div role="status" className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-sm">{result.message}</p>

          {result.delivery === 'console' && (
            <p className="border-flake/40 bg-flake/10 text-flake mt-3 rounded-md border p-3 text-sm">
              This deployment has no mail server configured, so nothing will reach
              your inbox. The reset link was written to the API log instead — ask
              an administrator to read it out for you.
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Link href="/login" className="text-accent text-sm hover:underline">
            Back to sign in
          </Link>
          {/* A typo in the address is otherwise a dead end that needs a reload. */}
          <Button
            size="sm"
            onClick={() => {
              setResult(null);
              setError(null);
            }}
          >
            Use a different address
          </Button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Reset your password"
      subtitle="Enter the address you sign in with and we will start a reset."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          id="email"
          label="Email address"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {error && (
          <p
            role="alert"
            className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm"
          >
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          {busy ? 'Requesting…' : 'Request a reset link'}
        </Button>
      </form>

      <p className="text-ink-faint mt-6 text-sm">
        Remembered it?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>

      {/*
        An SSO account has no password stored at all, so /forgot deliberately
        does nothing for one — and answers exactly as it does for everyone else.
        Without this line that person waits for a link that was never created.
      */}
      <p className="text-ink-faint mt-4 text-xs">
        Accounts that sign in through an identity provider have no password to
        reset. Use “Sign in with SSO” on the sign-in page instead.
      </p>
    </AuthFrame>
  );
}

/** With a token: set the new password. */
function SetNewPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A 400 is the link being dead, not the password being bad — so offer a new one. */
  const [linkDead, setLinkDead] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setBusy(true);
    setError(null);
    setLinkDead(false);
    try {
      await api('/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      /*
       * The API's 400 already says the link is invalid or expired and to ask for
       * a new one. Substituting our own sentence would give one failure two
       * slightly different accounts, and only one of them stays true.
       */
      setError(err instanceof ApiError ? err.message : 'Could not set a new password');
      setLinkDead(err instanceof ApiError && err.status === 400);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthFrame title="Password changed">
        <div role="status" className="border-pass/40 bg-pass/10 rounded-lg border p-4">
          <p className="text-pass text-sm font-medium">Your new password is saved.</p>
          <p className="text-ink-dim mt-2 text-sm">
            Every other session has been signed out, on every device. If the reset
            happened because somebody else had this account, they are out too.
          </p>
        </div>

        <p className="mt-6 text-sm">
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Set a new password"
      subtitle="Pick something you have not used on this account before."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          id="password"
          label="New password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          hint="At least 12 characters."
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setMismatch(false);
          }}
        />

        <Field
          id="confirm"
          label="Confirm new password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          error={mismatch ? 'Those two passwords do not match.' : null}
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setMismatch(false);
          }}
        />

        {error && (
          <div role="alert" className="border-fail/40 bg-fail/10 rounded-md border p-3">
            <p className="text-fail text-sm">{error}</p>
            {linkDead && (
              <Link
                href="/reset-password"
                className="text-accent mt-2 inline-block text-sm hover:underline"
              >
                Ask for a new link
              </Link>
            )}
          </div>
        )}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>

      <p className="text-ink-faint mt-6 text-sm">
        Remembered it?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
