// src/common/guards/kyc-auth.guard.ts
//
// The KYC submit/status endpoints need to work for TWO different callers:
//   1. A brand-new user, mid-registration, holding only a short-lived
//      registration token (no full login yet) — RegistrationTokenGuard.
//   2. An already-approved, fully logged-in user revisiting
//      "My Portal -> Documents" to add/replace a document — JwtAuthGuard.
//
// This guard tries a full login first (the common case post-approval), and
// falls back to the registration-token path only if that fails. Either way
// `request.user.id` ends up set consistently for @CurrentUser('id') to read.
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RegistrationTokenGuard } from './registration-token.guard';

@Injectable()
export class KycAuthGuard implements CanActivate {
  constructor(
    private jwtAuthGuard: JwtAuthGuard,
    private registrationTokenGuard: RegistrationTokenGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return (await this.jwtAuthGuard.canActivate(context)) as boolean;
    } catch {
      return this.registrationTokenGuard.canActivate(context);
    }
  }
}
