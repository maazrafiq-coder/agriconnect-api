import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { CitiesService, UnitsService, CreateCityDto, UpdateCityDto, CreateUnitDto, UpdateUnitDto } from './catalog.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('cities')
export class CitiesController {
  constructor(private readonly citiesService: CitiesService) {}

  // GET /cities?province=Punjab — public, active only
  @Get()
  findActive(@Query('province') province?: string) {
    return this.citiesService.findActive(province);
  }

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll() {
    return this.citiesService.adminFindAll();
  }

  @Post('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  create(@Body() dto: CreateCityDto) {
    return this.citiesService.create(dto);
  }

  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateCityDto) {
    return this.citiesService.update(id, dto);
  }

  @Patch('admin/:id/deactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  deactivate(@Param('id') id: string) {
    return this.citiesService.deactivate(id);
  }

  @Patch('admin/:id/reactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reactivate(@Param('id') id: string) {
    return this.citiesService.reactivate(id);
  }
}

@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  // GET /units?category=rice — public, returns category-specific + global units
  @Get()
  findActive(@Query('category') category?: string) {
    return this.unitsService.findActive(category);
  }

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminFindAll() {
    return this.unitsService.adminFindAll();
  }

  @Post('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  create(@Body() dto: CreateUnitDto) {
    return this.unitsService.create(dto);
  }

  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto) {
    return this.unitsService.update(id, dto);
  }

  @Patch('admin/:id/deactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  deactivate(@Param('id') id: string) {
    return this.unitsService.deactivate(id);
  }

  @Patch('admin/:id/reactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reactivate(@Param('id') id: string) {
    return this.unitsService.reactivate(id);
  }
}
