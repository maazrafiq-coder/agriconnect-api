// src/common/guards/registration-token.guard.ts
//
// Validates the short-lived "registration token" issued by
// AuthService.verifyOtp() (see auth.service.ts / generateRegistrationToken).
//
// This exists because SubmitKycDto's endpoint used to require a full
// JwtAuthGuard login — but a user who has only just verified their OTP is
// NOT logged in yet (login is gated on admin approval, see AuthService.login).
// That made document upload during registration impossible: there was no
// valid token the frontend could send.
//
// This guard accepts a SEPARATE token type (payload.type === 'registration'),
// signed with the same JWT_SECRET but short-lived and scoped ONLY to the
// registration/KYC endpoints — it grants no access to any other authenticated
// route (see KycAuthGuard for where it's actually wired in).
//
// It also re-checks the user's CURRENT kycStatus from the database on every
// request (not just the token's signature/expiry) — so the token
// automatically stops working the moment an admin approves or rejects the
// registration, even if it hasn't technically expired yet. This satisfies
// the "become invalid after registration is completed or rejected"
// requirement without needing a separate revocation list.
import {
  Injectable, CanActivate, ExecutionContext,
  UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

// Registration tokens are only valid while the account is in one of these
// states. INFO_REQUESTED is included so a user can still respond (e.g. by
// uploading another document) if an admin asks for more information while
// their registration token hasn't expired yet — otherwise they'd be locked
// out of the exact endpoint they need. APPROVED/REJECTED/RECOMMENDED mean
// the registration window is closed.
const REGISTRATION_ALLOWED_STATUSES = ['PENDING', 'SUBMITTED', 'INFO_REQUESTED'];

@Injectable()
export class RegistrationTokenGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Registration session required. Please verify your OTP first.');
    }

    const token = authHeader.slice('Bearer '.length);
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET') });
    } catch {
      throw new UnauthorizedException('Your registration session has expired. Please verify your OTP again.');
    }

    if (payload?.type !== 'registration') {
      throw new UnauthorizedException('Invalid registration session token.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('User not found.');

    if (!REGISTRATION_ALLOWED_STATUSES.includes(user.kycStatus)) {
      throw new ForbiddenException(
        'This registration session is no longer active — your registration has already been reviewed.',
      );
    }

    // Deliberately minimal — a registration-session identity, NOT a full
    // authenticated user object. It must never be usable to access normal
    // authenticated routes (that's enforced by callers only using this
    // guard on the two KYC endpoints, never on general-purpose routes).
    request.user = {
      id: user.id,
      role: user.role,
      kycStatus: user.kycStatus,
      isRegistrationSession: true,
    };
    return true;
  }
}
