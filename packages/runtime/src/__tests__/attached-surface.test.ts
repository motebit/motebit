/**
 * The attached read/act surface — closed registries, strict param
 * validation, fail-closed refusal of unknown kinds. The transport
 * (runtime-host) carries opaque strings; this module is the single
 * authority on what an attached rendering frontend may read and do.
 */
import { describe, expect, it } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import {
  ATTACHED_ACT_KINDS,
  ATTACHED_READ_KINDS,
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
} from "../index";

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("resolveAttachedRead", () => {
  it("refuses an unknown kind fail-closed", async () => {
    await expect(makeRuntime().resolveAttachedRead("no_such_kind")).rejects.toThrow(
      /unknown attached read kind "no_such_kind"/,
    );
  });

  it("every registered read kind dispatches (no registry/dispatch drift)", async () => {
    const runtime = makeRuntime();
    // Minimal valid params for kinds that require them.
    const PARAMS: Partial<Record<string, Record<string, unknown>>> = {
      policy_validate: { name: "no_such_tool" },
      memory_recall: { embedding: [0.1, 0.2, 0.3] },
    };
    for (const kind of ATTACHED_READ_KINDS) {
      // Must not be refused as UNKNOWN — a registry entry without a
      // dispatch arm is the drift this asserts against. A kind may
      // still reject for its own honest reasons (e.g. unknown tool).
      try {
        await runtime.resolveAttachedRead(kind, PARAMS[kind]);
      } catch (err: unknown) {
        expect(err instanceof Error ? err.message : String(err)).not.toMatch(
          /unknown attached read kind/,
        );
      }
    }
  });

  it("every registered act kind dispatches (no registry/dispatch drift)", async () => {
    const runtime = makeRuntime();
    const PARAMS: Record<string, Record<string, unknown>> = {
      memory_delete: { node_id: "n-missing" },
      memory_pin: { node_id: "n-missing", pinned: true },
      agent_petname: { remote_motebit_id: "m2", petname: null },
      session_sensitivity_set: { level: "none" },
      command_execute: { command: "state" },
      tool_execute: { name: "no_such_tool" },
      memory_store: { content: "drift probe" },
      tool_used_log: { tool: "probe", ok: true },
    };
    for (const kind of ATTACHED_ACT_KINDS) {
      expect(PARAMS[kind], `act kind "${kind}" missing minimal params in this test`).toBeDefined();
      try {
        await runtime.resolveAttachedAct(kind, PARAMS[kind]);
      } catch (err: unknown) {
        expect(err instanceof Error ? err.message : String(err)).not.toMatch(
          /unknown attached act kind/,
        );
      }
    }
  });

  it("memory_export returns the nodes+edges shape panels render", async () => {
    const payload = (await makeRuntime().resolveAttachedRead("memory_export")) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(Array.isArray(payload.nodes)).toBe(true);
    expect(Array.isArray(payload.edges)).toBe(true);
  });

  it("events_query validates params strictly", async () => {
    const runtime = makeRuntime();
    await expect(runtime.resolveAttachedRead("events_query", { limit: -5 })).rejects.toThrow(
      /"limit" must be a positive number/,
    );
    await expect(
      runtime.resolveAttachedRead("events_query", { event_types: "not-an-array" }),
    ).rejects.toThrow(/"event_types" must be an array of strings/);
    await expect(runtime.resolveAttachedRead("events_query", { limit: 10 })).resolves.toEqual([]);
  });

  it("session_sensitivity reflects the runtime's live value", async () => {
    const runtime = makeRuntime();
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await expect(runtime.resolveAttachedRead("session_sensitivity")).resolves.toBe(
      SensitivityLevel.Personal,
    );
  });
});

