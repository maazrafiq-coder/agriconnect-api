import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';

@Module({
  imports: [
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Round 2, Milestone 4 — see auth.module.ts for full reasoning.
        storage: s3MulterStorage(config, { folder: 'listings', filenamePrefix: 'listing' }),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      }),
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
