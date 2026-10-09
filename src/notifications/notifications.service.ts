import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  // Free-form payload; `link` (a frontend path) lets the bell deep-link.
  data?: Record<string, any>;
}

// In-app notifications. The Notification table existed from the start but
// nothing ever wrote to it. Delivery here is deliberately best-effort: a
// failure to notify must never roll back or fail the business action that
// triggered it (e.g. placing a lien), so notify() swallows and logs errors.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  async notify(input: NotifyInput): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Could not create notification for ${input.userId}: ${err?.message}`);
    }
  }

  async notifyMany(inputs: NotifyInput[]): Promise<void> {
    await Promise.all(inputs.map((i) => this.notify(i)));
  }

  async list(userId: string, limit = 30) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({ where: { userId, isRead: false } });
    return { count };
  }

  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    // Same 404 for "not found" and "not yours" so ids can't be probed.
    if (!n || n.userId !== userId) throw new NotFoundException('Notification not found');
    if (n.isRead) return n;
    return this.prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
  }

  async markAllRead(userId: string) {
    const r = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: r.count };
  }
}
