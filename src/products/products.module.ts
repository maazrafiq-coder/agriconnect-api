import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  imports: [
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Round 2, Milestone 4 — see auth.module.ts for full reasoning.
        // Listing photos are public-facing (unlike KYC docs) but still
        // go through StorageService.getPresignedUrl at read-time rather
        // than a permanent public URL — see products.service.ts.
        storage: s3MulterStorage(config, { folder: 'products', filenamePrefix: 'product' }),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      }),
    }),
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
