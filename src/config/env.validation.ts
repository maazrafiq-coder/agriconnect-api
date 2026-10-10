import * as Joi from 'joi';

/**
 * Validates process.env at application boot.
 * If a required variable is missing or malformed, the app refuses to start
 * instead of silently running with `undefined` secrets (e.g. JWT_SECRET).
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  FRONTEND_URL: Joi.string().uri().required(),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  JWT_SECRET: Joi.string().min(32).required()
    .messages({ 'string.min': 'JWT_SECRET must be at least 32 characters — generate one with `openssl rand -hex 32`' }),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  // Refresh tokens are opaque random values stored hashed in the database;
  // no signing secret is used, so this is optional (kept for compatibility).
  JWT_REFRESH_SECRET: Joi.string().min(32).optional(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  OTP_EXPIRY_MINUTES: Joi.number().default(10),
  // OTP_DEV_MODE makes '000000' verify for EVERY account. In production the
  // app refuses to boot with it on, unless ALLOW_INSECURE_DEV_OTP=true is
  // also set (an explicit, noisy opt-in for UAT while no SMS provider exists).
  ALLOW_INSECURE_DEV_OTP: Joi.boolean().default(false),
  OTP_DEV_MODE: Joi.boolean().default(false).when('NODE_ENV', {
    is: 'production',
    then: Joi.when('ALLOW_INSECURE_DEV_OTP', {
      is: true,
      then: Joi.boolean(),
      otherwise: Joi.boolean().valid(false).messages({
        'any.only': 'OTP_DEV_MODE must be false in production (000000 would log in as anyone). Configure real OTP delivery, or set ALLOW_INSECURE_DEV_OTP=true to knowingly override for UAT.',
      }),
    }),
  }),

  // Swagger docs in production: off unless ENABLE_SWAGGER=true, which then
  // also requires SWAGGER_USER and SWAGGER_PASSWORD (basic auth).
  ENABLE_SWAGGER: Joi.boolean().default(false),
  SWAGGER_USER: Joi.string().allow('').optional(),
  SWAGGER_PASSWORD: Joi.string().allow('').optional(),

  TWILIO_ACCOUNT_SID: Joi.string().allow('').optional(),
  TWILIO_AUTH_TOKEN: Joi.string().allow('').optional(),
  TWILIO_PHONE_NUMBER: Joi.string().allow('').optional(),

  // ── Operations (Round 3 M9) ──
  // Set when the app runs behind a reverse proxy (Railway, nginx): number of
  // proxy hops to trust so req.ip is the real client, not the proxy. Without
  // it every user shares one IP and the rate limiter throttles them together.
  // Railway = 1. Leave unset for direct exposure.
  TRUST_PROXY: Joi.number().integer().min(0).max(10).optional(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'log', 'debug', 'verbose').default('log'),
  LOG_FORMAT: Joi.string().valid('json', 'pretty').optional(),
  // Error reporting is OFF unless a DSN is set AND `@sentry/node` is installed.
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
  SENTRY_ENVIRONMENT: Joi.string().allow('').optional(),
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(0),

  UPLOAD_DEST: Joi.string().default('./uploads'),
  MAX_FILE_SIZE_MB: Joi.number().default(10),

  // Round 2, Milestone 4 — Railway Storage Buckets (S3-compatible object
  // storage) replaces local disk for every upload path (KYC docs,
  // clarification attachments, product/listing media). Required in
  // production so the app refuses to boot rather than silently accepting
  // uploads it can't actually persist; optional in dev/test so the
  // existing PrismaService-stub test pattern (which never touches a real
  // bucket) and sandboxes without bucket credentials keep working.
  AWS_ACCESS_KEY_ID: Joi.string().when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.allow('').optional() }),
  AWS_SECRET_ACCESS_KEY: Joi.string().when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.allow('').optional() }),
  AWS_REGION: Joi.string().allow('').optional().default('auto'),
  AWS_S3_BUCKET: Joi.string().when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.allow('').optional() }),
  // Railway Storage Buckets' S3-compatible endpoint (from the Railway
  // dashboard, e.g. https://storage.railway.app or a region-specific
  // host — check the bucket's connection details). Leave unset to talk
  // to real AWS S3 instead (e.g. if migrating off Railway later).
  AWS_S3_ENDPOINT: Joi.string().uri().allow('').optional(),
});
