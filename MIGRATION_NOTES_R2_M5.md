# Round 2, Milestone 5 — Registration data model completion

## What this milestone actually was

`prisma/schema.prisma`'s `UserProfile` model has always had business fields
(`businessName`, `ntnNumber`, `companyAddress`, `licenseNumber`), farm
fields (`farmSizeAcres`, `farmLocation`, `farmGps`, `cropsGrown`), and bank
fields (`bankName`, `bankAccountNo`, `iban`) — but nothing in the app ever
actually let a user fill them in:

- Registration only ever captured `fullName` + phone/email + password.
- KYC submission additionally captured `cnicNumber`, `dateOfBirth`, `address`
  — but nothing else.
- `PATCH /users/profile` existed and *could* have accepted these fields,
  but took `@Body() body: any` with **zero validation** — no DTO, no
  format checks, straight into `prisma.userProfile.update({ data: body })`.
  The frontend's `apiUpdateProfile()` helper existed too, but nothing ever
  called it.

So this wasn't a schema migration — it's closing the gap between what the
data model already supported and what the app actually let a user do.

## What changed

**Backend:**
- New `UpdateProfileDto` (`src/users/dto/update-profile.dto.ts`) with real
  `class-validator` rules per field — Pakistani NTN format, Pakistani IBAN
  format, bank account digit/length check, farm GPS `"lat,lng"` format,
  crop list size cap, etc.
- `UsersController.updateProfile` / `UsersService.updateProfile` now use
  that DTO instead of `any`. Combined with the global `ValidationPipe`'s
  `whitelist: true` (already on, see `main.ts`), any field NOT in the DTO
  is now silently stripped before it ever reaches the service — closing
  what was, in effect, an unvalidated arbitrary-field-write endpoint.
- **Deliberately excluded** from the DTO: `cnicNumber` (identity-critical;
  changing it should only ever happen through KYC re-submission /
  clarification, reviewed against the actual document — never a casual
  self-service PATCH) and `profilePhotoUrl` (should go through a real
  upload endpoint using the Milestone 4 bucket pattern once that exists;
  no such endpoint exists yet, out of scope here).

**Frontend:**
- New "Edit Profile" tab on the My Account page
  (`src/pages/AccountPage.jsx`), grouped into Personal / Farm (shown only
  for `role === 'FARMER'`) / Business (shown for everyone — a farmer may
  also run a registered business) / Bank sections. Wires up the
  already-existing-but-never-called `apiUpdateProfile()` helper.
- The read-only Profile tab now also surfaces a few of these fields
  (NTN, farm size, crops grown, bank name) when present — bank account
  number and IBAN are deliberately left out of that read-only summary view
  (shown only in the edit form itself) since there's no strong reason to
  surface full account numbers in a general-purpose summary list.

## No Prisma schema changes

Every field involved already existed on `UserProfile` from earlier
rounds — no `db push` needed for this checkpoint.

## Before deploying this checkpoint

Nothing bucket/infra-related this time (unlike Milestones 2–4) — this is
pure application-layer validation + a new form. Just the normal deploy.

## What to verify after deploying

1. As a FARMER account, open My Account → Edit Profile → confirm the Farm
   Details section appears and saves correctly (including the comma-
   separated crops list).
2. As a non-farmer account, confirm the Farm Details section does NOT
   appear, but Business and Bank sections do.
3. Try an invalid IBAN / NTN / bank account number → confirm a clear
   validation error comes back rather than a raw 500 or a silently
   accepted garbage value.
4. Confirm a valid Pakistani IBAN entered with spaces/lowercase (e.g.
   `pk36 scbl 0000 0011 2345 6702`) is normalized and accepted — this is
   the realistic way someone would actually type it in.
5. Confirm `cnicNumber` cannot be changed through this form (there's no
   field for it) — it should still only be editable via KYC submission /
   re-submission.

## Testing

**18 new tests** across 2 new spec files:
- `src/users/dto/update-profile.dto.spec.ts` (15 tests) — validation rules
  for every field, including the normalization transforms (IBAN
  uppercasing/whitespace-stripping, crop-list trimming) and confirming
  `cnicNumber` isn't part of the DTO's shape at all.
- `src/users/users.service.spec.ts` (3 tests) — the profile-existence
  guard and that the DTO's fields flow through to the Prisma update
  unchanged.

Full backend suite: **114/114** across 11 suites (up from 96/96 across 9 at
the end of Milestone 4).

Frontend: `AccountPage.jsx` passed the usual `esbuild` syntax check
convention (no Vite build available in this sandbox — see repo conventions
in the Round 2 handoff brief).
