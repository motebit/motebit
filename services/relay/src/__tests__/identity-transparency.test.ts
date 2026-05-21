/**
 * Identity-transparency endpoint material — the DB → verifier loop. A bundle
 * assembled from agent_registry + relay_key_successions must verify against
 * @motebit/crypto's verifyIdentityBindingAnchored, proving the relay produces
 * exactly what a third party consumes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  verifyIdentityBindingAnchored,
  type MotebitIdentityFile,
} from "@motebit/crypto";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import {
  readIdentityBindings,
  readSuccessionChain,
  buildIdentityBindingBundle,
} from "../identity-transparency.js";

async function key(): Promise<string> {
  return bytesToHex((await generateKeypair()).publicKey);
}

// Reconstruct the verifier's identity input from a bundle's binding material.
function identityFrom(
  bundle: NonNullable<Awaited<ReturnType<typeof buildIdentityBindingBundle>>>,
): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: bundle.motebit_id,
    created_at: bundle.created_at,
    owner_id: "o",
    identity: { algorithm: "Ed25519", public_key: bundle.current_public_key },
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession: bundle.succession,
  };
}

describe("identity-transparency bundle", () => {
  let db: DatabaseDriver;

  beforeEach(async () => {
    db = (await openMotebitDatabase(":memory:")).db;
    // Controlled minimal schemas (independent of relay migrations).
    db.exec("DROP TABLE IF EXISTS agent_registry");
    db.exec(
      "CREATE TABLE agent_registry (motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL)",
    );
    db.exec("DROP TABLE IF EXISTS relay_key_successions");
    db.exec(
      `CREATE TABLE relay_key_successions (id INTEGER PRIMARY KEY, motebit_id TEXT NOT NULL,
        old_public_key TEXT NOT NULL, new_public_key TEXT NOT NULL, timestamp INTEGER NOT NULL,
        reason TEXT, old_key_signature TEXT, new_key_signature TEXT NOT NULL, recovery INTEGER DEFAULT 0,
        guardian_signature TEXT)`,
    );
  });

  function register(motebitId: string, publicKey: string, registeredAt: number): void {
    db.prepare(
      "INSERT INTO agent_registry (motebit_id, public_key, registered_at) VALUES (?, ?, ?)",
    ).run(motebitId, publicKey, registeredAt);
  }

  it("assembles a bundle whose proof verifies against its own binding material", async () => {
    const k = await key();
    register("mote-a", k, Date.parse("2026-01-01T00:00:00Z"));
    register("mote-b", await key(), Date.parse("2026-01-02T00:00:00Z")); // non-trivial tree

    const bundle = await buildIdentityBindingBundle(db, "mote-a");
    expect(bundle).not.toBeNull();
    expect(bundle!.current_public_key).toBe(k);
    expect(bundle!.succession).toEqual([]);

    const r = await verifyIdentityBindingAnchored(
      identityFrom(bundle!),
      k,
      Date.parse("2026-06-01T00:00:00Z"),
      bundle!.proof,
    );
    expect(r.bound).toBe(true);
  });

  it("returns null for an unregistered motebit", async () => {
    register("mote-a", await key(), 1000);
    expect(await buildIdentityBindingBundle(db, "mote-unknown")).toBeNull();
  });

  it("readIdentityBindings reads agents; readSuccessionChain stamps the suite and omits empty fields", async () => {
    const k = await key();
    register("mote-a", k, 1000);
    db.prepare(
      "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature, recovery) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("mote-a", "old", "new", 2000, "sig", 0);

    expect(readIdentityBindings(db)).toEqual([{ motebit_id: "mote-a", public_key: k }]);
    const chain = readSuccessionChain(db, "mote-a");
    expect(chain).toHaveLength(1);
    expect(chain[0]!.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(chain[0]!.recovery).toBeUndefined(); // recovery 0 → omitted
    expect(chain[0]!.reason).toBeUndefined(); // null → omitted
  });
});
