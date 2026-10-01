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
 *   bad_sig      a receipt for X naming W but not signed by W's key
 *                                                            → refused, and
 *                never stands as X's answer, not even mid-ingestion
 *
 * Federation door: X is forwarded to W through `peer` (the route the
 * relay's forward records), and every variant arrives as a peer-signed
 * result — `foreign` is a key the peer invents for an invented signer,
 * `wrong_peer` is W's own receipt arriving from `otherPeer`. Two more:
 *   local_task   X was routed LOCALLY (no peer on its route): any active
 *                peer's result for it — W's own, or an invented signer's
 *                with the key the peer supplies — is refused  (CONFIRMED 1)
 *   no_key       X forwarded to an executor this relay holds no key for; the
 *                peer supplies none — unverifiable, refused
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
  verifyExecutionReceipt,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId, PlanStep, PlanId } from "@motebit/sdk";
import { StepStatus } from "@motebit/sdk";
import { RelayDelegationAdapter, DelegationUndeterminedError } from "@motebit/planner";
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  AUTH_HEADER,
  API_TOKEN,
  walletOf,
  buildP2pPaymentProof,
} from "./test-helpers.js";
import {
  isRoutedExecutor,
  recordTaskRoute,
  cleanupTaskRoutes,
  TASK_ROUTE_RETENTION_MS,
  forwardTaskViaMcp,
} from "../task-routing.js";
import {
  persistReceiptChain,
  getStoredReceiptJson,
  getArchivedReceiptForKeyOwner,
} from "../receipts-store.js";
import { relayMigrations } from "../migrations.js";

const PORT = 18953;
type Door = "post" | "mcp" | "fed";
type Variant =
  | "routed"
  | "foreign"
  | "wrong_peer"
  | "nested_squat"
  | "wrong_task"
  | "bad_sig"
  | "local_task"
  | "no_key";

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
  server.closeAllConnections();
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

/** A receipt naming `who` but signed with another key. */
async function badSigBy(
  who: { id: string; device: string },
  relayTaskId: string,
): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  return receiptBy({ ...who, kp }, relayTaskId, "failed");
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