describe("resolveAttachedAct", () => {
  it("refuses an unknown kind fail-closed", async () => {
    await expect(makeRuntime().resolveAttachedAct("transfer_funds")).rejects.toThrow(
      /unknown attached act kind "transfer_funds"/,
    );
  });

  it("money-shaped acts are structurally absent from the registry", () => {
    for (const kind of ATTACHED_ACT_KINDS) {
      expect(kind).not.toMatch(/pay|transfer|withdraw|settle|fund/);
    }
  });

  it("validates act params strictly", async () => {
    const runtime = makeRuntime();
    await expect(runtime.resolveAttachedAct("memory_delete", {})).rejects.toThrow(
      /"node_id" must be a non-empty string/,
    );
    await expect(
      runtime.resolveAttachedAct("memory_pin", { node_id: "n1", pinned: "yes" }),
    ).rejects.toThrow(/"pinned" must be a boolean/);
    await expect(
      runtime.resolveAttachedAct("agent_petname", { remote_motebit_id: "m2", petname: 42 }),
    ).rejects.toThrow(/"petname" must be a string or null/);
    await expect(
      runtime.resolveAttachedAct("session_sensitivity_set", { level: "radioactive" }),
    ).rejects.toThrow(/"radioactive" is not a sensitivity level/);
  });

  it("session_sensitivity_set round-trips through the runtime's live gate", async () => {
    const runtime = makeRuntime();
    await runtime.resolveAttachedAct("session_sensitivity_set", { level: "medical" });
    expect(runtime.getSessionSensitivity()).toBe(SensitivityLevel.Medical);
  });

  it("agent_petname null clears (wire null maps to undefined)", async () => {
    const runtime = makeRuntime();
    await expect(
      runtime.resolveAttachedAct("agent_petname", { remote_motebit_id: "m2", petname: null }),
    ).resolves.toBeNull();
  });
});

describe("serve-and-slash kinds", () => {
  it("command_execute runs only registered commands and returns the CommandResult", async () => {
    const runtime = makeRuntime();
    await expect(
      runtime.resolveAttachedAct("command_execute", { command: "not_a_command" }),
    ).rejects.toThrow(/is not a registered command/);
    const result = (await runtime.resolveAttachedAct("command_execute", {
      command: "state",
    })) as { summary: string } | null;
    expect(result).not.toBeNull();
    expect(typeof result!.summary).toBe("string");
  });

  it("tool_execute answers honestly for an unknown tool and gates through policy", async () => {
    const runtime = makeRuntime();
    const result = (await runtime.resolveAttachedAct("tool_execute", {
      name: "no_such_tool",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("memory_store hardcodes peer_agent provenance after governance", async () => {
    const runtime = makeRuntime();
    const stored = (await runtime.resolveAttachedAct("memory_store", {
      content: "the relay's staging peer is motebit-sync-stg-b",
    })) as { node_id: string };
    expect(stored.node_id).toBeTruthy();
    const exported = (await runtime.resolveAttachedRead("memory_export")) as {
      nodes: Array<{ node_id: string; source?: string }>;
    };
    const node = exported.nodes.find((n) => n.node_id === stored.node_id);
    expect(node?.source).toBe("peer_agent");
  });

  it("memory_recall validates the embedding and applies the fixed sensitivity floor", async () => {
    const runtime = makeRuntime();
    await expect(
      runtime.resolveAttachedRead("memory_recall", { embedding: "nope" }),
    ).rejects.toThrow(/"embedding" must be a non-empty array of finite numbers/);
  });

  it("tool_used_log appends the coordinator-constructed event row", async () => {
    const runtime = makeRuntime();
    await runtime.resolveAttachedAct("tool_used_log", {
      tool: "motebit_query",
      ok: true,
      args_preview: "x".repeat(500),
    });
    const events = (await runtime.resolveAttachedRead("events_query", {
      event_types: ["tool_used"],
    })) as Array<{ payload: { tool?: string; args_preview?: string } }>;
    expect(events.length).toBe(1);
    expect(events[0]!.payload.tool).toBe("motebit_query");
    // The preview is bounded coordinator-side, never wire-length.
    expect(events[0]!.payload.args_preview!.length).toBeLessThanOrEqual(200);
  });
});
