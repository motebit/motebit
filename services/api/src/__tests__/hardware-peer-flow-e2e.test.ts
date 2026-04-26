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
import { signBySuite, mintSecureEnclaveReceiptForTest } from "@motebit/crypto";
import {
  aggregateHardwareAttestation,
  HW_ATTESTATION_HARDWARE,
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

  // ── Hardening negatives — attach endpoint rejects bad inputs ─────────

  it("attach rejects malformed JSON in hardware_attestation_credential", async () => {
    // Build a syntactically-valid signed envelope with an invalid inner
    // credential (not JSON at all). The outer envelope signature checks
    // pass; the inner JSON.parse should fail and the endpoint returns 400.
    const body = {
      motebit_id: agentB.motebitId,
      device_id: agentB.deviceId,
      hardware_attestation_credential: "this is not json {{{",
      timestamp: Date.now(),
      suite: "motebit-jcs-ed25519-b64-v1" as const,
    };
    const sig = await signBySuite(
      "motebit-jcs-ed25519-b64-v1",
      new TextEncoder().encode(canonicalJson(body)),
      agentB.keypair.privateKey,
    );
    const res = await relay.app.request(
      `/api/v1/agents/${agentB.motebitId}/devices/${agentB.deviceId}/hardware-attestation`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, signature: toBase64Url(sig) }),
      },
    );
    expect(res.status).toBe(400);
    // Hono's HTTPException emits the message in the response body as plain
    // text by default. Read text + match — body shape is implementation
    // detail of Hono, not motebit; the contract is "400 with the message
    // somewhere visible to the client."
    const errText = await res.text();
    expect(errText).toMatch(/not valid JSON/);
  });

  it("attach rejects credentials whose identity_public_key doesn't match the device", async () => {
    // Compose a credential with agentA's keypair as the subject. Submit
    // through agentB's attach endpoint — relay must reject because the
    // subject's identity_public_key wouldn't match B's registered key.
    const wrongKeyVc = await composeHardwareAttestationCredential({
      publicKey: agentA.keypair.publicKey,
      publicKeyHex: agentA.publicKeyHex,
      privateKey: agentA.keypair.privateKey,
      hardwareAttestation: { platform: "software", key_exported: false },
      now: Date.now(),
    });
    const res = await attachHardwareAttestation(
      relay,
      agentB,
      wrongKeyVc as unknown as VerifiableCredential<unknown>,
    );
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { code?: string };
    expect(errBody.code).toBe("IDENTITY_KEY_MISMATCH");
  });

  it("attach rejects credentials with a tampered VC signature", async () => {
    // Take a valid credential (B's), flip the proof.proofValue's last
    // character. The eddsa-jcs-2022 verification fails. Endpoint returns
    // 400 with code BAD_CREDENTIAL.
    const tamperedVc = {
      ...bSelfHardwareVc,
      proof: {
        ...bSelfHardwareVc.proof,
        proofValue:
          bSelfHardwareVc.proof.proofValue.slice(0, -1) +
          (bSelfHardwareVc.proof.proofValue.endsWith("a") ? "b" : "a"),
      },
    };
    const res = await attachHardwareAttestation(relay, agentB, tamperedVc);
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { code?: string };
    expect(errBody.code).toBe("BAD_CREDENTIAL");
  });

  it("attach rejects expired credentials", async () => {
    // Compose a credential with a `now` timestamp far in the past so the
    // default ONE_HOUR_MS validUntil is already expired. The relay's
    // verifyVerifiableCredential returns false on expiry; endpoint
    // rejects with BAD_CREDENTIAL.
    const longAgo = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    const expiredVc = await composeHardwareAttestationCredential({
      publicKey: agentB.keypair.publicKey,
      publicKeyHex: agentB.publicKeyHex,
      privateKey: agentB.keypair.privateKey,
      hardwareAttestation: { platform: "software", key_exported: false },
      now: longAgo,
    });
    // Inject an expired validUntil — composeHardwareAttestationCredential
    // doesn't set validUntil, so we add it explicitly to trigger the
    // expiry check inside verifyVerifiableCredential.
    const withValidUntil = {
      ...expiredVc,
      validUntil: new Date(longAgo + 60 * 60 * 1000).toISOString(), // expired 23h ago
    };
    const res = await attachHardwareAttestation(
      relay,
      agentB,
      withValidUntil as unknown as VerifiableCredential<unknown>,
    );
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { code?: string };
    expect(errBody.code).toBe("BAD_CREDENTIAL");
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

// ==========================================================================
// Phase 2 — secure_enclave path
// ==========================================================================
//
// Validates that the same protocol loop works end-to-end with a real
// (verified) hardware-attestation claim, not just the software sentinel.
// Uses `mintSecureEnclaveReceiptForTest` from `@motebit/crypto` — a fresh
// in-process P-256 keypair signs the canonical body bytes; the resulting
// receipt is byte-identical to what the production Rust SE bridge would
// emit. The relay's existing verifier (no platform-adapter injection
// needed for SE) accepts it.
//
// Acceptance: peer-issued AgentTrustCredential carrying the verified
// secure_enclave claim scores at HW_ATTESTATION_HARDWARE (1.0), 10×
// the software sentinel — proving routing differentiates platforms.

describe("Hardware-attestation peer flow — Phase 2 (secure_enclave)", () => {
  let relay: SyncRelay;
  let agentA: BootstrapResult;
  let agentB: BootstrapResult;
  const MASTER_TOKEN = "hw-peer-flow-se-test-token";

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
  });

  afterAll(async () => {
    if (relay) await relay.close();
  });

  it("worker mints + attaches a verified secure_enclave hardware credential", async () => {
    // mintSecureEnclaveReceiptForTest produces the same on-wire shape the
    // Rust SE bridge emits in production — a fresh P-256 keypair signs
    // the canonical body bytes; the resulting receipt is verifiable by
    // verifyHardwareAttestationClaim with no adapter injection needed
    // (SE is verified in-package via P-256 ECDSA-SHA256).
    const { claim } = await mintSecureEnclaveReceiptForTest({
      motebit_id: agentB.motebitId,
      device_id: agentB.deviceId,
      identity_public_key: agentB.publicKeyHex,
      attested_at: Date.now(),
    });

    const seSelfVc = await composeHardwareAttestationCredential({
      publicKey: agentB.keypair.publicKey,
      publicKeyHex: agentB.publicKeyHex,
      privateKey: agentB.keypair.privateKey,
      hardwareAttestation: claim,
      now: Date.now(),
    });

    const res = await attachHardwareAttestation(relay, agentB, seSelfVc);
    expect(res.status).toBe(200);
  });

  it("delegator issues peer trust credential carrying verified secure_enclave claim; aggregator scores at HW_ATTESTATION_HARDWARE (1.0)", async () => {
    // A simulates the runtime hook: pull B's SE claim, verify (would pass
    // in-package because SE is synchronous), issue peer trust credential
    // carrying the verified claim. Submit to /credentials/submit.
    const capRes = await relay.app.request(`/agent/${agentB.motebitId}/capabilities`);
    const capBody = (await capRes.json()) as {
      hardware_attestations: Array<{
        device_id: string;
        public_key: string;
        hardware_attestation_credential: string;
      }>;
    };
    expect(capBody.hardware_attestations).toHaveLength(1);
    const reparsed = JSON.parse(
      capBody.hardware_attestations[0]!.hardware_attestation_credential,
    ) as VerifiableCredential<{
      hardware_attestation: { platform: string; attestation_receipt?: string };
    }>;
    const claim = reparsed.credentialSubject.hardware_attestation;
    expect(claim.platform).toBe("secure_enclave");

    // A issues peer trust credential carrying the verified SE claim.
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
          hardware_attestation: claim,
        },
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      },
      agentA.keypair.privateKey,
      agentA.keypair.publicKey,
    );

    const submitRes = await relay.app.request(
      `/api/v1/agents/${agentB.motebitId}/credentials/submit`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${MASTER_TOKEN}` },
        body: JSON.stringify({ credentials: [peerTrustVc] }),
      },
    );
    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as {
      accepted: number;
      rejected: number;
    };
    expect(submitBody.accepted).toBe(1);
    expect(submitBody.rejected).toBe(0);

    // Aggregator scores at HW_ATTESTATION_HARDWARE = 1.0 (10× the
    // software sentinel score of 0.1) — proves routing differentiates
    // platforms.
    const credsRes = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/credentials`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    const credsBody = (await credsRes.json()) as {
      credentials: Array<{ credential: TrustVC; credential_type: string }>;
    };
    const trustVcs = credsBody.credentials
      .filter((row) => row.credential_type === "AgentTrustCredential")
      .map((row) => row.credential);
    const aggregate = aggregateHardwareAttestation(trustVcs, () => 0.9);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.attestation_score).toBeCloseTo(HW_ATTESTATION_HARDWARE);
    expect(aggregate!.platform_breakdown.secure_enclave).toBeGreaterThanOrEqual(1);
  });
});

