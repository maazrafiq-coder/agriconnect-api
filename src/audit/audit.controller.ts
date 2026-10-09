import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

// Read-only view of the audit trail for the admin Security section.
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  // GET /audit/admin?action=&userId=&page=&limit=
  @Get('admin')
  async list(
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const where: any = {};
    if (action) where.action = action;
    if (userId) where.userId = userId;
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * l, take: l }),
      this.prisma.auditLog.count({ where }),
    ]);
    // Resolve actor names in one query instead of per row.
    const ids = [...new Set(rows.map((r: any) => r.userId).filter(Boolean))] as string[];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, phoneNumber: true, email: true, profile: { select: { fullName: true } } } })
      : [];
    const byId = new Map(users.map((u: any) => [u.id, u]));
    return {
      data: rows.map((r: any) => ({ ...r, actor: byId.get(r.userId) ? { name: (byId.get(r.userId) as any).profile?.fullName, role: (byId.get(r.userId) as any).role } : null })),
      meta: { total, page: p, limit: l, totalPages: Math.ceil(total / l) },
    };
  }
}
