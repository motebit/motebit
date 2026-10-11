/**
 * Identity authority — the single writer of an identity's money and keys,
 * and the proof it demands (docs/design/identity-authority-writers.md §3,
 * Inc 2: SHADOW).
 *
 * I1 (frozen): no authority-bearing identity state may be created,
 * redirected, or strengthened unless the write passes through the canonical
 * authority writer and proves control of the identity's current key.
 *
 * Three pieces:
 *
 *   - `ProvenKey` — a RUNTIME CAPABILITY, not a type brand: a class with an ES
 *     private field whose constructor demands a module-private symbol. Only
 *     `proveCurrentKey` mints one, and only after an `X-Motebit-Authority`
 *     request verified under the identity's CURRENT key (§3.2) for exactly
 *     the field, value and relay of the write. A forged value (a cast, a
 *     prototype copy, a JSON round-trip) fails the private-brand check in
 *     `writeAuthority` and writes nothing (`identity-authority-forgery`
 *     cells in `__tests__/identity-authority-shadow.test.ts`).
 *   - `writeAuthority(db, cap, change)` — the writer. In ONE synchronous
 *     transaction it consumes the request's signature in the replay store
 *     (`key-proof-replay.ts`, migration v59 — an exact replay is refused),
 *     opens the authority window, applies the change, and closes the window.
 *     `writeAuthorityUnproven(db, change)` applies the SAME change with the
 *     window shut: the Inc 2 path for a request that carries no authority
 *     header, byte-identical to the door it replaced, recorded by the guard.
 *     Inc 3 deletes it for the money fields.
 *   - `installAuthorityGuards(db)` — TEMP triggers (per connection, the
 *     `installFreezeMoneyGuards` precedent) on every authority-bearing column
 *     the census lists (`AUTHORITY_COLUMNS`, pinned to the census by test).
 *     In SHADOW they never abort: a write while the window is shut RECORDS an
 *     `authority_write_outside_writer` row in `relay_auth_events` — one row
 *     per request and subject (the request's own key, assigned server-side
 *     from the request context; a client-chosen correlation id never merges
 *     two requests), its `reason` the `table:OP` list the request touched.
 *     A write outside any request (a loop, boot) is grouped per subject per
 *     UTC hour. Inc 4 turns the record into `RAISE(ABORT)`.
 *
 * Current key (§3.2), as this tree can answer it — the census's own reading
 * (`currentKeyOf`, identity-authority-census.ts): a sovereign id's lineage
 * HEAD from its genesis key K₀ (never a retired key); a legacy id's
 * `identity_keys` holder only when its source is evidence (`succession`,
 * `migration`, `operator`); else NONE — and with none, no request can prove
 * the key, so the header is refused (D2: frozen until evidence exists).
 * A device row is never a current key (D1).
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AUTHORITY_REQUEST_HEADER,
  decodeAuthorityHeader,
  parseAuthorityRequest,
  verifyAuthorityRequest,
  type AuthorityField,
  type AuthorityRequestRefusal,
} from "@motebit/crypto";
import { requestContext } from "./request-context.js";
import type { AuthEvent } from "./auth-events.js";
import { createLogger } from "./logger.js";
import { currentKeyOf } from "./identity-authority-census.js";
import { keyProofAccepted, recordKeyProofAccepted } from "./key-proof-replay.js";
import {
  recordFirstIdentityKey,
  recordGuardianEvidence,
  recordIdentityGuardian,
  recordOperatorServiceKey,
  recordRegistryKeyEvidence,
  type SovereignFirstKey,
} from "./identity-keys.js";
import { requestWithdrawal } from "./accounts.js";

const logger = createLogger({ service: "identity-authority" });

// ── The authority-bearing columns (§2) ──────────────────────────────────

/**
 * Every authority-bearing column the census selects
 * (`docs/design/identity-authority-inventory.generated.md`, "Authority-bearing
 * fields"; `AUTHORITY_RULES` in `scripts/inventory-identity-authority.ts`),
 * by table — the full list, never a hand-picked subset (D5). The worker-side
 * `AgentTrustRecord` adapter rows are not relay tables and are not here.
 * `__tests__/identity-authority-shadow.test.ts` fails when this differs from
 * the committed census, and when a declared column is missing from a booted
 * relay's schema.
 */
