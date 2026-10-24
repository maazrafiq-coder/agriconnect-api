import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TransportService } from './testing.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('TransportService — quote → accept → track', () => {
  let service: TransportService;
  let prisma: any;
  let notifications: { notify: jest.Mock };
  let row: any;

  const base = () => ({
    id: 'r1', requesterId: 'buyer-1', providerId: 'prov-1', status: 'REQUESTED',
    pickupCity: 'Lahore', deliveryCity: 'Karachi', quotedPrice: null, agreedPrice: null,
  });

  beforeEach(async () => {
    row = base();
   
    
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          phoneNumber: '+923001234567',
          profile: { fullName: 'Test Buyer' },
        }),
      },
      transportProfile: {
        findUnique: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            where?.userId === 'prov-1'
              ? { userId: 'prov-1', isActive: true }
              : null,
          ),
        ),
      },
      transportRequest: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'new',
            requestSeq: 1,
            createdAt: new Date('2026-10-24T00:00:00Z'),
            ...data,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }: any) =>
          Promise.resolve({
            ...row,
            id: where?.id ?? row.id,
            ...data,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transportQuoteRound: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) =>
        callback(prisma),
      ),
    };


    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const ref = await Test.createTestingModule({
      providers: [TransportService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: notifications }],
    }).compile();
    service = ref.get(TransportService);
  });

  describe('request / book', () => {
    it('creating a request for a provider notifies them; an unknown provider is a 404', async () => {
      await service.createRequest('buyer-1', { pickupLocation: 'a', pickupCity: 'Lahore', deliveryLocation: 'b', deliveryCity: 'Karachi', providerId: 'prov-1' } as any);
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'prov-1', type: 'TRANSPORT_UPDATE' }));
      prisma.transportProfile.findUnique.mockResolvedValue(null);
      await expect(service.createRequest('buyer-1', { providerId: 'ghost' } as any)).rejects.toThrow(NotFoundException);
    });

    it('book() no longer sets a price or BOOKED — it asks the provider for a quote, ignoring any client price', async () => {
      await service.bookTransport('buyer-1', { requestId: 'r1', providerId: 'prov-1', agreedPrice: 1 } as any);
      const data = prisma.transportRequest.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ providerId: 'prov-1', status: 'REQUESTED', quotedPrice: null, agreedPrice: null });
    });

    it('book() refuses someone else’s request, and one already booked', async () => {
      await expect(service.bookTransport('intruder', { requestId: 'r1', providerId: 'prov-1' } as any)).rejects.toThrow(ForbiddenException);
      row.status = 'BOOKED';
      await expect(service.bookTransport('buyer-1', { requestId: 'r1', providerId: 'prov-1' } as any)).rejects.toThrow(/already booked/);
    });
  });

 });
