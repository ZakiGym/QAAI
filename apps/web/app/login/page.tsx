'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@qaai.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      router.push('/runs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
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
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
              Password
            </label>
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

        <p className="text-ink-faint mt-6 text-sm">
          New here?{' '}
          <Link href="/signup" className="text-accent hover:underline">
            Create an account
          </Link>
        </p>

        <p className="text-ink-faint mt-4 text-xs">
          Seeded demo account: <code className="font-mono">owner@qaai.local</code> /{' '}
          <code className="font-mono">qaai-demo-password-1</code>
        </p>
      </main>
    </>
  );
}
