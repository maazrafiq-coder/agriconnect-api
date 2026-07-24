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
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  OTP_EXPIRY_MINUTES: Joi.number().default(10),
  OTP_DEV_MODE: Joi.boolean().default(false),

  TWILIO_ACCOUNT_SID: Joi.string().allow('').optional(),
  TWILIO_AUTH_TOKEN: Joi.string().allow('').optional(),
  TWILIO_PHONE_NUMBER: Joi.string().allow('').optional(),

  UPLOAD_DEST: Joi.string().default('./uploads'),
  MAX_FILE_SIZE_MB: Joi.number().default(10),

  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  AWS_REGION: Joi.string().allow('').optional(),
  AWS_S3_BUCKET: Joi.string().allow('').optional(),
});
