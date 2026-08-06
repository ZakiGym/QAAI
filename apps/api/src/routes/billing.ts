/**
 * Billing (§9) — Stripe Checkout, the customer portal, and the webhook.
 *
 * The design principle here is that **Stripe is the source of truth and this
 * app is a cache of it.** Nothing in the local `Subscription` row is ever
 * written from a browser round-trip — not from the checkout redirect, not from
 * a "confirm" call. A user who returns to the success URL has proven they were
 * redirected there, not that they paid; the two come apart under a back button,
 * a shared link, or anyone who reads the URL. Only a signed webhook moves an
 * org between plans.
 *
 * That means the honest post-checkout experience is "we're activating your
 * plan" for the second or two the webhook takes, and the UI says exactly that
 * rather than claiming success it cannot verify.
 */

import { Router } from 'express';
import Stripe from 'stripe';
import { PLANS, PLAN_LIMITS, type Plan } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { overLimitFor, planFor, usageFor } from '../lib/plan.js';
import { audit } from '../lib/audit.js';
import { paymentFailedMail, sendMail } from '../lib/mail.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

export const billingRouter: Router = Router();

/**
 * Constructed lazily, and absent rather than fake when unconfigured.
 *
 * A self-hosted QAAI has no Stripe account and should not be forced to invent
 * one. Every paid path below returns a clear 400 in that case; every *read*
 * path keeps working, so an unconfigured install still shows plan and usage.
 */
let stripeClient: Stripe | null = null;
function stripe(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  stripeClient ??= new Stripe(env.STRIPE_SECRET_KEY);
  return stripeClient;
}

/** Which Stripe price sells which plan. Enterprise is a conversation, not a link. */
function priceIdFor(plan: Plan): string | null {
  if (plan === 'TEAM') return env.STRIPE_PRICE_TEAM ?? null;
  if (plan === 'BUSINESS') return env.STRIPE_PRICE_BUSINESS ?? null;
  return null;
}

/** Plan for a Stripe price — the reverse lookup the webhook needs. */
function planForPrice(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_TEAM) return 'TEAM';
  if (priceId === env.STRIPE_PRICE_BUSINESS) return 'BUSINESS';
  return null;
}

/*
 * Statuses that mean "Stripe will bill this again unless somebody acts".
 *
 * `incomplete` is deliberately absent: it is a first payment that never went
 * through, it expires into `incomplete_expired` on its own within a day, and
 * it never bills — repricing it cannot charge anyone, so a fresh Checkout
 * Session is the honest path past one. Everything else here — including
 * `past_due`, `unpaid` and `paused` — is a subscription that can come back to
 * life and bill, and creating a second one next to it is exactly the double
 * charge this file exists to prevent.
 */
const LIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
]);

/**
 * The customer's live subscription at Stripe, if any.
 *
 * Asked of Stripe rather than the local row, because the row is a cache filled
 * by webhooks and a missed webhook must not turn into a second monthly bill.
 * `status: 'all'` then filtered here: the API's default filter and this file's
 * definition of "live" are not the same set, and the difference is money.
 */
async function liveSubscription(
  client: Stripe,
  customerId: string,
): Promise<Stripe.Subscription | null> {
  const subs = await client.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  return subs.data.find((sub) => LIVE_STATUSES.has(sub.status)) ?? null;
}

/**
 * What the billing screen renders: the plan, what it costs, what has been used,
 * and — the part people actually come here for — how close they are to a limit.
 */
billingRouter.get(
  '/',
  requireAuth,
  async (req, res) => {
    const orgId = actorOf(req).orgId;
    const [state, usage] = await Promise.all([planFor(orgId), usageFor(orgId)]);

    res.json({
      plan: state.plan,
      status: state.status,
      paying: state.paying,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      currentPeriodEnd: state.currentPeriodEnd,
      limits: state.limits,
      usage,
      /** Absent Stripe config is a fact the UI needs, not an error to hide. */
      configured: Boolean(stripe()),
      catalogue: (['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as Plan[]).map((plan) => ({
        plan,
        ...PLAN_LIMITS[plan],
        purchasable: Boolean(priceIdFor(plan)),
      })),
    });
  },
);

