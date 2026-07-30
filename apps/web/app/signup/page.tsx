'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';

/**
 * Create an account (§1).
 *
 * `POST /auth/signup` has existed since the first commit and nothing ever
 * called it — the only way into the app was the seeded demo account, which made
 * QAAI unusable by an actual new user. Signup creates the user and their first
 * organisation in one transaction, so this is genuinely one screen.
 */
export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, orgName }),
      });
      // Signup signs you in, so go straight to the thing you came to do.
      router.push('/onboarding');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not create the account',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="app-drag-strip" />
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Create your QAAI account</h1>
        <p className="text-ink-dim mt-1 mb-8 text-sm">
          One account, one organisation, and you are ready to add an app.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
              Your name
            </label>
            <input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
          </div>

          <div>
            <label htmlFor="orgName" className="mb-1.5 block text-sm font-medium">
              Organisation
            </label>
            <input
              id="orgName"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Inc"
              autoComplete="organization"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
          </div>

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
              autoComplete="email"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
            />
            <p className="text-ink-faint mt-1.5 text-xs">At least 12 characters.</p>
          </div>

          {error && (
            <p role="alert" className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="bg-accent w-full rounded-md px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="text-ink-faint mt-6 text-sm">
          Already have an account?{' '}
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </main>
    </>
  );
}
