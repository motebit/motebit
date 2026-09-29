/**
 * #981 — a credential handed to one principal never authenticates as a
 * different principal.
 *
 * `presenter: "submitter"` (and any submission the relay did not route) hands
 * the SUBMITTER the per-task `task:dispatch` token. Before #981 the worker's
 * MCP transport tried that token as the RELAY's bearer first, so a submitter
 * (or anyone the token leaked to) could present it as
 * `Authorization: Bearer motebit:<dispatch_token>` and be served as
 * `relay:<did>` at Verified trust. The dispatch token is an ADMISSION record
 * (what was bought); it never proves who is calling.
 *
 * The matrix runs a REAL relay (`createTestRelay`, real submission route,
 * real `forwardTaskViaMcp`) against a REAL worker (`McpServerAdapter` with
 * `taskAdmission` pinned to the relay's key), real Ed25519 keys, raw
 * JSON-RPC over HTTP. Every cell uses its own admitted task, so single-use
 * never masks a cell. Crossed:
 *
 *   presenter   relay forward / submitter / third party holding a leaked
 *               token / expired token / token for a different task / token
 *               for a different worker
 *   door        transport (the token as the bearer, and as the argument —
 *               the attacker's best shot) / admission (the presenter's OWN
 *               mcp:call bearer, the token as the `dispatch_token` argument)
 *   observed    transport accepted?, the caller the worker saw (relay trust
 *               or not), executions
 *
 * The invariants:
 *   - only the relay's own forward earns relay transport trust;
 *   - a submitter presentation admits exactly the one task and earns no
 *     elevated trust;
 *   - everything else is refused;
 *   - one admission ⇒ one execution.
 *
 * Tampers: scripts/tampers/981-dispatch-presenter.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  generateKeypair,
  bytesToHex,
  mintAudienceToken,
  verifySignedToken,
  signExecutionReceipt,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import { McpServerAdapter, AgentTrustLevel } from "@motebit/mcp-server";
import type { SyncRelay } from "../index.js";
import { TASK_DISPATCH_TOKEN_TTL_MS } from "../task-routing.js";
import {
  createAgent,
  createTestRelay,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(10);
  }
  return true;
}

interface Principal {
  motebitId: string;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

interface World {
  relay: SyncRelay;
  worker: Principal;
  otherWorker: Principal;
  submitter: Principal;
  thirdParty: Principal;
  port: number;
  /** Callers the worker's policy gate saw, one per motebit_task call it evaluated. */
  callers: Array<{ motebitId: string; trustLevel: string }>;
  /** Executions by relay task id. */
  executions: Map<string, number>;
}

async function principal(relay: SyncRelay): Promise<Principal> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const { motebitId } = await createAgent(relay, publicKeyHex);
  return { motebitId, privateKey: kp.privateKey, publicKeyHex };
}

async function world(): Promise<World> {
  const relay = await createTestRelay();
  cleanups.push(() => relay.close());
  const worker = await principal(relay);
  const otherWorker = await principal(relay);
  const submitter = await principal(relay);
  const thirdParty = await principal(relay);
  const callers: World["callers"] = [];
  const executions = new Map<string, number>();

  const adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      taskAdmission: { relayPublicKey: relay.relayIdentity.publicKeyHex },
      // Both direct callers are known to the worker, at the same standing: a
      // direct caller's trust is whatever the worker's own record says —
      // never the relay's.
      knownCallers: new Map([
        [
          submitter.motebitId,
          { publicKey: submitter.publicKeyHex, trustLevel: AgentTrustLevel.FirstContact },
        ],
        [
          thirdParty.motebitId,
          { publicKey: thirdParty.publicKeyHex, trustLevel: AgentTrustLevel.FirstContact },
        ],
      ]),
    },
    {
      motebitId: worker.motebitId,
      publicKeyHex: worker.publicKeyHex,
      listTools: () => [],
      filterTools: (t: unknown) => t,
      validateTool: (
        tool: { name: string },
        _args: unknown,
        caller?: { motebitId: string; trustLevel: string },
      ) => {
        if (tool.name === "motebit_task" && caller != null) {
          callers.push({ motebitId: caller.motebitId, trustLevel: caller.trustLevel });
        }
        return { allowed: true, requiresApproval: false };
      },
      executeTool: async () => ({ ok: true, data: "ok" }),
      getState: () => ({}),
      getMemories: async () => [],
      logToolCall: () => {},
      verifySignedToken,
      handleAgentTask: async function* (prompt: string, opts?: { relayTaskId?: string }) {
        const id = opts?.relayTaskId ?? "(none)";
        executions.set(id, (executions.get(id) ?? 0) + 1);
        const enc = new TextEncoder();
        const result = "done";
        const receipt = await signExecutionReceipt(
          {
            task_id: id,
            relay_task_id: id,
            motebit_id: worker.motebitId as never,
            device_id: "svc" as never,
            submitted_at: Date.now() - 1000,
            completed_at: Date.now(),
            status: "completed" as const,
            result,
            tools_used: ["read_url"],
            memories_formed: 0,
            prompt_hash: await sha256(enc.encode(prompt)),
            result_hash: await sha256(enc.encode(result)),
          },
          worker.privateKey,
        );
        yield {
          type: "task_result" as const,
          receipt: receipt as unknown as Record<string, unknown>,
        };
      },
    } as never,
  );
  await adapter.start();
  cleanups.push(() => adapter.stop());
  const port = ((adapter as unknown as { httpServer: Server }).httpServer.address() as AddressInfo)
    .port;

  // A registered, reachable, unpriced worker: the shape the relay forwards to.
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: `http://127.0.0.1:${port}/mcp`,
      capabilities: ["read_url"],
    }),
  });
  await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["read_url"],
      pricing: [{ capability: "read_url", unit_cost: 0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "#981 worker",
    }),
  });

  return { relay, worker, otherWorker, submitter, thirdParty, port, callers, executions };
}

