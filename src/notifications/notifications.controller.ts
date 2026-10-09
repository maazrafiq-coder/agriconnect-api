import { Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // GET /notifications — latest notifications for the logged-in user
  @Get()
  list(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.notifications.list(userId, limit ? Number(limit) || 30 : 30);
  }

  // GET /notifications/unread-count — cheap poll for the bell badge
  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  // PATCH /notifications/read-all  (declared before :id/read — literal first)
  @Patch('read-all')
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  // PATCH /notifications/:id/read
  @Patch(':id/read')
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }
}
