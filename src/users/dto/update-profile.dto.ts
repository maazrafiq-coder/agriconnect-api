import {
  IsOptional, IsString, IsDateString, IsNumber, IsArray, Min, Max,
  MaxLength, Matches, ArrayMaxSize,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Round 2, Milestone 5 — registration data model completion.
//
// PATCH /users/profile previously took `@Body() body: any` and passed it
// straight into `prisma.userProfile.update({ data: body })` — no DTO, no
// class-validator, no field whitelist of its own. The *only* reason that
// wasn't already exploitable for arbitrary-field writes is the global
// ValidationPipe's `whitelist: true` (see main.ts) silently stripping
// unrecognized keys before any controller ever saw them — but with
// `body: any` there was nothing for `whitelist` to whitelist *against*,
// so in practice every real UserProfile scalar field was writable with
// zero format/length validation, which is how e.g. `iban` or
// `bankAccountNo` could have been saved as arbitrary unvalidated text.
//
// This DTO is the actual fix: every field a user may edit themselves
// through the generic profile-update endpoint, each with real
// validation. `UserProfile` has more columns than this (see
// prisma/schema.prisma) — the two deliberately excluded are:
//
//   - `cnicNumber` — identity-critical and unique; changing it should go
//     through KYC re-submission/clarification (re-verified by an admin
//     against the uploaded document), never a casual self-service PATCH.
//   - `profilePhotoUrl` — should go through a dedicated upload endpoint
//     (bucket key + presigned URL, same pattern as every other file in
//     this app — see Milestone 4) once that's built, not a raw string
//     field a client can point at anything. No such endpoint exists yet;
//     out of scope for this milestone.
export class UpdateProfileDto {
  // ─── Personal ─────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  // ─── Business (traders, millers, exporters, warehouse/testing/transport
  // operators — anyone registering as a company rather than an
  // individual; left optional for every role rather than server-side
  // role-gated, since e.g. a farmer may also run a registered business) ─
  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  // Pakistani NTN format: 7 digits, hyphen, 1 check digit (e.g. 1234567-1).
  @IsOptional()
  @Matches(/^\d{7}-\d$/, { message: 'NTN number must be in the format 1234567-1' })
  ntnNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  companyAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  licenseNumber?: string;

  // ─── Farm (farmers) ──────────────────────────────────────────────────
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  farmSizeAcres?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  farmLocation?: string;

  // "lat,lng" — validated loosely (real range/precision doesn't matter
  // much here; a map picker generates this, not a free-text field) to
  // catch obvious garbage before it lands in the DB.
  @IsOptional()
  @Matches(/^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/, {
    message: 'Farm GPS location must be in "latitude,longitude" format',
  })
  farmGps?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : value))
  cropsGrown?: string[];

  // ─── Bank (payouts — warehouse receipt releases, order settlements) ───
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @IsOptional()
  @Matches(/^\d{5,24}$/, { message: 'Bank account number must be 5–24 digits' })
  bankAccountNo?: string;

  // Pakistani IBAN: "PK" + 2 check digits + 4-letter bank code + 16 digits.
  @IsOptional()
  @Matches(/^PK\d{2}[A-Z]{4}\d{16}$/, {
    message: 'IBAN must be in Pakistani format, e.g. PK36SCBL0000001123456702',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : value))
  iban?: string;
}
