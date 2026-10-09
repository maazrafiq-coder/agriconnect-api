import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { join } from 'path';

import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './common/storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OffersModule } from './offers/offers.module';
import { SettingsModule } from './settings/settings.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { TestingModule } from './testing/testing.module';
import { HealthModule } from './health/health.module';
import { CategoriesModule } from './categories/categories.module';
import { CatalogModule } from './catalog/catalog.module';
import { MediaModule } from './media/media.module';
import { ReviewModule } from './review/review.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StatsModule } from './stats/stats.module';
import { AuditModule } from './audit/audit.module';
import { AdminReviewModule } from './admin-review/admin-review.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    // Global config — reads .env, validated against schema at boot
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),

    // Global rate limiting: 60 requests / 60s per IP by default.
    // Stricter per-route limits (e.g. OTP) are applied via @Throttle() overrides.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),

    // Legacy local-disk uploads only. As of Round 2 Milestone 4, new
    // product/listing media uploads go to a Railway Storage Bucket
    // (see StorageModule) and are served via presigned URLs instead —
    // this static route only still serves whatever, if anything,
    // survived on disk from before that migration (the container
    // filesystem is ephemeral, so in practice most of this is gone
    // after any redeploy).
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),

    // Core modules
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    OffersModule,
    SettingsModule,
    WarehouseModule,
    TestingModule,
    HealthModule,
    CategoriesModule,
    CatalogModule,
    MediaModule,
    ReviewModule,
    NotificationsModule,
    AdminReviewModule,
    AuditModule,
    StatsModule,
  ],
  providers: [
    // Global exception filter
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global rate limit guard — applies to every route unless overridden
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
