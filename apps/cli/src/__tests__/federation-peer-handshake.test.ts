/**
 * `motebit federation mesh` / `peer` drive the v2 peering handshake.
 *
 * Two REAL relays; `fetch` is routed by URL origin to each relay's app. The
 * CLI must: propose at the verifier, mint the PROVER's confirm through the
 * prover's operator-authenticated admin endpoint (never a public oracle),
 * and confirm at the verifier — in both directions. A token the relays do
 * not accept mints nothing, and no row is written.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import type { CliConfig } from "../args.js";
import { handleFederationMesh } from "../subcommands/federation.js";

const A_URL = "http://relay-a.test:3000";
const B_URL = "http://relay-b.test:3001";
const TOKEN = "operator-token";

async function relay(url: string): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: TOKEN,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
    enableDeviceAuth: false,
    federation: { endpointUrl: url, displayName: url },
  } as Parameters<typeof createSyncRelay>[0]);
}

const open: SyncRelay[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (open.length) await open.pop()!.close();
});

function route(a: SyncRelay, b: SyncRelay, calls: string[]): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = url.startsWith(A_URL) ? a : url.startsWith(B_URL) ? b : null;
    if (!target) throw new Error(`unrouted ${url}`);
    const path = url.slice((target === a ? A_URL : B_URL).length);
    calls.push(`${init?.method ?? "GET"} ${url.startsWith(A_URL) ? "A" : "B"} ${path}`);
    return target.app.request(path, {
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    });
  });
}

const peerRow = (on: SyncRelay, id: string) =>
  on.moteDb.db
    .prepare("SELECT state, public_key, endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
    .get(id) as { state: string; public_key: string; endpoint_url: string } | undefined;

describe("motebit federation mesh — handshake v2", () => {
  it("peers two relays both ways, each confirm minted by the prover's admin endpoint", async () => {
    const a = await relay(A_URL);
    const b = await relay(B_URL);
    open.push(a, b);
    const calls: string[] = [];
    route(a, b, calls);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handleFederationMesh({
      positionals: ["federation", "mesh", A_URL, B_URL],
      syncToken: TOKEN,
    } as unknown as CliConfig);

    expect(peerRow(b, a.relayIdentity.relayMotebitId)).toEqual({
      state: "active",
      public_key: a.relayIdentity.publicKeyHex,
      endpoint_url: A_URL,
    });
    expect(peerRow(a, b.relayIdentity.relayMotebitId)).toEqual({
      state: "active",
      public_key: b.relayIdentity.publicKeyHex,
      endpoint_url: B_URL,
    });
    // A's confirm came from A's admin endpoint, B's from B's — never a
    // self-propose at a relay's public propose route.
    expect(calls).toContain("POST A /api/v1/admin/federation/peer-confirm-signature");
    expect(calls).toContain("POST B /api/v1/admin/federation/peer-confirm-signature");
    const proposes = calls.filter((c) => c.endsWith("/federation/v1/peer/propose"));
    expect(proposes).toEqual([
      "POST B /federation/v1/peer/propose",
      "POST A /federation/v1/peer/propose",
    ]);
  });

  it("a token the relays refuse mints no confirm and peers nothing", async () => {
    const a = await relay(A_URL);
    const b = await relay(B_URL);
    open.push(a, b);
    route(a, b, []);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      handleFederationMesh({
        positionals: ["federation", "mesh", A_URL, B_URL],
        syncToken: "not-the-operator",
      } as unknown as CliConfig),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(peerRow(b, a.relayIdentity.relayMotebitId)).toBeUndefined();
    expect(peerRow(a, b.relayIdentity.relayMotebitId)).toBeUndefined();
  });
});
