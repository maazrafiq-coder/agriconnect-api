import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IsString, IsOptional, IsBoolean, IsInt, Min } from 'class-validator';

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateCategoryDto {
  @IsString() name: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  // ─── PUBLIC ───────────────────────────────────────────────────────────────
  // Used by: marketplace filter dropdown, seller's "create listing" form.
  // Only active categories are shown — admin "removes" a category by
  // deactivating it rather than hard-deleting (see remove() below for why).
  async findActive() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // ─── ADMIN ────────────────────────────────────────────────────────────────
  async adminFindAll() {
    const categories = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    // Attach a live product count per category so the admin can see impact
    // before deactivating one (e.g. "12 active listings use this category").
    const counts = await Promise.all(
      categories.map((c) =>
        this.prisma.product.count({ where: { category: c.slug, status: 'ACTIVE' } }),
      ),
    );

    return categories.map((c, i) => ({ ...c, activeProductCount: counts[i] }));
  }

  async create(dto: CreateCategoryDto) {
    const slug = slugify(dto.name);
    if (!slug) throw new BadRequestException('Category name must contain letters or numbers');

    const existing = await this.prisma.category.findFirst({
      where: { OR: [{ name: dto.name }, { slug }] },
    });
    if (existing) throw new ConflictException(`A category named "${dto.name}" already exists`);

    return this.prisma.category.create({
      data: {
        name: dto.name,
        slug,
        icon: dto.icon,
        description: dto.description,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');

    // Renaming does NOT change the slug — existing products reference the
    // slug, and changing it would silently orphan every listing in this
    // category. The display name can change freely; the slug is permanent
    // once products exist under it.
    return this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  // "Remove" a category = deactivate it. We never hard-delete: existing
  // products already reference this slug by value (not a DB foreign key,
  // since Prisma can't enforce FK integrity against a plain string field
  // the way it could against a relation). Hard-deleting would leave those
  // products with a category that resolves to nothing in the UI. Deactivating
  // hides it from new listings while old listings keep working.
  async deactivate(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');

    const activeCount = await this.prisma.product.count({
      where: { category: category.slug, status: 'ACTIVE' },
    });

    return {
      category: await this.prisma.category.update({ where: { id }, data: { isActive: false } }),
      warning: activeCount > 0
        ? `${activeCount} active listing(s) still use this category. They remain visible to existing buyers but the category is hidden from new listings and search filters.`
        : null,
    };
  }

  async reactivate(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    return this.prisma.category.update({ where: { id }, data: { isActive: true } });
  }
}
