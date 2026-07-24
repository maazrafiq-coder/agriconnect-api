import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ─── SECURITY HEADERS ───────────────────────────────────────────────────────
  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  // ─── CORS ────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // ─── START ────────────────────────────────────────────────────────────────
  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log('');
  console.log('🌾 AgriConnect Pakistan API');
  console.log('─────────────────────────────────────────');
  console.log(`🚀  Server:  http://localhost:${port}`);
  console.log(`📋  API:     http://localhost:${port}/${apiPrefix}`);
  console.log(`📖  Docs:    http://localhost:${port}/docs`);
  console.log(`🌱  Env:     ${process.env.NODE_ENV || 'development'}`);
  console.log('─────────────────────────────────────────');
}

bootstrap();
