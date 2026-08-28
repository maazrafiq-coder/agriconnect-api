import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TestingService, TransportService } from './testing.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Round 2, Milestone 6 — provider account fixes.
 *
 * TestingAgencyProfile and TransportProfile have always had an
 * `isVerified` column (used for sort order in their own public browse
 * queries), but neither service had any way to actually set it —
 * WarehouseService had `adminVerify`, these two didn't. This covers the
 * two new methods that close that gap, mirroring
 * WarehouseService.adminVerify's shape (including the 404 guard).
 */
describe('TestingService.adminVerify', () => {
  let service: TestingService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      testingAgencyProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'agency-1', isVerified: false }),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [TestingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(TestingService);
  });

  it('marks an existing agency as verified', async () => {
    const result = await service.adminVerify('agency-1', true);
    expect(prisma.testingAgencyProfile.update).toHaveBeenCalledWith({
      where: { id: 'agency-1' },
      data: { isVerified: true },
    });
    expect(result.isVerified).toBe(true);
  });

  it('can also unverify a previously-verified agency', async () => {
    await service.adminVerify('agency-1', false);
    expect(prisma.testingAgencyProfile.update).toHaveBeenCalledWith({
      where: { id: 'agency-1' },
      data: { isVerified: false },
    });
  });

  it('404s on a missing agency rather than a raw Prisma error', async () => {
    prisma.testingAgencyProfile.findUnique.mockResolvedValue(null);
    await expect(service.adminVerify('ghost-agency', true)).rejects.toThrow(NotFoundException);
    expect(prisma.testingAgencyProfile.update).not.toHaveBeenCalled();
  });
});

describe('TransportService.adminVerify', () => {
  let service: TransportService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      transportProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'transport-1', isVerified: false }),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [TransportService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(TransportService);
  });

  it('marks an existing provider as verified', async () => {
    const result = await service.adminVerify('transport-1', true);
    expect(prisma.transportProfile.update).toHaveBeenCalledWith({
      where: { id: 'transport-1' },
      data: { isVerified: true },
    });
    expect(result.isVerified).toBe(true);
  });

  it('404s on a missing provider rather than a raw Prisma error', async () => {
    prisma.transportProfile.findUnique.mockResolvedValue(null);
    await expect(service.adminVerify('ghost-provider', true)).rejects.toThrow(NotFoundException);
    expect(prisma.transportProfile.update).not.toHaveBeenCalled();
  });
});
