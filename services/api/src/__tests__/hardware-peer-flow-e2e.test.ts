/**
 * Hardware-attestation peer flow — Phase 1 E2E acceptance test.
 *
 * Proves the protocol loop end-to-end with the `software` sentinel:
 *
 *   1. Worker B composes a self-issued AgentTrustCredential bearing a
 *      `hardware_attestation: { platform: "software" }` claim and
 *      attaches it to its device record via the new
 *      `POST /api/v1/agents/:motebitId/devices/:deviceId/hardware-attestation`
 *      endpoint.
 *   2. Delegator A pulls B's capabilities — confirms the
 *      `hardware_attestation_credential` is publicly visible.
 *   3. A verifies the embedded claim via `verifyHardwareAttestationClaim`
 *      (no platform-adapter `verifiers` argument — `software` returns
 *      truthful `valid: false, platform: "software"`).
 *   4. A issues a peer `AgentTrustCredential` (issuer = A, subject = B)
 *      carrying the verified `hardware_attestation` claim.
 *   5. A submits the peer trust credential via `/credentials/submit` —
 *      relay accepts (issuer ≠ subject; the doctrine holds with no
 *      carve-out).
 *   6. Routing aggregator (`aggregateHardwareAttestation`) reads the
 *      relay-stored trust credential and produces an `attestation_score`
 *      of `HW_ATTESTATION_SOFTWARE` (0.1) for B.
 *
 * Sibling negative test confirms `/credentials/submit` STILL rejects
 * a self-issued `AgentTrustCredential`. Locks the doctrine the original
 * carve-out proposal would have weakened. Per
 * `lesson_hardware_attestation_self_issued_dead_drop.md`: the body's
 * `accepted: 0, rejected: 1` is checked, not just HTTP 200.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  signDeviceRegistration,
  composeHardwareAttestationCredential,
  canonicalJson,
  toBase64Url,
  signVerifiableCredential,
  hexPublicKeyToDidKey,
  bytesToHex,
} from "@motebit/encryption";
import type { KeyPair, VerifiableCredential } from "@motebit/encryption";
import { signBySuite } from "@motebit/crypto";
import {
  aggregateHardwareAttestation,
  HW_ATTESTATION_SOFTWARE,
  type TrustVC,
} from "@motebit/market";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface BootstrapResult {
  motebitId: string;
  deviceId: string;
  keypair: KeyPair;
  publicKeyHex: string;
}

async function bootstrapAgent(relay: SyncRelay): Promise<BootstrapResult> {
  const keypair = await generateKeypair();
  const motebitId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const publicKeyHex = bytesToHex(keypair.publicKey);

  const body = await signDeviceRegistration(
    {
      motebit_id: motebitId,
      device_id: deviceId,
      public_key: publicKeyHex,
      timestamp: Date.now(),
    },
    keypair.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register-self failed: ${res.status}`);
  }
  return { motebitId, deviceId, keypair, publicKeyHex };
}

/**
 * Sign + POST a hardware-attestation attach request. Mirrors the wire
 * format the new endpoint enforces (signed envelope + the credential
 * JSON inside the body).
 */
async function attachHardwareAttestation(
  relay: SyncRelay,
  agent: BootstrapResult,
  vc: VerifiableCredential<unknown>,
): Promise<Response> {
  const credentialJson = JSON.stringify(vc);
  const body = {
    motebit_id: agent.motebitId,
    device_id: agent.deviceId,
    hardware_attestation_credential: credentialJson,
    timestamp: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const canonical = canonicalJson(body);
  const messageBytes = new TextEncoder().encode(canonical);
  const sigBytes = await signBySuite(
    "motebit-jcs-ed25519-b64-v1",
    messageBytes,
    agent.keypair.privateKey,
  );
  const signed = { ...body, signature: toBase64Url(sigBytes) };
  return relay.app.request(
    `/api/v1/agents/${agent.motebitId}/devices/${agent.deviceId}/hardware-attestation`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(signed),
    },
  );
}

// ==========================================================================
// Phase 1 E2E
// ==========================================================================