/** Submit through the real relay route; returns the task id and any token handed back. */
async function submit(
  w: World,
  prompt: string,
  opts: { presenter?: "submitter"; to?: string } = {},
): Promise<{ taskId: string; token?: string }> {
  const res = await w.relay.app.request(`/agent/${opts.to ?? w.worker.motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt,
      submitted_by: w.submitter.motebitId,
      required_capabilities: ["read_url"],
      ...(opts.presenter ? { presenter: opts.presenter } : {}),
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task_id: string; dispatch_token?: string };
  return { taskId: body.task_id, ...(body.dispatch_token ? { token: body.dispatch_token } : {}) };
}

/** A presenter's OWN transport bearer: mcp:call, bound to the worker, fresh per request. */
function ownBearer(p: Principal, workerId: string): () => Promise<string> {
  return async () => {
    const { token } = await mintAudienceToken(
      {
        mid: p.motebitId,
        did: `${p.motebitId}-device`,
        aud: "mcp:call",
        sub: workerId,
        ttlMs: 60_000,
      },
      p.privateKey,
    );
    return `motebit:${token}`;
  };
}

function parseRpc(
  raw: string,
): { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null {
  const lines = raw.split("\n").filter((l) => l.startsWith("data:"));
  const json = lines.length > 0 ? lines[lines.length - 1]!.slice(5).trim() : raw.trim();
  try {
    return JSON.parse(json) as ReturnType<typeof parseRpc>;
  } catch {
    return null;
  }
}

interface Presentation {
  transportAccepted: boolean;
  toolText?: string;
}

/** Raw MCP session: initialize → initialized → tools/call motebit_task. A fresh bearer per request. */
async function present(
  port: number,
  bearer: () => Promise<string>,
  args: Record<string, unknown>,
): Promise<Presentation> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = async (session?: string): Promise<Record<string, string>> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${await bearer()}`,
    ...(session ? { "Mcp-Session-Id": session } : {}),
  });
  const init = await fetch(url, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    }),
  });
  await init.text();
  if (init.status !== 200) return { transportAccepted: false };
  const session = init.headers.get("mcp-session-id") ?? undefined;
  const notified = await fetch(url, {
    method: "POST",
    headers: await headers(session),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await notified.text();
  if (notified.status >= 400) return { transportAccepted: false };
  const call = await fetch(url, {
    method: "POST",
    headers: await headers(session),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "motebit_task", arguments: args },
    }),
  });
  const raw = await call.text();
  if (call.status >= 400) return { transportAccepted: false };
  const rpc = parseRpc(raw);
  return { transportAccepted: true, toolText: rpc?.result?.content?.[0]?.text };
}

// === The matrix =============================================================

const PRESENTERS = [
  "submitter", // the principal the relay handed the token to
  "third-party", // someone the submitter's token leaked to
  "expired", // the submitter's token, past its exp
  "other-task", // the submitter's token for task A, presented for task B
  "other-worker", // the submitter's token minted for a different worker
] as const;
const DOORS = ["transport", "admission"] as const;

type Presenter = (typeof PRESENTERS)[number];
type Door = (typeof DOORS)[number];

interface Observed {
  transportAccepted: boolean;
  /** The worker served the call as its relay. */
  relayTrust: boolean;
  /** Executions of the task this cell targeted. */
  executed: number;
  /** A non-relay caller the worker saw (its own identity), when any. */
  caller?: string;
}

/** The oracle. Exactly one direct cell executes, and nothing but the relay's forward earns relay trust. */
function oracle(p: Presenter, d: Door, w: World): Observed {
  if (p === "submitter" && d === "admission") {
    return {
      transportAccepted: true,
      relayTrust: false,
      executed: 1,
      caller: w.submitter.motebitId,
    };
  }
  if (d === "admission") {
    // The presenter's own bearer passes transport as ITSELF; the admission refuses.
    const who = p === "third-party" ? w.thirdParty : w.submitter;
    return { transportAccepted: true, relayTrust: false, executed: 0, caller: who.motebitId };
  }
  return { transportAccepted: false, relayTrust: false, executed: 0 };
}

/**
 * The third party presenting a leaked token through its OWN transport bearer is
 * the one cell the worker cannot refuse today: a `task:dispatch` token does not
 * name its presenter, and adding that claim is a `@motebit/crypto`
 * `SignedTokenPayload` change outside #981's fence. Asserted separately below
 * (`it.fails`), never silently in the oracle.
 */
