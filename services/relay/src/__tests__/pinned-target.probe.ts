/**
 * Differential probe for the pin (task-pin.ts) — run through
 * `scripts/differential-vs-main.ts`, never by the normal suite.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/pinned-target.probe.ts
 *
 * Each cell submits one task and records WHO the relay handed it to, by role
 * (never by id): the route rows, the routing choice, the push wakes. The
 * unpinned cells (the runtime's own-path capability routing, an operator's
 * submission, the planner's master-token label) must observe identically on
 * both trees — unpinned routing is unchanged. The pinned cells differ by
 * intent: on main the decoy is handed a task pinned to someone else.
 */
import { describe, it, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import {
  createAgent,
  createTestRelay,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const pushWakes = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../push-adapter.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../push-adapter.js")>();
  return {
    ...orig,
    attemptPushWake: async (motebitId: string) => {
      pushWakes.calls.push(motebitId);
      return false;
    },
  };
});

const CAP = "web_search";
const observations: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  if (process.env.PROBE_OUT) writeFileSync(process.env.PROBE_OUT, JSON.stringify(observations));
});

async function cell(
  name: string,
  shape: (ids: { delegator: string; target: string }) => { path: string; body: object },
): Promise<void> {
  pushWakes.calls.length = 0;
  process.env.EXPO_ACCESS_TOKEN = "probe";
  const relay: SyncRelay = await createTestRelay();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.method ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const mk = async () => {
      const kp = await generateKeypair();
      return { ...(await createAgent(relay, bytesToHex(kp.publicKey))), kp };
    };
    const delegator = await mk();
    const target = await mk();
    const decoy = await mk();
    const port = (server.address() as AddressInfo).port;
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: decoy.motebitId,
        endpoint_url: `http://127.0.0.1:${port}/mcp`,
        capabilities: [CAP],
        public_key: bytesToHex(decoy.kp.publicKey),
      }),
    });
    await relay.app.request(`/api/v1/agents/${decoy.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: [CAP],
        pricing: [{ capability: CAP, unit_cost: 0, currency: "USD", per: "task" }],
        description: "probe decoy",
      }),
    });
    const roles = new Map([
      [delegator.motebitId, "delegator"],
      [target.motebitId, "target"],
      [decoy.motebitId, "decoy"],
    ]);
    const role = (id: unknown) => (typeof id === "string" ? (roles.get(id) ?? "other") : null);
    const { path, body } = shape({ delegator: delegator.motebitId, target: target.motebitId });
    const res = await relay.app.request(`/agent/${path}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "probe", required_capabilities: [CAP], ...body }),
    });
    const json = (await res.json()) as {
      task_id?: string;
      routing_choice?: { selected_agent?: string } | null;
      dispatch_token?: string;
    };
    await sleep(500);
    const routes = (
      relay.moteDb.db
        .prepare("SELECT executor_id FROM relay_task_routes WHERE task_id = ?")
        .all(json.task_id ?? "") as Array<{ executor_id: string }>
    )
      .map((r) => role(r.executor_id))
      .sort();
    observations[name] = {
      status: res.status,
      routes,
      selected: role(json.routing_choice?.selected_agent),
      submitter_token: json.dispatch_token != null,
      decoy_forwarded: hits.length > 0,
      push_wakes: pushWakes.calls.map(role).sort(),
    };
  } finally {
    await relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("pinned-target differential probe", () => {
  it("unpinned: runtime capability routing (own path)", async () => {
    await cell("unpinned_own_path", ({ delegator }) => ({
      path: delegator,
      body: { submitted_by: delegator },
    }));
  });
  it("unpinned: operator submission, no submitter", async () => {
    await cell("unpinned_operator", ({ delegator }) => ({ path: delegator, body: {} }));
  });
  it("unpinned: planner label under the master token", async () => {
    await cell("unpinned_planner_label", ({ delegator }) => ({
      path: delegator,
      body: { submitted_by: "plan_engine" },
    }));
  });
  it("pinned: motebit delegate --target, target offline", async () => {
    await cell("pinned_cli_target_offline", ({ delegator, target }) => ({
      path: target,
      body: { submitted_by: delegator },
    }));
  });
});
