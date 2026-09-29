/**
 * #890 round 6 — who may answer a task.
 *
 * The relay must record WHO it handed a task to, and every door a receipt
 * enters by — the result POST, the MCP forward, the federation result — must
 * accept a receipt for task X only from X's recorded executor (and, for a
 * federated result, only from the peer X was forwarded through). The archive
 * answers X only with that executor's depth-0 receipt, and a receipt nested
 * inside another task's tree never occupies or shadows it.
 *
 * Harness, through the REAL relay routes: a task X is admitted on the
 * delegator's OWN path (as both goal adapters submit) and routed by the relay
 * to worker W over its MCP endpoint. Then each door delivers each variant:
 *
 *   routed       W's signed receipt for X                    → accepted
 *   foreign      a receipt for X signed by another identity  → refused
 *   wrong_peer   W's receipt for X arriving from a peer X was never
 *                forwarded through (federation door only)   → refused
 *   nested_squat W's honest receipt for ANOTHER task T nests an unsigned child
 *                claiming (W, X, failed); then W's real receipt for X arrives
 *                                                            → the real one wins
 *   wrong_task   W's receipt that names another task, delivered for X
 *                                                            → refused
 *
 * Oracle over every cell, from everything the delegator can observe about X
 * (the socket push, the poll, the archive after the queue forgets X):
 *   ONLY THE EXECUTOR  every observed receipt for X is signed by W and bound to X;
 *   ANSWERED           a routed (or nested-then-routed) cell's archive answers
 *                      W's receipt — also when the settlement row names the
 *                      PATH agent, as the relay writes it (tasks.ts, #959).
 *
 * Plus the adopted-task probe: a planner that adopted X from a 409 (no routing
 * known) must not rotate — pay again — on a federation result forged for X.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation, receipt and envelope signing
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  sign,
  canonicalJson,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId, PlanStep, PlanId } from "@motebit/sdk";
import { StepStatus } from "@motebit/sdk";
import { RelayDelegationAdapter, DelegationUndeterminedError } from "@motebit/planner";
import { createTestRelay, createAgent, JSON_AUTH, AUTH_HEADER, API_TOKEN } from "./test-helpers.js";

const PORT = 18953;
type Door = "post" | "mcp" | "fed";
type Variant = "routed" | "foreign" | "wrong_peer" | "nested_squat" | "wrong_task";

// ── the worker's MCP endpoint: answers each presented task from a script ──

/** prompt → how W's endpoint answers the presented task (given its relay task id). */
const mcpReplies = new Map<string, (relayTaskId: string) => Promise<ExecutionReceipt | null>>();
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        res.setHeader("Content-Type", "application/json");
        let body: {
          method?: string;
          params?: { arguments?: { prompt?: string; relay_task_id?: string } };
        } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body;
        } catch {
          /* /health */
        }
        if (body.method === "tools/call") {
          const build = mcpReplies.get(body.params?.arguments?.prompt ?? "");
          const r = build != null ? await build(body.params?.arguments?.relay_task_id ?? "") : null;
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: r == null ? {} : { content: [{ type: "text", text: JSON.stringify(r) }] },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Agent {
  id: string;
  device: string;
  kp: KeyPair;
}

async function agent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { id: a.motebitId, device: a.deviceId, kp };
}

async function receiptBy(
  who: { id: string; device: string; kp: KeyPair },
  relayTaskId: string,
  status: "completed" | "failed",
  nested: ExecutionReceipt[] = [],
): Promise<ExecutionReceipt> {
  const now = Date.now();
  return signExecutionReceipt(
    {
      task_id: relayTaskId,
      relay_task_id: relayTaskId,
      motebit_id: who.id as MotebitId,
      device_id: who.device as DeviceId,
      submitted_at: now - 100,
      completed_at: now,
      status,
      result: status,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "p",
      result_hash: "r",
      ...(nested.length > 0 ? { delegation_receipts: nested } : {}),
    },
    who.kp.privateKey,
  ) as Promise<ExecutionReceipt>;
}

/** An UNSIGNED nested child claiming (motebitId, taskId, failed). */
function squatChild(motebitId: string, taskId: string): ExecutionReceipt {
  return {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: motebitId as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: Date.now() - 50,
    completed_at: Date.now(),
    status: "failed",
    result: "forged",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "AAAA",
  } as ExecutionReceipt;
}

interface World {
  relay: SyncRelay;
  D: Agent;
  W: Agent;
  E: Agent;
  frames: Array<{ task_id?: string; receipt?: ExecutionReceipt }>;
  peer: { id: string; kp: KeyPair };
  otherPeer: { id: string; kp: KeyPair };
}

