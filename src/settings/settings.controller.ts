import { Body, Controller, Delete, Get, Param, Put, UseGuards, BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Admin-only configuration. (Reading the fee is harmless but there is no
// public use for it, so everything here is ADMIN.)
@Controller('settings/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // GET /settings/admin — current fee + all commodity prices
  @Get()
  async getAll() {
    const [platformFeePct, commodityPrices] = await Promise.all([
      this.settings.getPlatformFeePct(),
      this.settings.listCommodityPrices(),
    ]);
    return { platformFeePct, commodityPrices };
  }

  // PUT /settings/admin/platform-fee  { platformFeePct }
  @Put('platform-fee')
  setFee(@CurrentUser('id') adminId: string, @Body('platformFeePct') pct: number) {
    return this.settings.setPlatformFeePct(Number(pct), adminId);
  }

  // PUT /settings/admin/commodity-prices  { commodity, pricePerTon }
  @Put('commodity-prices')
  setPrice(@CurrentUser('id') adminId: string, @Body('commodity') commodity: string, @Body('pricePerTon') price: number) {
    if (typeof commodity !== 'string') throw new BadRequestException('Commodity name is required');
    return this.settings.setCommodityPrice(commodity, Number(price), adminId);
  }

  // DELETE /settings/admin/commodity-prices/:commodity
  @Delete('commodity-prices/:commodity')
  removePrice(@Param('commodity') commodity: string) {
    return this.settings.deleteCommodityPrice(commodity);
  }
}
