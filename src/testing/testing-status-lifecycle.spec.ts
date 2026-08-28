import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TestingService } from './testing.service';
import { PrismaService } from '../prisma/prisma.service';
import { TestingStatus } from '@prisma/client';

/**
 * Round 2, Milestone 7 — testing request status state machine.
 *
 * Before this milestone, PATCH /testing/requests/:id/status accepted any
 * TestingStatus from either the requester or the agency, with no
 * transition rules — most seriously, a requester could set their own
 * request straight to COMPLETED, bypassing submitReport (the endpoint
 * that's supposed to be the only legitimate, agency-only way to
 * complete a request). These tests cover the new allow-list, and confirm
 * COMPLETED is rejected outright from this endpoint regardless of party
 * or current status.
 */
describe('TestingService — status lifecycle', () => {
  let service: TestingService;
  let prisma: any;

  const baseRequest = {
    id: 'req-1',
    requesterId: 'requester-1',
    agencyId: 'agency-1',
    status: TestingStatus.REQUESTED,
  };

  beforeEach(async () => {
    prisma = {
      testingRequest: {
        findUnique: jest.fn().mockResolvedValue(baseRequest),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ ...baseRequest, ...data })),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [TestingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(TestingService);
  });

  it('lets the agency move REQUESTED -> ASSIGNED', async () => {
    const result = await service.updateStatus('req-1', 'agency-1', TestingStatus.ASSIGNED);
    expect(result.status).toBe(TestingStatus.ASSIGNED);
  });

  it('does NOT let the requester move REQUESTED -> ASSIGNED', async () => {
    await expect(
      service.updateStatus('req-1', 'requester-1', TestingStatus.ASSIGNED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets either party CANCEL a REQUESTED request', async () => {
    await expect(service.updateStatus('req-1', 'requester-1', TestingStatus.CANCELLED)).resolves.toBeDefined();
    await expect(service.updateStatus('req-1', 'agency-1', TestingStatus.CANCELLED)).resolves.toBeDefined();
  });

  it('rejects COMPLETED from this endpoint no matter who asks or what the current status is', async () => {
    await expect(
      service.updateStatus('req-1', 'agency-1', TestingStatus.COMPLETED),
    ).rejects.toThrow(BadRequestException);

    prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.IN_PROGRESS });
    await expect(
      service.updateStatus('req-1', 'requester-1', TestingStatus.COMPLETED),
    ).rejects.toThrow(BadRequestException);
  });

  it('only the agency can move SAMPLE_COLLECTED -> IN_PROGRESS, or cancel from IN_PROGRESS', async () => {
    prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.SAMPLE_COLLECTED });
    await expect(
      service.updateStatus('req-1', 'requester-1', TestingStatus.IN_PROGRESS),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.updateStatus('req-1', 'agency-1', TestingStatus.IN_PROGRESS)).resolves.toBeDefined();

    prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.IN_PROGRESS });
    await expect(
      service.updateStatus('req-1', 'requester-1', TestingStatus.CANCELLED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a caller who is neither the requester nor the agency', async () => {
    await expect(
      service.updateStatus('req-1', 'someone-else', TestingStatus.CANCELLED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('404s on a nonexistent request', async () => {
    prisma.testingRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.updateStatus('req-1', 'agency-1', TestingStatus.CANCELLED),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects transitions out of a terminal state (CANCELLED)', async () => {
    prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.CANCELLED });
    await expect(
      service.updateStatus('req-1', 'agency-1', TestingStatus.ASSIGNED),
    ).rejects.toThrow(BadRequestException);
  });

  describe('submitReport guards (Milestone 7 addition)', () => {
    it('refuses to submit a report for a CANCELLED request', async () => {
      prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.CANCELLED });
      await expect(
        service.submitReport('req-1', 'agency-1', { reportUrl: 'x', reportData: {} }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to submit a second report for an already-COMPLETED request', async () => {
      prisma.testingRequest.findUnique.mockResolvedValue({ ...baseRequest, status: TestingStatus.COMPLETED });
      await expect(
        service.submitReport('req-1', 'agency-1', { reportUrl: 'x', reportData: {} }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
