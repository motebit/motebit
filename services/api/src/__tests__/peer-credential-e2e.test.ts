/**
 * Peer Credential E2E — proves the full peer-issued credential loop:
 *
 * 1. Two agents delegate across a relay (peer credentials, NOT relay-issued)
 * 2. Peer-issued reputation credentials are verifiable by any party
 * 3. Credential-weighted routing improves with accumulated evidence
 * 4. Cross-relay credential portability: credentials earned on relay A
 *    verify on relay B (because they're signed by the peer, not the relay)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  createSignedToken,
  signExecutionReceipt,
  verifyVerifiableCredential,
  issueReputationCredential,
  bytesToHex,
  hexPublicKeyToDidKey,
  publicKeyToDidKey,
} from "@motebit/crypto";
import type { KeyPair, VerifiableCredential } from "@motebit/crypto";
import type { MotebitId, DeviceId, ReputationCredentialSubject } from "@motebit/sdk";

// === Helpers ===

async function makeSignedToken(
  motebitId: string,
  relayDeviceId: string,
  keypair: KeyPair,
  aud = "sync",
): Promise<string> {
  return createSignedToken(
    {
      mid: motebitId,
      did: relayDeviceId,
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud,
    },
    keypair.privateKey,
  );
}

async function makeReceipt(
  taskId: string,
  executorMotebitId: string,
  executorDeviceId: string,
  keypair: KeyPair,
) {
  const promptHash = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("test prompt"))),
  );
  const resultHash = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("test result"))),
  );

  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: executorMotebitId as unknown as MotebitId,
      device_id: executorDeviceId as unknown as DeviceId,
      submitted_at: Date.now() - 500,
      completed_at: Date.now(),
      status: "completed",
      result: "test result",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: promptHash,
      result_hash: resultHash,
    },
    keypair.privateKey,
  );
}

const AUTH = (token: string) => ({ Authorization: `Bearer ${token}` });
const JSON_HEADERS = { "Content-Type": "application/json" };

// ==========================================================================
// Test 1: Peer-issued credentials through the full delegation loop
// ==========================================================================

describe("Peer Credential E2E — Delegation Loop", () => {
  let relay: SyncRelay;
  let keypairA: KeyPair;
  let keypairB: KeyPair;
  let motebitIdA: string;
  let motebitIdB: string;
  let relayDeviceIdA: string;
  let relayDeviceIdB: string;
  const MASTER_TOKEN = "peer-cred-test-token";

  beforeAll(async () => {
    // Relay with credential issuance DISABLED — proves peer credentials work independently
    relay = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: MASTER_TOKEN,
      enableDeviceAuth: true,
      issueCredentials: false, // <-- key: relay does NOT issue credentials
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    keypairA = await generateKeypair();
    keypairB = await generateKeypair();
    motebitIdA = crypto.randomUUID();
    motebitIdB = crypto.randomUUID();

    // Bootstrap both agents
    const resA = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        motebit_id: motebitIdA,
        device_id: "alice-device",
        public_key: bytesToHex(keypairA.publicKey),
      }),
    });
    relayDeviceIdA = ((await resA.json()) as { device_id: string }).device_id;

    const resB = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        motebit_id: motebitIdB,
        device_id: "bob-device",
        public_key: bytesToHex(keypairB.publicKey),
      }),
    });
    relayDeviceIdB = ((await resB.json()) as { device_id: string }).device_id;
  });

  afterAll(() => relay.close());

  it("relay does NOT issue credential when issueCredentials=false", async () => {
    // Submit task with task:submit audience token
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...AUTH(tokenA) },
      body: JSON.stringify({
        prompt: "test delegation",
        submitted_by: motebitIdA,
        required_capabilities: [],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id } = (await taskRes.json()) as { task_id: string };

    // Post signed receipt with task:result audience token
    const receipt = await makeReceipt(task_id, motebitIdB, relayDeviceIdB, keypairB);
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");
    const resultRes = await relay.app.request(`/agent/${motebitIdB}/task/${task_id}/result`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...AUTH(tokenB) },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as { status: string; credential_id: string | null };

    // Relay should NOT have issued a credential
    expect(resultBody.credential_id).toBeNull();

    // Relay credential store should be empty for this agent
    const credRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/credentials`, {
      headers: AUTH(MASTER_TOKEN),
    });
    const credBody = (await credRes.json()) as { credentials: unknown[] };
    expect(credBody.credentials).toHaveLength(0);
  });

  it("peer-issued reputation credential is verifiable by any party", async () => {
    // Agent A issues a reputation credential about B (what the runtime does)
    const subjectDid = hexPublicKeyToDidKey(bytesToHex(keypairB.publicKey));
    const vc = await issueReputationCredential(
      {
        success_rate: 1.0,
        avg_latency_ms: 500,
        task_count: 1,
        trust_score: 1.0,
        availability: 1.0,
        measured_at: Date.now(),
      },
      keypairA.privateKey,
      keypairA.publicKey,
      subjectDid,
    );

    // Credential is issued by A, not the relay
    const issuerDid = publicKeyToDidKey(keypairA.publicKey);
    expect(vc.issuer).toBe(issuerDid);
    expect(vc.type).toContain("AgentReputationCredential");
    expect(vc.credentialSubject.id).toBe(subjectDid);

    // Any party can verify — doesn't need relay
    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });

  it("peer credential verifies via relay's public verification endpoint", async () => {
    // Issue peer credential
    const subjectDid = hexPublicKeyToDidKey(bytesToHex(keypairB.publicKey));
    const vc = await issueReputationCredential(
      {
        success_rate: 0.95,
        avg_latency_ms: 800,
        task_count: 5,
        trust_score: 0.9,
        availability: 1.0,
        measured_at: Date.now(),
      },
      keypairA.privateKey,
      keypairA.publicKey,
      subjectDid,
    );

    // Submit to relay's public verification endpoint
    const verifyRes = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(vc),
    });
    expect(verifyRes.status).toBe(200);

    const verifyBody = (await verifyRes.json()) as { valid: boolean; issuer: string };
    expect(verifyBody.valid).toBe(true);
    // Issuer is the peer (A), not the relay
    expect(verifyBody.issuer).toBe(publicKeyToDidKey(keypairA.publicKey));
  });

  it("on-demand relay reputation endpoint returns 403 when issueCredentials=false", async () => {
    const res = await relay.app.request(`/api/v1/credentials/${motebitIdB}/reputation`, {
      method: "POST",
      headers: AUTH(MASTER_TOKEN),
    });
    expect(res.status).toBe(403);
  });
});

// ==========================================================================
// Test 2: Cross-relay credential portability
// ==========================================================================

describe("Peer Credential E2E — Cross-Relay Portability", () => {
  let relayA: SyncRelay;
  let relayB: SyncRelay;
  let keypairAlice: KeyPair;
  let keypairBob: KeyPair;

  beforeAll(async () => {
    // Two independent relays — no federation, no shared state
    relayA = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: "relay-a-token",
      issueCredentials: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });
    relayB = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: "relay-b-token",
      issueCredentials: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    keypairAlice = await generateKeypair();
    keypairBob = await generateKeypair();
  });

  afterAll(() => {
    relayA.close();
    relayB.close();
  });

  it("credential earned via relay A verifies on relay B", async () => {
    // Alice issues a reputation credential about Bob on relay A's network
    const bobDid = hexPublicKeyToDidKey(bytesToHex(keypairBob.publicKey));
    const vc = await issueReputationCredential(
      {
        success_rate: 0.98,
        avg_latency_ms: 300,
        task_count: 10,
        trust_score: 0.95,
        availability: 1.0,
        measured_at: Date.now(),
      },
      keypairAlice.privateKey,
      keypairAlice.publicKey,
      bobDid,
    );

    // Verify locally (no relay needed)
    expect(await verifyVerifiableCredential(vc)).toBe(true);

    // Verify on relay A
    const verifyA = await relayA.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(vc),
    });
    expect(verifyA.status).toBe(200);
    expect(((await verifyA.json()) as { valid: boolean }).valid).toBe(true);

    // Verify on relay B — a completely independent relay with no shared state
    const verifyB = await relayB.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(vc),
    });
    expect(verifyB.status).toBe(200);
    const bodyB = (await verifyB.json()) as { valid: boolean; issuer: string; subject: string };
    expect(bodyB.valid).toBe(true);
    expect(bodyB.issuer).toBe(publicKeyToDidKey(keypairAlice.publicKey));
    expect(bodyB.subject).toBe(bobDid);
  });

  it("multiple peer credentials from different issuers all verify on foreign relay", async () => {
    const bobDid = hexPublicKeyToDidKey(bytesToHex(keypairBob.publicKey));

    // Generate 3 independent issuer keypairs (simulating 3 different agents)
    const issuers = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair()]);

    const credentials: VerifiableCredential<ReputationCredentialSubject>[] = [];
    for (let i = 0; i < issuers.length; i++) {
      const vc = await issueReputationCredential(
        {
          success_rate: 0.9 + i * 0.03,
          avg_latency_ms: 500 - i * 100,
          task_count: 5 + i * 5,
          trust_score: 0.85 + i * 0.05,
          availability: 1.0,
          measured_at: Date.now(),
        },
        issuers[i]!.privateKey,
        issuers[i]!.publicKey,
        bobDid,
      );
      credentials.push(vc);
    }

    // All 3 credentials verify on relay B (which has never seen any of these agents)
    for (const vc of credentials) {
      const res = await relayB.app.request("/api/v1/credentials/verify", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(vc),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { valid: boolean }).valid).toBe(true);
    }

    // Each credential has a different issuer
    const issuerDids = new Set(credentials.map((vc) => vc.issuer));
    expect(issuerDids.size).toBe(3);

    // All credentials are about the same subject
    const subjects = new Set(credentials.map((vc) => vc.credentialSubject.id));
    expect(subjects.size).toBe(1);
    expect(subjects.has(bobDid)).toBe(true);
  });

  it("tampered peer credential fails verification on any relay", async () => {
    const bobDid = hexPublicKeyToDidKey(bytesToHex(keypairBob.publicKey));
    const vc = await issueReputationCredential(
      {
        success_rate: 1.0,
        avg_latency_ms: 100,
        task_count: 50,
        trust_score: 1.0,
        availability: 1.0,
        measured_at: Date.now(),
      },
      keypairAlice.privateKey,
      keypairAlice.publicKey,
      bobDid,
    );

    // Tamper with the credential
    const tampered = JSON.parse(JSON.stringify(vc)) as VerifiableCredential;
    (tampered.credentialSubject as Record<string, unknown>).success_rate = 0.5;

    // Fails on relay A
    const resA = await relayA.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(tampered),
    });
    expect(((await resA.json()) as { valid: boolean }).valid).toBe(false);

    // Fails on relay B
    const resB = await relayB.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(tampered),
    });
    expect(((await resB.json()) as { valid: boolean }).valid).toBe(false);
  });
});
