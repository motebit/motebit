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
 * the motebit's own keys, and the inclusion proof is built against the latest
 * root the relay has CONFIRMED on-chain (`getLatestAnchoredSnapshot`), carrying
 * the anchor `tx_hash`. The relay still cannot make this `anchored` on its own —
 * the verifier must independently confirm `proof.anchoredRoot` is posted on-chain
 * at the relay's pinned address (`lookupIdentityLogAnchor` in
 * `@motebit/state-export-client`). Until a motebit is included in a confirmed
 * anchor, `anchored` is `null` and the verifier stays at `pinned`/integrity-only.
 */

import type { Hono } from "hono";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SuccessionRecord } from "@motebit/crypto";
import { buildIdentityLog, type IdentityBinding, type IdentityLogProof } from "./identity-log.js";
import { getLatestAnchoredSnapshot } from "./identity-log-anchoring.js";

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
    ...(r.recovery === 1 ? { recovery: true } : {}),
    ...(r.guardian_signature != null ? { guardian_signature: r.guardian_signature } : {}),
  }));
}

/** Inclusion proof against the latest confirmed on-chain root, with its anchor tx. */
export interface AnchoredInclusion {
  /** Merkle proof; `proof.anchoredRoot` is the root the relay posted on-chain. */
  readonly proof: IdentityLogProof;
  /** The Solana tx that posted `anchoredRoot` — provenance for the verifier. */
  readonly tx_hash: string;
  /** CAIP-2 network of the anchor tx. */
  readonly network: string;
}

/** The `/identity/:motebitId` response: binding material + (if anchored) inclusion proof. */
export interface IdentityBindingBundle {
  readonly motebit_id: string;
  /** ISO timestamp the genesis key became active (the registration time). */
  readonly created_at: string;
  /** The motebit's current identity public key (hex) — the chain head. */
  readonly current_public_key: string;
  /**
   * The motebit's guardian public key (hex), if it registered one. Required to
   * verify a guardian-recovery rotation in the succession chain (the spec's
   * key-compromise mechanism, §3.8.3) — without it a third party can't check a
   * recovery link, so the whole chain fails to verify.
   */
  readonly guardian_public_key?: string;
  /** The self-signed rotation chain (genesis → current). Empty if never rotated. */
  readonly succession: SuccessionRecord[];
  /**
   * Inclusion proof against the latest CONFIRMED on-chain anchored root plus its
   * tx. `null` until this motebit's binding has been anchored — an honest
   * "not anchored yet" state (the verifier stays at `pinned`/integrity-only). A
   * non-null proof here is only `anchored` once the verifier independently
   * confirms `proof.anchoredRoot` is on-chain at the relay's pinned address.
   */
  readonly anchored: AnchoredInclusion | null;
}

/**
 * Assemble the binding bundle for `motebitId`, or `null` if it isn't registered.
 *
 * The inclusion proof is built against the latest CONFIRMED on-chain anchored
 * root — rebuilt from the binding snapshot that root was computed over — so the
 * proof's root is one a verifier can actually find on-chain. If nothing is
 * anchored yet, or this motebit registered after the latest anchor (so it isn't
 * in that snapshot), `anchored` is `null`: honest, not an error.
 */
export async function buildIdentityBindingBundle(
  db: DatabaseDriver,
  motebitId: string,
): Promise<IdentityBindingBundle | null> {
  const agent = db
    .prepare(
      "SELECT public_key, registered_at, guardian_public_key FROM agent_registry WHERE motebit_id = ?",
    )
    .get(motebitId) as
    { public_key: string; registered_at: number; guardian_public_key: string | null } | undefined;
  if (!agent) return null;

  let anchored: AnchoredInclusion | null = null;
  const snapshot = getLatestAnchoredSnapshot(db);
  if (snapshot) {
    // Rebuild under the snapshot's stored tree-hash version (NULL ⇒ v1 legacy):
    // the proof's leaf + path must match the root committed on-chain, so a v2
    // snapshot reconstructs v2-tagged, a legacy v1 snapshot v1-tagged. The proof
    // carries `tree_hash_version` for v2 (omitted for v1) — see buildIdentityLog.
    const log = await buildIdentityLog(snapshot.bindings, snapshot.tree_hash_version);
    const proof = log.proofFor(motebitId);
    // Reproducing the snapshot must yield the anchored root; a mismatch means a
    // corrupted snapshot, which we refuse to serve as `anchored` (fail closed).
    if (proof && proof.anchoredRoot === snapshot.merkle_root) {
      anchored = { proof, tx_hash: snapshot.tx_hash, network: snapshot.network };
    }
  }

  return {
    motebit_id: motebitId,
    created_at: new Date(agent.registered_at).toISOString(),
    current_public_key: agent.public_key,
    ...(agent.guardian_public_key ? { guardian_public_key: agent.guardian_public_key } : {}),
    succession: readSuccessionChain(db, motebitId),
    anchored,
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
