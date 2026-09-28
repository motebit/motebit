/**
 * #928 round 2 — the REPL's `/sync` handler, driven as the REPL drives it
 * (`handleSlashCommand("sync", …)`) over a real database. Its plan leg pushed
 * plans in plaintext while the conversation leg beside it encrypted; every
 * body `/sync` puts on the wire is recorded and must carry no plaintext
 * conversation, message or plan content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { generateKeypair } from "@motebit/encryption";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { EventLogEntry, Plan, PlanStep } from "@motebit/sdk";
import { PlaintextPushRefusedError } from "@motebit/sync-engine";
import { createReplEventRemote } from "../runtime-factory.js";
import type { MotebitRuntime } from "@motebit/runtime";
import { handleSlashCommand, type ReplContext } from "../index.js";
import type { CliConfig } from "../args.js";

const MID = "mote-zz928r";
const SECRET = "ZZ928PLAIN";

let moteDb: MotebitDatabase;
let wire: Array<{ path: string; body: string }>;

beforeEach(() => {
  moteDb = createMotebitDatabase(":memory:");
  wire = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (typeof init?.body === "string") wire.push({ path, body: init.body });
      if (init?.method === "POST") return Response.json({ accepted: 1 });
      if (path.endsWith("/conversations")) return Response.json({ conversations: [] });
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/plans")) return Response.json({ plans: [] });
      if (path.endsWith("/plan-steps")) return Response.json({ steps: [] });
      return Response.json({});
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  moteDb.close();
});

function seed(): void {
  const convId = moteDb.conversationStore.createConversation(MID);
  moteDb.conversationStore.updateTitle(convId, `${SECRET} title`);
  moteDb.conversationStore.appendMessage(convId, MID, {
    role: "user",
    content: `${SECRET} message body`,
  });
  const now = Date.now();
  moteDb.planStore.savePlan({
    plan_id: "plan-zz928r",
    goal_id: "goal-zz928r",
    motebit_id: MID,
    title: `${SECRET} plan`,
    status: PlanStatus.Active,
    created_at: now,
    updated_at: now,
    current_step_index: 0,
    total_steps: 1,
  } as Plan);
  moteDb.planStore.saveStep({
    step_id: "step-zz928r",
    plan_id: "plan-zz928r",
    ordinal: 0,
    description: `${SECRET} step`,
    prompt: `${SECRET} prompt`,
    depends_on: [],
    optional: false,
    status: StepStatus.Pending,
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: now,
  } as PlanStep);
}

describe("REPL /sync (#928 round 2)", () => {
  it("with the identity key held, no conversation, message or plan content goes on the wire", async () => {
    seed();
    const kp = await generateKeypair();
    const repl: ReplContext = {
      moteDb,
      motebitId: MID,
      mcpAdapters: [],
      privateKeyBytes: kp.privateKey,
      deviceId: "dev-zz928r",
    };
    const runtime = {
      sync: { sync: async () => ({ pushed: 0, pulled: 0, conflicts: [] }) },
    } as unknown as MotebitRuntime;
    const config = {
      syncUrl: "https://relay.zz928r.test",
      syncToken: "operator-token",
    } as unknown as CliConfig;

    await handleSlashCommand("sync", "", runtime, config, undefined, repl);

    const paths = wire.map((w) => w.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `/sync/${MID}/conversations`,
        `/sync/${MID}/messages`,
        `/sync/${MID}/plans`,
        `/sync/${MID}/plan-steps`,
      ]),
    );
    const all = wire.map((w) => w.body).join("\n");
    expect(all).toContain("plan-zz928r");
    expect(all).not.toContain(SECRET);
  });
});

describe("REPL event remote (createReplEventRemote, what createRuntime connects)", () => {
  const plain = {
    event_id: "p",
    motebit_id: MID,
    timestamp: 0,
    event_type: "state_updated",
    payload: { secret: SECRET },
    version_clock: 1,
    tombstoned: false,
  } as unknown as EventLogEntry;

  it("with the sync key: an encrypting remote over a transport that refuses plaintext", async () => {
    const { remote, transport } = createReplEventRemote({
      syncUrl: "https://relay.zz928r.test",
      motebitId: MID,
      syncToken: "operator-token",
      encKey: new Uint8Array(32).fill(3),
    });
    await expect(transport.append(plain)).rejects.toBeInstanceOf(PlaintextPushRefusedError);
    await remote.append(plain);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.body).not.toContain(SECRET);
  });

  it("without a key it is raw by design", async () => {
    const { remote, transport } = createReplEventRemote({
      syncUrl: "https://relay.zz928r.test",
      motebitId: MID,
      syncToken: "operator-token",
      encKey: undefined,
    });
    expect(remote).toBe(transport);
    expect(transport.payloads).toBe("raw");
  });
});
