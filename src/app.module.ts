import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { join } from 'path';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OffersModule } from './offers/offers.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { TestingModule } from './testing/testing.module';
import { HealthModule } from './health/health.module';
import { CategoriesModule } from './categories/categories.module';
import { CatalogModule } from './catalog/catalog.module';
import { MediaModule } from './media/media.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    // Global config — reads .env, validated against schema at boot
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),

    // Global rate limiting: 60 requests / 60s per IP by default.
    // Stricter per-route limits (e.g. OTP) are applied via @Throttle() overrides.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),

    // Serve uploaded files statically
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),

    // Core modules
    PrismaModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    OffersModule,
    WarehouseModule,
    TestingModule,
    HealthModule,
    CategoriesModule,
    CatalogModule,
    MediaModule,
  ],
  providers: [
    // Global exception filter
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global rate limit guard — applies to every route unless overridden
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
