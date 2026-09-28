/**
 * Differential probe for #918: does one P2P payment proof ever admit (and
 * dispatch) more than one task? Five cells over the live submit route, a
 * pinned local P2P worker with an open socket:
 *
 *   A  the same proof under a NEW Idempotency-Key
 *   B  the same proof under the SAME key (#888 replay)
 *   C  a refusal before admission (no trust edge), then the corrected retry
 *      under a new key
 *   D  a second submitter (its own verified token) presenting the same proof
 *   E  four concurrent submissions of one proof under four keys
 *   F  a stranger submits the payer's public proof FIRST, then the payer
 *      (#918 round 2: the proof is bound to its payer)
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/p2p-proof-admission-918.probe.ts --pkg services/relay
 *
 * Observations are statuses, codes and counts — no ids. `leaks_foreign_task_id`
 * says whether a refusal to another principal carried the first task's id.
 */
import { it, beforeAll, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
// eslint-disable-next-line no-restricted-imports -- probe needs direct keypair generation
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { createAgent, createTestRelay, buildP2pPaymentProof, JSON_AUTH } from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const obs: Record<string, unknown> = {};
let relay: SyncRelay;

// A fake chain: each proof's payer is registered when the proof is built.
// Passed as a plain config object so the probe runs on main too (main ignores
// the field and never asks who paid).
const payers = new Map<string, string>();
const chain = {
  async payerOf(txHash: string, candidates: ReadonlySet<string>) {
    await Promise.resolve();
    const payer = payers.get(txHash);
    if (payer === undefined) return { status: "not_found" as const };
    return candidates.has(payer) ? { status: "payer" as const } : { status: "not_payer" as const };
  },
};

beforeAll(async () => {
  relay = await createTestRelay({ p2pPaymentChain: chain } as never);
});
afterAll(async () => {
  await relay.close();
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
});

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

async function newAgent(): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { ...a, privateKey: kp.privateKey, publicKey: kp.publicKey };
}

async function bearer(a: Agent): Promise<Record<string, string>> {
  const now = Date.now();
  const token = await createSignedToken(
    {
      mid: a.motebitId,
      did: a.deviceId,
      iat: now,
      exp: now + 300_000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    },
    a.privateKey,
  );
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function worker(): Promise<{
  id: string;
  dispatched: () => number;
  prompts: () => string[];
}> {
  const w = await newAgent();
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: w.motebitId,
      endpoint_url: "http://127.0.0.1:18999/mcp",
      capabilities: ["web_search"],
      settlement_address: WORKER_SOLANA_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${w.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "918 probe worker",
      pay_to_address: WORKER_SOLANA_ADDR,
    }),
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  relay.connections.set(w.motebitId, [
    { ws: ws as never, deviceId: w.deviceId, capabilities: ["web_search"] },
  ]);
  const reqs = () =>
    ws.send.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { type: string; task?: { prompt: string } })
      .filter((m) => m.type === "task_request");
  return {
    id: w.motebitId,
    dispatched: () => reqs().length,
    prompts: () => reqs().map((m) => m.task!.prompt),
  };
}

