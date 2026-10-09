// ─── DTOs ─────────────────────────────────────────────────────────────────────
import {
  IsString, IsNumber, IsOptional, IsEnum, IsBoolean,
  IsDateString, IsArray, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RiceStage } from '@prisma/client';

export class RiceDetailDto {
  @IsEnum(RiceStage)
  stage: RiceStage;

  @IsString()
  variety: string;

  @IsOptional() @IsBoolean()
  newCrop?: boolean;

  @IsOptional() @IsNumber()
  moisturePct?: number;

  @IsOptional() @IsNumber()
  grainLengthMm?: number;

  @IsOptional() @IsNumber()
  grainWidthMm?: number;

  @IsOptional() @IsNumber()
  brokenPct?: number;

  @IsOptional() @IsNumber()
  chalkinessPct?: number;

  @IsOptional() @IsNumber()
  purityPct?: number;

  @IsOptional() @IsNumber()
  foreignMatterPct?: number;

  @IsOptional() @IsNumber()
  millingYieldPct?: number;

  @IsOptional() @IsNumber()
  whitenessIndex?: number;
}

export class CreateProductDto {
  @IsString()
  category: string; // must match an active Category.slug — validated in ProductsService.create()

  @IsString()
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsNumber() @Min(0)
  quantity: number;

  @IsString()
  unit: string;

  @IsNumber() @Min(0)
  askingPrice: number;

  @IsNumber() @Min(0)
  minOrderQty: number;

  @IsString()
  locationCity: string;

  @IsString()
  locationProvince: string;

  @IsOptional() @IsString()
  locationGps?: string;

  @IsOptional() @IsDateString()
  harvestDate?: string;

  @IsOptional() @IsString()
  packagingType?: string;

  @IsOptional() @IsString()
  deliveryTerms?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RiceDetailDto)
  riceDetails?: RiceDetailDto;
}

export class UpdateProductDto {
  // Category and unit are deliberately NOT editable: offers and orders on
  // the listing were priced against them.
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsNumber() @Min(0)
  quantity?: number;

  @IsOptional() @IsNumber() @Min(0)
  askingPrice?: number;

  @IsOptional() @IsNumber() @Min(0)
  minOrderQty?: number;

  @IsOptional() @IsString()
  locationCity?: string;

  @IsOptional() @IsString()
  locationProvince?: string;

  @IsOptional() @IsDateString()
  harvestDate?: string;

  @IsOptional() @IsString()
  packagingType?: string;

  @IsOptional() @IsString()
  deliveryTerms?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RiceDetailDto)
  riceDetails?: RiceDetailDto;
}

export class ProductQueryDto {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  province?: string;

  @IsOptional() @IsString()
  city?: string;

  @IsOptional() @IsString()
  variety?: string;

  @IsOptional() @IsString()
  stage?: string;

  @IsOptional() @IsNumber() @Type(() => Number)
  minPrice?: number;

  @IsOptional() @IsNumber() @Type(() => Number)
  maxPrice?: number;

  @IsOptional() @IsBoolean() @Type(() => Boolean)
  verifiedOnly?: boolean;

  @IsOptional() @IsString()
  sortBy?: string;  // price_asc | price_desc | rating | newest

  @IsOptional() @IsNumber() @Type(() => Number) @Min(1)
  page?: number = 1;

  @IsOptional() @IsNumber() @Type(() => Number) @Min(1)
  limit?: number = 20;
}
