import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { TestingService, CreateTestingRequestDto, SubmitReportDto, AgencyQueryDto, RegisterAgencyDto, UpdateAgencyDto } from './testing.service';
import { TransportService, CreateTransportRequestDto, BookTransportDto, TransportQueryDto, RegisterProviderDto, UpdateProviderDto } from './testing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TestingStatus } from '@prisma/client';

// ─── TESTING CONTROLLER ───────────────────────────────────────────────────────
@Controller('testing')
export class TestingController {
  constructor(private readonly testingService: TestingService) {}

  @Get('agencies')
  findAgencies(@Query() query: AgencyQueryDto) {
    return this.testingService.findAllAgencies(query);
  }

  // ─── OPERATOR SELF-SERVICE ───────────────────────────────────────────────
  // POST /testing/register — testing agency operator registers their listing
  @Post('register')
  @UseGuards(JwtAuthGuard)
  register(@CurrentUser('id') userId: string, @Body() dto: RegisterAgencyDto) {
    return this.testingService.registerAgency(userId, dto);
  }

  // GET /testing/my-agency — operator's own listing + request stats
  @Get('my-agency')
  @UseGuards(JwtAuthGuard)
  getMyAgency(@CurrentUser('id') userId: string) {
    return this.testingService.getMyAgency(userId);
  }

  // PATCH /testing/my-agency — edit own listing
  @Patch('my-agency')
  @UseGuards(JwtAuthGuard)
  updateMyAgency(@CurrentUser('id') userId: string, @Body() dto: UpdateAgencyDto) {
    return this.testingService.updateMyAgency(userId, dto);
  }

  @Post('requests')
  @UseGuards(JwtAuthGuard)
  createRequest(@CurrentUser('id') userId: string, @Body() dto: CreateTestingRequestDto) {
    return this.testingService.createRequest(userId, dto);
  }

  @Get('requests/my')
  @UseGuards(JwtAuthGuard)
  getMyRequests(
    @CurrentUser('id') userId: string,
    @Query('role') role: 'requester' | 'agency' = 'requester',
  ) {
    return this.testingService.getMyRequests(userId, role);
  }

  @Patch('requests/:id/status')
  @UseGuards(JwtAuthGuard)
  updateStatus(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('status') status: TestingStatus,
  ) {
    return this.testingService.updateStatus(id, userId, status);
  }

  @Post('requests/:id/report')
  @UseGuards(JwtAuthGuard)
  submitReport(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SubmitReportDto,
  ) {
    return this.testingService.submitReport(id, userId, dto);
  }

  // GET /testing/admin/all — includes delisted agencies too
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll() {
    return this.testingService.adminFindAll();
  }

  // PATCH /testing/admin/:id/active — delist/relist without touching the account
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.testingService.adminSetActive(id, isActive);
  }
}

// ─── TRANSPORT CONTROLLER ─────────────────────────────────────────────────────
@Controller('transport')
export class TransportController {
  constructor(private readonly transportService: TransportService) {}

  @Get('providers')
  findProviders(@Query() query: TransportQueryDto) {
    return this.transportService.findAllProviders(query);
  }

  // ─── OPERATOR SELF-SERVICE ───────────────────────────────────────────────
  // POST /transport/register — transport provider operator registers their listing
  @Post('register')
  @UseGuards(JwtAuthGuard)
  register(@CurrentUser('id') userId: string, @Body() dto: RegisterProviderDto) {
    return this.transportService.registerProvider(userId, dto);
  }

  // GET /transport/my-provider — operator's own listing + request stats
  @Get('my-provider')
  @UseGuards(JwtAuthGuard)
  getMyProvider(@CurrentUser('id') userId: string) {
    return this.transportService.getMyProvider(userId);
  }

  // PATCH /transport/my-provider — edit own listing
  @Patch('my-provider')
  @UseGuards(JwtAuthGuard)
  updateMyProvider(@CurrentUser('id') userId: string, @Body() dto: UpdateProviderDto) {
    return this.transportService.updateMyProvider(userId, dto);
  }

  @Post('requests')
  @UseGuards(JwtAuthGuard)
  createRequest(@CurrentUser('id') userId: string, @Body() dto: CreateTransportRequestDto) {
    return this.transportService.createRequest(userId, dto);
  }

  @Post('book')
  @UseGuards(JwtAuthGuard)
  book(@CurrentUser('id') userId: string, @Body() dto: BookTransportDto) {
    return this.transportService.bookTransport(userId, dto);
  }

  @Get('requests/my')
  @UseGuards(JwtAuthGuard)
  getMyRequests(
    @CurrentUser('id') userId: string,
    @Query('role') role: 'requester' | 'provider' = 'requester',
  ) {
    return this.transportService.getMyRequests(userId, role);
  }

  @Patch('requests/:id/tracking')
  @UseGuards(JwtAuthGuard)
  updateTracking(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() data: any,
  ) {
    return this.transportService.updateTracking(id, userId, data);
  }

  @Get('track/:id')
  track(@Param('id') id: string) {
    return this.transportService.track(id);
  }

  // GET /transport/admin/all — includes delisted providers too
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll() {
    return this.transportService.adminFindAll();
  }

  // PATCH /transport/admin/:id/active — delist/relist without touching the account
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.transportService.adminSetActive(id, isActive);
  }
}
