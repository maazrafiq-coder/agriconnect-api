import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Milestone 1 - registration / file-access tokens must never work as a
 * login session, and suspension / rejection must bite immediately.
 */
describe('JwtStrategy.validate', () => {
  let prisma: any;
  let strategy: JwtStrategy;
  const config: any = { get: () => 'x'.repeat(32) };

  const activeUser = { id: 'u1', phoneNumber: '+92300', role: 'BUYER', kycStatus: 'APPROVED', isActive: true };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(activeUser) } };
    strategy = new JwtStrategy(config, prisma);
  });

  it('accepts a normal access token and returns LIVE role/kycStatus from the DB', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, role: 'SELLER' });
    const res = await strategy.validate({ sub: 'u1', role: 'BUYER', kycStatus: 'PENDING' });
    expect(res).toMatchObject({ id: 'u1', role: 'SELLER', kycStatus: 'APPROVED' });
  });

  it('rejects a registration token', async () => {
    await expect(strategy.validate({ sub: 'u1', type: 'registration' })).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a KYC file-access token', async () => {
    await expect(strategy.validate({ sub: 'doc1', purpose: 'kyc_file_access' })).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with no subject', async () => {
    await expect(strategy.validate({})).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(strategy.validate({ sub: 'gone' })).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a suspended user immediately, even with an unexpired token', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, isActive: false });
    await expect(strategy.validate({ sub: 'u1' })).rejects.toThrow(UnauthorizedException);
  });

  it.each(['PENDING', 'SUBMITTED', 'RECOMMENDED', 'REJECTED'])('rejects kycStatus %s', async (kycStatus) => {
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, kycStatus });
    await expect(strategy.validate({ sub: 'u1' })).rejects.toThrow(UnauthorizedException);
  });

  it('allows INFO_REQUESTED so the user can answer the admin', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, kycStatus: 'INFO_REQUESTED' });
    await expect(strategy.validate({ sub: 'u1' })).resolves.toMatchObject({ kycStatus: 'INFO_REQUESTED' });
  });
});