async function world(): Promise<World> {
  const relay = await createTestRelay({ enableDeviceAuth: false });
  const D = await agent(relay);
  const W = await agent(relay);
  const E = await agent(relay);
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: W.id,
      endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
      capabilities: ["cap890"],
    }),
  });
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, 'verified', 10, ?, ?)`,
    )
    .run(D.id, W.id, Date.now(), Date.now());
  const frames: World["frames"] = [];
  relay.connections.set(D.id, [
    {
      ws: {
        readyState: 1,
        send: (m: string) => frames.push(JSON.parse(m) as World["frames"][number]),
        close: () => {},
      } as never,
      deviceId: "d-dev",
    },
  ]);
  const peer = { id: `peer-${crypto.randomUUID()}`, kp: await generateKeypair() };
  const otherPeer = { id: `peer-${crypto.randomUUID()}`, kp: await generateKeypair() };
  for (const p of [peer, otherPeer]) {
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at)
         VALUES (?, ?, ?, 'peer', 'active', ?)`,
      )
      .run(p.id, bytesToHex(p.kp.publicKey), `http://${p.id}.invalid`, Date.now());
  }
  return { relay, D, W, E, frames, peer, otherPeer };
}

async function admit(w: World, prompt: string): Promise<string> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ prompt, required_capabilities: ["cap890"], submitted_by: w.D.id }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  // The relay's MCP presentation is fire-and-forget: let it land.
  await new Promise((r) => setTimeout(r, 60));
  return task_id;
}

async function postResult(w: World, taskId: string, receipt: ExecutionReceipt): Promise<number> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  return res.status;
}

async function fedResult(
  w: World,
  from: { id: string; kp: KeyPair },
  taskId: string,
  receipt: ExecutionReceipt,
  agentKey?: string,
): Promise<number> {
  const payload = {
    task_id: taskId,
    origin_relay: from.id,
    receipt,
    ...(agentKey != null ? { agent_public_key: agentKey } : {}),
    timestamp: Date.now(),
  };
  const sig = await sign(new TextEncoder().encode(canonicalJson(payload)), from.kp.privateKey);
  const res = await w.relay.app.request("/federation/v1/task/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
  });
  return res.status;
}

async function observed(w: World, taskId: string): Promise<ExecutionReceipt[]> {
  const out: ExecutionReceipt[] = [];
  for (const f of w.frames) if (f.task_id === taskId && f.receipt != null) out.push(f.receipt);
  const poll = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}`, {
    headers: AUTH_HEADER,
  });
  if (poll.ok) {
    const body = (await poll.json()) as { receipt?: ExecutionReceipt | null };
    if (body.receipt != null) out.push(body.receipt);
  }
  return out;
}

async function archived(w: World, taskId: string): Promise<ExecutionReceipt | null> {
  // The queue forgets X (as it does minutes after a receipt).
  w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(taskId);
  // The relay's settlement row for a funded relay-mode task names the PATH
  // agent (tasks.ts, KNOWN RESIDUAL #959) — here the delegator.
  w.relay.moteDb.db
    .prepare(
      `INSERT OR IGNORE INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at)
       VALUES (?, ?, ?, ?, 'h', 0, 0, 'completed', ?)`,
    )
    .run(crypto.randomUUID(), crypto.randomUUID(), taskId, w.D.id, Date.now());
  const r = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}`, { headers: AUTH_HEADER });
  if (!r.ok) return null;
  return ((await r.json()) as { receipt?: ExecutionReceipt | null }).receipt ?? null;
}

const bound = (r: ExecutionReceipt): string =>
  (r as { relay_task_id?: string }).relay_task_id ?? r.task_id;

