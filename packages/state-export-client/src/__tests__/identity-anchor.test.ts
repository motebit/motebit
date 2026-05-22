/**
 * lookupIdentityLogAnchor confirms a transparency-log root was actually posted
 * on-chain by the pinned relay. It scans the relay's Solana address for a
 * `motebit:anchor:v1:{root}:{count}` memo carrying the EXACT expected root —
 * the second trust channel that turns a relay-asserted inclusion proof into an
 * `anchored` binding. Solana RPC is mocked; the focus is the match/fail logic.
 */
import { describe, it, expect } from "vitest";
import { lookupIdentityLogAnchor } from "../identity-anchor.js";

const ADDR = "RelayPinnedSolanaAddr1111111111111111111111";
const ROOT = "a".repeat(64);

/** Mock `fetch` that returns a getSignaturesForAddress result with these memos. */
function mockFetch(
  signatures: Array<{ signature: string; memo: string | null; err?: unknown }>,
): typeof globalThis.fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: signatures.map((s) => ({
          signature: s.signature,
          slot: 1,
          err: s.err ?? null,
          memo: s.memo,
          blockTime: null,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;
}

describe("lookupIdentityLogAnchor", () => {
  it("confirms when a memo at the address carries the exact root", async () => {
    const fetch = mockFetch([
      { signature: "sig-other", memo: `[3] motebit:anchor:v1:${"b".repeat(64)}:7` },
      { signature: "sig-hit", memo: `[3] motebit:anchor:v1:${ROOT}:42` },
    ]);
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.txHash).toBe("sig-hit");
      expect(r.anchoredRoot).toBe(ROOT);
      expect(r.relayAnchorAddress).toBe(ADDR);
    }
  });

  it("is case-insensitive on the root hex", async () => {
    const fetch = mockFetch([
      { signature: "s", memo: `motebit:anchor:v1:${ROOT.toUpperCase()}:1` },
    ]);
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(true);
  });

  it("root_not_anchored when no memo carries the root", async () => {
    const fetch = mockFetch([{ signature: "s", memo: `motebit:anchor:v1:${"c".repeat(64)}:1` }]);
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("root_not_anchored");
  });

  it("skips failed txs and non-anchor memos", async () => {
    const fetch = mockFetch([
      { signature: "failed", memo: `motebit:anchor:v1:${ROOT}:1`, err: { InstructionError: [] } },
      { signature: "transparency", memo: `motebit:transparency:v1:${ROOT}` },
      { signature: "no-memo", memo: null },
    ]);
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("root_not_anchored");
  });

  it("rpc_failed on non-2xx", async () => {
    const fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rpc_failed");
  });

  it("rpc_failed on a JSON-RPC error body", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rpc_failed");
  });

  it("rpc_failed on transport throw", async () => {
    const fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await lookupIdentityLogAnchor(ADDR, ROOT, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rpc_failed");
      expect(r.detail).toContain("network down");
    }
  });
});
