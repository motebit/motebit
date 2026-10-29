/**
 * Repo task: no other tool is offered on any model call. The run asserts the
 * offered entries are the constructed objects, by identity, on every model
 * call. These tests corrupt the registry the builder returns — an extra
 * tool, a same-named stand-in handler, a swap after the first call — and the
 * run must abort before the model sees the corrupted set.
 */
import { describe, expect, it, vi } from "vitest";

import type { RepoTaskToolEntry, RepoTaskToolRegistry } from "../repo-task/index.js";

type Tamper =
  "none" | "extra" | "swap-handler" | "swap-definition" | "swap-on-second-call" | "drop";
const state: { tamper: Tamper } = { tamper: "none" };

vi.mock("../repo-task/tools.js", async () => {
  const actual =
    await vi.importActual<typeof import("../repo-task/tools.js")>("../repo-task/tools.js");
  return {
    ...actual,
    buildRepoTaskTools: (...args: Parameters<typeof actual.buildRepoTaskTools>) => {
      const built = actual.buildRepoTaskTools(...args);
      const real = built.registry.entries;
      const writeEntry = real.find((e) => e.definition.name === "repo_write_path")!;
      // A same-named stand-in: identical name and definition, another handler object.
      const standIn: RepoTaskToolEntry = {
        definition: writeEntry.definition,
        handler: { name: "repo_write_path", invoke: writeEntry.handler.invoke },
      };
      const extra: RepoTaskToolEntry = {
        definition: { ...writeEntry.definition, name: "write_file" },
        handler: { name: "repo_write_path", invoke: writeEntry.handler.invoke },
      };
      let reads = 0;
      const registry: RepoTaskToolRegistry = {
        get entries() {
          reads++;
          switch (state.tamper) {
            case "extra":
              return [...real, extra];
            case "swap-handler":
              return real.map((e) => (e === writeEntry ? standIn : e));
            case "swap-definition":
              return real.map((e) =>
                e === writeEntry ? { definition: { ...e.definition }, handler: e.handler } : e,
              );
            case "drop":
              return real.filter((e) => e !== writeEntry);
            case "swap-on-second-call":
              // Construction reads the entries twice before the first model
              // call (tool names, system prompt); the swap lands after that.
              return reads > 3 ? real.map((e) => (e === writeEntry ? standIn : e)) : real;
            default:
              return real;
          }
        },
      };
      return { registry, expected: built.expected };
    },
  };
});

const { runRepoTask, RepoTaskToolMismatchError } = await import("../repo-task/index.js");
const { InMemoryToolReceiptSink } = await import("../tool-receipt-sink.js");
const { agentA, call, ids, makeBundle, MemTree, MemWriter, scriptedModel, T0 } =
  await import("./repo-task-fixtures.js");

async function run(tamper: Tamper) {
  state.tamper = tamper;
  const model = scriptedModel([
    [call("c1", "repo_read_blob", { path: "docs/a.md" })],
    [call("c2", "repo_write_path", { path: "docs/a.md", content: "x" })],
    "done",
  ]);
  const writer = new MemWriter();
  const sink = new InMemoryToolReceiptSink();
  const promise = runRepoTask({
    authority: await makeBundle(),
    agent: await agentA(),
    provider: model,
    providerName: "scripted",
    reader: MemTree.withFile("docs/a.md", "x"),
    stager: writer,
    receipts: sink,
    runtimeVersion: "9.9.9",
    clock: () => T0 + 60_000,
    newId: ids,
  });
  return { promise, model, writer, sink };
}

describe("repo task: no other tool is offered on any model call", () => {
  it("the untampered registry runs (positive control)", async () => {
    const { promise, model, writer } = await run("none");
    await expect(promise).resolves.toMatchObject({ ended: "model_done" });
    expect(
      model.packs.every(
        (p) => p.tools!.map((t) => t.name).join() === "repo_read_blob,repo_write_path",
      ),
    ).toBe(true);
    expect(writer.calls).toHaveLength(1);
  });

  it("an injected extra tool aborts before the first model call", async () => {
    const { promise, model } = await run("extra");
    await expect(promise).rejects.toBeInstanceOf(RepoTaskToolMismatchError);
    expect(model.packs).toHaveLength(0);
  });

  it("a same-named stand-in handler aborts before the first model call", async () => {
    const { promise, model } = await run("swap-handler");
    await expect(promise).rejects.toBeInstanceOf(RepoTaskToolMismatchError);
    expect(model.packs).toHaveLength(0);
  });

  it("a same-named copy of the definition aborts before the first model call", async () => {
    const { promise, model } = await run("swap-definition");
    await expect(promise).rejects.toBeInstanceOf(RepoTaskToolMismatchError);
    expect(model.packs).toHaveLength(0);
  });

  it("a dropped tool aborts before the first model call", async () => {
    const { promise, model } = await run("drop");
    await expect(promise).rejects.toBeInstanceOf(RepoTaskToolMismatchError);
    expect(model.packs).toHaveLength(0);
  });

  it("a handler swapped mid-run aborts at the next model call, before any write", async () => {
    const { promise, model, writer, sink } = await run("swap-on-second-call");
    await expect(promise).rejects.toBeInstanceOf(RepoTaskToolMismatchError);
    expect(model.packs).toHaveLength(1);
    expect(writer.calls).toHaveLength(0);
    expect(sink.list().map((r) => r.tool_name)).toEqual(["repo_read_blob"]);
  });

  it("the built registry is frozen: entries cannot be pushed, replaced or rewired", async () => {
    const { buildRepoTaskTools } =
      await vi.importActual<typeof import("../repo-task/tools.js")>("../repo-task/tools.js");
    const { registry, expected } = buildRepoTaskTools(
      new Set(["repo_read_blob", "repo_write_path"] as const),
      (await makeBundle()).scope,
      {
        reader: MemTree.withFile("docs/a.md", "x"),
        stager: new MemWriter(),
        authorize: () => Promise.resolve(true),
      },
    );
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    for (const e of registry.entries) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.handler)).toBe(true);
      expect(Object.isFrozen(e.definition)).toBe(true);
    }
    expect(() => (registry.entries as RepoTaskToolEntry[]).push(registry.entries[0]!)).toThrow(
      TypeError,
    );
    expect(() => {
      (registry.entries[0] as { handler: unknown }).handler = null;
    }).toThrow(TypeError);
    expect(expected.size).toBe(2);
  });
});
