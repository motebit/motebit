/**
 * Clients mint as they now do, against the in-process relay (#827).
 *
 * The route-audience conformance test proves the relay against the protocol
 * table. This one drives the CLIENT code that was refused on every call —
 * as the client runs it, where the client package can be loaded here:
 *
 *   - the shared command layer (`@motebit/runtime` executeCommand: /balance,
 *     /deposits, /discover, /proposals), which web, desktop, spatial and the
 *     CLI all call. Each surface now passes `RelayConfig.mintToken`; before,
 *     they passed one `sync` token, which `/balance` (`account:balance`) and
 *     `/proposals` (`proposal`) refuse, `/discover` was a POST to a GET-only
 *     route, and `/proposals` named `/api/v1/agents/:id/proposals`, a route
 *     that never existed.
 *   - device-token proposals end to end, which the `/api/v1/*` master-only
 *     catch-all used to refuse before the proposal middleware ever ran.
 *   - web pairing, which minted `pair` where the pairing routes verify
 *     `device:auth`.
 *
 * The negative controls replay the pre-fix wiring and must stay refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { executeCommand, type RelayConfig } from "@motebit/runtime";
import { createTestRelay, createAgent, JSON_AUTH } from "./test-helpers.js";

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function seedAgent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const { motebitId, deviceId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { motebitId, deviceId, privateKey: kp.privateKey };
}

/** What every surface's `createSyncToken(aud)` reduces to. */
async function mint(a: Agent, aud: TokenAudience): Promise<string> {
  return (await mintAudienceToken({ mid: a.motebitId, did: a.deviceId, aud }, a.privateKey)).token;
}

/** The RelayConfig each surface now builds: a `sync` token plus `mintToken`. */
async function surfaceRelayConfig(a: Agent): Promise<RelayConfig> {
  return {
    relayUrl: "http://relay",
    authToken: await mint(a, "sync"),
    motebitId: a.motebitId,
    mintToken: (aud) => mint(a, aud),
  };
}

// The runtime needs nothing for the market commands; they touch only the relay.
const NO_RUNTIME = {} as never;

describe("clients mint the audience their route verifies (#827)", () => {
  let relay: SyncRelay;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    relay = await createTestRelay();
    originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return relay.app.request(url.replace("http://relay", ""), init);
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    await relay.close();
  });

  describe("shared command layer (web, desktop, spatial, CLI)", () => {
    it("/balance and /deposits succeed with the surface's RelayConfig", async () => {
      const a = await seedAgent(relay);
      const relayConfig = await surfaceRelayConfig(a);
      const balance = await executeCommand(NO_RUNTIME, "balance", undefined, relayConfig);
      expect(balance?.summary).toMatch(/^Balance: /);
      const deposits = await executeCommand(NO_RUNTIME, "deposits", undefined, relayConfig);
      expect(deposits?.summary).toBe("No deposits yet.");
    });

    it("negative control: a lone `sync` token (the pre-fix wiring) is refused by /balance", async () => {
      const a = await seedAgent(relay);
      const syncOnly: RelayConfig = {
        relayUrl: "http://relay",
        authToken: await mint(a, "sync"),
        motebitId: a.motebitId,
        mintToken: null,
      };
      await expect(executeCommand(NO_RUNTIME, "balance", undefined, syncOnly)).rejects.toThrow(
        /^401/,
      );
    });

    it("/discover reaches the public discovery route", async () => {
      const a = await seedAgent(relay);
      const result = await executeCommand(
        NO_RUNTIME,
        "discover",
        undefined,
        await surfaceRelayConfig(a),
      );
      expect(result?.summary).toBeDefined();
      expect(result?.summary).not.toMatch(/^4\d\d/);
    });

    it("/proposals lists the caller's proposals from /api/v1/proposals", async () => {
      const a = await seedAgent(relay);
      const peer = await seedAgent(relay);
      const created = await relay.app.request("/api/v1/proposals", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          proposal_id: "prop-827",
          plan_id: "plan-827",
          initiator_motebit_id: a.motebitId,
          participants: [{ motebit_id: peer.motebitId, assigned_steps: [0] }],
        }),
      });
      expect(created.status).toBe(201);

      const result = await executeCommand(
        NO_RUNTIME,
        "proposals",
        undefined,
        await surfaceRelayConfig(a),
      );
      expect(result?.summary).toBe("1 proposals");
      expect(result?.detail).toContain("prop-827".slice(0, 8));
    });
  });

  describe("device-token proposals (CLI /propose, /proposals, /proposal)", () => {
    it("a `proposal` token creates and lists; the proposal is the caller's own", async () => {
      const a = await seedAgent(relay);
      const peer = await seedAgent(relay);
      const token = await mint(a, "proposal");
      const create = await relay.app.request("/api/v1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          proposal_id: "prop-dev",
          plan_id: "plan-dev",
          // A device caller's initiator is its own token's motebit, never the body's.
          initiator_motebit_id: peer.motebitId,
          participants: [{ motebit_id: peer.motebitId, assigned_steps: [0] }],
        }),
      });
      expect(create.status).toBe(201);
      const list = await relay.app.request("/api/v1/proposals", {
        headers: { Authorization: `Bearer ${await mint(a, "proposal")}` },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        proposals: Array<{ proposal_id: string; initiator_motebit_id: string }>;
      };
      expect(body.proposals).toEqual([
        expect.objectContaining({ proposal_id: "prop-dev", initiator_motebit_id: a.motebitId }),
      ]);
    });

    it("a token for another audience, or none, is refused", async () => {
      const a = await seedAgent(relay);
      for (const headers of [
        { Authorization: `Bearer ${await mint(a, "sync")}` },
        {} as Record<string, string>,
      ]) {
        const res = await relay.app.request("/api/v1/proposals", { headers });
        expect(res.status).toBe(401);
      }
    });
  });

  describe("web pairing", () => {
    it("initiates with `device:auth` (what web now mints); `pair` is refused", async () => {
      const a = await seedAgent(relay);
      const ok = await relay.app.request("/pairing/initiate", {
        method: "POST",
        headers: { Authorization: `Bearer ${await mint(a, "device:auth")}` },
      });
      expect(ok.status).toBeLessThan(300);
      const refused = await relay.app.request("/pairing/initiate", {
        method: "POST",
        headers: { Authorization: `Bearer ${await mint(a, "pair")}` },
      });
      expect(refused.status).toBe(401);
    });
  });
});
