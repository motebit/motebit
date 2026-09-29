/**
 * #890 round 5 (3ii) — the real route by which a receipt signed by someone
 * OTHER than the task's worker reached the relay: the MCP forward. The relay
 * presents a task to ONE worker's endpoint; whatever that endpoint returns
 * was stored on the queue entry (served to the delegator's poll) and handed
 * to ingestion, which verifies the signature against the receipt's OWN
 * `motebit_id` — so an endpoint returning another identity's signed failure
 * put a foreign receipt under the task. A delegator reading it as a signed
 * failure would rotate and pay again.
 *
 * The forward now accepts only a receipt signed by the worker it presented
 * the task to; anything else is neither stored nor ingested.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { forwardTaskViaMcp } from "../task-routing.js";

const PORT = 18947;

function workerReturning(receipt: Record<string, unknown>): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      let method = "";
      try {
        method = (JSON.parse(Buffer.concat(chunks).toString()) as { method?: string }).method ?? "";
      } catch {
        /* /health */
      }
      if (method === "tools/call") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  server.listen(PORT, "127.0.0.1");
  return server;
}

function receipt(signer: string, status: "completed" | "failed") {
  return {
    task_id: "task-890",
    relay_task_id: "task-890",
    motebit_id: signer,
    device_id: "dev",
    status,
    result: status,
    signature: "sig",
  };
}

describe("#890 r5: the MCP forward accepts only the presented worker's receipt", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function forward(r: Record<string, unknown>) {
    server = workerReturning(r);
    const queue = new Map<string, { task: { status: string }; receipt?: unknown }>([
      ["task-890", { task: { status: "pending" } }],
    ]);
    const ingested: unknown[] = [];
    const warns: string[] = [];
    await forwardTaskViaMcp(
      `http://127.0.0.1:${PORT}`,
      "task-890",
      "do it",
      "routed-worker",
      queue,
      { info: () => {}, warn: (m: string) => warns.push(m) },
      undefined,
      async (rc) => {
        ingested.push(rc);
      },
      "disp.token",
      { allowPrivateNetwork: true },
    );
    return { ingested, stored: queue.get("task-890")!.receipt, warns };
  }

  it("a receipt signed by ANOTHER identity is neither stored nor ingested", async () => {
    const r = await forward(receipt("evil-worker", "failed"));
    expect(r.ingested).toEqual([]);
    expect(r.stored).toBeUndefined();
    expect(r.warns).toContain("task.mcp_forward_receipt_not_from_worker");
  });

  it("the presented worker's own receipt is stored and ingested", async () => {
    const r = await forward(receipt("routed-worker", "completed"));
    expect(r.ingested).toHaveLength(1);
    expect((r.stored as { motebit_id: string }).motebit_id).toBe("routed-worker");
  });
});
