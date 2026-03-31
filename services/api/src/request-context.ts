/**
 * AsyncLocalStorage-based request context propagation.
 *
 * Any code in a request's call chain can access the request context
 * (correlation ID, caller identity, timing) without explicit parameter passing.
 * Near-zero overhead on Node.js 20+.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  correlationId: string;
  motebitId?: string;
  deviceId?: string;
  startedAt: number;
  method: string;
  path: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Get current context or undefined if outside a request */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** Get correlation ID from context, or generate a fresh one */
export function getCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? crypto.randomUUID();
}

/**
 * Enrich the current request context with caller identity.
 * Called after authentication resolves the caller.
 * No-op if called outside a request context.
 */
export function enrichRequestContext(fields: { motebitId?: string; deviceId?: string }): void {
  const store = requestContext.getStore();
  if (store == null) return;
  if (fields.motebitId != null) store.motebitId = fields.motebitId;
  if (fields.deviceId != null) store.deviceId = fields.deviceId;
}
