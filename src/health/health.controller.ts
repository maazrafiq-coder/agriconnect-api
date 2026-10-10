import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

// Probes are polled every few seconds by Railway / Docker / uptime monitors
// from one IP — they must never be rate-limited, or the platform would
// start restarting a healthy app.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  private async dbReachable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Bounded: a hung database must fail the probe, not hang it.
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('db timeout')), 3000); }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // GET /health — kept as before (always 200, reports "degraded") so any
  // existing monitor keeps working. Prefer /health/ready for new setups.
  @Get()
  async check() {
    const dbOk = await this.dbReachable();
    return {
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'connected' : 'unreachable',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  // GET /health/live — process is up. Never touches the database: if this
  // fails the container should be restarted; a DB outage must not do that.
  @Get('live')
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  // GET /health/ready — can serve traffic: 200 only when the DB answers,
  // 503 otherwise (so a load balancer stops routing here).
  @Get('ready')
  async ready() {
    if (!(await this.dbReachable())) {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unreachable' });
    }
    return { status: 'ok', database: 'connected' };
  }
}