async function world(federation = false): Promise<World> {
  const relay = await createTestRelay({
    enableDeviceAuth: false,
    ...(federation
      ? { federation: { endpointUrl: "http://relay-890.test", displayName: "relay-890" } }
      : {}),
  });
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
  // Planted only where the settlement guards admit it (#890 r9: a task the
  // relay knows settles once, on its claimed receipt) — a stand-in.
  try {
    w.relay.moteDb.db
      .prepare(
        `INSERT OR IGNORE INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at)
         VALUES (?, ?, ?, ?, 'h', 0, 0, 'completed', ?)`,
      )
      .run(crypto.randomUUID(), crypto.randomUUID(), taskId, w.D.id, Date.now());
  } catch {
    /* refused by the settlement guards */
  }
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
    if (door !== "fed" && ["wrong_peer", "local_task", "no_key"].includes(variant)) return [];
    const pX = `X ${tag}`;
    /** The relay forwarded `id` to W through `peer` (what its forward records). */
    const forwarded = (id: string, executor = w.W.id): void =>
      recordTaskRoute(w.relay.moteDb.db, id, executor, w.peer.id);
    const refused = (st: number, what: string): void => {
      if (st < 400) failures.push(`REFUSED: ${what} was accepted (${st})`);
    };

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
        else {
          forwarded(T);
          await fedResult(w, w.peer, T, await squatFor(T));
        }
      }
      await postResult(w, X, await receiptBy(w.W, X, "completed"));
      expectArchive = "completed";
    } else if (door === "mcp") {
      // The relay presents X to W's endpoint; W's endpoint answers.
      mcpReplies.set(pX, (id) => {
        if (variant === "routed") return receiptBy(w.W, id, "failed");
        if (variant === "foreign") return receiptBy(w.E, id, "failed");
        if (variant === "bad_sig") return badSigBy(w.W, id);
        return receiptBy(w.W, `other-${id}`, "failed"); // wrong_task
      });
      X = await admit(w, pX);
      if (variant === "routed") expectArchive = "failed";
    } else if (door === "post") {
      mcpReplies.set(pX, none);
      X = await admit(w, pX);
      if (variant === "routed") {
        await postResult(w, X, await receiptBy(w.W, X, "failed"));
        expectArchive = "failed";
      }
      if (variant === "foreign") await postResult(w, X, await receiptBy(w.E, X, "failed"));
      if (variant === "wrong_task")
        await postResult(w, X, await receiptBy(w.W, crypto.randomUUID(), "failed"));
      if (variant === "bad_sig") await postResult(w, X, await badSigBy(w.W, X));
    } else {
      mcpReplies.set(pX, none);
      X = await admit(w, pX);
      const invented = async (): Promise<[ExecutionReceipt, string]> => {
        const kp = await generateKeypair();
        const r = await receiptBy({ id: `evil-${tag}`, device: "evil-dev", kp }, X, "failed");
        return [r, bytesToHex(kp.publicKey)];
      };
      if (variant === "local_task") {
        refused(
          await fedResult(w, w.peer, X, await receiptBy(w.W, X, "failed")),
          "a peer's result for a task routed locally",
        );
        const [r, key] = await invented();
        refused(await fedResult(w, w.peer, X, r, key), "a peer's invented signer for a local task");
      } else if (variant === "no_key") {
        const kp = await generateKeypair();
        const remote = { id: `remote-${tag}`, device: "remote-dev", kp };
        forwarded(X, remote.id);
        refused(
          await fedResult(w, w.peer, X, await receiptBy(remote, X, "failed")),
          "a federated receipt with no key to verify it",
        );
      } else {
        forwarded(X);
        if (variant === "routed") {
          expect(await fedResult(w, w.peer, X, await receiptBy(w.W, X, "failed"))).toBe(200);
          expectArchive = "failed";
        }
        if (variant === "foreign") {
          const [r, key] = await invented();
          refused(await fedResult(w, w.peer, X, r, key), "the routed peer's invented signer");
        }
        if (variant === "wrong_peer") {
          refused(
            await fedResult(w, w.otherPeer, X, await receiptBy(w.W, X, "failed")),
            "a result from a peer X was never forwarded through",
          );
        }
        if (variant === "wrong_task") {
          const r = await receiptBy(w.W, crypto.randomUUID(), "failed");
          refused(await fedResult(w, w.peer, X, r), "a receipt bound to another task");
        }
        if (variant === "bad_sig") {
          refused(await fedResult(w, w.peer, X, await badSigBy(w.W, X)), "a bad signature");
        }
      }
    }

    for (const r of await observed(w, X)) {
      if (r.motebit_id !== w.W.id || bound(r) !== X) {
        failures.push(
          `ONLY THE EXECUTOR: observed ${r.status} receipt for ${bound(r)} signed by ${r.motebit_id === w.E.id ? "E" : r.motebit_id}`,
        );
      } else if (!(await verifyExecutionReceipt(r, w.W.kp.publicKey))) {
        failures.push(`ONLY THE EXECUTOR: observed a receipt naming W that W's key did not sign`);
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
        "bad_sig",
        "local_task",
        "no_key",
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
      const realFetch = globalThis.fetch;
      let first = true;
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("http://relay")) return realFetch(input, init);
        const path = url.replace("http://relay", "");
        if (init?.method === "POST" && /\/agent\/[^/]+\/task$/.test(path)) {
          posts.push(new Headers(init.headers).get("idempotency-key") ?? "(no key)");
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

describe("#890 r6 admission is a route — the path agent's own devices answer its task", () => {
  it("a task the relay broadcast to its path agent's devices is answered by that agent, from the archive too", async () => {
    const w = await world();
    try {
      // No capability: nothing is ranked, the relay hands X to D's own devices.
      const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ prompt: "own devices", submitted_by: w.D.id }),
      });
      expect(res.status).toBe(201);
      const { task_id: X } = (await res.json()) as { task_id: string };
      expect(await postResult(w, X, await receiptBy(w.D, X, "completed"))).toBe(200);
      const a = await archived(w, X);
      expect(a?.motebit_id).toBe(w.D.id);
      expect(a?.status).toBe("completed");
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r6 the routing record's only exception is a task admitted before it existed", () => {
  let relay: SyncRelay;
  beforeAll(async () => {
    relay = await createTestRelay();
  });
  afterAll(async () => {
    await relay.close();
  });
  const epoch = (): number =>
    (
      relay.moteDb.db
        .prepare("SELECT applied_at FROM relay_schema_migrations WHERE version = 50")
        .get() as { applied_at: number }
    ).applied_at;

  it("with no route, a task admitted BEFORE the record is answerable by its own agent, locally", () => {
    const before = { executor: "agent-x", submittedAt: epoch() - 1 };
    expect(isRoutedExecutor(relay.moteDb.db, "legacy-1", "agent-x", "", before, "admission")).toBe(
      true,
    );
    expect(isRoutedExecutor(relay.moteDb.db, "legacy-1", "stranger", "", before, "admission")).toBe(
      false,
    );
    expect(
      isRoutedExecutor(relay.moteDb.db, "legacy-1", "agent-x", "some-peer", before, "admission"),
    ).toBe(false);
  });

  it("with no route, a task admitted AFTER the record is answerable by no one", () => {
    const after = { executor: "agent-x", submittedAt: epoch() + 1 };
    expect(isRoutedExecutor(relay.moteDb.db, "unrouted-1", "agent-x", "", after, "admission")).toBe(
      false,
    );
  });

  it("a route admits its executor through its peer, and nobody else", () => {
    recordTaskRoute(relay.moteDb.db, "routed-1", "worker-w", "peer-p");
    expect(
      isRoutedExecutor(relay.moteDb.db, "routed-1", "worker-w", "peer-p", null, "admission"),
    ).toBe(true);
    expect(isRoutedExecutor(relay.moteDb.db, "routed-1", "worker-w", "", null, "admission")).toBe(
      false,
    );
    expect(
      isRoutedExecutor(relay.moteDb.db, "routed-1", "worker-w", "peer-q", null, "admission"),
    ).toBe(false);
    expect(
      isRoutedExecutor(relay.moteDb.db, "routed-1", "worker-e", "peer-p", null, "admission"),
    ).toBe(false);
  });
});

describe("#890 r7 a route answers only the task of its own origin", () => {
  let relay: SyncRelay;
  beforeAll(async () => {
    relay = await createTestRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  it("an inbound forward's route never answers an own admission, and an admission's never an inbound task", () => {
    const db = relay.moteDb.db;
    recordTaskRoute(db, "origin-1", "agent-t", "", "inbound_forward");
    recordTaskRoute(db, "origin-1", "agent-w");
    expect(isRoutedExecutor(db, "origin-1", "agent-t", "", null, "admission")).toBe(false);
    expect(isRoutedExecutor(db, "origin-1", "agent-t", "", null, "inbound_forward")).toBe(true);
    expect(isRoutedExecutor(db, "origin-1", "agent-w", "", null, "admission")).toBe(true);
    expect(isRoutedExecutor(db, "origin-1", "agent-w", "", null, "inbound_forward")).toBe(false);
    const origins = db
      .prepare(
        "SELECT executor_id, origin FROM relay_task_routes WHERE task_id = 'origin-1' ORDER BY executor_id",
      )
      .all();
    expect(origins).toEqual([
      { executor_id: "agent-t", origin: "inbound_forward" },
      { executor_id: "agent-w", origin: "admission" },
    ]);
  });

  it("a pre-v50 task with only an inbound route of a re-used id is still answered by its own agent, and never by the inbound executor", () => {
    const db = relay.moteDb.db;
    const epoch = (
      db.prepare("SELECT applied_at FROM relay_schema_migrations WHERE version = 50").get() as {
        applied_at: number;
      }
    ).applied_at;
    recordTaskRoute(db, "legacy-2", "agent-t", "", "inbound_forward");
    const legacy = { executor: "agent-x", submittedAt: epoch - 1 };
    expect(isRoutedExecutor(db, "legacy-2", "agent-x", "", legacy, "admission")).toBe(true);
    expect(isRoutedExecutor(db, "legacy-2", "agent-t", "", legacy, "admission")).toBe(false);
  });
});

describe("#890 r7 the inbound door refuses an id held in ANY single local store", () => {
  it("queue, admission route, Idempotency-Key, archived receipt — each alone refuses a peer's colliding forward (409)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world(true);
    try {
      const db = w.relay.moteDb.db;
      await w.relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: w.E.id,
          endpoint_url: "http://e.invalid/mcp",
          capabilities: [],
        }),
      });
      const answers: Record<string, number> = {};
      // queue alone: an inbound task `peer` forwarded, its route swept.
      const Q = crypto.randomUUID();
      expect(await fedForward(w, w.peer, Q, w.W.id)).toBeLessThan(300);
      db.prepare("DELETE FROM relay_task_routes WHERE task_id = ?").run(Q);
      answers.queue = await fedForward(w, w.otherPeer, Q, w.E.id);
      // an own admission's route alone.
      const R = crypto.randomUUID();
      recordTaskRoute(db, R, w.W.id);
      answers.route = await fedForward(w, w.otherPeer, R, w.E.id);
      // an Idempotency-Key alone.
      const K = crypto.randomUUID();
      db.prepare(
        `INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, response_status, response_body, created_at, completed_at, task_id)
         VALUES (?, ?, 'completed', 201, '{}', ?, ?, ?)`,
      ).run(crypto.randomUUID(), w.D.id, Date.now(), Date.now(), K);
      answers.key = await fedForward(w, w.otherPeer, K, w.E.id);
      // an archived top-level receipt alone.
      const A = crypto.randomUUID();
      persistReceiptChain(db, await receiptBy(w.W, A, "completed"));
      answers.receipt = await fedForward(w, w.otherPeer, A, w.E.id);
      // a fresh id is admitted; the same peer re-forwarding it (queued, then
      // forgotten by the queue) is its retry — held, never run twice.
      const F = crypto.randomUUID();
      answers.fresh = await fedForward(w, w.peer, F, w.W.id);
      const rq = await fedForwardBody(w, w.peer, F, w.W.id);
      answers.retry_queued = rq.status;
      // The same id from ANOTHER peer while queued is a collision, not a retry.
      const oq = await fedForwardBody(w, w.otherPeer, F, w.E.id);
      answers.other_peer_queued = oq.status;
      db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(F);
      const rf = await fedForwardBody(w, w.peer, F, w.W.id);
      answers.retry_forgotten = rf.status;
      expect({ rq: rq.body, oq: oq.body, rf: rf.body }).toEqual({
        rq: "duplicate",
        oq: "rejected",
        rf: "duplicate",
      });
      expect(answers).toEqual({
        queue: 409,
        route: 409,
        key: 409,
        receipt: 409,
        fresh: 202,
        retry_queued: 409,
        other_peer_queued: 409,
        retry_forgotten: 409,
      });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r7 migration v51 — existing v50 routes keep answering their owners", () => {
  it("over a pre-v51 table: own-admission rows become 'admission', a still-queued inbound row 'inbound_forward'", async () => {
    const relay = await createTestRelay();
    try {
      const db = relay.moteDb.db;
      // Rebuild relay_task_routes as v50 left it (no origin column).
      db.exec("DROP TABLE relay_task_routes");
      relayMigrations.find((m) => m.version === 50)!.up(db);
      const cols = (
        db.prepare("PRAGMA table_info(relay_task_routes)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).not.toContain("origin");
      const X = crypto.randomUUID();
      const V = { id: `v-${crypto.randomUUID()}`, device: "v-dev", kp: await generateKeypair() };
      db.prepare(
        "INSERT INTO relay_task_routes (task_id, executor_id, via_peer, created_at) VALUES (?, ?, '', ?)",
      ).run(X, V.id, Date.now());
      db.prepare(
        "INSERT INTO relay_task_routes (task_id, executor_id, via_peer, created_at) VALUES (?, 'fed-w', 'peer-p', ?)",
      ).run(X, Date.now());
      // An inbound forward still queued: its route is identifiable.
      const I = crypto.randomUUID();
      db.prepare(
        "INSERT INTO relay_task_routes (task_id, executor_id, via_peer, created_at) VALUES (?, 'inbound-t', '', ?)",
      ).run(I, Date.now());
      db.prepare(
        `INSERT INTO relay_task_queue (task_id, submitter_id, worker_id, status, prompt, created_at, expires_at, task_json)
         VALUES (?, 'relay:p', 'inbound-t', 'pending', 'p', ?, ?, ?)`,
      ).run(
        I,
        Date.now(),
        Date.now() + 60_000,
        JSON.stringify({ task: { task_id: I, motebit_id: "inbound-t" }, origin_relay: "peer-p" }),
      );
      relayMigrations.find((m) => m.version === 51)!.up(db);
      expect(
        db
          .prepare(
            "SELECT task_id, executor_id, origin FROM relay_task_routes ORDER BY executor_id",
          )
          .all(),
      ).toEqual([
        { task_id: X, executor_id: "fed-w", origin: "admission" },
        { task_id: I, executor_id: "inbound-t", origin: "inbound_forward" },
        { task_id: X, executor_id: V.id, origin: "admission" },
      ]);
      // The owner's archive still answers its recorded executor.
      db.prepare(
        `INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, response_status, response_body, created_at, completed_at, task_id)
         VALUES (?, 'owner', 'completed', 201, '{}', ?, ?, ?)`,
      ).run(crypto.randomUUID(), Date.now(), Date.now(), X);
      persistReceiptChain(db, await receiptBy(V, X, "completed"));
      const a = getArchivedReceiptForKeyOwner(db, "owner", X, 0);
      expect((JSON.parse(a!) as ExecutionReceipt).motebit_id).toBe(V.id);
    } finally {
      await relay.close();
    }
  });
});

describe("#890 r6 (D) a nested child never occupies a top-level key — and is not lost either", () => {
  let relay: SyncRelay;
  beforeAll(async () => {
    relay = await createTestRelay();
  });
  afterAll(async () => {
    await relay.close();
  });
  const rows = (motebitId: string, like: string) =>
    relay.moteDb.db
      .prepare(
        "SELECT task_id, depth, status FROM relay_receipts WHERE motebit_id = ? AND task_id LIKE ? ORDER BY depth",
      )
      .all(motebitId, like) as Array<{ task_id: string; depth: number; status: string }>;

  it("a child arriving AFTER V's own top-level receipt for X is kept under its namespaced key", async () => {
    const V = { id: `v-${crypto.randomUUID()}`, device: "v-dev", kp: await generateKeypair() };
    const P = { id: `p-${crypto.randomUUID()}`, device: "p-dev", kp: await generateKeypair() };
    const X = crypto.randomUUID();
    const T = crypto.randomUUID();
    persistReceiptChain(relay.moteDb.db, await receiptBy(V, X, "completed"));
    persistReceiptChain(relay.moteDb.db, await receiptBy(P, T, "completed", [squatChild(V.id, X)]));
    expect(rows(V.id, `${X}%`)).toEqual([
      { task_id: X, depth: 0, status: "completed" },
      { task_id: `${X}#nested:${T}`, depth: 1, status: "failed" },
    ]);
  });

  it("a child arriving BEFORE V's own receipt moves aside when it arrives", async () => {
    const V = { id: `v-${crypto.randomUUID()}`, device: "v-dev", kp: await generateKeypair() };
    const P = { id: `p-${crypto.randomUUID()}`, device: "p-dev", kp: await generateKeypair() };
    const X = crypto.randomUUID();
    const T = crypto.randomUUID();
    persistReceiptChain(relay.moteDb.db, await receiptBy(P, T, "completed", [squatChild(V.id, X)]));
    expect(persistReceiptChain(relay.moteDb.db, await receiptBy(V, X, "completed"))).toBe(true);
    expect(rows(V.id, `${X}%`)).toEqual([
      { task_id: X, depth: 0, status: "completed" },
      { task_id: `${X}#nested:${T}`, depth: 1, status: "failed" },
    ]);
  });
});

describe("#890 r6 (A) every hand-off records its executor — a pinned paid task", () => {
  async function pinnedWorld(): Promise<{
    w: World;
    submit: (prompt: string, presenter?: "submitter") => Promise<Response>;
  }> {
    const w = await world();
    const addr = walletOf(bytesToHex(w.W.kp.publicKey));
    await w.relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: w.W.id,
        endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
        capabilities: ["cap890"],
        settlement_address: addr,
        settlement_modes: "relay,p2p",
      }),
    });
    await w.relay.app.request(`/api/v1/agents/${w.W.id}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["cap890"],
        pricing: [{ capability: "cap890", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "pinned",
        pay_to_address: addr,
      }),
    });
    const submit = async (prompt: string, presenter?: "submitter"): Promise<Response> => {
      const proof = buildP2pPaymentProof(w.relay, {
        workerAddress: addr,
        unitCostMicro: 500_000,
      });
      return w.relay.app.request(`/agent/${w.D.id}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": proof.tx_hash },
        body: JSON.stringify({
          prompt,
          submitted_by: w.D.id,
          target_agent: w.W.id,
          settlement_mode: "p2p",
          payment_proof: proof,
          required_capabilities: ["cap890"],
          delegator_acknowledges_no_history_risk: true,
          ...(presenter != null ? { presenter } : {}),
        }),
      });
    };
    return { w, submit };
  }

  it("dispatched to the pinned worker's socket: that worker answers it", async () => {
    const { w, submit } = await pinnedWorld();
    try {
      const sent: string[] = [];
      w.relay.connections.set(w.W.id, [
        {
          ws: { readyState: 1, send: (m: string) => sent.push(m), close: () => {} } as never,
          deviceId: "w-dev",
          capabilities: ["cap890"],
        },
      ]);
      const res = await submit("pinned socket");
      expect(res.status, await res.clone().text()).toBe(201);
      const { task_id: X } = (await res.json()) as { task_id: string };
      expect(sent.some((m) => m.includes(X))).toBe(true);
      expect(await postResult(w, X, await receiptBy(w.W, X, "completed"))).toBe(200);
    } finally {
      await w.relay.close();
    }
  });

  it("presented by its submitter (presenter: submitter): the worker the token binds answers it", async () => {
    const { w, submit } = await pinnedWorld();
    try {
      const res = await submit("submitter presents", "submitter");
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as { task_id: string; dispatch_token?: string };
      expect(typeof body.dispatch_token).toBe("string");
      expect(
        await postResult(w, body.task_id, await receiptBy(w.W, body.task_id, "completed")),
      ).toBe(200);
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r6 routes are swept past their horizon; legacy nested rows never answer", () => {
  let relay: SyncRelay;
  beforeAll(async () => {
    relay = await createTestRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  it("a route older than TASK_ROUTE_RETENTION_MS is swept; a fresh one — and one inside the idempotency window — stays", () => {
    const db = relay.moteDb.db;
    const now = Date.now();
    const insert = (task: string, at: number) =>
      db
        .prepare(
          "INSERT INTO relay_task_routes (task_id, executor_id, via_peer, created_at) VALUES (?, 'w', '', ?)",
        )
        .run(task, at);
    insert("route-old", now - TASK_ROUTE_RETENTION_MS - 1);
    insert("route-day", now - 25 * 60 * 60 * 1000);
    insert("route-new", now);
    expect(TASK_ROUTE_RETENTION_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(cleanupTaskRoutes(db, now)).toBe(1);
    const left = (
      db
        .prepare(
          "SELECT task_id FROM relay_task_routes WHERE task_id LIKE 'route-%' ORDER BY task_id",
        )
        .all() as Array<{ task_id: string }>
    ).map((r) => r.task_id);
    expect(left).toEqual(["route-day", "route-new"]);
  });

  it("a legacy nested row at a task's plain key is never the archive's answer, and an audit read prefers the top-level receipt", async () => {
    const db = relay.moteDb.db;
    const V = { id: `v-${crypto.randomUUID()}`, device: "v-dev", kp: await generateKeypair() };
    const X = crypto.randomUUID();
    // A pre-v50 squat: an unsigned nested child claiming (V, X) at the plain key.
    const squat = squatChild(V.id, X);
    db.prepare(
      `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite, public_key, signature, invocation_origin, receipt_json, received_at)
       VALUES (?, ?, 'legacy-parent', 1, 'failed', 'motebit-jcs-ed25519-b64-v1', '', 'AAAA', NULL, ?, ?)`,
    ).run(V.id, X, JSON.stringify(squat), Date.now());
    db.prepare(
      `INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, response_status, response_body, created_at, completed_at, task_id)
       VALUES (?, 'owner', 'completed', 201, '{}', ?, ?, ?)`,
    ).run(crypto.randomUUID(), Date.now(), Date.now(), X);
    recordTaskRoute(db, X, V.id);
    expect(getArchivedReceiptForKeyOwner(db, "owner", X, 0)).toBeNull();

    // A task whose own top-level receipt AND a nested copy are archived:
    // the audit read serves the top-level one.
    const Y = crypto.randomUUID();
    const P = { id: `p-${crypto.randomUUID()}`, device: "p-dev", kp: await generateKeypair() };
    persistReceiptChain(
      db,
      await receiptBy(P, crypto.randomUUID(), "completed", [squatChild(V.id, Y)]),
    );
    persistReceiptChain(db, await receiptBy(V, Y, "completed"));
    const served = JSON.parse(getStoredReceiptJson(db, V.id, Y)!) as ExecutionReceipt;
    expect(served.status).toBe("completed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #890 round 7 — the COLLISION dimension.
//
// A task id is relay-minted: a federation peer never gets to choose one that
// already means something here. Round 6's inbound door refused a colliding
// forward only while the id sat in the task queue — routes, keys and
// receipts outlive the queue — and the archive answered ANY recorded
// executor's receipt, including the one a peer's inbound forward recorded.
//
// Dimension, through the real relay routes: every way a task id reaches this
// relay × every local state of that id × every receipt door.
//
//   way    ranked      own admission, ranked to W over its MCP endpoint
//          pinned      own admission, pinned P2P to W (the relay presents it)
//          submitter   own admission, pinned P2P, presented by its submitter
//          fed_p2p     own admission, pinned P2P, forwarded to W via `peer`
//          fed_ranked  own admission, no local worker, forwarded to a
//                      remote R via `peer`
//          inbound     `peer` forwarded the task here, to local agent W
//   (the two outbound federated ways are recorded by the route their forward
//   writes — `recordTaskRoute(X, executor, peer)` — as the r6 harness does.)
//   state  queued      X is in the task queue
//          expired     the queue forgot X; its routes (and key) remain
//          completed   X's routed executor answered it; the queue forgot X
//          key_only    only X's Idempotency-Key row remains
//   door   post        T (a local agent the attacker controls) POSTs its
//                      signed receipt for X, then the owner's live view
//          mcp         W's pending MCP presentation answers with T's receipt
//          fed         `otherPeer` delivers T's receipt for X
//          archive     T POSTs; the owner polls after the queue forgets X
//
// The attack in every cell: `otherPeer` forwards {task_id: X, target: T}.
// Oracle:
//   REFUSED      the colliding forward is answered 409 (never 2xx);
//   OWNER'S OWN  nothing the owner observes about X (socket push, live poll,
//                archive) is signed by an executor not recorded under the
//                owner's own admission — never T. For `inbound`, the owner is
//                the origin peer: T's receipt is refused at every door.
// ───────────────────────────────────────────────────────────────────────────

type Way = "ranked" | "pinned" | "submitter" | "fed_p2p" | "fed_ranked" | "inbound";
type IdState = "queued" | "expired" | "completed" | "key_only";
type CDoor = "post" | "mcp" | "fed" | "archive";

async function registerPinned(w: World): Promise<string> {
  const addr = walletOf(bytesToHex(w.W.kp.publicKey));
  await w.relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: w.W.id,
      endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
      capabilities: ["cap890"],
      settlement_address: addr,
      settlement_modes: "relay,p2p",
    }),
  });
  await w.relay.app.request(`/api/v1/agents/${w.W.id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["cap890"],
      pricing: [{ capability: "cap890", unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "pinned",
      pay_to_address: addr,
    }),
  });
  return addr;
}

async function submitPinned(
  w: World,
  addr: string,
  prompt: string,
  presenter?: "submitter",
): Promise<Response> {
  const proof = buildP2pPaymentProof(w.relay, { workerAddress: addr, unitCostMicro: 500_000 });
  return w.relay.app.request(`/agent/${w.D.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": proof.tx_hash },
    body: JSON.stringify({
      prompt,
      submitted_by: w.D.id,
      target_agent: w.W.id,
      settlement_mode: "p2p",
      payment_proof: proof,
      required_capabilities: ["cap890"],
      delegator_acknowledges_no_history_risk: true,
      ...(presenter != null ? { presenter } : {}),
    }),
  });
}

/** A peer-signed inbound forward of `taskId` to local agent `target`. */
async function fedForward(
  w: World,
  from: { id: string; kp: KeyPair },
  taskId: string,
  target: string,
): Promise<number> {
  return (await fedForwardBody(w, from, taskId, target)).status;
}

/** The forward's HTTP status and its body's `status` ("duplicate", "rejected", …). */
async function fedForwardBody(
  w: World,
  from: { id: string; kp: KeyPair },
  taskId: string,
  target: string,
): Promise<{ status: number; body: string }> {
  const payload = {
    task_id: taskId,
    origin_relay: from.id,
    target_agent: target,
    task_payload: { prompt: `forwarded ${taskId}` },
    timestamp: Date.now(),
  };
  const sig = await sign(new TextEncoder().encode(canonicalJson(payload)), from.kp.privateKey);
  const res = await w.relay.app.request("/federation/v1/task/forward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  return { status: res.status, body: body.status ?? "" };
}

async function postResultAs(
  w: World,
  pathAgent: string,
  taskId: string,
  receipt: ExecutionReceipt,
): Promise<number> {
  const res = await w.relay.app.request(`/agent/${pathAgent}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  return res.status;
}

/** What the owner D sees of X right now: its socket pushes and its live poll. */
async function liveView(w: World, taskId: string): Promise<ExecutionReceipt[]> {
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

/** The owner's poll once the queue has forgotten X: the archive's answer. */
async function archiveView(w: World, taskId: string): Promise<ExecutionReceipt | null> {
  w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(taskId);
  const r = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}`, { headers: AUTH_HEADER });
  if (!r.ok) return null;
  return ((await r.json()) as { receipt?: ExecutionReceipt | null }).receipt ?? null;
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One cell. `null` = the door does not exist for this way (not counted). */
async function collisionCell(
  way: Way,
  state: IdState,
  door: CDoor,
  bypass = false,
): Promise<string[] | null> {
  if (way === "inbound" && state === "key_only") return null; // an inbound id has no key here
  if (way === "inbound" && bypass) return null; // an inbound task has no owner's admission
  if (way === "inbound" && door !== "post") return null; // T's local POST is its only door
  const w = await world(true);
  const failures: string[] = [];
  let release: () => void = () => {};
  try {
    const db = w.relay.moteDb.db;
    const T = await agent(w.relay); // the attacker's local agent
    await w.relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: T.id,
        endpoint_url: "http://t.invalid/mcp",
        capabilities: [],
      }),
    });
    const R = { id: `remote-${crypto.randomUUID()}`, device: "r-dev", kp: await generateKeypair() };
    const tag = crypto.randomUUID();
    const pX = `C ${tag}`;
    // W's MCP endpoint holds its answer until the attack has happened; for
    // the mcp door that answer is T's receipt, relayed by W's endpoint.
    const gate = new Promise<void>((r) => (release = r));
    let presented = false;
    mcpReplies.set(pX, async (id) => {
      presented = true;
      await gate;
      return door === "mcp" ? receiptBy(T, id, "failed") : null;
    });

    // ── the way X reached this relay ──
    let X: string;
    let executor: Agent | typeof R = w.W;
    let viaPeer = "";
    if (way === "ranked") {
      X = await admit(w, pX);
    } else if (way === "inbound") {
      X = crypto.randomUUID();
      const st = await fedForward(w, w.peer, X, w.W.id);
      if (st >= 300) failures.push(`SETUP: inbound forward answered ${st}`);
    } else if (way === "fed_ranked") {
      const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ prompt: pX, submitted_by: w.D.id }),
      });
      X = ((await res.json()) as { task_id: string }).task_id;
      recordTaskRoute(db, X, R.id, w.peer.id);
      executor = R;
      viaPeer = w.peer.id;
    } else {
      const addr = await registerPinned(w);
      const res = await submitPinned(w, addr, pX, way === "submitter" ? "submitter" : undefined);
      if (res.status !== 201) failures.push(`SETUP: pinned submit answered ${res.status}`);
      X = ((await res.json()) as { task_id: string }).task_id;
      await settle(60);
      if (way === "fed_p2p") {
        recordTaskRoute(db, X, w.W.id, w.peer.id);
        // The forward's admission names the peer it went through.
        db.prepare(
          `UPDATE relay_task_queue SET task_json = json_set(task_json, '$.p2p_admission.planned_peer', ?) WHERE task_id = ?`,
        ).run(w.peer.id, X);
        viaPeer = w.peer.id;
      }
    }

    // ── the local state of X ──
    if (state === "completed") {
      const r = await receiptBy(executor, X, "completed");
      const st =
        viaPeer === ""
          ? way === "inbound"
            ? await postResultAs(w, w.W.id, X, r)
            : await postResultAs(w, w.D.id, X, r)
          : await fedResult(w, w.peer, X, r, bytesToHex(executor.kp.publicKey));
      if (st !== 200) failures.push(`SETUP: the routed executor's receipt answered ${st}`);
    }
    if (state !== "queued") db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
    if (state === "key_only") {
      db.prepare("DELETE FROM relay_task_routes WHERE task_id = ?").run(X);
    }

    // ── the attack: another peer re-uses X for the attacker's agent ──
    if (!bypass) {
      const fwd = await fedForward(w, w.otherPeer, X, T.id);
      if (fwd !== 409) failures.push(`REFUSED: the colliding forward answered ${fwd}`);
    } else {
      // Defence in depth: the inbound door let the collision through anyway
      // — the route an inbound forward writes for T sits beside X's own.
      recordTaskRoute(db, X, T.id, "", "inbound_forward");
    }

    // T answers through `door` — a FAILED receipt, which makes a planner pay
    // again; in the completed state a COMPLETED one (it would outrank).
    const tStatus = state === "completed" ? "completed" : "failed";
    const tReceipt = await receiptBy(T, X, tStatus);
    if (bypass && door === "archive") {
      // T's receipt sits in the archive, as the door of its inbound task
      // would have archived it.
      persistReceiptChain(db, tReceipt);
    } else if (door === "post" || door === "archive") {
      const st = await postResultAs(w, T.id, X, tReceipt);
      if (way === "inbound" && st < 400) {
        failures.push(`OWNER'S OWN: T's receipt for the inbound task was accepted (${st})`);
      }
      if (way !== "inbound") await postResultAs(w, w.D.id, X, tReceipt);
    } else if (door === "mcp") {
      if (!presented) {
        release();
        return null; // this way has no relay MCP presentation
      }
    } else {
      await fedResult(w, w.otherPeer, X, tReceipt, bytesToHex(T.kp.publicKey));
    }
    release();
    await settle();

    if (way !== "inbound") {
      const seen = door === "archive" ? [await archiveView(w, X)] : await liveView(w, X);
      for (const r of seen) {
        if (r != null && r.motebit_id === T.id) {
          failures.push(`OWNER'S OWN: the owner was answered T's ${r.status} receipt`);
        }
      }
    }
  } finally {
    release();
    await w.relay.close();
  }
  return failures;
}

