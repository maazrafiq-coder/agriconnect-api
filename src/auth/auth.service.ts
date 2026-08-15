import {
  Injectable, BadRequestException, UnauthorizedException,
  ConflictException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
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

    if (dto.phoneNumber) {
      const existing = await this.prisma.user.findUnique({ where: { phoneNumber: dto.phoneNumber } });
      if (existing) throw new ConflictException('Phone number already registered');
    }
    if (dto.email) {
      const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (emailExists) throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        phoneNumber: dto.phoneNumber,
        email: dto.email,
        passwordHash,
        role: dto.role,
        profile: {
          create: { fullName: dto.fullName },
        },
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

  // ─── VERIFY OTP ───────────────────────────────────────────────────────────
  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.findByIdentifier(dto.identifier);
    if (!user) throw new NotFoundException('User not found');

    const recentFailures = await this.prisma.otp.count({
      where: {
        userId: user.id,
        purpose: dto.purpose,
        isUsed: false,
        createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
      },
    });
    if (recentFailures > 5) {
      throw new BadRequestException('Too many attempts. Please wait 15 minutes and request a new OTP.');
    }

    // Dev/test bypass: when OTP_DEV_MODE is on, '000000' always verifies
    // regardless of what's stored or whether it expired, so testers never
    // get blocked waiting on a real code. Only ever active outside prod.
    const isTestBypass = this.isOtpDevMode() && dto.otp === '000000';

    if (!isTestBypass) {
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          userId: user.id,
          code: dto.otp,
          purpose: dto.purpose,
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
      });
      if (!otpRecord) throw new BadRequestException('Invalid or expired OTP');

      await this.prisma.otp.update({ where: { id: otpRecord.id }, data: { isUsed: true } });
    }

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

    return {
      message: 'Verified! Your registration is now pending admin review before you can log in.',
      user: this.sanitizeUser(updated),
      pendingApproval: updated.kycStatus !== 'APPROVED',
    };
  }

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.findByIdentifier(dto.identifier, { includeProfile: true });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('This account has been suspended. Contact support.');

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) throw new UnauthorizedException('Invalid credentials');

    // Registration approval gate — the account must be admin-approved
    // before it can be used, per the required flow. Accounts admins create
    // directly are auto-approved (see adminCreateUser below), so this only
    // blocks self-registered accounts still awaiting review.
    if (user.kycStatus !== 'APPROVED') {
      const statusMessage = {
        PENDING: 'Please verify your OTP first.',
        SUBMITTED: 'Your registration is pending admin review. You will be able to log in once approved.',
        RECOMMENDED: 'Your registration has been reviewed and is awaiting final admin approval.',
        REJECTED: `Your registration was not approved.${user.kycRejectionNote ? ' Reason: ' + user.kycRejectionNote : ''}`,
      }[user.kycStatus] || 'Your account is not yet approved for login.';
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
  async refreshToken(token: string) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true },
    });
    if (!record || record.isRevoked || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { isRevoked: true } });

    const tokens = await this.generateTokens(record.user);
    return tokens;
  }

  // ─── LOGOUT ───────────────────────────────────────────────────────────────
  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { token: refreshToken },
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
          fileUrl: `/uploads/${file.filename}`,
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

    if (user.kycStatus === 'PENDING' || user.kycStatus === 'SUBMITTED') {
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
    const user = await this.findByIdentifier(identifier);
    if (!user) throw new NotFoundException('No account found with that phone or email');

    const otp = await this.createOtp(user.id, 'password_reset');
    return {
      message: 'OTP sent to your registered contact',
      ...(this.isOtpDevMode() && { devOtp: otp }),
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.findByIdentifier(dto.identifier);
    if (!user) throw new NotFoundException('User not found');

    const isTestBypass = this.isOtpDevMode() && dto.otp === '000000';

    if (!isTestBypass) {
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          userId: user.id,
          code: dto.otp,
          purpose: 'password_reset',
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
      });
      if (!otpRecord) throw new BadRequestException('Invalid or expired OTP');

      await this.prisma.otp.update({ where: { id: otpRecord.id }, data: { isUsed: true } });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

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

  private async createOtp(userId: string, purpose: string): Promise<string> {
    const isDevMode = this.isOtpDevMode();
    const code = isDevMode ? '000000' : Math.floor(100000 + Math.random() * 900000).toString();
    const expiryMinutes = parseInt(this.config.get('OTP_EXPIRY_MINUTES') || '10');

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

  private generateTempPassword(): string {
    // Readable-ish temporary password: Agri + 6 random alphanumerics
    return 'Agri' + Math.random().toString(36).slice(-6) + '!1';
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

    const refreshTokenValue = uuidv4();
    const refreshExpiryDays = 7;

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshTokenValue,
        expiresAt: new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken: refreshTokenValue };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, ...safe } = user;
    return safe;
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
