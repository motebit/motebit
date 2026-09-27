/**
 * Identity binding (#846) — the ONE place a request's authenticated principal
 * is bound to the identity whose rows it writes.
 *
 * The class: authority asserted over a target the request never proves a
 * relationship to (#701/#713/#719, `check-identity-authority-writers`). Every
 * door that writes a row filed under an identity names that identity twice —
 * once in what authenticated the request (a token's `mid`, a signature's
 * key, the operator's master token), once in the target (a path segment, an
 * entry's own `motebit_id`) — and the defect is a door that never compares
 * them. Sync pushes filed each entry under the entry's own `motebit_id`; the
 * subscription routes authenticated nothing; `migrate/cancel`, `migrate/depart`
 * and `approvals` read a token's `mid` and never compared it to the path.
 *
 * The comparison lives here, and its RESULT is a runtime capability.
 * `BoundIdentity` is an object with an ES private field that only this
 * module can construct (the constructor demands a module-private key), and
 * only after the comparison passed. The write helpers for per-identity rows
 * (`upsertSync*`, `appendBoundEvent`, `setSubscriptionStatus`,
 * `updateMigrationState`, `insertApproval`) take a `BoundIdentity` as the
 * owner and read the identity ONLY through `unwrapBound`, which performs the
 * private-brand check (`#id in b`) and throws on anything this module did not
 * mint. A type assertion, a type predicate, an `asserts` function, an
 * overload, a value parsed from JSON, a tuple cast (the #860 review's
 * forgeries) — each still type-checks, and each is a value that throws at
 * the write and writes nothing. The type is not the guarantee; the object
 * is. The mint call sites are registered per file in
 * `scripts/check-identity-authority-writers.ts`, so a new door that mints is
 * a visible decision too.
 *
 * Every refusal is recorded (relay rule 6) under the PRESENTER — the identity
 * whose token verified, or null for the master token / no credential — never
 * the target, which is already in `path`.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MigrationRequest } from "@motebit/protocol";
import { hexToBytes } from "@motebit/encryption";
import { verifyMigrationRequest } from "@motebit/crypto";
import { OPERATOR_PRESENTED, type AuthEvent } from "./auth-events.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "identity-binding" });

/** Module-private: the constructor refuses any caller that cannot name it. */
const MINT_KEY: unique symbol = Symbol("identity-binding.mint");

// Assigned once, by the class's static block (declared first: the block runs
// when the class is defined). Neither is exported.
// eslint-disable-next-line prefer-const
let readBound: (b: unknown) => string;
// eslint-disable-next-line prefer-const
let mintBound: (motebitId: string) => BoundIdentity;

/**
 * An identity the current request has been PROVEN to act for — a runtime
 * capability, not a type brand. Constructible only inside this module (the
 * constructor demands `MINT_KEY`, which is never exported), after a binding
 * compared the request's principal to the identity. Read it with
 * `unwrapBound`; nothing else can.
 */
export class BoundIdentity {
  readonly #id: string;
  private constructor(key: typeof MINT_KEY, id: string) {
    if (key !== MINT_KEY || typeof id !== "string" || id === "") {
      throw new TypeError("BoundIdentity is minted only by identity-binding.ts");
    }
    this.#id = id;
    Object.freeze(this);
  }

  /** @internal the private-brand read behind `unwrapBound`. */
  static #read(b: unknown): string {
    if (typeof b === "object" && b !== null && #id in b) return b.#id;
    throw new TypeError(
      "not a BoundIdentity: an identity-row writer accepts only an identity a binding in identity-binding.ts minted (#846)",
    );
  }

  static {
    readBound = (b) => BoundIdentity.#read(b);
    mintBound = (id) => new BoundIdentity(MINT_KEY, id);
  }

  /** Never render the identity by accident (a template literal, a log line, a SQL bind). */
  toString(): string {
    return "[BoundIdentity]";
  }
  toJSON(): string {
    return "[BoundIdentity]";
  }
}

/**
 * The ONLY way to read the identity a `BoundIdentity` carries. Throws on any
 * value this module did not mint — whatever its static type says — so a
 * writer that reads its owner through this cannot be fed a forged one.
 */
export function unwrapBound(b: BoundIdentity): string {
  return readBound(b);
}

const mint = (motebitId: string): BoundIdentity => mintBound(motebitId);

type Record = ((event: AuthEvent) => void) | undefined;

// ---------------------------------------------------------------------------
// HTTP routes: the caller is the path identity, or the operator
// ---------------------------------------------------------------------------

/**
 * Bind an HTTP request to the path identity `motebitId`: the caller's
 * verified token names it (`callerMotebitId`, set by the auth middleware
 * after verification), or the master token authenticated the request (the
 * operator acting for it — marked positively by `recordMasterTokenOnce`,
 * never inferred from an unset caller id). Anything else is refused and
 * recorded: another identity's token 403, no credential at all 401.
 */
