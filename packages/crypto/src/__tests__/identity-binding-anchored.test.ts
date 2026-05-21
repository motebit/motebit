/**
 * verifyIdentityBindingAnchored — the verifier-side foundation of the anchored
 * binding rung (docs/doctrine/identity-binding-verification.md). Binds only when
 * BOTH hold: the sovereign chain places the signing key as valid (time-windowed)
 * AND the motebit's current key is included in the identity-transparency log
 * under the anchored Merkle root. Built against a synthetic 2-leaf tree so the
 * inclusion path is exercised without relay infrastructure.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  sha256,
  signBySuite,
  canonicalJson,
  identityLogLeaf,
  verifyIdentityBindingAnchored,
  type MotebitIdentityFile,
  type SuccessionRecord,
  type KeyPair,
} from "../index.js";

const CREATED = Date.parse("2026-01-01T00:00:00Z");
const NOW = CREATED + 24 * 60 * 60 * 1000;
const ROTATED_AT = CREATED + 7 * 24 * 60 * 60 * 1000;
const SUITE = "motebit-jcs-ed25519-hex-v1" as const;

async function rotation(
  oldKp: KeyPair,
  newKp: KeyPair,
  timestamp: number,
): Promise<SuccessionRecord> {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const msg = new TextEncoder().encode(
    canonicalJson({ old_public_key, new_public_key, timestamp, suite: SUITE }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    old_key_signature: bytesToHex(await signBySuite(SUITE, msg, oldKp.privateKey)),
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

function identity(motebitId: string, currentKeyHex: string): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(CREATED).toISOString(),
    owner_id: "o",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
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
    succession: [],
  };
}

// A 2-leaf Merkle tree (plain SHA-256, leaf-to-root) with our leaf at index 0,
// matching verifyMerkleInclusion's hashing. Returns a proof that reconstructs the root.
async function treeFor(
  leaf0: string,
): Promise<{ anchoredRoot: string; siblings: string[]; index: number; layerSizes: number[] }> {
  const leaf1 = bytesToHex(await sha256(new TextEncoder().encode("sibling-leaf")));
  const anchoredRoot = bytesToHex(await sha256(concat(hexToBytes(leaf0), hexToBytes(leaf1))));
  return { anchoredRoot, siblings: [leaf1], index: 0, layerSizes: [2] };
}

describe("verifyIdentityBindingAnchored", () => {
  it("binds when the chain is valid AND the key is included under the anchored root", async () => {
    const K = bytesToHex((await generateKeypair()).publicKey);
    const id = identity("mote-x", K);
    const proof = await treeFor(await identityLogLeaf("mote-x", K));
    const r = await verifyIdentityBindingAnchored(id, K, NOW, proof);
    expect(r.bound).toBe(true);
    expect(r.genesisPublicKey).toBe(K);
  });

  it("fails when the inclusion proof doesn't reconstruct the anchored root", async () => {
    const K = bytesToHex((await generateKeypair()).publicKey);
    const id = identity("mote-x", K);
    const proof = await treeFor(await identityLogLeaf("mote-x", K));
    const r = await verifyIdentityBindingAnchored(id, K, NOW, {
      ...proof,
      anchoredRoot: "00".repeat(32),
    });
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not included in the anchored transparency log");
  });

  it("fails at the sovereign root when the signing key isn't this identity's key", async () => {
    const K = bytesToHex((await generateKeypair()).publicKey);
    const stranger = bytesToHex((await generateKeypair()).publicKey);
    const id = identity("mote-x", K);
    const proof = await treeFor(await identityLogLeaf("mote-x", K));
    const r = await verifyIdentityBindingAnchored(id, stranger, NOW, proof);
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not in this identity's succession chain");
  });

  it("binds an old rotated key when the current key is anchored", async () => {
    // The realistic case: a receipt was signed by the genesis key, the motebit
    // later rotated, and the LOG anchors the current key. The old key must still
    // bind for a receipt dated within its window.
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const k1 = bytesToHex(kp1.publicKey);
    const k2 = bytesToHex(kp2.publicKey);
    const id: MotebitIdentityFile = {
      ...identity("mote-x", k2),
      succession: [await rotation(kp1, kp2, ROTATED_AT)],
    };
    // The log commits the CURRENT key (k2); the receipt is signed by the OLD key.
    const proof = await treeFor(await identityLogLeaf("mote-x", k2));
    const r = await verifyIdentityBindingAnchored(id, k1, CREATED + 1000, proof);
    expect(r.bound).toBe(true);
    expect(r.genesisPublicKey).toBe(k1);
  });

  it("identityLogLeaf is deterministic and key-specific", async () => {
    const a = await identityLogLeaf("mote-x", "aa");
    const b = await identityLogLeaf("mote-x", "aa");
    const c = await identityLogLeaf("mote-x", "bb");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