async function runCell(door: Door, variant: Variant): Promise<string[]> {
  const w = await world();
  const failures: string[] = [];
  try {
    const tag = crypto.randomUUID();
    let X: string;
    let expectArchive: "failed" | "completed" | null = null;

    const none = (): Promise<null> => Promise.resolve(null);
    if (variant === "wrong_peer" && door !== "fed") return [];
    if (variant === "routed" && door === "fed") return []; // X is routed locally; no peer may answer it
    const pX = `X ${tag}`;

    if (variant === "nested_squat") {
      // W answers ANOTHER task T honestly, nesting an unsigned child that
      // claims (W, X, failed); then X's real receipt arrives from W.
      mcpReplies.set(pX, none);
      X = await admit(w, pX);
      const pT = `T ${tag}`;
      const squatFor = (T: string) => receiptBy(w.W, T, "completed", [squatChild(w.W.id, X)]);
      if (door === "mcp") {
        mcpReplies.set(pT, squatFor);
        await admit(w, pT);
      } else {
        mcpReplies.set(pT, none);
        const T = await admit(w, pT);
        if (door === "post") await postResult(w, T, await squatFor(T));
        else await fedResult(w, w.peer, T, await squatFor(T));
      }
      await postResult(w, X, await receiptBy(w.W, X, "completed"));
      expectArchive = "completed";
    } else if (door === "mcp") {
      // The relay presents X to W's endpoint; W's endpoint answers.
      mcpReplies.set(pX, (id) => {
        if (variant === "routed") return receiptBy(w.W, id, "failed");
        if (variant === "foreign") return receiptBy(w.E, id, "failed");
        return receiptBy(w.W, `other-${id}`, "failed"); // wrong_task
      });
      X = await admit(w, pX);
      if (variant === "routed") expectArchive = "failed";
    } else {
      mcpReplies.set(pX, none);
      X = await admit(w, pX);
      if (variant === "routed") {
        await postResult(w, X, await receiptBy(w.W, X, "failed"));
        expectArchive = "failed";
      }
      if (variant === "foreign") {
        if (door === "post") await postResult(w, X, await receiptBy(w.E, X, "failed"));
        else {
          // A key the peer invents, forwarded as the "worker's" key.
          const kp = await generateKeypair();
          const forged = await receiptBy(
            { id: `evil-${tag}`, device: "evil-dev", kp },
            X,
            "failed",
          );
          await fedResult(w, w.peer, X, forged, bytesToHex(kp.publicKey));
        }
      }
      if (variant === "wrong_peer") {
        // W's own signed receipt — but X was never forwarded through this peer.
        const st = await fedResult(w, w.peer, X, await receiptBy(w.W, X, "failed"));
        if (st < 400)
          failures.push(`REFUSED: a result from a peer X never went through was accepted (${st})`);
      }
      if (variant === "wrong_task") {
        const r = await receiptBy(w.W, crypto.randomUUID(), "failed");
        if (door === "post") await postResult(w, X, r);
        else await fedResult(w, w.peer, X, r);
      }
    }

    for (const r of await observed(w, X)) {
      if (r.motebit_id !== w.W.id || bound(r) !== X) {
        failures.push(
          `ONLY THE EXECUTOR: observed ${r.status} receipt for ${bound(r)} signed by ${r.motebit_id === w.E.id ? "E" : r.motebit_id}`,
        );
      }
    }
    const a = await archived(w, X);
    if (a != null && (a.motebit_id !== w.W.id || bound(a) !== X)) {
      failures.push(`ONLY THE EXECUTOR: archive answered ${a.status} signed by ${a.motebit_id}`);
    }
    if (expectArchive != null && (a == null || a.status !== expectArchive)) {
      failures.push(
        `ANSWERED: archive gave ${a == null ? "404" : a.status}, expected ${expectArchive}`,
      );
    }
  } finally {
    await w.relay.close();
  }
  return failures;
}

describe("#890 r6 receipt doors — only a task's recorded executor may answer it", () => {
  it("door × variant, through the real relay routes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: string[] = [];
    for (const door of ["post", "mcp", "fed"] as Door[]) {
      for (const variant of [
        "routed",
        "foreign",
        "wrong_peer",
        "nested_squat",
        "wrong_task",
      ] as Variant[]) {
        for (const f of await runCell(door, variant)) failures.push(`${door}/${variant}: ${f}`);
      }
    }
    expect(failures, `${failures.length} failing`).toEqual([]);
  }, 120_000);
});

describe("#890 r6 adopted-task probe — a forged federation failure never rotates a planner", () => {
  it("a planner that adopted X from a 409 does not admit a second task on a forged failed result", async () => {
    const w = await world();
    try {
      mcpReplies.set("adopt", () => Promise.resolve(null));
      const X = await admit(w, "adopt");
      const listeners = new Set<(m: { type: string; [k: string]: unknown }) => void>();
      w.relay.connections.set(w.D.id, [
        {
          ws: {
            readyState: 1,
            send: (m: string) => {
              for (const l of listeners) l(JSON.parse(m) as { type: string });
            },
            close: () => {},
          } as never,
          deviceId: "d-dev",
        },
      ]);
      const posts: string[] = [];
      let first = true;
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        const path = String(input).replace("http://relay", "");
        if (init?.method === "POST") {
          posts.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          if (first) {
            first = false;
            // The relay says the key already admitted X (#888).
            return new Response(JSON.stringify({ code: "TASK_CONFLICT", task_id: X }), {
              status: 409,
            });
          }
        }
        return w.relay.app.request(path, init);
      });
      const adapter = new RelayDelegationAdapter({
        syncUrl: "http://relay",
        motebitId: w.D.id,
        authToken: async () => API_TOKEN,
        sendRaw: () => {},
        onCustomMessage: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        maxDelegationRetries: 1,
      });
      const step: PlanStep = {
        step_id: "s1",
        plan_id: "p1" as PlanId,
        ordinal: 0,
        description: "remote",
        prompt: "adopt",
        depends_on: [],
        optional: false,
        required_capabilities: ["cap890" as never],
        status: StepStatus.Pending,
        result_summary: null,
        error_message: null,
        tool_calls_made: 0,
        started_at: null,
        completed_at: null,
        retry_count: 0,
        updated_at: 0,
      };
      const p = adapter.delegateStep(step, 300);
      p.catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      // A peer invents a key and forges X's failure.
      const kp = await generateKeypair();
      const forged = await receiptBy({ id: "evil-probe", device: "evil-dev", kp }, X, "failed");
      await fedResult(w, w.peer, X, forged, bytesToHex(kp.publicKey));
      await p.catch((e: unknown) => e);
      const rotated = posts.filter((k) => !k.endsWith(":0"));
      expect(rotated, "a second task was bought on a forged failure").toEqual([]);
      await expect(p).rejects.toBeInstanceOf(DelegationUndeterminedError);
    } finally {
      vi.unstubAllGlobals();
      await w.relay.close();
    }
  }, 30_000);
});
