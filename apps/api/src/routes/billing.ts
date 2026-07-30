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
import { PLAN_LIMITS, type Plan } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { planFor, usageFor } from '../lib/plan.js';
import { audit } from '../lib/audit.js';
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
 * Start a checkout.
 *
 * OWNER-only: billing is the one surface where "an admin did it" is not good
 * enough — it moves money that belongs to whoever owns the account.
 */
billingRouter.post(
  '/checkout',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const client = stripe();
    if (!client) throw badRequest('Billing is not configured on this instance.');

    const plan = String((req.body as { plan?: string }).plan ?? '') as Plan;
    const priceId = priceIdFor(plan);
    if (!priceId) {
      throw badRequest(
        plan === 'ENTERPRISE'
          ? 'Enterprise is priced per organisation — talk to us instead.'
          : `${plan || 'That plan'} cannot be bought online.`,
      );
    }

    const orgId = actorOf(req).orgId;
    const actor = actorOf(req);
    const [org, user] = await Promise.all([
      unscoped(() =>
        prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      ),
      unscoped(() =>
        prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
      ),
    ]);
    if (!org) throw notFound('Organisation');

    // Reuse the Stripe customer across purchases, so a team that upgrades twice
    // has one customer with one payment-method list and one invoice history.
    const existing = await unscoped(() =>
      prisma.subscription.findUnique({ where: { orgId }, select: { stripeCustomerId: true } }),
    );

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
 */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
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
  const plan = planForPrice(priceId);
  if (!plan) {
    logger.error({ subscriptionId: sub.id, priceId }, 'subscription for an unknown price');
    return;
  }

  // A cancelled subscription drops to FREE rather than being deleted: the row
  // holds the Stripe customer id, and losing it would orphan the invoice
  // history the next time they subscribe.
  const cancelled = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  const periodEnd = sub.items.data[0]?.current_period_end;

  await unscoped(() =>
    prisma.subscription.upsert({
      where: { orgId },
      create: {
        orgId,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        plan: cancelled ? 'FREE' : plan,
        status: sub.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
      update: {
        stripeSubscriptionId: sub.id,
        plan: cancelled ? 'FREE' : plan,
        status: sub.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
    }),
  );

  // Organization.plan is denormalised for the hot path; keep it honest.
  await unscoped(() =>
    prisma.organization.update({
      where: { id: orgId },
      data: { plan: cancelled ? 'FREE' : plan },
    }),
  );

  logger.info({ orgId, plan, status: sub.status }, 'subscription applied');
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

      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await applySubscription(event.data.object);
          break;

        case 'checkout.session.completed': {
          // The session carries only an id for the subscription; fetch it so the
          // same apply path runs, rather than half-writing state from the session.
          const session = event.data.object;
          const subId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id;
          if (subId) await applySubscription(await client.subscriptions.retrieve(subId));
          break;
        }

        case 'invoice.payment_failed': {
          // Stripe will retry on its own schedule; the status change arrives as
          // a subscription.updated. Logged so a human can see it happened.
          logger.warn({ eventId: event.id }, 'an invoice payment failed');
          break;
        }

        default:
          break;
      }

      // 200 as soon as it is handled — Stripe retries anything else, and a
      // retry storm over a downstream hiccup is worse than a missed log line.
      res.json({ received: true });
    },
  );
}
