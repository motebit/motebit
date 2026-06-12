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
    for (const kind of ATTACHED_READ_KINDS) {
      // Must not be refused as unknown — a registry entry without a
      // dispatch arm is the drift this asserts against.
      await expect(runtime.resolveAttachedRead(kind)).resolves.toBeDefined();
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
