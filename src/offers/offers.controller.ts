import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Headers } from '@nestjs/common';
import { OfferMessagesService, PostOfferMessageDto } from './offer-messages.service';
import { OffersService, CreateOfferDto, CounterOfferDto, ProposeRoundDto, AcceptRoundDto } from './offers.service';
import { normalizePaymentTerms, describeTerms, computeSchedule } from './terms/payment-terms';

const IDEM = /^[A-Za-z0-9_-]{1,100}$/;
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireApproved } from '../common/guards/approved-user.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Reads need a session only (a limited, not-yet-approved session sees empty lists).
// Every route that creates or changes an offer requires an APPROVED account -
// enforced here by ApprovedUserGuard and again inside OffersService.
@Controller('offers')
export class OffersController {
  constructor(private readonly offersService: OffersService, private readonly offerMessages: OfferMessagesService) {}

  // POST /offers — buyer submits offer
  @Post()
  @RequireApproved()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateOfferDto, @Headers('idempotency-key') key?: string) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.offersService.create(userId, dto);
  }

  // POST /offers/terms/preview - validates payment terms and returns the
  // canonical form, a plain-language summary and the instalment schedule for an
  // order total. Read-only (nothing is saved); single source of truth for the
  // listing / offer review steps.
  @Post('terms/preview')
  @RequireApproved()
  previewTerms(@Body('paymentTerms') paymentTerms: any, @Body('totalAmount') totalAmount: number) {
    const terms = normalizePaymentTerms(paymentTerms);
    const total = Number(totalAmount);
    return {
      paymentTerms: terms,
      summary: describeTerms(terms),
      schedule: Number.isFinite(total) && total > 0 ? computeSchedule(terms, total) : [],
    };
  }

  // GET /offers/received — seller sees incoming offers
  @Get('received')
  @UseGuards(JwtAuthGuard)
  getReceived(@CurrentUser('id') userId: string) {
    return this.offersService.getSellerOffers(userId);
  }

  // GET /offers/sent — buyer sees their offers
  @Get('sent')
  @UseGuards(JwtAuthGuard)
  getSent(@CurrentUser('id') userId: string) {
    return this.offersService.getBuyerOffers(userId);
  }

  // PATCH /offers/:id/accept — seller accepts
  @Patch(':id/accept')
  @RequireApproved()
  accept(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: AcceptRoundDto) {
    return this.offersService.accept(id, userId, dto);
  }

  // PATCH /offers/:id/accept-counter — BUYER accepts the seller's counter (order at the counter price)
  @Patch(':id/accept-counter')
  @RequireApproved()
  acceptCounter(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: AcceptRoundDto) {
    return this.offersService.acceptCounter(id, userId, dto);
  }

  // PATCH /offers/:id/withdraw — BUYER withdraws an open offer / declines a counter
  @Patch(':id/withdraw')
  @RequireApproved()
  withdraw(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.withdraw(id, userId);
  }

  // PATCH /offers/:id/reject — seller rejects (optionally with a reason)
  @Patch(':id/reject')
  @RequireApproved()
  reject(@Param('id') id: string, @CurrentUser('id') userId: string, @Body('reason') reason?: string) {
    return this.offersService.reject(id, userId, reason);
  }

  // PATCH /offers/:id/counter — seller counters
  @Patch(':id/counter')
  @RequireApproved()
  counter(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CounterOfferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.offersService.counter(id, userId, dto);
  }

  // POST /offers/:id/rounds - either party answers the current round with a new proposal
  @Post(':id/rounds')
  @RequireApproved()
  propose(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ProposeRoundDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (key && IDEM.test(key)) dto.clientRequestId = key;
    return this.offersService.propose(id, userId, dto);
  }

  // GET /offers/:id/rounds - negotiation timeline (buyer or seller of the offer)
  @Get(':id/rounds')
  @UseGuards(JwtAuthGuard)
  getRounds(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.getRounds(id, userId);
  }

  // GET /offers/:id/messages — seller/buyer conversation about this offer
  @Get(':id/messages')
  @UseGuards(JwtAuthGuard)
  getMessages(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offerMessages.list(id, userId);
  }

  // POST /offers/:id/messages
  @Post(':id/messages')
  @RequireApproved()
  postMessage(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: PostOfferMessageDto) {
    return this.offerMessages.post(id, userId, dto);
  }
}
