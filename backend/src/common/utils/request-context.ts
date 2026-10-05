import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** Client address as Express resolved it (honours TRUST_PROXY). */
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the request's context; everything it awaits sees the same context. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request's context (undefined outside a request, e.g. in background jobs). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
