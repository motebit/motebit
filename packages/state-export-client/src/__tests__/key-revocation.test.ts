/**
 * lookupKeyRevocation reads the relay's on-chain `motebit:revocation:v1:` memos so
 * a verifier can refuse to bind a receipt signed by a revoked key. It returns the
 * EARLIEST revocation timestamp for the key (most protective); RPC failure is
 * `unknown` (never silently "not revoked"). Solana RPC is mocked.
 */
import { describe, it, expect } from "vitest";
import { lookupKeyRevocation } from "../key-revocation.js";

const ADDR = "RelayPinnedSolanaAddr1111111111111111111111";
const KEY = "ab".repeat(32); // 64 hex
const OTHER = "cd".repeat(32);

function mockFetch(
  sigs: Array<{ signature: string; memo: string | null; err?: unknown }>,
): typeof globalThis.fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: sigs.map((s) => ({
          signature: s.signature,
          slot: 1,
          err: s.err ?? null,
          memo: s.memo,
          blockTime: null,
        })),
      }),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;
}

describe("lookupKeyRevocation", () => {
  it("finds a revocation memo for the key → status revoked with timestamp + tx", async () => {
    const fetch = mockFetch([{ signature: "rev-tx", memo: `motebit:revocation:v1:${KEY}:1500` }]);
    const r = await lookupKeyRevocation(ADDR, KEY, { fetch });
    expect(r.status).toBe("revoked");
    if (r.status === "revoked") {
      expect(r.revokedAt).toBe(1500);
      expect(r.txHash).toBe("rev-tx");
    }
  });

  it("returns the EARLIEST revocation when several exist", async () => {
    const fetch = mockFetch([
      { signature: "late", memo: `motebit:revocation:v1:${KEY}:3000` },
      { signature: "early", memo: `motebit:revocation:v1:${KEY}:1200` },
    ]);
    const r = await lookupKeyRevocation(ADDR, KEY, { fetch });
    expect(r.status === "revoked" && r.revokedAt).toBe(1200);
    expect(r.status === "revoked" && r.txHash).toBe("early");
  });

  it("not_revoked when only OTHER keys are revoked", async () => {
    const fetch = mockFetch([{ signature: "x", memo: `motebit:revocation:v1:${OTHER}:1500` }]);
    expect((await lookupKeyRevocation(ADDR, KEY, { fetch })).status).toBe("not_revoked");
  });

  it("not_revoked when the address has no revocation memos", async () => {
    const fetch = mockFetch([{ signature: "x", memo: `motebit:anchor:v1:${KEY}:7` }]);
    expect((await lookupKeyRevocation(ADDR, KEY, { fetch })).status).toBe("not_revoked");
  });

  it("skips failed txs", async () => {
    const fetch = mockFetch([
      { signature: "failed", memo: `motebit:revocation:v1:${KEY}:1500`, err: { e: 1 } },
    ]);
    expect((await lookupKeyRevocation(ADDR, KEY, { fetch })).status).toBe("not_revoked");
  });

  it("is case-insensitive on the key hex", async () => {
    const fetch = mockFetch([
      { signature: "x", memo: `motebit:revocation:v1:${KEY.toUpperCase()}:1500` },
    ]);
    expect((await lookupKeyRevocation(ADDR, KEY, { fetch })).status).toBe("revoked");
  });

  it("unknown (not 'not_revoked') on a non-2xx RPC response", async () => {
    const fetch = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const r = await lookupKeyRevocation(ADDR, KEY, { fetch });
    expect(r.status).toBe("unknown");
  });

  it("unknown on a transport throw", async () => {
    const fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await lookupKeyRevocation(ADDR, KEY, { fetch });
    expect(r.status).toBe("unknown");
    if (r.status === "unknown") expect(r.detail).toContain("offline");
  });
});
