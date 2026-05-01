/**
 * Witness-omission dispute sign + verify tests (retention phase 4b-3).
 *
 * Coverage matrix locked in `retention-next-session-handoff.md` —
 * eight tests minimum, two cert-side round-trips plus six dispute
 * checks (two positive, four negative across both evidence shapes
 * and both clock gates).
 */

import { describe, expect, it } from "vitest";

import type {
  DeletionCertificate,
  HorizonWitness,
  WitnessOmissionDispute,
} from "@motebit/protocol";
import { asMotebitId, EMPTY_FEDERATION_GRAPH_ANCHOR } from "@motebit/protocol";

import { generateEd25519Keypair, signBySuite } from "../suite-dispatch.js";
import { bytesToHex, sha256 } from "../signing.js";
import {
  signHorizonCertAsIssuer,
  signHorizonWitness,
  verifyDeletionCertificate,
  WITNESS_OMISSION_DISPUTE_WINDOW_MS,
} from "../deletion-certificate.js";
import {
  signWitnessOmissionDispute,
  verifyWitnessOmissionDispute,
} from "../witness-omission-dispute.js";

const FEDERATION_HEARTBEAT_SUITE = "motebit-concat-ed25519-hex-v1" as const;

async function makeKeyPair() {
  const { publicKey, privateKey } = await generateEd25519Keypair();
  return { publicKey, privateKey };
}

/**
 * Compute a federation peer leaf — SHA-256 of the lowercase hex
 * encoding of the peer's Ed25519 pubkey. Mirrors the canonicalization
 * locked in `retention-policy.ts` § FederationGraphAnchor.
 */
async function computePeerLeaf(pubkey: Uint8Array): Promise<string> {
  const hex = bytesToHex(pubkey).toLowerCase();
  const hash = await sha256(new TextEncoder().encode(hex));
  return bytesToHex(hash);
}

/**
 * Build a 2-leaf anchor over [disputantPubkey, otherPubkey] sorted
 * by hex-pubkey. Returns the anchor + the inclusion proof for the
 * disputant. Mirrors the binary-tree-with-odd-promotion algorithm in
 * `merkle.ts`.
 */
