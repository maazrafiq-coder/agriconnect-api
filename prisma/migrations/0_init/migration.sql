-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('FARMER', 'TRADER', 'MILLER', 'EXPORTER', 'BUYER', 'TRANSPORTER', 'WAREHOUSE', 'TESTING_AGENCY', 'BANK', 'INSURANCE', 'INVESTOR', 'ADMIN', 'MODERATOR');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'SUBMITTED', 'RECOMMENDED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiceStage" AS ENUM ('PADDY', 'BROWN_RICE', 'MILLED_WHITE', 'WHITE_RICE', 'PARBOILED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'UNDER_OFFER', 'SOLD', 'PAUSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COUNTERED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('ORDER_PAYMENT', 'STORAGE_FEE', 'TESTING_FEE', 'TRANSPORT_FEE', 'INSURANCE_PREMIUM', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'PLATFORM_FEE', 'REFUND');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('COLD_STORAGE', 'DRY_STORAGE', 'CONTROLLED_ATMOSPHERE', 'BONDED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('ACTIVE', 'UNDER_LIEN', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LienStatus" AS ENUM ('PENDING', 'ACTIVE', 'RELEASED', 'DEFAULTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateEnum
CREATE TYPE "GatePassStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TestingStatus" AS ENUM ('REQUESTED', 'ASSIGNED', 'SAMPLE_COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportStatus" AS ENUM ('REQUESTED', 'QUOTED', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SMALL_TRUCK', 'MEDIUM_TRUCK', 'LARGE_TRUCK', 'CONTAINER', 'BULK_CARGO', 'REFRIGERATED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER_UPDATE', 'OFFER_RECEIVED', 'OFFER_ACCEPTED', 'OFFER_REJECTED', 'PAYMENT_RECEIVED', 'PAYMENT_DUE', 'TESTING_UPDATE', 'TRANSPORT_UPDATE', 'WAREHOUSE_UPDATE', 'KYC_UPDATE', 'LOAN_UPDATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('OPEN', 'RESPONDED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "BookingMessageKind" AS ENUM ('MESSAGE', 'INFO_REQUEST');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_clarifications" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestMessage" TEXT NOT NULL,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'OPEN',
    "responseMessage" TEXT,
    "respondedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clarification_attachments" (
    "id" TEXT NOT NULL,
    "clarificationId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clarification_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "agriConnectSeq" SERIAL NOT NULL,
    "phoneNumber" TEXT,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "kycApprovedAt" TIMESTAMP(3),
    "kycRejectedAt" TIMESTAMP(3),
    "kycRejectionNote" TEXT,
    "kycInfoRequestNote" TEXT,
    "kycInfoRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "cnicNumber" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "address" TEXT,
    "city" TEXT,
    "province" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Pakistan',
    "profilePhotoUrl" TEXT,
    "businessName" TEXT,
    "ntnNumber" TEXT,
    "companyAddress" TEXT,
    "licenseNumber" TEXT,
    "farmSizeAcres" DOUBLE PRECISION,
    "farmLocation" TEXT,
    "farmGps" TEXT,
    "cropsGrown" TEXT[],
    "bankName" TEXT,
    "bankAccountNo" TEXT,
    "iban" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "s3Key" TEXT,
    "ocrData" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "askingPrice" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "minOrderQty" DOUBLE PRECISION NOT NULL,
    "locationCity" TEXT NOT NULL,
    "locationProvince" TEXT NOT NULL,
    "locationGps" TEXT,
    "harvestDate" TIMESTAMP(3),
    "packagingType" TEXT,
    "deliveryTerms" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionNote" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rice_product_details" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stage" "RiceStage" NOT NULL,
    "variety" TEXT NOT NULL,
    "newCrop" BOOLEAN NOT NULL DEFAULT true,
    "moisturePct" DOUBLE PRECISION,
    "grainLengthMm" DOUBLE PRECISION,
    "grainWidthMm" DOUBLE PRECISION,
    "lWRatio" DOUBLE PRECISION,
    "brokenPct" DOUBLE PRECISION,
    "chalkinessPct" DOUBLE PRECISION,
    "purityPct" DOUBLE PRECISION,
    "foreignMatterPct" DOUBLE PRECISION,
    "damagedGrainPct" DOUBLE PRECISION,
    "yellowGrainPct" DOUBLE PRECISION,
    "millingYieldPct" DOUBLE PRECISION,
    "whitenessIndex" DOUBLE PRECISION,
    "color" TEXT,

    CONSTRAINT "rice_product_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "s3Key" TEXT,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_documents" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "s3Key" TEXT,
    "issuedBy" TEXT,
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_products" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "offeredPrice" DECIMAL(14,2) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "message" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "counterPrice" DECIMAL(14,2),
    "counterMessage" TEXT,
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_messages" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "totalAmount" DECIMAL(16,2) NOT NULL,
    "platformFeePct" DECIMAL(5,2) NOT NULL DEFAULT 1.5,
    "platformFee" DECIMAL(14,2) NOT NULL,
    "netSellerAmount" DECIMAL(14,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "contractUrl" TEXT,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "gatewayRef" TEXT,
    "gatewayResponse" JSONB,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "gpsCoordinates" TEXT,
    "totalCapacityTons" DOUBLE PRECISION NOT NULL,
    "pricePerTonMonth" DECIMAL(10,2) NOT NULL,
    "ratesByCommodity" JSONB,
    "insurancePricePerTonMonth" DECIMAL(10,2),
    "minDurationDays" INTEGER NOT NULL,
    "commoditiesAccepted" TEXT[],
    "certifications" TEXT[],
    "features" TEXT[],
    "bankPartners" TEXT[],
    "insuranceAvailable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "managerName" TEXT,
    "managerPhone" TEXT,
    "establishedYear" INTEGER,
    "description" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_bookings" (
    "id" TEXT NOT NULL,
    "bookingSeq" SERIAL NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "depositorId" TEXT NOT NULL,
    "commodity" TEXT NOT NULL,
    "variety" TEXT,
    "quantityTons" DOUBLE PRECISION NOT NULL,
    "packagingType" TEXT,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "exitDate" TIMESTAMP(3) NOT NULL,
    "pricePerTon" DECIMAL(10,2) NOT NULL,
    "insuranceCost" DECIMAL(12,2),
    "totalCost" DECIMAL(14,2) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "rejectionReason" TEXT,
    "cancelReason" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "includeInsurance" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_messages" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "kind" "BookingMessageKind" NOT NULL DEFAULT 'MESSAGE',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "receiptSeq" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "commodity" TEXT NOT NULL,
    "variety" TEXT,
    "quantityTons" DOUBLE PRECISION NOT NULL,
    "qualityMetrics" JSONB,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "marketValue" DECIMAL(16,2) NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'ACTIVE',
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_liens" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "loanPurpose" TEXT NOT NULL,
    "loanAmount" DECIMAL(16,2) NOT NULL,
    "interestRate" DECIMAL(5,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "loanOfficer" TEXT,
    "loanRefNo" TEXT,
    "status" "LienStatus" NOT NULL DEFAULT 'PENDING',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_liens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_insurance" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "policySeq" SERIAL NOT NULL,
    "coverageAmount" DECIMAL(16,2) NOT NULL,
    "premiumAmount" DECIMAL(12,2) NOT NULL,
    "coverage" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "policyDocUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_insurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceSeq" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "depositorId" TEXT NOT NULL,
    "storageCost" DECIMAL(14,2) NOT NULL,
    "insuranceCost" DECIMAL(12,2),
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentReference" TEXT,
    "paidAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "s3Key" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_notes" (
    "id" TEXT NOT NULL,
    "grnNumber" TEXT NOT NULL,
    "grnSeq" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "depositorId" TEXT NOT NULL,
    "commodity" TEXT NOT NULL,
    "variety" TEXT,
    "quantityTons" DOUBLE PRECISION NOT NULL,
    "qualityNotes" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_out_passes" (
    "id" TEXT NOT NULL,
    "passNumber" TEXT,
    "passSeq" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "depositorId" TEXT NOT NULL,
    "quantityTons" DOUBLE PRECISION NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestNote" TEXT,
    "status" "GatePassStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approverRole" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "s3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_out_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testing_agency_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "accreditations" TEXT[],
    "services" TEXT[],
    "basePrice" DECIMAL(10,2) NOT NULL,
    "turnaroundHours" INTEGER NOT NULL,
    "coverageAreas" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "testing_agency_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testing_requests" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "productId" TEXT,
    "orderId" TEXT,
    "servicesRequested" TEXT[],
    "scheduledDate" TIMESTAMP(3),
    "fee" DECIMAL(10,2) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "status" "TestingStatus" NOT NULL DEFAULT 'REQUESTED',
    "sampleLocation" TEXT,
    "reportUrl" TEXT,
    "reportFileKey" TEXT,
    "reportFileName" TEXT,
    "reportData" JSONB,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "testing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "vehicleTypes" "VehicleType"[],
    "maxCapacityTons" DOUBLE PRECISION NOT NULL,
    "coverageProvinces" TEXT[],
    "pricePerKm" DECIMAL(8,2) NOT NULL,
    "hasGps" BOOLEAN NOT NULL DEFAULT false,
    "hasInsurance" BOOLEAN NOT NULL DEFAULT false,
    "licenseNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_requests" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "providerId" TEXT,
    "orderId" TEXT,
    "pickupLocation" TEXT NOT NULL,
    "pickupCity" TEXT NOT NULL,
    "pickupGps" TEXT,
    "deliveryLocation" TEXT NOT NULL,
    "deliveryCity" TEXT NOT NULL,
    "deliveryGps" TEXT,
    "cargoDescription" TEXT,
    "cargoWeightTons" DOUBLE PRECISION,
    "vehicleType" "VehicleType",
    "requiredDate" TIMESTAMP(3),
    "quotedPrice" DECIMAL(12,2),
    "quoteNote" TEXT,
    "quotedAt" TIMESTAMP(3),
    "agreedPrice" DECIMAL(12,2),
    "status" "TransportStatus" NOT NULL DEFAULT 'REQUESTED',
    "trackingUrl" TEXT,
    "currentLocation" TEXT,
    "estimatedArrival" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "driverName" TEXT,
    "driverPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "participants" TEXT[],
    "lastMessage" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "fileUrl" TEXT,
    "fileType" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "reviewedId" TEXT NOT NULL,
    "orderId" TEXT,
    "productId" TEXT,
    "rating" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "description" TEXT NOT NULL,
    "referenceId" TEXT,
    "referenceType" TEXT,
    "balanceBefore" DECIMAL(14,2),
    "balanceAfter" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_media" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "s3Key" TEXT,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "commodity_prices" (
    "commodity" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pricePerTon" DECIMAL(14,2) NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commodity_prices_pkey" PRIMARY KEY ("commodity")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "cities_name_province_key" ON "cities"("name", "province");

-- CreateIndex
CREATE UNIQUE INDEX "units_name_categoryId_key" ON "units"("name", "categoryId");

-- CreateIndex
CREATE INDEX "review_clarifications_subjectType_subjectId_idx" ON "review_clarifications"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "review_clarifications_status_idx" ON "review_clarifications"("status");

-- CreateIndex
CREATE INDEX "clarification_attachments_clarificationId_idx" ON "clarification_attachments"("clarificationId");

-- CreateIndex
CREATE UNIQUE INDEX "users_agriConnectSeq_key" ON "users"("agriConnectSeq");

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_kycStatus_idx" ON "users"("kycStatus");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_userId_key" ON "user_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_cnicNumber_key" ON "user_profiles"("cnicNumber");

-- CreateIndex
CREATE INDEX "kyc_documents_userId_idx" ON "kyc_documents"("userId");

-- CreateIndex
CREATE INDEX "otps_userId_idx" ON "otps"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "products_sellerId_idx" ON "products"("sellerId");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE INDEX "products_locationProvince_idx" ON "products"("locationProvince");

-- CreateIndex
CREATE INDEX "products_status_createdAt_idx" ON "products"("status", "createdAt");

-- CreateIndex
CREATE INDEX "products_sellerId_status_idx" ON "products"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rice_product_details_productId_key" ON "rice_product_details"("productId");

-- CreateIndex
CREATE INDEX "product_media_productId_idx" ON "product_media"("productId");

-- CreateIndex
CREATE INDEX "product_documents_productId_idx" ON "product_documents"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_products_userId_productId_key" ON "saved_products"("userId", "productId");

-- CreateIndex
CREATE INDEX "offers_productId_idx" ON "offers"("productId");

-- CreateIndex
CREATE INDEX "offers_buyerId_idx" ON "offers"("buyerId");

-- CreateIndex
CREATE INDEX "offers_status_idx" ON "offers"("status");

-- CreateIndex
CREATE INDEX "offers_buyerId_status_idx" ON "offers"("buyerId", "status");

-- CreateIndex
CREATE INDEX "offers_status_expiresAt_idx" ON "offers"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "offer_messages_offerId_createdAt_idx" ON "offer_messages"("offerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_offerId_key" ON "orders"("offerId");

-- CreateIndex
CREATE INDEX "orders_sellerId_idx" ON "orders"("sellerId");

-- CreateIndex
CREATE INDEX "orders_buyerId_idx" ON "orders"("buyerId");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "orders_sellerId_status_idx" ON "orders"("sellerId", "status");

-- CreateIndex
CREATE INDEX "orders_buyerId_status_idx" ON "orders"("buyerId", "status");

-- CreateIndex
CREATE INDEX "order_status_history_orderId_idx" ON "order_status_history"("orderId");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "warehouse_profiles_province_idx" ON "warehouse_profiles"("province");

-- CreateIndex
CREATE INDEX "warehouse_profiles_type_idx" ON "warehouse_profiles"("type");

-- CreateIndex
CREATE INDEX "warehouse_profiles_userId_idx" ON "warehouse_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_bookings_bookingSeq_key" ON "storage_bookings"("bookingSeq");

-- CreateIndex
CREATE INDEX "storage_bookings_warehouseId_idx" ON "storage_bookings"("warehouseId");

-- CreateIndex
CREATE INDEX "storage_bookings_depositorId_idx" ON "storage_bookings"("depositorId");

-- CreateIndex
CREATE INDEX "storage_bookings_status_idx" ON "storage_bookings"("status");

-- CreateIndex
CREATE INDEX "storage_bookings_warehouseId_status_idx" ON "storage_bookings"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "booking_messages_bookingId_createdAt_idx" ON "booking_messages"("bookingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_receipts_receiptNumber_key" ON "warehouse_receipts"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_receipts_receiptSeq_key" ON "warehouse_receipts"("receiptSeq");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_receipts_bookingId_key" ON "warehouse_receipts"("bookingId");

-- CreateIndex
CREATE INDEX "warehouse_receipts_ownerId_idx" ON "warehouse_receipts"("ownerId");

-- CreateIndex
CREATE INDEX "warehouse_receipts_status_idx" ON "warehouse_receipts"("status");

-- CreateIndex
CREATE INDEX "warehouse_receipts_ownerId_status_idx" ON "warehouse_receipts"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_liens_receiptId_key" ON "bank_liens"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_insurance_receiptId_key" ON "storage_insurance"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_insurance_policySeq_key" ON "storage_insurance"("policySeq");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_invoices_invoiceNumber_key" ON "warehouse_invoices"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_invoices_invoiceSeq_key" ON "warehouse_invoices"("invoiceSeq");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_invoices_bookingId_key" ON "warehouse_invoices"("bookingId");

-- CreateIndex
CREATE INDEX "warehouse_invoices_warehouseId_idx" ON "warehouse_invoices"("warehouseId");

-- CreateIndex
CREATE INDEX "warehouse_invoices_depositorId_idx" ON "warehouse_invoices"("depositorId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_notes_grnNumber_key" ON "goods_receipt_notes"("grnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_notes_grnSeq_key" ON "goods_receipt_notes"("grnSeq");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_notes_bookingId_key" ON "goods_receipt_notes"("bookingId");

-- CreateIndex
CREATE INDEX "goods_receipt_notes_warehouseId_idx" ON "goods_receipt_notes"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "gate_out_passes_passNumber_key" ON "gate_out_passes"("passNumber");

-- CreateIndex
CREATE UNIQUE INDEX "gate_out_passes_passSeq_key" ON "gate_out_passes"("passSeq");

-- CreateIndex
CREATE INDEX "gate_out_passes_bookingId_idx" ON "gate_out_passes"("bookingId");

-- CreateIndex
CREATE INDEX "gate_out_passes_warehouseId_idx" ON "gate_out_passes"("warehouseId");

-- CreateIndex
CREATE INDEX "gate_out_passes_status_idx" ON "gate_out_passes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "testing_agency_profiles_userId_key" ON "testing_agency_profiles"("userId");

-- CreateIndex
CREATE INDEX "testing_requests_requesterId_idx" ON "testing_requests"("requesterId");

-- CreateIndex
CREATE INDEX "testing_requests_agencyId_idx" ON "testing_requests"("agencyId");

-- CreateIndex
CREATE INDEX "testing_requests_status_idx" ON "testing_requests"("status");

-- CreateIndex
CREATE INDEX "testing_requests_agencyId_status_idx" ON "testing_requests"("agencyId", "status");

-- CreateIndex
CREATE INDEX "testing_requests_requesterId_status_idx" ON "testing_requests"("requesterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transport_profiles_userId_key" ON "transport_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "transport_requests_orderId_key" ON "transport_requests"("orderId");

-- CreateIndex
CREATE INDEX "transport_requests_requesterId_idx" ON "transport_requests"("requesterId");

-- CreateIndex
CREATE INDEX "transport_requests_providerId_idx" ON "transport_requests"("providerId");

-- CreateIndex
CREATE INDEX "transport_requests_status_idx" ON "transport_requests"("status");

-- CreateIndex
CREATE INDEX "transport_requests_providerId_status_idx" ON "transport_requests"("providerId", "status");

-- CreateIndex
CREATE INDEX "transport_requests_requesterId_status_idx" ON "transport_requests"("requesterId", "status");

-- CreateIndex
CREATE INDEX "messages_conversationId_idx" ON "messages"("conversationId");

-- CreateIndex
CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");

-- CreateIndex
CREATE INDEX "messages_receiverId_idx" ON "messages"("receiverId");

-- CreateIndex
CREATE INDEX "ratings_reviewedId_idx" ON "ratings"("reviewedId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_userId_idx" ON "transactions"("userId");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");

-- CreateIndex
CREATE INDEX "transactions_referenceId_idx" ON "transactions"("referenceId");

-- CreateIndex
CREATE INDEX "listing_media_entityType_entityId_idx" ON "listing_media"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarification_attachments" ADD CONSTRAINT "clarification_attachments_clarificationId_fkey" FOREIGN KEY ("clarificationId") REFERENCES "review_clarifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otps" ADD CONSTRAINT "otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rice_product_details" ADD CONSTRAINT "rice_product_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_products" ADD CONSTRAINT "saved_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_profiles" ADD CONSTRAINT "warehouse_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bookings" ADD CONSTRAINT "storage_bookings_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bookings" ADD CONSTRAINT "storage_bookings_depositorId_fkey" FOREIGN KEY ("depositorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_messages" ADD CONSTRAINT "booking_messages_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "storage_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_messages" ADD CONSTRAINT "booking_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_receipts" ADD CONSTRAINT "warehouse_receipts_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "storage_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_receipts" ADD CONSTRAINT "warehouse_receipts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_receipts" ADD CONSTRAINT "warehouse_receipts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_liens" ADD CONSTRAINT "bank_liens_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "warehouse_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_insurance" ADD CONSTRAINT "storage_insurance_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "warehouse_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_invoices" ADD CONSTRAINT "warehouse_invoices_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "storage_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_invoices" ADD CONSTRAINT "warehouse_invoices_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_invoices" ADD CONSTRAINT "warehouse_invoices_depositorId_fkey" FOREIGN KEY ("depositorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "storage_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_depositorId_fkey" FOREIGN KEY ("depositorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_out_passes" ADD CONSTRAINT "gate_out_passes_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "storage_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_out_passes" ADD CONSTRAINT "gate_out_passes_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_out_passes" ADD CONSTRAINT "gate_out_passes_depositorId_fkey" FOREIGN KEY ("depositorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testing_agency_profiles" ADD CONSTRAINT "testing_agency_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testing_requests" ADD CONSTRAINT "testing_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testing_requests" ADD CONSTRAINT "testing_requests_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "testing_agency_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testing_requests" ADD CONSTRAINT "testing_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_profiles" ADD CONSTRAINT "transport_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "transport_profiles"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_reviewedId_fkey" FOREIGN KEY ("reviewedId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
