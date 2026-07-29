import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { CategoriesService, CreateCategoryDto, UpdateCategoryDto } from './categories.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // GET /categories — public, active only (marketplace filters, create-listing dropdown)
  @Get()
  findActive() {
    return this.categoriesService.findActive();
  }

  // ─── ADMIN ────────────────────────────────────────────────────────────────

  // GET /categories/admin/all — includes inactive + product counts
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll() {
    return this.categoriesService.adminFindAll();
  }

  // POST /categories/admin — create a new category
  @Post('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  // PATCH /categories/admin/:id — edit name/icon/description/order
  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  // PATCH /categories/admin/:id/deactivate — soft "remove"
  @Patch('admin/:id/deactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  deactivate(@Param('id') id: string) {
    return this.categoriesService.deactivate(id);
  }

  // PATCH /categories/admin/:id/reactivate
  @Patch('admin/:id/reactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reactivate(@Param('id') id: string) {
    return this.categoriesService.reactivate(id);
  }
}
