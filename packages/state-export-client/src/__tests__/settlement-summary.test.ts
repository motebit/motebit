/**
 * verifiedSettlementSummaryFetch tests — typed wrapper over the generic
 * verified fetch for the per-peer settlement summary. Pins the canonical
 * URL shape, the happy path, and the fail-closed artifact_type guard
 * (signed bytes for the WRONG export are rejected, not rendered).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, bytesToHex, hexToBytes, signContentArtifact } from "@motebit/crypto";
import type { ContentArtifactType } from "@motebit/protocol";

import {
  verifiedSettlementSummaryFetch,
  settlementSummaryUrl,
  type SettlementSummaryExport,
} from "../settlement-summary.js";
import { MANIFEST_HEADER } from "../verified-fetch.js";
import type { TransparencyAnchor } from "../transparency-anchor.js";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  did: string;
}

let signer: Keys;

beforeAll(async () => {
  const kp = await generateKeypair();
  const hex = bytesToHex(kp.publicKey);
  signer = {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: hex,
    did: `did:key:z${hex.slice(0, 16)}`,
  };
});

function anchor(): TransparencyAnchor {
  return {
    relayPublicKey: hexToBytes(signer.publicKeyHex),
    relayPublicKeyHex: signer.publicKeyHex.toLowerCase(),
    relayId: "test-relay",
    declaredAt: 1736500000000,
  };
}

function header(manifest: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function serve(
  body: object,
  artifactType: ContentArtifactType,
): Promise<typeof globalThis.fetch> {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  const manifest = await signContentArtifact(bodyBytes, {
    artifactType,
    producer: signer.did,
    producerPublicKey: signer.publicKey,
    producerPrivateKey: signer.privateKey,
    claimGenerator: "motebit-relay/test",
  });
  return async () =>
    new Response(bodyBytes, {
      status: 200,
      headers: { "Content-Type": "application/json", [MANIFEST_HEADER]: header(manifest) },
    });
}

const SUMMARY: SettlementSummaryExport = {
  motebit_id: "mote-me",
  peers: [
    {
      peer_id: "mote-peer",
      earned_micro: 3_000_000,
      paid_micro: 500_000,
      net_micro: 2_500_000,
      fee_micro: 25_000,
      settled_count: 3,
      p2p_count: 2,
      first_at: 100,
      last_at: 300,
    },
  ],
  unattributed: { earned_micro: 0, fee_micro: 0, settled_count: 0 },
};

describe("settlementSummaryUrl", () => {
  it("builds the canonical /api/v1/agents/:id/settlements path, trimming a trailing slash", () => {
    expect(settlementSummaryUrl("https://relay.example.com/", "mote-me")).toBe(
      "https://relay.example.com/api/v1/agents/mote-me/settlements",
    );
  });
});

describe("verifiedSettlementSummaryFetch", () => {
  it("returns the parsed summary when the manifest verifies", async () => {
    const fetch = await serve(SUMMARY, "settlement-summary");
    const res = await verifiedSettlementSummaryFetch("https://relay.example.com", "mote-me", {
      fetch,
      anchor: anchor(),
    });
    expect(res.verification.valid).toBe(true);
    expect(res.body).toEqual(SUMMARY);
  });

  it("fails closed when the verified manifest is signed for a DIFFERENT artifact_type", async () => {
    // Bytes verify, key pins — but the manifest claims `audit-trail`.
    const fetch = await serve(SUMMARY, "audit-trail");
    const res = await verifiedSettlementSummaryFetch("https://relay.example.com", "mote-me", {
      fetch,
      anchor: anchor(),
    });
    expect(res.body).toBeNull();
    expect(res.verification.valid).toBe(false);
    if (!res.verification.valid) {
      expect(res.verification.reason).toBe("unexpected_artifact_type");
    }
  });
});
