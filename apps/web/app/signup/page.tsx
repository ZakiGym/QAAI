'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { API_URL, api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Badge, Card, Skeleton } from '../../components/ui/layout';

/**
 * Create an account, or accept an invitation (§1).
 *
 * `POST /auth/signup` has two arms and this screen only ever sent one. An admin
 * invites a teammate, the API mints `…/signup?invite=<token>`, and the page
 * ignored the query string entirely — so the recipient created their OWN
 * organisation, alone, and the seat they were invited to stayed empty. The
 * token was never spent, so the link kept working and kept doing the wrong
 * thing.
 *
 * The invite is therefore read before anything is rendered: it decides the
 * heading, whether there is an organisation field at all, and which arm of the
 * strict union is submitted.
 */

/** Mirrors signupSchema in packages/shared: `z.string().min(12).max(200)`. */
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/**
 * `blocked` covers both answers that are not a usable invite: the API's own
 * 410 (expired, already used, never existed) and our failure to ask it at all.
 * They read differently to the user, so `retryable` keeps them apart — one is a
 * settled fact, the other is worth pressing a button about.
 */
type InviteState =
  | { status: 'none' }
  | { status: 'checking' }
  | { status: 'valid'; token: string; email: string; role: string | null; orgName: string }
  | { status: 'blocked'; reason: string; retryable: boolean };

/** The API's rule, said before the request instead of after it. */
function passwordProblem(value: string): string | null {
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (value.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <PendingForm />
        </AuthShell>
      }
    >
      <SignupInner />
    </Suspense>
  );
}

