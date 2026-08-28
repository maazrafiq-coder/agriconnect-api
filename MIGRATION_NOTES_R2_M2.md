# Round 2, Milestone 2 — DB migration required

This checkpoint changes `prisma/schema.prisma`:

- New `BookingStatus` enum (`REQUESTED / ACCEPTED / REJECTED / ACTIVE / COMPLETED / CANCELLED`)
- `StorageBooking.status` changed from a free-text `String` to `BookingStatus`
- New columns on `StorageBooking`: `bookingSeq` (unique autoincrement), `rejectionReason`, `cancelReason`, `acceptedAt`, `rejectedAt`, `cancelledAt`, `completedAt`
- New index on `StorageBooking.status`

**Before deploying this checkpoint**, run in an environment with real network
access to Prisma's engine binaries and your real `DATABASE_URL`:

```bash
npx prisma generate
npx prisma db push
```

(matches the project's existing convention of `db push` over tracked
migrations, per prior sessions).

## Why this note exists

This checkpoint was built and tested in a sandbox with no network access to
Prisma's engine-binary CDN, so `prisma generate` / `db push` could not be run
here to produce a migration automatically. All backend logic was instead
verified with an instrumented Prisma stub (see `src/__route-audit__/README.md`
and the 46 passing tests in `warehouse-booking-lifecycle.spec.ts` /
`offers.service.spec.ts` / `warehouse.service.spec.ts` /
`route-ordering.e2e-spec.ts`) — but the actual schema migration against a
real Postgres database still needs to be applied once, by you, outside this
sandbox, before this code is deployed.

**Existing rows:** `StorageBooking.status` currently holds the string
`"confirmed"` for old rows created before this migration. Postgres enum
columns don't accept arbitrary strings, so `db push` will need those rows
either backfilled to a valid `BookingStatus` value first, or — if this is
still a pre-production database with only test data — simply truncated.
Since prior sessions' notes indicate this is still an active-development
database, if you hit a cast/constraint error on `db push`, the fastest fix is:

```sql
-- Only if you're OK discarding pre-migration test bookings:
TRUNCATE TABLE storage_bookings CASCADE;
```

If there's real data you need to keep, let me know and I'll write a proper
backfill (e.g. map `"confirmed"` → `ACTIVE`, `"active"` → `ACTIVE`) instead.