async function buildTwoPeerAnchor(disputantPubkey: Uint8Array, otherPubkey: Uint8Array) {
  const disputantHex = bytesToHex(disputantPubkey).toLowerCase();
  const otherHex = bytesToHex(otherPubkey).toLowerCase();
  const sorted =
    disputantHex < otherHex ? [disputantPubkey, otherPubkey] : [otherPubkey, disputantPubkey];
  const disputantIndex = disputantHex < otherHex ? 0 : 1;
  const otherIndex = 1 - disputantIndex;

  const leaves = await Promise.all(sorted.map((p) => computePeerLeaf(p)));
  const leftBytes = hexToBytes(leaves[0]!);
  const rightBytes = hexToBytes(leaves[1]!);
  const concat = new Uint8Array(leftBytes.length + rightBytes.length);
  concat.set(leftBytes);
  concat.set(rightBytes, leftBytes.length);
  const rootBytes = await sha256(concat);
  const merkleRoot = bytesToHex(rootBytes);

  return {
    anchor: { algo: "merkle-sha256-v1" as const, merkle_root: merkleRoot, leaf_count: 2 },
    disputantLeaf: leaves[disputantIndex]!,
    disputantIndex,
    proofForDisputant: {
      siblings: [leaves[otherIndex]!],
      leaf_index: disputantIndex,
      layer_sizes: [2],
    },
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Build a federation Heartbeat-shaped peering artifact signed by the
 * cert issuer. Mirrors the heartbeat sender in `services/relay/src/federation.ts`.
 */
async function buildHeartbeatArtifact(
  issuerMotebitId: string,
  timestamp: number,
  issuerPrivateKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const payload = new TextEncoder().encode(
    `${issuerMotebitId}|${timestamp}|${FEDERATION_HEARTBEAT_SUITE}`,
  );
  const sig = await signBySuite(FEDERATION_HEARTBEAT_SUITE, payload, issuerPrivateKey);
  return {
    relay_id: issuerMotebitId,
    timestamp,
    signature: bytesToHex(sig),
    agent_count: 0,
  };
}

const HORIZON_TS = 1730000000000;
const ISSUED_AT = HORIZON_TS + 1000;

const baseHorizonBody = (
  issuerMotebitId: string,
): Omit<Extract<DeletionCertificate, { kind: "append_only_horizon" }>, "signature" | "suite"> => ({
  kind: "append_only_horizon",
  subject: { kind: "motebit", motebit_id: asMotebitId(issuerMotebitId) },
  store_id: "event_log",
  horizon_ts: HORIZON_TS,
  witnessed_by: [],
  issued_at: ISSUED_AT,
});

// ── 1. Round-trip empty-tree self-witnessed cert ─────────────────────

describe("verifyDeletionCertificate — empty-tree self-witnessed horizon cert", () => {
  it("admits leaf_count=0 anchor with empty witnessed_by[]", async () => {
    const issuer = await makeKeyPair();
    const cert = await signHorizonCertAsIssuer(
      {
        ...baseHorizonBody("issuer-relay"),
        federation_graph_anchor: EMPTY_FEDERATION_GRAPH_ANCHOR,
      },
      issuer.privateKey,
    );
    const result = await verifyDeletionCertificate(cert, {
      resolveMotebitPublicKey: async (id) => (id === "issuer-relay" ? issuer.publicKey : null),
      resolveOperatorPublicKey: async () => null,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps.horizon_witnesses_present_count).toBe(0);
  });

  it("rejects leaf_count=0 with a non-empty-tree merkle_root", async () => {
    const issuer = await makeKeyPair();
    const cert = await signHorizonCertAsIssuer(
      {
        ...baseHorizonBody("issuer-relay"),
        federation_graph_anchor: {
          algo: "merkle-sha256-v1",
          merkle_root: "00".repeat(32),
          leaf_count: 0,
        },
      },
      issuer.privateKey,
    );
    const result = await verifyDeletionCertificate(cert, {
      resolveMotebitPublicKey: async (id) => (id === "issuer-relay" ? issuer.publicKey : null),
      resolveOperatorPublicKey: async () => null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty-tree merkle_root"))).toBe(true);
  });
});

// ── 2. Round-trip horizon cert with peer witnesses ───────────────────

describe("verifyDeletionCertificate — horizon cert with witnessed peers", () => {
  it("verifies issuer + multiple witness signatures over identical canonical bytes", async () => {
    const issuer = await makeKeyPair();
    const peerA = await makeKeyPair();
    const peerB = await makeKeyPair();

    // Witnesses sign over the same body-minus-witnessed_by that the issuer
    // eventually signs — including federation_graph_anchor — so the
    // canonical bytes match at verify time.
    const sharedBody = {
      ...baseHorizonBody("issuer-relay"),
      federation_graph_anchor: {
        algo: "merkle-sha256-v1" as const,
        merkle_root: "11".repeat(32),
        leaf_count: 2,
      },
    };
    const witnessARecord: HorizonWitness = await signHorizonWitness(
      { ...sharedBody, suite: "motebit-jcs-ed25519-b64-v1", signature: "" },
      "peer-a",
      peerA.privateKey,
    );
    const witnessBRecord: HorizonWitness = await signHorizonWitness(
      { ...sharedBody, suite: "motebit-jcs-ed25519-b64-v1", signature: "" },
      "peer-b",
      peerB.privateKey,
    );
    const certWithWitnesses = await signHorizonCertAsIssuer(
      { ...sharedBody, witnessed_by: [witnessARecord, witnessBRecord] },
      issuer.privateKey,
    );
    const result = await verifyDeletionCertificate(certWithWitnesses, {
      resolveMotebitPublicKey: async (id) => {
        if (id === "issuer-relay") return issuer.publicKey;
        if (id === "peer-a") return peerA.publicKey;
        if (id === "peer-b") return peerB.publicKey;
        return null;
      },
      resolveOperatorPublicKey: async () => null,
    });
    expect(result.valid).toBe(true);
    expect(result.steps.horizon_witnesses_valid_count).toBe(2);
    expect(result.steps.horizon_witnesses_present_count).toBe(2);
  });
});

// ── Helper: build cert + dispute-base for the dispute-side tests ─────

async function setupDisputeFixture() {
  const issuer = await makeKeyPair();
  const disputant = await makeKeyPair();
  const otherPeer = await makeKeyPair();

  const { anchor, disputantLeaf, proofForDisputant } = await buildTwoPeerAnchor(
    disputant.publicKey,
    otherPeer.publicKey,
  );

  // Cert WITHOUT a witness from the disputant — the disputant claims wrongful omission.
  const cert = await signHorizonCertAsIssuer(
    {
      ...baseHorizonBody("issuer-relay"),
      federation_graph_anchor: anchor,
      // Only otherPeer witnessed; disputant was omitted.
      witnessed_by: [],
    },
    issuer.privateKey,
  );

  return { issuer, disputant, otherPeer, cert, disputantLeaf, proofForDisputant };
}

// ── 3. Positive: inclusion-proof claim ───────────────────────────────

describe("verifyWitnessOmissionDispute — inclusion_proof evidence", () => {
  it("admits a valid inclusion proof against the cert anchor", async () => {
    const { issuer, disputant, cert, disputantLeaf, proofForDisputant } =
      await setupDisputeFixture();

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-001",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: disputantLeaf,
          proof: proofForDisputant,
        },
        filed_at: ISSUED_AT + 60_000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 60_000,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps.window_open).toBe(true);
    expect(result.steps.cert_binding_valid).toBe(true);
    expect(result.steps.disputant_signature_valid).toBe(true);
    expect(result.steps.evidence_valid).toBe(true);
  });
});

// ── 4. Positive: alternative-peering claim ───────────────────────────

describe("verifyWitnessOmissionDispute — alternative_peering evidence", () => {
  it("admits a valid heartbeat artifact within ±5min of cert.horizon_ts", async () => {
    const issuer = await makeKeyPair();
    const disputant = await makeKeyPair();

    const cert = await signHorizonCertAsIssuer(
      {
        ...baseHorizonBody("issuer-relay"),
        federation_graph_anchor: EMPTY_FEDERATION_GRAPH_ANCHOR,
      },
      issuer.privateKey,
    );

    const heartbeat = await buildHeartbeatArtifact(
      "issuer-relay",
      HORIZON_TS - 30_000, // 30s before horizon — within freshness window
      issuer.privateKey,
    );

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-002",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: { kind: "alternative_peering", peering_artifact: heartbeat },
        filed_at: ISSUED_AT + 1000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 1000,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps.evidence_valid).toBe(true);
  });
});

// ── 5. Negative: window-expired ──────────────────────────────────────

describe("verifyWitnessOmissionDispute — window expiry", () => {
  it("rejects a dispute whose receiver clock is past cert.issued_at + 24h", async () => {
    const { issuer, disputant, cert, disputantLeaf, proofForDisputant } =
      await setupDisputeFixture();

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-003",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: disputantLeaf,
          proof: proofForDisputant,
        },
        // Disputant attests filed_at within the window, but...
        filed_at: ISSUED_AT + 60_000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      // ...the receiver's wall clock is past the 24h window.
      now: ISSUED_AT + WITNESS_OMISSION_DISPUTE_WINDOW_MS + 1,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.window_open).toBe(false);
    expect(result.errors.some((e) => e.includes("dispute window expired"))).toBe(true);
  });

  it("rejects a backdated filed_at outside [cert.issued_at, +WINDOW]", async () => {
    const { issuer, disputant, cert, disputantLeaf, proofForDisputant } =
      await setupDisputeFixture();

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-003b",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: disputantLeaf,
          proof: proofForDisputant,
        },
        // Disputant claims filed_at BEFORE the cert was issued — invalid.
        filed_at: ISSUED_AT - 1,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 60_000,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.window_open).toBe(false);
    expect(
      result.errors.some((e) => e.includes("disputant-attested clock cannot widen window")),
    ).toBe(true);
  });
});