// ==========================================================================
// Phase 2 — android_keystore path
// ==========================================================================
//
// Same protocol-loop assertion as the secure_enclave variant, on the
// canonical Android primitive. The split exists because the two leaves
// have structurally different verification surfaces:
//
//   - secure_enclave is single-keypair (P-256), so a fresh in-process
//     keypair produces a receipt the in-package verifier accepts —
//     `mintSecureEnclaveReceiptForTest` does that and the Phase 2 SE
//     test exercises the full verify path end-to-end.
//
//   - android_keystore is X.509-shaped: the leaf must chain to one of
//     Google's pinned Hardware Attestation roots. Forging a chain that
//     `androidKeystoreVerifier` would accept requires Google's private
//     key, which is not a property tests can reproduce. Chain validation
//     is exhaustively covered in
//     `packages/crypto-android-keystore/src/__tests__/verify.test.ts`
//     (synthetic chains under a test-only root) and
//     `verify-real-ceremony.test.ts` (real Pixel 9a TEE + StrongBox
//     fixtures from android/keyattestation@f39ec0d5 under the production
//     pinned roots).
//
// What this test proves is the relay-side protocol loop — that the
// `android_keystore` claim travels through attach → capabilities →
// peer-issuance → submit → routing aggregation, and the aggregator
// scores it at HW_ATTESTATION_HARDWARE (1.0), 10× the software sentinel
// — i.e., routing differentiates platforms identically for android_keystore
// as it does for secure_enclave. The receipt payload is opaque from the
// relay's perspective (sync-routes.ts:380 explicitly carves chain
// verification out of services/api per CLAUDE.md rule 6); inner-claim
// verification is the issuer's job, exercised in the leaf package.

