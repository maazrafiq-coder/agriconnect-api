-- Phase 2: negotiation rounds, payment terms, seller invoices.
-- Additive and re-runnable (IF NOT EXISTS guards, ON CONFLICT DO NOTHING, deterministic back-fill ids),
-- so it can also be applied by hand with psql when the DB was created via `prisma db push`.
-- Requires PostgreSQL 13+.

-- 1) Enums
DO $$ BEGIN CREATE TYPE "OfferRoundStatus" AS ENUM ('CURRENT','SUPERSEDED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SellerInvoiceStatus" AS ENUM ('ISSUED','PAYMENT_SUBMITTED','PAYMENT_CONFIRMED','VOID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) New columns on existing tables
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "paymentTerms" JSONB;
ALTER TABLE "offers"   ADD COLUMN IF NOT EXISTS "currentRoundId" TEXT;
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "unitPrice" DECIMAL(14,2);
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "quantity" DOUBLE PRECISION;
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "paymentTermsSnapshot" JSONB;
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "termsAcceptedById" TEXT;
ALTER TABLE "orders"   ADD COLUMN IF NOT EXISTS "acceptedRoundId" TEXT;

-- 3) offer_rounds
CREATE TABLE IF NOT EXISTS "offer_rounds" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "proposerId" TEXT NOT NULL,
    "proposerRole" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "paymentTerms" JSONB,
    "message" TEXT,
    "status" "OfferRoundStatus" NOT NULL DEFAULT 'CURRENT',
    "supersededById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "respondedById" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "offer_rounds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "offer_rounds_offerId_roundNo_key" ON "offer_rounds"("offerId","roundNo");
CREATE UNIQUE INDEX IF NOT EXISTS "offer_rounds_offerId_clientRequestId_key" ON "offer_rounds"("offerId","clientRequestId");
CREATE INDEX IF NOT EXISTS "offer_rounds_offerId_status_idx" ON "offer_rounds"("offerId","status");
-- one CURRENT round per offer (Prisma cannot express partial indexes)
CREATE UNIQUE INDEX IF NOT EXISTS "offer_rounds_one_current_per_offer" ON "offer_rounds"("offerId") WHERE "status" = 'CURRENT';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offer_rounds_offerId_fkey') THEN
ALTER TABLE "offer_rounds" ADD CONSTRAINT "offer_rounds_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- 4) seller_invoices
CREATE TABLE IF NOT EXISTS "seller_invoices" (
    "id" TEXT NOT NULL,
    "invoiceSeq" SERIAL NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" "SellerInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "orderAmount" DECIMAL(16,2) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "platformFeePct" DECIMAL(5,2) NOT NULL,
    "platformFee" DECIMAL(14,2) NOT NULL,
    "sellerNet" DECIMAL(14,2) NOT NULL,
    "paymentTermsSnapshot" JSONB,
    "schedule" JSONB NOT NULL,
    "dueDate" TIMESTAMP(3),
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
    CONSTRAINT "seller_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "seller_invoices_invoiceSeq_key" ON "seller_invoices"("invoiceSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "seller_invoices_invoiceNumber_key" ON "seller_invoices"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "seller_invoices_orderId_idx" ON "seller_invoices"("orderId");
CREATE INDEX IF NOT EXISTS "seller_invoices_sellerId_status_idx" ON "seller_invoices"("sellerId","status");
CREATE INDEX IF NOT EXISTS "seller_invoices_buyerId_status_idx" ON "seller_invoices"("buyerId","status");
-- at most one live (non-VOID) invoice per order
CREATE UNIQUE INDEX IF NOT EXISTS "seller_invoices_one_live_per_order" ON "seller_invoices"("orderId") WHERE "status" <> 'VOID';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_invoices_orderId_fkey') THEN
ALTER TABLE "seller_invoices" ADD CONSTRAINT "seller_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_invoices_sellerId_fkey') THEN
ALTER TABLE "seller_invoices" ADD CONSTRAINT "seller_invoices_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_invoices_buyerId_fkey') THEN
ALTER TABLE "seller_invoices" ADD CONSTRAINT "seller_invoices_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;

-- 5) Immutable order terms snapshot: once set it can never be changed or cleared.
CREATE OR REPLACE FUNCTION orders_terms_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."paymentTermsSnapshot" IS NOT NULL AND NEW."paymentTermsSnapshot" IS DISTINCT FROM OLD."paymentTermsSnapshot" THEN
    RAISE EXCEPTION 'orders.paymentTermsSnapshot is immutable once set (order %)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS orders_terms_snapshot_immutable_trg ON "orders";
CREATE TRIGGER orders_terms_snapshot_immutable_trg BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_terms_snapshot_immutable();