// ── 6. Negative: invalid disputant signature ─────────────────────────

describe("verifyWitnessOmissionDispute — disputant signature", () => {
  it("rejects a dispute whose signature has been tampered", async () => {
    const { issuer, disputant, cert, disputantLeaf, proofForDisputant } =
      await setupDisputeFixture();

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-004",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: disputantLeaf,
          proof: proofForDisputant,
        },
        filed_at: ISSUED_AT + 60_000,
      },
      disputant.privateKey,
    );

    // Mutate dispute_id without re-signing — invalidates the signature.
    const tampered: WitnessOmissionDispute = { ...dispute, dispute_id: "dispute-004-tampered" };

    const result = await verifyWitnessOmissionDispute(tampered, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 60_000,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.disputant_signature_valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not verify"))).toBe(true);
  });
});

// ── 7. Negative: malformed inclusion proof ───────────────────────────

describe("verifyWitnessOmissionDispute — inclusion_proof malformed", () => {
  it("rejects a dispute whose inclusion proof does not reconstruct to the anchor", async () => {
    const { issuer, disputant, cert, disputantLeaf } = await setupDisputeFixture();

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-005",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: disputantLeaf,
          // Garbage sibling — will not reconstruct.
          proof: { siblings: ["aa".repeat(32)], leaf_index: 0, layer_sizes: [2] },
        },
        filed_at: ISSUED_AT + 60_000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 60_000,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.evidence_valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("does not reconstruct to anchor.merkle_root")),
    ).toBe(true);
  });

  it("rejects an inclusion_proof claim against a self-witnessed cert (leaf_count=0)", async () => {
    const issuer = await makeKeyPair();
    const disputant = await makeKeyPair();

    const cert = await signHorizonCertAsIssuer(
      {
        ...baseHorizonBody("issuer-relay"),
        federation_graph_anchor: EMPTY_FEDERATION_GRAPH_ANCHOR,
      },
      issuer.privateKey,
    );

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-005b",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: {
          kind: "inclusion_proof",
          leaf_hash: "00".repeat(32),
          proof: { siblings: [], leaf_index: 0, layer_sizes: [] },
        },
        filed_at: ISSUED_AT + 60_000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 60_000,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.evidence_valid).toBe(false);
    expect(result.errors.some((e) => e.includes("self-witnessed"))).toBe(true);
  });
});

