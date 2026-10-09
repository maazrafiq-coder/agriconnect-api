// src/users/users.controller.ts
import { Controller, Get, Patch, Param, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { ReviewService } from '../review/review.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly reviewService: ReviewService,
  ) {}

  // GET /users/profile — own profile
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.getProfile(userId);
  }

  // PATCH /users/profile — update own profile
  //
  // Round 2, Milestone 5: now validated by UpdateProfileDto instead of
  // accepting `body: any` — see that file for the full reasoning
  // (notably: cnicNumber is deliberately NOT editable here, only through
  // KYC re-submission).
  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(userId, dto);
  }

  // GET /users/:id — public profile
  @Get(':id')
  getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicProfile(id);
  }

  // ─── ADMIN ROUTES ─────────────────────────────────────────────────────────

  // GET /users/admin/list
  @Get('admin/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR') // moderators review registrations (read-only); only ADMIN decides
  adminList(
    @Query('role') role?: string,
    @Query('kycStatus') kycStatus?: string,
    @Query('search') search?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.usersService.adminFindAll(role, kycStatus, search, +page, Math.min(Math.max(+limit || 20, 1), 200));
  }

  // GET /users/admin/:id/detail — full profile for the "View Complete
  // Profile" admin screen. Kept as a distinct 3-segment path (not
  // `admin/:id`) so it can never shadow the sibling `admin/list` route
  // regardless of declaration order.
  @Get('admin/:id/detail')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR') // moderators review registrations (read-only); only ADMIN decides
  adminDetail(@Param('id') id: string) {
    return this.usersService.adminFindOne(id);
  }

  // PATCH /users/admin/:id/kyc — approve, reject, or request more info.
  // "Request more info" is delegated to ReviewService so it opens a real,
  // two-way, respond-with-attachments clarification thread (see
  // ReviewClarification in schema.prisma) instead of writing a single
  // note nobody could reply to. The endpoint/contract stays the same —
  // existing frontend calls don't need to change, only what they trigger.
  @Patch('admin/:id/kyc')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminKyc(
    @Param('id') id: string,
    @Body('status') status: 'APPROVED' | 'REJECTED' | 'INFO_REQUESTED',
    @Body('note') note: string | undefined,
    @CurrentUser('id') adminId: string,
  ) {
    if (status === 'INFO_REQUESTED') {
      if (!note || note.trim().length < 5) {
        throw new BadRequestException('Please describe what additional information is needed (at least 5 characters).');
      }
      return this.reviewService.requestClarification(adminId, {
        subjectType: 'USER_KYC',
        subjectId: id,
        requestMessage: note.trim(),
      });
    }
    return this.usersService.adminUpdateKyc(id, status, note, adminId);
  }

  // PATCH /users/admin/:id/active — suspend or activate
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean, @CurrentUser('id') adminId: string) {
    return this.usersService.adminSetActive(id, isActive, adminId);
  }
}
