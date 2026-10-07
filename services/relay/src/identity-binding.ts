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
import type { MigrationRequest } from "@motebit/protocol";
import type { DatabaseDriver, PreparedStatement } from "@motebit/persistence";
import { bytesToHex, didKeyToPublicKey, hexToBytes } from "@motebit/encryption";
import {
  deriveSovereignMotebitId,
  verifyDelegationRevocation,
  verifyMigrationRequest,
  type DelegationRevocation,
} from "@motebit/crypto";
import { OPERATOR_PRESENTED, type AuthEvent } from "./auth-events.js";
import { identityKey, keysHeldBy } from "./identity-keys.js";
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
// Signed artifacts: the row is filed under the identity the ARTIFACT names,
// proven against the keys the relay holds for it (#850)
// ---------------------------------------------------------------------------

/** The canonical lowercase hex key a `did:key` URI names, or null when it is not a well-formed Ed25519 `did:key`. */
function didKeyHex(did: string): string | null {
  try {
    return bytesToHex(didKeyToPublicKey(did));
  } catch {
    return null;
  }
}

/**
 * Is the `did:key` URI `did` PROVEN to be `motebitId`'s key? Only evidence
 * counts (#850 review):
 *
 *  - (a) `motebitId` is the sovereign commitment to the key
 *    (`deriveSovereignMotebitId(key) === motebitId`) — the id commits to its
 *    genesis key, offline, whoever registered what; or
 *  - (b) the key is the identity's HOLDER key (`identityKey`, identity-keys.ts
 *    — the #703 authority state, written only by evidence: E-sov, E-link,
 *    E-mig, E-op, E-main).
 *
 * The registry column and device rows are NOT evidence: before #875
 * `/agents/bootstrap` and `/agents/register` wrote any `public_key` without
 * proof of possession (those rows remain), the operator's master-token doors
 * still assert keys on the operator's authority, and possession of a key
 * says nothing about whose identity it is — so a key there proves nothing
 * about the identity. They never bind, and —
 * because nothing another identity writes can veto — they never block
 * either: there is no "no other identity holds it" check (a squatter's
 * bootstrap under V's key used to refuse every credential about V).
 *
 * A legacy (non-sovereign) identity with no holder has no proven key, so no
 * `did:key` names it; `did:motebit:<id>` still does.
 */
export async function didKeyProvenFor(
  db: DatabaseDriver,
  did: string,
  motebitId: string,
): Promise<boolean> {
  const hex = didKeyHex(did);
  if (hex === null) return false;
  if ((await deriveSovereignMotebitId(hex)) === motebitId) return true;
  const holder = identityKey(db, motebitId)?.publicKey;
  // The holder's stored spelling may predate the lowercase rule (E-main
  // transplants as-is); both sides name the same 32 bytes.
  return typeof holder === "string" && holder.toLowerCase() === hex;
}

/** Why a credential's subject did not bind to the path identity (`bindCredentialSubject`). */
export type CredentialSubjectRefusal =
  | "credential_subject:missing"
  | "credential_subject:not_path_identity"
  | "credential_subject:key_not_proven_for_path_identity"
  | "credential_subject:unsupported_did";

/**
 * `POST /api/v1/agents/:motebitId/credentials/submit` files a credential
 * under the path identity, and that row is what `revoke-credential` later
 * reads as "the subject" (spec/credential-v1.md §6.2). The route is public
 * (the issuer's signature is the auth, §7.1), so nothing about the SUBMITTER
 * can be bound — the binding is between the target and the CREDENTIAL: the
 * path identity must be the identity the credential's own
 * `credentialSubject.id` names.
 *
 *  - `did:motebit:<id>` names `<id>`; it must be exactly the path identity.
 *  - `did:key:z…` names a key; it must be PROVEN the path identity's key —
 *    the path id is its sovereign commitment, or it is the identity's holder
 *    key (`didKeyProvenFor`). Registry and device-row keys never bind.
 *  - anything else, or no subject id at all, binds nobody.
 *
 * Before #850 the row was filed under the path alone: X filed V's credential
 * under X, then revoked it as its "subject" — relay-wide, for V.
 */
export async function bindCredentialSubject(
  db: DatabaseDriver,
  subjectId: unknown,
  pathId: string,
): Promise<{ bound: BoundIdentity } | { refused: CredentialSubjectRefusal }> {
  if (typeof subjectId !== "string" || subjectId === "") {
    return { refused: "credential_subject:missing" };
  }
  if (subjectId.startsWith("did:motebit:")) {
    if (subjectId.slice("did:motebit:".length) !== pathId) {
      return { refused: "credential_subject:not_path_identity" };
    }
  } else if (subjectId.startsWith("did:key:")) {
    if (!(await didKeyProvenFor(db, subjectId, pathId))) {
      return { refused: "credential_subject:key_not_proven_for_path_identity" };
    }
  } else {
    return { refused: "credential_subject:unsupported_did" };
  }
  return { bound: mint(pathId) };
}

