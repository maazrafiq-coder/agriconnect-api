import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(3),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    service = new NotificationsService(prisma);
  });

  it('never throws when the write fails — notifying is best-effort', async () => {
    prisma.notification.create.mockRejectedValue(new Error('db down'));
    await expect(service.notify({ userId: 'u', type: 'SYSTEM' as any, title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('only returns the caller\'s notifications and caps the page size', async () => {
    await service.list('u1', 5000);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' }, take: 100 }));
  });

  it('counts unread for the caller only', async () => {
    await expect(service.unreadCount('u1')).resolves.toEqual({ count: 3 });
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: 'u1', isRead: false } });
  });

  it('refuses to mark someone else\'s notification as read (same 404 as missing)', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'someone-else', isRead: false });
    await expect(service.markRead('u1', 'n1')).rejects.toThrow(NotFoundException);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('marks own notification read, and mark-all only touches own unread', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'u1', isRead: false });
    await service.markRead('u1', 'n1');
    expect(prisma.notification.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n1' } }));
    await expect(service.markAllRead('u1')).resolves.toEqual({ updated: 2 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', isRead: false } }));
  });
});
