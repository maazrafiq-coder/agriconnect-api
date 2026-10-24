-- Phase 4: brief section 10 gaps for transport (richer request, quote details + payment terms,
-- confirmed transport ORDER reference TRO-, agreed-terms snapshot, delivery evidence) and a human
-- reference (TST-) + idempotency key for lab-testing requests.
-- Additive and re-runnable; also fine after `db push`. Requires PostgreSQL 13+.

-- 1) transport_requests
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "deliveryDeadline" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "commodity" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "cargoType" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "specialHandling" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "contactName" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "orderSeq" INTEGER;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "orderNumber" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "orderConfirmedAt" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "paymentTermsSnapshot" JSONB;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "agreedCharges" JSONB;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "agreedConditions" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "agreedPickupAt" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "termsAcceptedById" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "deliveryReceiverName" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "deliveryNote" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "deliveredQuantityTons" DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_orderSeq_key" ON "transport_requests"("orderSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_orderNumber_key" ON "transport_requests"("orderNumber");

-- the transport ORDER number is drawn from its own sequence when a quote is accepted (race-safe)
CREATE SEQUENCE IF NOT EXISTS transport_order_seq;
-- back-fill an order number for shipments that were already booked (oldest first); re-run safe
WITH todo AS (
  SELECT "id", "createdAt" FROM "transport_requests"
   WHERE "agreedPrice" IS NOT NULL AND "orderNumber" IS NULL ORDER BY "createdAt", "id"
), numbered AS (
  SELECT "id", "createdAt", nextval('transport_order_seq')::int AS n FROM todo
)
UPDATE "transport_requests" r
   SET "orderSeq" = numbered.n,
       "orderNumber" = 'TRO-' || to_char(numbered."createdAt", 'YYYY') || '-' || lpad(numbered.n::text, 6, '0'),
       "orderConfirmedAt" = COALESCE(r."quotedAt", r."createdAt")
  FROM numbered WHERE r."id" = numbered."id";

-- agreed terms are immutable once set (like agreedPrice)
CREATE OR REPLACE FUNCTION transport_agreed_terms_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."paymentTermsSnapshot" IS NOT NULL AND NEW."paymentTermsSnapshot" IS DISTINCT FROM OLD."paymentTermsSnapshot" THEN
    RAISE EXCEPTION 'transport_requests.paymentTermsSnapshot is immutable once set (request %)', OLD."id";
  END IF;
  IF OLD."orderNumber" IS NOT NULL AND NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" THEN
    RAISE EXCEPTION 'transport_requests.orderNumber is immutable once set (request %)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transport_agreed_terms_immutable_trg ON "transport_requests";
CREATE TRIGGER transport_agreed_terms_immutable_trg BEFORE UPDATE ON "transport_requests"
  FOR EACH ROW EXECUTE FUNCTION transport_agreed_terms_immutable();

-- 2) transport_quote_rounds: total, charges, dates, vehicle, terms, conditions
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "additionalCharges" JSONB;
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "totalPrice" DECIMAL(14,2);
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "estimatedPickup" TIMESTAMP(3);
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "vehicleDetails" TEXT;
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "paymentTerms" JSONB;
ALTER TABLE "transport_quote_rounds" ADD COLUMN IF NOT EXISTS "conditions" TEXT;
UPDATE "transport_quote_rounds" SET "totalPrice" = "price" WHERE "totalPrice" IS NULL;
ALTER TABLE "transport_quote_rounds" ALTER COLUMN "totalPrice" SET NOT NULL;

-- 3) transport_invoices: due date follows the agreed terms (nullable while open-ended)
ALTER TABLE "transport_invoices" ADD COLUMN IF NOT EXISTS "orderNumber" TEXT;
ALTER TABLE "transport_invoices" ADD COLUMN IF NOT EXISTS "paymentTermsSnapshot" JSONB;
ALTER TABLE "transport_invoices" ALTER COLUMN "dueDate" DROP NOT NULL;
UPDATE "transport_invoices" i SET "orderNumber" = r."orderNumber"
  FROM "transport_requests" r WHERE r."id" = i."requestId" AND i."orderNumber" IS NULL;

-- 4) testing_requests: TST- reference + idempotency key
ALTER TABLE "testing_requests" ADD COLUMN IF NOT EXISTS "requestSeq" SERIAL;
ALTER TABLE "testing_requests" ADD COLUMN IF NOT EXISTS "requestNumber" TEXT;
ALTER TABLE "testing_requests" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;
UPDATE "testing_requests"
   SET "requestNumber" = 'TST-' || to_char("createdAt", 'YYYY') || '-' || lpad("requestSeq"::text, 6, '0')
 WHERE "requestNumber" IS NULL;
ALTER TABLE "testing_requests" ALTER COLUMN "requestNumber" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "testing_requests_requestSeq_key" ON "testing_requests"("requestSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "testing_requests_requestNumber_key" ON "testing_requests"("requestNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "testing_requests_requesterId_clientRequestId_key" ON "testing_requests"("requesterId","clientRequestId");
