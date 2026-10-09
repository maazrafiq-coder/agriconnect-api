import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';

describe('ProductsService.update (Edit listing)', () => {
  let service: ProductsService;
  let prisma: any;
  const existing = (over: any = {}) => ({ id: 'p1', sellerId: 's1', status: 'ACTIVE', quantity: 500, minOrderQty: 50, ...over });

  beforeEach(async () => {
    prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(existing()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data })),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  it('404 / 403 for missing or someone else\'s listing', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.update('p1', 's1', {})).rejects.toThrow(NotFoundException);
    prisma.product.findUnique.mockResolvedValue(existing());
    await expect(service.update('p1', 'other', {})).rejects.toThrow(ForbiddenException);
  });

  it('updates all editable fields, converting harvestDate to a Date', async () => {
    await service.update('p1', 's1', {
      name: 'N', askingPrice: 4000, minOrderQty: 20, locationCity: 'Multan',
      locationProvince: 'Punjab', harvestDate: '2026-09-01', packagingType: 'PP', deliveryTerms: 'Ex-mill',
    });
    const data = prisma.product.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: 'N', askingPrice: 4000, locationCity: 'Multan', packagingType: 'PP' });
    expect(data.harvestDate).toBeInstanceOf(Date);
  });

  it('upserts rice details (the listing may not have had any)', async () => {
    const rd = { stage: 'MILLED_WHITE', variety: '1121' } as any;
    await service.update('p1', 's1', { riceDetails: rd });
    expect(prisma.product.update.mock.calls[0][0].data.riceDetails).toEqual({ upsert: { create: rd, update: rd } });
  });

  it('editing a REJECTED listing resubmits it for review', async () => {
    prisma.product.findUnique.mockResolvedValue(existing({ status: 'REJECTED' }));
    await service.update('p1', 's1', { name: 'Fixed' });
    expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({ status: 'PENDING_REVIEW', rejectionNote: null });
  });

  it.each(['SOLD', 'REMOVED'])('refuses to edit a %s listing', async (status) => {
    prisma.product.findUnique.mockResolvedValue(existing({ status }));
    await expect(service.update('p1', 's1', { name: 'x' })).rejects.toThrow(BadRequestException);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('refuses a minimum order larger than the quantity', async () => {
    await expect(service.update('p1', 's1', { minOrderQty: 600 })).rejects.toThrow(/Minimum order/);
    await expect(service.update('p1', 's1', { quantity: 10 })).rejects.toThrow(/Minimum order/); // existing min is 50
  });
});
