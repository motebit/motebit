/**
 * M1 (client seam) — the payer binds EVERY candidate's pay-to address before
 * broadcast, local or federated (docs/doctrine/settlement-authority-binding.md).
 *
 * The relay-side fix stops a peer entry shadowing a local id; this is the
 * fund-protecting seam that holds even against an older or mis-merging relay:
 *  - a candidate the origin did not mark LOCAL (`hop_distance` > 0) that carries
 *    no direct-peer key cannot be priced or bound — refused, never "treated as
 *    local" (the bypass: no peer key ⇒ local ⇒ no check);
 *  - a LOCAL candidate's address is write-authorized on the relay, so the
 *    relay's caller-bound pre-flight confirms it: a pre-flight that names a
 *    different registered address refuses (custody separation stays legal —
 *    the address need not derive from the key, it must be the one registered).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { resolveP2pPaymentRequest } from "../relay-delegation.js";

const RELAY_URL = "https://relay.test";
const ATTACKER = "AttackerAddr9999999999999999999999999999999";
const CUSTODY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

function stub(agent: Record<string, unknown>, eligibility: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/api/v1/agents/discover")) return json(200, { agents: [agent] });
    if (url.includes("/p2p-eligibility")) return json(200, eligibility);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function params() {
  const relay = await generateKeypair();
  return {
    motebitId: "alice",
    syncUrl: RELAY_URL,
    authToken: vi.fn(async (aud?: string) => `tok-${aud}`),
    capability: "web_search",
    relayPublicKeyHex: bytesToHex(relay.publicKey),
  };
}

const AMOUNTS = { expected_amount_micro: 500_000, expected_fee_micro: 25_000 };

describe("payer binds every candidate before broadcast", () => {
  it("a non-local entry (hop 1) with no direct-peer key is refused — never treated as local", async () => {
    stub(
      {
        motebit_id: "bob",
        settlement_address: ATTACKER,
        settlement_modes: "p2p",
        hop_distance: 1,
        source_relay: "ghost-relay",
      },
      { allowed: true, ...AMOUNTS },
    );
    const r = await resolveP2pPaymentRequest(await params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("worker_settlement_unbound");
  });

  it("the pinned hire of such an entry is refused too", async () => {
    stub(
      {
        motebit_id: "bob",
        settlement_address: ATTACKER,
        settlement_modes: "p2p",
        hop_distance: 2,
        source_relay: "far-relay",
      },
      { allowed: true, ...AMOUNTS },
    );
    const r = await resolveP2pPaymentRequest({ ...(await params()), targetWorkerId: "bob" });
    expect(r.ok).toBe(false);
  });

  it("a LOCAL candidate whose discovered address differs from the relay's registered one is refused", async () => {
    const fetchFn = stub(
      { motebit_id: "bob", settlement_address: ATTACKER, settlement_modes: "p2p", hop_distance: 0 },
      { allowed: true, settlement_address: CUSTODY, ...AMOUNTS },
    );
    const r = await resolveP2pPaymentRequest(await params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("worker_settlement_unbound");
    expect(fetchFn).toHaveBeenCalledTimes(2); // discover + pre-flight, nothing priced
  });

  it("a LOCAL custody-separated address the relay confirms is paid (write-authorized rung)", async () => {
    stub(
      { motebit_id: "bob", settlement_address: CUSTODY, settlement_modes: "p2p", hop_distance: 0 },
      { allowed: true, settlement_address: CUSTODY, ...AMOUNTS },
    );
    const r = await resolveP2pPaymentRequest(await params());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workerAddress).toBe(CUSTODY);
  });

  it("an older relay (no hop_distance, no confirmed address) keeps today's local behaviour", async () => {
    stub(
      { motebit_id: "bob", settlement_address: CUSTODY, settlement_modes: "p2p" },
      { allowed: true, ...AMOUNTS },
    );
    const r = await resolveP2pPaymentRequest(await params());
    expect(r.ok).toBe(true);
  });
});
