import { randomUUID } from 'crypto';
import { requestContext } from './request-context';
import { appLogger } from './app-logger';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns every request an id (honouring a well-formed inbound X-Request-Id
 * from the proxy), echoes it in the response header, binds it to the async
 * context, and writes ONE access-log line when the response finishes.
 * Paths are logged without the query string (tokens/OTPs can appear there).
 */
export function requestIdMiddleware(req: any, res: any, next: () => void) {
  const inbound = req.headers['x-request-id'];
  const requestId = typeof inbound === 'string' && SAFE_ID.test(inbound) ? inbound : randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();
  const quiet = (req.originalUrl || req.url || '').includes('/health');

  res.on('finish', () => {
    if (quiet && res.statusCode < 400) return; // don't drown logs in probe noise
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const path = String(req.originalUrl || req.url).split('?')[0];
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';
    appLogger.write(level, 'http', `${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`, {
      requestId, method: req.method, path, status: res.statusCode, durationMs: Math.round(ms), userId: req.user?.id,
    });
  });

  requestContext.run({ requestId }, next);
}
