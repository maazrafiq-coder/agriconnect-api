import {
  Injectable, BadRequestException, UnauthorizedException,
  ConflictException, NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { RegisterDto, LoginDto, VerifyOtpDto, ResetPasswordDto, SubmitKycDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // ─── REGISTER ─────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
    });
    if (existing) throw new ConflictException('Phone number already registered');

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

    // Create and send OTP
    const otp = await this.createOtp(user.id, 'phone_verify');

    return {
      message: 'Registration successful. OTP sent to your phone.',
      userId: user.id,
      // In dev mode, return OTP directly
      ...(this.config.get('OTP_DEV_MODE') === 'true' && { devOtp: otp }),
    };
  }

  // ─── VERIFY OTP ───────────────────────────────────────────────────────────
  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
    });
    if (!user) throw new NotFoundException('User not found');

    // Lockout check: max 5 failed attempts per active (unexpired, unused) OTP window
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

    const otpRecord = await this.prisma.otp.findFirst({
      where: {
        userId: user.id,
        code: dto.otp,
        purpose: dto.purpose,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!otpRecord) {
      // Track the failed attempt so lockout logic above can count it
      throw new BadRequestException('Invalid or expired OTP');
    }

    // Mark OTP used
    await this.prisma.otp.update({
      where: { id: otpRecord.id },
      data: { isUsed: true },
    });

    // Invalidate any other outstanding OTPs of the same purpose (prevents reuse/enumeration)
    await this.prisma.otp.updateMany({
      where: { userId: user.id, purpose: dto.purpose, isUsed: false },
      data: { isUsed: true },
    });

    // Mark phone verified
    await this.prisma.user.update({
      where: { id: user.id },
      data: { isPhoneVerified: true },
    });

    const tokens = await this.generateTokens(user);
    return {
      message: 'Phone number verified successfully',
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
      include: { profile: true },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account suspended');

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) throw new UnauthorizedException('Invalid credentials');

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

    // Rotate refresh token
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { isRevoked: true },
    });

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

    // Save uploaded documents
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

    // Update profile with KYC data
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

    // Update KYC status to SUBMITTED
    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: 'SUBMITTED' },
    });

    return { message: 'KYC documents submitted for review. You will be notified within 24 hours.' };
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
        kycDocuments: {
          select: { docType: true, status: true, createdAt: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ─── FORGOT PASSWORD ─────────────────────────────────────────────────────
  async forgotPassword(phoneNumber: string) {
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) throw new NotFoundException('Phone number not found');

    const otp = await this.createOtp(user.id, 'password_reset');
    return {
      message: 'OTP sent to your registered phone number',
      ...(this.config.get('OTP_DEV_MODE') === 'true' && { devOtp: otp }),
    };
  }

  // ─── RESET PASSWORD ──────────────────────────────────────────────────────
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
    });
    if (!user) throw new NotFoundException('User not found');

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

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    return { message: 'Password reset successfully' };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  private async createOtp(userId: string, purpose: string): Promise<string> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryMinutes = parseInt(this.config.get('OTP_EXPIRY_MINUTES') || '10');

    await this.prisma.otp.create({
      data: {
        userId,
        code,
        purpose,
        expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
      },
    });

    // TODO: Send SMS via Twilio in production
    // await this.smsService.send(user.phoneNumber, `Your AgriConnect OTP: ${code}`);

    return code;
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
}