function pair(delegator: string, w: string): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, 'verified', 10, ?, ?)`,
    )
    .run(delegator, w, Date.now(), Date.now());
}

function tasks(prompt: string): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_task_queue WHERE prompt = ?")
      .get(prompt) as { n: number }
  ).n;
}

async function post(
  delegator: string,
  key: string,
  headers: Record<string, string>,
  w: string,
  prompt: string,
  proof: ReturnType<typeof buildP2pPaymentProof>,
): Promise<{ status: number; code?: string; text: string }> {
  const res = await relay.app.request(`/agent/${delegator}/task`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": key },
    body: JSON.stringify({
      prompt,
      submitted_by: delegator,
      target_agent: w,
      payment_proof: proof,
      required_capabilities: ["web_search"],
    }),
  });
  const text = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: res.status, code, text };
}

const proof = (payer: Agent) => {
  const p = buildP2pPaymentProof(relay, {
    workerAddress: WORKER_SOLANA_ADDR,
    unitCostMicro: toMicro(0.5),
  });
  payers.set(p.tx_hash, deriveSolanaAddress(payer.publicKey));
  return p;
};

it("A: same proof, new key", async () => {
  const d = await newAgent();
  const w = await worker();
  pair(d.motebitId, w.id);
  const p = proof(d);
  const prompt = `A ${crypto.randomUUID()}`;
  const r1 = await post(d.motebitId, crypto.randomUUID(), JSON_AUTH, w.id, prompt, p);
  const r2 = await post(d.motebitId, crypto.randomUUID(), JSON_AUTH, w.id, prompt, p);
  obs["A"] = {
    statuses: [r1.status, r2.status],
    second_code: r2.code ?? null,
    tasks: tasks(prompt),
    dispatches: w.dispatched(),
  };
});

it("B: same proof, same key", async () => {
  const d = await newAgent();
  const w = await worker();
  pair(d.motebitId, w.id);
  const p = proof(d);
  const prompt = `B ${crypto.randomUUID()}`;
  const r1 = await post(d.motebitId, p.tx_hash, JSON_AUTH, w.id, prompt, p);
  const r2 = await post(d.motebitId, p.tx_hash, JSON_AUTH, w.id, prompt, p);
  obs["B"] = {
    statuses: [r1.status, r2.status],
    same_body: r1.text === r2.text,
    tasks: tasks(prompt),
    dispatches: w.dispatched(),
  };
});

it("C: refused before admission, corrected retry", async () => {
  const d = await newAgent();
  const w = await worker();
  const p = proof(d);
  const prompt = `C ${crypto.randomUUID()}`;
  const r1 = await post(d.motebitId, crypto.randomUUID(), JSON_AUTH, w.id, prompt, p);
  pair(d.motebitId, w.id);
  const r2 = await post(d.motebitId, crypto.randomUUID(), JSON_AUTH, w.id, prompt, p);
  obs["C"] = {
    statuses: [r1.status, r2.status],
    first_code: r1.code ?? null,
    tasks: tasks(prompt),
    dispatches: w.dispatched(),
  };
});

it("D: another submitter, same proof", async () => {
  const alice = await newAgent();
  const mallory = await newAgent();
  const w = await worker();
  pair(alice.motebitId, w.id);
  pair(mallory.motebitId, w.id);
  const p = proof(alice);
  const prompt = `D ${crypto.randomUUID()}`;
  const r1 = await post(alice.motebitId, crypto.randomUUID(), await bearer(alice), w.id, prompt, p);
  const aliceTask = (JSON.parse(r1.text) as { task_id?: string }).task_id ?? "<none>";
  const r2 = await post(
    mallory.motebitId,
    crypto.randomUUID(),
    await bearer(mallory),
    w.id,
    prompt,
    p,
  );
  obs["D"] = {
    statuses: [r1.status, r2.status],
    second_code: r2.code ?? null,
    leaks_foreign_task_id: r2.text.includes(aliceTask),
    tasks: tasks(prompt),
    dispatches: w.dispatched(),
  };
});

it("F: a stranger submits the payer's public proof first, then the payer", async () => {
  const victim = await newAgent();
  const mallory = await newAgent();
  const w = await worker();
  pair(victim.motebitId, w.id);
  pair(mallory.motebitId, w.id);
  const p = proof(victim);
  const mPrompt = `F-mallory ${crypto.randomUUID()}`;
  const vPrompt = `F-victim ${crypto.randomUUID()}`;
  const rm = await post(
    mallory.motebitId,
    crypto.randomUUID(),
    await bearer(mallory),
    w.id,
    mPrompt,
    p,
  );
  const rv = await post(
    victim.motebitId,
    crypto.randomUUID(),
    await bearer(victim),
    w.id,
    vPrompt,
    p,
  );
  obs["F"] = {
    statuses: { attacker: rm.status, victim: rv.status },
    codes: { attacker: rm.code ?? null, victim: rv.code ?? null },
    tasks: { attacker: tasks(mPrompt), victim: tasks(vPrompt) },
    worker_receives: w
      .prompts()
      .map((x) => (x === mPrompt ? "MALLORY" : x === vPrompt ? "VICTIM" : "?")),
  };
});

it("E: four concurrent keys, one proof", async () => {
  const d = await newAgent();
  const w = await worker();
  pair(d.motebitId, w.id);
  const p = proof(d);
  const prompt = `E ${crypto.randomUUID()}`;
  const rs = await Promise.all(
    [0, 1, 2, 3].map(() => post(d.motebitId, crypto.randomUUID(), JSON_AUTH, w.id, prompt, p)),
  );
  obs["E"] = {
    statuses: rs.map((r) => r.status).sort(),
    tasks: tasks(prompt),
    dispatches: w.dispatched(),
  };
});