/**
 * Buy, change, or leave a plan.
 *
 * OWNER-only: billing is the one surface where "an admin did it" is not good
 * enough — it moves money that belongs to whoever owns the account.
 *
 * One endpoint on purpose: the upgrade, downgrade and back-to-Free buttons all
 * land here because the first question is the same for all of them, and it is
 * the question this route used to skip — does this customer already have a live
 * subscription? Skipping it was the double-charge bug: a TEAM org clicking
 * BUSINESS got a SECOND subscription-mode Checkout Session, Stripe billed both
 * every month, and nothing here held a record of the first to cancel or refund.
 * A live subscription is therefore always MODIFIED in place; a Checkout Session
 * is only ever created for a customer with nothing live to modify.
 */
billingRouter.post(
  '/checkout',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const client = stripe();
    if (!client) throw badRequest('Billing is not configured on this instance.');

    const plan = String((req.body as { plan?: string }).plan ?? '') as Plan;
    if (!PLANS.includes(plan)) {
      throw badRequest(`${(plan as string) || 'That'} is not a plan.`);
    }
    if (plan === 'ENTERPRISE') {
      throw badRequest('Enterprise is priced per organisation — talk to us instead.');
    }

    const actor = actorOf(req);
    const orgId = actor.orgId;
    const [org, user, existing] = await Promise.all([
      unscoped(() =>
        prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      ),
      unscoped(() =>
        prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
      ),
      unscoped(() =>
        prisma.subscription.findUnique({ where: { orgId }, select: { stripeCustomerId: true } }),
      ),
    ]);
    if (!org) throw notFound('Organisation');

    const live = existing?.stripeCustomerId
      ? await liveSubscription(client, existing.stripeCustomerId)
      : null;

    if (plan === 'FREE') {
      if (!live) {
        throw badRequest('There is no paid subscription to cancel — nothing here is billing this org.');
      }
      if (live.cancel_at_period_end) {
        throw badRequest('This subscription is already set to end at the period end.');
      }

      /*
       * Cancel at the period end, never delete: the customer paid for the
       * month, so the plan runs to the day they paid through and not a day
       * less. The actual drop to FREE arrives as `customer.subscription.deleted`
       * when Stripe ends it, and applySubscription handles it like any other
       * state change.
       */
      await client.subscriptions.update(live.id, { cancel_at_period_end: true });

      const from = planForPrice(live.items.data[0]?.price?.id);
      const overLimit = await overLimitFor(orgId, 'FREE');
      const periodEnd = live.items.data[0]?.current_period_end;
      await audit({
        actor,
        action: 'billing.plan.change',
        targetType: 'subscription',
        targetId: orgId,
        metadata: { from, to: 'FREE', cancelAtPeriodEnd: true, overLimit },
      });

      res.json({
        changed: true,
        plan: from,
        to: 'FREE',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        overLimit,
      });
      return;
    }

    const priceId = priceIdFor(plan);
    if (!priceId) {
      throw badRequest(`${plan} has no Stripe price configured on this instance.`);
    }

    if (live) {
      const item = live.items.data[0];
      if (!item) {
        // A subscription with no items cannot be repriced from here, and
        // guessing would risk the exact double billing this branch prevents.
        throw badRequest('This subscription has no items to reprice — manage it in the billing portal.');
      }
      const from = planForPrice(item.price?.id);

      if (item.price?.id === priceId) {
        if (live.cancel_at_period_end) {
          // Choosing the plan they are already leaving is a change of heart:
          // withdraw the scheduled cancellation instead of refusing.
          await client.subscriptions.update(live.id, { cancel_at_period_end: false });
          await audit({
            actor,
            action: 'billing.plan.change',
            targetType: 'subscription',
            targetId: orgId,
            metadata: { from: plan, to: plan, resumed: true },
          });
          res.json({ changed: true, plan, resumed: true, overLimit: [] });
          return;
        }
        throw badRequest(`This org is already on ${PLAN_LIMITS[plan].label}.`);
      }

      /*
       * The double-charge fix: MODIFY the live subscription instead of selling
       * a second one. `create_prorations` bills the difference for the rest of
       * the period on an upgrade and credits it on a downgrade, so nobody pays
       * twice for the same month. `cancel_at_period_end: false` because picking
       * a paid plan while a cancellation is scheduled means the cancellation is
       * off. The metadata re-stamp is defensive: the webhook resolves the org
       * through it, and this must hold even for a subscription that predates
       * checkout writing it.
       */
      await client.subscriptions.update(live.id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false,
        metadata: { orgId },
      });

      /*
       * The reverse limit check (§9). A downgrade deletes nothing — the excess
       * projects stay readable, the run history stays visible — because the
       * customer paid for the tier that produced them. What it does is say out
       * loud what the lower ceilings now refuse to add to, here and in the
       * audit row, instead of the customer discovering it at the next create.
       */
      const overLimit = await overLimitFor(orgId, plan);

      await audit({
        actor,
        action: 'billing.plan.change',
        targetType: 'subscription',
        targetId: orgId,
        metadata: { from, to: plan, proration: 'create_prorations', overLimit },
      });

      // The local rows are deliberately NOT written here: only the webhook
      // moves an org between plans (see the header), and Stripe emits
      // `customer.subscription.updated` for the change we just made.
      res.json({ changed: true, plan, overLimit });
      return;
    }

    // Reuse the Stripe customer across purchases, so a team that subscribes,
    // cancels and subscribes again has one customer with one payment-method
    // list and one invoice history.
    let customerId = existing?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await client.customers.create({
        name: org.name,
        email: user?.email,
        // The org id travels on the customer as well as the session: webhooks
        // for later events (renewals, cancellations) carry the customer but not
        // the original session's metadata.
        metadata: { orgId },
      });
      customerId = customer.id;
      await unscoped(() =>
        prisma.subscription.upsert({
          where: { orgId },
          create: { orgId, stripeCustomerId: customerId, plan: 'FREE', status: 'incomplete' },
          update: { stripeCustomerId: customerId },
        }),
      );
    }

    const web = env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    const session = await client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // `pending=1` tells the billing screen to poll for the webhook rather
      // than declare victory on the redirect alone.
      success_url: `${web}/settings/billing?pending=1`,
      cancel_url: `${web}/settings/billing`,
      subscription_data: { metadata: { orgId } },
      metadata: { orgId, plan },
      allow_promotion_codes: true,
    });

    await audit({
      actor: actorOf(req),
      action: 'billing.checkout.start',
      targetType: 'subscription',
      targetId: orgId,
      metadata: { plan },
    });

    res.json({ url: session.url });
  },
);

