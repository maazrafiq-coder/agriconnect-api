import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { SellerInvoiceService, SubmitPaymentDto, ReasonDto } from './seller-invoice.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireApproved } from '../common/guards/approved-user.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Seller invoices (Phase 2). Static routes ('my', 'issued', 'order/:orderId')
// are declared BEFORE ':id' so they are never captured as an id.
@Controller('invoices')
export class SellerInvoicesController {
  constructor(private readonly invoices: SellerInvoiceService) {}

  @Get('my')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser('id') userId: string) {
    return this.invoices.listMine(userId, 'buyer');
  }

  @Get('issued')
  @UseGuards(JwtAuthGuard)
  issuedByMe(@CurrentUser('id') userId: string) {
    return this.invoices.listMine(userId, 'seller');
  }

  @Get('order/:orderId')
  @UseGuards(JwtAuthGuard)
  forOrder(@Param('orderId') orderId: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.forOrder(orderId, userId, role);
  }

  // POST /invoices/order/:orderId - seller issues the invoice for an order
  @Post('order/:orderId')
  @RequireApproved()
  issue(@Param('orderId') orderId: string, @CurrentUser('id') userId: string) {
    return this.invoices.issue(userId, orderId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  get(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.get(id, userId, role);
  }

  @Post(':id/submit-payment')
  @RequireApproved()
  submitPayment(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: SubmitPaymentDto) {
    return this.invoices.submitPayment(id, userId, dto);
  }

  @Post(':id/confirm-payment')
  @RequireApproved()
  confirmPayment(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.invoices.confirmPayment(id, userId, role);
  }

  @Post(':id/reject-payment')
  @RequireApproved()
  rejectPayment(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: ReasonDto) {
    return this.invoices.rejectPayment(id, userId, dto.reason);
  }

  @Post(':id/void')
  @RequireApproved()
  void(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string, @Body() dto: ReasonDto) {
    return this.invoices.void(id, userId, role, dto.reason);
  }

  // POST /invoices/:id/replace - void this invoice and issue a corrected one
  @Post(':id/replace')
  @RequireApproved()
  replace(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: ReasonDto) {
    return this.invoices.replace(id, userId, dto.reason);
  }
}
