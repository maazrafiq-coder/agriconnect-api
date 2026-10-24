import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

// Accounts in these KYC states may hold a session.
//
// Only APPROVED accounts may TRANSACT (see ApprovedUserGuard). Every other
// state here is a deliberately LIMITED session: the person can browse the
// public marketplace, see their account/KYC status, upload or replace
// documents and answer the admin's clarification requests - nothing that
// creates or changes a commercial record.
//   SUBMITTED / RECOMMENDED - registered, waiting for admin approval
//   INFO_REQUESTED          - admin asked for more information
//   REJECTED                - must see the reason and can re-submit documents
// PENDING (OTP not yet verified) is NOT here: that person only holds a
// registration token. Suspended accounts (isActive=false) are blocked
// separately, whatever their kycStatus.
export const SESSION_ALLOWED_KYC = ['APPROVED', 'INFO_REQUESTED', 'SUBMITTED', 'RECOMMENDED', 'REJECTED'];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // Registration tokens ({type:'registration'}) and signed file-access
    // tokens ({purpose:'kyc_file_access'}) share JWT_SECRET. They are only
    // valid on their own endpoints, never as a login session.
    if (!payload || payload.type || payload.purpose || !payload.sub) {
      throw new UnauthorizedException('Invalid session token');
    }

    // Re-check the account on every request so suspension / rejection takes
    // effect immediately instead of when the access token expires. Role and
    // kycStatus come from the database, not the (possibly stale) token.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, phoneNumber: true, role: true, kycStatus: true, isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is not active');
    }
    if (!SESSION_ALLOWED_KYC.includes(user.kycStatus)) {
      throw new UnauthorizedException('This account is not approved for access');
    }

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      role: user.role,
      kycStatus: user.kycStatus,
    };
  }
}