/** Why a delegation revocation did not bind to its delegator (`bindByDelegationRevocation`). */
export type DelegationRevocationRefusal =
  "delegation_revocation:signature_invalid" | "delegation_revocation:key_not_held_by_delegator";

/**
 * Bind a `DelegationRevocation` to the delegator it names
 * (spec/standing-delegation-v1.md §5.1: "Only the grant's delegator may sign
 * one"). The signature must verify AND the key it verifies under must be one
 * this relay holds for `delegator_id` (`keysHeldBy` — so a rotated-out key
 * no longer speaks for the identity). The key is looked up HERE, never taken
 * from the caller: the key embedded in the artifact proves only that
 * SOMEONE signed it.
 *
 * Before #850 the relay verified the revocation against its own embedded
 * key alone, so a stranger with a fresh keypair could file a revocation
 * naming any delegator and any `grant_id`, and the acceptance fence refused
 * that grant's tasks.
 */
export async function bindByDelegationRevocation(
  db: DatabaseDriver,
  revocation: DelegationRevocation,
): Promise<{ bound: BoundIdentity } | { refused: DelegationRevocationRefusal }> {
  let ok = false;
  try {
    ok = await verifyDelegationRevocation(revocation);
  } catch {
    ok = false;
  }
  if (!ok) return { refused: "delegation_revocation:signature_invalid" };
  // Case-insensitive: a legacy device row may store UPPER(K) (#758 —
  // device-registration-guard.ts admits it), and both spellings name the same
  // 32 bytes the signature just verified under. Same rule as didKeyProvenFor.
  const signer =
    typeof revocation.delegator_public_key === "string"
      ? revocation.delegator_public_key.toLowerCase()
      : "";
  if (
    typeof revocation.delegator_id !== "string" ||
    revocation.delegator_id === "" ||
    signer === "" ||
    ![...keysHeldBy(db, revocation.delegator_id)].some((k) => k.toLowerCase() === signer)
  ) {
    return { refused: "delegation_revocation:key_not_held_by_delegator" };
  }
  return { bound: mint(revocation.delegator_id) };
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
 * The statement `@motebit/persistence`'s `SqliteEventStore.append` runs, with
 * the same bind values, plus the relay's write-time redaction fact
 * (`relay_ingress_redacted`, migration v56). Pinned row-for-row against
 * `SqliteEventStore.append` by `__tests__/sync-hold-receipt-hardening.test.ts`.
 */
const APPEND_BOUND_EVENT_SQL = `INSERT OR IGNORE INTO events (event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned, relay_ingress_redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const appendStatements = new WeakMap<DatabaseDriver, PreparedStatement>();

/**
 * Append a synced event under its bound owner. The only relay route path for
 * client-supplied entries into `events`: an entry that does not name `owner`
 * is refused here too, so the type and the row agree.
 *
 * `ingressRedacted` is whether the door's ingress redaction changed this
 * entry. It is written in the SAME statement as the bytes, so it describes
 * exactly the row that statement stores; when `INSERT OR IGNORE` keeps an
 * older row, the older row keeps its own flag. The sync hold receipt reads
 * it back from the stored row (`sync-hold-receipt.ts`), never from a frame.
 */
export function appendBoundEvent(
  db: DatabaseDriver,
  owner: BoundIdentity,
  entry: EventLogEntry,
  ingressRedacted: boolean,
): boolean {
  if (entry.motebit_id !== unwrapBound(owner)) return false;
  // `EventStore.append`'s own refusals, in its order and words.
  if (entry.event_id === "") throw new Error("event_id must not be empty");
  if (entry.motebit_id === "") throw new Error("motebit_id must not be empty");
  let stmt = appendStatements.get(db);
  if (stmt === undefined) {
    stmt = db.prepare(APPEND_BOUND_EVENT_SQL);
    appendStatements.set(db, stmt);
  }
  stmt.run(
    entry.event_id,
    entry.motebit_id,
    entry.device_id ?? null,
    entry.event_type,
    JSON.stringify(entry.payload),
    entry.version_clock,
    entry.timestamp,
    entry.tombstoned ? 1 : 0,
    ingressRedacted ? 1 : 0,
  );
  return true;
}