export const AUTHORITY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agent_registry: [
    "capabilities",
    "delisted_at",
    "endpoint_url",
    "guardian_public_key",
    "public_key",
    "revoked",
    "settlement_address",
    "settlement_modes",
    "sweep_threshold",
  ],
  agent_trust: [
    "failed_tasks",
    "interaction_count",
    "public_key",
    "successful_tasks",
    "trust_level",
  ],
  devices: ["device_id", "device_token", "hardware_attestation_credential", "public_key"],
  identity_keys: ["guardian_public_key", "public_key"],
  pairing_sessions: ["claiming_public_key", "claiming_x25519_pubkey"],
  relay_agent_revocations: ["revoked"],
  relay_agent_wallets: ["address"],
  relay_bond_commitments: ["bonded_address", "bonded_public_key"],
  relay_delegation_revocations: ["delegator_public_key", "revoked_at"],
  relay_guardian_evidence: ["guardian_public_key"],
  relay_identity_revocations: ["revoked_at"],
  relay_key_proofs_accepted: ["public_key"],
  relay_key_successions: ["guardian_signature", "new_public_key", "old_public_key", "recovery"],
  relay_motebit_intake: ["public_key"],
  relay_peers: [
    "endpoint_url",
    "failed_forwards",
    "missed_heartbeats",
    "nonce",
    "peer_protocol_version",
    "peered_at",
    "public_key",
    "state",
    "successful_forwards",
    "trust_level",
    "trust_score",
  ],
  relay_pending_withdrawals: ["destination", "rail"],
  relay_registry_key_evidence: ["public_key"],
  relay_revocation_events: ["new_public_key"],
  relay_service_listings: ["capabilities", "pay_to_address", "pricing"],
  relay_settlements: ["p2p_worker_address", "p2p_worker_address_rung"],
  relay_skill_registry: ["signature_public_key"],
  relay_withdrawals: ["destination"],
  service_listings: ["capabilities", "pricing"],
};

/** The shadow event's kind in `relay_auth_events`. */
export const AUTHORITY_SHADOW_KIND = "authority_write_outside_writer";

/** Whose row a write touches, per table — the shadow event's `motebit_id`. */
const SUBJECT_COLUMNS = [
  "motebit_id",
  "peer_relay_id",
  "delegator_id",
  "submitter_id",
  "submitter",
] as const;

// ── ProvenKey: the runtime capability ───────────────────────────────────

const MINT: unique symbol = Symbol("ProvenKey.mint");

interface Proof {
  motebitId: string;
  publicKey: string;
  basis: "sovereign_lineage" | "holder_evidence";
  field: AuthorityField;
  signature: string;
  nonce: string;
}

/**
 * Proof that a request was signed by the identity's CURRENT key over one
 * change. Constructible only inside this module (the symbol is never
 * exported); read only through `writeAuthority`'s private-brand check.
 */
