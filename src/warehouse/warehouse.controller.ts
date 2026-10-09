import {
  Controller, Get, Post, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import {
  WarehouseService, CreateWarehouseDto, UpdateWarehouseDto, BookStorageDto,
  WarehouseQueryDto, ApplyLienDto, ConfirmLienDto, BuyInsuranceDto,
  RejectBookingDto, CancelBookingDto, PostBookingMessageDto,
} from './warehouse.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireApproved } from '../common/guards/approved-user.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('warehouse')
export class WarehouseController {
  constructor(private readonly warehouseService: WarehouseService) {}

  // ─── PUBLIC ───────────────────────────────────────────────────────────────

  // GET /warehouse — browse all warehouses
  @Get()
  findAll(@Query() query: WarehouseQueryDto) {
    return this.warehouseService.findAll(query);
  }

  // GET /warehouse/:id — warehouse detail
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.warehouseService.findOne(id);
  }

  // ─── AUTHENTICATED ────────────────────────────────────────────────────────

  // POST /warehouse/register — warehouse operator registers
  @Post('register')
  @RequireApproved()
  register(@CurrentUser('id') userId: string, @Body() dto: CreateWarehouseDto) {
    return this.warehouseService.create(userId, dto);
  }

  // PATCH /warehouse/:id — operator edits their own warehouse's details/rates
  @Patch(':id')
  @RequireApproved()
  update(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouseService.update(userId, id, dto);
  }

  // GET /warehouse/:id/quote — live rate preview (incl. insurance) before booking
  @Get(':id/quote')
  quote(
    @Param('id') id: string,
    @Query('commodity') commodity: string,
    @Query('quantityTons') quantityTons: string,
    @Query('durationDays') durationDays: string,
    @Query('includeInsurance') includeInsurance?: string,
  ) {
    return this.warehouseService.quoteRate(
      id, commodity, Number(quantityTons), Number(durationDays), includeInsurance === 'true',
    );
  }

  // POST /warehouse/book — book storage (creates a REQUESTED booking;
  // the warehouse operator must accept it before goods should be delivered)
  @Post('book')
  @RequireApproved()
  book(@CurrentUser('id') userId: string, @Body() dto: BookStorageDto) {
    return this.warehouseService.bookStorage(userId, dto);
  }

  // GET /warehouse/bookings/my — buyer's own booking requests, with status
  @Get('bookings/my')
  @UseGuards(JwtAuthGuard)
  getMyBookings(@CurrentUser('id') userId: string) {
    return this.warehouseService.getMyBookings(userId);
  }

  // GET /warehouse/bookings/:id — single booking (buyer, operator, or admin)
  @Get('bookings/:id')
  @UseGuards(JwtAuthGuard)
  getBooking(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.warehouseService.getBooking(id, userId, role);
  }

  // GET /warehouse/bookings/:id/messages — conversation thread for a booking
  @Get('bookings/:id/messages')
  @UseGuards(JwtAuthGuard)
  getBookingMessages(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.warehouseService.getBookingMessages(id, userId, role);
  }

  // POST /warehouse/bookings/:id/messages — depositor or operator posts (operator may flag INFO_REQUEST)
  @Post('bookings/:id/messages')
  @UseGuards(JwtAuthGuard)
  postBookingMessage(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Body() dto: PostBookingMessageDto,
  ) {
    return this.warehouseService.postBookingMessage(id, userId, role, dto);
  }

  // PATCH /warehouse/bookings/:id/accept — warehouse operator accepts a REQUESTED booking
  @Patch('bookings/:id/accept')
  @RequireApproved()
  acceptBooking(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.acceptBooking(userId, id);
  }

  // PATCH /warehouse/bookings/:id/reject — warehouse operator declines a REQUESTED booking
  @Patch('bookings/:id/reject')
  @RequireApproved()
  rejectBooking(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: RejectBookingDto) {
    return this.warehouseService.rejectBooking(userId, id, dto);
  }

  // PATCH /warehouse/bookings/:id/cancel — depositor or operator withdraws before goods arrive
  @Patch('bookings/:id/cancel')
  @RequireApproved()
  cancelBooking(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.warehouseService.cancelBooking(userId, role, id, dto);
  }

  // PATCH /warehouse/bookings/:id/complete — operator marks booking complete (goods released)
  @Patch('bookings/:id/complete')
  @RequireApproved()
  completeBooking(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.completeBooking(userId, id);
  }

  // GET /warehouse/receipts/my — my digital warehouse receipts
  @Get('receipts/my')
  @UseGuards(JwtAuthGuard)
  getMyReceipts(@CurrentUser('id') userId: string) {
    return this.warehouseService.getMyReceipts(userId);
  }

  // GET /warehouse/receipts/:id — single receipt
  @Get('receipts/:id')
  @UseGuards(JwtAuthGuard)
  getReceipt(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.getReceipt(id, userId);
  }

  // POST /warehouse/receipts/issue/:bookingId — operator issues receipt
  @Post('receipts/issue/:bookingId')
  @RequireApproved()
  issueReceipt(
    @Param('bookingId') bookingId: string,
    @CurrentUser('id') userId: string,
    @Body('qualityMetrics') qualityMetrics: any,
    @Body('actualQuantityTons') actualQuantityTons: number,
  ) {
    return this.warehouseService.issueReceipt(userId, bookingId, qualityMetrics, actualQuantityTons);
  }

  // ─── INVOICE (NEW_Changes item 10) ──────────────────────────────────────────

  // POST /warehouse/bookings/:bookingId/invoice — operator generates & "sends" an invoice
  @Post('bookings/:bookingId/invoice')
  @RequireApproved()
  generateInvoice(@Param('bookingId') bookingId: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.generateInvoice(userId, bookingId);
  }

  // GET /warehouse/invoices/my — depositor's own invoices (must precede :id)
  @Get('invoices/my')
  @UseGuards(JwtAuthGuard)
  getMyInvoices(@CurrentUser('id') userId: string) {
    return this.warehouseService.getMyInvoices(userId);
  }

  // GET /warehouse/invoices/operator — invoices issued across all of the operator's warehouses
  @Get('invoices/operator')
  @UseGuards(JwtAuthGuard)
  getOperatorInvoices(@CurrentUser('id') userId: string) {
    return this.warehouseService.getOperatorInvoices(userId);
  }

  // GET /warehouse/invoices/:id — invoice detail + a fresh signed PDF download URL
  @Get('invoices/:id')
  @UseGuards(JwtAuthGuard)
  getInvoice(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') userRole: string) {
    return this.warehouseService.getInvoice(userId, userRole, id);
  }

  // PATCH /warehouse/invoices/:id/confirm-payment — manual payment confirmation
  // (operator or admin/moderator — see InvoiceStatus schema comment)
  @Patch('invoices/:id/confirm-payment')
  @RequireApproved()
  confirmInvoicePayment(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Body('paymentReference') paymentReference?: string,
  ) {
    return this.warehouseService.confirmInvoicePayment(userId, userRole, id, paymentReference);
  }

  // ─── GOODS RECEIPT NOTE (issued automatically by issueReceipt above) ───────

  // GET /warehouse/grn/:id — GRN detail + a fresh signed PDF download URL
  @Get('grn/:id')
  @UseGuards(JwtAuthGuard)
  getGrn(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') userRole: string) {
    return this.warehouseService.getGrn(userId, userRole, id);
  }

  // ─── GATE OUT PASS (NEW_Changes item 10) ────────────────────────────────────

  // POST /warehouse/bookings/:bookingId/gate-out-request — operator requests release
  @Post('bookings/:bookingId/gate-out-request')
  @RequireApproved()
  requestGateOut(
    @Param('bookingId') bookingId: string,
    @CurrentUser('id') userId: string,
    @Body('quantityTons') quantityTons?: number,
    @Body('requestNote') requestNote?: string,
  ) {
    return this.warehouseService.requestGateOut(userId, bookingId, quantityTons, requestNote);
  }

  // GET /warehouse/gate-out/my — depositor's own gate-out requests (must precede :id)
  @Get('gate-out/my')
  @UseGuards(JwtAuthGuard)
  getMyGateOutPasses(@CurrentUser('id') userId: string) {
    return this.warehouseService.getMyGateOutPasses(userId);
  }

  // GET /warehouse/gate-out/operator — requests across all of the operator's warehouses
  @Get('gate-out/operator')
  @UseGuards(JwtAuthGuard)
  getOperatorGateOutPasses(@CurrentUser('id') userId: string) {
    return this.warehouseService.getOperatorGateOutPasses(userId);
  }

  // GET /warehouse/gate-out/:id — gate-out request/pass detail
  @Get('gate-out/:id')
  @UseGuards(JwtAuthGuard)
  getGateOutPass(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') userRole: string) {
    return this.warehouseService.getGateOutPass(userId, userRole, id);
  }

  // PATCH /warehouse/gate-out/:id/approve — depositor or admin/moderator approves
  @Patch('gate-out/:id/approve')
  @RequireApproved()
  approveGateOut(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') userRole: string) {
    return this.warehouseService.approveGateOut(userId, userRole, id);
  }

  // PATCH /warehouse/gate-out/:id/reject — depositor or admin/moderator rejects
  @Patch('gate-out/:id/reject')
  @RequireApproved()
  rejectGateOut(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Body('rejectionNote') rejectionNote?: string,
  ) {
    return this.warehouseService.rejectGateOut(userId, userRole, id, rejectionNote);
  }

  // POST /warehouse/lien/apply — apply for bank lien
  @Post('lien/apply')
  @RequireApproved()
  applyLien(@CurrentUser('id') userId: string, @Body() dto: ApplyLienDto) {
    return this.warehouseService.applyLien(userId, dto);
  }

  // PATCH /warehouse/lien/:id/withdraw — depositor withdraws a PENDING application
  @Patch('lien/:id/withdraw')
  @RequireApproved()
  withdrawLien(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.withdrawLien(id, userId);
  }

  // PATCH /warehouse/lien/:id/release — record the bank's clearance of a lien.
  // Warehouse operator (who receives the bank's release letter) or admin/
  // moderator only; the depositor cannot clear their own lien.
  @Patch('lien/:id/release')
  @RequireApproved()
  releaseLien(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Body('note') note?: string,
  ) {
    return this.warehouseService.releaseLien(id, userId, role, note);
  }

  // GET /warehouse/insurance/quote/:receiptId — server-computed premium & cover
  @Get('insurance/quote/:receiptId')
  @UseGuards(JwtAuthGuard)
  insuranceQuote(@Param('receiptId') receiptId: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.getInsuranceQuote(userId, receiptId);
  }

  // POST /warehouse/insurance/buy — buy storage insurance
  @Post('insurance/buy')
  @RequireApproved()
  buyInsurance(@CurrentUser('id') userId: string, @Body() dto: BuyInsuranceDto) {
    return this.warehouseService.buyInsurance(userId, dto);
  }

  // GET /warehouse/dashboard/operator — warehouse operator dashboard.
  // Optional ?warehouseId= to view a specific one (NEW_Changes item 10 —
  // operators can now run more than one warehouse); defaults to their
  // first-registered warehouse when omitted, unchanged for single-warehouse
  // operators.
  @Get('dashboard/operator')
  @UseGuards(JwtAuthGuard)
  getOperatorDashboard(@CurrentUser('id') userId: string, @Query('warehouseId') warehouseId?: string) {
    return this.warehouseService.getWarehouseDashboard(userId, warehouseId);
  }

  // ─── ADMIN ────────────────────────────────────────────────────────────────

  // GET /warehouse/admin/all
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminGetAll() {
    return this.warehouseService.adminGetAll();
  }

  // GET /warehouse/admin/liens?status=PENDING — loan application queue
  @Get('admin/liens')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  adminListLiens(@Query('status') status?: string) {
    return this.warehouseService.adminListLiens(status);
  }

  // PATCH /warehouse/admin/liens/:id/confirm — confirm a pending application (becomes the active lien)
  @Patch('admin/liens/:id/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  confirmLien(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: ConfirmLienDto) {
    return this.warehouseService.confirmLien(id, userId, dto);
  }

  // PATCH /warehouse/admin/liens/:id/reject — decline a pending application
  @Patch('admin/liens/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  rejectLien(@Param('id') id: string, @CurrentUser('id') userId: string, @Body('note') note?: string) {
    return this.warehouseService.rejectLien(id, userId, note);
  }

  // PATCH /warehouse/admin/:id/verify
  @Patch('admin/:id/verify')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminVerify(@Param('id') id: string, @Body('verified') verified: boolean, @CurrentUser('id') adminId: string) {
    return this.warehouseService.adminVerify(id, verified, adminId);
  }

  // PATCH /warehouse/admin/:id/active — delist/relist without touching the account
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean, @CurrentUser('id') adminId: string) {
    return this.warehouseService.adminSetActive(id, isActive, adminId);
  }
}
