/**
 * #954 round 2 — P2P admission relies on the chain id a proof claims, so it
 * reads the payer only once the relay's Solana network resolves.
 *
 * Wired the production way: NO injected payer chain — `SOLANA_RPC_URL` points
 * at a fake JSON-RPC whose `getTransaction` names the delegator as payer, so
 * the chain `index.ts` builds from the environment (and gates on the network)
 * is the one under test.
 *
 *   - SOLANA_NETWORK contradicts the RPC ⇒ every P2P submission is a
 *     retryable 503, nothing admitted — permanently.
 *   - the RPC agrees (or nothing is declared) ⇒ an honest submission admits,
 *     exactly as before (the flow staging passed 51/51 on).
 *   - the network is still unresolved ⇒ 503, and the same submission admits
 *     once the RPC answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_CAIP2,
} from "@motebit/wallet-solana";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  walletOf,
  JSON_AUTH,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { startFakeSolanaRpc, type FakeSolanaRpc } from "./booted-entry-harness.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

let relay: SyncRelay | null = null;
let rpc: FakeSolanaRpc | null = null;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["SOLANA_RPC_URL", "SOLANA_NETWORK", "SOLANA_USDC_MINT"])
    saved[k] = process.env[k];
  delete process.env.SOLANA_USDC_MINT;
});

afterEach(async () => {
  if (relay) await relay.close();
  relay = null;
  if (rpc) await rpc.close();
  rpc = null;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function bootWith(opts: { declared?: string; genesisFailures?: number }): Promise<SyncRelay> {
  rpc = await startFakeSolanaRpc({
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    ...(opts.genesisFailures !== undefined ? { genesisFailures: opts.genesisFailures } : {}),
  });
  process.env.SOLANA_RPC_URL = rpc.url;
  if (opts.declared !== undefined) process.env.SOLANA_NETWORK = opts.declared;
  else delete process.env.SOLANA_NETWORK;
  // `p2pPaymentChain: undefined` ⇒ the relay builds its chain from the env.
  relay = await createTestRelay({ p2pPaymentChain: undefined });
  return relay;
}

interface Agent {
  motebitId: string;
  publicKeyHex: string;
}

async function newAgent(r: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const a = await createAgent(r, publicKeyHex);
  return { motebitId: a.motebitId, publicKeyHex };
}

async function pricedWorker(r: SyncRelay): Promise<{ worker: Agent; dispatched: () => number }> {
  const worker = await newAgent(r);
  const a = await r.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: "http://127.0.0.1:18999/mcp",
      capabilities: ["web_search"],
      settlement_address: WORKER_SOLANA_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  expect(a.status).toBeLessThan(300);
  await r.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "954 worker",
      pay_to_address: WORKER_SOLANA_ADDR,
    }),
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  r.connections.set(worker.motebitId, [
    { ws: ws as never, deviceId: "d-954", capabilities: ["web_search"] },
  ]);
  return {
    worker,
    dispatched: () =>
      ws.send.mock.calls.filter(
        (c) => (JSON.parse(String(c[0])) as { type: string }).type === "task_request",
      ).length,
  };
}

function establishPair(r: SyncRelay, delegator: string, worker: string): void {
  r.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, 'verified', 10, ?, ?)`,
    )
    .run(delegator, worker, Date.now(), Date.now());
}

async function submitP2p(r: SyncRelay): Promise<{
  status: number;
  code?: string;
  resubmit: () => Promise<number>;
  dispatched: () => number;
}> {
  const delegator = await newAgent(r);
  const { worker, dispatched } = await pricedWorker(r);
  establishPair(r, delegator.motebitId, worker.motebitId);
  rpc!.setPayer(walletOf(delegator.publicKeyHex));
  const proof = buildP2pPaymentProof(r, {
    workerAddress: WORKER_SOLANA_ADDR,
    unitCostMicro: toMicro(0.5),
  });
  const send = () =>
    r.app.request(`/agent/${delegator.motebitId}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt: `954 p2p ${crypto.randomUUID()}`,
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        payment_proof: proof,
        required_capabilities: ["web_search"],
      }),
    });
  const res = await send();
  const body = (await res.json()) as { code?: string };
  return {
    status: res.status,
    ...(body.code !== undefined ? { code: body.code } : {}),
    resubmit: async () => (await send()).status,
    dispatched,
  };
}

describe("#954 — P2P admission waits for the relay's Solana network", () => {
  it("SOLANA_NETWORK contradicting the RPC refuses an honest P2P submission (503, nothing admitted)", async () => {
    const r = await bootWith({ declared: SOLANA_MAINNET_CAIP2 });
    const out = await submitP2p(r);
    expect(out.status).toBe(503);
    expect(out.code).toBe("TASK_P2P_PROOF_UNVERIFIED");
    expect(out.dispatched()).toBe(0);
    expect(rpc!.callsOf("getTransaction"), "the payer is never read on a mismatch").toBe(0);
    // Permanent: a retry is refused the same way.
    expect(await out.resubmit()).toBe(503);
  });

  it("an RPC that agrees with SOLANA_NETWORK admits the honest submission", async () => {
    const r = await bootWith({ declared: SOLANA_DEVNET_CAIP2 });
    const out = await submitP2p(r);
    expect(out.status).toBe(201);
    expect(out.dispatched()).toBe(1);
  });

  it("with nothing declared, the honest submission admits once the network resolves", async () => {
    const r = await bootWith({});
    const out = await submitP2p(r);
    expect(out.status).toBe(201);
  });

  it("while the network is unresolved P2P is a retryable 503; the retry admits once the RPC answers", async () => {
    // Warm-up read + the first submission's read both hit 503s.
    const r = await bootWith({ genesisFailures: 2 });
    await new Promise((res) => setTimeout(res, 100)); // let the warm-up read fail
    const out = await submitP2p(r);
    expect(out.status).toBe(503);
    expect(out.dispatched()).toBe(0);
    expect(await out.resubmit()).toBe(201);
  });
});