/**
 * The customer portal — Stripe's own UI for cards, invoices and cancellation.
 *
 * Deliberately not rebuilt here. Card capture, dunning, tax receipts and
 * proration are a compliance surface, and the correct amount of it to reimplement
 * in a QA product is none.
 */
billingRouter.post(
  '/portal',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const client = stripe();
    if (!client) throw badRequest('Billing is not configured on this instance.');

    const orgId = actorOf(req).orgId;
    const subscription = await unscoped(() =>
      prisma.subscription.findUnique({ where: { orgId }, select: { stripeCustomerId: true } }),
    );
    if (!subscription?.stripeCustomerId) {
      throw badRequest('There is nothing to manage yet — this org has never subscribed.');
    }

    const session = await client.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${env.WEB_PUBLIC_URL ?? 'http://localhost:3000'}/settings/billing`,
    });

    res.json({ url: session.url });
  },
);

/**
 * Apply a Stripe subscription object to the local row.
 *
 * Shared by every subscription event because they all mean the same thing:
 * "here is the current state, make yours match". Writing it once avoids the
 * classic bug where `created` and `updated` drift and a plan change silently
 * does not take effect.
 *
 * `eventCreated` is the Stripe event's own clock, and it is the ordering
 * guard: Stripe does not promise delivery order, so an `updated` from before a
 * cancellation can arrive after it, and "make yours match" must not mean
 * "resurrect the plan the newer event already ended". State older than what is
 * already applied is refused, with a log saying why.
 */
async function applySubscription(sub: Stripe.Subscription, eventCreated: Date): Promise<void> {
  const orgId =
    sub.metadata?.orgId ??
    (typeof sub.customer === 'object' && sub.customer && !('deleted' in sub.customer)
      ? sub.customer.metadata?.orgId
      : undefined);

  if (!orgId) {
    logger.error({ subscriptionId: sub.id }, 'subscription event with no orgId; ignoring');
    return;
  }

  const priceId = sub.items.data[0]?.price?.id;
  const mapped = planForPrice(priceId);

  /*
   * The ordering guard. Strictly greater, not >=: `event.created` has second
   * resolution, so two honest events in the same second are unordered, and
   * last-write-wins there loses nothing that ordering could have saved —
   * whereas skipping an equal timestamp would drop a real change.
   */
  const existing = await unscoped(() =>
    prisma.subscription.findUnique({ where: { orgId }, select: { planSyncedAt: true } }),
  );
  if (existing?.planSyncedAt && existing.planSyncedAt.getTime() > eventCreated.getTime()) {
    logger.info(
      {
        orgId,
        subscriptionId: sub.id,
        eventCreated,
        appliedAt: existing.planSyncedAt,
      },
      'stale subscription event ignored: newer state was already applied',
    );
    return;
  }

  // A cancelled subscription drops to FREE rather than being deleted: the row
  // holds the Stripe customer id, and losing it would orphan the invoice
  // history the next time they subscribe.
  const cancelled = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  const periodEnd = sub.items.data[0]?.current_period_end;

  /*
   * A price this deployment cannot name used to be an early return here, and
   * the early return was the cancelled-plan bug: `customer.subscription.deleted`
   * for a price missing from the env left the org on its paid plan forever,
   * with nobody billing for it and nothing recording why. Unknown-price state
   * now applies as FREE — the one plan that is always safe to grant — and the
   * log stays loud, because what produces this in production is rotated
   * STRIPE_PRICE_* env vars: an operator mistake to fix, not a customer to
   * strand on a plan nobody is paying for.
   */
  if (!mapped && !cancelled) {
    logger.error(
      { subscriptionId: sub.id, priceId },
      'subscription for an unknown price; applying FREE rather than leaving the plan unaccounted for',
    );
  }
  const plan: Plan = cancelled || !mapped ? 'FREE' : mapped;

  // What the org is on NOW decides whether this event is a transition worth an
  // audit row — most deliveries are renewals restating the same plan, and a
  // log recording "TEAM stayed TEAM" every month forever is noise.
  const orgBefore = await unscoped(() =>
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  );

  await unscoped(() =>
    prisma.subscription.upsert({
      where: { orgId },
      create: {
        orgId,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        plan,
        status: sub.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        planSyncedAt: eventCreated,
      },
      update: {
        stripeSubscriptionId: sub.id,
        plan,
        status: sub.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        planSyncedAt: eventCreated,
      },
    }),
  );

  // Organization.plan is denormalised for the hot path; keep it honest. A
  // cancellation also ends dunning: the org is FREE now, not past due, and a
  // PAST_DUE flag surviving the subscription it described would be a stale
  // warning nobody can clear.
  await unscoped(() =>
    prisma.organization.update({
      where: { id: orgId },
      data: {
        plan,
        // Stamped with the event's clock so a stale invoice event from the
        // subscription's lifetime cannot re-mark the org after cancellation.
        ...(cancelled ? { billingState: 'OK' as const, billingStateAt: eventCreated } : {}),
      },
    }),
  );

  /*
   * The transition audit row, written only when the plan label actually moved.
   * This is the record requirement for the money state: every plan an org
   * gains or loses leaves a row, whoever caused it — an OWNER in the checkout
   * route (which audits its own intent as `billing.plan.change`), Stripe
   * ending a cancelled subscription, or an operator's rotated price id. On a
   * drop, the row also carries what is now over the lower plan's ceilings —
   * nothing is deleted, but the refusals the forward checks are about to start
   * issuing should be explainable from the log.
   */
  if (orgBefore && orgBefore.plan !== plan) {
    const dropped = PLANS.indexOf(plan) < PLANS.indexOf(orgBefore.plan);
    const overLimit = dropped ? await overLimitFor(orgId, plan) : [];
    await audit({
      actor: { userId: '', orgId, ip: null, impersonatedBy: null },
      action: 'billing.plan.applied',
      targetType: 'subscription',
      targetId: orgId,
      metadata: {
        from: orgBefore.plan,
        to: plan,
        status: sub.status,
        priceId: priceId ?? null,
        overLimit,
        ...(mapped || cancelled ? {} : { reason: 'unknown_price' }),
      },
    });
  }

  logger.info({ orgId, plan, status: sub.status }, 'subscription applied');
}

/**
 * Which org a Stripe invoice belongs to. Invoices carry the customer, not our
 * metadata, so this goes through the customer id stored at checkout time.
 */
async function orgForInvoice(invoice: Stripe.Invoice): Promise<string | null> {
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null);
  if (!customerId) return null;

  const subscription = await unscoped(() =>
    prisma.subscription.findUnique({
      where: { stripeCustomerId: customerId },
      select: { orgId: true },
    }),
  );
  return subscription?.orgId ?? null;
}

/**
 * Dunning (§9): a charge failed.
 *
 * Deliberately RECORD-AND-NOTIFY ONLY. Nothing reads `billingState` to gate a
 * feature — whether a past-due org keeps its paid limits is a policy decision
 * (lib/plan.ts already meters a subscription Stripe marks `past_due` at FREE
 * limits, off Stripe's own status), and a webhook handler must not make that
 * decision as a side effect. This marks the org, tells the people who can fix
 * it, and writes the audit row; enforcement, if it ever comes, is a separate
 * deliberate change.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice, eventCreated: Date): Promise<void> {
  const orgId = await orgForInvoice(invoice);
  if (!orgId) {
    // A customer we never recorded — most likely an invoice from a different
    // product sharing the Stripe account. Not ours to dun.
    logger.warn({ invoiceId: invoice.id }, 'payment_failed for an unknown Stripe customer');
    return;
  }

  const org = await unscoped(() =>
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true, billingState: true, billingStateAt: true },
    }),
  );
  if (!org) {
    logger.error({ orgId, invoiceId: invoice.id }, 'payment_failed for a deleted organisation');
    return;
  }

  /*
   * The same ordering guard applySubscription has, for the same reason: Stripe
   * does not promise delivery order. Without this, an invoice.payment_failed
   * arriving AFTER the invoice.paid that superseded it marked a healthy org
   * PAST_DUE and mailed every OWNER a false alarm — wrong until the next
   * renewal, up to a month later. Strictly greater, matching applySubscription.
   */
  if (org.billingStateAt && org.billingStateAt.getTime() > eventCreated.getTime()) {
    logger.info(
      { orgId, invoiceId: invoice.id, eventCreated, appliedAt: org.billingStateAt },
      'stale payment_failed refused; a newer invoice event was already applied',
    );
    return;
  }

  await unscoped(() =>
    prisma.organization.update({
      where: { id: orgId },
      data: { billingState: 'PAST_DUE', billingStateAt: eventCreated },
    }),
  );

  await audit({
    actor: { userId: '', orgId, ip: null, impersonatedBy: null },
    action: 'billing.payment.failed',
    targetType: 'subscription',
    targetId: orgId,
    metadata: { invoiceId: invoice.id ?? null, previousState: org.billingState },
  });

  /*
   * Every OWNER, not one: billing above is OWNER-only, so anyone else who got
   * this mail could read it but not fix it. One message per failed ATTEMPT is
   * intended — Stripe's retries are days apart, and a card still broken a week
   * later deserves a second nudge.
   *
   * Mail is best-effort, like audit: the PAST_DUE mark and the audit row are
   * the durable record, and a down SMTP server must not turn into a webhook
   * 500 and a Stripe retry storm.
   */
  const owners = await unscoped(() =>
    prisma.membership.findMany({
      where: { orgId, role: 'OWNER' },
      select: { user: { select: { email: true } } },
    }),
  );
  const billingUrl = `${env.WEB_PUBLIC_URL ?? 'http://localhost:3000'}/settings/billing`;
  for (const owner of owners) {
    const to = owner.user?.email;
    if (!to) continue;
    try {
      await sendMail(paymentFailedMail(to, org.name, billingUrl));
    } catch (err) {
      logger.error({ err, orgId, to }, 'failed to send a dunning email');
    }
  }

  logger.warn({ orgId, invoiceId: invoice.id }, 'invoice payment failed; org marked PAST_DUE');
}

/** Dunning, the way out: an invoice paid clears PAST_DUE. */
async function handleInvoicePaid(invoice: Stripe.Invoice, eventCreated: Date): Promise<void> {
  const orgId = await orgForInvoice(invoice);
  if (!orgId) return; // Not a customer of ours — same reasoning as above.

  const org = await unscoped(() =>
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { billingState: true, billingStateAt: true },
    }),
  );
  if (!org) return;

  if (org.billingStateAt && org.billingStateAt.getTime() > eventCreated.getTime()) {
    // Stale — a newer invoice event already spoke. Same guard as the failure
    // side; skipping it only there would let old paids clear new failures.
    return;
  }

  if (org.billingState !== 'PAST_DUE') {
    /*
     * A healthy renewal. No state change and no audit row — but the timestamp
     * IS recorded, because it is what refuses the out-of-order payment_failed
     * above. Skip it and a paid-then-stale-failure sequence on a healthy org
     * would still raise the false alarm the guard exists to prevent.
     */
    await unscoped(() =>
      prisma.organization.update({
        where: { id: orgId },
        data: { billingStateAt: eventCreated },
      }),
    );
    return;
  }

  await unscoped(() =>
    prisma.organization.update({
      where: { id: orgId },
      data: { billingState: 'OK', billingStateAt: eventCreated },
    }),
  );

  await audit({
    actor: { userId: '', orgId, ip: null, impersonatedBy: null },
    action: 'billing.payment.recovered',
    targetType: 'subscription',
    targetId: orgId,
    metadata: { invoiceId: invoice.id ?? null },
  });

  logger.info({ orgId, invoiceId: invoice.id }, 'invoice paid; PAST_DUE cleared');
}

/**
 * The Stripe webhook.
 *
 * Mounted on the `/webhooks` prefix, which is parsed with `express.raw()` ahead
 * of the JSON body parser — signature verification is over the exact bytes
 * Stripe signed, and a re-serialised JSON body will not match.
 *
 * An unverified body is refused outright. This endpoint is the only thing that
 * can grant a paid plan, so forging it is worth real money to an attacker.
 */
export function registerStripeWebhook(router: Router): void {
  router.post(
    '/stripe',
    async (req, res) => {
      const client = stripe();
      const secret = env.STRIPE_WEBHOOK_SECRET;
      if (!client || !secret) {
        res.status(503).json({ error: 'Billing is not configured' });
        return;
      }

      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        res.status(400).json({ error: 'Missing signature' });
        return;
      }

      let event: Stripe.Event;
      try {
        // `req.body` is a Buffer here thanks to the raw parser on this prefix.
        event = client.webhooks.constructEvent(req.body as Buffer, signature, secret);
      } catch (err) {
        // Never echo the reason: it tells a forger how close they got.
        logger.warn({ err }, 'rejected a Stripe webhook with a bad signature');
        res.status(400).json({ error: 'Invalid signature' });
        return;
      }

      /*
       * The redelivery guard. Stripe redelivers events — on timeouts, on any
       * non-2xx, and occasionally even after a 2xx — and an event that moves
       * money state must run its side effects (plan changes, dunning emails,
       * audit rows) exactly once.
       *
       * CLAIM-FIRST: the insert is the lock. The previous shape checked before
       * handling and recorded after, which left a window where two concurrent
       * deliveries of one event both passed the check and both ran the
       * handlers — the plan writes are idempotent, but every OWNER got the
       * dunning email twice. Here exactly one delivery wins the unique id;
       * the loser sees P2002 and stops.
       *
       * A handler that throws releases the claim in the catch below, so the
       * 500 makes Stripe redeliver and the retry starts clean. The residual
       * window is a process death between claim and release — rarer than
       * concurrent redelivery, and Stripe's dashboard still shows the event
       * as failed for a manual resend.
       *
       * The read first is the fast path, not the guard: Stripe routinely
       * redelivers even after a 2xx, and answering those from an index lookup
       * beats taking a unique-violation exception every time. Correctness
       * never rests on it — two deliveries racing past this read are settled
       * by the insert below.
       */
      const alreadySeen = await unscoped(() =>
        prisma.stripeEventSeen.findUnique({ where: { id: event.id }, select: { id: true } }),
      );
      if (alreadySeen) {
        logger.debug(
          { eventId: event.id, type: event.type },
          'stripe event already handled; skipping the redelivery',
        );
        res.json({ received: true, duplicate: true });
        return;
      }

      try {
        await unscoped(() =>
          prisma.stripeEventSeen.create({ data: { id: event.id, type: event.type } }),
        );
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        logger.debug(
          { eventId: event.id, type: event.type },
          'stripe event already claimed; skipping the redelivery',
        );
        res.json({ received: true, duplicate: true });
        return;
      }

      // The event's own clock, in seconds — the one timestamp that lets every
      // handler refuse out-of-order deliveries against a single (Stripe's)
      // clock rather than mixing in ours.
      const eventCreated = new Date(event.created * 1000);

      try {
        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
            await applySubscription(event.data.object, eventCreated);
            break;

          case 'checkout.session.completed': {
            // The session carries only an id for the subscription; fetch it so
            // the same apply path runs, rather than half-writing state from the
            // session. The retrieve returns state at least as fresh as this
            // event, so stamping the event's own time errs stale-ward — it can
            // never claim to be newer than a subscription event it did not see.
            const session = event.data.object;
            const subId =
              typeof session.subscription === 'string'
                ? session.subscription
                : session.subscription?.id;
            if (subId) {
              await applySubscription(await client.subscriptions.retrieve(subId), eventCreated);
            }
            break;
          }

          case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object, eventCreated);
            break;

          case 'invoice.paid':
            await handleInvoicePaid(event.data.object, eventCreated);
            break;

          default:
            break;
        }
      } catch (err) {
        /*
         * Release the claim so Stripe's redelivery retries clean. If THIS
         * delete fails too, the event is stuck claimed-but-unfinished — logged
         * at error with the id, because the fix is a manual resend from the
         * Stripe dashboard after deleting the row.
         */
        await unscoped(() =>
          prisma.stripeEventSeen.delete({ where: { id: event.id } }),
        ).catch((releaseErr) =>
          logger.error(
            { releaseErr, eventId: event.id, type: event.type },
            'handler failed AND the claim could not be released — delete this StripeEventSeen row and resend the event from Stripe',
          ),
        );
        throw err;
      }

      // 200 as soon as it is handled — Stripe retries anything else, and a
      // retry storm over a downstream hiccup is worse than a missed log line.
      res.json({ received: true });
    },
  );
}
