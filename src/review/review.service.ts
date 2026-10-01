// src/review/review.service.ts
//
// Round 2 Milestone 3: reusable two-way clarification workflow. See the
// ReviewClarification model comment in schema.prisma for why this is
// generic (subjectType/subjectId) rather than hard-wired to User KYC.
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ClarificationStatus } from '@prisma/client';
import { IsString, IsIn, MinLength } from 'class-validator';

// Allow-list of subject types this endpoint accepts. USER_KYC was the
// only one wired up in Milestone 3; Milestone 6 (Round 2) adds the three
// provider profile types below — reusing this exact same clarification
// thread/attachment/token machinery for provider listing review, which
// is exactly why this was built generic in the first place (see
// ReviewClarification's model comment in schema.prisma).
const SUPPORTED_SUBJECT_TYPES = [
  'USER_KYC',
  'WAREHOUSE_PROFILE',
  'TESTING_AGENCY_PROFILE',
  'TRANSPORT_PROFILE',
] as const;

export class CreateClarificationDto {
  @IsIn(SUPPORTED_SUBJECT_TYPES) subjectType: string;
  @IsString() subjectId: string;
  @IsString() @MinLength(5) requestMessage: string;
}

export class RespondClarificationDto {
  @IsString() @MinLength(2) responseMessage: string;
}

@Injectable()
export class ReviewService {
  private readonly FILE_TOKEN_TTL = '5m';

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // Resolves "who is allowed to respond to / view this subject" — the
  // single place that needed a new case for Milestone 6's three provider
  // profile types. For all of them `subjectId` is the profile's own
  // `.id` (matching how every existing admin route for these profiles
  // — adminSetActive, adminVerify, etc. — already addresses them), NOT
  // the operator's `userId`; the owner is resolved via the profile's
  // `userId` column instead.
  private async resolveSubjectOwnerId(subjectType: string, subjectId: string): Promise<string> {
    switch (subjectType) {
      case 'USER_KYC': {
        const user = await this.prisma.user.findUnique({ where: { id: subjectId }, select: { id: true } });
        if (!user) throw new NotFoundException('Subject not found');
        return user.id;
      }
      case 'WAREHOUSE_PROFILE': {
        const profile = await this.prisma.warehouseProfile.findUnique({ where: { id: subjectId }, select: { userId: true } });
        if (!profile) throw new NotFoundException('Subject not found');
        return profile.userId;
      }
      case 'TESTING_AGENCY_PROFILE': {
        const profile = await this.prisma.testingAgencyProfile.findUnique({ where: { id: subjectId }, select: { userId: true } });
        if (!profile) throw new NotFoundException('Subject not found');
        return profile.userId;
      }
      case 'TRANSPORT_PROFILE': {
        const profile = await this.prisma.transportProfile.findUnique({ where: { id: subjectId }, select: { userId: true } });
        if (!profile) throw new NotFoundException('Subject not found');
        return profile.userId;
      }
      default:
        throw new BadRequestException(`Unsupported subject type: ${subjectType}`);
    }
  }

  // ─── ADMIN/MODERATOR: open a clarification request ─────────────────────
  async requestClarification(requestedById: string, dto: CreateClarificationDto) {
    await this.resolveSubjectOwnerId(dto.subjectType, dto.subjectId); // 404s if subject doesn't exist

    const clarification = await this.prisma.reviewClarification.create({
      data: {
        subjectType: dto.subjectType,
        subjectId: dto.subjectId,
        requestedById,
        requestMessage: dto.requestMessage,
        status: ClarificationStatus.OPEN,
      },
    });

    if (dto.subjectType === 'USER_KYC') {
      await this.prisma.user.update({
        where: { id: dto.subjectId },
        data: {
          kycStatus: 'INFO_REQUESTED',
          // Denormalized "latest request" cache — see schema.prisma comment.
          kycInfoRequestNote: dto.requestMessage,
          kycInfoRequestedAt: clarification.createdAt,
        },
      });
    }
    // Provider profile clarifications (Milestone 6) are deliberately
    // communication-only — unlike KYC, `isActive`/`isVerified` on
    // WarehouseProfile/TestingAgencyProfile/TransportProfile are plain
    // admin-controlled booleans, not a review-state machine, so opening
    // a clarification here has no automatic side effect on them. An
    // admin can still flip `isActive`/`isVerified` separately (e.g. to
    // unlist a listing while its clarification is outstanding) — that's
    // just not implied by asking a question.

    return clarification;
  }

