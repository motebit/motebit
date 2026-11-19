/**
 * The fake relays in the paid-delegation tests answer the payment pre-flight
 * (`p2p-eligibility`) through `helpers/p2p-eligibility-fixture.ts`. This pins
 * that fixture's CURRENT shape to what the real relay handler answers THE
 * REAL CLIENT, so the fixture cannot silently drift from the relay.
 *
 * The handler has two returns. A caller the relay cannot identify (the master
 * token) gets an advisory answer; an identified caller — which is what the
 * paying client is: it sends its own signed `market:listing` token
 * (`packages/runtime/src/relay-delegation.ts`, the eligibility pre-flight) —
 * gets the answer of `evaluateSettlementEligibility`. This test asks the way
 * the client does: a registered delegator with an ephemeral key, a token
 * minted with the CLI's own `mintAudienceToken`, the client's own query
 * string. The fixture must equal THAT answer, field for field.
 *
 * It matters because the two shapes of answer take different paths through
 * the payment code: with the amounts present the client pays without reading
 * any signed relay document.
 *
 * The relay is booted with nothing that reaches the network (an in-process
 * facilitator stub, no deposit detector, no chain reader), and the test fails
 * if anything in it attempts a non-loopback request.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  mintAudienceToken,
} from "@motebit/encryption";
import { signedBootstrapBody } from "../relay-registration.js";
import {
  CURRENT_ELIGIBILITY_KEYS,
  currentEligibilityAnswer,
  olderRelayEligibilityAnswer,
} from "./helpers/p2p-eligibility-fixture.js";

const MASTER = "test-token";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER}` };
const WORKER_ADDR = "11111111111111111111111111111112";

/** An x402 facilitator that is never reachable, in-process: no socket is opened. */
const OFFLINE_FACILITATOR: unknown = {
  getSupported: () => Promise.reject(new TypeError("facilitator offline in test")),
  verify: () => Promise.reject(new TypeError("facilitator offline in test")),
  settle: () => Promise.reject(new TypeError("facilitator offline in test")),
};

let relay: SyncRelay;
const realFetch = globalThis.fetch;
/** Every request anything in this test tried to make over the network. */
let outbound: string[] = [];

beforeEach(async () => {
  outbound = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    return Promise.reject(new TypeError(`network denied in test: ${url}`));
  }) as typeof fetch;
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    // Nothing that reaches the network (the relay's own test harness does the
    // same): the facilitator handshake, the deposit detector's RPC scan and
    // the x402 chain reader are all off or in-process.
    x402FacilitatorClient: OFFLINE_FACILITATOR,
    depositDetectorRpc: null,
    x402ChainReader: null,
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
});

afterEach(async () => {
  await relay.close();
  globalThis.fetch = realFetch;
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

/**
 * A delegator the relay can identify: an ephemeral key, bootstrapped the way
 * the CLI bootstraps (`signedBootstrapBody`), and a `market:listing` token
 * minted the way the CLI mints one (`mintAudienceToken`).
 */
async function delegatorToken(): Promise<string> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const motebitId = await deriveSovereignMotebitId(publicKeyHex);
  const deviceId = `${motebitId}-dev`;
  const bootstrapped = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await signedBootstrapBody({
      motebitId,
      deviceId,
      publicKeyHex,
      privateKey: kp.privateKey,
    }),
  });
  expect(bootstrapped.ok, await bootstrapped.clone().text()).toBe(true);
  const { token } = await mintAudienceToken(
    { mid: motebitId, did: deviceId, aud: "market:listing" },
    kp.privateKey,
  );
  return token;
}

describe("the p2p-eligibility fixture matches the real relay handler", () => {
  it("the current shape equals what the handler answers an IDENTIFIED caller (the paying client), field for field", async () => {
    const workerId = await pricedWorker(0.25);
    const token = await delegatorToken();
    // The client's own request: its signed token, and the query it builds for
    // a session that opted into paying new agents.
    const res = await relay.app.request(
      `/api/v1/agents/${workerId}/p2p-eligibility?acknowledge_no_history_risk=true&capability=web_search`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const real = (await res.json()) as Record<string, unknown>;

    const fixture = currentEligibilityAnswer({
      settlementAddress: WORKER_ADDR,
      expectedAmountMicro: 250_000,
      expectedFeeMicro: 13_158,
    });
    // Not the advisory answer an unidentified caller gets.
    expect(real["reason"]).not.toContain("advisory");
    expect(Object.keys(real).sort()).toEqual([...CURRENT_ELIGIBILITY_KEYS]);
    expect(Object.keys(fixture).sort()).toEqual([...CURRENT_ELIGIBILITY_KEYS]);
    expect(real).toEqual(fixture);
    expect(outbound).toEqual([]);
  });

  it("without the cold-start acknowledgment the same identified caller is refused (the request above is the caller-bound path)", async () => {
    const workerId = await pricedWorker(0.25);
    const token = await delegatorToken();
    const res = await relay.app.request(
      `/api/v1/agents/${workerId}/p2p-eligibility?capability=web_search`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const real = (await res.json()) as Record<string, unknown>;
    // The master token would be answered `allowed: true` here (advisory).
    expect(real["allowed"]).toBe(false);
    expect(outbound).toEqual([]);
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
