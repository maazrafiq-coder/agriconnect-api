import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService.adminSetActive', () => {
  let service: UsersService;
  let prisma: any;
  beforeEach(async () => {
    prisma = {
      user: { update: jest.fn().mockResolvedValue({ id: 'u1' }) },
      refreshToken: { updateMany: jest.fn() },
    };
    const mod = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } }],
    }).compile();
    service = mod.get(UsersService);
  });

  it('revokes every refresh token when suspending', async () => {
    await service.adminSetActive('u1', false);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { isRevoked: true } });
  });
  it('does not touch tokens when re-activating', async () => {
    await service.adminSetActive('u1', true);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
