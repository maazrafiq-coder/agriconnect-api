// src/users/users.controller.ts
import { Controller, Get, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // GET /users/profile — own profile
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.getProfile(userId);
  }

  // PATCH /users/profile — update own profile
  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.usersService.updateProfile(userId, body);
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
  @Roles('ADMIN')
  adminList(
    @Query('role') role?: string,
    @Query('kycStatus') kycStatus?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.usersService.adminFindAll(role, kycStatus, +page, +limit);
  }

  // PATCH /users/admin/:id/kyc — approve or reject KYC
  @Patch('admin/:id/kyc')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminKyc(
    @Param('id') id: string,
    @Body('status') status: 'APPROVED' | 'REJECTED',
    @Body('note') note?: string,
  ) {
    return this.usersService.adminUpdateKyc(id, status, note);
  }

  // PATCH /users/admin/:id/active — suspend or activate
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.usersService.adminSetActive(id, isActive);
  }
}
