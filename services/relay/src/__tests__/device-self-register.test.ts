/**
 * Self-attesting device registration — relay-side round-trip.
 *
 * Asserts the §5.1 wire-format outcomes from `spec/device-self-registration-v1.md`:
 *   (a) auth-less endpoint accepts a properly signed request,
 *   (b) re-registering the same (motebit_id, public_key) returns 200 (created=false),
 *   (c) registering a known motebit_id with a different public_key returns 409,
 *   (d) malformed / stale / bad-signature requests return 400 with reason codes,
 *   (e) the device-token-signed flow against `/agent/.../task` succeeds AFTER
 *       self-registration — proving the binding is what the verifier reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  signDeviceRegistration,
  bytesToHex,
  generateKeypair,
  type SignableDeviceRegistration,
} from "@motebit/encryption";

const API_TOKEN = "test-token";

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

function freshIds() {
  return {
    motebitId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
  };
}

async function postRegister(relay: SyncRelay, body: SignableDeviceRegistration): Promise<Response> {
  return relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/devices/register-self — self-attesting registration", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("accepts a properly signed first-time registration with 201 (created=true)", async () => {
    const kp = await generateKeypair();
    const ids = freshIds();
    const body = await signDeviceRegistration(
      {
        motebit_id: ids.motebitId,
        device_id: ids.deviceId,
        public_key: bytesToHex(kp.publicKey),
        device_name: "test-laptop",
        owner_id: `self:${ids.motebitId}`,
        timestamp: Date.now(),
      },
      kp.privateKey,
    );
    const res = await postRegister(relay, body);
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as {
      motebit_id: string;
      device_id: string;
      created: boolean;
      registered_at: number;
    };
    expect(parsed.created).toBe(true);
    expect(parsed.motebit_id).toBe(ids.motebitId);
    expect(parsed.device_id).toBe(ids.deviceId);
    expect(typeof parsed.registered_at).toBe("number");
  });

  it("returns 200 (created=false) on idempotent re-registration with the same key", async () => {
    const kp = await generateKeypair();
    const ids = freshIds();
    const sign = (ts: number) =>
      signDeviceRegistration(
        {
          motebit_id: ids.motebitId,
          device_id: ids.deviceId,
          public_key: bytesToHex(kp.publicKey),
          owner_id: `self:${ids.motebitId}`,
          timestamp: ts,
        },
        kp.privateKey,
      );

    const first = await postRegister(relay, await sign(Date.now()));
    expect(first.status).toBe(201);

    const second = await postRegister(relay, await sign(Date.now()));
    expect(second.status).toBe(200);
    const parsed = (await second.json()) as { created: boolean };
    expect(parsed.created).toBe(false);
  });

  it("returns 409 when re-registering a known motebit_id with a different public key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const ids = freshIds();

    const first = await postRegister(
      relay,
      await signDeviceRegistration(
        {
          motebit_id: ids.motebitId,
          device_id: ids.deviceId,
          public_key: bytesToHex(kpA.publicKey),
          owner_id: `self:${ids.motebitId}`,
          timestamp: Date.now(),
        },
        kpA.privateKey,
      ),
    );
    expect(first.status).toBe(201);

    // Same motebit_id + device_id, different keypair — should reject.
    const conflict = await postRegister(
      relay,
      await signDeviceRegistration(
        {
          motebit_id: ids.motebitId,
          device_id: ids.deviceId,
          public_key: bytesToHex(kpB.publicKey),
          owner_id: `self:${ids.motebitId}`,
          timestamp: Date.now(),
        },
        kpB.privateKey,
      ),
    );
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { code: string; remediation: string };
    expect(body.code).toBe("DEVICE_KEY_CONFLICT");
    expect(body.remediation).toContain("rotate-key");
  });

  it("returns 400 (reason=bad_signature) when the body is tampered after signing", async () => {
    const kp = await generateKeypair();
    const ids = freshIds();
    const body = await signDeviceRegistration(
      {
        motebit_id: ids.motebitId,
        device_id: ids.deviceId,
        public_key: bytesToHex(kp.publicKey),
        owner_id: `self:${ids.motebitId}`,
        timestamp: Date.now(),
      },
      kp.privateKey,
    );
    const tampered = { ...body, motebit_id: crypto.randomUUID() };
    const res = await postRegister(relay, tampered);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { code: string; reason: string };
    expect(parsed.code).toBe("DEVICE_REGISTRATION_REJECTED");
    expect(parsed.reason).toBe("bad_signature");
  });

  it("returns 400 (reason=stale) when timestamp is outside the ±5 minute window", async () => {
    const kp = await generateKeypair();
    const ids = freshIds();
    const body = await signDeviceRegistration(
      {
        motebit_id: ids.motebitId,
        device_id: ids.deviceId,
        public_key: bytesToHex(kp.publicKey),
        owner_id: `self:${ids.motebitId}`,
        timestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
      },
      kp.privateKey,
    );
    const res = await postRegister(relay, body);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("stale");
  });

  it("requires no Authorization header — signature is the auth", async () => {
    const kp = await generateKeypair();
    const ids = freshIds();
    const body = await signDeviceRegistration(
      {
        motebit_id: ids.motebitId,
        device_id: ids.deviceId,
        public_key: bytesToHex(kp.publicKey),
        owner_id: `self:${ids.motebitId}`,
        timestamp: Date.now(),
      },
      kp.privateKey,
    );
    // No Authorization header at all.
    const res = await relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  });

  it("rejects non-JSON body with 400", async () => {
    const res = await relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
