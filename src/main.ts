import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { appLogger } from './common/logging/app-logger';
import { requestIdMiddleware } from './common/logging/request-id.middleware';
import { initSentry } from './common/observability/sentry';

// Multer's diskStorage does NOT create missing destination directories —
// it throws ENOENT on the first upload if they don't already exist. These
// were previously only relying on the directories having been created
// once, manually, on whatever host happened to run this — which is also
// exactly why the plan flags the uploads path as needing a persistent
// Railway volume (a fresh container has no memory of a manual mkdir).
// Creating them at boot, every boot, means a fresh deploy or volume mount
// never silently breaks uploads again.
function ensureUploadDirsExist() {
  const dirs = ['./uploads/products', './uploads/listings', './secure-uploads/kyc'];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

async function bootstrap() {
  ensureUploadDirsExist();

  initSentry();
  const app = await NestFactory.create(AppModule, { logger: appLogger });

  // Behind Railway/nginx, req.ip is the proxy unless told how many hops to
  // trust — which would make the rate limiter treat every user as one client.
  if (process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '') {
    (app as any).set('trust proxy', Number(process.env.TRUST_PROXY));
  }
  app.use(requestIdMiddleware);
  // Finish in-flight requests and close the DB cleanly on SIGTERM (deploys).
  app.enableShutdownHooks();

  // ─── SECURITY HEADERS ───────────────────────────────────────────────────────
  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  // ─── CORS ────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true, // required so the httpOnly refresh-token cookie is sent/received
  });

  // ─── GLOBAL PREFIX ────────────────────────────────────────────────────────
  const apiPrefix = process.env.API_PREFIX || 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  // ─── VALIDATION ───────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,           // strip unknown fields
      forbidNonWhitelisted: false,
      transform: true,           // auto-transform types (string→number etc.)
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ─── SWAGGER DOCS ─────────────────────────────────────────────────────────
  const config = new DocumentBuilder()
    .setTitle('AgriConnect Pakistan API')
    .setDescription(
      'Complete REST API for the AgriConnect Pakistan agriculture marketplace platform. ' +
      'Covers authentication, KYC, product listings, offers, orders, warehouse receipts, ' +
      'testing agencies, and transport providers.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'JWT-auth',
    )
    .addTag('auth', 'Registration, login, OTP, KYC')
    .addTag('users', 'User profiles and admin management')
    .addTag('products', 'Product listings and search')
    .addTag('offers', 'Offer submission and negotiation')
    .addTag('orders', 'Order management and status tracking')
    .addTag('warehouse', 'Warehouse storage, receipts, bank liens, insurance')
    .addTag('testing', 'Lab testing agencies and requests')
    .addTag('transport', 'Transport providers and bookings')
    .build();

  // Swagger exposes the full API surface. Open by default outside
  // production; in production it is OFF unless ENABLE_SWAGGER=true, and
  // even then it requires HTTP basic auth (SWAGGER_USER / SWAGGER_PASSWORD).
  const isProd = process.env.NODE_ENV === 'production';
  const swaggerEnabled = !isProd || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    if (isProd) {
      const user = process.env.SWAGGER_USER;
      const pass = process.env.SWAGGER_PASSWORD;
      if (!user || !pass) {
        throw new Error('ENABLE_SWAGGER=true in production requires SWAGGER_USER and SWAGGER_PASSWORD');
      }
      const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      app.use(['/docs', '/docs-json'], (req: any, res: any, next: any) => {
        if (req.headers.authorization === expected) return next();
        res.setHeader('WWW-Authenticate', 'Basic realm="AgriConnect API docs"');
        res.status(401).send('Authentication required');
      });
    }
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  if (isProd && process.env.OTP_DEV_MODE === 'true') {
    appLogger.warn('⚠️  OTP_DEV_MODE is ON in production (ALLOW_INSECURE_DEV_OTP) — code 000000 is accepted for EVERY account. Do not leave this on for real users.');
  }

  // ─── START ────────────────────────────────────────────────────────────────
  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log('');
  console.log('🌾 AgriConnect Pakistan API');
  console.log('─────────────────────────────────────────');
  console.log(`🚀  Server:  http://localhost:${port}`);
  console.log(`📋  API:     http://localhost:${port}/${apiPrefix}`);
  if (swaggerEnabled) console.log(`📖  Docs:    http://localhost:${port}/docs`);
  console.log(`🌱  Env:     ${process.env.NODE_ENV || 'development'}`);
  console.log('─────────────────────────────────────────');
}

bootstrap();
