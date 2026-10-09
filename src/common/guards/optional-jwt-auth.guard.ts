// src/common/guards/optional-jwt-auth.guard.ts
//
// For public routes that behave differently when the caller happens to be
// logged in (e.g. product detail: owners/admins can see non-live listings).
// Never rejects: a missing, expired or invalid token simply means "guest"
// (req.user === undefined).
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(_err: any, user: any) {
    return user || undefined;
  }
}
