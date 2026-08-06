-- The ordering guard for dunning state. Subscription events already refuse
-- out-of-order delivery via Subscription."planSyncedAt"; the invoice handlers
-- (payment_failed / paid) had no equivalent, so an invoice.payment_failed
-- delivered after the invoice.paid that superseded it wrongly marked a healthy
-- org PAST_DUE and mailed every OWNER a false dunning notice.
ALTER TABLE "Organization" ADD COLUMN "billingStateAt" TIMESTAMP(3);
