import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Round 2, Milestone 5 — registration data model completion.
 *
 * Covers UsersService.updateProfile(): the profile-existence check (a
 * user without a UserProfile row — shouldn't normally happen given
 * registration always creates one, but worth guarding rather than
 * letting Prisma throw a raw "record not found" error) and that the
 * validated DTO is passed straight through to the update.
 */
describe('UsersService.updateProfile', () => {
  let service: UsersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'profile-1', userId: 'user-1' }),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'profile-1', userId: 'user-1', ...data })),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } }],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('updates the profile with the given fields', async () => {
    const result = await service.updateProfile('user-1', { city: 'Multan', province: 'Punjab' } as any);
    expect(prisma.userProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { city: 'Multan', province: 'Punjab' },
    });
    expect(result.city).toBe('Multan');
  });

  it('throws NotFoundException if the user has no profile row', async () => {
    prisma.userProfile.findUnique.mockResolvedValue(null);
    await expect(service.updateProfile('ghost-user', { city: 'Lahore' } as any)).rejects.toThrow(NotFoundException);
    expect(prisma.userProfile.update).not.toHaveBeenCalled();
  });

  it('accepts an empty update (no-op fields) without error', async () => {
    await expect(service.updateProfile('user-1', {} as any)).resolves.toBeDefined();
  });
});
