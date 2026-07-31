'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { useToast } from '../../../components/ui/Toast';

/**
 * Billing.
 *
 * Two jobs, in this order: tell someone what they are using against what they
 * are paying for, and only then offer to sell them something. A billing page
 * that leads with the upsell and buries the usage is a billing page people
 * distrust — and usage is the honest argument for upgrading anyway.
 *
 * The post-checkout state is deliberately "activating", not "thank you". Only
 * the Stripe webhook can move an org between plans; landing on the success URL
 * proves a redirect happened, not that money moved. So the page polls until the
 * server confirms, and says exactly that while it waits.
 */

interface PlanRow {
  plan: string;
  label: string;
  monthlyPriceUsd: number | null;
  maxProjects: number;
  maxRunsPerMonth: number | null;
  maxParallelWorkers: number;
  artifactRetentionDays: number;
  sso: boolean;
  auditLog: boolean;
  purchasable: boolean;
}

interface Billing {
  plan: string;
  status: string;
  paying: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  limits: PlanRow;
  usage: { runsThisMonth: number; projects: number };
  configured: boolean;
  catalogue: PlanRow[];
}

function BillingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = params.get('pending') === '1';
  const [activating, setActivating] = useState(pending);

  const load = useCallback(async () => {
    try {
      const data = await api<Billing>('/billing');
      setBilling(data);
      setError(null);
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return null;
      }
      setError(err instanceof Error ? err.message : 'Could not load billing');
      return null;
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * After checkout, poll until the webhook lands.
   *
   * Bounded rather than indefinite: if Stripe cannot reach the webhook (the
   * classic local-dev case — no `stripe listen` running) the page must stop
   * spinning and say so, instead of implying the payment failed. It did not;
   * the notification did.
   */
  useEffect(() => {
    if (!activating) return;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      const data = await load();
      if (data?.paying) {
        setActivating(false);
        toast.success(`You are on ${data.limits.label}.`);
        router.replace('/settings/billing');
      } else if (attempts >= 10) {
        setActivating(false);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [activating, load, router, toast]);

  async function checkout(plan: string) {
    setBusy(plan);
    try {
      const { url } = await api<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      // Stripe hosts the card form. We never see a card number.
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
      setBusy(null);
    }
  }

  async function portal() {
    setBusy('portal');
    try {
      const { url } = await api<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the billing portal');
      setBusy(null);
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
          {error}
        </p>
      </main>
    );
  }

  if (!billing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-ink-faint text-body-sm">Loading…</p>
      </main>
    );
  }

  const { limits, usage } = billing;
  const runCap = limits.maxRunsPerMonth;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Billing</h1>
      <p className="text-ink-dim text-body-sm mb-8">
        You are on <span className="text-ink font-medium">{limits.label}</span>
        {billing.currentPeriodEnd && billing.paying && (
          <>
            {' · '}
            {billing.cancelAtPeriodEnd ? 'ends' : 'renews'}{' '}
            {new Date(billing.currentPeriodEnd).toLocaleDateString()}
          </>
        )}
      </p>

      {activating && (
        <p className="border-accent/50 bg-accent/10 text-body-sm mb-6 rounded-md border p-3">
          Activating your plan… this usually takes a couple of seconds.
        </p>
      )}

      {!activating && pending && !billing.paying && (
        <p className="border-flake/40 bg-flake/10 text-body-sm mb-6 rounded-md border p-3">
          Payment went through, but we have not had the confirmation from Stripe yet. It usually
          arrives within a minute — refresh, and if it is still not here, contact us and we will sort
          it out. You have not been charged twice.
        </p>
      )}

      {/* Past due gets said plainly, because the consequence is real. */}
      {billing.status === 'past_due' && (
        <p className="border-fail/50 bg-fail/10 text-body-sm mb-6 rounded-md border p-3">
          Your last payment failed, so you are temporarily on Free limits. Updating your card
          restores everything — nothing has been deleted.
        </p>
      )}

      <section className="mb-10">
        <h2 className="text-micro text-ink-faint mb-3 font-semibold tracking-wider uppercase">
          This month
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Meter
            label="Runs"
            used={usage.runsThisMonth}
            cap={runCap}
            note={runCap === null ? 'Unlimited on your plan' : 'Resets on the 1st'}
          />
          <Meter label="Projects" used={usage.projects} cap={limits.maxProjects} />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-micro text-ink-faint font-semibold tracking-wider uppercase">Plans</h2>
          {billing.paying && (
            <button
              type="button"
              onClick={() => void portal()}
              disabled={busy !== null}
              className="text-accent text-body-sm hover:underline disabled:opacity-50"
            >
              Manage payment & invoices →
            </button>
          )}
        </div>

        {!billing.configured && (
          <p className="text-ink-faint text-body-sm border-line mb-3 rounded-md border border-dashed p-3">
            This instance has no Stripe keys configured, so plans cannot be bought here. Limits
            below are still enforced.
          </p>
        )}

        <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-lg border">
          {billing.catalogue.map((row) => {
            const current = row.plan === billing.plan;
            return (
              <div key={row.plan} className="flex items-center gap-4 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {row.label}
                    {current && (
                      <span className="border-accent/50 text-accent text-meta ml-2 rounded border px-1.5 py-0.5 align-middle">
                        CURRENT
                      </span>
                    )}
                  </p>
                  <p className="text-ink-faint text-micro mt-1">
                    {row.maxProjects > 1000 ? 'Unlimited' : row.maxProjects} project
                    {row.maxProjects === 1 ? '' : 's'} ·{' '}
                    {row.maxRunsPerMonth === null ? 'unlimited runs' : `${row.maxRunsPerMonth} runs`}{' '}
                    · {row.maxParallelWorkers} parallel · {row.artifactRetentionDays}d artifacts
                    {row.sso && ' · SSO'}
                    {row.auditLog && ' · audit log'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-body-sm">
                    {row.monthlyPriceUsd === null ? (
                      <span className="text-ink-dim">Talk to us</span>
                    ) : row.monthlyPriceUsd === 0 ? (
                      <span className="text-ink-dim">Free</span>
                    ) : (
                      <>
                        ${row.monthlyPriceUsd}
                        <span className="text-ink-faint text-micro">/mo</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="w-24 text-right">
                  {!current && row.purchasable && (
                    <button
                      type="button"
                      onClick={() => void checkout(row.plan)}
                      disabled={busy !== null}
                      className="bg-accent text-body-sm rounded-md px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === row.plan ? '…' : 'Upgrade'}
                    </button>
                  )}
                  {!current && !row.purchasable && row.monthlyPriceUsd === null && (
                    <a
                      href="mailto:sales@qaai.dev"
                      className="text-accent text-body-sm hover:underline"
                    >
                      Contact
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

/** A usage bar that only alarms when there is something to be alarmed about. */
function Meter({
  label,
  used,
  cap,
  note,
}: {
  label: string;
  used: number;
  cap: number | null;
  note?: string;
}) {
  const unlimited = cap === null || cap > 1000;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / cap) * 100));
  const tone = pct >= 100 ? 'bg-fail' : pct >= 80 ? 'bg-flake' : 'bg-accent';

  return (
    <div className="border-line bg-surface-1 rounded-lg border p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-body-sm text-ink-dim">{label}</p>
        <p className="text-sm">
          <span className="font-medium">{used}</span>
          <span className="text-ink-faint">{unlimited ? '' : ` / ${cap}`}</span>
        </p>
      </div>
      {!unlimited && (
        <div className="bg-surface-2 mt-2.5 h-1.5 overflow-hidden rounded-full">
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {note && <p className="text-ink-faint text-micro mt-2">{note}</p>}
    </div>
  );
}

/**
 * `useSearchParams()` forces a client-side bailout, and Next refuses to
 * statically prerender a page that does so without a Suspense boundary — it
 * failed the production build outright ("useSearchParams() should be wrapped in
 * a suspense boundary"). The boundary lets the shell prerender and the
 * param-dependent part hydrate on the client.
 */
export default function BillingPage() {
  return (
    <Suspense fallback={<main className="text-ink-faint p-10 text-body-sm">Loading…</main>}>
      <BillingInner />
    </Suspense>
  );
}