export class ProvenKey {
  readonly #proof: Readonly<Proof>;
  constructor(key: typeof MINT, proof: Proof) {
    if (key !== MINT) throw new Error("ProvenKey is minted only by proveCurrentKey");
    this.#proof = Object.freeze({ ...proof });
  }
  get motebitId(): string {
    return this.#proof.motebitId;
  }
  get field(): AuthorityField {
    return this.#proof.field;
  }
  get publicKey(): string {
    return this.#proof.publicKey;
  }
  /** The private-brand read: throws on anything `proveCurrentKey` did not mint. */
  static unwrap(cap: unknown): Readonly<Proof> {
    if (typeof cap !== "object" || cap === null || !(#proof in cap)) {
      throw new AuthorityCapabilityRefused();
    }
    return cap.#proof;
  }
}

/** A value that is not a minted `ProvenKey` reached the writer. */
export class AuthorityCapabilityRefused extends Error {
  constructor(message = "writeAuthority: not a ProvenKey minted by proveCurrentKey") {
    super(message);
    this.name = "AuthorityCapabilityRefused";
  }
}

/** The request's signature was already consumed — an exact replay. */
export class AuthorityReplayed extends Error {
  constructor() {
    super("authority request already accepted — an exact replay writes nothing");
    this.name = "AuthorityReplayed";
  }
}

export type AuthorityRefusal = AuthorityRequestRefusal | "no_current_key" | "replayed";

/**
 * Verify an `X-Motebit-Authority` header and mint a `ProvenKey`, or name why
 * not. Read-only: nothing is recorded until `writeAuthority` consumes it.
 */
export async function proveCurrentKey(
  db: DatabaseDriver,
  input: {
    header: string;
    field: AuthorityField;
    motebitId: string;
    /** The value the change writes — for a door, its parsed JSON body. */
    value: unknown;
    relayId: string;
    now?: number;
  },
): Promise<{ ok: true; cap: ProvenKey } | { ok: false; reason: AuthorityRefusal }> {
  const wire = decodeAuthorityHeader(input.header);
  if (parseAuthorityRequest(wire) === null) return { ok: false, reason: "malformed" };
  const current = await currentKeyOf(db, input.motebitId);
  if (current.key === null || current.basis === "none")
    return { ok: false, reason: "no_current_key" };
  const verdict = await verifyAuthorityRequest(wire, {
    field: input.field,
    motebitId: input.motebitId,
    self: input.relayId,
    publicKeyHex: current.key,
    value: input.value,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const proof: Proof = {
    motebitId: input.motebitId,
    publicKey: current.key,
    basis: current.basis,
    field: input.field,
    signature: verdict.request.signature,
    nonce: verdict.request.envelope.nonce,
  };
  if (keyProofAccepted(db, keyProof(proof))) return { ok: false, reason: "replayed" };
  return { ok: true, cap: new ProvenKey(MINT, proof) };
}

const keyProof = (p: Readonly<Proof>) => ({
  motebitId: p.motebitId,
  publicKey: p.publicKey,
  signature: p.signature,
});

// ── The changes ─────────────────────────────────────────────────────────

/** `PATCH /api/v1/agents/:id/sweep-config` — only the fields present. */
export interface SweepConfigChange {
  field: "sweep_config";
  motebitId: string;
  sweepThreshold?: number | null;
  settlementAddress?: string | null;
}

/** `POST /api/v1/agents/:id/listing` — the listing is replaced whole. */
export interface ListingChange {
  field: "listing";
  motebitId: string;
  listingId: string;
  now: number;
  capabilities: string;
  pricing: string;
  slaMaxLatencyMs: number;
  slaAvailability: number;
  description: string;
  payToAddress: string | null;
  regulatoryRisk: number | null;
}

/** `POST /api/v1/agents/:id/withdraw` — the debit and the destination. */
export interface WithdrawalChange {
  field: "withdrawal";
  motebitId: string;
  amountMicro: number;
  destination: string;
  idempotencyKey?: string;
}

/** `POST /api/v1/agents/register` — the registration's writes, in its order. */
export interface RegistrationChange {
  field: "registration";
  motebitId: string;
  /** E-sov's proven first key, when the door computed one. */
  sovereignProof: SovereignFirstKey | null;
  /** E-op: an operator bearer registering a keyed service identity. */
  operatorServiceKey: boolean;
  publicKey: string;
  endpointUrl: string;
  capabilities: string[];
  metadata: string | null;
  now: number;
  expiresAt: number;
  guardianPublicKey: string | null;
  federationVisible: number;
  settlementAddress: string | null;
  settlementModes: string;
  sweepThreshold: number | null;
  listingDescription: string;
}

export type AuthorityChange =
  SweepConfigChange | ListingChange | WithdrawalChange | RegistrationChange;

type ResultOf<C extends AuthorityChange> = C extends WithdrawalChange
  ? ReturnType<typeof requestWithdrawal>
  : void;

/**
 * THE writer. `cap` must be a `ProvenKey` minted for exactly this identity
 * and field; the request's signature is consumed in the same transaction as
 * the write (an exact replay throws `AuthorityReplayed` and writes nothing).
 * Synchronous by construction: the window is open only inside this one
 * better-sqlite3 transaction, so no other request's write can pass through it.
 */
export function writeAuthority<C extends AuthorityChange>(
  db: DatabaseDriver,
  cap: ProvenKey,
  change: C,
  now: number = Date.now(),
): ResultOf<C> {
  const proof = ProvenKey.unwrap(cap);
  if (proof.field !== change.field || proof.motebitId !== change.motebitId) {
    throw new AuthorityCapabilityRefused(
      `writeAuthority: the ProvenKey authorizes ${proof.field} for ${proof.motebitId}, not ${change.field} for ${change.motebitId}`,
    );
  }
  return db.transaction(() => {
    if (keyProofAccepted(db, keyProof(proof))) throw new AuthorityReplayed();
    setWindow(db, true);
    try {
      recordKeyProofAccepted(db, keyProof(proof), "authority", now);
      return applyChange(db, change, proof) as ResultOf<C>;
    } finally {
      setWindow(db, false);
    }
  });
}

/**
 * The same change with NO proof of the current key: Inc 2's path for a
 * request without `X-Motebit-Authority`, byte-identical to the door it
 * replaced. The window stays shut, so the guard records the write
 * (`authority_write_outside_writer`). Inc 3 deletes this for the money fields.
 */
export function writeAuthorityUnproven<C extends AuthorityChange>(
  db: DatabaseDriver,
  change: C,
): ResultOf<C> {
  return applyChange(db, change, null) as ResultOf<C>;
}

function applyChange(
  db: DatabaseDriver,
  change: AuthorityChange,
  proof: Readonly<Proof> | null,
): unknown {
  switch (change.field) {
    case "sweep_config": {
      const c = change;
      const sets: string[] = [];
      const vals: Array<number | string | null> = [];
      if ("sweepThreshold" in c) {
        sets.push("sweep_threshold = ?");
        vals.push(c.sweepThreshold ?? null);
      }
      if ("settlementAddress" in c) {
        sets.push("settlement_address = ?");
        vals.push(c.settlementAddress ?? null);
      }
      if (sets.length > 0) {
        vals.push(c.motebitId);
        db.prepare(`UPDATE agent_registry SET ${sets.join(", ")} WHERE motebit_id = ?`).run(
          ...vals,
        );
      }
      return undefined;
    }
    case "listing": {
      const c = change;
      db.prepare("DELETE FROM relay_service_listings WHERE motebit_id = ?").run(c.motebitId);
      db.prepare(
        `INSERT INTO relay_service_listings
         (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, pay_to_address, regulatory_risk, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.listingId,
        c.motebitId,
        c.capabilities,
        c.pricing,
        c.slaMaxLatencyMs,
        c.slaAvailability,
        c.description,
        c.payToAddress,
        c.regulatoryRisk,
        c.now,
      );
      return undefined;
    }
    case "withdrawal": {
      const c = change;
      return requestWithdrawal(db, c.motebitId, c.amountMicro, c.destination, c.idempotencyKey);
    }
    case "registration": {
      applyRegistration(db, change, proof);
      return undefined;
    }
  }
}

function applyRegistration(
  db: DatabaseDriver,
  c: RegistrationChange,
  proof: Readonly<Proof> | null,
): void {
  // The holder's first key — BEFORE the registry upsert, whose write would
  // otherwise fill the empty registry slot E-sov's predicate requires (DA2).
  if (c.sovereignProof) {
    recordFirstIdentityKey(db, c.sovereignProof, {
      source: "register",
      guardianPublicKey: c.guardianPublicKey,
      now: c.now,
    });
  } else if (c.operatorServiceKey) {
    recordOperatorServiceKey(db, {
      motebitId: c.motebitId,
      publicKey: c.publicKey,
      guardianPublicKey: c.guardianPublicKey,
      now: c.now,
    });
  }

  db.prepare(
    `
      INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, metadata, registered_at, last_heartbeat, expires_at, guardian_public_key, federation_visible, settlement_address, settlement_modes, sweep_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(motebit_id) DO UPDATE SET
        public_key = excluded.public_key,
        endpoint_url = CASE WHEN agent_registry.revoked = 1 THEN agent_registry.endpoint_url ELSE excluded.endpoint_url END,
        capabilities = CASE WHEN agent_registry.revoked = 1 THEN agent_registry.capabilities ELSE excluded.capabilities END,
        metadata = excluded.metadata,
        last_heartbeat = excluded.last_heartbeat,
        expires_at = excluded.expires_at,
        guardian_public_key = COALESCE(excluded.guardian_public_key, agent_registry.guardian_public_key),
        federation_visible = excluded.federation_visible,
        settlement_address = COALESCE(excluded.settlement_address, agent_registry.settlement_address),
        settlement_modes = COALESCE(excluded.settlement_modes, agent_registry.settlement_modes),
        sweep_threshold = COALESCE(excluded.sweep_threshold, agent_registry.sweep_threshold),
        delisted_at = CASE WHEN agent_registry.revoked = 1 THEN agent_registry.delisted_at ELSE NULL END
    `,
  ).run(
    c.motebitId,
    c.publicKey,
    c.endpointUrl,
    JSON.stringify(c.capabilities),
    c.metadata,
    c.now,
    c.now,
    c.expiresAt,
    c.guardianPublicKey,
    c.federationVisible,
    c.settlementAddress,
    c.settlementModes,
    c.sweepThreshold,
  );

  // Every verified guardian attestation reaches the holder (DA6).
  if (c.guardianPublicKey) {
    recordIdentityGuardian(db, {
      motebitId: c.motebitId,
      guardianPublicKey: c.guardianPublicKey,
      now: c.now,
    });
  }

  // A default service listing, when the agent has none (routing reads listings).
  if (c.capabilities.length > 0) {
    const existing = db
      .prepare("SELECT listing_id FROM relay_service_listings WHERE motebit_id = ?")
      .get(c.motebitId) as { listing_id: string } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO relay_service_listings
             (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, updated_at)
             VALUES (?, ?, ?, '[]', 30000, 0.95, ?, ?)`,
      ).run(
        `ls-${crypto.randomUUID()}`,
        c.motebitId,
        JSON.stringify(c.capabilities),
        c.listingDescription,
        c.now,
      );
    }
  }

  // Provenance, only beside a proven write (#875 v58/v60): the key and the
  // guardian were written under the identity's current key.
  if (proof !== null) {
    if (c.publicKey === proof.publicKey) {
      recordRegistryKeyEvidence(db, {
        motebitId: c.motebitId,
        publicKey: proof.publicKey,
        evidence: "key_proof",
        now: c.now,
      });
    }
    if (c.guardianPublicKey) {
      recordGuardianEvidence(db, {
        motebitId: c.motebitId,
        guardianPublicKey: c.guardianPublicKey,
        setUnderKey: proof.publicKey,
        evidence: "key_proof",
        now: c.now,
      });
    }
  }
}

// ── The doors' one entry (Inc 2: optional header) ───────────────────────

/** What a money door hands the writer to decide proven vs unproven. */
export interface AuthorityDoor {
  db: DatabaseDriver;
  relayId: string;
  recordAuthEvent: (event: AuthEvent) => void;
}

/**
 * Read a door's `X-Motebit-Authority` header. ABSENT → `null`: the door's
 * behaviour is byte-identical to before Inc 2 (it writes through
 * `writeAuthorityUnproven`, and the shadow guard records the write). PRESENT
 * → a `ProvenKey`, or a 401 naming why not — recorded in `relay_auth_events`
 * (rule 6) and written nothing. The header is new, so refusing a bad one
 * refuses no request a client sent before it existed.
 */
export async function authorityFromRequest(
  c: Context,
  door: AuthorityDoor,
  input: { field: AuthorityField; motebitId: string; value: unknown },
): Promise<ProvenKey | null> {
  const header = c.req.header(AUTHORITY_REQUEST_HEADER);
  if (header === undefined) return null;
  const proven = await proveCurrentKey(door.db, {
    header,
    field: input.field,
    motebitId: input.motebitId,
    value: input.value,
    relayId: door.relayId,
  });
  if (proven.ok) return proven.cap;
  return refuseAuthority(c, door, input.motebitId, proven.reason);
}

function refuseAuthority(
  c: Context,
  door: AuthorityDoor,
  motebitId: string,
  reason: AuthorityRefusal,
): never {
  const caller = c.get("callerMotebitId" as never) as string | undefined;
  door.recordAuthEvent({
    kind: "agent_token_rejected",
    method: c.req.method,
    path: c.req.path,
    motebitId: caller ?? null,
    reason: `authority:${reason}`,
    correlationId: c.req.header("x-correlation-id") ?? null,
  });
  logger.warn("authority.refused", { motebitId, caller: caller ?? null, reason });
  throw new HTTPException(401, {
    message: `X-Motebit-Authority refused: ${reason} — sign the change with the identity's current key (signAuthorityRequest in @motebit/crypto), or send no header`,
  });
}

/**
 * Apply a door's change: through `writeAuthority` when the request proved the
 * current key, else through `writeAuthorityUnproven` (Inc 2's recorded path).
 * A proven request that lost a replay race is refused 401 like any replay.
 */
export function applyAuthorityChange<C extends AuthorityChange>(
  c: Context,
  door: AuthorityDoor,
  cap: ProvenKey | null,
  change: C,
): ResultOf<C> {
  if (cap === null) return writeAuthorityUnproven(door.db, change);
  try {
    return writeAuthority(door.db, cap, change);
  } catch (err) {
    if (err instanceof AuthorityReplayed) refuseAuthority(c, door, change.motebitId, "replayed");
    throw err;
  }
}

// ── The guard (SHADOW) ──────────────────────────────────────────────────

const REQUEST_FN = "motebit_authority_request";

function windowInstalled(db: DatabaseDriver): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM temp.sqlite_master WHERE type = 'table' AND name = 'authority_window'",
      )
      .get() != null
  );
}

