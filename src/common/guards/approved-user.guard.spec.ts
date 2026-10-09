import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApprovedUserGuard } from './approved-user.guard';

function ctx(user: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
}

describe('ApprovedUserGuard', () => {
  let guard: ApprovedUserGuard;
  let authSpy: jest.SpyInstance;

  beforeEach(() => {
    guard = new ApprovedUserGuard();
    // Stub the passport step so we test only the approval rule.
    authSpy = jest.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true as any);
  });
  afterEach(() => authSpy.mockRestore());

  it('allows an APPROVED user', async () => {
    await expect(guard.canActivate(ctx({ id: 'u', kycStatus: 'APPROVED' }))).resolves.toBe(true);
  });

  it.each(['INFO_REQUESTED', 'PENDING', 'SUBMITTED', 'REJECTED', undefined])('blocks kycStatus %s', async (s) => {
    await expect(guard.canActivate(ctx({ id: 'u', kycStatus: s }))).rejects.toThrow(ForbiddenException);
  });

  it('does not bypass authentication failure', async () => {
    authSpy.mockResolvedValue(false as any);
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(false);
  });
});
