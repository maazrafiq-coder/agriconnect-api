# 🌾 AgriConnect Pakistan — Backend API

NestJS REST API for the AgriConnect Pakistan agriculture marketplace platform.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in your values
cp .env.example .env

# 3. Start a local PostgreSQL database (Docker)
docker run -d \
  --name agriconnect-db \
  -e POSTGRES_DB=agriconnect \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:16

# 4. Run database migrations
npm run db:push

# 5. Seed demo data (creates 6 demo accounts)
npm run db:seed

# 6. Start development server
npm run start:dev
# → API:  http://localhost:3000/api/v1
# → Docs: http://localhost:3000/docs
```

---

## Project Structure

```
src/
├── main.ts                     Entry point — CORS, Swagger, ValidationPipe
├── app.module.ts               Root module wiring
├── prisma/
│   ├── prisma.service.ts       PrismaClient singleton
│   └── prisma.module.ts        Global Prisma module
├── common/
│   ├── guards/
│   │   ├── jwt-auth.guard.ts   Requires valid JWT
│   │   └── roles.guard.ts      Role-based access control
│   ├── decorators/
│   │   ├── current-user.ts     @CurrentUser() param decorator
│   │   └── roles.decorator.ts  @Roles('ADMIN') metadata
│   └── filters/
│       └── http-exception.filter.ts  Global error handler
├── auth/                       Register, OTP, login, KYC, JWT
├── users/                      Profiles, admin user management
├── products/                   Listings, search, media upload
├── offers/                     Offer submission, negotiation, orders
├── warehouse/                  Storage, DWR, bank liens, insurance
└── testing/                    Lab agencies, testing requests, transport

prisma/
├── schema.prisma               Full database schema (17 models)
└── seed.ts                     Demo data seed
```

---

## API Endpoints

### Auth  `POST /api/v1/auth/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/register` | Register new user | Public |
| POST | `/verify-otp` | Verify phone OTP | Public |
| POST | `/login` | Login with phone + password | Public |
| POST | `/refresh` | Refresh access token | Public |
| POST | `/logout` | Revoke refresh token | 🔒 |
| POST | `/kyc/submit` | Upload CNIC documents | 🔒 |
| GET | `/kyc/status` | Check KYC status | 🔒 |
| POST | `/forgot-password` | Send reset OTP | Public |
| POST | `/reset-password` | Reset with OTP | Public |
| GET | `/me` | Current user info | 🔒 |

### Products  `GET|POST /api/v1/products/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/` | Search products (filters, pagination) | Public |
| GET | `/my` | Seller's own listings | 🔒 |
| GET | `/saved` | Buyer's saved products | 🔒 |
| GET | `/:id` | Product detail | Public |
| POST | `/` | Create product listing | 🔒 |
| PATCH | `/:id` | Update listing | 🔒 |
| PATCH | `/:id/status` | Pause / activate / remove | 🔒 |
| POST | `/:id/media` | Upload images / documents | 🔒 |
| POST | `/:id/save` | Toggle save product | 🔒 |

### Offers  `POST /api/v1/offers/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/` | Submit offer on product | 🔒 |
| GET | `/received` | Seller: incoming offers | 🔒 |
| GET | `/sent` | Buyer: sent offers | 🔒 |
| PATCH | `/:id/accept` | Accept offer (creates order) | 🔒 |
| PATCH | `/:id/reject` | Reject offer | 🔒 |
| PATCH | `/:id/counter` | Counter-offer | 🔒 |

### Orders  `GET|PATCH /api/v1/orders/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/` | List orders (seller or buyer) | 🔒 |
| GET | `/admin` | All orders (admin) | 🔒 Admin |
| GET | `/:id` | Order detail | 🔒 |
| PATCH | `/:id/status` | Update order status | 🔒 |

### Warehouse  `GET|POST /api/v1/warehouse/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/` | Browse warehouses | Public |
| GET | `/:id` | Warehouse detail | Public |
| POST | `/register` | Register warehouse | 🔒 |
| POST | `/book` | Book storage | 🔒 |
| GET | `/receipts/my` | My digital warehouse receipts | 🔒 |
| GET | `/receipts/:id` | Single receipt | 🔒 |
| POST | `/receipts/issue/:bookingId` | Issue DWR (operator) | 🔒 |
| POST | `/lien/apply` | Apply for bank lien | 🔒 |
| PATCH | `/lien/:id/release` | Release lien | 🔒 |
| POST | `/insurance/buy` | Buy storage insurance | 🔒 |
| GET | `/dashboard/operator` | Operator dashboard | 🔒 |
| GET | `/admin/all` | All warehouses (admin) | 🔒 Admin |
| PATCH | `/admin/:id/verify` | Verify warehouse (admin) | 🔒 Admin |

### Testing  `GET|POST /api/v1/testing/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/agencies` | Browse agencies | Public |
| POST | `/requests` | Create testing request | 🔒 |
| GET | `/requests/my` | My requests | 🔒 |
| PATCH | `/requests/:id/status` | Update status | 🔒 |
| POST | `/requests/:id/report` | Submit lab report | 🔒 |

### Transport  `GET|POST /api/v1/transport/...`

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/providers` | Browse providers | Public |
| POST | `/requests` | Create transport request | 🔒 |
| POST | `/book` | Book a provider | 🔒 |
| GET | `/requests/my` | My requests | 🔒 |
| PATCH | `/requests/:id/tracking` | Update location | 🔒 |
| GET | `/track/:id` | Public shipment tracking | Public |

