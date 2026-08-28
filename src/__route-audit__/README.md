# Route-ordering live verification (Round 2, Milestone 1)

`route-ordering.e2e-spec.ts` boots the **real** NestJS `AppModule` — real
controllers, real routing table, real guards — and fires real HTTP requests
through the real Express router. It is not a static read-through of the
code; it proves how the framework actually dispatches each request.

The only thing swapped out is `PrismaService`, replaced with an
instrumented in-memory stub that records every `model.method(args)` call
instead of touching a database. That log is the proof for each test: e.g.
if `GET /users/admin/list` results in a `user.findUnique({ where: { id:
'admin' } })` call instead of `user.findMany(...)`, the route-ordering bug
is real — the test fails regardless of what any code comment claims.

Auth/roles guards are overridden to always allow with a fake ADMIN user —
this suite is about routing, not authorization (that's covered separately
in the IDOR/security pass).

## Running it

```bash
npm install
npm test -- __route-audit__/route-ordering.e2e-spec.ts
```

## Why this exists / sandbox note

This suite was written and verified in a development sandbox with no
network access to Prisma's engine-binary CDN, so a real `PrismaClient`
could not be constructed to run against a live Postgres database. The stub
above is what makes the test runnable without one. In a normal dev/CI
environment with `DATABASE_URL` and a generated Prisma client, this same
suite can be pointed at a real test database instead by swapping the
`PrismaService` override for a real client connected to a disposable test
DB — the HTTP-level assertions don't change either way.

**Verified in the sandbox:** all 13 tests pass against the current
codebase. A sabotage test (temporarily reordering `products.controller.ts`
so `:id` preceded `my`/`saved`) was run to confirm the harness actually
fails when the bug is real, then reverted — confirmed byte-identical via
`diff` afterwards.
