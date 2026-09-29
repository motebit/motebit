/**
 * #811 v2 differential probe — the #845 reviewer's probe, plus the ranked and
 * chosen-presenter cells. Run with scripts/differential-vs-main.ts.
 *
 * Reviewer probe (#845): closed-only socket at dispatch, then the worker
 * reconnects. Worker = one motebit id with (a) a real McpServerAdapter on its
 * registered endpoint, taskAdmission: relay (pinned relay key), slow handler;
 * (b) a WS device that executes every task_request it receives (as
 * `motebit serve --transport http` does: claim, run, POST the receipt).
 * Counts executions on each surface, receipts accepted, settlement rows.
 */
import { it, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  verifySignedToken,
  mintAudienceToken,
  hash as sha256,
} from "@motebit/encryption";
import { McpServerAdapter, AgentTrustLevel } from "@motebit/mcp-server";
import type { SyncRelay, ConnectedDevice } from "../index.js";
import {
  API_TOKEN,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { forwardTaskViaMcp } from "../task-routing.js";

const obs: Record<string, unknown> = {};
const cleanups: Array<() => Promise<void>> = [];
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
let nextPort = 18991;

afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(10);
  }
  return true;
}

async function startRelay(): Promise<{ relay: SyncRelay; port: number }> {
  const relay = await createTestRelay({ commandTimeoutMs: 1_000 });
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  cleanups.push(async () => {
    await relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { relay, port: (server.address() as AddressInfo).port };
}

async function signReceipt(
  kp: { privateKey: Uint8Array },
  worker: string,
  taskId: string,
  prompt: string,
  tag: string,
) {
  const enc = new TextEncoder();
  const result = `done via ${tag}`;
  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: worker as never,
      device_id: "svc" as never,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result,
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode(prompt)),
      result_hash: await sha256(enc.encode(result)),
    },
    kp.privateKey,
  );
}

type Kind = "closed" | "none";