describe("#890 r7 collision dimension — a re-used task id never answers its owner", () => {
  it("way × state × door, through the real relay routes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: string[] = [];
    let cells = 0;
    const failingCells = new Set<string>();
    for (const way of [
      "ranked",
      "pinned",
      "submitter",
      "fed_p2p",
      "fed_ranked",
      "inbound",
    ] as Way[]) {
      for (const state of ["queued", "expired", "completed", "key_only"] as IdState[]) {
        for (const door of ["post", "mcp", "fed", "archive"] as CDoor[]) {
          for (const bypass of [false, true]) {
            const f = await collisionCell(way, state, door, bypass);
            if (f == null) continue;
            cells++;
            const cell = `${bypass ? "bypass:" : ""}${way}/${state}/${door}`;
            for (const m of f) {
              failures.push(`${cell}: ${m}`);
              failingCells.add(cell);
            }
          }
        }
      }
    }
    expect(failures, `${failingCells.size}/${cells} cells failing`).toEqual([]);
  }, 600_000);
});

describe("#890 r7 the reviewer's probe — a re-used id answered by a foreign executor never rotates a planner", () => {
  it("D's expired X, re-forwarded by a peer to T, answered FAILED by T: D's poll holds and the adapter never buys again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world(true);
    try {
      const T = await agent(w.relay);
      await w.relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: T.id,
          endpoint_url: "http://t.invalid/mcp",
          capabilities: [],
        }),
      });
      // D submits X; the relay ranks W and presents it over MCP; W never answers.
      mcpReplies.set("probe r7", () => Promise.resolve(null));
      const X = await admit(w, "probe r7");
      // The queue expires X: D's poll is a 404 (hold).
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
      const before = await w.relay.app.request(`/agent/${w.D.id}/task/${X}`, {
        headers: AUTH_HEADER,
      });
      expect(before.status).toBe(404);
      // A peer forwards {task_id: X, target_agent: T}.
      const fwd = await fedForward(w, w.peer, X, T.id);
      // T POSTs a signed FAILED receipt for X.
      const tPost = await postResultAs(w, T.id, X, await receiptBy(T, X, "failed"));
      // The queue forgets the forwarded entry too (its TTL).
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
      const poll = await w.relay.app.request(`/agent/${w.D.id}/task/${X}`, {
        headers: AUTH_HEADER,
      });
      const polled = poll.ok
        ? ((await poll.json()) as { receipt?: ExecutionReceipt | null }).receipt
        : null;

      // A RelayDelegationAdapter that adopted X from a 409 (#888, no routing_choice).
      const posts: string[] = [];
      const realFetch = globalThis.fetch;
      let first = true;
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("http://relay")) return realFetch(input, init);
        const path = url.replace("http://relay", "");
        if (init?.method === "POST" && /\/agent\/[^/]+\/task$/.test(path)) {
          posts.push(new Headers(init.headers).get("idempotency-key") ?? "(no key)");
          if (first) {
            first = false;
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
        onCustomMessage: () => () => {},
        maxDelegationRetries: 1,
      });
      const step: PlanStep = {
        step_id: "s1",
        plan_id: "p1" as PlanId,
        ordinal: 0,
        description: "remote",
        prompt: "probe r7",
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
      const outcome = await adapter.delegateStep(step, 100).catch((e: unknown) => e);
      vi.unstubAllGlobals();

      expect({
        forward: fwd,
        tPost,
        polledSigner: polled?.motebit_id === T.id ? "T" : (polled?.motebit_id ?? null),
        rotated: posts.filter((k) => !k.endsWith(":0")),
        undetermined: outcome instanceof DelegationUndeterminedError,
      }).toEqual({ forward: 409, tPost: 404, polledSigner: null, rotated: [], undetermined: true });
    } finally {
      vi.unstubAllGlobals();
      await w.relay.close();
    }
  }, 30_000);
});

