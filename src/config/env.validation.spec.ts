import { envValidationSchema } from './env.validation';

const base = {
  FRONTEND_URL: 'https://app.example.com',
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  NODE_ENV: 'production',
  AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_S3_BUCKET: 'c',
};

describe('env validation - OTP dev mode', () => {
  it('refuses to boot in production with OTP_DEV_MODE on', () => {
    const { error } = envValidationSchema.validate({ ...base, OTP_DEV_MODE: 'true' });
    expect(error?.message).toMatch(/OTP_DEV_MODE must be false in production/);
  });
  it('allows it only with the explicit ALLOW_INSECURE_DEV_OTP override', () => {
    const { error } = envValidationSchema.validate({ ...base, OTP_DEV_MODE: 'true', ALLOW_INSECURE_DEV_OTP: 'true' });
    expect(error).toBeUndefined();
  });
  it('is fine in production with it off, and in development with it on', () => {
    expect(envValidationSchema.validate({ ...base }).error).toBeUndefined();
    expect(envValidationSchema.validate({ ...base, NODE_ENV: 'development', OTP_DEV_MODE: 'true' }).error).toBeUndefined();
  });
  it('no longer requires JWT_REFRESH_SECRET', () => {
    expect(envValidationSchema.validate({ ...base }).error).toBeUndefined();
  });
});
