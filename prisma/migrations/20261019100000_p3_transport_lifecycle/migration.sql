-- Phase 3: transport lifecycle (quote rounds, request refs, transport invoices, driver details,
-- delivery acknowledgement, disputes).
-- Additive and re-runnable (IF NOT EXISTS guards, deterministic back-fill ids), so it can also be applied
-- by hand with psql when the DB was created via `prisma db push`. Requires PostgreSQL 13+.
--
-- NOTE: ALTER TYPE ... ADD VALUE is allowed inside a transaction on PG 12+, but the new values must not be
-- USED in the same transaction. Nothing below references 'COMPLETED' / 'DISPUTED' of TransportStatus.

-- 1) Enums
ALTER TYPE "TransportStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "TransportStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
DO $$ BEGIN CREATE TYPE "TransportQuoteStatus" AS ENUM ('CURRENT','SUPERSEDED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TransportInvoiceStatus" AS ENUM ('ISSUED','PAYMENT_SUBMITTED','PAYMENT_CONFIRMED','VOID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TransportDisputeCategory" AS ENUM ('DAMAGED_CARGO','SHORTAGE','LATE_DELIVERY','NOT_DELIVERED','PRICE_MISMATCH','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TransportDisputeStatus" AS ENUM ('OPEN','RESPONDED','RESOLVED','WITHDRAWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) New columns on transport_requests
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "requestSeq" SERIAL;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "requestNumber" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "vehicleRegNo" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "driverUpdatedAt" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "currentRoundId" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "agreedRoundId" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "acknowledgedById" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "acknowledgementNote" TEXT;
ALTER TABLE "transport_requests" ADD COLUMN IF NOT EXISTS "statusBeforeDispute" "TransportStatus";

-- back-fill the reference of existing requests (deterministic from seq + created year), then lock it down
UPDATE "transport_requests"
   SET "requestNumber" = 'TRQ-' || to_char("createdAt", 'YYYY') || '-' || lpad("requestSeq"::text, 6, '0')
 WHERE "requestNumber" IS NULL;
ALTER TABLE "transport_requests" ALTER COLUMN "requestNumber" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_requestSeq_key" ON "transport_requests"("requestSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_requestNumber_key" ON "transport_requests"("requestNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_requesterId_clientRequestId_key" ON "transport_requests"("requesterId","clientRequestId");

-- 3) transport_quote_rounds
CREATE TABLE IF NOT EXISTS "transport_quote_rounds" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "proposerId" TEXT NOT NULL,
    "proposerRole" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "estimatedArrival" TIMESTAMP(3),
    "message" TEXT,
    "status" "TransportQuoteStatus" NOT NULL DEFAULT 'CURRENT',
    "supersededById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "respondedById" TEXT,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transport_quote_rounds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "transport_quote_rounds_requestId_roundNo_key" ON "transport_quote_rounds"("requestId","roundNo");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_quote_rounds_requestId_clientRequestId_key" ON "transport_quote_rounds"("requestId","clientRequestId");
CREATE INDEX IF NOT EXISTS "transport_quote_rounds_requestId_status_idx" ON "transport_quote_rounds"("requestId","status");
-- one CURRENT round per request (Prisma cannot express partial indexes)
CREATE UNIQUE INDEX IF NOT EXISTS "transport_quote_rounds_one_current_per_request" ON "transport_quote_rounds"("requestId") WHERE "status" = 'CURRENT';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_quote_rounds_requestId_fkey') THEN
ALTER TABLE "transport_quote_rounds" ADD CONSTRAINT "transport_quote_rounds_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "transport_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- 4) transport_invoices
CREATE TABLE IF NOT EXISTS "transport_invoices" (
    "id" TEXT NOT NULL,
    "invoiceSeq" SERIAL NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "TransportInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(16,2) NOT NULL,
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "s3Key" TEXT,
    "paymentReference" TEXT,
    "paymentNote" TEXT,
    "paymentSubmittedAt" TIMESTAMP(3),
    "paymentSubmittedById" TEXT,
    "paymentConfirmedAt" TIMESTAMP(3),
    "paymentConfirmedById" TEXT,
    "paymentRejectedNote" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "replacesId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transport_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "transport_invoices_invoiceSeq_key" ON "transport_invoices"("invoiceSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_invoices_invoiceNumber_key" ON "transport_invoices"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "transport_invoices_requestId_idx" ON "transport_invoices"("requestId");
CREATE INDEX IF NOT EXISTS "transport_invoices_providerId_status_idx" ON "transport_invoices"("providerId","status");
CREATE INDEX IF NOT EXISTS "transport_invoices_requesterId_status_idx" ON "transport_invoices"("requesterId","status");
-- at most one live (non-VOID) invoice per shipment
CREATE UNIQUE INDEX IF NOT EXISTS "transport_invoices_one_live_per_request" ON "transport_invoices"("requestId") WHERE "status" <> 'VOID';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_invoices_requestId_fkey') THEN
ALTER TABLE "transport_invoices" ADD CONSTRAINT "transport_invoices_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "transport_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_invoices_providerId_fkey') THEN
ALTER TABLE "transport_invoices" ADD CONSTRAINT "transport_invoices_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_invoices_requesterId_fkey') THEN
ALTER TABLE "transport_invoices" ADD CONSTRAINT "transport_invoices_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;

-- 5) transport_disputes
CREATE TABLE IF NOT EXISTS "transport_disputes" (
    "id" TEXT NOT NULL,
    "disputeSeq" SERIAL NOT NULL,
    "disputeNumber" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "raisedById" TEXT NOT NULL,
    "raisedByRole" TEXT NOT NULL,
    "category" "TransportDisputeCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "claimAmount" DECIMAL(14,2),
    "status" "TransportDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "respondedById" TEXT,
    "resolutionOutcome" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transport_disputes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "transport_disputes_disputeSeq_key" ON "transport_disputes"("disputeSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_disputes_disputeNumber_key" ON "transport_disputes"("disputeNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "transport_disputes_requestId_clientRequestId_key" ON "transport_disputes"("requestId","clientRequestId");
CREATE INDEX IF NOT EXISTS "transport_disputes_requestId_status_idx" ON "transport_disputes"("requestId","status");
CREATE INDEX IF NOT EXISTS "transport_disputes_status_idx" ON "transport_disputes"("status");
-- at most one open dispute per shipment
CREATE UNIQUE INDEX IF NOT EXISTS "transport_disputes_one_open_per_request" ON "transport_disputes"("requestId") WHERE "status" IN ('OPEN','RESPONDED');
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_disputes_requestId_fkey') THEN
ALTER TABLE "transport_disputes" ADD CONSTRAINT "transport_disputes_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "transport_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_disputes_raisedById_fkey') THEN
ALTER TABLE "transport_disputes" ADD CONSTRAINT "transport_disputes_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;

-- 6) The agreed price is immutable once set (the service never changes it; this enforces it in the DB).
CREATE OR REPLACE FUNCTION transport_agreed_price_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."agreedPrice" IS NOT NULL AND NEW."agreedPrice" IS DISTINCT FROM OLD."agreedPrice" THEN
    RAISE EXCEPTION 'transport_requests.agreedPrice is immutable once set (request %)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transport_agreed_price_immutable_trg ON "transport_requests";
CREATE TRIGGER transport_agreed_price_immutable_trg BEFORE UPDATE ON "transport_requests"
  FOR EACH ROW EXECUTE FUNCTION transport_agreed_price_immutable();

-- 7) Back-fill quote rounds for requests that already have a quote (deterministic ids => safe to re-run).
--    Only live requests get a CURRENT round; historic BOOKED+ requests get an ACCEPTED round so the
--    price history is complete. Requests without a provider or without a quote get none.
INSERT INTO "transport_quote_rounds" ("id","requestId","providerId","roundNo","proposerId","proposerRole","price","estimatedArrival","message","status","respondedAt","createdAt")
SELECT md5(r."id" || ':q1')::uuid::text, r."id", r."providerId", 1, r."providerId", 'PROVIDER',
       COALESCE(r."agreedPrice", r."quotedPrice"), r."estimatedArrival", r."quoteNote",
       (CASE WHEN r."status"::text = 'QUOTED' THEN 'CURRENT'
             WHEN r."status"::text = 'CANCELLED' THEN 'WITHDRAWN'
             ELSE 'ACCEPTED' END)::"TransportQuoteStatus",
       CASE WHEN r."status"::text <> 'QUOTED' THEN r."updatedAt" END,
       COALESCE(r."quotedAt", r."createdAt")
FROM "transport_requests" r
WHERE r."providerId" IS NOT NULL AND COALESCE(r."agreedPrice", r."quotedPrice") IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "transport_requests" r SET "currentRoundId" = q."id"
FROM "transport_quote_rounds" q
WHERE q."requestId" = r."id" AND q."roundNo" = 1 AND r."currentRoundId" IS NULL AND q."status"::text = 'CURRENT';
UPDATE "transport_requests" r SET "agreedRoundId" = q."id"
FROM "transport_quote_rounds" q
WHERE q."requestId" = r."id" AND q."roundNo" = 1 AND r."agreedRoundId" IS NULL AND q."status"::text = 'ACCEPTED' AND r."agreedPrice" IS NOT NULL;
