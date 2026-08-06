'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { useToast } from '../../../components/ui/Toast';
import { Page, PageHeader, Skeleton, SkeletonRows } from '../../../components/ui/layout';
import { SECTION_TABS_SLOT_ID } from '../../../components/shell/AppShell';

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
 *
 * It is a route rather than a `?tab=` on /settings because it comes back from
 * Stripe with `?pending=1` and has to survive a whole page load. It wears the
 * Settings header and the Settings tab strip so that it still reads as the tab
 * it is.
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

interface Me {
  activeOrgId: string;
  orgs: Array<{ id: string; name: string }>;
}

/**
 * What POST /billing/checkout answers. `url` means a first purchase and a
 * redirect to Stripe's card form; everything else means the live subscription
 * was modified in place and there is nothing to pay interactively.
 */
interface CheckoutResult {
  url?: string;
  changed?: boolean;
  plan?: string | null;
  to?: string;
  resumed?: boolean;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  overLimit?: Array<{ limit: 'projects' | 'runs'; used: number; max: number }>;
}

/** The catalogue says "unlimited" with a number nobody can read. Translate it. */
const uncapped = (n: number | null): boolean => n === null || n > 1000;

const count = (n: number) => n.toLocaleString();

function priceLabel(usd: number | null): string {
  if (usd === null) return 'talk to us';
  if (usd === 0) return 'free';
  return `$${usd}/mo`;
}

/**
 * The frame: the Settings title, the Settings tab slot, and the org name.
 *
 * Only `BillingInner` reads `?pending=1`, and it is the only thing inside the
 * Suspense boundary. `next build` refuses to prerender a page that calls
 * `useSearchParams()` without one, and the shell resolves its tab slot with a
 * single `getElementById` — a slot rendered inside a fallback is a different DOM
 * node from the one rendered after it resolves, so it has to live out here where
 * it is mounted once and never replaced.
 */
export default function BillingPage() {
  const [orgName, setOrgName] = useState<string | null>(null);

  // Only for the eyebrow: this page is a Settings tab and has to say which
  // organisation's money it is about, which /billing does not carry.
  useEffect(() => {
    void api<Me>('/auth/me')
      .then((me) => setOrgName(me.orgs.find((org) => org.id === me.activeOrgId)?.name ?? null))
      .catch(() => setOrgName(null));
  }, []);

  return (
    <Page width="settings">
      <PageHeader
        // A non-breaking space while the org name is in flight, so the title
        // does not jump down a line when it lands.
        eyebrow={orgName ? `${orgName} · Settings` : ' '}
        title="Settings"
      />

      {/* The shell portals the section strip in here, under the title. */}
      <div id={SECTION_TABS_SLOT_ID} />

      <div className="mt-[26px]">
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <BillingInner />
        </Suspense>
      </div>
    </Page>
  );
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
      const result = await api<CheckoutResult>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });

      if (result.url) {
        // A first purchase: Stripe hosts the card form. We never see a number.
        window.location.href = result.url;
        return;
      }

      /*
       * An existing subscription was modified in place — no card form, no
       * redirect. The server changed it at Stripe; the plan shown here moves
       * when the webhook lands, same contract as the post-checkout poll.
       */
      if (result.cancelAtPeriodEnd) {
        toast.success(
          'Downgrade scheduled. Your plan runs to the end of the period you paid for, then drops to Free.',
        );
      } else if (result.resumed) {
        toast.success('Cancellation withdrawn — your plan continues.');
      } else {
        toast.success(`Plan change requested — Stripe is confirming ${result.plan ?? 'it'} now.`);
      }

      // A downgrade never deletes anything; it only stops MORE being created.
      // Say which ceilings are already exceeded, so the next refused create is
      // not a surprise.
      for (const flag of result.overLimit ?? []) {
        toast.toast(
          'info',
          flag.limit === 'projects'
            ? `You have ${flag.used} projects and the lower plan includes ${flag.max}. Nothing is deleted — you just cannot create more until you are under the limit.`
            : `You have used ${flag.used} runs this month and the lower plan includes ${flag.max}. Existing results stay; new runs wait for the 1st.`,
        );
      }

      // Give the webhook a few seconds to land, then stop — the page tells the
      // truth either way, and an indefinite spinner would not.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const data = await load();
        if (!data) break;
        if (result.cancelAtPeriodEnd && data.cancelAtPeriodEnd) break;
        if (result.resumed && !data.cancelAtPeriodEnd) break;
        if (!result.cancelAtPeriodEnd && !result.resumed && data.plan === result.plan) break;
      }
      setBusy(null);
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
      <p
        role="alert"
        className="border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] text-fail text-body-sm rounded-md border px-3 py-2"
      >
        {error}
      </p>
    );
  }

  if (!billing) {
    return (
      <>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="mt-3 h-4 w-full max-w-[520px]" />
        <div className="mt-[22px]">
          <SkeletonRows rows={4} />
        </div>
      </>
    );
  }

  return (
    <BillingBody
      billing={billing}
      activating={activating}
      pending={pending}
      busy={busy}
      onCheckout={checkout}
      onPortal={portal}
    />
  );
}

