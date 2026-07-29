import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IsString, IsOptional, IsInt, Min } from 'class-validator';

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateCityDto {
  @IsString() name: string;
  @IsString() province: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateCityDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class CreateUnitDto {
  @IsString() name: string;
  @IsOptional() @IsString() categoryId?: string; // omit = applies to all categories
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateUnitDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

// ─── CITIES ───────────────────────────────────────────────────────────────────
@Injectable()
export class CitiesService {
  constructor(private prisma: PrismaService) {}

  async findActive(province?: string) {
    return this.prisma.city.findMany({
      where: { isActive: true, ...(province && { province }) },
      orderBy: [{ province: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async adminFindAll() {
    return this.prisma.city.findMany({
      orderBy: [{ province: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreateCityDto) {
    const existing = await this.prisma.city.findUnique({
      where: { name_province: { name: dto.name, province: dto.province } },
    });
    if (existing) throw new ConflictException(`"${dto.name}, ${dto.province}" already exists`);

    return this.prisma.city.create({
      data: { name: dto.name, province: dto.province, sortOrder: dto.sortOrder ?? 0 },
    });
  }

  async update(id: string, dto: UpdateCityDto) {
    const city = await this.prisma.city.findUnique({ where: { id } });
    if (!city) throw new NotFoundException('City not found');
    return this.prisma.city.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.province && { province: dto.province }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  // Cities are only ever referenced by free-text match on Product.locationCity
  // (not a foreign key — sellers could theoretically have typed a city before
  // it existed in this list, or after it's deactivated). Deactivating here
  // only affects the dropdown going forward; it never touches existing listings.
  async deactivate(id: string) {
    const city = await this.prisma.city.findUnique({ where: { id } });
    if (!city) throw new NotFoundException('City not found');
    return this.prisma.city.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string) {
    const city = await this.prisma.city.findUnique({ where: { id } });
    if (!city) throw new NotFoundException('City not found');
    return this.prisma.city.update({ where: { id }, data: { isActive: true } });
  }
}

// ─── UNITS ────────────────────────────────────────────────────────────────────
@Injectable()
export class UnitsService {
  constructor(private prisma: PrismaService) {}

  // Returns units valid for a given category PLUS global units (categoryId
  // null). This is what powers "Rice shows bags/tons/maunds, Cotton shows
  // bales/tons" — the seller's unit dropdown filters by whichever category
  // they picked first.
  async findActive(categorySlug?: string) {
    if (!categorySlug) {
      return this.prisma.unit.findMany({
        where: { isActive: true, categoryId: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
    }

    const category = await this.prisma.category.findUnique({ where: { slug: categorySlug } });
    return this.prisma.unit.findMany({
      where: {
        isActive: true,
        OR: [{ categoryId: null }, { categoryId: category?.id }],
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async adminFindAll() {
    return this.prisma.unit.findMany({
      include: { category: { select: { name: true, icon: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreateUnitDto) {
    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
      if (!category) throw new BadRequestException('Category not found');
    }

    // Postgres treats every NULL as distinct, so the DB's @@unique([name,
    // categoryId]) constraint would silently allow duplicate GLOBAL units
    // (categoryId: null) with the same name. Check explicitly here for
    // that case; category-scoped duplicates are still caught by the DB.
    const existing = await this.prisma.unit.findFirst({
      where: { name: dto.name, categoryId: dto.categoryId ?? null },
    });
    if (existing) throw new ConflictException(`"${dto.name}" already exists for this scope`);

    return this.prisma.unit.create({
      data: { name: dto.name, categoryId: dto.categoryId, sortOrder: dto.sortOrder ?? 0 },
      include: { category: { select: { name: true, icon: true } } },
    });
  }

  async update(id: string, dto: UpdateUnitDto) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return this.prisma.unit.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
      include: { category: { select: { name: true, icon: true } } },
    });
  }

  async deactivate(id: string) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return this.prisma.unit.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return this.prisma.unit.update({ where: { id }, data: { isActive: true } });
  }
}
