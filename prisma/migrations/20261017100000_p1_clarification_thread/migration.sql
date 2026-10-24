-- Re-runnable (IF NOT EXISTS guards + back-fill only touches rows without messages), so it can also be applied by hand with psql when the DB was created via `prisma db push`.
-- Phase 1: real clarification conversation (additive only - nothing is dropped or rewritten).
-- Requires PostgreSQL 13+ for gen_random_uuid() (Railway Postgres is 14+).

-- 1) Message table
CREATE TABLE IF NOT EXISTS "review_clarification_messages" (
    "id" TEXT NOT NULL,
    "clarificationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_clarification_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "rcm_clarificationId_clientRequestId_key" ON "review_clarification_messages"("clarificationId", "clientRequestId");
CREATE INDEX IF NOT EXISTS "rcm_clarificationId_createdAt_idx" ON "review_clarification_messages"("clarificationId", "createdAt");

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_clarification_messages_clarificationId_fkey') THEN
ALTER TABLE "review_clarification_messages" ADD CONSTRAINT "review_clarification_messages_clarificationId_fkey"
    FOREIGN KEY ("clarificationId") REFERENCES "review_clarifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- 2) Attachments can point at the message they were sent with
ALTER TABLE "clarification_attachments" ADD COLUMN IF NOT EXISTS "messageId" TEXT;
CREATE INDEX IF NOT EXISTS "clarification_attachments_messageId_idx" ON "clarification_attachments"("messageId");
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarification_attachments_messageId_fkey') THEN
ALTER TABLE "clarification_attachments" ADD CONSTRAINT "clarification_attachments_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "review_clarification_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- 3) Back-fill existing clarifications into the thread (idempotent: only rows with no messages yet)
-- 3a) the reviewer's original request
INSERT INTO "review_clarification_messages" ("id", "clarificationId", "senderId", "senderRole", "body", "createdAt")
SELECT gen_random_uuid()::text, c."id", c."requestedById", 'REVIEWER', c."requestMessage", c."createdAt"
FROM "review_clarifications" c
WHERE NOT EXISTS (SELECT 1 FROM "review_clarification_messages" m WHERE m."clarificationId" = c."id");

-- 3b) the subject's (single) response, attributed to the profile owner
INSERT INTO "review_clarification_messages" ("id", "clarificationId", "senderId", "senderRole", "body", "createdAt")
SELECT gen_random_uuid()::text, c."id",
       COALESCE(
         CASE c."subjectType"
           WHEN 'USER_KYC' THEN c."subjectId"
           WHEN 'WAREHOUSE_PROFILE' THEN (SELECT w."userId" FROM "warehouse_profiles" w WHERE w."id" = c."subjectId")
           WHEN 'TESTING_AGENCY_PROFILE' THEN (SELECT t."userId" FROM "testing_agency_profiles" t WHERE t."id" = c."subjectId")
           WHEN 'TRANSPORT_PROFILE' THEN (SELECT p."userId" FROM "transport_profiles" p WHERE p."id" = c."subjectId")
         END,
         c."subjectId"),
       'SUBJECT', c."responseMessage", COALESCE(c."respondedAt", c."createdAt" + interval '1 second')
FROM "review_clarifications" c
WHERE c."responseMessage" IS NOT NULL
  AND (SELECT COUNT(*) FROM "review_clarification_messages" m WHERE m."clarificationId" = c."id") = 1;

-- 3c) existing attachments were all sent with the response
UPDATE "clarification_attachments" a
SET "messageId" = (
  SELECT m."id" FROM "review_clarification_messages" m
  WHERE m."clarificationId" = a."clarificationId" AND m."senderRole" = 'SUBJECT'
  ORDER BY m."createdAt" DESC LIMIT 1)
WHERE a."messageId" IS NULL;
