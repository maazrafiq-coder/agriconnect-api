import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
      transportProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'prov-1', isActive: true }) },
      transportRequest: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'new', pickupCity: data.pickupCity, deliveryCity: data.deliveryCity, ...data })),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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

  describe('quote', () => {
    it('provider sends a price → QUOTED, requester notified', async () => {
      await service.quote('r1', 'prov-1', { price: 45000, note: 'incl. loading' } as any);
      expect(prisma.transportRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'QUOTED', quotedPrice: 45000, quoteNote: 'incl. loading' }),
      }));
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'buyer-1', title: expect.stringMatching(/quote/i) }));
    });

    it('only the assigned provider can quote, and only before booking', async () => {
      await expect(service.quote('r1', 'other-prov', { price: 1 } as any)).rejects.toThrow(ForbiddenException);
      row.status = 'BOOKED';
      await expect(service.quote('r1', 'prov-1', { price: 1 } as any)).rejects.toThrow(BadRequestException);
    });

    it('may re-quote a QUOTED request', async () => {
      row.status = 'QUOTED';
      await expect(service.quote('r1', 'prov-1', { price: 40000 } as any)).resolves.toBeDefined();
    });
  });

  describe('acceptQuote', () => {
    beforeEach(() => { row = { ...base(), status: 'QUOTED', quotedPrice: 45000 }; });

    it('BOOKED at exactly the quoted price (guarded on that price), provider notified', async () => {
      await service.acceptQuote('r1', 'buyer-1');
      expect(prisma.transportRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', status: 'QUOTED', quotedPrice: 45000 },
        data: { status: 'BOOKED', agreedPrice: 45000 },
      });
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'prov-1' }));
    });

    it('refuses when there is no quote, for strangers, and when the quote changed under you', async () => {
      await expect(service.acceptQuote('r1', 'intruder')).rejects.toThrow(ForbiddenException);
      row = { ...base(), status: 'REQUESTED' };
      await expect(service.acceptQuote('r1', 'buyer-1')).rejects.toThrow(/no quote/);
      row = { ...base(), status: 'QUOTED', quotedPrice: 45000 };
      prisma.transportRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.acceptQuote('r1', 'buyer-1')).rejects.toThrow(/quote changed/);
    });
  });

  describe('decline / cancel', () => {
    it('provider decline needs a reason, then unassigns the request and tells the requester', async () => {
      await expect(service.declineRequest('r1', 'prov-1', 'no')).rejects.toThrow(/reason/);
      await service.declineRequest('r1', 'prov-1', 'No trucks that week');
      expect(prisma.transportRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerId: null, status: 'REQUESTED' }) }));
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'buyer-1' }));
    });

    it('requester can cancel until pickup, not after', async () => {
      row.status = 'BOOKED';
      await service.cancelRequest('r1', 'buyer-1');
      expect(prisma.transportRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }));
      row.status = 'IN_TRANSIT';
      await expect(service.cancelRequest('r1', 'buyer-1')).rejects.toThrow(/already been picked up/);
    });
  });

  describe('tracking', () => {
    it('walks BOOKED → PICKED_UP → IN_TRANSIT → DELIVERED and notifies the requester each time', async () => {
      row.status = 'BOOKED';
      await service.updateTracking('r1', 'prov-1', { status: 'PICKED_UP', currentLocation: 'Lahore depot' } as any);
      const first = prisma.transportRequest.updateMany.mock.calls[0][0];
      expect(first.data).toMatchObject({ status: 'PICKED_UP', pickedUpAt: expect.any(Date), currentLocation: 'Lahore depot' });
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'buyer-1', title: 'Shipment picked up' }));
      row.status = 'IN_TRANSIT';
      await service.updateTracking('r1', 'prov-1', { status: 'DELIVERED' } as any);
      expect(prisma.transportRequest.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(Date) });
    });

    it('rejects skipping steps, going backwards, or tracking an un-booked request', async () => {
      row.status = 'BOOKED';
      await expect(service.updateTracking('r1', 'prov-1', { status: 'DELIVERED' } as any)).rejects.toThrow(/can't move/);
      row.status = 'DELIVERED';
      await expect(service.updateTracking('r1', 'prov-1', { currentLocation: 'x' } as any)).rejects.toThrow(/can't be updated/);
      row.status = 'QUOTED';
      await expect(service.updateTracking('r1', 'prov-1', { status: 'PICKED_UP' } as any)).rejects.toThrow(BadRequestException);
    });

    it('only the assigned provider can update tracking', async () => {
      row.status = 'BOOKED';
      await expect(service.updateTracking('r1', 'other', { status: 'PICKED_UP' } as any)).rejects.toThrow(ForbiddenException);
    });

    it('a status update that lost a race fails instead of overwriting', async () => {
      row.status = 'BOOKED';
      prisma.transportRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.updateTracking('r1', 'prov-1', { status: 'PICKED_UP' } as any)).rejects.toThrow(/just updated/);
    });
  });
});
