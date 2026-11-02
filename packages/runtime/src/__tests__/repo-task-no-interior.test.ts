/**
 * Repo task: no interior. The run reads no file and no config (every
 * `fs` / `os` entry point is recorded, and throws, while it runs — recorded
 * too, so a caller that swallows the throw is still caught), forms no memory
 * however the
 * model tags its text, and every pack it sends carries nothing but the
 * scope, the two tools and the run's own conversation.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const armed = { on: false };
/** Every fs / os call made while armed. */
const touched: string[] = [];

/** Wrap every function export of a module so it throws while `armed.on`. */
function tripwire<T extends Record<string, unknown>>(mod: T, label: string): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mod)) {
    out[k] =
      typeof v === "function"
        ? (...a: unknown[]) => {
            if (armed.on) {
              touched.push(`${label}.${k}`);
              throw new Error(`repo task touched ${label}.${k}`);
            }
            return (v as (...x: unknown[]) => unknown)(...a);
          }
        : v;
  }
  return out as T;
}

for (const id of ["node:fs", "fs", "node:fs/promises", "fs/promises", "node:os", "os"]) {
  vi.doMock(id, async () => {
    const actual = await vi.importActual<Record<string, unknown>>(id);
    const wrapped = tripwire(actual, id);
    return {
      ...wrapped,
      default: tripwire((actual.default ?? actual) as Record<string, unknown>, id),
    };
  });
}

const { runRepoTask } = await import("../repo-task/index.js");
const { InMemoryToolReceiptSink } = await import("../tool-receipt-sink.js");
const { agentA, call, ids, makeBundle, MemTree, MemWriter, scriptedModel, T0 } =
  await import("./repo-task-fixtures.js");

async function runArmed(turns: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(turns);
  const input = {
    authority: await makeBundle(),
    agent: await agentA(),
    provider: model,
    providerName: "scripted",
    reader: MemTree.withFile("docs/a.md", "teh\n"),
    stager: new MemWriter(),
    receipts: new InMemoryToolReceiptSink(),
    runtimeVersion: "9.9.9",
    clock: () => T0 + 60_000,
    newId: ids,
  };
  touched.length = 0;
  armed.on = true;
  try {
    return { result: await runRepoTask(input), model, touched: [...touched] };
  } finally {
    armed.on = false;
  }
}

describe("repo task: no interior", () => {
  it("the tripwire is live: an fs read while armed throws", async () => {
    const fs = await import("node:fs");
    armed.on = true;
    try {
      expect(() => fs.readFileSync("/dev/null")).toThrow(/repo task touched/);
    } finally {
      armed.on = false;
    }
  });

  it("reads no file and no config, and forms no memory however the model tags its text", async () => {
    const {
      result,
      model,
      touched: calls,
    } = await runArmed([
      [call("c1", "repo_read_blob", { path: "docs/a.md" })],
      [call("c2", "repo_write_path", { path: "docs/a.md", content: "the\n" })],
      "<memory>The user's name is Dana</memory> Done. <state>curiosity=0.9</state>",
    ]);
    expect(calls).toEqual([]);
    expect(result.ended).toBe("model_done");
    expect(result.memories_formed).toBe(0);
    expect(model.packs).toHaveLength(3);
  });

  it("every pack carries only the scope, the two tools and the run's conversation", async () => {
    const { model } = await runArmed([
      [call("c1", "repo_read_blob", { path: "docs/a.md" })],
      "done",
    ]);
    const allowedKeys = new Set([
      "recent_events",
      "relevant_memories",
      "current_state",
      "user_message",
      "conversation_history",
      "tools",
      "precisionContext",
    ]);
    for (const pack of model.packs) {
      for (const key of Object.keys(pack)) expect(allowedKeys.has(key), key).toBe(true);
      expect(pack.recent_events).toEqual([]);
      expect(pack.relevant_memories).toEqual([]);
      expect(pack.current_state).toEqual({
        attention: 0,
        processing: 0,
        confidence: 0.5,
        affect_valence: 0,
        affect_arousal: 0,
        social_distance: 0.5,
        curiosity: 0,
        trust_mode: "guarded",
        battery_mode: "normal",
      });
      expect(pack.tools!.map((t) => t.name)).toEqual(["repo_read_blob", "repo_write_path"]);
    }
    expect(model.packs[0]!.conversation_history).toBeUndefined();
    expect(model.packs[1]!.conversation_history!.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("the run's modules import no store, memory, sync, skills, MCP, config or filesystem module", () => {
    const dir = join(__dirname, "..", "repo-task");
    const allowed = new Set([
      "@motebit/ai-core",
      "@motebit/crypto",
      "@motebit/protocol",
      "@motebit/sdk",
      "@motebit/verifier",
      "../tool-receipt-sink.js",
      "./authority.js",
      "./system-prompt.js",
      "./tools.js",
      "./run.js",
    ]);
    const seen: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        seen.push(m[1]!);
        expect(allowed.has(m[1]!), `${file} imports ${m[1]}`).toBe(true);
      }
      expect(src).not.toMatch(/\bimport\(/);
      expect(src).not.toMatch(/\brequire\(/);
    }
    expect(seen).toContain("@motebit/crypto");
  });
});
