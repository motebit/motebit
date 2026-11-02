/**
 * The repo-task run signs with its own copy of the agent key and erases that
 * copy on every exit (the CLI erases only its own buffer). The signer is
 * wrapped to capture the exact buffer the run signs with.
 */
import { describe, expect, it, vi } from "vitest";

const signedWith: Uint8Array[] = [];
vi.mock("@motebit/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("@motebit/crypto")>();
  return {
    ...real,
    signToolInvocationReceipt: ((receipt, privateKey, ...rest) => {
      signedWith.push(privateKey);
      return real.signToolInvocationReceipt(receipt, privateKey, ...rest);
    }) as typeof real.signToolInvocationReceipt,
  };
});

import { InMemoryToolReceiptSink } from "../tool-receipt-sink.js";
import type { ToolReceiptSink } from "../tool-receipt-sink.js";
import { runRepoTask } from "../repo-task/index.js";
import type { RepoTaskRunInput } from "../repo-task/index.js";
import {
  agentA,
  call,
  ids,
  makeBundle,
  MemTree,
  MemWriter,
  scriptedModel,
  T0,
  type Turn,
} from "./repo-task-fixtures.js";

async function input(turns: Turn[]): Promise<RepoTaskRunInput> {
  return {
    authority: await makeBundle(),
    agent: await agentA(),
    provider: scriptedModel(turns),
    providerName: "scripted",
    reader: MemTree.withFile("docs/a.md", "teh typo\n"),
    stager: new MemWriter(),
    receipts: new InMemoryToolReceiptSink(),
    runtimeVersion: "9.9.9",
    clock: () => T0 + 60_000,
    newId: ids,
  };
}

const erased = (k: Uint8Array): boolean => k.length > 0 && k.every((b) => b === 0);

describe("repo task: the run's copy of the agent key is erased on every exit", () => {
  it("after a completed run, the buffer that signed is all zeros; the caller's is untouched", async () => {
    signedWith.length = 0;
    const i = await input([[call("c1", "repo_read_blob", { path: "docs/a.md" })], "done"]);
    await runRepoTask(i);
    expect(signedWith.length).toBeGreaterThan(0);
    expect(signedWith[0]).not.toBe(i.agent.privateKey);
    expect(signedWith.every(erased)).toBe(true);
    expect(erased(i.agent.privateKey)).toBe(false);
  });

  it("after a run that throws mid-way, the buffer that signed is all zeros", async () => {
    signedWith.length = 0;
    const i = await input([[call("c1", "repo_read_blob", { path: "docs/a.md" })], "done"]);
    // The durable sink refuses the first receipt after it is signed: the run aborts.
    const sink: ToolReceiptSink = { append: () => Promise.reject(new Error("disk full")) };
    await expect(runRepoTask({ ...i, receipts: sink })).rejects.toThrow();
    expect(signedWith.length).toBeGreaterThan(0);
    expect(signedWith.every(erased)).toBe(true);
  });
});
