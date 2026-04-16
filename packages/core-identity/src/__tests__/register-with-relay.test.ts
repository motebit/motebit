/**
 * registerDeviceWithRelay — §5.1 outcome mapping from
 * `spec/device-self-registration-v1.md`. Covers every branch of the
 * status → error-code classifier plus the idempotent success path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerDeviceWithRelay } from "../register-with-relay.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";

let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
let baseParams: {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  privateKey: Uint8Array;
  syncUrl: string;
};

beforeEach(async () => {
  keypair = await generateKeypair();
  baseParams = {
    motebitId: "mote-test",
    deviceId: "dev-1",
    publicKey: bytesToHex(keypair.publicKey),
    privateKey: keypair.privateKey,
    syncUrl: "http://relay.test",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responder: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responder()),
  );
}

describe("registerDeviceWithRelay", () => {
  it("returns ok with created=true on 201", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            motebit_id: "mote-test",
            device_id: "dev-1",
            registered_at: 1_700_000_000_000,
            created: true,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(true);
      expect(r.registered_at).toBe(1_700_000_000_000);
    }
  });

  it("returns ok with created=false on 200 (idempotent re-register)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            motebit_id: "mote-test",
            device_id: "dev-1",
            registered_at: 1_700_000_000_001,
            created: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toBe(false);
  });

  it("returns unknown when the success body is non-JSON", async () => {
    mockFetch(() => new Response("not-json", { status: 200 }));
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unknown");
      expect(r.status).toBe(200);
    }
  });

  it("returns network_unreachable when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("network_unreachable");
      expect(r.message).toContain("ECONNREFUSED");
    }
  });

  it("returns key_conflict on 409", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "key mismatch" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("key_conflict");
      expect(r.status).toBe(409);
      expect(r.message).toBe("key mismatch");
    }
  });

  it("returns rate_limited on 429", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ reason: "too_many" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rate_limited");
      expect(r.message).toBe("too_many");
    }
  });

  it("returns rejected on 400 with reason code", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ code: "BAD_SIG", reason: "bad_signature" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rejected");
      expect(r.message).toBe("bad_signature");
    }
  });

  it("returns unknown with status for 5xx responses", async () => {
    mockFetch(() => new Response("server broke", { status: 503 }));
    const r = await registerDeviceWithRelay(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unknown");
      expect(r.status).toBe(503);
      expect(r.message).toContain("server broke");
    }
  });

  it("uses self-owner default when ownerId is omitted", async () => {
    let captured: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            motebit_id: "mote-test",
            device_id: "dev-1",
            registered_at: 1,
            created: true,
          }),
          { status: 201 },
        );
      }),
    );
    await registerDeviceWithRelay(baseParams);
    expect(captured).toMatchObject({ owner_id: "self:mote-test" });
  });

  it("honors an explicit ownerId when provided", async () => {
    let captured: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            motebit_id: "mote-test",
            device_id: "dev-1",
            registered_at: 1,
            created: true,
          }),
          { status: 201 },
        );
      }),
    );
    await registerDeviceWithRelay({ ...baseParams, ownerId: "user:alice", deviceName: "Laptop" });
    expect(captured).toMatchObject({ owner_id: "user:alice", device_name: "Laptop" });
  });
});
