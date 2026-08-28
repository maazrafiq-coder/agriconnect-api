# Round 2, Milestone 4 — Persistent file storage (Railway Storage Buckets)

## What changed

Every upload path (KYC documents, listing/product photos, clarification
attachments) now uploads directly to a Railway Storage Bucket (S3-compatible
object storage) instead of `multer.diskStorage()` on the container's local
disk. Local disk on Railway is ephemeral — every redeploy was silently
wiping out any files written there since Round 1, including approved KYC
documents.

**No Prisma schema changes in this checkpoint** — `s3Key` already existed on
every relevant model (`KycDocument`, `ClarificationAttachment`,
`ProductMedia`, `ListingMedia`) from earlier rounds, so there's no `db push`
required for Milestone 4 itself. (Milestones 2 and 3's pending migrations
still apply if you haven't run those yet — see `MIGRATION_NOTES_R2_M2.md` /
`_M3.md`.)

## Before deploying this checkpoint

### 1. Create the bucket

In the Railway dashboard, add a Storage Bucket to your project (or your own
S3-compatible provider, if you'd rather not use Railway's). Note down:
- Access key ID / secret access key
- Bucket name
- The S3-compatible endpoint URL for that bucket

### 2. Set these environment variables in Railway

```
AWS_ACCESS_KEY_ID=<from the bucket's connection details>
AWS_SECRET_ACCESS_KEY=<from the bucket's connection details>
AWS_REGION=auto
AWS_S3_BUCKET=<your bucket name>
AWS_S3_ENDPOINT=<your bucket's S3-compatible endpoint>
```

The app now **refuses to boot in production** (`NODE_ENV=production`)
without `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET` set
(see `src/config/env.validation.ts`) — this is deliberate, so a
misconfigured deploy fails loudly at startup instead of silently accepting
uploads it can't persist. They stay optional in development/test so the
existing sandbox test suite (which never touches a real bucket) keeps
working.

`UPLOAD_DEST` and `MAX_FILE_SIZE_MB` are no longer read by any code path —
harmless to leave in your `.env`, safe to remove.

### 3. Existing files on disk are effectively already gone

Because Railway's filesystem is ephemeral, in practice most files uploaded
before this checkpoint won't have survived to today's deploy regardless.
This checkpoint does **not** include a backfill/migration script to move
still-surviving on-disk files into the bucket — if any users still show a
broken image/document link for something uploaded before this milestone,
the practical fix is asking them to re-upload (KYC docs) or the seller to
re-add the photo (listings), since the original bytes are already gone
either way, not because of this change.

Rows created before this checkpoint keep displaying correctly via their old
`/uploads/...` URL for as long as the file happens to still be on disk —
`src/common/storage/media-url.util.ts` only generates a presigned bucket URL
for rows whose `s3Key` looks like a bucket key (contains a folder prefix,
e.g. `listings/listing-123.jpg`); a bare legacy filename with no prefix is
left untouched.

## What to verify after deploying

1. Submit a test KYC document as a new user → confirm it's viewable from the
   admin review screen (this proves upload + the signed-URL redirect flow
   both work end-to-end against the real bucket).
2. Upload a product/listing photo → confirm it displays on the listing
   page.
3. Redeploy the app once (any trivial change is fine) → confirm the photo
   from step 2 still displays. This is the actual regression this milestone
   fixes — worth explicitly checking rather than assuming.
4. Respond to a KYC clarification request with a file attachment → confirm
   both the requester and an admin can view it.

## Sandbox limitation note (same as Milestones 2 & 3)

This sandbox has no network access to a real bucket any more than it does
to Prisma's engine-binary CDN, so none of the above could be verified
against a real Railway Storage Bucket here. Verification was done by:

- Mocking the AWS SDK v3 client directly in tests (`storage.service.spec.ts`,
  `s3-multer-storage.spec.ts`, `media.service.spec.ts`) — asserting the
  right S3 commands are sent with the right bucket/key/content-type, that
  delete failures are swallowed rather than thrown, and — the
  security-critical case — that a file whose real magic bytes don't match
  an allowed type is rejected **before** any upload command is ever sent.
- The full existing `AppModule` boot test (`route-ordering.e2e-spec.ts`)
  still passes with the new `StorageModule` wired in globally, proving no
  DI wiring errors were introduced.

**28 new tests across 4 new spec files, all passing.** Full suite: **96/96**
across 9 suites (up from 68/68 across 5 suites at the end of Milestone 3).

The real bucket itself — actual upload, actual presigned URL redirect,
actual cross-redeploy persistence — still needs the manual verification
checklist above run once by you against the real deployed app.

## Also fixed in this session (found while establishing baseline)

`package.json`'s `testRegex` was `.*\.spec\.ts$`, which does **not** match
`route-ordering.e2e-spec.ts` (hyphen before "spec", not a dot) — so the
Milestone 1 "permanent regression guard" test file existed in the repo but
was never actually being run by `npm test`. Fixed to
`.*\.(spec|e2e-spec)\.ts$`. Worth knowing this test wasn't actually running
between Milestone 1 and now, though nothing in that window changed routing.