// ── 8. Negative: alternative-peering missing supporting signature ────

describe("verifyWitnessOmissionDispute — alternative_peering missing/invalid signature", () => {
  it("rejects a heartbeat artifact whose signature does not verify against the cert issuer", async () => {
    const issuer = await makeKeyPair();
    const disputant = await makeKeyPair();
    const imposter = await makeKeyPair();

    const cert = await signHorizonCertAsIssuer(
      {
        ...baseHorizonBody("issuer-relay"),
        federation_graph_anchor: EMPTY_FEDERATION_GRAPH_ANCHOR,
      },
      issuer.privateKey,
    );

    // Heartbeat signed by imposter, claiming to be from issuer-relay.
    const forgedHeartbeat = await buildHeartbeatArtifact(
      "issuer-relay",
      HORIZON_TS,
      imposter.privateKey,
    );

    const dispute = await signWitnessOmissionDispute(
      {
        dispute_id: "dispute-006",
        cert_issuer: "issuer-relay",
        cert_signature: cert.signature,
        disputant_motebit_id: "disputant-peer",
        evidence: { kind: "alternative_peering", peering_artifact: forgedHeartbeat },
        filed_at: ISSUED_AT + 1000,
      },
      disputant.privateKey,
    );

    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: issuer.publicKey,
      disputantPublicKey: disputant.publicKey,
      now: ISSUED_AT + 1000,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.evidence_valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("signature does not verify against cert issuer pubkey")),
    ).toBe(true);
  });
});