describe("#890 r7 (P1) a late MCP answer never overwrites a settled task's receipt", () => {
  it("after W's POSTed receipt settles X, W's endpoint answering later with an unverified receipt changes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let answered = false;
      mcpReplies.set("late p1", async (id) => {
        await gate;
        answered = true;
        // Names W, bound to X — but not signed by W's key.
        return badSigBy(w.W, id);
      });
      const X = await admit(w, "late p1");
      expect(await postResult(w, X, await receiptBy(w.W, X, "completed"))).toBe(200);
      release();
      for (let i = 0; i < 50 && !answered; i++) await settle(20);
      await settle(100);
      const poll = await w.relay.app.request(`/agent/${w.D.id}/task/${X}`, {
        headers: AUTH_HEADER,
      });
      const body = (await poll.json()) as { receipt?: ExecutionReceipt | null };
      expect(answered).toBe(true);
      expect(body.receipt?.status).toBe("completed");
      expect(await verifyExecutionReceipt(body.receipt!, w.W.kp.publicKey)).toBe(true);
    } finally {
      await w.relay.close();
    }
  }, 30_000);
});

// ── #890 round 8 — the ANSWER dimension: one chokepoint decides a task's answer ──
//
// door (result POST, MCP forward, federation result)
//   × entry state (unsettled; settled by W's completed / failed over the POST;
//     settled by W's completed over the MCP forward; answered-not-settled by
//     W's completed through the peer; settled then evicted to the archive)
//   × signer (W the routed executor; W2 a second recorded executor — the
//     ranking fan-out records several local picks and one federated route;
//     E a foreign identity; a bad signature naming W; D the delegator's own
//     device — its admission route makes it a recorded executor; a receipt
//     POSTed under the master token by an identity with no key on file)
//   × receipt status (completed, failed).
//
// Oracles, per cell:
//   (1) WRITE-ONCE   the poll answer after the door is the answer before it,
//                    except: an unanswered entry takes an accepted receipt,
//                    and a settled `failed` is replaced by a verified
//                    `completed` from a recorded executor (the archive's
//                    completed-outranks-failed rule, applied identically);
//   (2) ONE KEY      a planner that adopted X (409 naming X) never submits a
//                    second Idempotency-Key while X's answer is `completed`
//                    or undetermined (a `failed` answer from a recorded
//                    executor is positive evidence: its rotation is owed);
//   (3) POSITIVE     a door (POST, federation) reports acceptance (2xx) only
//                    when the entry took THIS receipt;
//   (4) EVICTION     (#890 r9) the queue then forgets X, and the poll answers
//                    exactly what it answered live.
// #890 r9 narrows (1): a SETTLED answer is frozen — the completed-over-failed
// replacement applies only to an entry neither settled nor claimed for
// settlement (`settling`).
type AnswerDoor = "post" | "mcp" | "fed";
type AnswerState =
  | "unsettled"
  | "settled_completed"
  | "settled_failed"
  | "settled_completed_mcp"
  | "answered_not_settled"
  | "evicted";
