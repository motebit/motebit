/**
 * State-export manifest sweep — pins the doctrine §8 promise that
 * every `app.get(...)` in `state-export.ts` emits a relay-asserted
 * `ContentArtifactManifest` in the `X-Motebit-Content-Manifest`
 * HTTP header.
 *
 * Coverage is one assertion per endpoint: hit the route with minimal
 * setup, decode the manifest header, verify the signature against
 * the response body bytes. The `verifyContentArtifact` primitive is
 * exhaustively tested in `@motebit/crypto`; this file is the
 * structural pin that every endpoint composes correctly.
 *
 * The drift gate `check-state-export-signed` enforces the same
 * invariant statically. This sweep is the runtime sibling — together
 * they catch both pre-merge and runtime drift.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { fromBase64Url } from "@motebit/encryption";
import { verifyContentArtifact, type ContentArtifactManifest } from "@motebit/crypto";
import type { ContentArtifactType } from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay as _createTestRelay } from "./test-helpers.js";

const MOTEBIT_ID = "test-mote-export";
const createTestRelay = () => _createTestRelay({ enableDeviceAuth: false });

function decodeManifestHeader(headerValue: string | null): ContentArtifactManifest {
  if (headerValue == null || headerValue === "") {
    throw new Error("X-Motebit-Content-Manifest header missing");
  }
  const manifestBytes = fromBase64Url(headerValue);
  const manifestJson = new TextDecoder().decode(manifestBytes);
  return JSON.parse(manifestJson) as ContentArtifactManifest;
}

// One route per artifact-type — covers every `app.get(...)` in
// `state-export.ts` except `execution-ledger`, which is exhaustively
// tested in `execution-ledger-reconstruction.test.ts`.
//
// `requiresGoalId` paths skipped — execution-ledger needs a plan
// fixture and is covered elsewhere. Every other endpoint accepts
// empty-state and returns a signed body anyway (relay attests "no
// state for motebit X at time T," which is itself a valid claim).
interface Endpoint {
  path: string;
  expectedType: ContentArtifactType;
}

const ENDPOINTS: ReadonlyArray<Endpoint> = [
  { path: `/api/v1/state/${MOTEBIT_ID}`, expectedType: "state-snapshot" },
  { path: `/api/v1/memory/${MOTEBIT_ID}`, expectedType: "memory-export" },
  { path: `/api/v1/goals/${MOTEBIT_ID}`, expectedType: "goal-list" },
  { path: `/api/v1/conversations/${MOTEBIT_ID}`, expectedType: "conversation-list" },
  {
    path: `/api/v1/conversations/${MOTEBIT_ID}/conv-1/messages`,
    expectedType: "conversation-messages",
  },
  { path: `/api/v1/devices/${MOTEBIT_ID}`, expectedType: "device-list" },
  { path: `/api/v1/audit/${MOTEBIT_ID}`, expectedType: "audit-trail" },
  { path: `/api/v1/plans/${MOTEBIT_ID}`, expectedType: "plan-list" },
  { path: `/api/v1/gradient/${MOTEBIT_ID}`, expectedType: "gradient-history" },
  { path: `/api/v1/sync/${MOTEBIT_ID}/pull`, expectedType: "sync-pull" },
  { path: `/api/v1/agents/${MOTEBIT_ID}/settlements`, expectedType: "settlement-summary" },
];

describe("State-export manifest sweep — every GET emits a verifiable signed bundle", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.path} → artifact_type=${endpoint.expectedType}, round-trip verifies`, async () => {
      const res = await relay.app.request(endpoint.path, {
        method: "GET",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/application\/json/);

      const bodyBytes = new Uint8Array(await res.arrayBuffer());
      const manifest = decodeManifestHeader(res.headers.get("X-Motebit-Content-Manifest"));

      expect(manifest.artifact_type).toBe(endpoint.expectedType);
      expect(manifest.suite).toBe("motebit-jcs-ed25519-hex-v1");
      expect(manifest.producer).toMatch(/^did:key:/);
      expect(manifest.producer_public_key).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.claim_generator).toMatch(/^motebit-relay\//);

      const result = await verifyContentArtifact(manifest, bodyBytes);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  }

  it("all sampled endpoints use the SAME producer key (one relay identity)", async () => {
    const producers = new Set<string>();
    for (const endpoint of ENDPOINTS) {
      const res = await relay.app.request(endpoint.path, {
        method: "GET",
        headers: AUTH_HEADER,
      });
      const manifest = decodeManifestHeader(res.headers.get("X-Motebit-Content-Manifest"));
      producers.add(manifest.producer_public_key);
    }
    // The relay attests with one identity for every export; a verifier
    // that pins the relay's public key can verify every endpoint's
    // manifest with that single anchor.
    expect(producers.size).toBe(1);
  });

  it("tampering the body of any endpoint produces content_hash_mismatch", async () => {
    // Spot-check tamper detection on one endpoint — same primitive is
    // exercised in execution-ledger-reconstruction.test.ts for the
    // 11th endpoint and in @motebit/crypto unit tests at the primitive
    // layer.
    const res = await relay.app.request(`/api/v1/audit/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    const manifest = decodeManifestHeader(res.headers.get("X-Motebit-Content-Manifest"));
    const tampered = new Uint8Array(bodyBytes);
    tampered[0] = tampered[0]! ^ 0x01;
    const result = await verifyContentArtifact(manifest, tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("content_hash_mismatch");
  });
});