-- 6) Back-fill rounds from legacy offers (deterministic ids => safe to re-run).
--    round 1 = buyer's original offer; round 2 = seller's counter (if any).
--    Legacy offers carry no payment terms, so paymentTerms stays NULL on these rounds.
INSERT INTO "offer_rounds" ("id","offerId","roundNo","proposerId","proposerRole","price","quantity","paymentTerms","message","status","supersededById","expiresAt","respondedAt","createdAt")
SELECT md5(o."id" || ':r1')::uuid::text, o."id", 1, o."buyerId", 'BUYER', o."offeredPrice", o."quantity", NULL, o."message",
  (CASE
     WHEN o."counterPrice" IS NOT NULL THEN 'SUPERSEDED'
     WHEN o."status" = 'PENDING'   THEN 'CURRENT'
     WHEN o."status" = 'ACCEPTED'  THEN 'ACCEPTED'
     WHEN o."status" = 'REJECTED'  THEN 'DECLINED'
     WHEN o."status" = 'WITHDRAWN' THEN 'WITHDRAWN'
     WHEN o."status" = 'EXPIRED'   THEN 'EXPIRED'
     ELSE 'SUPERSEDED' END)::"OfferRoundStatus",
  CASE WHEN o."counterPrice" IS NOT NULL THEN md5(o."id" || ':r2')::uuid::text END,
  CASE WHEN o."status" = 'PENDING' AND o."counterPrice" IS NULL THEN o."expiresAt" END,
  CASE WHEN o."counterPrice" IS NOT NULL OR o."status" <> 'PENDING' THEN o."updatedAt" END,
  o."createdAt"
FROM "offers" o
ON CONFLICT DO NOTHING;

INSERT INTO "offer_rounds" ("id","offerId","roundNo","proposerId","proposerRole","price","quantity","paymentTerms","message","status","expiresAt","respondedAt","createdAt")
SELECT md5(o."id" || ':r2')::uuid::text, o."id", 2, p."sellerId", 'SELLER', o."counterPrice", o."quantity", NULL, o."counterMessage",
  (CASE
     WHEN o."status" = 'COUNTERED' THEN 'CURRENT'
     WHEN o."status" = 'ACCEPTED'  THEN 'ACCEPTED'
     WHEN o."status" = 'REJECTED'  THEN 'DECLINED'
     WHEN o."status" = 'WITHDRAWN' THEN 'WITHDRAWN'
     WHEN o."status" = 'EXPIRED'   THEN 'EXPIRED'
     ELSE 'SUPERSEDED' END)::"OfferRoundStatus",
  CASE WHEN o."status" = 'COUNTERED' THEN o."expiresAt" END,
  CASE WHEN o."status" <> 'COUNTERED' THEN o."updatedAt" END,
  o."updatedAt"
FROM "offers" o JOIN "products" p ON p."id" = o."productId"
WHERE o."counterPrice" IS NOT NULL
ON CONFLICT DO NOTHING;

-- an ACCEPTED offer with a counter: if the order total matches the ORIGINAL price the seller accepted the
-- original, so round 1 (not the counter) is the accepted one.
UPDATE "offer_rounds" r1 SET "status" = 'ACCEPTED'
FROM "offers" o JOIN "orders" ord ON ord."offerId" = o."id"
WHERE r1."offerId" = o."id" AND r1."roundNo" = 1 AND o."status" = 'ACCEPTED' AND o."counterPrice" IS NOT NULL
  AND abs(ord."totalAmount" - round((o."offeredPrice" * o."quantity")::numeric, 2)) < 0.01
  AND abs(ord."totalAmount" - round((o."counterPrice" * o."quantity")::numeric, 2)) >= 0.01
  AND r1."status" = 'SUPERSEDED';
UPDATE "offer_rounds" r2 SET "status" = 'DECLINED'
FROM "offers" o JOIN "orders" ord ON ord."offerId" = o."id"
WHERE r2."offerId" = o."id" AND r2."roundNo" = 2 AND o."status" = 'ACCEPTED'
  AND EXISTS (SELECT 1 FROM "offer_rounds" x WHERE x."offerId" = o."id" AND x."roundNo" = 1 AND x."status" = 'ACCEPTED')
  AND r2."status" = 'ACCEPTED';

UPDATE "offers" o SET "currentRoundId" = r."id"
FROM "offer_rounds" r
WHERE r."offerId" = o."id" AND o."currentRoundId" IS NULL
  AND r."roundNo" = (SELECT max(x."roundNo") FROM "offer_rounds" x WHERE x."offerId" = o."id");

-- 7) Back-fill what each existing order actually agreed (price/qty from the accepted round)
UPDATE "orders" ord SET
  "quantity" = r."quantity", "unitPrice" = r."price", "acceptedRoundId" = r."id"
FROM "offer_rounds" r
WHERE r."offerId" = ord."offerId" AND r."status" = 'ACCEPTED' AND ord."acceptedRoundId" IS NULL;
