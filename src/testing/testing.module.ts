// src/testing/testing.module.ts
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { s3MulterStorage } from '../common/storage/s3-multer-storage';
import { TestingService, TransportService } from './testing.service';
import { TestingController, TransportController } from './testing.controller';
import { TransportLifecycleService } from '../transport/transport-lifecycle.service';
import { TransportInvoiceService } from '../transport/transport-invoice.service';
import { TransportDisputeService } from '../transport/transport-dispute.service';
import {
  TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController,
} from '../transport/transport.controller';

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
  // order matters: TransportController (static routes) first, then the Phase 3 controllers
  controllers: [TestingController, TransportController, TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController],
  providers: [TestingService, TransportService, TransportLifecycleService, TransportInvoiceService, TransportDisputeService],
  exports: [TestingService, TransportService, TransportLifecycleService],
})
export class TestingModule {}
