import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { OfferMessagesService, PostOfferMessageDto } from './offer-messages.service';
import { OffersService, CreateOfferDto, CounterOfferDto } from './offers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  constructor(private readonly offersService: OffersService, private readonly offerMessages: OfferMessagesService) {}

  // POST /offers — buyer submits offer
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateOfferDto) {
    return this.offersService.create(userId, dto);
  }

  // GET /offers/received — seller sees incoming offers
  @Get('received')
  getReceived(@CurrentUser('id') userId: string) {
    return this.offersService.getSellerOffers(userId);
  }

  // GET /offers/sent — buyer sees their offers
  @Get('sent')
  getSent(@CurrentUser('id') userId: string) {
    return this.offersService.getBuyerOffers(userId);
  }

  // PATCH /offers/:id/accept — seller accepts
  @Patch(':id/accept')
  accept(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.accept(id, userId);
  }

  // PATCH /offers/:id/accept-counter — BUYER accepts the seller's counter (order at the counter price)
  @Patch(':id/accept-counter')
  acceptCounter(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.acceptCounter(id, userId);
  }

  // PATCH /offers/:id/withdraw — BUYER withdraws an open offer / declines a counter
  @Patch(':id/withdraw')
  withdraw(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.withdraw(id, userId);
  }

  // PATCH /offers/:id/reject — seller rejects (optionally with a reason)
  @Patch(':id/reject')
  reject(@Param('id') id: string, @CurrentUser('id') userId: string, @Body('reason') reason?: string) {
    return this.offersService.reject(id, userId, reason);
  }

  // PATCH /offers/:id/counter — seller counters
  @Patch(':id/counter')
  counter(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CounterOfferDto,
  ) {
    return this.offersService.counter(id, userId, dto);
  }

  // GET /offers/:id/messages — seller/buyer conversation about this offer
  @Get(':id/messages')
  getMessages(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offerMessages.list(id, userId);
  }

  // POST /offers/:id/messages
  @Post(':id/messages')
  postMessage(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: PostOfferMessageDto) {
    return this.offerMessages.post(id, userId, dto);
  }
}
