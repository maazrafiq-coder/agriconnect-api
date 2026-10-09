import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

// Real, public platform figures for the home page (it used to show
// hard-coded "1,248+ sellers" and "₨2.4B+ volume"). Counts only — no money.
@Controller('public')
export class StatsController {
  private cache: { at: number; value: any } | null = null;
  constructor(private prisma: PrismaService) {}

  @Get('stats')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async stats() {
    if (this.cache && Date.now() - this.cache.at < 5 * 60 * 1000) return this.cache.value;
    const [sellers, listings, completedOrders, warehouses] = await Promise.all([
      this.prisma.user.count({ where: { role: { in: ['FARMER', 'TRADER', 'MILLER', 'EXPORTER'] as any }, kycStatus: 'APPROVED' as any, isActive: true } }),
      this.prisma.product.count({ where: { status: 'ACTIVE' as any } }),
      this.prisma.order.count({ where: { status: 'COMPLETED' as any } }),
      this.prisma.warehouseProfile.count({ where: { isVerified: true, isActive: true } }),
    ]);
    const value = { verifiedSellers: sellers, activeListings: listings, completedOrders, verifiedWarehouses: warehouses };
    this.cache = { at: Date.now(), value };
    return value;
  }
}