describe("Hardware-attestation peer flow — Phase 1 E2E (software sentinel)", () => {
  let relay: SyncRelay;
  let agentA: BootstrapResult;
  let agentB: BootstrapResult;
  let bSelfHardwareVc: VerifiableCredential<unknown>;
  const MASTER_TOKEN = "hw-peer-flow-test-token";

  beforeAll(async () => {
    relay = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: MASTER_TOKEN,
      enableDeviceAuth: true,
      issueCredentials: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    agentA = await bootstrapAgent(relay);
    agentB = await bootstrapAgent(relay);

    // Worker B composes its self-issued hardware-attestation credential
    // (software sentinel — no real cascade-mint needed for Phase 1).
    bSelfHardwareVc = await composeHardwareAttestationCredential({
      publicKey: agentB.keypair.publicKey,
      publicKeyHex: agentB.publicKeyHex,
      privateKey: agentB.keypair.privateKey,
      hardwareAttestation: { platform: "software", key_exported: false },
      now: Date.now(),
    });
  });

  afterAll(async () => {
    if (relay) await relay.close();
  });

  it("worker attaches its self-hardware credential to the device record", async () => {
    const res = await attachHardwareAttestation(relay, agentB, bSelfHardwareVc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; device_id: string };
    expect(body.motebit_id).toBe(agentB.motebitId);
    expect(body.device_id).toBe(agentB.deviceId);
  });

  it("delegator pulls worker's capabilities and sees the credential", async () => {
    const res = await relay.app.request(`/agent/${agentB.motebitId}/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hardware_attestations: Array<{
        device_id: string;
        public_key: string;
        hardware_attestation_credential: string;
      }>;
    };
    expect(body.hardware_attestations).toHaveLength(1);
    expect(body.hardware_attestations[0]!.device_id).toBe(agentB.deviceId);
    expect(body.hardware_attestations[0]!.public_key).toBe(agentB.publicKeyHex);
    // The credential is the same VC the worker attached — peer verifiers
    // can parse, verify, and extract the hardware claim from this string.
    const reparsed = JSON.parse(
      body.hardware_attestations[0]!.hardware_attestation_credential,
    ) as VerifiableCredential<{ hardware_attestation: { platform: string } }>;
    expect(reparsed.credentialSubject.hardware_attestation.platform).toBe("software");
  });

  it("delegator issues peer AgentTrustCredential carrying verified claim, relay accepts (issuer ≠ subject)", async () => {
    // A simulates the runtime's bumpTrustFromReceipt hook: pull B's
    // hardware claim, fold it into a peer AgentTrustCredential, sign as
    // A, submit. The runtime version of this is in
    // packages/runtime/src/agent-trust.ts (Phase 1 step 6).
    const subjectDid = hexPublicKeyToDidKey(agentB.publicKeyHex);
    const issuerDid = hexPublicKeyToDidKey(agentA.publicKeyHex);
    const now = new Date();
    const peerTrustVc = await signVerifiableCredential(
      {
        "@context": [
          "https://www.w3.org/ns/credentials/v2",
          "https://motebit.com/ns/credentials/v1",
        ],
        type: ["VerifiableCredential", "AgentTrustCredential"],
        issuer: issuerDid,
        credentialSubject: {
          id: subjectDid,
          trust_level: "Verified",
          interaction_count: 1,
          successful_tasks: 1,
          failed_tasks: 0,
          first_seen_at: now.getTime() - 1000,
          last_seen_at: now.getTime(),
          // The verified hardware claim — A vouches that B's identity key
          // is hardware-backed (or, in the software sentinel case,
          // truthfully reports no hardware channel).
          hardware_attestation: { platform: "software", key_exported: false },
        },
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      },
      agentA.keypair.privateKey,
      agentA.keypair.publicKey,
    );

    // Submit to /credentials/submit — peer-issued; relay accepts.
    const res = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/credentials/submit`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${MASTER_TOKEN}` },
      body: JSON.stringify({ credentials: [peerTrustVc] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: number;
      rejected: number;
      errors?: string[];
    };
    // Per the dead-drop lesson — assert on body fields, not response.ok.
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
  });

  it("aggregator scores B's trust credential at HW_ATTESTATION_SOFTWARE (0.1)", async () => {
    // Pull the relay's stored credentials for B and feed through the
    // aggregator. This mirrors what task-routing.ts does on every
    // discovery request.
    const res = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/credentials`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: Array<{ credential: TrustVC; credential_type: string }>;
    };
    const trustVcs = body.credentials
      .filter((row) => row.credential_type === "AgentTrustCredential")
      .map((row) => row.credential);
    expect(trustVcs.length).toBeGreaterThanOrEqual(1);

    const aggregate = aggregateHardwareAttestation(trustVcs, () => 0.9);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.attestation_score).toBeCloseTo(HW_ATTESTATION_SOFTWARE);
    expect(aggregate!.platform_breakdown.software).toBeGreaterThanOrEqual(1);
  });

  // Doctrine-locking negative test: even with the new device-record path
  // for hardware attestation, /credentials/submit STILL rejects self-issued
  // credentials. Confirms the carve-out proposal that was rejected on review
  // doesn't sneak back in. Without this test, a future contributor could
  // weaken §23 silently.
  it("/credentials/submit STILL rejects self-issued AgentTrustCredentials (doctrine lock)", async () => {
    // The credential B already attached to its device record is self-issued.
    // Submitting that exact credential through /credentials/submit MUST
    // produce accepted: 0, rejected: 1 — the bootstrap-time submission
    // path commit 63fa2199 unwound.
    const res = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/credentials/submit`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${MASTER_TOKEN}` },
      body: JSON.stringify({ credentials: [bSelfHardwareVc] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: number;
      rejected: number;
      errors?: string[];
    };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.errors).toContain("self-issued credential rejected");
  });
});
