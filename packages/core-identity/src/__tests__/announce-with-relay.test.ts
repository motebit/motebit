/**
 * announceMotebit — outcome mapping for the sovereign-funnel intake client.
 * Covers descriptor discovery (audience binding), every status → error-code
 * branch, and the network-unreachable best-effort contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { announceMotebit } from "../announce-with-relay.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";

const RELAY_ID = "relay-sovereign-id-123";

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
  baseParams = {
    motebitId: "mote-test",
    publicKey: bytesToHex(keypair.publicKey),
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
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
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
    }),
  );
}

describe("announceMotebit", () => {
  it("returns ok with first_seen=true on 201 and binds audience to the relay's id", async () => {
    let captured: { audience?: string; suite?: string; signature?: string } = {};
    mockRelay({
      announce: new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_000, first_seen: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
      onAnnounceBody: (b) => (captured = b as typeof captured),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.first_seen).toBe(true);
      expect(r.announced_at).toBe(1_700_000_000_000);
    }
    // The signed announcement is bound to the relay's discovered id.
    expect(captured.audience).toBe(RELAY_ID);
    expect(captured.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(typeof captured.signature).toBe("string");
  });

  it("returns ok with first_seen=false on 200 (idempotent re-announce)", async () => {
    mockRelay({
      announce: new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_001, first_seen: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.first_seen).toBe(false);
  });

  it("returns relay_identity_unavailable when the descriptor is missing relay_id", async () => {
    mockRelay({
      descriptor: new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      announce: new Response("", { status: 201 }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("relay_identity_unavailable");
  });

  it("returns relay_identity_unavailable when the descriptor 404s", async () => {
    mockRelay({
      descriptor: new Response("nope", { status: 404 }),
      announce: new Response("", { status: 201 }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("relay_identity_unavailable");
      expect(r.status).toBe(404);
    }
  });

  it("returns network_unreachable when the descriptor fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("network_unreachable");
      expect(r.message).toContain("ECONNREFUSED");
    }
  });

  it("returns rejected on 400 with reason code", async () => {
    mockRelay({
      announce: new Response(
        JSON.stringify({ code: "MOTEBIT_ANNOUNCEMENT_REJECTED", reason: "wrong_audience" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rejected");
      expect(r.message).toBe("wrong_audience");
    }
  });

  it("returns rate_limited on 429", async () => {
    mockRelay({
      announce: new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rate_limited");
  });

  it("returns unknown with status for 5xx responses", async () => {
    mockRelay({ announce: new Response("server broke", { status: 503 }) });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unknown");
      expect(r.status).toBe(503);
    }
  });

  it("returns unknown when the success body is non-JSON", async () => {
    mockRelay({ announce: new Response("not-json", { status: 201 }) });
    const r = await announceMotebit(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unknown");
      expect(r.status).toBe(201);
    }
  });
});
