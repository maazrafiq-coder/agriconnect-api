import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

// Global so any feature module can inject StorageService without each
// one separately importing StorageModule (mirrors how PrismaModule is
// wired — see prisma/prisma.module.ts).
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