  // ─── SUBJECT (or admin/moderator): respond, optionally with files ──────
  async respondToClarification(
    userId: string,
    role: string,
    clarificationId: string,
    dto: RespondClarificationDto,
    files: Array<{ originalname: string; filename: string }> = [],
  ) {
    const clarification = await this.prisma.reviewClarification.findUnique({ where: { id: clarificationId } });
    if (!clarification) throw new NotFoundException('Clarification request not found');

    const ownerId = await this.resolveSubjectOwnerId(clarification.subjectType, clarification.subjectId);
    const isOwner = ownerId === userId;
    const isReviewer = role === 'ADMIN' || role === 'MODERATOR';
    if (!isOwner && !isReviewer) throw new ForbiddenException('Access denied');
    if (clarification.status === ClarificationStatus.RESOLVED) {
      throw new BadRequestException('This request has already been resolved and can no longer be responded to');
    }

    await this.prisma.reviewClarification.update({
      where: { id: clarificationId },
      data: {
        status: ClarificationStatus.RESPONDED,
        responseMessage: dto.responseMessage,
        respondedAt: new Date(),
      },
    });

    if (files.length) {
      await this.prisma.clarificationAttachment.createMany({
        data: files.map((f) => ({
          clarificationId,
          uploadedById: userId,
          fileName: f.originalname,
          s3Key: f.filename,
        })),
      });
    }

    // The subject answered — put them back in front of a reviewer instead
    // of leaving them stuck showing "more info needed" after they already
    // provided it.
    if (clarification.subjectType === 'USER_KYC' && isOwner) {
      await this.prisma.user.update({ where: { id: ownerId }, data: { kycStatus: 'SUBMITTED' } });
    }

    return this.prisma.reviewClarification.findUnique({
      where: { id: clarificationId },
      include: { attachments: true },
    });
  }

  // ─── ADMIN/MODERATOR: mark resolved (used to help decide approve/reject) ─
  async resolveClarification(resolvedById: string, clarificationId: string) {
    const clarification = await this.prisma.reviewClarification.findUnique({ where: { id: clarificationId } });
    if (!clarification) throw new NotFoundException('Clarification request not found');

    return this.prisma.reviewClarification.update({
      where: { id: clarificationId },
      data: { status: ClarificationStatus.RESOLVED, resolvedById, resolvedAt: new Date() },
    });
  }

