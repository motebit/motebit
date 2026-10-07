/**
 * #875 make-before-break — the client half ships before the relay enforces.
 *
 * Every client now sends a SIGNED `POST /api/v1/agents/bootstrap` (a
 * device-registration request: the unsigned fields plus `timestamp`, `suite`,
 * `signature`). These tests drive the signed bodies through the relay in this
 * tree: the key must land, and the signed bearer that follows must verify
 * under it.
 *
 * The last case pins the other half of the deploy order. The clients shipped
 * first (motebit@2.1.0, #1088); the relay in this tree now enforces, so the
 * UNSIGNED body the published `motebit@2.0.1` sends is refused with
 * `400 KEY_PROOF_REQUIRED` and a repair instruction, writing nothing.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-875-cfg-"));
});

import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  signDeviceRegistration,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { bootstrapReplDevice } from "../runtime-factory.js";
import {
  registerWithRelay,
  signedBootstrapBody,
  signedRelayHeaders,
} from "../relay-registration.js";

const MASTER = "test-token-875-compat";
const BASE = "http://relay.zz875.test";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay | undefined;
const fetchViaRelay = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return relay!.app.request(url.replace(BASE, ""), init);
}) as typeof globalThis.fetch;

afterEach(async () => {
  if (relay) await relay.close();
  relay = undefined;
});

async function startRelay(): Promise<void> {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
}

async function identity(): Promise<{ mid: string; deviceId: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  return { mid, deviceId: `${mid}-dev`, kp };
}

async function postBootstrap(body: string): Promise<Response> {
  return fetchViaRelay(`${BASE}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/** A signed `sync` call succeeds only when the relay holds the device's key. */
async function deviceKeyHeld(mid: string, deviceId: string, kp: KeyPair): Promise<boolean> {
  const resp = await fetchViaRelay(`${BASE}/api/v1/agents/heartbeat`, {
    method: "POST",
    headers: await signedRelayHeaders(
      { motebitId: mid, deviceId, privateKey: kp.privateKey },
      "admin:query",
    ),
    body: JSON.stringify({}),
  });
  return resp.status !== 401 && resp.status !== 403;
}

describe("#875 client half — signed bootstrap bodies are accepted by a relay that does not enforce yet", () => {
  it("signedBootstrapBody (CLI) is admitted, idempotently, and the key it names verifies the bearer after it", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    const id = { motebitId: mid, deviceId, publicKeyHex: hex(kp), privateKey: kp.privateKey };

    const signed = JSON.parse(await signedBootstrapBody(id)) as Record<string, unknown>;
    expect(signed).toMatchObject({ motebit_id: mid, device_id: deviceId, public_key: hex(kp) });
    expect(typeof signed["signature"]).toBe("string");
    expect(typeof signed["suite"]).toBe("string");
    expect(typeof signed["timestamp"]).toBe("number");

    const first = await postBootstrap(JSON.stringify(signed));
    expect(first.status).toBe(201);
    // A re-introduction (every REPL startup, the #962 push loop) stays admitted.
    const again = await postBootstrap(await signedBootstrapBody(id));
    expect(again.ok).toBe(true);
    expect(await deviceKeyHeld(mid, deviceId, kp)).toBe(true);
    // The probe discriminates: a key the relay was never introduced to is refused.
    expect(await deviceKeyHeld(mid, deviceId, await generateKeypair())).toBe(false);
  });

  it("registerWithRelay (daemon) bootstraps signed and registers under its own bearer", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    const statuses: Record<string, number> = {};
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      const resp = await fetchViaRelay(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      statuses[new URL(url).pathname] = resp.status;
      return resp;
    }) as typeof globalThis.fetch;

    const handle = await registerWithRelay({
      syncUrl: BASE,
      identity: { motebitId: mid, deviceId, publicKeyHex: hex(kp), privateKey: kp.privateKey },
      registration: {
        motebit_id: mid,
        endpoint_url: "http://worker.zz875.test/mcp",
        capabilities: ["echo"],
        metadata: { name: "compat-875" },
      },
      toolNames: ["echo"],
      description: "compat",
      log: () => {},
      fetchImpl: recording,
      env: {},
    });
    handle.stop();

    expect(statuses["/api/v1/agents/bootstrap"]).toBe(201);
    expect(statuses["/api/v1/agents/register"]).toBe(200);
    expect(handle.registered).toBe(true);
  });

  it("bootstrapReplDevice (REPL / run / serve / delegate / #962 push loop) is admitted", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    expect(
      await bootstrapReplDevice({
        syncUrl: BASE,
        motebitId: mid,
        deviceId,
        publicKeyHex: hex(kp),
        privateKey: kp.privateKey,
        fetchImpl: fetchViaRelay,
      }),
    ).toBeNull();
    expect(await deviceKeyHeld(mid, deviceId, kp)).toBe(true);
  });

  it("the mcp-server / molecule-runner / probe-delegator body (signDeviceRegistration over the bootstrap fields) is admitted", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    // Exactly what molecule-runner wires as `relayAuth.signRegistration` and
    // what the service posts as the bootstrap body.
    const signed = await signDeviceRegistration(
      { motebit_id: mid, device_id: deviceId, public_key: hex(kp), timestamp: Date.now() },
      kp.privateKey,
    );
    const resp = await postBootstrap(JSON.stringify(signed));
    expect(resp.status).toBe(201);
    expect(await deviceKeyHeld(mid, deviceId, kp)).toBe(true);
  });

  it("the published 2.0.1 CLI's UNSIGNED bootstrap is refused now that the relay enforces — 400 KEY_PROOF_REQUIRED, nothing written", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    const resp = await postBootstrap(
      JSON.stringify({ motebit_id: mid, device_id: deviceId, public_key: hex(kp) }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string; remediation: string };
    expect(body.code).toBe("KEY_PROOF_REQUIRED");
    expect(body.remediation).toMatch(/signDeviceRegistration/);
    expect(await deviceKeyHeld(mid, deviceId, kp)).toBe(false);
  });
});
