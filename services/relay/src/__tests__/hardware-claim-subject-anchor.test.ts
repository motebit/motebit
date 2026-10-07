/**
 * A hardware-attestation claim about S is admitted only when S published it.
 *
 * `/credentials/submit` is public — the issuer's signature is the auth — and
 * it checked the issuer's signature, issuer ≠ subject, and that the path is
 * the subject. It never looked at the `hardware_attestation` claim inside. So
 * anyone with a throwaway keypair could issue an `AgentTrustCredential` about
 * a victim carrying `platform: "secure_enclave"`, submit it without auth, and
 * `/agents/discover` (and the routing aggregate) showed the victim as
 * hardware-attested — inflated rank on a scoring dimension.
 *
 * A `secure_enclave` receipt has no vendor chain: anyone can mint a P-256
 * receipt naming the victim's identity key, so verifying the receipt alone
 * cannot close this. The anchor is the subject itself: the legitimate peer
 * flow (runtime `agent-trust.ts`) re-issues the claim S attached to its OWN
 * device record — a publication signed under S's device key
 * (`POST …/devices/:deviceId/hardware-attestation`). A peer claim must be one
 * of S's published claims, and a claim the relay can verify in-package must
 * verify against that device's key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay, AUTH_HEADER } from "./test-helpers.js";
import {
  generateKeypair,
  signDeviceRegistration,
  composeHardwareAttestationCredential,
  canonicalJson,
  toBase64Url,
  signVerifiableCredential,
  hexPublicKeyToDidKey,
  bytesToHex,
  deriveSovereignMotebitId,
} from "@motebit/encryption";
import type { KeyPair, VerifiableCredential } from "@motebit/encryption";
import { signBySuite, mintSecureEnclaveReceiptForTest } from "@motebit/crypto";
import type { HardwareAttestationClaim } from "@motebit/protocol";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Agent {
  motebitId: string;
  deviceId: string;
  keypair: KeyPair;
  publicKeyHex: string;
}

async function registerSelf(relay: SyncRelay): Promise<Agent> {
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);
  const motebitId = await deriveSovereignMotebitId(publicKeyHex);
  const deviceId = crypto.randomUUID();
  const body = await signDeviceRegistration(
    { motebit_id: motebitId, device_id: deviceId, public_key: publicKeyHex, timestamp: Date.now() },
    keypair.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  expect([200, 201]).toContain(res.status);
  // Listed, so /agents/discover shows it.
  const reg = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
  expect(reg.status).toBe(200);
  return { motebitId, deviceId, keypair, publicKeyHex };
}

async function attach(relay: SyncRelay, agent: Agent, claim: HardwareAttestationClaim) {
  const vc = await composeHardwareAttestationCredential({
    publicKey: agent.keypair.publicKey,
    publicKeyHex: agent.publicKeyHex,
    privateKey: agent.keypair.privateKey,
    hardwareAttestation: claim,
    now: Date.now(),
  });
  const body = {
    motebit_id: agent.motebitId,
    device_id: agent.deviceId,
    hardware_attestation_credential: JSON.stringify(vc),
    timestamp: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const sig = await signBySuite(
    "motebit-jcs-ed25519-b64-v1",
    new TextEncoder().encode(canonicalJson(body)),
    agent.keypair.privateKey,
  );
  const res = await relay.app.request(
    `/api/v1/agents/${agent.motebitId}/devices/${agent.deviceId}/hardware-attestation`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, signature: toBase64Url(sig) }),
    },
  );
  expect(res.status).toBe(200);
}

async function peerCredential(
  issuer: { privateKey: Uint8Array; publicKey: Uint8Array },
  subject: Agent,
  claim: HardwareAttestationClaim,
): Promise<VerifiableCredential<unknown>> {
  const now = new Date();
  return signVerifiableCredential(
    {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://motebit.com/ns/credentials/v1"],
      type: ["VerifiableCredential", "AgentTrustCredential"],
      issuer: hexPublicKeyToDidKey(bytesToHex(issuer.publicKey)),
      credentialSubject: {
        id: hexPublicKeyToDidKey(subject.publicKeyHex),
        trust_level: "Verified",
        interaction_count: 1,
        successful_tasks: 1,
        failed_tasks: 0,
        first_seen_at: now.getTime() - 1000,
        last_seen_at: now.getTime(),
        hardware_attestation: claim,
      },
      validFrom: now.toISOString(),
      validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
    },
    issuer.privateKey,
    issuer.publicKey,
  ) as Promise<VerifiableCredential<unknown>>;
}

/** No Authorization header — the route is public. */
async function submit(relay: SyncRelay, subject: Agent, vc: VerifiableCredential<unknown>) {
  const res = await relay.app.request(`/api/v1/agents/${subject.motebitId}/credentials/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ credentials: [vc] }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { accepted: number; rejected: number; errors?: string[] };
}

async function discovered(relay: SyncRelay, motebitId: string) {
  const res = await relay.app.request("/api/v1/agents/discover");
  const { agents } = (await res.json()) as {
    agents: Array<{ motebit_id: string; hardware_attestation?: { platform: string } }>;
  };
  return agents.find((a) => a.motebit_id === motebitId);
}

describe("hardware-attestation claims are anchored to the subject's own publication", () => {
  let relay: SyncRelay;
  let victim: Agent;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true });
    victim = await registerSelf(relay);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("refuses a stranger's secure_enclave claim about a victim who published none", async () => {
    const attacker = await generateKeypair();
    // The strongest forge: a receipt that VERIFIES against the victim's key.
    const { claim } = await mintSecureEnclaveReceiptForTest({
      motebit_id: victim.motebitId,
      device_id: "forged",
      identity_public_key: victim.publicKeyHex,
      attested_at: Date.now(),
    });
    const r = await submit(relay, victim, await peerCredential(attacker, victim, claim));
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(1);
    expect((await discovered(relay, victim.motebitId))?.hardware_attestation).toBeUndefined();
  });

  it("refuses an unverifiable platform claim with a garbage receipt", async () => {
    const attacker = await generateKeypair();
    const r = await submit(
      relay,
      victim,
      await peerCredential(attacker, victim, { platform: "tpm", attestation_receipt: "AAAA" }),
    );
    expect(r.accepted).toBe(0);
    expect((await discovered(relay, victim.motebitId))?.hardware_attestation).toBeUndefined();
  });

  it("refuses a claim that differs from the one the subject published", async () => {
    await attach(relay, victim, { platform: "software", key_exported: false });
    const attacker = await generateKeypair();
    const { claim } = await mintSecureEnclaveReceiptForTest({
      motebit_id: victim.motebitId,
      device_id: victim.deviceId,
      identity_public_key: victim.publicKeyHex,
      attested_at: Date.now(),
    });
    const r = await submit(relay, victim, await peerCredential(attacker, victim, claim));
    expect(r.accepted).toBe(0);
    expect((await discovered(relay, victim.motebitId))?.hardware_attestation).toBeUndefined();
  });

  it("admits a peer re-issuing the claim the subject published (the legitimate flow)", async () => {
    const { claim } = await mintSecureEnclaveReceiptForTest({
      motebit_id: victim.motebitId,
      device_id: victim.deviceId,
      identity_public_key: victim.publicKeyHex,
      attested_at: Date.now(),
    });
    await attach(relay, victim, claim);
    const peer = await generateKeypair();
    const r = await submit(relay, victim, await peerCredential(peer, victim, claim));
    expect(r.accepted).toBe(1);
    expect((await discovered(relay, victim.motebitId))?.hardware_attestation?.platform).toBe(
      "secure_enclave",
    );
  });

  it("still admits a credential with no hardware claim", async () => {
    const peer = await generateKeypair();
    const now = new Date();
    const vc = (await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "AgentTrustCredential"],
        issuer: hexPublicKeyToDidKey(bytesToHex(peer.publicKey)),
        credentialSubject: {
          id: hexPublicKeyToDidKey(victim.publicKeyHex),
          trust_level: "Verified",
          interaction_count: 1,
          successful_tasks: 1,
          failed_tasks: 0,
          first_seen_at: now.getTime() - 1000,
          last_seen_at: now.getTime(),
        },
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
      },
      peer.privateKey,
      peer.publicKey,
    )) as VerifiableCredential<unknown>;
    expect((await submit(relay, victim, vc)).accepted).toBe(1);
  });
});
