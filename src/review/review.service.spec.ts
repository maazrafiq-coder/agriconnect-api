import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ReviewService } from './review.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClarificationStatus } from '@prisma/client';

/**
 * Round 2, Milestone 3 — KYC clarification workflow.
 *
 * Covers the generic request → respond → resolve lifecycle, ownership
 * enforcement, the User.kycStatus side-effects (INFO_REQUESTED on
 * request, back to SUBMITTED on the subject's response), and the
 * signed-file-token pattern for attachments.
 */
describe('ReviewService — clarification workflow', () => {
  let service: ReviewService;
  let prisma: any;
  let jwt: JwtService;

  const baseClarification = {
    id: 'clar-1',
    subjectType: 'USER_KYC',
    subjectId: 'user-1',
    requestedById: 'admin-1',
    requestMessage: 'Please upload a clearer photo of your CNIC',
    status: ClarificationStatus.OPEN,
    createdAt: new Date('2026-03-01T00:00:00Z'),
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      reviewClarification: {
        create: jest.fn().mockResolvedValue(baseClarification),
        findUnique: jest.fn()
          .mockResolvedValueOnce(baseClarification) // existence/status check
          .mockResolvedValue({ ...baseClarification, status: ClarificationStatus.RESPONDED }), // post-update refetch
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ ...baseClarification, ...data })),
        findMany: jest.fn().mockResolvedValue([baseClarification]),
      },
      clarificationAttachment: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'att-1',
          fileName: 'cnic-front.jpg',
          s3Key: 'clarification-123.jpg',
          clarification: baseClarification,
        }),
      },
      // Round 2, Milestone 6 — provider profile subject types.
      warehouseProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wh-1', userId: 'operator-1' }),
      },
      testingAgencyProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'agency-1', userId: 'operator-2' }),
      },
      transportProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'transport-1', userId: 'operator-3' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret' })],
      providers: [
        ReviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'JWT_SECRET' ? 'test-secret' : undefined) } },
      ],
    }).compile();

    service = moduleRef.get(ReviewService);
    jwt = moduleRef.get(JwtService);
  });

  describe('requestClarification', () => {
    const dto = { subjectType: 'USER_KYC', subjectId: 'user-1', requestMessage: 'Need a clearer CNIC photo' };

    it('creates an OPEN clarification and flips the user to INFO_REQUESTED', async () => {
      const result = await service.requestClarification('admin-1', dto as any);
      expect(result.status).toBe(ClarificationStatus.OPEN);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({ kycStatus: 'INFO_REQUESTED' }),
        }),
      );
    });

    it('404s if the subject user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.requestClarification('admin-1', dto as any)).rejects.toThrow(NotFoundException);
    });

    it('rejects an unsupported subjectType', async () => {
      await expect(
        service.requestClarification('admin-1', { ...dto, subjectType: 'BOGUS_TYPE' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('respondToClarification', () => {
    const dto = { responseMessage: 'Here is a clearer photo, please check' };

    it('lets the subject respond and moves status to RESPONDED', async () => {
      const result = await service.respondToClarification('user-1', 'BUYER', 'clar-1', dto, []);
      expect(result.status).toBe(ClarificationStatus.RESPONDED);
    });

    it('puts the user back to SUBMITTED so it re-enters the review queue', async () => {
      await service.respondToClarification('user-1', 'BUYER', 'clar-1', dto, []);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' }, data: { kycStatus: 'SUBMITTED' } }),
      );
    });

    it('stores attachments when files are provided', async () => {
      await service.respondToClarification('user-1', 'BUYER', 'clar-1', dto, [
        { originalname: 'cnic-front.jpg', filename: 'clarification-123.jpg' } as any,
      ]);
      expect(prisma.clarificationAttachment.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ clarificationId: 'clar-1', uploadedById: 'user-1', fileName: 'cnic-front.jpg' })],
        }),
      );
    });

    it('lets an admin respond too (e.g. adding a follow-up note)', async () => {
      const result = await service.respondToClarification('admin-1', 'ADMIN', 'clar-1', dto, []);
      expect(result.status).toBe(ClarificationStatus.RESPONDED);
    });

    it('refuses an unrelated user', async () => {
      await expect(service.respondToClarification('random-user', 'BUYER', 'clar-1', dto, [])).rejects.toThrow(ForbiddenException);
    });

    it('refuses to respond to an already-RESOLVED request', async () => {
      prisma.reviewClarification.findUnique.mockReset().mockResolvedValue({ ...baseClarification, status: ClarificationStatus.RESOLVED });
      await expect(service.respondToClarification('user-1', 'BUYER', 'clar-1', dto, [])).rejects.toThrow(BadRequestException);
    });

    it('404s on a nonexistent clarification', async () => {
      prisma.reviewClarification.findUnique.mockReset().mockResolvedValue(null);
      await expect(service.respondToClarification('user-1', 'BUYER', 'clar-1', dto, [])).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolveClarification', () => {
    it('marks a clarification RESOLVED with resolver + timestamp', async () => {
      const result = await service.resolveClarification('admin-1', 'clar-1');
      expect(result.status).toBe(ClarificationStatus.RESOLVED);
      expect(prisma.reviewClarification.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: ClarificationStatus.RESOLVED, resolvedById: 'admin-1' }) }),
      );
    });
  });

  describe('listForSubject', () => {
    it('returns the thread for the owner', async () => {
      const result = await service.listForSubject('USER_KYC', 'user-1', 'user-1', 'BUYER');
      expect(result).toHaveLength(1);
    });

    it('returns the thread for an admin', async () => {
      const result = await service.listForSubject('USER_KYC', 'user-1', 'admin-1', 'ADMIN');
      expect(result).toHaveLength(1);
    });

    it('refuses an unrelated user', async () => {
      await expect(service.listForSubject('USER_KYC', 'user-1', 'random-user', 'BUYER')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('attachment signed URLs', () => {
    it('issues a signed URL for the owner', async () => {
      const result = await service.getAttachmentSignedUrl('att-1', 'user-1', 'BUYER');
      expect(result.url).toMatch(/^\/review\/clarifications\/attachments\/file\//);
    });

    it('issues a signed URL for a reviewer', async () => {
      const result = await service.getAttachmentSignedUrl('att-1', 'admin-1', 'ADMIN');
      expect(result.url).toBeDefined();
    });

    it('refuses an unrelated user', async () => {
      await expect(service.getAttachmentSignedUrl('att-1', 'random-user', 'BUYER')).rejects.toThrow(ForbiddenException);
    });

    it('resolves a valid token back to the bucket key', async () => {
      const { url } = await service.getAttachmentSignedUrl('att-1', 'user-1', 'BUYER');
      const token = url.split('/').pop();
      const resolved = await service.resolveFileToken(token);
      expect(resolved.fileName).toBe('cnic-front.jpg');
      expect(resolved.s3Key).toBe('clarification-123.jpg');
    });

    it('rejects a garbage token', async () => {
      await expect(service.resolveFileToken('not-a-real-token')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token issued for a different purpose', async () => {
      const wrongPurposeToken = jwt.sign({ sub: 'att-1', purpose: 'kyc_file_access' }, { secret: 'test-secret' });
      await expect(service.resolveFileToken(wrongPurposeToken)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a token pointing at a since-deleted attachment', async () => {
      const { url } = await service.getAttachmentSignedUrl('att-1', 'user-1', 'BUYER');
      const token = url.split('/').pop();
      prisma.clarificationAttachment.findUnique.mockResolvedValue(null);
      await expect(service.resolveFileToken(token)).rejects.toThrow(NotFoundException);
    });
  });

  // Round 2, Milestone 6 — provider profile clarifications, reusing the
  // exact same thread mechanics as USER_KYC above.
  describe('provider profile subject types (Milestone 6)', () => {
    it.each([
      ['WAREHOUSE_PROFILE', 'warehouseProfile', 'wh-1', 'operator-1'],
      ['TESTING_AGENCY_PROFILE', 'testingAgencyProfile', 'agency-1', 'operator-2'],
      ['TRANSPORT_PROFILE', 'transportProfile', 'transport-1', 'operator-3'],
    ])('opens a %s clarification against the profile owner, not the profile id', async (subjectType, model, profileId, ownerId) => {
      const dto = { subjectType, subjectId: profileId, requestMessage: 'Please clarify your listed capacity' };
      const result = await service.requestClarification('admin-1', dto as any);
      expect(result.status).toBe(ClarificationStatus.OPEN);
      expect((prisma as any)[model].findUnique).toHaveBeenCalledWith({
        where: { id: profileId },
        select: { userId: true },
      });
      // Unlike USER_KYC, opening a provider clarification must NOT touch
      // User.kycStatus or any other side effect — it's communication-only.
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s if the warehouse profile does not exist', async () => {
      prisma.warehouseProfile.findUnique.mockResolvedValue(null);
      const dto = { subjectType: 'WAREHOUSE_PROFILE', subjectId: 'ghost-wh', requestMessage: 'Please clarify your listed capacity' };
      await expect(service.requestClarification('admin-1', dto as any)).rejects.toThrow(NotFoundException);
    });

    it('lets the warehouse operator (the profile owner) respond, but not an unrelated user', async () => {
      prisma.reviewClarification.findUnique
        .mockReset()
        .mockResolvedValueOnce({ ...baseClarification, subjectType: 'WAREHOUSE_PROFILE', subjectId: 'wh-1' })
        .mockResolvedValue({ ...baseClarification, subjectType: 'WAREHOUSE_PROFILE', subjectId: 'wh-1', status: ClarificationStatus.RESPONDED });

      const result = await service.respondToClarification(
        'operator-1', 'WAREHOUSE', 'clar-1', { responseMessage: 'Capacity figure was a typo, corrected to 500 tons' }, [],
      );
      expect(result.status).toBe(ClarificationStatus.RESPONDED);
    });

    it('rejects a response from a user who does not own the warehouse profile', async () => {
      prisma.reviewClarification.findUnique
        .mockReset()
        .mockResolvedValue({ ...baseClarification, subjectType: 'WAREHOUSE_PROFILE', subjectId: 'wh-1' });

      await expect(
        service.respondToClarification('some-other-user', 'WAREHOUSE', 'clar-1', { responseMessage: 'Not my listing' }, []),
      ).rejects.toThrow(ForbiddenException);
    });

    describe('listMyProviderClarifications', () => {
      it("resolves the caller's own warehouse profile id before listing", async () => {
        await service.listMyProviderClarifications('operator-1', 'WAREHOUSE_PROFILE');
        expect(prisma.warehouseProfile.findUnique).toHaveBeenCalledWith({ where: { userId: 'operator-1' }, select: { id: true } });
        expect(prisma.reviewClarification.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { subjectType: 'WAREHOUSE_PROFILE', subjectId: 'wh-1' } }),
        );
      });

      it('returns an empty list rather than erroring if the caller has no provider profile yet', async () => {
        prisma.warehouseProfile.findUnique.mockResolvedValue(null);
        const result = await service.listMyProviderClarifications('brand-new-user', 'WAREHOUSE_PROFILE');
        expect(result).toEqual([]);
      });
    });
  });
});