function setWindow(db: DatabaseDriver, open: boolean): void {
  if (!windowInstalled(db)) return;
  db.prepare(`UPDATE temp.authority_window SET open = ?`).run(open ? 1 : 0);
}

/**
 * The request a write belongs to, as JSON for the triggers: a key assigned
 * once per request, server-side (never the client's correlation id), plus
 * method, path and correlation id. NULL outside a request.
 */
function currentRequestJson(): string | null {
  const ctx = requestContext.getStore();
  if (ctx == null) return null;
  ctx.authorityShadowKey ??= crypto.randomUUID();
  return JSON.stringify({
    k: ctx.authorityShadowKey,
    m: ctx.method,
    p: ctx.path,
    c: ctx.correlationId,
  });
}

function columnsOf(db: DatabaseDriver, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA main.table_info("${table}")`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
}

/**
 * Install the shadow guards on this connection. Call at boot after EVERY
 * schema mutation (a migration that rebuilds a table drops its triggers),
 * beside `installFreezeMoneyGuards`. Idempotent. Throws if a declared
 * authority table or column does not exist (a census column the schema lost
 * would otherwise go unguarded silently).
 */
export function installAuthorityGuards(db: DatabaseDriver): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS authority_window (open INTEGER NOT NULL);
    CREATE TEMP TABLE IF NOT EXISTS authority_shadow_seen (
      key TEXT NOT NULL, subject TEXT NOT NULL, event_id INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (key, subject)
    );
    CREATE INDEX IF NOT EXISTS temp.idx_authority_shadow_seen_at ON authority_shadow_seen(at);
  `);
  if (db.prepare(`SELECT 1 FROM temp.authority_window`).get() == null) {
    db.prepare(`INSERT INTO temp.authority_window (open) VALUES (0)`).run();
  } else {
    db.prepare(`UPDATE temp.authority_window SET open = 0`).run();
  }
  db.function?.(REQUEST_FN, currentRequestJson);
  const requestExpr = db.function ? `${REQUEST_FN}()` : "NULL";

  for (const [table, declared] of Object.entries(AUTHORITY_COLUMNS)) {
    const cols = columnsOf(db, table);
    if (cols.size === 0) {
      throw new Error(`installAuthorityGuards: authority table ${table} does not exist`);
    }
    for (const c of declared) {
      if (!cols.has(c)) {
        throw new Error(`installAuthorityGuards: authority column ${table}.${c} does not exist`);
      }
    }
    const subjectCol = SUBJECT_COLUMNS.find((c) => cols.has(c)) ?? null;
    for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      const subject = subjectCol !== null ? `CAST(${row}."${subjectCol}" AS TEXT)` : "NULL";
      const tag = `${table}:${op}`;
      const on = op === "UPDATE" ? `UPDATE OF ${declared.map((c) => `"${c}"`).join(", ")}` : op;
      db.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS authority_shadow_${table}_${op.toLowerCase()}
          BEFORE ${on} ON main."${table}"
          WHEN (SELECT open FROM temp.authority_window) = 0
        BEGIN
          DELETE FROM temp.authority_shadow_seen WHERE at < CAST(unixepoch('subsec') * 1000 AS INTEGER) - 3600000;
          INSERT INTO main.relay_auth_events (at, kind, method, path, motebit_id, audience, reason, correlation_id)
            SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER), '${AUTHORITY_SHADOW_KIND}',
                   json_extract(r, '$.m'), COALESCE(json_extract(r, '$.p'), '(internal)'),
                   ${subject}, NULL, '${tag}', json_extract(r, '$.c')
              FROM (SELECT ${requestExpr} AS r)
             WHERE NOT EXISTS (
               SELECT 1 FROM temp.authority_shadow_seen
                WHERE key = COALESCE(json_extract(r, '$.k'), 'internal:' || strftime('%Y-%m-%dT%H', 'now'))
                  AND subject = COALESCE(${subject}, ''));
          INSERT INTO temp.authority_shadow_seen (key, subject, event_id, at)
            SELECT k, COALESCE(${subject}, ''), last_insert_rowid(), CAST(unixepoch('subsec') * 1000 AS INTEGER)
              FROM (SELECT COALESCE(json_extract(${requestExpr}, '$.k'), 'internal:' || strftime('%Y-%m-%dT%H', 'now')) AS k)
             WHERE NOT EXISTS (SELECT 1 FROM temp.authority_shadow_seen s WHERE s.key = k AND s.subject = COALESCE(${subject}, ''));
          UPDATE main.relay_auth_events SET reason = reason || ',${tag}'
           WHERE id = (SELECT event_id FROM temp.authority_shadow_seen
                        WHERE key = COALESCE(json_extract((SELECT ${requestExpr}), '$.k'), 'internal:' || strftime('%Y-%m-%dT%H', 'now'))
                          AND subject = COALESCE(${subject}, ''))
             AND instr(',' || reason || ',', ',${tag},') = 0;
        END;`);
    }
  }
}
