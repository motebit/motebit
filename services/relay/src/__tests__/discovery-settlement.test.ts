/**
 * Discovery settlement capability tests.
 *
 * Verifies that GET /api/v1/discover/:motebitId returns
 * settlement_address and settlement_modes when the agent declares them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import type { AgentResolutionResult } from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  publicKeyHex: string,
  opts?: { settlementAddress?: string; settlementModes?: string },
) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
      ...(opts?.settlementAddress ? { settlement_address: opts.settlementAddress } : {}),
      ...(opts?.settlementModes ? { settlement_modes: opts.settlementModes } : {}),
    }),
  });
}

describe("Discovery — settlement capabilities", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("includes settlement_address and settlement_modes when agent declares them", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-p2p", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      settlementModes: "relay,p2p",
    });

    const res = await relay.app.request("/api/v1/discover/agent-p2p");
    expect(res.status).toBe(200);

    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(true);
    expect(result.settlement_address).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv");
    expect(result.settlement_modes).toEqual(["relay", "p2p"]);
  });

  it("omits settlement fields when agent has no settlement address", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-relay-only", bytesToHex(kp.publicKey));

    const res = await relay.app.request("/api/v1/discover/agent-relay-only");
    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(true);
    expect(result.settlement_address).toBeUndefined();
    // Default settlement_modes is "relay" — should be included
    expect(result.settlement_modes).toEqual(["relay"]);
  });

  it("settlement_modes with single mode returns array", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-p2p-only", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      settlementModes: "p2p",
    });

    const res = await relay.app.request("/api/v1/discover/agent-p2p-only");
    const result = (await res.json()) as AgentResolutionResult;
    expect(result.settlement_modes).toEqual(["p2p"]);
  });
});
