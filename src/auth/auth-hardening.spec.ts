import { Test } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

describe('AuthService - Milestone 1 hardening', () => {
  let service: AuthService;
  let prisma: any;
  let env: Record<string, any>;

  const user = (over: any = {}) => ({
    id: 'u1', phoneNumber: '+9230', email: null, role: 'BUYER', kycStatus: 'APPROVED',
    isActive: true, passwordHash: 'h', ...over,
  });

  beforeEach(async () => {
    env = { JWT_SECRET: 's'.repeat(32), OTP_DEV_MODE: false, OTP_EXPIRY_MINUTES: '10' };
    prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn().mockResolvedValue(user()) },
      otp: {
        findFirst: jest.fn(), create: jest.fn(), update: jest.fn(),
        updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0),
      },
      refreshToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn() },
    };
    const mod = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue('jwt') } },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    service = mod.get(AuthService);
  });

  describe('refresh tokens', () => {
    it('stores only a SHA-256 hash, never the raw token', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ passwordHash: await bcrypt.hash('pw', 4) }));
      const res: any = await service.login({ identifier: '+9230', password: 'pw' } as any);
      const stored = prisma.refreshToken.create.mock.calls[0][0].data.token;
      expect(stored).not.toBe(res.refreshToken);
      expect(stored).toBe(sha(res.refreshToken));
      expect(res.refreshToken.length).toBeGreaterThanOrEqual(60);
    });

    it('looks the token up by hash', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { token: sha('raw') } }));
    });

    it('refuses to refresh for a suspended user and revokes all their tokens', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: false, expiresAt: new Date(Date.now() + 1e6),
        user: user({ isActive: false }),
      });
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { isRevoked: true, revokedAt: expect.any(Date) } });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('refuses to refresh for a REJECTED user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: false, expiresAt: new Date(Date.now() + 1e6),
        user: user({ kycStatus: 'REJECTED' }),
      });
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
    });

    it('rotates a valid token for an active user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: false, expiresAt: new Date(Date.now() + 1e6), user: user(),
      });
      const res: any = await service.refreshToken('raw');
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', isRevoked: false, rotatedAt: null },
        data: { isRevoked: true, revokedAt: expect.any(Date), rotatedAt: expect.any(Date) },
      });
      expect(res.accessToken).toBe('jwt');
      expect(res.refreshToken).toBeTruthy();
    });

    it('REUSE DETECTION: replaying an already-rotated token burns every session for that user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: true, rotatedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 1e6), user: user(),
      });
      await expect(service.refreshToken('stolen')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isRevoked: false },
        data: { isRevoked: true, revokedAt: expect.any(Date) },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'refresh_token_reuse' }) }));
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('does NOT burn sessions for a two-tab race inside the grace window', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: true, rotatedAt: new Date(Date.now() - 2_000),
        expiresAt: new Date(Date.now() + 1e6), user: user(),
      });
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('a token logged out (revoked, never rotated) is simply refused — no mass revoke', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: true, rotatedAt: null, expiresAt: new Date(Date.now() + 1e6), user: user(),
      });
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('loses cleanly when another request rotated the token first', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'r1', userId: 'u1', isRevoked: false, rotatedAt: null, expiresAt: new Date(Date.now() + 1e6), user: user(),
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.refreshToken('raw')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('registration: resend OTP & abandoned accounts', () => {
    const dto: any = { phoneNumber: '+9230', password: 'password1', role: 'FARMER', fullName: 'New Name' };
    beforeEach(() => {
      prisma.user.create = jest.fn().mockResolvedValue(user({ id: 'new' }));
      prisma.otp.create.mockResolvedValue({});
    });

    it('takes over an abandoned (unverified PENDING) registration instead of 409', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(user({ id: 'old', kycStatus: 'PENDING', isPhoneVerified: false }));
      prisma.user.update.mockResolvedValue(user({ id: 'old' }));
      const res: any = await service.register(dto);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' }, data: expect.objectContaining({ role: 'FARMER' }) }));
      expect(res.userId).toBe('old');
      expect(prisma.otp.create).toHaveBeenCalled();
    });

    it('still refuses a number that belongs to a verified / reviewed account', async () => {
      for (const over of [{ kycStatus: 'SUBMITTED', isPhoneVerified: true }, { kycStatus: 'APPROVED', isPhoneVerified: true }, { kycStatus: 'PENDING', isPhoneVerified: true }]) {
        prisma.user.findUnique.mockResolvedValueOnce(user(over));
        await expect(service.register(dto)).rejects.toThrow(/already registered/);
      }
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses when phone and email belong to two different pending registrations', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(user({ id: 'a', kycStatus: 'PENDING', isPhoneVerified: false }))
        .mockResolvedValueOnce(user({ id: 'b', kycStatus: 'PENDING', isPhoneVerified: false }));
      await expect(service.register({ ...dto, email: 'x@y.com' })).rejects.toThrow(/different pending/);
    });

    it('resend: sends a fresh code only to an unverified PENDING account', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ kycStatus: 'PENDING', isPhoneVerified: false }));
      await service.resendRegistrationOtp('+9230');
      expect(prisma.otp.create).toHaveBeenCalledTimes(1);
    });

    it('resend: same generic answer and NO code for unknown, verified or suspended accounts', async () => {
      const generic = { message: expect.stringMatching(/If a registration/) };
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.resendRegistrationOtp('nobody')).resolves.toEqual(generic);
      prisma.user.findFirst.mockResolvedValue(user({ kycStatus: 'APPROVED' }));
      await expect(service.resendRegistrationOtp('+9230')).resolves.toEqual(generic);
      prisma.user.findFirst.mockResolvedValue(user({ kycStatus: 'PENDING', isPhoneVerified: false, isActive: false }));
      await expect(service.resendRegistrationOtp('+9230')).resolves.toEqual(generic);
      expect(prisma.otp.create).not.toHaveBeenCalled();
    });

    it('resend: respects the 5-per-15-minutes cap', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ kycStatus: 'PENDING', isPhoneVerified: false }));
      prisma.otp.count.mockResolvedValue(5);
      await expect(service.resendRegistrationOtp('+9230')).rejects.toThrow(/Too many OTP requests/);
    });
  });

  describe('forgotPassword', () => {
    it('gives the identical response for unknown and known accounts', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      const unknown = await service.forgotPassword('nobody@x.com');
      prisma.user.findFirst.mockResolvedValue(user());
      const known = await service.forgotPassword('+9230');
      expect(unknown).toEqual(known);
      expect(prisma.otp.create).toHaveBeenCalledTimes(1); // only the real account got a code
    });

    it('does not reveal suspended accounts or rate limiting', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ isActive: false }));
      await expect(service.forgotPassword('+9230')).resolves.toHaveProperty('message');
      prisma.user.findFirst.mockResolvedValue(user());
      prisma.otp.count.mockResolvedValue(99);
      await expect(service.forgotPassword('+9230')).resolves.toHaveProperty('message');
    });
  });

  describe('OTP verification', () => {
    const live = { id: 'o1', code: '123456', attempts: 0 };

    it('generates 6-digit numeric codes', async () => {
      prisma.user.findFirst.mockResolvedValue(user());
      await service.forgotPassword('+9230');
      expect(prisma.otp.create.mock.calls[0][0].data.code).toMatch(/^\d{6}$/);
    });

    it('counts a wrong guess against the OTP', async () => {
      prisma.user.findFirst.mockResolvedValue(user());
      prisma.otp.findFirst.mockResolvedValue(live);
      await expect(service.verifyOtp({ identifier: '+9230', otp: '000001', purpose: 'phone_verify' } as any)).rejects.toThrow('Invalid or expired OTP');
      expect(prisma.otp.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { attempts: { increment: 1 } } });
    });

    it('locks after 5 wrong guesses even if the next guess is correct', async () => {
      prisma.user.findFirst.mockResolvedValue(user());
      prisma.otp.findFirst.mockResolvedValue({ ...live, attempts: 5 });
      await expect(service.verifyOtp({ identifier: '+9230', otp: '123456', purpose: 'phone_verify' } as any)).rejects.toThrow(/Too many incorrect attempts/);
      expect(prisma.otp.update).not.toHaveBeenCalled();
    });

    it('accepts the right code and marks it used', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ kycStatus: 'PENDING' }));
      prisma.otp.findFirst.mockResolvedValue(live);
      prisma.user.update.mockResolvedValue(user({ kycStatus: 'SUBMITTED' }));
      const res: any = await service.verifyOtp({ identifier: '+9230', otp: '123456', purpose: 'phone_verify' } as any);
      expect(prisma.otp.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { isUsed: true } });
      expect(res.registrationToken).toBeTruthy();
    });

    it('does not reveal whether the account exists', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp({ identifier: 'x', otp: '1', purpose: 'phone_verify' } as any)).rejects.toThrow(BadRequestException);
    });

    it('throttles code requests per account', async () => {
      prisma.user.findFirst.mockResolvedValue(user());
      prisma.otp.count.mockResolvedValue(5);
      await expect((service as any).createOtp('u1', 'phone_verify')).rejects.toThrow(/Too many OTP requests/);
    });

    it('password reset ends all sessions', async () => {
      prisma.user.findFirst.mockResolvedValue(user());
      prisma.otp.findFirst.mockResolvedValue(live);
      await service.resetPassword({ identifier: '+9230', otp: '123456', newPassword: 'NewPass1!' } as any);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { isRevoked: true, revokedAt: expect.any(Date) } });
    });
  });

  describe('login', () => {
    it('does not reveal a suspended account to someone with the wrong password', async () => {
      prisma.user.findFirst.mockResolvedValue(user({ isActive: false, passwordHash: await bcrypt.hash('right', 4) }));
      await expect(service.login({ identifier: '+9230', password: 'wrong' } as any)).rejects.toThrow('Invalid credentials');
    });
  });
});
