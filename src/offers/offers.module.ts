import { Module } from '@nestjs/common';
import { OffersService, OrdersService } from './offers.service';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';

@Module({
  controllers: [OffersController, OrdersController],
  providers: [OffersService, OrdersService],
  exports: [OffersService, OrdersService],
})
export class OffersModule {}
