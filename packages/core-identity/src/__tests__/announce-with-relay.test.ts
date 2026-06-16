/**
 * announceMotebit — outcome mapping for the sovereign-funnel intake client.
 * Covers the sovereign-binding preflight (the doomed-round-trip skip), descriptor
 * discovery (audience binding), every status → error-code branch, and the
 * network-unreachable best-effort contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { announceMotebit } from "../announce-with-relay.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { deriveSovereignMotebitId } from "@motebit/crypto";

const RELAY_ID = "relay-sovereign-id-123";
// A legacy random id (version nibble 7) — never the sovereign commitment to any
// key. This is the exact shape of the 2026-06-15 production account that 400'd.
const LEGACY_V7_ID = "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb";

let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
let baseParams: {
  motebitId: string;
  publicKey: string;
  privateKey: Uint8Array;
  surface: "web";
  relayUrl: string;
};

beforeEach(async () => {
  keypair = await generateKeypair();
  const publicKey = bytesToHex(keypair.publicKey);
  baseParams = {
    // Sovereign-bound by construction: the id IS the commitment to this key, so
    // the preflight passes and the announce path is exercised. The fix made an
    // unbound id (the old "mote-test") a skip, not a fetch.
    motebitId: await deriveSovereignMotebitId(publicKey),
    publicKey,
    privateKey: keypair.privateKey,
    surface: "web",
    relayUrl: "http://relay.test",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Mock both legs: the `.well-known/motebit.json` descriptor GET and the
 * `/api/v1/motebits/announce` POST. `descriptor` defaults to a valid one
 * carrying RELAY_ID; pass `announce` to control the POST response and
 * `onAnnounceBody` to capture the signed body.
 */
function mockRelay(opts: {
  descriptor?: Response | (() => Response);
  announce: Response | (() => Response | Promise<Response>);
  onAnnounceBody?: (body: unknown) => void;
}): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/motebit.json")) {
      const d =
        opts.descriptor ??
        new Response(JSON.stringify({ relay_id: RELAY_ID }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return typeof d === "function" ? d() : d;
    }
    if (url.endsWith("/api/v1/motebits/announce")) {
      if (opts.onAnnounceBody && init?.body != null) {
        opts.onAnnounceBody(JSON.parse(init.body as string));
      }
      return typeof opts.announce === "function" ? opts.announce() : opts.announce;
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

describe("announceMotebit — sovereign-binding preflight (skip the doomed round-trip)", () => {
  it("a legacy UUIDv7 id → skipped, with NO network request", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const r = await announceMotebit({ ...baseParams, motebitId: LEGACY_V7_ID });

    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("identity_not_sovereign_bound");
    // The relay is never contacted — no descriptor GET, no announce POST.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an UNRELATED UUIDv8 (valid v8, wrong key) → skipped, with NO network request", async () => {
    // A version-nibble check would WRONGLY let this through (it is a v8); the
    // exact verifySovereignBinding catches that it does not commit to our key.
    const otherKeypair = await generateKeypair();
    const unrelatedV8 = await deriveSovereignMotebitId(bytesToHex(otherKeypair.publicKey));
    expect(unrelatedV8.split("-")[2]![0]).toBe("8"); // it really is a v8
    expect(unrelatedV8).not.toBe(baseParams.motebitId);

    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const r = await announceMotebit({ ...baseParams, motebitId: unrelatedV8 });

    expect(r.status).toBe("skipped");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a properly bound sovereign id → DOES make the announce POST", async () => {
    const fetchFn = mockRelay({
      announce: new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_000, first_seen: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    });

    const r = await announceMotebit(baseParams);

    expect(r.status).toBe("announced");
    // Both legs hit: descriptor GET + announce POST.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.some(([u]) => String(u).endsWith("/api/v1/motebits/announce"))).toBe(
      true,
    );
  });
});

describe("announceMotebit", () => {
  it("returns announced with first_seen=true on 201 and binds audience to the relay's id", async () => {
    let captured: { audience?: string; suite?: string; signature?: string } = {};
    mockRelay({
      announce: new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_000, first_seen: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
      onAnnounceBody: (b) => (captured = b as typeof captured),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("announced");
    if (r.status === "announced") {
      expect(r.first_seen).toBe(true);
      expect(r.announced_at).toBe(1_700_000_000_000);
    }
    // The signed announcement is bound to the relay's discovered id.
    expect(captured.audience).toBe(RELAY_ID);
    expect(captured.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(typeof captured.signature).toBe("string");
  });

  it("returns announced with first_seen=false on 200 (idempotent re-announce)", async () => {
    mockRelay({
      announce: new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_001, first_seen: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("announced");
    if (r.status === "announced") expect(r.first_seen).toBe(false);
  });

  it("returns failed/relay_identity_unavailable when the descriptor is missing relay_id", async () => {
    mockRelay({
      descriptor: new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      announce: new Response("", { status: 201 }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("relay_identity_unavailable");
    }
  });

  it("returns failed/relay_identity_unavailable when the descriptor 404s", async () => {
    mockRelay({
      descriptor: new Response("nope", { status: 404 }),
      announce: new Response("", { status: 201 }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("relay_identity_unavailable");
      expect(r.httpStatus).toBe(404);
    }
  });

  it("returns failed/network_unreachable when the descriptor fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("network_unreachable");
      expect(r.message).toContain("ECONNREFUSED");
    }
  });

  it("returns failed/rejected on 400 with reason code", async () => {
    mockRelay({
      announce: new Response(
        JSON.stringify({ code: "MOTEBIT_ANNOUNCEMENT_REJECTED", reason: "wrong_audience" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("rejected");
      expect(r.message).toBe("wrong_audience");
      // A relay rejection of a well-formed, bound announcement is persistent.
    }
  });

  it("returns failed/rate_limited on 429", async () => {
    mockRelay({
      announce: new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("rate_limited");
    }
  });

  it("returns failed/unknown with httpStatus for 5xx responses", async () => {
    mockRelay({ announce: new Response("server broke", { status: 503 }) });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("unknown");
      expect(r.httpStatus).toBe(503);
    }
  });

  it("returns failed/unknown when the success body is non-JSON", async () => {
    mockRelay({ announce: new Response("not-json", { status: 201 }) });
    const r = await announceMotebit(baseParams);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.code).toBe("unknown");
      expect(r.httpStatus).toBe(201);
    }
  });
});
