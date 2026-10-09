import { Module } from '@nestjs/common';
import { OffersService, OrdersService } from './offers.service';
import { OfferMessagesService } from './offer-messages.service';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';

@Module({
  controllers: [OffersController, OrdersController],
  providers: [OffersService, OrdersService, OfferMessagesService],
  exports: [OffersService, OrdersService],
})
export class OffersModule {}