const GAP = (p: Presenter, d: Door): boolean => p === "third-party" && d === "admission";

async function runCell(w: World, p: Presenter, d: Door, n: number): Promise<Observed> {
  const prompt = `https://example.com/981/${p}/${d}/${n}`;
  let target: { taskId: string; token?: string };
  if (p === "expired") {
    // A token the relay minted a TTL and a minute ago: the real mint under an
    // earlier clock (the relay's private key never leaves the relay).
    const real = Date.now.bind(Date);
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => real() - TASK_DISPATCH_TOKEN_TTL_MS - 60_000);
    try {
      target = await submit(w, prompt, { presenter: "submitter" });
    } finally {
      spy.mockRestore();
    }
  } else {
    target = await submit(w, prompt, { presenter: "submitter" });
  }
  expect(typeof target.token).toBe("string");
  let token = target.token!;
  let args: Record<string, unknown> = {
    prompt,
    relay_task_id: target.taskId,
    dispatch_token: token,
  };

  if (p === "other-task") {
    // The submitter's token for ANOTHER admitted task, presented for this one.
    const other = await submit(w, `${prompt}/other`, { presenter: "submitter" });
    token = other.token!;
    args = { prompt, dispatch_token: token };
  } else if (p === "other-worker") {
    const other = await submit(w, prompt, { presenter: "submitter", to: w.otherWorker.motebitId });
    token = other.token!;
    args = { prompt, dispatch_token: token };
  }

  const presenter = p === "third-party" ? w.thirdParty : w.submitter;
  const bearer =
    d === "transport" ? async () => `motebit:${token}` : ownBearer(presenter, w.worker.motebitId);

  const seenBefore = w.callers.length;
  const r = await present(w.port, bearer, args);
  const seen = w.callers.slice(seenBefore);
  const relayTrust = seen.some((c) => c.motebitId.startsWith("relay:"));
  const direct = seen.find((c) => !c.motebitId.startsWith("relay:"));
  return {
    transportAccepted: r.transportAccepted,
    relayTrust,
    executed: w.executions.get(target.taskId) ?? 0,
    ...(direct ? { caller: direct.motebitId } : {}),
  };
}

describe("#981 — the dispatch door: presenter × door × outcome", () => {
  it(`only the submitter's own presentation executes, and no direct cell earns relay trust (${PRESENTERS.length * DOORS.length - 1} cells)`, async () => {
    const w = await world();
    const wrong: string[] = [];
    let n = 0;
    for (const p of PRESENTERS) {
      for (const d of DOORS) {
        if (GAP(p, d)) continue;
        const got = await runCell(w, p, d, n++);
        const want = oracle(p, d, w);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          wrong.push(`${p} × ${d}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the relay's own forward is served as the relay, and executes exactly once", async () => {
    const w = await world();
    const { taskId, token } = await submit(w, "https://example.com/981/forward");
    // The relay routed it: the submitter holds no token.
    expect(token).toBeUndefined();
    expect(await waitFor(() => (w.executions.get(taskId) ?? 0) >= 1)).toBe(true);
    await sleep(200);
    expect(w.executions.get(taskId)).toBe(1);
    expect(w.callers).toHaveLength(1);
    expect(w.callers[0]!.motebitId).toBe(`relay:${w.relay.relayIdentity.did}`);
  });

  it("one admission ⇒ one execution: the submitter's second presentation, and a transport-door retry, run nothing", async () => {
    const w = await world();
    const prompt = "https://example.com/981/once";
    const { taskId, token } = await submit(w, prompt, { presenter: "submitter" });
    const args = { prompt, relay_task_id: taskId, dispatch_token: token! };
    const first = await present(w.port, ownBearer(w.submitter, w.worker.motebitId), args);
    expect(first.transportAccepted).toBe(true);
    const again = await present(w.port, ownBearer(w.submitter, w.worker.motebitId), args);
    expect(again.toolText).toMatch(/already admitted/);
    const asRelay = await present(w.port, async () => `motebit:${token!}`, args);
    expect(asRelay.transportAccepted).toBe(false);
    expect(w.executions.get(taskId)).toBe(1);
    expect(w.callers.every((c) => !c.motebitId.startsWith("relay:"))).toBe(true);
  });

  it("the transport refusal of a dispatch token names why, so an older relay fails loudly", async () => {
    const w = await world();
    const { token } = await submit(w, "https://example.com/981/loud", { presenter: "submitter" });
    const res = await fetch(`http://127.0.0.1:${w.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer motebit:${token!}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toMatch(/task:dispatch/);
    expect(body.reason).toMatch(/never authenticates the transport/);
  });

  // GAP — see `GAP` above. Flips to a failure (and must be un-`fails`ed) the
  // day a dispatch token names its presenter and the worker checks it.
  it.fails(
    "GAP: a third party presenting a LEAKED admission token through its own bearer is refused",
    async () => {
      const w = await world();
      const got = await runCell(w, "third-party", "admission", 0);
      expect(got.executed).toBe(0);
    },
  );
});
