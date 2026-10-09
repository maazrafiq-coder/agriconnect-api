// src/testing/testing.module.ts
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { TestingService, TransportService } from './testing.service';
import { TestingController, TransportController } from './testing.controller';

@Module({
  imports: [
    // Lab report documents: stored permanently; downloads are signed on demand.
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: s3MulterStorage(config, { folder: 'lab-reports', filenamePrefix: 'lab-report' }),
        limits: { fileSize: 10 * 1024 * 1024 },
      }),
    }),
  ],
  controllers: [TestingController, TransportController],
  providers: [TestingService, TransportService],
  exports: [TestingService, TransportService],
})
export class TestingModule {}
