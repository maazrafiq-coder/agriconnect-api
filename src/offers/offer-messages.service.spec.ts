import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OfferMessagesService } from './offer-messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('OfferMessagesService', () => {
  let service: OfferMessagesService;
  let prisma: any;
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const offer = (status = 'PENDING') => ({ id: 'o1', buyerId: 'buyer', status, product: { name: 'Basmati', sellerId: 'seller' } });

  beforeEach(async () => {
    notifications.notify.mockClear();
    prisma = {
      offer: { findUnique: jest.fn().mockResolvedValue(offer()) },
      offerMessage: {
        findMany: jest.fn().mockResolvedValue([{ id: 'm1', body: 'hi', createdAt: new Date(), senderId: 'buyer', sender: { profile: { fullName: 'Ali' } } }]),
        create: jest.fn().mockResolvedValue({ id: 'm2' }),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        OfferMessagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(OfferMessagesService);
  });

  it('404s for an unknown offer', async () => {
    prisma.offer.findUnique.mockResolvedValue(null);
    await expect(service.list('x', 'buyer')).rejects.toThrow(NotFoundException);
  });

  it('blocks people who are neither the buyer nor the seller', async () => {
    await expect(service.list('o1', 'stranger')).rejects.toThrow(ForbiddenException);
    await expect(service.post('o1', 'stranger', { body: 'hi' })).rejects.toThrow(ForbiddenException);
    expect(prisma.offerMessage.create).not.toHaveBeenCalled();
  });

  it('marks which messages are mine', async () => {
    const rows = await service.list('o1', 'buyer');
    expect(rows[0]).toMatchObject({ mine: true, senderName: 'Ali' });
  });

  it('rejects empty messages and closed offers', async () => {
    await expect(service.post('o1', 'buyer', { body: '   ' })).rejects.toThrow(BadRequestException);
    prisma.offer.findUnique.mockResolvedValue(offer('EXPIRED'));
    await expect(service.post('o1', 'buyer', { body: 'hello' })).rejects.toThrow(BadRequestException);
  });

  it('buyer message notifies the seller; seller message notifies the buyer', async () => {
    await service.post('o1', 'buyer', { body: 'Can you do 3700?' });
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller' }));
    await service.post('o1', 'seller', { body: 'Yes' });
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer' }));
  });
});