function SignupInner() {
  const token = useSearchParams().get('invite');

  /*
   * Seeded from the token rather than defaulting to `none`, because `none` is
   * the state that renders the organisation field — an invited user would see
   * "name your organisation" for one frame and be told, briefly, exactly the
   * wrong thing about what this screen does.
   */
  const [invite, setInvite] = useState<InviteState>(() =>
    token ? { status: 'checking' } : { status: 'none' },
  );
  const [attempt, setAttempt] = useState(0);

  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState({ password: false, confirm: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setInvite({ status: 'checking' });

    void (async () => {
      try {
        /*
         * Raw fetch rather than api(): a dead invite is a 410 carrying
         * `{ valid: false, reason }` at the top level, and the shared client
         * reads a failure's message out of `error.message` — so the reason,
         * which is the only thing on this screen worth reading, would arrive as
         * "Request failed with 410".
         */
        const response = await fetch(`${API_URL}/auth/invite?token=${encodeURIComponent(token)}`, {
          credentials: 'include',
        });
        const body = (await response.json().catch(() => null)) as {
          valid?: boolean;
          email?: string;
          role?: string;
          org?: { name?: string };
          reason?: string;
        } | null;
        if (cancelled) return;

        if (response.ok && body?.valid && body.email && body.org?.name) {
          setInvite({
            status: 'valid',
            token,
            email: body.email,
            role: typeof body.role === 'string' ? body.role : null,
            orgName: body.org.name,
          });
          return;
        }

        setInvite({
          status: 'blocked',
          reason: body?.reason ?? 'That invitation link is not valid.',
          // 410 is the API's considered answer and will not change on a second
          // ask. Anything else is a fault on our side of the wire.
          retryable: response.status !== 410,
        });
      } catch {
        if (cancelled) return;
        setInvite({
          status: 'blocked',
          reason: 'Could not reach QAAI to check that invitation.',
          retryable: true,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const invited = invite.status === 'valid' ? invite : null;
  /*
   * The API refuses a signup whose email is not the invited address, so the
   * invited one is the value — not a default the field can be typed over. An
   * editable box here is a trap: it accepts the change, and the server rejects
   * the whole account.
   */
  const emailValue = invited ? invited.email : email;

  const passwordError = touched.password ? passwordProblem(password) : null;
  const confirmError =
    touched.confirm && confirm !== password ? 'Those two passwords are not the same.' : null;

  function markTouched(field: 'password' | 'confirm') {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // A refusal has to say why, so failing the check reveals both messages
    // rather than making the button feel broken.
    setTouched({ password: true, confirm: true });
    if (passwordProblem(password) || confirm !== password) return;

    setBusy(true);
    setError(null);
    try {
      /*
       * One arm of the union or the other. signupSchema is a strict union, so
       * a body carrying both `invite` and `orgName` is not "the invite wins" —
       * it matches neither arm and fails validation outright.
       */
      const body = invited
        ? { email: invited.email, password, name, invite: invited.token }
        : { email, password, name, orgName };

      await api('/auth/signup', { method: 'POST', body: JSON.stringify(body) });

      /*
       * Signup signs you in, so go straight to the thing you came to do — with
       * a full navigation, so the root-layout ProjectProvider and top-bar
       * session mount against the new session instead of whatever was on
       * screen before. See the note in login/page.tsx.
       *
       * Joining an existing org skips onboarding: that screen exists to create
       * a first project by crawling an app, and the org you just joined already
       * has projects and runs to look at.
       */
      window.location.assign(invited ? '/runs' : '/onboarding');
    } catch (err) {
      /*
       * There is no path for an existing account to accept an invitation — the
       * token is only ever spent by POST /auth/signup, which refuses an address
       * it already knows. Saying "an account with that email already exists"
       * and stopping would leave them pressing the same button forever.
       */
      if (invited && err instanceof ApiError && err.status === 409) {
        setError(
          `${invited.email} already has a QAAI account. An invitation can only be accepted by a new account, so ask ${invited.orgName} to invite an address you have not signed up with.`,
        );
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not create the account');
      }
    } finally {
      setBusy(false);
    }
  }

  if (invite.status === 'checking') {
    return (
      <AuthShell>
        <PendingForm label="Checking your invitation" />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight break-words">
        {invited ? `Join ${invited.orgName}` : 'Create your QAAI account'}
      </h1>
      <p className="text-ink-dim mt-1 mb-8 text-sm">
        {invited
          ? 'An administrator there invited you. This account joins that organisation — it does not create a new one.'
          : 'One account, one organisation, and you are ready to add an app.'}
      </p>

      {invite.status === 'blocked' && (
        <div role="alert" className="border-flake/40 bg-flake/10 mb-6 rounded-md border p-3.5">
          {/* The API's own sentence, verbatim. It is the one that says which of
              expired / used / unknown this was. */}
          <p className="text-flake text-body-sm">{invite.reason}</p>
          <p className="text-ink-dim text-micro mt-1.5 leading-relaxed">
            {invite.retryable
              ? 'Creating an account now makes a new organisation of your own rather than joining the one that invited you.'
              : 'You can still create your own organisation below, or ask whoever invited you for a fresh link.'}
          </p>
          {invite.retryable && (
            <Button size="sm" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Check again
            </Button>
          )}
        </div>
      )}

      {invited && (
        <Card className="mb-6 flex items-center gap-3 p-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-ink-faint text-micro">Invitation for</p>
            <p className="text-body-sm truncate">{invited.email}</p>
          </div>
          {invited.role && (
            // `text-meta` restated because tailwind-merge cannot tell this
            // project's custom font size from its custom text colour, so a
            // toned Badge silently drops its own size and renders at 16px.
            <Badge tone="accent" className="text-meta">
              Joins as {ROLE_LABEL[invited.role] ?? invited.role}
            </Badge>
          )}
        </Card>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Field
          id="name"
          label="Your name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />

        {/*
          Not rendered at all when invited, rather than hidden: the API refuses
          `orgName` alongside `invite`, and a required input that exists but
          cannot be seen blocks submission with a bubble pointing at nothing.
        */}
        {!invited && (
          <Field
            id="orgName"
            label="Organisation"
            required
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme Inc"
            autoComplete="organization"
          />
        )}

        <Field
          id="email"
          label="Email address"
          type="email"
          required
          value={emailValue}
          readOnly={invited !== null}
          onChange={invited ? undefined : (e) => setEmail(e.target.value)}
          autoComplete="email"
          hint={
            invited
              ? 'The invitation was issued for this address; the API refuses any other.'
              : undefined
          }
          className={invited ? 'text-ink-dim' : undefined}
        />

        <div>
          {/*
            Field's own label leaves no room for the reveal control, so the row
            is assembled here with the same classes it uses.
          */}
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label htmlFor="password" className="text-ink-dim text-body-sm">
              Password
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReveal((shown) => !shown)}
              aria-pressed={reveal}
              aria-controls="password confirm"
              className="-my-1"
            >
              {reveal ? 'Hide' : 'Show'}
            </Button>
          </div>
          <Field
            id="password"
            type={reveal ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // Blurring a field you never typed in is not a mistake worth a red
            // line; the submit path marks it touched regardless.
            onBlur={(e) => {
              if (e.target.value) markTouched('password');
            }}
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={passwordError}
          />
        </div>

        <Field
          id="confirm"
          label="Confirm password"
          type={reveal ? 'text' : 'password'}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={(e) => {
            if (e.target.value) markTouched('confirm');
          }}
          autoComplete="new-password"
          error={confirmError}
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
          <span className="min-w-0 truncate">
            {busy
              ? invited
                ? 'Joining…'
                : 'Creating…'
              : invited
                ? `Join ${invited.orgName}`
                : 'Create account'}
          </span>
        </Button>
      </form>

      <p className="text-ink-faint mt-6 text-sm">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

/** The auth-screen frame, shared with /login. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="app-drag-strip" />
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        {children}
      </main>
    </>
  );
}

/**
 * Shown while the invite is being read — including in the Suspense fallback,
 * where the query string has not been parsed yet.
 *
 * Deliberately says nothing: both real headings ("Create your QAAI account",
 * "Join Acme") are claims about which organisation you are about to be in, and
 * neither is known yet. The label is a prop for the same reason — the fallback
 * cannot yet know whether an invitation is what is being waited on.
 */
function PendingForm({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-label={label}>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="mt-3 h-3.5 w-full" />
      <Skeleton className="mt-8 h-14 w-full" />
      <Skeleton className="mt-4 h-14 w-full" />
      <Skeleton className="mt-4 h-14 w-full" />
      <Skeleton className="mt-6 h-9 w-full" />
    </div>
  );
}
