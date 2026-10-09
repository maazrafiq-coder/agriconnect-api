import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminReviewService } from './admin-review.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin-review')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'MODERATOR')
export class AdminReviewController {
  constructor(private readonly adminReview: AdminReviewService) {}

  // GET /admin-review/:type/:id — complete read-only detail of a listing
  // (warehouse | testing_agency | transport | product) with owner,
  // submitted documents and activity, for the admin review screens.
  @Get(':type/:id')
  getDetail(@Param('type') type: string, @Param('id') id: string) {
    return this.adminReview.getDetail(type, id);
  }
}
