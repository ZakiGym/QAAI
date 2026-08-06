-- Outbound delivery lifecycle (§7). notify.ts now retries failed sends through
-- the queue, so a row needs a state machine: PENDING while retries remain, SENT
-- on the 2xx that landed, FAILED once the last attempt is spent. The FAILED row
-- is the dead-letter — there is no separate store.
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

ALTER TABLE "WebhookDelivery" ADD COLUMN "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING';

-- Existing rows were written by the single-attempt path, so their outcome is
-- already decided: deliveredAt set means the POST landed, anything else spent
-- its one and only attempt. Leaving them PENDING would show every historical
-- delivery as still in flight.
UPDATE "WebhookDelivery"
SET "status" = CASE WHEN "deliveredAt" IS NOT NULL THEN 'SENT' ELSE 'FAILED' END::"WebhookDeliveryStatus";