async function scenario(
  name: string,
  kind: Kind,
  paid: boolean,
  mode: "plain" | "caps" | "present" | "other" | "ranked" | "chosen" = "plain",
): Promise<void> {
  const { relay, port } = await startRelay();
  const kp = await generateKeypair();
  const { motebitId: worker } = await createAgent(relay, bytesToHex(kp.publicKey));
  const xkp = await generateKeypair();
  const { motebitId: xId } = await createAgent(relay, bytesToHex(xkp.publicKey));
  const mcpOwner = mode === "other" ? xId : worker;
  const mcpKp = mode === "other" ? xkp : kp;
  const mcpPort = nextPort++;
  // A submitter that presents directly does so AS ITSELF (#981).
  const subKp = await generateKeypair();
  const SUBMITTER = "submitter-0000-0000-0000-000000000981";
  let mcpExec = 0;
  let mcpDenied = 0;
  const adapter = new McpServerAdapter(
    {
      transport: "http",
      port: mcpPort,
      taskAdmission: { relayPublicKey: relay.relayIdentity.publicKeyHex },
      knownCallers: new Map([
        [
          SUBMITTER,
          { publicKey: bytesToHex(subKp.publicKey), trustLevel: AgentTrustLevel.FirstContact },
        ],
      ]),
    },
    {
      motebitId: mcpOwner,
      publicKeyHex: bytesToHex(mcpKp.publicKey),
      listTools: () => [],
      filterTools: (t: unknown) => t,
      validateTool: () => ({ allowed: true, requiresApproval: false }),
      executeTool: async () => ({ ok: true, data: "ok" }),
      getState: () => ({}),
      getMemories: async () => [],
      logToolCall: (_n: unknown, _a: unknown, r: unknown) => {
        if (
          r &&
          (r as { ok?: boolean }).ok === false &&
          String((r as { error?: string }).error).includes("admission denied")
        )
          mcpDenied++;
      },
      verifySignedToken,
      handleAgentTask: async function* (prompt: string, opts?: { relayTaskId?: string }) {
        mcpExec++;
        await sleep(1500); // an LLM task takes a while
        yield {
          type: "task_result" as const,
          receipt: (await signReceipt(
            mcpKp,
            mcpOwner,
            opts!.relayTaskId!,
            prompt,
            "mcp",
          )) as unknown as Record<string, unknown>,
        };
      },
    } as never,
  );
  await adapter.start();
  cleanups.push(() => adapter.stop());
  const endpoint = `http://127.0.0.1:${mcpPort}`;
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mcpOwner,
      endpoint_url: endpoint,
      capabilities: ["web_search"],
      ...(paid ? { settlement_address: WORKER_SOLANA_ADDR, settlement_modes: "relay,p2p" } : {}),
    }),
  });
  if (paid || mode === "ranked") {
    await relay.app.request(`/api/v1/agents/${worker}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [
          { capability: "web_search", unit_cost: paid ? 0.5 : 0, currency: "USD", per: "task" },
        ],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "probe",
        ...(paid ? { pay_to_address: WORKER_SOLANA_ADDR } : {}),
      }),
    });
  }

  // The WS device: executes every task_request (claim, run, POST receipt).
  let wsFrames = 0;
  const resultStatuses: number[] = [];
  const openDevice = async (): Promise<{ ws: WebSocket; peer: ConnectedDevice }> => {
    const before = relay.connections.get(worker)?.slice() ?? [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${worker}?token=${API_TOKEN}${mode === "caps" || mode === "other" || mode === "ranked" ? "&capabilities=web_search" : ""}`,
    );
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      let f: { type?: string; task?: { task_id: string; prompt: string } };
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (f.type !== "task_request" || f.task == null) return;
      wsFrames++;
      const t = f.task;
      ws.send(JSON.stringify({ type: "task_claim", task_id: t.task_id }));
      void (async () => {
        await sleep(200);
        const receipt = await signReceipt(kp, worker, t.task_id, t.prompt, "ws");
        const res = await relay.app.request(`/agent/${worker}/task/${t.task_id}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipt),
        });
        resultStatuses.push(res.status);
      })();
    });
    await waitFor(() => (relay.connections.get(worker)?.length ?? 0) > before.length);
    const peer = relay.connections.get(worker)!.find((p) => !before.includes(p))!;
    cleanups.push(async () => ws.terminate());
    return { ws, peer };
  };

  if (kind === "closed") {
    const d = await openDevice();
    d.ws.close();
    await waitFor(
      () => d.peer.ws.readyState === 3 && !(relay.connections.get(worker) ?? []).includes(d.peer),
    );
    const list = relay.connections.get(worker) ?? [];
    list.unshift(d.peer);
    relay.connections.set(worker, list);
  }

  // Submit.
  let r: Response;
  const prompt = "probe task";
  if (paid) {
    const del = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(del.motebitId, worker, "verified", 10, Date.now(), Date.now());
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    r = await relay.app.request(`/agent/${del.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt,
        submitted_by: del.motebitId,
        target_agent: worker,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: ["web_search"],
      }),
    });
  } else if (mode === "ranked") {
    const via = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(via.motebitId, worker, "verified", 10, Date.now(), Date.now());
    r = await relay.app.request(`/agent/${via.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt, required_capabilities: ["web_search"] }),
    });
  } else {
    r = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt,
        ...(mode === "caps" || mode === "other" ? { required_capabilities: ["web_search"] } : {}),
        ...(mode === "chosen" ? { presenter: "submitter" } : {}),
      }),
    });
  }
  const j = (await r.json()) as { task_id: string; dispatch_token?: string };
  const taskId = j.task_id;

  if ((mode === "present" || mode === "chosen") && typeof j.dispatch_token === "string") {
    // The submitter presents its token directly at the worker's endpoint.
    void forwardTaskViaMcp(
      endpoint,
      taskId,
      prompt,
      worker,
      new Map() as never,
      { info: () => {}, warn: () => {} },
      undefined,
      undefined,
      j.dispatch_token,
      { allowPrivateNetwork: true } as never,
      // The submitter's OWN caller token per request, never the dispatch token (#981).
      async () =>
        (
          await mintAudienceToken(
            {
              mid: SUBMITTER,
              did: "submitter-device",
              aud: "mcp:call",
              sub: worker,
              ttlMs: 60_000,
            },
            subKp.privateKey,
          )
        ).token,
    );
  }
  // The worker's device reconnects shortly after (backoff ~300ms).
  await sleep(300);
  await openDevice();
  await sleep(3500);

  let settlementRows: number | string = "n/a";
  try {
    settlementRows = (
      relay.moteDb.db
        .prepare(`SELECT COUNT(*) AS n FROM relay_settlements WHERE task_id = ?`)
        .get(taskId) as { n: number }
    ).n;
  } catch (e) {
    settlementRows = String(e);
  }
  const statusRes = await relay.app.request(`/agent/${worker}/task/${taskId}`, {
    headers: JSON_AUTH,
  });
  const st =
    statusRes.status === 200
      ? ((await statusRes.json()) as { task?: { status?: string }; receipt?: { result?: string } })
      : null;
  obs[`${name}.${kind}`] = {
    http: r.status,
    submitter_token: typeof j.dispatch_token === "string",
    mcp_executions: mcpExec,
    mcp_admission_denied: mcpDenied,
    ws_task_request_frames_on_reconnect: wsFrames,
    total_executions: mcpExec + wsFrames,
    ws_result_post_statuses: resultStatuses,
    settlement_rows: settlementRows,
    final_status: st?.task?.status ?? null,
    receipt_from: st?.receipt?.result ?? null,
  };
}

it("unpaid Phase 2→3 (URL worker, MCP endpoint)", async () => {
  await scenario("phase3", "closed", false);
  await scenario("phase3", "none", false);
}, 60_000);

it("unpaid with required caps (Phase 1/2/3)", async () => {
  await scenario("caps", "closed", false, "caps");
  await scenario("caps", "none", false, "caps");
}, 60_000);

it("unpaid caps; MCP endpoint is a DIFFERENT agent X; W is WS-only", async () => {
  await scenario("other", "closed", false, "other");
  await scenario("other", "none", false, "other");
}, 60_000);

it("unpaid, submitter presents its token", async () => {
  await scenario("present", "closed", false, "present");
  await scenario("present", "none", false, "present");
}, 60_000);

it("paid Phase 0 pinned p2p", async () => {
  await scenario("pinned", "closed", true);
  await scenario("pinned", "none", true);
}, 60_000);

it("Phase 1 ranked local dispatch (submitted to another agent's URL)", async () => {
  await scenario("ranked", "closed", false, "ranked");
  await scenario("ranked", "none", false, "ranked");
}, 60_000);

it("presenter: submitter chosen up front", async () => {
  await scenario("chosen", "closed", false, "chosen");
  await scenario("chosen", "none", false, "chosen");
}, 60_000);