  // ─── Full thread for a subject (owner, or admin/moderator) ─────────────
  async listForSubject(subjectType: string, subjectId: string, requesterId: string, requesterRole: string) {
    const ownerId = await this.resolveSubjectOwnerId(subjectType, subjectId);
    const isOwner = ownerId === requesterId;
    const isReviewer = requesterRole === 'ADMIN' || requesterRole === 'MODERATOR';
    if (!isOwner && !isReviewer) throw new ForbiddenException('Access denied');

    return this.prisma.reviewClarification.findMany({
      where: { subjectType, subjectId },
      include: { attachments: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Convenience for the most common case: "my own KYC clarification thread".
  async listMyKycClarifications(userId: string) {
    return this.listForSubject('USER_KYC', userId, userId, 'BUYER'); // role arg unused when isOwner is already true
  }

  // Convenience for a provider operator's own listing clarification
  // thread(s). Needs the profile's `.id` (not `userId`) as subjectId, and
  // needs to look that profile up first since the operator only knows "I
  // am this user", not "my warehouse profile has this id". A warehouse
  // operator can now own more than one warehouse (NEW_Changes item 10),
  // so this fans out across all of them and merges the threads.
  async listMyProviderClarifications(
    userId: string,
    subjectType: 'WAREHOUSE_PROFILE' | 'TESTING_AGENCY_PROFILE' | 'TRANSPORT_PROFILE',
  ) {
    const profileIds = await this.findOwnProviderProfileIds(userId, subjectType);
    if (!profileIds.length) return [];
    const threads = await Promise.all(
      profileIds.map((id) => this.listForSubject(subjectType, id, userId, 'BUYER')), // role arg unused when isOwner is already true
    );
    return threads.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private async findOwnProviderProfileIds(
    userId: string,
    subjectType: 'WAREHOUSE_PROFILE' | 'TESTING_AGENCY_PROFILE' | 'TRANSPORT_PROFILE',
  ): Promise<string[]> {
    switch (subjectType) {
      case 'WAREHOUSE_PROFILE': {
        // findMany, not findUnique — userId is no longer unique on
        // WarehouseProfile (an operator can run several warehouses).
        const rows = await this.prisma.warehouseProfile.findMany({ where: { userId }, select: { id: true } });
        return rows.map((r) => r.id);
      }
      case 'TESTING_AGENCY_PROFILE': {
        const p = await this.prisma.testingAgencyProfile.findUnique({ where: { userId }, select: { id: true } });
        return p ? [p.id] : [];
      }
      case 'TRANSPORT_PROFILE': {
        const p = await this.prisma.transportProfile.findUnique({ where: { userId }, select: { id: true } });
        return p ? [p.id] : [];
      }
    }
  }

  // ─── Signed, short-lived, single-file access token (same pattern as
  // AuthService.getKycDocumentSignedUrl / resolveKycFileToken) ────────────
  async getAttachmentSignedUrl(attachmentId: string, requesterId: string, requesterRole: string) {
    const attachment = await this.prisma.clarificationAttachment.findUnique({
      where: { id: attachmentId },
      include: { clarification: true },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    const ownerId = await this.resolveSubjectOwnerId(
      attachment.clarification.subjectType,
      attachment.clarification.subjectId,
    );
    const isOwner = ownerId === requesterId;
    const isReviewer = requesterRole === 'ADMIN' || requesterRole === 'MODERATOR';
    if (!isOwner && !isReviewer) throw new ForbiddenException('You do not have permission to view this file');

    const token = this.jwt.sign(
      { sub: attachment.id, purpose: 'clarification_file_access' },
      { secret: this.config.get('JWT_SECRET'), expiresIn: this.FILE_TOKEN_TTL },
    );
    return { url: `/review/clarifications/attachments/file/${token}` };
  }

  // Round 2, Milestone 4: previously resolved to a local disk path; now
  // returns the bucket key itself, which the controller turns into a
  // short-lived presigned bucket URL via StorageService — see
  // AuthService.resolveKycFileToken for the mirrored KYC-side change.
  async resolveFileToken(token: string): Promise<{ s3Key: string; fileName: string }> {
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET') });
    } catch {
      throw new UnauthorizedException('This file link has expired. Please request it again.');
    }
    if (payload?.purpose !== 'clarification_file_access') {
      throw new UnauthorizedException('Invalid file link.');
    }

    const attachment = await this.prisma.clarificationAttachment.findUnique({ where: { id: payload.sub } });
    if (!attachment) throw new NotFoundException('File not found');

    // s3Key is server-generated (see s3-multer-storage.ts) — always
    // "<folder>/<generated-name>" — never user input. A "/" is now
    // expected (separates the bucket folder from the filename); only
    // ".." is refused as defense in depth against path traversal.
    if (attachment.s3Key.includes('..')) {
      throw new NotFoundException('File not found');
    }

    return {
      s3Key: attachment.s3Key,
      fileName: attachment.fileName,
    };
  }
}
