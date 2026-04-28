#!/usr/bin/env tsx
/**
 * Live round-trip test for the hardware-attestation peer flow Phase 1.
 *
 * Sibling to `services/relay/src/__tests__/hardware-peer-flow-e2e.test.ts`
 * — same protocol loop, but executed against a real relay subprocess
 * over HTTP. Catches deployment/CI surface issues the in-memory test
 * cannot: route registration, content-type handling, JSON serialization
 * edges, real network framing.
 *
 * Per `lesson_hardware_attestation_self_issued_dead_drop.md`: every
 * relay response is body-inspected (the `accepted/rejected/errors`
 * fields), never trusted on `response.ok` alone. The relay returns
 * HTTP 200 even when every credential in a batch was rejected.
 *
 * Workspace-aware (uses `@motebit/encryption` via tsx). Different
 * category from `scripts/test-federation-live.mjs`, which is
 * pure-Node-zero-deps because it targets deployed production relays;
 * this script boots a local relay subprocess and is run from the
 * workspace.
 *
 * Usage:
 *   npx tsx scripts/test-hardware-peer-loop-live.ts
 *
 * Optional environment:
 *   PORT          Override the relay's port (default 3199, same as
 *                 python-conformance to share boot recipe)
 *   RELAY_URL     Skip subprocess management, target an already-running
 *                 relay at this URL (useful when iterating)
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more assertions failed (the printed report names them)
 *   2  could not boot or reach the relay
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  bytesToHex,
  canonicalJson,
  composeHardwareAttestationCredential,
  generateKeypair,
  hexPublicKeyToDidKey,
  signDeviceRegistration,
  signVerifiableCredential,
  toBase64Url,
} from "@motebit/encryption";
import type { KeyPair, VerifiableCredential } from "@motebit/encryption";
import { signBySuite } from "@motebit/crypto";

// ── Config ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? "3199";
const RELAY_URL = process.env.RELAY_URL ?? `http://localhost:${PORT}`;
const MASTER_TOKEN = "hw-peer-live-test-token";
const SHOULD_BOOT = !process.env.RELAY_URL;

// ── Logging ────────────────────────────────────────────────────────────

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;

function header(name: string): void {
  console.log(`\n${C.yellow}▸ ${name}${C.reset}`);
}

function step(label: string): void {
  process.stdout.write(`  ${C.dim}${label}${C.reset} ... `);
}

function pass(): void {
  passed++;
  console.log(`${C.green}PASS${C.reset}`);
}

function fail(reason: string): void {
  failed++;
  console.log(`${C.red}FAIL${C.reset} ${reason}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  step(label);
  if (actual === expected) pass();
  else fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTruthy(value: unknown, label: string): void {
  step(label);
  if (value) pass();
  else fail(`expected truthy, got ${JSON.stringify(value)}`);
}

// ── Relay subprocess management ────────────────────────────────────────

let relayProc: ChildProcess | null = null;

async function bootRelay(): Promise<void> {
  if (!SHOULD_BOOT) {
    console.log(`Targeting external relay at ${RELAY_URL} (RELAY_URL set)`);
    return;
  }
  const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..");
  const serverPath = resolve(repoRoot, "services/relay/src/server.ts");

  console.log(`Booting relay subprocess: tsx ${serverPath} (port ${PORT})`);
  relayProc = spawn("npx", ["tsx", serverPath], {
    env: {
      ...process.env,
      PORT,
      X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000000",
      NODE_ENV: "development",
      MOTEBIT_DB_PATH: ":memory:",
      MOTEBIT_API_TOKEN: MASTER_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  relayProc.stdout?.on("data", () => {});
  relayProc.stderr?.on("data", () => {});

  // Wait up to 30s for /health
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${RELAY_URL}/health`);
      if (res.ok) return;
    } catch {
      // keep retrying
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("relay never became healthy in 30s");
}

function teardownRelay(): void {
  if (relayProc && relayProc.pid != null) {
    try {
      process.kill(relayProc.pid);
    } catch {
      // ignore
    }
  }
}

// ── Test helpers ───────────────────────────────────────────────────────

interface BootstrapResult {
  motebitId: string;
  deviceId: string;
  keypair: KeyPair;
  publicKeyHex: string;
}

async function registerDevice(): Promise<BootstrapResult> {
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
  const res = await fetch(`${RELAY_URL}/api/v1/devices/register-self`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register-self failed: HTTP ${res.status}`);
  }
  return { motebitId, deviceId, keypair, publicKeyHex };
}

async function attachHardwareAttestation(
  agent: BootstrapResult,
  vc: VerifiableCredential<unknown>,
): Promise<Response> {
  const body = {
    motebit_id: agent.motebitId,
    device_id: agent.deviceId,
    hardware_attestation_credential: JSON.stringify(vc),
    timestamp: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const messageBytes = new TextEncoder().encode(canonicalJson(body));
  const sigBytes = await signBySuite(
    "motebit-jcs-ed25519-b64-v1",
    messageBytes,
    agent.keypair.privateKey,
  );
  const signed = { ...body, signature: toBase64Url(sigBytes) };
  return fetch(
    `${RELAY_URL}/api/v1/agents/${agent.motebitId}/devices/${agent.deviceId}/hardware-attestation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    },
  );
}

async function issuePeerTrustCredential(
  issuer: BootstrapResult,
  subject: BootstrapResult,
): Promise<VerifiableCredential<unknown>> {
  const subjectDid = hexPublicKeyToDidKey(subject.publicKeyHex);
  const issuerDid = hexPublicKeyToDidKey(issuer.publicKeyHex);
  const now = new Date();
  return signVerifiableCredential(
    {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://motebit.com/ns/credentials/v1"],
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
        hardware_attestation: { platform: "software", key_exported: false },
      },
      validFrom: now.toISOString(),
      validUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    },
    issuer.keypair.privateKey,
    issuer.keypair.publicKey,
  );
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${C.cyan}Hardware-attestation peer flow — live round-trip${C.reset}`);
  try {
    await bootRelay();
  } catch (err) {
    console.error((err as Error).message);
    teardownRelay();
    process.exit(2);
  }

  let agentA: BootstrapResult;
  let agentB: BootstrapResult;
  let bSelfHardwareVc: VerifiableCredential<unknown>;

  try {
    header("Bootstrap two agents (A delegator, B worker)");
    agentA = await registerDevice();
    pass();
    agentB = await registerDevice();
    pass();

    header("Worker B composes self-issued hardware-attestation credential");
    bSelfHardwareVc = await composeHardwareAttestationCredential({
      publicKey: agentB.keypair.publicKey,
      publicKeyHex: agentB.publicKeyHex,
      privateKey: agentB.keypair.privateKey,
      hardwareAttestation: { platform: "software", key_exported: false },
      now: Date.now(),
    });
    assertEqual(
      bSelfHardwareVc.issuer,
      hexPublicKeyToDidKey(agentB.publicKeyHex),
      "issuer matches B's identity key",
    );

    header("Worker B attaches credential to its device record");
    {
      const res = await attachHardwareAttestation(agentB, bSelfHardwareVc);
      assertEqual(res.status, 200, "attach endpoint returns 200");
      const body = (await res.json()) as { motebit_id?: string; device_id?: string };
      assertEqual(body.motebit_id, agentB.motebitId, "response motebit_id matches");
      assertEqual(body.device_id, agentB.deviceId, "response device_id matches");
    }

    header("Delegator A pulls B's capabilities via /agent/:id/capabilities");
    {
      const res = await fetch(`${RELAY_URL}/agent/${agentB.motebitId}/capabilities`);
      assertEqual(res.status, 200, "capabilities endpoint returns 200");
      const body = (await res.json()) as {
        hardware_attestations?: Array<{
          device_id: string;
          public_key: string;
          hardware_attestation_credential: string;
        }>;
      };
      assertTruthy(body.hardware_attestations, "response carries hardware_attestations array");
      assertEqual(body.hardware_attestations?.length, 1, "exactly one attestation");
      const attestation = body.hardware_attestations?.[0];
      assertEqual(attestation?.device_id, agentB.deviceId, "device_id matches");
      assertEqual(attestation?.public_key, agentB.publicKeyHex, "public_key matches");
      const reparsed = JSON.parse(
        attestation!.hardware_attestation_credential,
      ) as VerifiableCredential<{ hardware_attestation: { platform: string } }>;
      assertEqual(
        reparsed.credentialSubject.hardware_attestation.platform,
        "software",
        "embedded claim platform is 'software'",
      );
    }

    header("Delegator A issues peer AgentTrustCredential, submits via /credentials/submit");
    {
      const peerTrustVc = await issuePeerTrustCredential(agentA, agentB);
      const res = await fetch(`${RELAY_URL}/api/v1/agents/${agentB.motebitId}/credentials/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_TOKEN}`,
        },
        body: JSON.stringify({ credentials: [peerTrustVc] }),
      });
      assertEqual(res.status, 200, "credentials/submit returns 200");
      const body = (await res.json()) as {
        accepted: number;
        rejected: number;
        errors?: string[];
      };
      // BODY assertions per dead-drop lesson — never trust response.ok alone.
      assertEqual(body.accepted, 1, "body.accepted === 1 (peer credential accepted)");
      assertEqual(body.rejected, 0, "body.rejected === 0");
    }

    header("Doctrine lock: /credentials/submit STILL rejects self-issued");
    {
      const res = await fetch(`${RELAY_URL}/api/v1/agents/${agentB.motebitId}/credentials/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_TOKEN}`,
        },
        body: JSON.stringify({ credentials: [bSelfHardwareVc] }),
      });
      assertEqual(res.status, 200, "credentials/submit returns 200 (per spec)");
      const body = (await res.json()) as {
        accepted: number;
        rejected: number;
        errors?: string[];
      };
      // The 200-with-rejected-body is the EXACT failure shape the dead-drop
      // lesson warned about. Asserting on body.rejected, not response.ok.
      assertEqual(body.accepted, 0, "body.accepted === 0 (self-issued NOT accepted)");
      assertEqual(body.rejected, 1, "body.rejected === 1");
      assertTruthy(
        body.errors?.includes("self-issued credential rejected"),
        "errors lists 'self-issued credential rejected'",
      );
    }

    console.log(`\n${passed} ${C.green}passed${C.reset}, ${failed} ${C.red}failed${C.reset}`);
    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    teardownRelay();
  }
}

process.on("SIGINT", () => {
  teardownRelay();
  process.exit(130);
});

void main();
