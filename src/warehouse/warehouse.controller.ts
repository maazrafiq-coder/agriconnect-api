import {
  Controller, Get, Post, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import {
  WarehouseService, CreateWarehouseDto, BookStorageDto,
  WarehouseQueryDto, ApplyLienDto, BuyInsuranceDto,
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

  // POST /warehouse/book — book storage
  @Post('book')
  @UseGuards(JwtAuthGuard)
  book(@CurrentUser('id') userId: string, @Body() dto: BookStorageDto) {
    return this.warehouseService.bookStorage(userId, dto);
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

  // GET /warehouse/dashboard/operator — warehouse operator dashboard
  @Get('dashboard/operator')
  @UseGuards(JwtAuthGuard)
  getOperatorDashboard(@CurrentUser('id') userId: string) {
    return this.warehouseService.getWarehouseDashboard(userId);
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
}