function BillingBody({
  billing,
  activating,
  pending,
  busy,
  onCheckout,
  onPortal,
}: {
  billing: Billing;
  activating: boolean;
  pending: boolean;
  busy: string | null;
  onCheckout: (plan: string) => void;
  onPortal: () => void;
}) {
  const { limits, usage } = billing;

  const runs = uncapped(limits.maxRunsPerMonth)
    ? `${count(usage.runsThisMonth)} runs`
    : `${count(usage.runsThisMonth)} of ${count(limits.maxRunsPerMonth as number)} runs`;
  const projects = uncapped(limits.maxProjects)
    ? `${count(usage.projects)} projects`
    : `${count(usage.projects)} of ${count(limits.maxProjects)} projects`;

  const renewal =
    billing.currentPeriodEnd && billing.paying
      ? `${billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${new Date(
          billing.currentPeriodEnd,
        ).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`
      : null;

  return (
    <div>
      {activating && (
        <Note tone="accent">Activating your plan… this usually takes a couple of seconds.</Note>
      )}

      {!activating && pending && !billing.paying && (
        <Note tone="flake">
          Payment went through, but we have not had the confirmation from Stripe yet. It usually
          arrives within a minute — refresh, and if it is still not here, contact us and we will
          sort it out. You have not been charged twice.
        </Note>
      )}

      {/* Past due gets said plainly, because the consequence is real. */}
      {billing.status === 'past_due' && (
        <Note tone="fail">
          Your last payment failed, so you are temporarily on Free limits. Updating your card
          restores everything — nothing has been deleted.
        </Note>
      )}

      <h2 className="font-display text-display-sm font-semibold">
        {limits.label} — {priceLabel(limits.monthlyPriceUsd)}
      </h2>

      <p className="text-ink-dim text-row-sub mt-1.5 leading-relaxed">
        {runs} · {projects} · {limits.maxParallelWorkers} parallel workers ·{' '}
        {limits.artifactRetentionDays}-day artifacts.
        {renewal && ` ${renewal}`} Usage first, upsell second — usage is the honest argument
        anyway.
      </p>

      {!billing.configured && (
        <p className="text-ink-faint text-micro border-line mt-4 rounded-md border border-dashed px-3 py-2">
          This instance has no Stripe keys configured, so plans cannot be bought here. The limits
          below are still enforced.
        </p>
      )}

      <PlanTable billing={billing} busy={busy} onCheckout={onCheckout} />

      <p className="text-ink-faint text-meta mt-3 font-mono">
        stripe hosts the card form — we never see a number
        {billing.paying && (
          <>
            {' · '}
            <button
              type="button"
              onClick={onPortal}
              disabled={busy !== null}
              className="text-accent hover:underline disabled:opacity-50"
            >
              {busy === 'portal' ? 'opening…' : 'manage in the portal →'}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

const NOTE_TONE = {
  accent: 'border-accent/40 bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]',
  flake: 'border-flake/40 bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)]',
  fail: 'border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)]',
} as const;

function Note({ tone, children }: { tone: keyof typeof NOTE_TONE; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'text-body-sm mb-5 rounded-md border px-3 py-2 leading-relaxed',
        NOTE_TONE[tone],
      )}
    >
      {children}
    </p>
  );
}

/**
 * The comparison, one column per plan, the one you are on in ink.
 *
 * A real `<table>` rather than the reference's CSS grid: five columns of plan
 * limits IS tabular data, and the grid version gives a screen reader five
 * unrelated runs of text with no idea which number belongs to which plan.
 *
 * The `Monthly` row is the one addition to the design. The reference had three
 * columns and put the price only in the serif headline, which works when the
 * reader already knows what the other two cost — nobody does, and a comparison
 * table you cannot decide from is decoration.
 */
function PlanTable({
  billing,
  busy,
  onCheckout,
}: {
  billing: Billing;
  busy: string | null;
  onCheckout: (plan: string) => void;
}) {
  const cell = 'px-3.5 py-2.5 text-left align-baseline';

  return (
    <div className="border-line mt-[22px] overflow-x-auto rounded-lg border">
      <table className="text-row-sub w-full min-w-[560px] table-fixed border-collapse">
        <colgroup>
          <col className="w-[24%]" />
          {billing.catalogue.map((row) => (
            <col key={row.plan} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-line border-b">
            <th className={cell}>
              <span className="sr-only">Limit</span>
            </th>
            {billing.catalogue.map((row) => {
              const current = row.plan === billing.plan;
              return (
                <th
                  key={row.plan}
                  scope="col"
                  aria-current={current ? 'true' : undefined}
                  className={cn(
                    cell,
                    'text-meta font-mono font-normal tracking-[0.08em] uppercase',
                    current ? 'text-ink' : 'text-ink-faint',
                  )}
                >
                  {current ? `${row.label} · now` : row.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <Row label="Monthly" cell={cell}>
            {billing.catalogue.map((row) => (
              <td key={row.plan} className={cn(cell, 'tabular-nums')}>
                {priceLabel(row.monthlyPriceUsd)}
              </td>
            ))}
          </Row>
          <Row label="Runs / month" cell={cell}>
            {billing.catalogue.map((row) => (
              <td key={row.plan} className={cn(cell, 'tabular-nums')}>
                {uncapped(row.maxRunsPerMonth) ? 'unlimited' : count(row.maxRunsPerMonth as number)}
              </td>
            ))}
          </Row>
          <Row label="Parallel workers" cell={cell}>
            {billing.catalogue.map((row) => (
              <td key={row.plan} className={cn(cell, 'tabular-nums')}>
                {row.maxParallelWorkers}
              </td>
            ))}
          </Row>
          <Row label="Artifact retention" cell={cell}>
            {billing.catalogue.map((row) => (
              <td key={row.plan} className={cn(cell, 'tabular-nums')}>
                {row.artifactRetentionDays} days
              </td>
            ))}
          </Row>
          <Row label="SSO · audit export" cell={cell}>
            {billing.catalogue.map((row) => (
              <td
                key={row.plan}
                className={cn(
                  cell,
                  row.sso && row.auditLog
                    ? 'text-pass'
                    : row.sso || row.auditLog
                      ? undefined
                      : 'text-ink-faint',
                )}
              >
                {row.sso && row.auditLog
                  ? 'both'
                  : row.auditLog
                    ? 'audit only'
                    : row.sso
                      ? 'SSO only'
                      : '—'}
              </td>
            ))}
          </Row>
          <tr>
            <td className={cell} />
            {billing.catalogue.map((row, idx) => {
              const current = row.plan === billing.plan;
              const currentIdx = billing.catalogue.findIndex((r) => r.plan === billing.plan);
              // The catalogue is ordered cheapest-first, so position IS rank.
              // Calling a cheaper plan "upgrade" would misdescribe the money.
              const label = idx < currentIdx ? 'downgrade →' : 'upgrade →';
              return (
                <td key={row.plan} className={cn(cell, 'text-ink-faint text-[12px]')}>
                  {current ? (
                    'current'
                  ) : row.purchasable ? (
                    <button
                      type="button"
                      onClick={() => onCheckout(row.plan)}
                      disabled={busy !== null}
                      className="text-accent hover:underline disabled:opacity-50"
                    >
                      {busy === row.plan ? 'starting…' : label}
                    </button>
                  ) : row.plan === 'FREE' && billing.paying && billing.configured ? (
                    // The way DOWN AND OUT. Cancels at the period end — the
                    // month is paid for — which is why it shows as scheduled
                    // rather than done.
                    billing.cancelAtPeriodEnd ? (
                      'scheduled'
                    ) : (
                      <button
                        type="button"
                        onClick={() => onCheckout('FREE')}
                        disabled={busy !== null}
                        className="text-accent hover:underline disabled:opacity-50"
                      >
                        {busy === 'FREE' ? 'scheduling…' : 'downgrade →'}
                      </button>
                    )
                  ) : row.monthlyPriceUsd === null ? (
                    <a href="mailto:sales@qaai.dev" className="text-accent hover:underline">
                      contact →
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  cell,
  children,
}: {
  label: string;
  cell: string;
  children: React.ReactNode;
}) {
  return (
    <tr className="border-line border-b">
      <th scope="row" className={cn(cell, 'text-ink-dim font-normal')}>
        {label}
      </th>
      {children}
    </tr>
  );
}
