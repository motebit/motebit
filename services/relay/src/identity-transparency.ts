/**
 * Identity-transparency endpoint — serves the binding material a third party
 * needs to verify a receipt's producer (`docs/doctrine/identity-binding-verification.md`).
 *
 * `GET /api/v1/identity/:motebitId` returns the motebit's current key, succession
 * chain (the self-signed records the relay merely stores — it cannot forge them),
 * and a Merkle inclusion proof of its binding under the identity-log root. A
 * verifier feeds these to `verifyKeyBindingAtTime` + `verifyIdentityBindingAnchored`.
 *
 * The relay is a CDN here, not a trust root: the succession records are signed by
 * the motebit's own keys, and the inclusion proof's root is what the relay anchors
 * on-chain (the anchoring + the verifier's on-chain cross-check are separate
 * pieces — until that lands, this proves inclusion under a relay-asserted root,
 * which is the `pinned`/in-progress state, NOT `anchored`).
 */

import type { Hono } from "hono";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SuccessionRecord } from "@motebit/crypto";
import { buildIdentityLog, type IdentityBinding, type IdentityLogProof } from "./identity-log.js";

/** The relay's succession records are always under this suite (no per-row column). */
const SUCCESSION_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/** Read every registered `motebit_id → current key` binding for the log. */
export function readIdentityBindings(db: DatabaseDriver): IdentityBinding[] {
  const rows = db.prepare("SELECT motebit_id, public_key FROM agent_registry").all() as Array<{
    motebit_id: string;
    public_key: string;
  }>;
  return rows.map((r) => ({ motebit_id: r.motebit_id, public_key: r.public_key }));
}

interface SuccessionRow {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason: string | null;
  old_key_signature: string | null;
  new_key_signature: string;
  recovery: number | null;
  guardian_signature: string | null;
}

/** Read a motebit's succession chain, stamped with the fixed suite the verifier expects. */
export function readSuccessionChain(db: DatabaseDriver, motebitId: string): SuccessionRecord[] {
  const rows = db
    .prepare(
      `SELECT old_public_key, new_public_key, timestamp, reason, old_key_signature,
              new_key_signature, recovery, guardian_signature
         FROM relay_key_successions WHERE motebit_id = ? ORDER BY timestamp ASC`,
    )
    .all(motebitId) as SuccessionRow[];
  return rows.map((r) => ({
    old_public_key: r.old_public_key,
    new_public_key: r.new_public_key,
    timestamp: r.timestamp,
    suite: SUCCESSION_SUITE,
    ...(r.reason != null ? { reason: r.reason } : {}),
    ...(r.old_key_signature != null ? { old_key_signature: r.old_key_signature } : {}),
    new_key_signature: r.new_key_signature,
    ...(r.recovery ? { recovery: true } : {}),
    ...(r.guardian_signature != null ? { guardian_signature: r.guardian_signature } : {}),
  }));
}

/** The `/identity/:motebitId` response: binding material + inclusion proof. */
export interface IdentityBindingBundle {
  readonly motebit_id: string;
  /** ISO timestamp the genesis key became active (the registration time). */
  readonly created_at: string;
  /** The motebit's current identity public key (hex) — the chain head. */
  readonly current_public_key: string;
  /** The self-signed rotation chain (genesis → current). Empty if never rotated. */
  readonly succession: SuccessionRecord[];
  /** Merkle inclusion proof of this binding under the log root (`proof.anchoredRoot`). */
  readonly proof: IdentityLogProof;
}

/**
 * Assemble the binding bundle for `motebitId`, or `null` if it isn't registered.
 * Builds the log over all current bindings and extracts this motebit's proof.
 */
export async function buildIdentityBindingBundle(
  db: DatabaseDriver,
  motebitId: string,
): Promise<IdentityBindingBundle | null> {
  const agent = db
    .prepare("SELECT public_key, registered_at FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string; registered_at: number } | undefined;
  if (!agent) return null;

  const log = await buildIdentityLog(readIdentityBindings(db));
  const proof = log.proofFor(motebitId);
  if (!proof) return null;

  return {
    motebit_id: motebitId,
    created_at: new Date(agent.registered_at).toISOString(),
    current_public_key: agent.public_key,
    succession: readSuccessionChain(db, motebitId),
    proof,
  };
}

export interface IdentityTransparencyDeps {
  app: Hono;
  db: DatabaseDriver;
}

export function registerIdentityTransparencyRoutes(deps: IdentityTransparencyDeps): void {
  const { app, db } = deps;

  // ── GET /api/v1/identity/:motebitId ──
  // Unauthenticated. Serves binding material for offline verification; no secrets.
  /**
   * @experimental
   * @since 2026-05-21
   * @stabilizes_by 2026-08-21
   * @replacement none
   * @reason Identity-transparency binding endpoint. The IdentityBindingBundle wire
   *   format may change until the anchored rung is complete (the on-chain root
   *   cross-check); it graduates to a versioned spec route once stable.
   */
  app.get("/api/v1/identity/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const bundle = await buildIdentityBindingBundle(db, motebitId);
    if (!bundle) return c.json({ error: "not_found" }, 404);
    return c.json(bundle);
  });
}