---

## Demo Accounts (after seed)

| Role | Phone | Password |
|------|-------|----------|
| Admin | 0300-0000000 | Admin@123 (**local/dev only** — the seed refuses to run when `NODE_ENV=production`; if a seeded admin ever reached a real database, change its password immediately) |
| Seller/Trader | 0300-1111111 | Seller@123 |
| Buyer/Exporter | 0300-2222222 | Buyer@123 |
| Warehouse Op. | 0300-3333333 | Warehouse@123 |
| Lab Agency | 0300-4444444 | Agency@123 |
| Transporter | 0300-5555555 | Transport@123 |

---

## Connect Frontend

In your Vite frontend, update `src/data/index.js` to fetch from the API:

```js
// src/lib/api.js
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('accessToken');
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...options,
  });
  if (!res.ok) throw await res.json();
  return res.json();
}

// Example usage
export const getProducts = (params) =>
  apiFetch(`/products?${new URLSearchParams(params)}`);

export const login = (data) =>
  apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(data) });
```

---

## Deploy to Production

### Railway (recommended for NestJS)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
railway variables set DATABASE_URL="..."
railway variables set JWT_SECRET="..."
```

### Docker
A multi-stage `Dockerfile` is included (build → slim runtime, non-root, `tini`).

```bash
docker build -t agriconnect-api .
docker compose up --build          # API + Postgres for local use (uses .env)
```
On start the entrypoint runs `prisma migrate deploy` when `prisma/migrations/` has migrations, otherwise `prisma db push` (the old behaviour). Set `SKIP_DB_SETUP=true` to skip both.

### Moving from `db push` to migrations (one-time)
```bash
# DATABASE_URL = your existing database (back it up first)
npm run db:baseline     # writes prisma/migrations/0_init and marks it applied
git add prisma/migrations
```
After that: `npx prisma migrate dev --name <change>` locally, `npm run db:deploy` in production.

### Tests
```bash
npm test                                   # unit tests (no database needed)
docker compose -f docker-compose.test.yml up -d
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/agri_test
npm run test:integration:setup && npm run test:integration   # real-Postgres tests
```

---

## Database Management

```bash
npm run db:studio     # Open Prisma Studio (visual DB browser)
npm run db:migrate    # Create a new migration
npm run db:push       # Push schema changes (dev only)
npm run db:seed       # Seed demo data
npm run db:generate   # Regenerate Prisma client
```
