import {
  Injectable, BadRequestException, UnauthorizedException,
  ConflictException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { withAgriConnectId } from '../common/utils/agri-connect-id.util';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { SESSION_ALLOWED_KYC } from './strategies/jwt.strategy';
import {
  RegisterDto, LoginDto, VerifyOtpDto, ResetPasswordDto, SubmitKycDto,
  ChangePasswordDto, AdminCreateUserDto, AdminResetPasswordDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // ─── REGISTER ─────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    if (!dto.phoneNumber && !dto.email) {
      throw new BadRequestException('Provide a phone number or an email address to register');
    }

    // An earlier registration that never got past OTP verification (no code
    // entered, tab closed…) must not lock the phone/email forever. If the
    // matching account is still unverified (PENDING, phone not verified) it
    // is taken over: details are replaced and a fresh OTP sent. Ownership is
    // proven by the OTP, so this can't be used to hijack anything.
    const byPhone = dto.phoneNumber ? await this.prisma.user.findUnique({ where: { phoneNumber: dto.phoneNumber } }) : null;
    const byEmail = dto.email ? await this.prisma.user.findUnique({ where: { email: dto.email } }) : null;
    const isAbandoned = (u: any) => u && u.kycStatus === 'PENDING' && !u.isPhoneVerified && u.isActive;
    if (byPhone && !isAbandoned(byPhone)) throw new ConflictException('Phone number already registered');
    if (byEmail && !isAbandoned(byEmail)) throw new ConflictException('Email already registered');
    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      throw new ConflictException('Phone number and email belong to different pending registrations');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const abandoned = byPhone || byEmail;

    const user = abandoned
      ? await this.prisma.user.update({
          where: { id: abandoned.id },
          data: {
            phoneNumber: dto.phoneNumber ?? abandoned.phoneNumber,
            email: dto.email ?? abandoned.email,
            passwordHash,
            role: dto.role,
            profile: { upsert: { create: { fullName: dto.fullName }, update: { fullName: dto.fullName } } },
          },
        })
      : await this.prisma.user.create({
          data: {
            phoneNumber: dto.phoneNumber,
            email: dto.email,
            passwordHash,
            role: dto.role,
            profile: { create: { fullName: dto.fullName } },
          },
        });

    // Send OTP to whichever channel is available — phone takes priority
    // since that's the only one with a (placeholder) delivery path today.
    const otp = await this.createOtp(user.id, 'phone_verify');

    return {
      message: `Registration successful. OTP sent to your ${dto.phoneNumber ? 'phone' : 'email'}.`,
      userId: user.id,
      identifier: dto.phoneNumber || dto.email,
      ...(this.isOtpDevMode() && { devOtp: otp }),
    };
  }

  // ─── RESEND OTP (registration) ─────────────────────────────────────────────
  // Only for accounts still waiting on their first verification. Always the
  // same response, whether or not such an account exists, so it can't be used
  // to enumerate users; requests are capped by createOtp's 15-minute limit.
  async resendRegistrationOtp(identifier: string) {
    const generic = { message: 'If a registration is waiting for verification, a new OTP has been sent.' };
    const user = await this.findByIdentifier(identifier);
    if (!user || user.kycStatus !== 'PENDING' || user.isPhoneVerified || !user.isActive) return generic;
    // A rate-limit BadRequest from createOtp propagates: the person is the
    // owner of this registration, so telling them to wait leaks nothing.
    const otp = await this.createOtp(user.id, 'phone_verify');
    return { ...generic, ...(this.isOtpDevMode() && { devOtp: otp }) };
  }

  // ─── VERIFY OTP ───────────────────────────────────────────────────────────
  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.findByIdentifier(dto.identifier);
    // Same message as a wrong code, so this endpoint can't be used to find
    // out which phone numbers / emails are registered.
    if (!user) throw new BadRequestException('Invalid or expired OTP');

    // Dev/test bypass: when OTP_DEV_MODE is on, '000000' always verifies
    // regardless of what's stored or whether it expired, so testers never
    // get blocked waiting on a real code. Boot is refused in production
    // unless explicitly overridden (see env.validation.ts).
    const isTestBypass = this.isOtpDevMode() && dto.otp === '000000';
    if (!isTestBypass) await this.consumeOtp(user.id, dto.purpose, dto.otp);

    await this.prisma.otp.updateMany({
      where: { userId: user.id, purpose: dto.purpose, isUsed: false },
      data: { isUsed: true },
    });

    // Registration flow: Register -> OTP -> Upload Documents -> Pending
    // Approval -> Admin Review -> Approved -> Can Login. Verifying the OTP
    // marks the account as fully SUBMITTED (documents are optional — this
    // fires whether or not any were uploaded) — it does NOT grant login.
    // Login itself is blocked until an admin/moderator sets kycStatus to
    // APPROVED (see login() below).
    const updateData: any = { isPhoneVerified: true };
    if (user.kycStatus === 'PENDING') updateData.kycStatus = 'SUBMITTED';

    const updated = await this.prisma.user.update({ where: { id: user.id }, data: updateData });

    await this.writeAuditLog(user.id, 'phone_verified', 'user', user.id);

    // The user isn't logged in yet (login is gated on admin approval — see
    // login() below) but they DO need to upload KYC documents next. Issue a
    // short-lived, single-purpose token scoped only to the KYC endpoints
    // (see RegistrationTokenGuard) rather than granting a real session.
    const registrationToken = this.generateRegistrationToken(user.id);

    return {
      message: 'Verified! Your registration is now pending admin review before you can log in.',
      user: this.sanitizeUser(updated),
      pendingApproval: updated.kycStatus !== 'APPROVED',
      registrationToken,
      registrationTokenExpiresIn: this.REGISTRATION_TOKEN_TTL,
    };
  }

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.findByIdentifier(dto.identifier, { includeProfile: true });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    // Password first: the suspended / approval messages below confirm an
    // account exists, so only reveal them to someone who knows the password.
    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('This account has been suspended. Contact support.');

    // Registration approval gate — the account must be admin-approved
    // before it can be used, per the required flow. Accounts admins create
    // directly are auto-approved (see adminCreateUser below), so this only
    // blocks self-registered accounts still awaiting review.
    //
    // INFO_REQUESTED is a deliberate exception: an admin has asked this
    // user for more information, and they can't provide it (or see why it
    // was asked) if they're locked out of the account entirely. So these
    // users ARE allowed to log in — they just can't transact yet (see
    // OffersService.assertCanTransact) until an admin actually approves
    // the account.
    if (user.kycStatus !== 'APPROVED' && user.kycStatus !== 'INFO_REQUESTED') {
      const statusMessage = ({
        PENDING: 'Please verify your OTP first.',
        SUBMITTED: 'Your registration is pending admin review. You will be able to log in once approved.',
        RECOMMENDED: 'Your registration has been reviewed and is awaiting final admin approval.',
        REJECTED: `Your registration was not approved.${user.kycRejectionNote ? ' Reason: ' + user.kycRejectionNote : ''}`,
      } as Record<string, string>)[user.kycStatus] || 'Your account is not yet approved for login.';
      throw new ForbiddenException(statusMessage);
    }

    await this.writeAuditLog(user.id, 'login', 'user', user.id);

    const tokens = await this.generateTokens(user);
    return {
      message: 'Login successful',
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  // ─── REFRESH TOKEN ────────────────────────────────────────────────────────
  // Grace window for two tabs refreshing at the same moment with the same
  // cookie: the loser of that race is not an attack.
  private static readonly ROTATION_GRACE_MS = 10_000;

  async refreshToken(token: string) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: this.hashToken(token) },
      include: { user: true },
    });
    if (!record) throw new UnauthorizedException('Invalid refresh token');

    // Reuse detection: a token that was already exchanged is being replayed
    // (stolen cookie, or the legitimate client holding a stale copy). Either
    // way the whole token family is burned and everyone must log in again.
    if (record.rotatedAt) {
      if (Date.now() - record.rotatedAt.getTime() > AuthService.ROTATION_GRACE_MS) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: record.userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date() },
        });
        await this.writeAuditLog(record.userId, 'refresh_token_reuse', 'user', record.userId);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (record.isRevoked || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // A suspended / rejected account must not be able to mint new access
    // tokens, even with a refresh token that is otherwise still valid.
    if (!record.user.isActive || !SESSION_ALLOWED_KYC.includes(record.user.kycStatus)) {
      await this.prisma.refreshToken.updateMany({ where: { userId: record.userId }, data: { isRevoked: true, revokedAt: new Date() } });
      throw new UnauthorizedException('This account is not active');
    }

    // Rotate: guarded so only one concurrent caller wins.
    const now = new Date();
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, isRevoked: false, rotatedAt: null },
      data: { isRevoked: true, revokedAt: now, rotatedAt: now },
    });
    if (rotated.count === 0) throw new UnauthorizedException('Invalid refresh token');

    return this.generateTokens(record.user);
  }

  // ─── LOGOUT ───────────────────────────────────────────────────────────────
  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { token: this.hashToken(refreshToken) },
      data: { isRevoked: true },
    });
    return { message: 'Logged out successfully' };
  }

  // ─── KYC SUBMIT ───────────────────────────────────────────────────────────
  async submitKyc(userId: string, dto: SubmitKycDto, files: any[]) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const docPromises = files.map((file) =>
      this.prisma.kycDocument.create({
        data: {
          userId,
          docType: file.fieldname,
          // Historical field, not actually used to serve the file (KYC
          // docs are only ever served through the signed-token endpoint
          // below, which resolves via `s3Key`) — kept populated for
          // readability/audit trails rather than removed outright.
          fileUrl: `kyc/${file.fieldname}`,
          s3Key: file.filename,
          status: 'pending',
        },
      })
    );
    await Promise.all(docPromises);

    if (dto.cnicNumber || dto.fullName) {
      await this.prisma.userProfile.update({
        where: { userId },
        data: {
          ...(dto.fullName && { fullName: dto.fullName }),
          ...(dto.cnicNumber && { cnicNumber: dto.cnicNumber }),
          ...(dto.dateOfBirth && { dateOfBirth: new Date(dto.dateOfBirth) }),
          ...(dto.address && { address: dto.address }),
        },
      });
    }

    if (user.kycStatus === 'PENDING' || user.kycStatus === 'SUBMITTED' || user.kycStatus === 'REJECTED') {
      await this.prisma.user.update({ where: { id: userId }, data: { kycStatus: 'SUBMITTED' } });
    }

    await this.writeAuditLog(userId, 'documents_uploaded', 'user', userId, { fileCount: files.length });

    return { message: 'Documents submitted for review. You will be notified once reviewed.' };
  }

  // ─── KYC STATUS ───────────────────────────────────────────────────────────
  async getKycStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        kycApprovedAt: true,
        kycRejectedAt: true,
        kycRejectionNote: true,
        kycDocuments: { select: { docType: true, status: true, createdAt: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ─── FORGOT / RESET PASSWORD ─────────────────────────────────────────────
  async forgotPassword(identifier: string) {
    // Always the same response whether or not the account exists (or is
    // suspended), so this can't be used to enumerate registered users.
    const generic = { message: 'If an account exists for that phone or email, an OTP has been sent.' };

    const user = await this.findByIdentifier(identifier);
    if (!user || !user.isActive) return generic;

    let otp: string;
    try {
      otp = await this.createOtp(user.id, 'password_reset');
    } catch (e) {
      if (e instanceof BadRequestException) return generic; // rate-limited: stay silent
      throw e;
    }
    return {
      ...generic,
      ...(this.isOtpDevMode() && { devOtp: otp }),
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.findByIdentifier(dto.identifier);
    if (!user) throw new BadRequestException('Invalid or expired OTP');

    const isTestBypass = this.isOtpDevMode() && dto.otp === '000000';
    if (!isTestBypass) await this.consumeOtp(user.id, 'password_reset', dto.otp);

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    // A reset means the old password may be compromised: end every session.
    await this.prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { isRevoked: true, revokedAt: new Date() } });

    await this.writeAuditLog(user.id, 'password_reset', 'user', user.id);

    return { message: 'Password reset successfully' };
  }

  // ─── SELF-SERVICE: CHANGE PASSWORD (authenticated) ───────────────────────
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    // Revoke all existing sessions so a stolen/old device is logged out
    await this.prisma.refreshToken.updateMany({ where: { userId }, data: { isRevoked: true } });

    await this.writeAuditLog(userId, 'password_changed', 'user', userId);

    return { message: 'Password changed. Please log in again.' };
  }

  // ─── SELF-SERVICE: DEACTIVATE OWN ACCOUNT ────────────────────────────────
  async deactivateSelf(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    await this.prisma.refreshToken.updateMany({ where: { userId }, data: { isRevoked: true } });
    await this.writeAuditLog(userId, 'self_deactivated', 'user', userId);

    return { message: 'Your account has been deactivated. Contact admin to reactivate.' };
  }

  // ─── SELF-SERVICE: VIEW OWN DOCUMENTS ────────────────────────────────────
  async getMyDocuments(userId: string) {
    return this.prisma.kycDocument.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── SELF-SERVICE: VIEW OWN ACTIVITY LOG ─────────────────────────────────
  async getMyAuditLog(userId: string) {
    return this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ─── ADMIN: CREATE USER ON SOMEONE'S BEHALF ──────────────────────────────
  async adminCreateUser(dto: AdminCreateUserDto, createdByAdminId: string) {
    if (!dto.phoneNumber && !dto.email) {
      throw new BadRequestException('Provide a phone number or an email address');
    }
    if (dto.phoneNumber) {
      const existing = await this.prisma.user.findUnique({ where: { phoneNumber: dto.phoneNumber } });
      if (existing) throw new ConflictException('Phone number already registered');
    }
    if (dto.email) {
      const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (existing) throw new ConflictException('Email already registered');
    }

    const tempPassword = dto.password || this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        phoneNumber: dto.phoneNumber,
        email: dto.email,
        passwordHash,
        role: dto.role,
        isPhoneVerified: !!dto.phoneNumber,
        isEmailVerified: !!dto.email,
        // Admin-created accounts skip the approval queue — the admin
        // creating it IS the approval.
        kycStatus: 'APPROVED',
        kycApprovedAt: new Date(),
        profile: { create: { fullName: dto.fullName } },
      },
    });

    await this.writeAuditLog(createdByAdminId, 'user_created_by_admin', 'user', user.id, { role: dto.role });

    return {
      user: this.sanitizeUser(user),
      temporaryPassword: tempPassword,
      message: 'User created and approved. Share the temporary password securely — they should change it on first login.',
    };
  }

  // ─── ADMIN: RESET ANY USER'S PASSWORD ────────────────────────────────────
  async adminResetPassword(targetUserId: string, dto: AdminResetPasswordDto, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');

    const newPassword = dto.newPassword || this.generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({ where: { id: targetUserId }, data: { passwordHash } });
    await this.prisma.refreshToken.updateMany({ where: { userId: targetUserId }, data: { isRevoked: true } });

    await this.writeAuditLog(adminId, 'password_reset_by_admin', 'user', targetUserId);

    return { temporaryPassword: newPassword, message: 'Password reset. Share it securely with the user.' };
  }

  // ─── MODERATOR: RECOMMEND APPROVAL (does not itself approve) ────────────
  async moderatorRecommend(targetUserId: string, moderatorId: string, note?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.kycStatus !== 'SUBMITTED') {
      throw new BadRequestException('Only submitted registrations can be recommended');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { kycStatus: 'RECOMMENDED' },
    });
    await this.writeAuditLog(moderatorId, 'kyc_recommended', 'user', targetUserId, { note });

    return updated;
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  private async findByIdentifier(identifier: string, opts: { includeProfile?: boolean } = {}) {
    return this.prisma.user.findFirst({
      where: { OR: [{ phoneNumber: identifier }, { email: identifier }] },
      ...(opts.includeProfile && { include: { profile: true } }),
    });
  }

  // Joi's schema (see env.validation.ts) coerces OTP_DEV_MODE into a real
  // boolean, so comparing against the string 'true' always evaluated to
  // false and dev mode never actually engaged. Accept either shape here.
  private isOtpDevMode(): boolean {
    const raw = this.config.get('OTP_DEV_MODE');
    return raw === true || raw === 'true';
  }

  private static readonly OTP_MAX_ATTEMPTS = 5;
  private static readonly OTP_MAX_REQUESTS_PER_15_MIN = 5;

  private async createOtp(userId: string, purpose: string): Promise<string> {
    // Throttle code requests per account/purpose so the 5-guess lockout
    // below can't be reset indefinitely by asking for fresh codes.
    const recentRequests = await this.prisma.otp.count({
      where: { userId, purpose, createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) } },
    });
    if (recentRequests >= AuthService.OTP_MAX_REQUESTS_PER_15_MIN) {
      throw new BadRequestException('Too many OTP requests. Please wait 15 minutes and try again.');
    }

    const isDevMode = this.isOtpDevMode();
    const code = isDevMode ? '000000' : randomInt(100000, 1000000).toString();
    const expiryMinutes = parseInt(this.config.get('OTP_EXPIRY_MINUTES') || '10');

    // Only the newest code is ever valid.
    await this.prisma.otp.updateMany({ where: { userId, purpose, isUsed: false }, data: { isUsed: true } });

    await this.prisma.otp.create({
      data: {
        userId,
        code,
        purpose,
        expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
      },
    });

    return code;
  }

  // Validates a submitted code against the newest live OTP. Failed guesses
  // are counted on that OTP row; after 5 it is locked and a new code must
  // be requested. Success marks it used.
  private async consumeOtp(userId: string, purpose: string, submitted: string): Promise<void> {
    const otp = await this.prisma.otp.findFirst({
      where: { userId, purpose, isUsed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Invalid or expired OTP');

    if (otp.attempts >= AuthService.OTP_MAX_ATTEMPTS) {
      throw new BadRequestException('Too many incorrect attempts. Please request a new OTP.');
    }

    const a = Buffer.from(String(otp.code));
    const b = Buffer.from(String(submitted ?? ''));
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      await this.prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('Invalid or expired OTP');
    }

    await this.prisma.otp.update({ where: { id: otp.id }, data: { isUsed: true } });
  }

  // Refresh tokens are stored as SHA-256 hashes: a database leak must not
  // hand out live sessions. (The tokens are 384-bit random values, so a
  // fast hash is appropriate; bcrypt would only slow every refresh.)
  private hashToken(token: string): string {
    return createHash('sha256').update(String(token ?? '')).digest('hex');
  }

  // How long a post-OTP registration session stays usable for KYC document
  // upload before the user would need to re-verify. Deliberately generous
  // (documents take time to gather/photograph) but still short compared to
  // a real session, and it's re-checked against live kycStatus on every
  // request anyway (see RegistrationTokenGuard), so it can't outlive an
  // admin decision even within this window.
  private readonly REGISTRATION_TOKEN_TTL = '2h';

  private generateRegistrationToken(userId: string): string {
    return this.jwt.sign(
      { sub: userId, type: 'registration' },
      { secret: this.config.get('JWT_SECRET'), expiresIn: this.REGISTRATION_TOKEN_TTL },
    );
  }

  // How long a signed KYC-document access URL stays valid. Short on
  // purpose — this is meant to be used immediately (click a document,
  // view it), not stored or shared. A new one is issued every time the
  // frontend needs to open a document, so re-requesting after expiry
  // costs nothing.
  private readonly KYC_FILE_TOKEN_TTL = '5m';

  // Anyone requesting to VIEW a document must either own it or be staff
  // reviewing it. This is the only access-control check for KYC files —
  // there is no other path to reach the underlying file (see
  // secure-uploads/kyc, outside the public static root, and
  // GET /auth/kyc/documents/file/:token below, which trusts nothing but
  // this signed token).
  async getKycDocumentSignedUrl(requesterId: string, requesterRole: string, docId: string) {
    const doc = await this.prisma.kycDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Document not found');

    const isOwner = doc.userId === requesterId;
    const isReviewer = requesterRole === 'ADMIN' || requesterRole === 'MODERATOR';
    if (!isOwner && !isReviewer) {
      throw new ForbiddenException('You do not have permission to view this document');
    }

    const token = this.jwt.sign(
      { sub: doc.id, purpose: 'kyc_file_access' },
      { secret: this.config.get('JWT_SECRET'), expiresIn: this.KYC_FILE_TOKEN_TTL },
    );
    return { url: `/auth/kyc/documents/file/${token}` };
  }

  // Resolves a signed token (see above) to the object's bucket key. The
  // token itself IS the credential here — this endpoint is intentionally
  // reachable without a normal Authorization header, since it's opened as
  // a plain URL (new tab / img src), which can't carry custom headers.
  // Ownership/role was already checked once, at token-issue time; a
  // stolen token is still only a 5-minute, single-document, read-only
  // liability.
  //
  // Round 2, Milestone 4: previously resolved to a local disk path
  // (`secure-uploads/kyc/<s3Key>`); now returns the bucket key itself,
  // which the controller turns into a short-lived presigned bucket URL
  // via StorageService — the actual bytes are never proxied through our
  // server.
  async resolveKycFileToken(token: string): Promise<{ s3Key: string; docType: string }> {
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET') });
    } catch {
      throw new UnauthorizedException('This document link has expired. Please request it again.');
    }
    if (payload?.purpose !== 'kyc_file_access') {
      throw new UnauthorizedException('Invalid document link.');
    }

    const doc = await this.prisma.kycDocument.findUnique({ where: { id: payload.sub } });
    if (!doc?.s3Key) throw new NotFoundException('Document not found');

    // s3Key is server-generated (see s3-multer-storage.ts) — always
    // "<folder>/<generated-name>" — never user input. We still refuse
    // anything containing ".." as defense in depth against path
    // traversal, in case that assumption ever changes. (Unlike the old
    // disk-based check, a "/" is now expected and fine — it separates
    // the bucket folder from the filename.)
    if (doc.s3Key.includes('..')) {
      throw new NotFoundException('Document not found');
    }

    return {
      s3Key: doc.s3Key,
      docType: doc.docType,
    };
  }

  private generateTempPassword(): string {
    // Readable-ish temporary password: Agri + 6 random alphanumerics
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 8; i++) out += chars[randomInt(chars.length)];
    return 'Agri' + out + '!1';
  }

  private async generateTokens(user: any) {
    const payload = {
      sub: user.id,
      phoneNumber: user.phoneNumber,
      role: user.role,
      kycStatus: user.kycStatus,
    };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: this.config.get('JWT_EXPIRES_IN') || '15m',
    });

    const refreshTokenValue = randomBytes(48).toString('base64url');
    const refreshExpiryDays = 7;

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: this.hashToken(refreshTokenValue),
        expiresAt: new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken: refreshTokenValue };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, ...safe } = user;
    return withAgriConnectId(safe);
  }

  private async writeAuditLog(userId: string | null, action: string, entityType?: string, entityId?: string, details?: any) {
    try {
      await this.prisma.auditLog.create({
        data: { userId: userId || undefined, action, entityType, entityId, details },
      });
    } catch {
      // Audit logging should never break the primary action it's attached to
    }
  }
}
