import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { TestingService, CreateTestingRequestDto, SubmitReportDto, AgencyQueryDto } from './testing.service';
import { TransportService, CreateTransportRequestDto, BookTransportDto, TransportQueryDto } from './testing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
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
}

// ─── TRANSPORT CONTROLLER ─────────────────────────────────────────────────────
@Controller('transport')
export class TransportController {
  constructor(private readonly transportService: TransportService) {}

  @Get('providers')
  findProviders(@Query() query: TransportQueryDto) {
    return this.transportService.findAllProviders(query);
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
}
