/**
 * Tests for the Tauri IPC adapter that bridges the SkillsPanelAdapter
 * surface to the Rust `skills_*` commands.
 *
 * The contract these tests pin:
 *   - Each adapter method invokes the matching `skills_*` command name
 *     with the right argument shape (no extra fields, no missing
 *     fields). A drift here is silent in production — Tauri returns
 *     undefined for missing args — so the test is the only safety
 *     net.
 *   - Structured IpcError objects from Tauri get translated into
 *     `Error(`<reason>: <message>`)` so the controller's `state.error`
 *     carries the typed reason for the UI to format.
 *   - Non-IpcError throws still surface as Errors (no swallowing).
 *   - URL install sources are rejected at the TS boundary (phase 4.5),
 *     not silently no-op'd.
 */
import { describe, expect, it } from "vitest";

import type { SkillSummary, SkillsInstallSource } from "@motebit/panels";

import { TauriIpcSkillsPanelAdapter } from "../skills-ipc";
import type { InvokeFn } from "../tauri-storage";

function makeInvoke<T>(result: T): {
  invoke: InvokeFn;
  calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    return result;
  }) as unknown as InvokeFn;
  return { invoke, calls };
}

function makeFailingInvoke(error: unknown): InvokeFn {
  return (async () => {
    throw error;
  }) as unknown as InvokeFn;
}

describe("TauriIpcSkillsPanelAdapter", () => {
  it("listSkills calls skills_list with no args", async () => {
    const summary: SkillSummary = {
      name: "demo",
      version: "1.0.0",
      description: "d",
      enabled: true,
      trusted: false,
      provenance_status: "verified",
      sensitivity: "none",
      installed_at: "2026-04-29T00:00:00.000Z",
      source: "directory:/x",
    };
    const { invoke, calls } = makeInvoke<SkillSummary[]>([summary]);
    const adapter = new TauriIpcSkillsPanelAdapter(invoke);
    const out = await adapter.listSkills();
    expect(out).toEqual([summary]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("skills_list");
    expect(calls[0]?.args).toEqual({});
  });

  it("readSkillDetail forwards the name", async () => {
    const { invoke, calls } = makeInvoke<null>(null);
    const adapter = new TauriIpcSkillsPanelAdapter(invoke);
    await adapter.readSkillDetail("foo");
    expect(calls[0]?.cmd).toBe("skills_read_detail");
    expect(calls[0]?.args).toEqual({ name: "foo" });
  });

  it("installFromSource directory forwards path and uses skills_install_directory", async () => {
    const { invoke, calls } = makeInvoke({
      name: "x",
      version: "1.0.0",
      provenance_status: "verified",
    });
    const adapter = new TauriIpcSkillsPanelAdapter(invoke);
    const source: SkillsInstallSource = { kind: "directory", path: "/skills/foo" };
    await adapter.installFromSource(source);
    expect(calls[0]?.cmd).toBe("skills_install_directory");
    expect(calls[0]?.args).toEqual({ path: "/skills/foo" });
  });

  it("installFromSource rejects url sources at the TS boundary", async () => {
    const adapter = new TauriIpcSkillsPanelAdapter(makeInvoke(null).invoke);
    await expect(
      adapter.installFromSource({ kind: "url", url: "https://x.test/skill" }),
    ).rejects.toThrow(/url.*not supported/i);
  });

  it("enable/disable/trust/untrust/remove all forward {name}", async () => {
    const { invoke, calls } = makeInvoke<null>(null);
    const adapter = new TauriIpcSkillsPanelAdapter(invoke);
    await adapter.enableSkill("a");
    await adapter.disableSkill("b");
    await adapter.trustSkill("c");
    await adapter.untrustSkill("d");
    await adapter.removeSkill("e");
    expect(calls.map((c) => c.cmd)).toEqual([
      "skills_enable",
      "skills_disable",
      "skills_trust",
      "skills_untrust",
      "skills_remove",
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      { name: "a" },
      { name: "b" },
      { name: "c" },
      { name: "d" },
      { name: "e" },
    ]);
  });

  it("verifySkill forwards name and returns the typed status", async () => {
    const { invoke, calls } = makeInvoke<"verified">("verified");
    const adapter = new TauriIpcSkillsPanelAdapter(invoke);
    const status = await adapter.verifySkill("foo");
    expect(status).toBe("verified");
    expect(calls[0]?.cmd).toBe("skills_verify");
    expect(calls[0]?.args).toEqual({ name: "foo" });
  });

  it("translates structured IpcError into Error('<reason>: <message>')", async () => {
    const adapter = new TauriIpcSkillsPanelAdapter(
      makeFailingInvoke({ reason: "verification_failed", message: "tampered" }),
    );
    await expect(adapter.installFromSource({ kind: "directory", path: "/x" })).rejects.toThrow(
      "verification_failed: tampered",
    );
  });

  it("preserves a sidecar_unavailable reason for the UI to format", async () => {
    const adapter = new TauriIpcSkillsPanelAdapter(
      makeFailingInvoke({ reason: "sidecar_unavailable", message: "Node not on PATH" }),
    );
    await expect(adapter.listSkills()).rejects.toThrow("sidecar_unavailable: Node not on PATH");
  });

  it("rewraps non-Error non-IpcError throws as Error", async () => {
    const adapter = new TauriIpcSkillsPanelAdapter(makeFailingInvoke("plain string"));
    await expect(adapter.listSkills()).rejects.toThrow("plain string");
  });

  it("rethrows real Error instances unchanged", async () => {
    // Reference equality matters here: a re-wrapped clone would lose
    // the original `cause` chain that the controller's `state.error`
    // surface relies on for diagnostics.
    const original = new Error("boom");
    const adapter = new TauriIpcSkillsPanelAdapter(makeFailingInvoke(original));
    await expect(adapter.listSkills()).rejects.toBe(original);
  });
});
