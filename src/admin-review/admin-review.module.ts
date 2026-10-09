import { Module } from '@nestjs/common';
import { AdminReviewService } from './admin-review.service';
import { AdminReviewController } from './admin-review.controller';

@Module({
  controllers: [AdminReviewController],
  providers: [AdminReviewService],
})
export class AdminReviewModule {}
