import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

const make = (ok: boolean) =>
  new HealthController({ $queryRaw: jest.fn().mockImplementation(() => (ok ? Promise.resolve([1]) : Promise.reject(new Error('down')))) } as any);

describe('HealthController', () => {
  it('live never touches the database', () => {
    const prisma = { $queryRaw: jest.fn() };
    expect(new HealthController(prisma as any).live().status).toBe('ok');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('ready is ok when the DB answers', async () => {
    await expect(make(true).ready()).resolves.toMatchObject({ status: 'ok', database: 'connected' });
  });
  it('ready is 503 when the DB is down', async () => {
    await expect(make(false).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('legacy /health still returns 200-style body with degraded status', async () => {
    await expect(make(false).check()).resolves.toMatchObject({ status: 'degraded', database: 'unreachable' });
  });
});
