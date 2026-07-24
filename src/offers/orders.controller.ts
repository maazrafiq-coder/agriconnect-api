import { Controller, Get, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './offers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OrderStatus } from '@prisma/client';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // GET /orders?role=seller|buyer&status=...
  @Get()
  findAll(
    @CurrentUser('id') userId: string,
    @Query('role') role: 'seller' | 'buyer' = 'buyer',
    @Query('status') status?: string,
  ) {
    return this.ordersService.findAll(userId, role, status);
  }

  // GET /orders/admin — admin view all orders
  @Get('admin')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  adminOrders(
    @Query('status') status?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.ordersService.getAdminOrders(status, +page, +limit);
  }

  // GET /orders/:id
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.ordersService.findOne(id, userId);
  }

  // PATCH /orders/:id/status
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('status') status: OrderStatus,
    @Body('note') note?: string,
  ) {
    return this.ordersService.updateStatus(id, userId, status, note);
  }

  // PATCH /orders/admin/:id/resolve-dispute
  @Patch('admin/:id/resolve-dispute')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  resolveDispute(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body('resolution') resolution: 'completed' | 'cancelled',
    @Body('note') note: string,
  ) {
    return this.ordersService.adminResolveDispute(id, adminId, resolution, note);
  }
}
