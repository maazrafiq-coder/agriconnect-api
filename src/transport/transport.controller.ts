// Phase 3 transport routes. NOTE on ordering: TransportController (testing module)
// is registered first and owns the static `requests` POST, `book`, `providers`, etc.
// Inside each controller below, static segments ('my', 'issued', 'request/:id') are
// declared BEFORE ':id' so they are never captured as an id.
import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Headers } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireApproved } from '../common/guards/approved-user.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  TransportLifecycleService, QuoteRoundDto, AcceptQuoteDto, ReasonDto, OptionalReasonDto, TrackingUpdateDto, AcknowledgeDto,
} from './transport-lifecycle.service';
import { TransportInvoiceService, SubmitTransportPaymentDto, InvoiceReasonDto } from './transport-invoice.service';
import { TransportDisputeService, RaiseDisputeDto, DisputeResponseDto, ResolveDisputeDto } from './transport-dispute.service';
import { IDEM } from './transport.shared';

@Controller('transport')
export class TransportLifecycleController {
  constructor(private readonly svc: TransportLifecycleService) {}

  @Get('requests/my')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser('id') userId: string, @Query('role') role: 'requester' | 'provider' = 'requester') {
    return this.svc.listMine(userId, role === 'provider' ? 'provider' : 'requester');
  }

  @Get('requests/:id')
  @UseGuards(JwtAuthGuard)
  one(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.svc.getOne(id, userId, role);
  }

  // Provider: quote / revised quote
  @Patch('requests/:id/quote')
  @RequireApproved()
  quote(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: QuoteRoundDto, @Headers('idempotency-key') key?: string) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.svc.propose(id, userId, 'PROVIDER', dto);
  }

  // Requester: counter-offer on the provider's quote
  @Patch('requests/:id/counter')
  @RequireApproved()
  counter(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: QuoteRoundDto, @Headers('idempotency-key') key?: string) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.svc.propose(id, userId, 'REQUESTER', dto);
  }

  // Either party accepts the OTHER party's CURRENT round -> BOOKED
  @Patch('requests/:id/accept')
  @RequireApproved()
  accept(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: AcceptQuoteDto) {
    return this.svc.accept(id, userId, dto);
  }

  @Patch('requests/:id/reject-quote')
  @RequireApproved()
  rejectQuote(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: ReasonDto) {
    return this.svc.rejectRound(id, userId, dto.reason);
  }

  // Provider declines the whole request (it returns to the requester unassigned)
  @Patch('requests/:id/decline')
  @RequireApproved()
  decline(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: ReasonDto) {
    return this.svc.decline(id, userId, dto.reason);
  }

  @Patch('requests/:id/cancel')
  @RequireApproved()
  cancel(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: OptionalReasonDto) {
    return this.svc.cancel(id, userId, dto?.reason);
  }

  // Driver / vehicle / location / status
  @Patch('requests/:id/tracking')
  @RequireApproved()
  updateTracking(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: TrackingUpdateDto) {
    return this.svc.updateTracking(id, userId, dto);
  }

  @Post('requests/:id/acknowledge')
  @RequireApproved()
  acknowledge(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: AcknowledgeDto) {
    return this.svc.acknowledge(id, userId, dto?.note);
  }

  // Public by design (shared link) - D4: no driver phone / plate / price, masked driver name.
  // Tighter than the global limit so the id space can't be probed: 20 lookups/min/IP.
  @Get('track/:id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  track(@Param('id') id: string) {
    return this.svc.track(id);
  }
}

@Controller('transport/disputes')
export class TransportDisputesController {
  constructor(private readonly svc: TransportDisputeService) {}

  @Get('my')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }

  @Post('request/:requestId')
  @RequireApproved()
  raise(@Param('requestId') requestId: string, @CurrentUser('id') userId: string, @Body() dto: RaiseDisputeDto, @Headers('idempotency-key') key?: string) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.svc.raise(requestId, userId, dto);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  get(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.svc.get(id, userId, role);
  }

  @Post(':id/respond')
  @RequireApproved()
  respond(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: DisputeResponseDto) {
    return this.svc.respond(id, userId, dto.response);
  }

  @Post(':id/withdraw')
  @RequireApproved()
  withdraw(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.svc.withdraw(id, userId);
  }
}

@Controller('transport/admin/disputes')
export class TransportAdminDisputesController {
  constructor(private readonly svc: TransportDisputeService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  list(@Query('status') status?: string) {
    return this.svc.adminList(status);
  }

  @Post(':id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  resolve(@Param('id') id: string, @CurrentUser('id') adminId: string, @Body() dto: ResolveDisputeDto) {
    return this.svc.resolve(id, adminId, dto);
  }
}

@Controller('transport-invoices')
export class TransportInvoicesController {
  constructor(private readonly invoices: TransportInvoiceService) {}

  @Get('my')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser('id') userId: string) {
    return this.invoices.listMine(userId, 'requester');
  }

  @Get('issued')
  @UseGuards(JwtAuthGuard)
  issued(@CurrentUser('id') userId: string) {
    return this.invoices.listMine(userId, 'provider');
  }

  @Get('request/:requestId')
  @UseGuards(JwtAuthGuard)
  forRequest(@Param('requestId') requestId: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.forRequest(requestId, userId, role);
  }

  @Post('request/:requestId')
  @RequireApproved()
  issue(@Param('requestId') requestId: string, @CurrentUser('id') userId: string) {
    return this.invoices.issue(userId, requestId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  get(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.get(id, userId, role);
  }

  @Post(':id/submit-payment')
  @RequireApproved()
  submit(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: SubmitTransportPaymentDto) {
    return this.invoices.submitPayment(id, userId, dto);
  }

  @Post(':id/confirm-payment')
  @RequireApproved()
  confirm(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.confirmPayment(id, userId, role);
  }

  @Post(':id/reject-payment')
  @RequireApproved()
  reject(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: InvoiceReasonDto) {
    return this.invoices.rejectPayment(id, userId, dto.reason);
  }

  @Post(':id/void')
  @RequireApproved()
  void(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string, @Body() dto: InvoiceReasonDto) {
    return this.invoices.void(id, userId, role, dto.reason);
  }

  @Post(':id/replace')
  @RequireApproved()
  replace(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: InvoiceReasonDto) {
    return this.invoices.replace(id, userId, dto.reason);
  }
}
