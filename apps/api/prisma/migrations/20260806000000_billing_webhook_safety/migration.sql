-- Billing webhook safety (§9) — idempotency, ordering, and dunning state.
--
-- Additive by construction: one enum, two columns with defaults, one new
-- table. No existing row changes meaning, and every code path that never
-- touches billing behaves exactly as it did before this migration.
--
--  * StripeEventSeen        — Stripe redelivers webhook events (on timeouts,
--                             on any non-2xx, occasionally after a 2xx), and
--                             this endpoint moves orgs between paid plans.
--                             Every event id is checked here before handling
--                             and recorded after. Same shape as
--                             SsoAssertionSeen, the other replay-guard table.
--  * Subscription.planSyncedAt — Stripe does not promise delivery order; this
--                             is the `event.created` of the last applied
--                             subscription state, so an older event cannot
--                             regress a newer plan. NULL on existing rows: the
--                             first event to arrive claims it.
--  * Organization.billingState — record-and-notify dunning. PAST_DUE is set by
--                             invoice.payment_failed and cleared by
--                             invoice.paid; nothing gates features on it.

-- CreateEnum
CREATE TYPE "BillingState" AS ENUM ('OK', 'PAST_DUE');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingState" "BillingState" NOT NULL DEFAULT 'OK';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "planSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StripeEventSeen" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEventSeen_pkey" PRIMARY KEY ("id")
);
