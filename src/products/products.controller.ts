import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto/product.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProductStatus } from '@prisma/client';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // GET /products — public search
  @Get()
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }

  // GET /products/my — seller's own listings
  @Get('my')
  @UseGuards(JwtAuthGuard)
  getMyProducts(@CurrentUser('id') userId: string) {
    return this.productsService.getSellerProducts(userId);
  }

  // GET /products/saved — buyer's saved list
  @Get('saved')
  @UseGuards(JwtAuthGuard)
  getSaved(@CurrentUser('id') userId: string) {
    return this.productsService.getSavedProducts(userId);
  }

  // GET /products/:id — public detail
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  // POST /products — create listing
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(userId, dto);
  }

  // PATCH /products/:id — update listing
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(id, userId, dto);
  }

  // PATCH /products/:id/status — pause / activate / remove
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard)
  changeStatus(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('status') status: ProductStatus,
  ) {
    return this.productsService.changeStatus(id, userId, status);
  }

  // POST /products/:id/media — upload images/docs
  //
  // Round 2, Milestone 4: storage engine (S3 bucket vs. local disk) is
  // now configured once at the module level (see products.module.ts)
  // rather than inline here, matching the auth/review modules'
  // MulterModule.registerAsync pattern. Content-type magic-byte
  // validation now happens inside that storage engine itself before
  // the upload is persisted, so the separate FileValidationInterceptor
  // (which checked bytes only after they'd already been written to
  // disk) is no longer needed here.
  @Post(':id/media')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10))
  addMedia(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('type') type: string = 'image',
  ) {
    return this.productsService.addMedia(id, userId, files, type);
  }

  // PATCH /products/media/:mediaId/set-primary — set the listing's display picture
  @Patch('media/:mediaId/set-primary')
  @UseGuards(JwtAuthGuard)
  setPrimaryMedia(@Param('mediaId') mediaId: string, @CurrentUser('id') userId: string) {
    return this.productsService.setPrimaryMedia(mediaId, userId);
  }

  // POST /products/:id/save — toggle save
  @Post(':id/save')
  @UseGuards(JwtAuthGuard)
  save(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.productsService.saveProduct(userId, id);
  }

  // ─── ADMIN ────────────────────────────────────────────────────────────────

  // GET /products/admin/all — moderation queue
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll(
    @Query('status') status?: ProductStatus,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.productsService.adminFindAll(status, +page, +limit);
  }

  // PATCH /products/admin/:id/approve — approve a pending listing (first time it goes live)
  @Patch('admin/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminApprove(@Param('id') id: string) {
    return this.productsService.adminApprove(id);
  }

  // PATCH /products/admin/:id/reject — decline a pending listing (seller can edit + resubmit)
  @Patch('admin/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminReject(@Param('id') id: string, @Body('reason') reason: string) {
    return this.productsService.adminReject(id, reason || 'No reason provided');
  }

  // PATCH /products/admin/:id/remove — remove a fraudulent/policy-violating listing
  @Patch('admin/:id/remove')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminRemove(@Param('id') id: string, @Body('reason') reason: string) {
    return this.productsService.adminRemove(id, reason || 'No reason provided');
  }

  // PATCH /products/admin/:id/restore — reinstate a removed listing
  @Patch('admin/:id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminRestore(@Param('id') id: string) {
    return this.productsService.adminRestore(id);
  }
}
