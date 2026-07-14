/**
 * forwardTaskViaMcp observability — a non-2xx from the worker's MCP endpoint
 * (401 unauthorized, 503 cold-start, …) must be LOGGED, not silently swallowed.
 *
 * The 2026-07-13 conformance receipt-timeouts had NO forensic signal for hours
 * because the forward sailed through initialize → notifications/initialized →
 * tools/call without checking any response status, parsed null, and returned.
 * The underlying auth failure (worker's MOTEBIT_AUTH_TOKEN unset ⇒ mcp-server
 * has no inbound verifier ⇒ 401 on every forward) was invisible. These tests
 * lock the fix: a paid task's dispatch failure always leaves a trail, and no
 * receipt is ingested on a rejected forward.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { forwardTaskViaMcp } from "../task-routing.js";

const PORT = 18941;

interface LogEntry {
  msg: string;
  ctx: Record<string, unknown>;
}

function capturingLogger(): { entries: LogEntry[]; info: LogEntry[]; logger: unknown } {
  const info: LogEntry[] = [];
  const entries: LogEntry[] = [];
  return {
    entries,
    info,
    logger: {
      info: (msg: string, ctx: Record<string, unknown>) => {
        info.push({ msg, ctx });
        entries.push({ msg, ctx });
      },
      warn: (msg: string, ctx: Record<string, unknown>) => entries.push({ msg, ctx }),
    },
  };
}

describe("forwardTaskViaMcp — non-2xx is loud, never silent", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("logs task.mcp_forward_failed with the status and ingests no receipt on a 401 init", async () => {
    server = createServer((req, res) => {
      // /health wake succeeds; the /mcp POST rejects with 401 — the exact
      // shape of a worker whose inbound verifier is unconfigured.
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "unauthorized — set authToken or use a motebit signed token" }),
      );
    });
    await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", r));

    const cap = capturingLogger();
    const taskQueue = new Map();
    let receiptIngested = false;

    await forwardTaskViaMcp(
      `http://127.0.0.1:${PORT}`,
      "task-401",
      "probe",
      "worker-abc",
      taskQueue,
      cap.logger as Parameters<typeof forwardTaskViaMcp>[5],
      "relay-token",
      async () => {
        receiptIngested = true;
      },
    );

    const failure = cap.entries.find((e) => e.msg === "task.mcp_forward_failed");
    expect(failure).toBeDefined();
    expect(failure!.ctx.status).toBe(401);
    expect(failure!.ctx.step).toBe("initialize");
    // No receipt path runs on a rejected forward.
    expect(receiptIngested).toBe(false);
    expect(cap.entries.find((e) => e.msg === "task.mcp_forward_completed")).toBeUndefined();
  });
});
