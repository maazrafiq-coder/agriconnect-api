// src/review/review.controller.ts
import {
  Controller, Get, Post, Patch, Param, Body, Query, UseGuards,
  UseInterceptors, UploadedFiles, Res,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  ReviewService, CreateClarificationDto, RespondClarificationDto,
} from './review.service';
import { StorageService } from '../common/storage/storage.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('review')
export class ReviewController {
  constructor(
    private reviewService: ReviewService,
    private storage: StorageService,
  ) {}

  // POST /review/clarifications — admin/moderator opens a request
  @Post('clarifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  create(@CurrentUser('id') adminId: string, @Body() dto: CreateClarificationDto) {
    return this.reviewService.requestClarification(adminId, dto);
  }

  // GET /review/clarifications?subjectType=USER_KYC&subjectId=... — full thread
  @Get('clarifications')
  @UseGuards(JwtAuthGuard)
  list(
    @Query('subjectType') subjectType: string,
    @Query('subjectId') subjectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.reviewService.listForSubject(subjectType, subjectId, userId, role);
  }

  // GET /review/clarifications/my/kyc — convenience: my own KYC thread
  @Get('clarifications/my/kyc')
  @UseGuards(JwtAuthGuard)
  myKyc(@CurrentUser('id') userId: string) {
    return this.reviewService.listMyKycClarifications(userId);
  }

  // GET /review/clarifications/my/provider/:subjectType — convenience:
  // "my own [warehouse|testing agency|transport] listing" clarification
  // thread. Round 2, Milestone 6.
  @Get('clarifications/my/provider/:subjectType')
  @UseGuards(JwtAuthGuard)
  myProviderClarifications(
    @Param('subjectType') subjectType: 'WAREHOUSE_PROFILE' | 'TESTING_AGENCY_PROFILE' | 'TRANSPORT_PROFILE',
    @CurrentUser('id') userId: string,
  ) {
    return this.reviewService.listMyProviderClarifications(userId, subjectType);
  }

  // POST /review/clarifications/:id/respond — subject (or reviewer) replies,
  // optionally attaching files
  @Post('clarifications/:id/respond')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('attachments', 5))
  respond(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Body() dto: RespondClarificationDto,
    @UploadedFiles() files: Array<{ originalname: string; filename: string }>,
  ) {
    return this.reviewService.respondToClarification(userId, role, id, dto, files || []);
  }

  // PATCH /review/clarifications/:id/resolve — admin/moderator closes it out
  @Patch('clarifications/:id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  resolve(@Param('id') id: string, @CurrentUser('id') adminId: string) {
    return this.reviewService.resolveClarification(adminId, id);
  }

  // GET /review/clarifications/:id/attachments/:attId/signed-url
  @Get('clarifications/:id/attachments/:attId/signed-url')
  @UseGuards(JwtAuthGuard)
  getAttachmentUrl(
    @Param('attId') attId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.reviewService.getAttachmentSignedUrl(attId, userId, role);
  }

  // GET /review/clarifications/attachments/file/:token — serves file bytes.
  // No guard: the signed, short-lived token in the path IS the credential
  // (same pattern as AuthController.serveKycFile) — this is reachable as a
  // plain URL (new tab / download link), which can't carry auth headers.
  //
  // Round 2, Milestone 4: no longer streams bytes from local disk —
  // redirects to a fresh, short-lived presigned bucket URL.
  @Get('clarifications/attachments/file/:token')
  async serveFile(@Param('token') token: string, @Res() res: Response) {
    const { s3Key } = await this.reviewService.resolveFileToken(token);
    const presignedUrl = await this.storage.getPresignedUrl(s3Key, 60);
    res.set({ 'Cache-Control': 'private, no-store' });
    return res.redirect(presignedUrl);
  }
}
