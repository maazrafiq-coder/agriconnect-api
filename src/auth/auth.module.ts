import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RegistrationTokenGuard } from '../common/guards/registration-token.guard';
import { KycAuthGuard } from '../common/guards/kyc-auth.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
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
        // Round 2, Milestone 4: uploads now go straight to a Railway
        // Storage Bucket instead of local disk (see
        // common/storage/s3-multer-storage.ts) — the container
        // filesystem is ephemeral and was silently losing every KYC
        // document on redeploy. The bucket has no public access; KYC
        // documents are still served exclusively through the signed,
        // time-limited, access-checked endpoint below
        // (getKycDocumentSignedUrl / GET /auth/kyc/documents/file/:token),
        // which now resolves to a short-lived presigned bucket URL
        // instead of a local file path. Content-type validation (real
        // magic-byte check, not just extension) happens inside the
        // storage engine itself, before anything is uploaded.
        storage: s3MulterStorage(config, { folder: 'kyc', filenamePrefix: 'kyc' }),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RegistrationTokenGuard, KycAuthGuard],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
