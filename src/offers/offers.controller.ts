import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { OffersService, CreateOfferDto, CounterOfferDto } from './offers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  constructor(private readonly offersService: OffersService) {}

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

  // PATCH /offers/:id/reject — seller rejects
  @Patch(':id/reject')
  reject(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.offersService.reject(id, userId);
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
}
