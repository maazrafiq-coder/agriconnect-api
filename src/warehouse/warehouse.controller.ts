import {
  Controller, Get, Post, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import {
  WarehouseService, CreateWarehouseDto, UpdateWarehouseDto, BookStorageDto,
  WarehouseQueryDto, ApplyLienDto, BuyInsuranceDto,
  RejectBookingDto, CancelBookingDto, PostBookingMessageDto,
} from './warehouse.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
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
  @UseGuards(JwtAuthGuard)
  register(@CurrentUser('id') userId: string, @Body() dto: CreateWarehouseDto) {
    return this.warehouseService.create(userId, dto);
  }

  // PATCH /warehouse/:id — operator edits their own warehouse's details/rates
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  acceptBooking(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.warehouseService.acceptBooking(userId, id);
  }

  // PATCH /warehouse/bookings/:id/reject — warehouse operator declines a REQUESTED booking
  @Patch('bookings/:id/reject')
  @UseGuards(JwtAuthGuard)
  rejectBooking(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: RejectBookingDto) {
    return this.warehouseService.rejectBooking(userId, id, dto);
  }

  // PATCH /warehouse/bookings/:id/cancel — depositor or operator withdraws before goods arrive
  @Patch('bookings/:id/cancel')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  approveGateOut(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') userRole: string) {
    return this.warehouseService.approveGateOut(userId, userRole, id);
  }

  // PATCH /warehouse/gate-out/:id/reject — depositor or admin/moderator rejects
  @Patch('gate-out/:id/reject')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  applyLien(@CurrentUser('id') userId: string, @Body() dto: ApplyLienDto) {
    return this.warehouseService.applyLien(userId, dto);
  }

  // PATCH /warehouse/lien/:id/release — release bank lien
  @Patch('lien/:id/release')
  @UseGuards(JwtAuthGuard)
  releaseLien(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('note') note?: string,
  ) {
    return this.warehouseService.releaseLien(id, userId, note);
  }

  // POST /warehouse/insurance/buy — buy storage insurance
  @Post('insurance/buy')
  @UseGuards(JwtAuthGuard)
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

  // PATCH /warehouse/admin/:id/verify
  @Patch('admin/:id/verify')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminVerify(@Param('id') id: string, @Body('verified') verified: boolean) {
    return this.warehouseService.adminVerify(id, verified);
  }

  // PATCH /warehouse/admin/:id/active — delist/relist without touching the account
  @Patch('admin/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminSetActive(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.warehouseService.adminSetActive(id, isActive);
  }
}
