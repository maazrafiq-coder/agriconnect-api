// src/testing/testing.module.ts
import { Module } from '@nestjs/common';
import { TestingService, TransportService } from './testing.service';
import { TestingController, TransportController } from './testing.controller';

@Module({
  controllers: [TestingController, TransportController],
  providers: [TestingService, TransportService],
  exports: [TestingService, TransportService],
})
export class TestingModule {}
