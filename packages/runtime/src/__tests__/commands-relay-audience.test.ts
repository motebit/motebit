/**
 * The shared market commands mint the audience each relay route verifies
 * (#827). Web, desktop, spatial and the CLI build one `RelayConfig`; before,
 * its single `sync` token went to every route, and `/balance`
 * (`account:balance`) and `/proposals` (`proposal`) refused it. The relay-side
 * proof that these audiences are what the routes verify is
 * services/relay/src/__tests__/route-audience-conformance.test.ts; the same
 * commands run against the in-process relay in client-audience-e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCommand, type RelayConfig } from "../commands/index.js";

interface Seen {
  method: string;
  path: string;
  bearer: string | null;
}

describe("shared market commands mint per-route audiences", () => {
  let seen: Seen[];

  beforeEach(() => {
    seen = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        method: init?.method ?? "GET",
        path: url.replace("http://relay", ""),
        bearer: headers["Authorization"]?.replace("Bearer ", "") ?? null,
      });
      return new Response(
        JSON.stringify({ balance: 0, currency: "USDC", proposals: [], agents: [] }),
        {
          status: 200,
        },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const relay: RelayConfig = {
    relayUrl: "http://relay",
    authToken: "sync-token",
    motebitId: "m1",
    mintToken: async (audience) => `minted:${audience}`,
  };
  const noRuntime = {} as never;

  it.each([
    ["balance", "GET", "/api/v1/agents/m1/balance", "minted:account:balance"],
    ["deposits", "GET", "/api/v1/agents/m1/balance", "minted:account:balance"],
    ["proposals", "GET", "/api/v1/proposals", "minted:proposal"],
  ])("%s → %s %s with %s", async (command, method, path, bearer) => {
    await executeCommand(noRuntime, command, undefined, relay);
    expect(seen).toEqual([{ method, path, bearer }]);
  });

  it("discover is a GET of the public route; no audience to mint, so the fallback bearer", async () => {
    await executeCommand(noRuntime, "discover", undefined, relay);
    expect(seen).toEqual([
      { method: "GET", path: "/api/v1/agents/discover", bearer: "sync-token" },
    ]);
  });

  it("mintToken: null (an operator's master token, no device key) sends the one bearer", async () => {
    await executeCommand(noRuntime, "balance", undefined, {
      relayUrl: "http://relay",
      authToken: "master",
      motebitId: "m1",
      mintToken: null,
    });
    expect(seen[0]?.bearer).toBe("master");
  });
});
