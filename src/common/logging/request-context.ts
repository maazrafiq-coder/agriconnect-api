import { AsyncLocalStorage } from 'async_hooks';

/** Per-request context so any log line can carry the request id without plumbing it through every call. */
export const requestContext = new AsyncLocalStorage<{ requestId: string; userId?: string }>();
export const currentRequestId = () => requestContext.getStore()?.requestId;