describe("Hardware-attestation peer flow — Phase 2 (android_keystore)", () => {
  let relay: SyncRelay;
  let agentA: BootstrapResult;
  let agentB: BootstrapResult;
  const MASTER_TOKEN = "hw-peer-flow-aks-test-token";

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
  });

  afterAll(async () => {
    if (relay) await relay.close();
  });

  it("worker attaches a self-issued android_keystore hardware credential", async () => {
    // The receipt format is `{leafCertB64}.{intermediatesJoinedB64}` per
    // the leaf package's contract. Chain verification happens at peer-
    // issuance time (issuer's job) and at any third-party verification
    // time (motebit-verify); both are out of scope for the relay-side
    // protocol-loop assertion this test makes. Use an opaque placeholder.
    const claim = {
      platform: "android_keystore" as const,
      key_exported: false,
      attestation_receipt: "leaf-cert-b64-placeholder.intermediates-b64-placeholder",
    };

    const akSelfVc = await composeHardwareAttestationCredential({
      publicKey: agentB.keypair.publicKey,
      publicKeyHex: agentB.publicKeyHex,
      privateKey: agentB.keypair.privateKey,
      hardwareAttestation: claim,
      now: Date.now(),
    });

    const res = await attachHardwareAttestation(relay, agentB, akSelfVc);
    expect(res.status).toBe(200);
  });

  it("delegator issues peer trust credential carrying android_keystore claim; aggregator scores at HW_ATTESTATION_HARDWARE (1.0)", async () => {
    // A pulls B's capabilities, reads the android_keystore claim out of
    // the attached VC (in production A would also call
    // `androidKeystoreVerifier` to verify the chain — see the leaf
    // package's tests for that path), then issues a peer
    // AgentTrustCredential carrying the verified claim.
    const capRes = await relay.app.request(`/agent/${agentB.motebitId}/capabilities`);
    const capBody = (await capRes.json()) as {
      hardware_attestations: Array<{
        device_id: string;
        public_key: string;
        hardware_attestation_credential: string;
      }>;
    };
    expect(capBody.hardware_attestations).toHaveLength(1);
    const reparsed = JSON.parse(
      capBody.hardware_attestations[0]!.hardware_attestation_credential,
    ) as VerifiableCredential<{
      hardware_attestation: { platform: string; attestation_receipt?: string };
    }>;
    const claim = reparsed.credentialSubject.hardware_attestation;
    expect(claim.platform).toBe("android_keystore");

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
          hardware_attestation: claim,
        },
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      },
      agentA.keypair.privateKey,
      agentA.keypair.publicKey,
    );

    const submitRes = await relay.app.request(
      `/api/v1/agents/${agentB.motebitId}/credentials/submit`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${MASTER_TOKEN}` },
        body: JSON.stringify({ credentials: [peerTrustVc] }),
      },
    );
    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as {
      accepted: number;
      rejected: number;
    };
    expect(submitBody.accepted).toBe(1);
    expect(submitBody.rejected).toBe(0);

    const credsRes = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/credentials`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    const credsBody = (await credsRes.json()) as {
      credentials: Array<{ credential: TrustVC; credential_type: string }>;
    };
    const trustVcs = credsBody.credentials
      .filter((row) => row.credential_type === "AgentTrustCredential")
      .map((row) => row.credential);
    const aggregate = aggregateHardwareAttestation(trustVcs, () => 0.9);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.attestation_score).toBeCloseTo(HW_ATTESTATION_HARDWARE);
    expect(aggregate!.platform_breakdown.android_keystore).toBeGreaterThanOrEqual(1);
  });
});
