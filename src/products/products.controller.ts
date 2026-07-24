import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { FileValidationInterceptor } from '../common/guards/file-validation.interceptor';
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
  @Post(':id/media')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: diskStorage({
        destination: './uploads/products',
        filename: (req, file, cb) => {
          const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `product-${unique}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  @UseInterceptors(FileValidationInterceptor)
  addMedia(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('type') type: string = 'image',
  ) {
    return this.productsService.addMedia(id, userId, files, type);
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