export function bindCaller(
  c: Context,
  motebitId: string,
  opts: { recordAuthEvent: Record; reason: string; audience?: string },
): BoundIdentity {
  const caller = c.get("callerMotebitId" as never) as string | undefined;
  if (typeof caller === "string" && caller !== "") {
    if (caller === motebitId) return mint(motebitId);
    refuse(c, motebitId, caller, 403, opts);
  }
  if (c.get(OPERATOR_PRESENTED) === true) return mint(motebitId);
  refuse(c, motebitId, null, 401, opts);
}

function refuse(
  c: Context,
  motebitId: string,
  presenter: string | null,
  status: 401 | 403,
  opts: { recordAuthEvent: Record; reason: string; audience?: string },
): never {
  const reason =
    presenter == null ? `${opts.reason}:unauthenticated` : `${opts.reason}:not_own_identity`;
  logger.warn("identity_binding.refused", { motebitId, presenter, path: c.req.path, reason });
  opts.recordAuthEvent?.({
    kind: "agent_token_rejected",
    method: c.req.method,
    path: c.req.path,
    motebitId: presenter,
    audience: opts.audience ?? null,
    reason,
    correlationId: c.req.header("x-correlation-id") ?? null,
  });
  throw new HTTPException(status, {
    message:
      status === 401
        ? "Authentication required"
        : "This route acts only on the caller's own identity",
  });
}

/**
 * Bind to the identity a signed MigrationRequest names, on the strength of
 * its signature under that identity's own key (spec/migration-v1.md §4.1).
 * The verification happens HERE, so this mint cannot be reached with a bare
 * string: `null` when there is no key or the signature does not verify.
 * `publicKeyHex` is the identity's current verification key, read by the
 * caller (`verificationKeyFor`).
 */
export async function bindBySignature(
  request: MigrationRequest,
  publicKeyHex: string | null,
): Promise<BoundIdentity | null> {
  if (publicKeyHex === null || typeof request.motebit_id !== "string") return null;
  let ok = false;
  try {
    ok = await verifyMigrationRequest(request, hexToBytes(publicKeyHex));
  } catch {
    ok = false;
  }
  return ok ? mint(request.motebit_id) : null;
}

// ---------------------------------------------------------------------------
// Sync pushes: every entry names the identity the push authenticated as
// ---------------------------------------------------------------------------

/** The recorded reason for a refused cross-identity sync entry. */
export const FOREIGN_SYNC_ENTRY_REASON = "sync:foreign_motebit_id";

/** Context key the `/sync/*` device-auth middleware sets to the verified token's identity. */
export const SYNC_PRESENTER_KEY = "syncPresenter";

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

/**
 * The WebSocket door: bind a push frame's entries to the socket's identity.
 * `null` when an entry names another identity — the caller records and
 * refuses; nothing may be written.
 */
export function bindSocketEntries(
  entries: readonly unknown[],
  socketMotebitId: string,
): BoundIdentity | null {
  return firstForeignSyncEntry(entries, socketMotebitId) === -1 ? mint(socketMotebitId) : null;
}

/**
 * The HTTP door: bind a push's entries to the path identity, or throw 403 —
 * before any write — recording the refusal first.
 *
 * The path identity is bound to the token by the `/sync/*` middleware, which
 * reads the raw segment through `pathIdentity` (id-bounds.ts, #853: a `%`
 * is refused, so the raw segment IS the decoded `:motebitId` the handler
 * passes here) and sets `SYNC_PRESENTER_KEY` to the identity it verified.
 * This binder does not take that on trust: when a device token was verified,
 * the handler's `motebitId` must be exactly the verified identity, or the
 * push is refused as not the caller's own (a regression in either reader
 * fails closed here instead of filing under someone else). The master token
 * sets no presenter — the operator acts for the path identity.
 */
export function bindSyncEntries(
  c: Context,
  entries: readonly unknown[],
  motebitId: string,
  recordAuthEvent: Record,
): BoundIdentity {
  const presenter = (c.get(SYNC_PRESENTER_KEY as never) as string | undefined) ?? null;
  if (presenter !== null && presenter !== motebitId) {
    logger.warn("sync.path_identity_mismatch", { motebitId, presenter, path: c.req.path });
    recordAuthEvent?.({
      ...foreignSyncEntryEvent({
        path: c.req.path,
        method: c.req.method,
        presenter,
        correlationId: c.req.header("x-correlation-id") ?? null,
      }),
      reason: "sync:path_identity_not_verified_identity",
    });
    throw new HTTPException(403, {
      message: "The path identity is not the identity the token was verified for",
    });
  }
  if (firstForeignSyncEntry(entries, motebitId) === -1) return mint(motebitId);
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

/**
 * Append a synced event under its bound owner. The only relay route path to
 * `EventStore.append` for client-supplied entries: an entry that does not
 * name `owner` is refused here too, so the type and the row agree.
 */
export async function appendBoundEvent(
  eventStore: EventStore,
  owner: BoundIdentity,
  entry: EventLogEntry,
): Promise<boolean> {
  if (entry.motebit_id !== unwrapBound(owner)) return false;
  await eventStore.append(entry);
  return true;
}
