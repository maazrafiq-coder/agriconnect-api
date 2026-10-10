import { appLogger } from '../logging/app-logger';

/**
 * Optional Sentry hook. OFF by default: nothing is loaded unless SENTRY_DSN is
 * set. `@sentry/node` is deliberately NOT a dependency — to turn this on run
 * `npm i @sentry/node` and set SENTRY_DSN. If the DSN is set but the package is
 * missing we log one warning and carry on (never crash the app over telemetry).
 */
let sentry: any = null;

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    // Non-literal require so TypeScript/webpack don't demand the package.
    const moduleName = '@sentry/node';
    sentry = require(moduleName);
    sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      sendDefaultPii: false,
      // Never ship credentials or tokens that can sit in headers/bodies.
      beforeSend(event: any) {
        if (event.request) {
          delete event.request.cookies;
          delete event.request.data;
          if (event.request.headers) {
            delete event.request.headers.authorization;
            delete event.request.headers.cookie;
          }
        }
        return event;
      },
    });
    appLogger.log('Sentry error reporting enabled', 'Observability');
  } catch {
    sentry = null;
    appLogger.warn('SENTRY_DSN is set but @sentry/node is not installed — run `npm i @sentry/node`. Error reporting stays off.', 'Observability');
  }
}

export function captureException(err: unknown, extra?: Record<string, unknown>) {
  if (!sentry) return;
  try {
    sentry.withScope((scope: any) => {
      if (extra) for (const [k, v] of Object.entries(extra)) scope.setExtra(k, v);
      sentry.captureException(err);
    });
  } catch { /* telemetry must never throw */ }
}