type AnswerSigner = "routed" | "second" | "foreign" | "bad_sig" | "delegator" | "master";
const ANSWER_STATES: AnswerState[] = [
  "unsettled",
  "settled_completed",
  "settled_failed",
  "settled_completed_mcp",
  "answered_not_settled",
  "evicted",
];
const ANSWER_SIGNERS: AnswerSigner[] = [
  "routed",
  "second",
  "foreign",
  "bad_sig",
  "delegator",
  "master",
];

/** The entry is settled, or claimed for settlement (#890 r9: its answer is frozen). */
function entryFrozen(w: World, taskId: string): boolean {
  const row = w.relay.moteDb.db
    .prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?")
    .get(taskId) as { task_json: string } | undefined;
  if (row == null) return false;
  const e = JSON.parse(row.task_json) as { settled?: boolean; settling?: string };
  return e.settled === true || (typeof e.settling === "string" && e.settling !== "");
}

/** The poll's answer for X, as D sees it (live entry, else the archive). */
async function pollAnswer(w: World, taskId: string): Promise<ExecutionReceipt | null> {
  const r = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}`, { headers: AUTH_HEADER });
  if (!r.ok) return null;
  return ((await r.json()) as { receipt?: ExecutionReceipt | null }).receipt ?? null;
}

/**
 * A RelayDelegationAdapter that adopted X: every submission under the
 * step's first key (`…:0`) is answered 409 naming X (#888); any other key
 * is a SECOND paid submission, recorded and refused (never admitted).
 * Returns the keys other than the first one it submitted.
 */
async function adoptedAdapterKeys(w: World, X: string): Promise<string[]> {
  const secondKeys: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://relay")) return realFetch(input, init);
    const path = url.replace("http://relay", "");
    if (init?.method === "POST" && /\/agent\/[^/]+\/task$/.test(path)) {
      const key = new Headers(init.headers).get("idempotency-key") ?? "(no key)";
      if (key.endsWith(":0")) {
        return new Response(JSON.stringify({ code: "TASK_CONFLICT", task_id: X }), {
          status: 409,
        });
      }
      secondKeys.push(key);
      return new Response("{}", { status: 503 });
    }
    return w.relay.app.request(path, init);
  });
  try {
    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: w.D.id,
      authToken: async () => API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: () => () => {},
      maxDelegationRetries: 1,
    });
    const step: PlanStep = {
      step_id: "s1",
      plan_id: "p1" as PlanId,
      ordinal: 0,
      description: "remote",
      prompt: "adopted",
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
    await adapter.delegateStep(step, 20).catch((e: unknown) => e);
  } finally {
    vi.unstubAllGlobals();
  }
  return secondKeys;
}

async function runAnswerCell(
  door: AnswerDoor,
  state: AnswerState,
  signer: AnswerSigner,
  status: "completed" | "failed",
): Promise<string[]> {
  const failures: string[] = [];
  const w = await world();
  try {
    const db = w.relay.moteDb.db;
    const W2 = await agent(w.relay);
    const tag = crypto.randomUUID();
    const pX = `answer ${tag}`;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let mcpAnswered = false;
    let sent: ExecutionReceipt | null = null;
    const operator = { id: `operator-${tag}`, device: "op-dev", kp: await generateKeypair() };
    const build = async (id: string): Promise<ExecutionReceipt> => {
      if (signer === "routed") return receiptBy(w.W, id, status);
      if (signer === "second") return receiptBy(W2, id, status);
      if (signer === "foreign") return receiptBy(w.E, id, status);
      if (signer === "delegator") return receiptBy(w.D, id, status);
      if (signer === "master") return receiptBy(operator, id, status);
      const kp = await generateKeypair();
      return receiptBy({ ...w.W, kp }, id, status); // bad_sig: names W, not W's key
    };
    mcpReplies.set(pX, async (id) => {
      if (state === "settled_completed_mcp") return receiptBy(w.W, id, "completed");
      if (door !== "mcp") return null;
      await gate;
      sent = await build(id);
      mcpAnswered = true;
      return sent;
    });
    const X = await admit(w, pX);
    // The ranking fan-out's further recorded executors: a second local pick,
    // and the federated route (W and W2 through `peer`).
    recordTaskRoute(db, X, W2.id);
    recordTaskRoute(db, X, w.W.id, w.peer.id);
    recordTaskRoute(db, X, W2.id, w.peer.id);

    // ── the state ──
    if (state === "settled_completed" || state === "evicted") {
      expect(await postResult(w, X, await receiptBy(w.W, X, "completed"))).toBe(200);
    } else if (state === "settled_failed") {
      expect(await postResult(w, X, await receiptBy(w.W, X, "failed"))).toBe(200);
    } else if (state === "answered_not_settled") {
      expect(await fedResult(w, w.peer, X, await receiptBy(w.W, X, "completed"))).toBe(200);
    } else if (state === "settled_completed_mcp") {
      for (let i = 0; i < 50 && (await pollAnswer(w, X)) == null; i++) await settle(20);
    }
    if (state === "evicted") {
      db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
    }
    const before = await pollAnswer(w, X);
    // #890 r9: a SETTLED answer is frozen — settled, or claimed for settlement.
    const frozen = entryFrozen(w, X);

    // ── the door ──
    let reported: number | null = null;
    if (door === "mcp") {
      // The forward's acceptance report is its `task.mcp_forward_completed`
      // line for X: observed, never inferred.
      let mcpReported = false;
      const write = process.stdout.write.bind(process.stdout);
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
          const line = String(chunk);
          if (line.includes('"task.mcp_forward_completed"') && line.includes(X)) {
            mcpReported = true;
          }
          return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
        });
      try {
        release();
        for (let i = 0; i < 50 && !mcpAnswered; i++) await settle(20);
        await settle(150);
      } finally {
        spy.mockRestore();
      }
      reported = mcpReported ? 200 : 499;
    } else {
      sent = await build(X);
      if (door === "post") reported = await postResult(w, X, sent);
      else {
        const key = signer === "master" ? bytesToHex(operator.kp.publicKey) : undefined;
        reported = await fedResult(w, w.peer, X, sent, key);
      }
    }
    const after = await pollAnswer(w, X);

    // ── the law's expected answer ──
    const sigValid = signer !== "bad_sig";
    const recorded =
      door === "fed"
        ? signer === "routed" || signer === "second"
        : door === "mcp"
          ? signer === "routed" // the forward presented X to W alone
          : signer === "routed" || signer === "second" || signer === "delegator";
    const admissible = sigValid && recorded && state !== "evicted";
    let expected: ExecutionReceipt | null = before;
    if (admissible && sent != null && !frozen) {
      if (before == null) expected = sent;
      else if (before.status !== "completed" && status === "completed") expected = sent;
    }
    const sig = (r: ExecutionReceipt | null): string =>
      r == null ? "none" : `${r.status}/${r.motebit_id.slice(0, 8)}/${r.signature.slice(0, 8)}`;
    if (sig(after) !== sig(expected)) {
      failures.push(
        `WRITE-ONCE: answer ${sig(before)} became ${sig(after)}, law says ${sig(expected)}`,
      );
    }
    if (
      reported != null &&
      reported < 300 &&
      (after == null || sent == null || after.signature !== sent.signature)
    ) {
      failures.push(
        `POSITIVE: the door reported ${reported} but the entry did not take the receipt`,
      );
    }
    // ── the eviction dimension (#890 r9): the queue forgets X; the poll
    //    answers exactly what it answered before (the archive IS the answer).
    if (state !== "evicted") {
      db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
      const evicted = await pollAnswer(w, X);
      if (sig(evicted) !== sig(after)) {
        failures.push(
          `EVICTION: the live answer ${sig(after)} became ${sig(evicted)} once evicted`,
        );
      }
    }
    if (expected == null || expected.status === "completed") {
      const keys = await adoptedAdapterKeys(w, X);
      if (keys.length > 0)
        failures.push(`ONE KEY: the adopted planner submitted ${keys.join(",")}`);
    }
  } finally {
    await w.relay.close();
  }
  return failures;
}

async function answerDoor(door: AnswerDoor): Promise<{ cells: number; failures: string[] }> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const failures: string[] = [];
  let cells = 0;
  for (const state of ANSWER_STATES) {
    if (door === "mcp" && state === "settled_completed_mcp") continue; // one presentation per task
    for (const signer of ANSWER_SIGNERS) {
      for (const status of ["completed", "failed"] as const) {
        cells++;
        for (const f of await runAnswerCell(door, state, signer, status)) {
          failures.push(`${door}/${state}/${signer}/${status}: ${f}`);
        }
      }
    }
  }
  return { cells, failures };
}

describe("#890 r8 the ANSWER dimension — one chokepoint, write-once, positive acceptance", () => {
  for (const door of ["post", "mcp", "fed"] as AnswerDoor[]) {
    it(`${door} door × entry state × signer × status`, async () => {
      const { cells, failures } = await answerDoor(door);
      expect(cells).toBeGreaterThan(0);
      // One line per failing cell, so a red run names every cell.
      expect(`${failures.length} failing of ${cells}\n${failures.join("\n")}`).toBe(
        `0 failing of ${cells}\n`,
      );
    }, 600_000);
  }
});

describe("#890 r8 the reviewer's probes", () => {
  it("C1(a)(d): after W's completed settles X, a failed POST by E, a bad signature, W or D is refused; the poll stays completed; the adopted planner never pays twice", async () => {
    const failures: string[] = [];
    for (const signer of ["foreign", "bad_sig", "routed", "delegator"] as AnswerSigner[]) {
      for (const state of ["settled_completed", "settled_completed_mcp"] as AnswerState[]) {
        for (const f of await runAnswerCell("post", state, signer, "failed")) {
          failures.push(`${state}/${signer}: ${f}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("C2(a): after a local W completes X, a failed federation result from the second recorded executor (the ranked federated route) is refused", async () => {
    expect(await runAnswerCell("fed", "settled_completed", "second", "failed")).toEqual([]);
    expect(await runAnswerCell("fed", "answered_not_settled", "second", "failed")).toEqual([]);
  }, 120_000);
});

