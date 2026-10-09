// src/settings/settings.service.ts
//
// Admin-maintained platform configuration:
//   - platform_fee_pct  — the % AgriConnect keeps on each completed order
//   - commodity prices  — reference PKR/ton used to value warehouse receipts
//
// Both used to be hard-coded (1.5% and 38,000/ton for every commodity).
import { BadRequestException, Injectable } from '@nestjs/common';
import { recordAudit } from '../common/utils/audit.util';
import { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_PLATFORM_FEE_PCT = 1.5;
const FEE_KEY = 'platform_fee_pct';

export const normaliseCommodity = (name: string) => String(name ?? '').trim().toLowerCase();

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  // ─── PLATFORM FEE ────────────────────────────────────────────────────────
  async getPlatformFeePct(): Promise<number> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: FEE_KEY } });
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_PLATFORM_FEE_PCT;
  }

  async setPlatformFeePct(pct: number, adminId: string) {
    if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
      throw new BadRequestException('Platform fee must be between 0% and 25%');
    }
    await this.prisma.platformSetting.upsert({
      where: { key: FEE_KEY },
      create: { key: FEE_KEY, value: String(pct), updatedById: adminId },
      update: { value: String(pct), updatedById: adminId },
    });
    await recordAudit(this.prisma, adminId, 'platform_fee_changed', 'setting', FEE_KEY, { platformFeePct: pct });
    return { platformFeePct: pct };
  }

  // ─── COMMODITY PRICES ────────────────────────────────────────────────────
  listCommodityPrices() {
    return this.prisma.commodityPrice.findMany({ orderBy: { label: 'asc' } });
  }

  // Returns PKR per ton for a commodity, or null if the admin hasn't set one.
  async getCommodityPricePerTon(commodity: string): Promise<number | null> {
    const row = await this.prisma.commodityPrice.findUnique({ where: { commodity: normaliseCommodity(commodity) } });
    return row ? Number(row.pricePerTon) : null;
  }

  // Sets/updates a price. Receipts that were issued while no price existed
  // (marketValue 0 — "valuation pending") for this commodity are valued now.
  async setCommodityPrice(label: string, pricePerTon: number, adminId: string) {
    const key = normaliseCommodity(label);
    if (!key) throw new BadRequestException('Commodity name is required');
    if (!Number.isFinite(pricePerTon) || pricePerTon <= 0) {
      throw new BadRequestException('Price per ton must be greater than zero');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const price = await tx.commodityPrice.upsert({
        where: { commodity: key },
        create: { commodity: key, label: label.trim(), pricePerTon, updatedById: adminId },
        update: { label: label.trim(), pricePerTon, updatedById: adminId },
      });

      const pending = await tx.warehouseReceipt.findMany({
        where: { marketValue: 0, commodity: { equals: key, mode: 'insensitive' } },
        select: { id: true, quantityTons: true },
      });
      for (const r of pending) {
        await tx.warehouseReceipt.update({
          where: { id: r.id },
          data: { marketValue: Math.round(r.quantityTons * pricePerTon * 100) / 100 },
        });
      }
      return { price, receiptsValued: pending.length };
    });
    await recordAudit(this.prisma, adminId, 'commodity_price_set', 'commodity', key, { pricePerTon, receiptsValued: result.receiptsValued });
    return result;
  }

  async deleteCommodityPrice(commodity: string) {
    await this.prisma.commodityPrice.deleteMany({ where: { commodity: normaliseCommodity(commodity) } });
    return { message: 'Price removed. New receipts for this commodity will be "valuation pending" until a price is set.' };
  }
}
