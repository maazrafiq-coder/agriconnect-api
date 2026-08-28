// src/review/review.module.ts
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { ReviewService } from './review.service';
import { ReviewController } from './review.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') || '15m' },
      }),
    }),
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Round 2, Milestone 4 — see auth.module.ts for full reasoning.
        // Same signed-endpoint access pattern (ReviewController.serveFile),
        // now resolving to a presigned bucket URL instead of a local path.
        storage: s3MulterStorage(config, { folder: 'clarifications', filenamePrefix: 'clarification' }),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      }),
    }),
  ],
  controllers: [ReviewController],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class ReviewModule {}
