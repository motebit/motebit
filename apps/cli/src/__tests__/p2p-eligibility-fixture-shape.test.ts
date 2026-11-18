/**
 * The fake relays in the paid-delegation tests answer the payment pre-flight
 * (`p2p-eligibility`) through `helpers/p2p-eligibility-fixture.ts`. This pins
 * that fixture's CURRENT shape to what the real relay handler answers, so the
 * fixture cannot silently drift from the relay: a real relay is booted
 * in-process, a worker is registered with a settlement address and a priced
 * listing, and the handler's own answer is compared with the fixture's.
 *
 * It matters because the two shapes take different paths through the payment
 * code: with the amounts present the client pays without reading any signed
 * relay document.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { bytesToHex, generateKeypair } from "@motebit/crypto";
import {
  CURRENT_ELIGIBILITY_KEYS,
  currentEligibilityAnswer,
  olderRelayEligibilityAnswer,
} from "./helpers/p2p-eligibility-fixture.js";

const MASTER = "test-token";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER}` };
const WORKER_ADDR = "11111111111111111111111111111112";

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
});

afterEach(async () => {
  await relay.close();
});

/** Register a worker with a settlement address and a priced `web_search` listing. */
async function pricedWorker(unitCost: number): Promise<string> {
  const workerId = crypto.randomUUID();
  const kp = await generateKeypair();
  const registered = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      motebit_id: workerId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
      settlement_address: WORKER_ADDR,
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(200);
  const listed = await relay.app.request(`/api/v1/agents/${workerId}/listing`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: unitCost, currency: "USD", per: "task" }],
    }),
  });
  expect(listed.status, await listed.clone().text()).toBe(200);
  return workerId;
}

describe("the p2p-eligibility fixture matches the real relay handler", () => {
  it("the current shape: the same fields, and the same amounts, as the handler answers for a priced worker", async () => {
    const workerId = await pricedWorker(0.25);
    const res = await relay.app.request(
      `/api/v1/agents/${workerId}/p2p-eligibility?capability=web_search`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const real = (await res.json()) as Record<string, unknown>;

    const fixture = currentEligibilityAnswer({
      settlementAddress: WORKER_ADDR,
      expectedAmountMicro: 250_000,
      expectedFeeMicro: 13_158,
    });
    expect(Object.keys(real).sort()).toEqual([...CURRENT_ELIGIBILITY_KEYS]);
    expect(Object.keys(fixture).sort()).toEqual([...CURRENT_ELIGIBILITY_KEYS]);
    // Field for field, the handler's own answer for this worker.
    expect(real).toEqual(fixture);
  });

  it("the older shape differs from the current one only by the two amounts", () => {
    const older = olderRelayEligibilityAnswer({ settlementAddress: WORKER_ADDR });
    expect(Object.keys(older).sort()).toEqual(
      CURRENT_ELIGIBILITY_KEYS.filter(
        (k) => k !== "expected_amount_micro" && k !== "expected_fee_micro",
      ),
    );
  });
});
