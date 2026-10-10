import { LoggerService } from '@nestjs/common';
import { currentRequestId } from './request-context';

type Level = 'error' | 'warn' | 'log' | 'debug' | 'verbose';
const ORDER: Level[] = ['error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Nest LoggerService writing one JSON object per line in production
 * (LOG_FORMAT=json) or readable text in development (LOG_FORMAT=pretty).
 * LOG_LEVEL=error|warn|log|debug|verbose (default: log).
 * Every line carries the current requestId when inside a request.
 */
export class AppLogger implements LoggerService {
  private get threshold() {
    const l = (process.env.LOG_LEVEL || 'log') as Level;
    return ORDER.indexOf(ORDER.includes(l) ? l : 'log');
  }
  private get json() {
    const f = process.env.LOG_FORMAT;
    return f ? f === 'json' : process.env.NODE_ENV === 'production';
  }

  write(level: Level, context: string | undefined, message: unknown, extra?: Record<string, unknown>) {
    if (ORDER.indexOf(level) > this.threshold) return;
    const requestId = (extra?.requestId as string) || currentRequestId();
    const msg = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    if (this.json) {
      out.write(JSON.stringify({ time: new Date().toISOString(), level, context, requestId, msg, ...extra }) + '\n');
    } else {
      const rid = requestId ? ` [${String(requestId).slice(0, 8)}]` : '';
      out.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}${rid} ${context ? `[${context}] ` : ''}${msg}\n`);
    }
  }

  log(message: any, context?: string) { this.write('log', context, message); }
  error(message: any, stack?: string, context?: string) {
    // Nest calls error(message, stack?, context?) — a lone string 2nd arg is a context.
    this.write('error', context, message, stack ? { stack } : undefined);
  }
  warn(message: any, context?: string) { this.write('warn', context, message); }
  debug(message: any, context?: string) { this.write('debug', context, message); }
  verbose(message: any, context?: string) { this.write('verbose', context, message); }
}

export const appLogger = new AppLogger();
