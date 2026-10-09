// src/common/guards/approved-user.guard.ts
//
// One shared "must be an APPROVED account" gate for state-changing routes.
// JwtStrategy already re-reads kycStatus from the database on every request,
// so req.user.kycStatus is live here - no extra query, no per-service copy
// of the check.
//
// Use it IN PLACE OF JwtAuthGuard (it authenticates first):
//     @RequireApproved()                 // authenticated + APPROVED
//     @UseGuards(ApprovedUserGuard, RolesGuard)   // when combining with roles
//
// Deliberately NOT applied to: reads, KYC/profile/account routes, or
// clarification/message replies - INFO_REQUESTED users must be able to
// respond to the admin.
import { ExecutionContext, ForbiddenException, Injectable, UseGuards, applyDecorators } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class ApprovedUserGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;
    const user = context.switchToHttp().getRequest().user;
    if (user?.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(
        'Your account must be approved before you can do this. Check your registration status in My Portal.',
      );
    }
    return true;
  }
}

export const RequireApproved = () => applyDecorators(UseGuards(ApprovedUserGuard));
