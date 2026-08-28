# Round 2, Milestone 3 — DB migration required

This checkpoint adds to `prisma/schema.prisma`:

- New `ClarificationStatus` enum (`OPEN / RESPONDED / RESOLVED`)
- New `ReviewClarification` model
- New `ClarificationAttachment` model
- No changes to existing columns — `User.kycInfoRequestNote` /
  `kycInfoRequestedAt` are kept as-is (now documented as a denormalized
  "latest request" cache; `ReviewClarification` is the real source of truth)

**Before deploying this checkpoint**, run in an environment with real network
access to Prisma's engine binaries and your real `DATABASE_URL`:

```bash
npx prisma generate
npx prisma db push
```

This is purely additive (two new tables, no column changes, no data to
backfill) — no truncation or backfill concerns like Milestone 2's
`storage_bookings` change.

## New directory needed at runtime

`ReviewModule`'s multer config writes clarification response attachments to
`./secure-uploads/clarifications` (same pattern as the existing
`./secure-uploads/kyc` directory for original KYC documents — outside the
public static-file root, only reachable through the signed-token endpoint).
Multer creates this directory automatically on first upload, but if your
deploy process pre-creates `secure-uploads/` with restricted permissions,
make sure `clarifications/` is included.

**Also carries forward from Milestone 2:** `storage_bookings` still needs
its own migration if you haven't applied that checkpoint yet — see
`MIGRATION_NOTES_R2_M2.md`.

## Why this note exists

Same sandbox limitation as Milestone 2 — no network access here to Prisma's
engine-binary CDN, so this could only be verified with an instrumented
Prisma stub (68 passing tests across 5 suites, including a full `AppModule`
boot proving `ReviewModule` wires cleanly into `UsersModule` with no DI
errors) rather than against a real Postgres database. The actual schema
push still needs to be run once, by you, outside this sandbox.