describe("#890 r8 (P1) `duplicate` only to the peer whose forward holds the id", () => {
  it("an id held only by peer's inbound route: peer's re-forward is `duplicate`, otherPeer's is a collision", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world(true);
    try {
      const db = w.relay.moteDb.db;
      await w.relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: w.E.id,
          endpoint_url: "http://e.invalid/mcp",
          capabilities: [],
        }),
      });
      const F = crypto.randomUUID();
      expect(await fedForward(w, w.peer, F, w.W.id)).toBe(202);
      db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(F);
      const other = await fedForwardBody(w, w.otherPeer, F, w.E.id);
      const same = await fedForwardBody(w, w.peer, F, w.W.id);
      expect({ other: other.body, same: same.body }).toEqual({
        other: "rejected",
        same: "duplicate",
      });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r8 (P3) an MCP forward reports acceptance only on a positive ingestion", () => {
  it("forwardTaskViaMcp logs the forward completed only when onReceipt answered true — never with no callback", async () => {
    const w = await world();
    try {
      const completedLogs = async (
        onReceipt: undefined | (() => Promise<boolean>),
      ): Promise<{ completed: number; ingested: number }> => {
        const X = crypto.randomUUID();
        mcpReplies.set(`p3 ${X}`, (id) => receiptBy(w.W, id, "completed"));
        const queue = new Map<string, { task: { status: string }; receipt?: unknown }>([
          [X, { task: { status: "pending" } }],
        ]);
        let completed = 0;
        let ingested = 0;
        const log = {
          info: (msg: string) => {
            if (msg === "task.mcp_forward_completed") completed++;
          },
          warn: () => {},
        };
        await forwardTaskViaMcp(
          `http://127.0.0.1:${PORT}/mcp`,
          X,
          `p3 ${X}`,
          w.W.id,
          queue,
          log,
          undefined,
          onReceipt == null
            ? undefined
            : async () => {
                ingested++;
                return onReceipt();
              },
          "dispatch-token",
          { allowPrivateNetwork: true },
          () => Promise.resolve("bearer"),
        );
        return { completed, ingested };
      };
      // Positive control: the forward reached the endpoint and the callback.
      expect(await completedLogs(() => Promise.resolve(true))).toEqual({
        completed: 1,
        ingested: 1,
      });
      expect(await completedLogs(() => Promise.resolve(false))).toEqual({
        completed: 0,
        ingested: 1,
      });
      // No callback: nothing ingested it, so nothing is accepted.
      expect(await completedLogs(undefined)).toEqual({ completed: 0, ingested: 0 });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r8 the answer has ONE writer", () => {
  it("no source file outside task-answer.ts assigns a queue entry's receipt, terminal status or settlement claim, or writes the queue in SQL", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(join(d, e.name));
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name === "task-answer.ts") continue;
        const src = readFileSync(join(d, e.name), "utf8").split("\n");
        src.forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "");
          const receiptWrite = /\.receipt\s*=(?!=)/.test(code);
          const statusWrite = /\.task\.status\s*=(?!=)/.test(code);
          // #890 r9 (a secondary signal — the queue's answer capability and
          // its triggers are the enforcement): the settlement claim, bracket
          // writes, and SQL that writes the queue outside task-queue.ts.
          const settleWrite = /\.(settled|settling)\s*=(?!=)/.test(code);
          const bracketWrite =
            /\[\s*["'`](receipt|settled|settling|status)["'`]\s*\]\s*=(?!=)/.test(code);
          const sqlWrite =
            e.name !== "task-queue.ts" &&
            /(UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+relay_task_(queue|answers)\b/i.test(
              code,
            );
          if (!receiptWrite && !statusWrite && !settleWrite && !bracketWrite && !sqlWrite) return;
          // Allowed: the durable queue hydrating a stored row, and the socket
          // claim's Pending ⇄ Claimed transition (never a terminal status).
          if (
            e.name === "task-queue.ts" &&
            /entry\.receipt = JSON\.parse\(row\.receipt\)/.test(code)
          )
            return;
          if (
            e.name === "websocket.ts" &&
            /\.task\.status = AgentTaskStatus\.(Claimed|Pending);/.test(code)
          )
            return;
          offenders.push(`${e.name}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    walk(dir);
    expect(offenders, "route the write through answerTask (task-answer.ts)").toEqual([]);
  });
});
