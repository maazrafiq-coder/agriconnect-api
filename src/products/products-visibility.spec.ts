import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';

/** Milestone 1 - GET /products/:id must not leak non-live listings or seller PII. */
describe('ProductsService.findOne visibility', () => {
  let service: ProductsService;
  let prisma: any;

  const product = (status: string) => ({
    id: 'p1', sellerId: 'seller1', status, media: [],
    seller: { id: 'seller1', ratingsReceived: [{ rating: 4 }, { rating: 5 }], profile: { fullName: 'A' } },
  });

  beforeEach(async () => {
    prisma = {
      product: { findUnique: jest.fn(), update: jest.fn() },
      offer: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } },
        { provide: StorageService, useValue: { getSignedUrl: jest.fn(), isEnabled: () => false } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  it.each(['ACTIVE', 'UNDER_OFFER', 'SOLD'])('guests can open a %s listing', async (st) => {
    prisma.product.findUnique.mockResolvedValue(product(st));
    await expect(service.findOne('p1')).resolves.toMatchObject({ id: 'p1' });
  });

  it.each(['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'PAUSED', 'REMOVED'])('guests get 404 for a %s listing', async (st) => {
    prisma.product.findUnique.mockResolvedValue(product(st));
    await expect(service.findOne('p1')).rejects.toThrow(NotFoundException);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('other logged-in users get 404 too', async () => {
    prisma.product.findUnique.mockResolvedValue(product('PENDING_REVIEW'));
    await expect(service.findOne('p1', { id: 'someone', role: 'BUYER' })).rejects.toThrow(NotFoundException);
  });

  it('the owner can open their own pending listing (and it does not bump views)', async () => {
    prisma.product.findUnique.mockResolvedValue(product('PENDING_REVIEW'));
    await expect(service.findOne('p1', { id: 'seller1', role: 'SELLER' })).resolves.toBeDefined();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'MODERATOR'])('%s can open any listing for review', async (role) => {
    prisma.product.findUnique.mockResolvedValue(product('REJECTED'));
    await expect(service.findOne('p1', { id: 'staff', role })).resolves.toBeDefined();
  });

  it('a buyer with an existing offer can still open a paused listing', async () => {
    prisma.product.findUnique.mockResolvedValue(product('PAUSED'));
    prisma.offer.findFirst.mockResolvedValue({ id: 'o1' });
    await expect(service.findOne('p1', { id: 'buyer1', role: 'BUYER' })).resolves.toBeDefined();
  });

  it('selects only public seller profile fields (no CNIC / bank / DOB)', async () => {
    prisma.product.findUnique.mockResolvedValue(product('ACTIVE'));
    await service.findOne('p1');
    const sel = prisma.product.findUnique.mock.calls[0][0].include.seller.select.profile.select;
    expect(Object.keys(sel).sort()).toEqual(['businessName', 'city', 'farmLocation', 'fullName', 'profilePhotoUrl', 'province']);
    for (const bad of ['cnicNumber', 'dateOfBirth', 'address', 'bankAccountNo', 'iban', 'ntnNumber']) {
      expect(sel).not.toHaveProperty(bad);
    }
  });
});
