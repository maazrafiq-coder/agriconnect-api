// prisma/seed.ts
import { PrismaClient, UserRole, KycStatus, RiceStage, ProductStatus, WarehouseType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding AgriConnect database...');

  // ─── CATEGORIES ───────────────────────────────────────────────────────────
  // These used to be a hardcoded Prisma enum. Now they're real rows the
  // admin can add to, rename, or deactivate from the Admin Portal without
  // a code deploy. Seeding the same starting set so existing behavior
  // doesn't change on first run.
  const initialCategories = [
    { name: 'Rice',           slug: 'rice',           icon: '🌾', sortOrder: 1 },
    { name: 'Paddy',          slug: 'paddy',           icon: '🌾', sortOrder: 2 },
    { name: 'Wheat',          slug: 'wheat',           icon: '🌿', sortOrder: 3 },
    { name: 'Maize',          slug: 'maize',           icon: '🌽', sortOrder: 4 },
    { name: 'Cotton',         slug: 'cotton',          icon: '☁️', sortOrder: 5 },
    { name: 'Sugarcane',      slug: 'sugarcane',       icon: '🎋', sortOrder: 6 },
    { name: 'Pulses',         slug: 'pulses',          icon: '🫘', sortOrder: 7 },
    { name: 'Oil Seeds',      slug: 'oil-seeds',       icon: '🛢️', sortOrder: 8 },
    { name: 'Fruits',         slug: 'fruits',          icon: '🍎', sortOrder: 9 },
    { name: 'Vegetables',     slug: 'vegetables',      icon: '🥬', sortOrder: 10 },
    { name: 'Livestock Feed', slug: 'livestock-feed',  icon: '🐄', sortOrder: 11 },
    { name: 'Other',          slug: 'other',           icon: '📦', sortOrder: 12 },
  ];

  for (const cat of initialCategories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: cat,
    });
  }
  console.log(`  ✓ Seeded ${initialCategories.length} categories`);

  // ─── CITIES ───────────────────────────────────────────────────────────────
  const initialCities = [
    { name: 'Lahore', province: 'Punjab' }, { name: 'Sheikhupura', province: 'Punjab' },
    { name: 'Gujranwala', province: 'Punjab' }, { name: 'Multan', province: 'Punjab' },
    { name: 'Faisalabad', province: 'Punjab' }, { name: 'Rawalpindi', province: 'Punjab' },
    { name: 'Karachi', province: 'Sindh' }, { name: 'Hyderabad', province: 'Sindh' },
    { name: 'Larkana', province: 'Sindh' }, { name: 'Sukkur', province: 'Sindh' },
    { name: 'Peshawar', province: 'KPK' }, { name: 'Mardan', province: 'KPK' },
    { name: 'Quetta', province: 'Balochistan' },
  ];
  for (const [i, city] of initialCities.entries()) {
    await prisma.city.upsert({
      where: { name_province: { name: city.name, province: city.province } },
      update: {},
      create: { ...city, sortOrder: i },
    });
  }
  console.log(`  ✓ Seeded ${initialCities.length} cities`);

  // ─── UNITS ────────────────────────────────────────────────────────────────
  // Global units (categoryId: null) apply everywhere. Category-scoped units
  // only show up in that category's dropdown — this is what lets Rice offer
  // "40kg bags" while Cotton offers "Bales" without cluttering either list.
  const riceCategory = await prisma.category.findUnique({ where: { slug: 'rice' } });
  const cottonCategory = await prisma.category.findUnique({ where: { slug: 'cotton' } });

  const initialUnits = [
    { name: 'kg', categoryId: null, sortOrder: 1 },
    { name: 'Tons', categoryId: null, sortOrder: 2 },
    { name: 'Maunds', categoryId: null, sortOrder: 3 },
    { name: '40kg bags', categoryId: riceCategory?.id, sortOrder: 4 },
    { name: '50kg bags', categoryId: riceCategory?.id, sortOrder: 5 },
    { name: 'Bales', categoryId: cottonCategory?.id, sortOrder: 6 },
  ];
  for (const unit of initialUnits) {
    const existing = await prisma.unit.findFirst({
      where: { name: unit.name, categoryId: unit.categoryId ?? null },
    });
    if (!existing) {
      await prisma.unit.create({ data: unit });
    }
  }
  console.log(`  ✓ Seeded ${initialUnits.length} units`);


  // ─── ADMIN ────────────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('Admin@123', 10);
  const admin = await prisma.user.upsert({
    where: { phoneNumber: '0300-0000000' },
    update: {},
    create: {
      phoneNumber: '0300-0000000',
      email: 'admin@agriconnect.pk',
      passwordHash: adminHash,
      role: UserRole.ADMIN,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Platform Administrator',
          city: 'Lahore',
          province: 'Punjab',
        },
      },
    },
  });

  // ─── DEMO SELLER ─────────────────────────────────────────────────────────
  const sellerHash = await bcrypt.hash('Seller@123', 10);
  const seller = await prisma.user.upsert({
    where: { phoneNumber: '0300-1111111' },
    update: {},
    create: {
      phoneNumber: '0300-1111111',
      email: 'seller@agriconnect.pk',
      passwordHash: sellerHash,
      role: UserRole.TRADER,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Khan Rice Mills',
          businessName: 'Khan Rice Mills Pvt. Ltd.',
          cnicNumber: '35202-1234567-1',
          city: 'Sheikhupura',
          province: 'Punjab',
          farmSizeAcres: 500,
          cropsGrown: ['Rice', 'Wheat'],
        },
      },
    },
  });

  // ─── DEMO BUYER ──────────────────────────────────────────────────────────
  const buyerHash = await bcrypt.hash('Buyer@123', 10);
  const buyer = await prisma.user.upsert({
    where: { phoneNumber: '0300-2222222' },
    update: {},
    create: {
      phoneNumber: '0300-2222222',
      email: 'buyer@agriconnect.pk',
      passwordHash: buyerHash,
      role: UserRole.BUYER,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Ahmed Exports Ltd',
          businessName: 'Ahmed Agri Exports Pvt. Ltd.',
          cnicNumber: '42101-9876543-2',
          ntnNumber: '1234567-8',
          city: 'Karachi',
          province: 'Sindh',
        },
      },
    },
  });

  // ─── DEMO WAREHOUSE OPERATOR ─────────────────────────────────────────────
  const warehouseUserHash = await bcrypt.hash('Warehouse@123', 10);
  const warehouseUser = await prisma.user.upsert({
    where: { phoneNumber: '0300-3333333' },
    update: {},
    create: {
      phoneNumber: '0300-3333333',
      email: 'warehouse@agriconnect.pk',
      passwordHash: warehouseUserHash,
      role: UserRole.WAREHOUSE,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Punjab Cold Chain Hub',
          businessName: 'Punjab Cold Chain Hub Pvt. Ltd.',
          city: 'Sheikhupura',
          province: 'Punjab',
        },
      },
      warehouseProfile: {
        create: {
          name: 'Punjab Cold Chain Hub',
          type: WarehouseType.COLD_STORAGE,
          city: 'Sheikhupura',
          province: 'Punjab',
          address: 'Near Motorway M-2, Sheikhupura, Punjab',
          gpsCoordinates: '31.7167° N, 73.9850° E',
          totalCapacityTons: 5000,
          pricePerTonMonth: 850,
          minDurationDays: 7,
          commoditiesAccepted: ['Rice', 'Wheat', 'Maize', 'Vegetables', 'Fruits'],
          certifications: ['PSQCA Certified', 'ISO 22000', 'Halal Certified'],
          features: ['Temperature Control (0–8°C)', 'Humidity Control', '24/7 CCTV', 'Fire Suppression', 'Pest Control', 'Armed Security'],
          bankPartners: ['HBL', 'MCB', 'Bank Alfalah'],
          insuranceAvailable: true,
          isVerified: true,
          managerName: 'Malik Irfan',
          managerPhone: '0300-1234567',
          establishedYear: 2018,
          description: 'State-of-the-art cold chain facility with international standards.',
          rating: 4.8,
          reviewCount: 142,
        },
      },
    },
  });

  // ─── DEMO PRODUCTS ───────────────────────────────────────────────────────
  const product1 = await prisma.product.upsert({
    where: { id: 'seed-product-001' },
    update: {},
    create: {
      id: 'seed-product-001',
      sellerId: seller.id,
      category: 'rice',
      name: '1121 Basmati — Milled White',
      description: 'Premium 1121 Basmati from certified fields. Extra long grain, excellent aroma, export-grade quality preferred by Middle East markets.',
      quantity: 500,
      unit: '40kg bags',
      askingPrice: 3800,
      minOrderQty: 50,
      locationCity: 'Sheikhupura',
      locationProvince: 'Punjab',
      harvestDate: new Date('2024-10-01'),
      packagingType: 'Woven PP Bags',
      deliveryTerms: 'Ex-Works Sheikhupura',
      status: ProductStatus.ACTIVE,
      riceDetails: {
        create: {
          stage: RiceStage.MILLED_WHITE,
          variety: '1121 Basmati',
          newCrop: true,
          moisturePct: 12.5,
          grainLengthMm: 7.8,
          grainWidthMm: 1.85,
          lWRatio: 4.2,
          brokenPct: 2.1,
          chalkinessPct: 3.2,
          purityPct: 98.5,
          foreignMatterPct: 0.2,
          millingYieldPct: 68.5,
          whitenessIndex: 42,
        },
      },
    },
  });

  const product2 = await prisma.product.upsert({
    where: { id: 'seed-product-002' },
    update: {},
    create: {
      id: 'seed-product-002',
      sellerId: seller.id,
      category: 'rice',
      name: 'Super Basmati — Export Grade',
      description: 'Super Basmati with superior aroma and extra long grain. RRI Kala Shah Kaku certified.',
      quantity: 300,
      unit: '50kg bags',
      askingPrice: 4100,
      minOrderQty: 30,
      locationCity: 'Lahore',
      locationProvince: 'Punjab',
      harvestDate: new Date('2024-10-15'),
      status: ProductStatus.ACTIVE,
      riceDetails: {
        create: {
          stage: RiceStage.WHITE_RICE,
          variety: 'Super Basmati',
          newCrop: true,
          moisturePct: 11.8,
          grainLengthMm: 8.1,
          grainWidthMm: 1.78,
          brokenPct: 1.5,
          purityPct: 99.0,
          millingYieldPct: 70.0,
          whitenessIndex: 44,
        },
      },
    },
  });

  // ─── DEMO TESTING AGENCY ─────────────────────────────────────────────────
  const agencyHash = await bcrypt.hash('Agency@123', 10);
  const agencyUser = await prisma.user.upsert({
    where: { phoneNumber: '0300-4444444' },
    update: {},
    create: {
      phoneNumber: '0300-4444444',
      email: 'lab@agriconnect.pk',
      passwordHash: agencyHash,
      role: UserRole.TESTING_AGENCY,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Punjab Food Authority Lab',
          businessName: 'Punjab Food Authority Quality Testing Laboratory',
          city: 'Lahore',
          province: 'Punjab',
        },
      },
      testingAgencyProfile: {
        create: {
          name: 'Punjab Food Authority Lab',
          city: 'Lahore',
          province: 'Punjab',
          accreditations: ['ISO 17025', 'PNAC Accredited'],
          services: ['Moisture', 'Grain Size', 'Broken %', 'Whiteness Index', 'Milling Yield', 'Purity Analysis'],
          basePrice: 2500,
          turnaroundHours: 48,
          coverageAreas: ['Punjab', 'Federal'],
          isVerified: true,
          rating: 4.8,
          reviewCount: 234,
        },
      },
    },
  });

  // ─── DEMO TRANSPORTER ────────────────────────────────────────────────────
  const transportHash = await bcrypt.hash('Transport@123', 10);
  const transporter = await prisma.user.upsert({
    where: { phoneNumber: '0300-5555555' },
    update: {},
    create: {
      phoneNumber: '0300-5555555',
      email: 'transport@agriconnect.pk',
      passwordHash: transportHash,
      role: UserRole.TRANSPORTER,
      isPhoneVerified: true,
      kycStatus: KycStatus.APPROVED,
      profile: {
        create: {
          fullName: 'Pak Logistics Express',
          businessName: 'Pak Logistics Express Pvt. Ltd.',
          city: 'Lahore',
          province: 'Punjab',
        },
      },
      transportProfile: {
        create: {
          companyName: 'Pak Logistics Express',
          vehicleTypes: ['LARGE_TRUCK', 'CONTAINER', 'REFRIGERATED'],
          maxCapacityTons: 40,
          coverageProvinces: ['Punjab', 'Sindh', 'KPK', 'Balochistan'],
          pricePerKm: 45,
          hasGps: true,
          hasInsurance: true,
          isVerified: true,
          rating: 4.7,
          reviewCount: 189,
        },
      },
    },
  });

  console.log('');
  console.log('✅ Seed complete! Demo accounts:');
  console.log('');
  console.log('  Role          Phone           Password');
  console.log('  ──────────    ─────────────   ──────────');
  console.log('  Admin         0300-0000000    Admin@123');
  console.log('  Seller        0300-1111111    Seller@123');
  console.log('  Buyer         0300-2222222    Buyer@123');
  console.log('  Warehouse     0300-3333333    Warehouse@123');
  console.log('  Lab Agency    0300-4444444    Agency@123');
  console.log('  Transporter   0300-5555555    Transport@123');
  console.log('');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
