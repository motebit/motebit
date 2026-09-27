/**
 * Sync ingest binding (#846): every entry a sync push carries must name the
 * identity the push was authenticated as.
 *
 * A sync push is authenticated for ONE identity — the `:motebitId` of
 * `/sync/:motebitId/*` or `/ws/sync/:motebitId`, which the verifier binds to
 * the token's `mid` (or the operator's master token acting for it). Each entry
 * then carries its OWN `motebit_id`, and the stores file the entry under that
 * field. Without this check a device authenticated as A could write events,
 * conversations, messages, plans and plan steps into B's store, where B's
 * devices pull them as their own — authority asserted over a target the
 * request never proves a relationship to (the #701/#713/#719 class).
 *
 * The rule is one comparison, applied at every ingest door BEFORE any write:
 * the whole batch is refused when any entry names another identity (or names
 * none). Nothing is written and nothing is fanned out, and the refusal is
 * recorded (relay rule 6) under the PRESENTER — the identity whose token was
 * verified, or null for the master token, which carries none.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthEvent } from "./auth-events.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "sync-ingest-binding" });

/** The recorded reason for a refused cross-identity sync entry. */
export const FOREIGN_SYNC_ENTRY_REASON = "sync:foreign_motebit_id";

/**
 * Index of the first entry not bound to `motebitId` — not an object, or its
 * `motebit_id` is not exactly `motebitId` — or -1 when every entry is bound.
 */
export function firstForeignSyncEntry(entries: readonly unknown[], motebitId: string): number {
  return entries.findIndex(
    (entry) =>
      typeof entry !== "object" ||
      entry === null ||
      (entry as { motebit_id?: unknown }).motebit_id !== motebitId,
  );
}

/** The auth-event record of a refused cross-identity sync push. */
export function foreignSyncEntryEvent(opts: {
  path: string;
  method?: string;
  /** Who presented the push: the verified token's identity, or null (master token / no auth). */
  presenter: string | null;
  correlationId?: string | null;
}): AuthEvent {
  return {
    kind: "device_token_rejected",
    ...(opts.method != null ? { method: opts.method } : {}),
    path: opts.path,
    motebitId: opts.presenter,
    audience: "sync",
    reason: FOREIGN_SYNC_ENTRY_REASON,
    correlationId: opts.correlationId ?? null,
  };
}

/** Context key the `/sync/*` device-auth middleware sets to the verified token's identity. */
export const SYNC_PRESENTER_KEY = "syncPresenter";

/**
 * The HTTP door: throw 403 — before any write — when an entry of `entries`
 * is not bound to the path identity, recording the refusal first.
 */
export function refuseForeignSyncEntries(
  c: Context,
  entries: readonly unknown[],
  motebitId: string,
  recordAuthEvent: ((event: AuthEvent) => void) | undefined,
): void {
  if (firstForeignSyncEntry(entries, motebitId) === -1) return;
  const presenter = (c.get(SYNC_PRESENTER_KEY as never) as string | undefined) ?? null;
  logger.warn("sync.foreign_entry_refused", { motebitId, presenter, path: c.req.path });
  recordAuthEvent?.(
    foreignSyncEntryEvent({
      path: c.req.path,
      method: c.req.method,
      presenter,
      correlationId: c.req.header("x-correlation-id") ?? null,
    }),
  );
  throw new HTTPException(403, {
    message: "Every entry's motebit_id must be the authenticated identity",
  });
}
