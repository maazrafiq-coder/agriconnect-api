import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
];

export function buildCorsOptions(frontendUrl?: string): CorsOptions {
  return {
    origin: frontendUrl || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    credentials: true,
  };
}
