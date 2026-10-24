import { Module } from '@nestjs/common';
import { OffersService, OrdersService } from './offers.service';
import { OfferMessagesService } from './offer-messages.service';
import { SellerInvoiceService } from './seller-invoice.service';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';
import { SellerInvoicesController } from './seller-invoices.controller';

@Module({
  controllers: [OffersController, OrdersController, SellerInvoicesController],
  providers: [OffersService, OrdersService, OfferMessagesService, SellerInvoiceService],
  exports: [OffersService, OrdersService, SellerInvoiceService],
})
export class OffersModule {}
