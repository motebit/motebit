/**
 * The repo-task run (docs/proposals/governed-repo-change-v1.md, build step 2):
 * it cannot start or write without a valid tick, offers no other tool, forms
 * no memory, and records every call's real status in the durable sink.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@motebit/ai-core";
import { hash, verifyToolInvocationReceipt } from "@motebit/crypto";

import { InMemoryToolReceiptSink } from "../tool-receipt-sink.js";
import {
  buildRepoTaskPack,
  checkRepoTaskAuthority,
  repoTaskFrame,
  RepoTaskAbortedError,
  RepoTaskRefusedError,
  runRepoTask,
} from "../repo-task/index.js";
import type { RepoTaskAuthorityBundle, RepoTaskRunInput } from "../repo-task/index.js";
import {
  agentA,
  A_ID,
  call,
  F_ID,
  hex,
  HOUR,
  ids,
  keys,
  makeBundle,
  MemTree,
  MemWriter,
  revokeGrant,
  scriptedModel,
  T0,
  type BundleOpts,
  type Turn,
} from "./repo-task-fixtures.js";

const enc = new TextEncoder();

async function setup(
  turns: Turn[],
  opts: {
    bundle?: BundleOpts;
    authority?: RepoTaskAuthorityBundle;
    clock?: () => number;
    onCall?: (n: number) => void;
    tree?: MemTree;
    agent?: Awaited<ReturnType<typeof agentA>>;
  } = {},
) {
  const model = scriptedModel(turns, opts.onCall);
  const tree = opts.tree ?? MemTree.withFile("docs/a.md", "teh typo\n");
  const writer = new MemWriter();
  const sink = new InMemoryToolReceiptSink();
  const input: RepoTaskRunInput = {
    authority: opts.authority ?? (await makeBundle(opts.bundle)),
    agent: opts.agent ?? (await agentA()),
    provider: model,
    providerName: "scripted",
    reader: tree,
    writer,
    receipts: sink,
    runtimeVersion: "9.9.9",
    clock: opts.clock ?? (() => T0 + 60_000),
    newId: ids,
  };
  return { input, model, tree, writer, sink };
}

describe("repo task: the run cannot start without a valid tick", () => {
  const cases: Array<[string, BundleOpts, (() => number) | undefined]> = [
    ["an expired tick", {}, () => T0 + HOUR + 1],
    ["a tick not yet valid", { tick: (t) => void (t.not_before = T0 + 30 * 60_000) }, undefined],
    [
      "a tick of another grant",
      { tick: (t) => void (t.grant_id = "ffffffff-4f50-4a61-8b72-93a4b5c6d7e8") },
      undefined,
    ],
    [
      "a tick whose signature does not verify",
      { tickSigned: (t) => void (t.scope = "repo_read_blob") },
      undefined,
    ],
    ["a tick signed by another key", { tickSigner: (k) => k.x }, undefined],
    ["a revoked grant", { revocations: async (k, g) => [await revokeGrant(k, g)] }, undefined],
    [
      "a revocation file that failed strict parsing",
      { revocationFailures: ["bad.json"] },
      undefined,
    ],
    [
      "a scope wider than the two tools",
      {
        grant: (g) => void (g.scope = "repo_read_blob,repo_write_path,web_search"),
        tick: (t) => void (t.scope = "repo_read_blob,repo_write_path,web_search"),
      },
      undefined,
    ],
    ["a tick wider than the grant", { grant: (g) => void (g.scope = "repo_read_blob") }, undefined],
    [
      "a scope the grant does not bind",
      { scopeAfterBinding: (s) => void s.allowed_paths.push("docs/b.md") },
      undefined,
    ],
    ["a grant with no subject_binding", { grant: (g) => void delete g.subject_binding }, undefined],
    ["a grant for another subject", { grant: (g) => void (g.subject = "money") }, undefined],
    [
      "a grant with a spend ceiling",
      { grant: (g) => void (g.spend_ceiling = { amount_micro: 1, currency: "USD" } as never) },
      undefined,
    ],
    [
      "a grant living longer than 24 hours",
      { grant: (g) => void ((g.expires_at = T0 + 25 * HOUR), (g.cadence_ms = 25 * HOUR)) },
      undefined,
    ],
    ["a cadence below the lifetime", { grant: (g) => void (g.cadence_ms = HOUR) }, undefined],
    [
      "a delegator that is not the principal pin",
      { principal: (k) => ({ motebit_id: F_ID, public_key: hex(k.x) }) },
      undefined,
    ],
    [
      "a non-canonical allowed path",
      { scope: (s) => void (s.allowed_paths = ["docs/../a.md"]) },
      undefined,
    ],
    ["an allowed path the predicate refuses", { isPathPermitted: () => false }, undefined],
    ["a scope for another repository", { scope: (s) => void (s.repo = "someone/else") }, undefined],
  ];
  for (const [label, bundle, clock] of cases) {
    it(`refuses ${label} before any model call`, async () => {
      const { input, model, writer, sink, tree } = await setup(
        [[call("c1", "repo_write_path", { path: "docs/a.md", content: "the" })]],
        { bundle, clock },
      );
      await expect(runRepoTask(input)).rejects.toBeInstanceOf(RepoTaskRefusedError);
      expect(model.packs).toHaveLength(0);
      expect(writer.calls).toHaveLength(0);
      expect(tree.lookups).toHaveLength(0);
      expect(sink.list()).toHaveLength(0);
    });
  }

  it("refuses an agent that is not the grant's delegate", async () => {
    const k = await keys();
    const { input, model } = await setup(["done"], {
      agent: await agentA({ privateKey: k.x.privateKey, publicKey: k.x.publicKey }),
    });
    await expect(runRepoTask(input)).rejects.toBeInstanceOf(RepoTaskRefusedError);
    expect(model.packs).toHaveLength(0);
  });

  it("refuses an agent whose private key does not sign as its public key", async () => {
    const k = await keys();
    const { input, model } = await setup(["done"], {
      agent: await agentA({ privateKey: k.x.privateKey }),
    });
    await expect(runRepoTask(input)).rejects.toBeInstanceOf(RepoTaskRefusedError);
    expect(model.packs).toHaveLength(0);
  });

  it("starts on a valid tick (positive control)", async () => {
    const { input, model } = await setup(["nothing to do"]);
    const result = await runRepoTask(input);
    expect(result.ended).toBe("model_done");
    expect(model.packs).toHaveLength(1);
  });

  it("a pre-minted tick whose window opens later is valid once it opens", async () => {
    const bundle = await makeBundle({ tick: (t) => void (t.not_before = T0 + 30 * 60_000) });
    const k = await keys();
    expect(
      (
        await checkRepoTaskAuthority(
          bundle,
          { motebit_id: A_ID, public_key: hex(k.a) },
          T0 + 31 * 60_000,
        )
      ).ok,
    ).toBe(true);
  });
});

describe("repo task: the run cannot write without a valid tick", () => {
  it("a tick that expires mid-run makes the next repo_write_path denied, with no write", async () => {
    let now = T0 + 60_000;
    const { input, writer, sink, model } = await setup(
      [
        [call("c1", "repo_write_path", { path: "docs/a.md", content: "the typo\n" })],
        [call("c2", "repo_write_path", { path: "docs/a.md", content: "the typo!\n" })],
        "done",
      ],
      {
        clock: () => now,
        // The second model call returns after the tick has expired.
        onCall: (n) => {
          if (n === 2) now = T0 + HOUR + 1;
        },
      },
    );
    const result = await runRepoTask(input);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]!.text).toBe("the typo\n");
    expect(sink.list().map((r) => r.status)).toEqual(["completed", "denied"]);
    expect(result.ended).toBe("authority_lapsed");
    expect(model.packs).toHaveLength(2);
  });

  it("a revocation present at preflight is never outrun by a valid-looking call", async () => {
    const { input, writer } = await setup(
      [[call("c1", "repo_write_path", { path: "docs/a.md", content: "x" })]],
      { bundle: { revocations: async (k, g) => [await revokeGrant(k, g)] } },
    );
    await expect(runRepoTask(input)).rejects.toBeInstanceOf(RepoTaskRefusedError);
    expect(writer.calls).toHaveLength(0);
  });
});

describe("repo task: every call's real status, durably recorded", () => {
  it("success is completed, refusal is denied, a throw is failed — each a receipt in the sink", async () => {
    const tree = MemTree.withFile("docs/a.md", "teh typo\n");
    const { input, sink, writer } = await setup(
      [
        [
          call("c1", "repo_read_blob", { path: "docs/a.md" }),
          call("c2", "repo_write_path", { path: "docs/other.md", content: "x" }),
          call("c3", "repo_write_path", { path: "docs/a.md", content: "the typo\n" }),
        ],
        [call("c4", "repo_read_blob", { path: "docs/a.md" })],
        "done",
      ],
      { tree },
    );
    // The second read hits an unreadable object store: the handler throws.
    let reads = 0;
    const realRead = tree.readBlob.bind(tree);
    tree.readBlob = (oid: string) =>
      ++reads === 2 ? Promise.reject(new Error("io")) : realRead(oid);
    const result = await runRepoTask(input);
    const statuses = sink.list().map((r) => [r.tool_name, r.status]);
    expect(statuses).toEqual([
      ["repo_read_blob", "completed"],
      ["repo_write_path", "denied"],
      ["repo_write_path", "completed"],
      ["repo_read_blob", "failed"],
    ]);
    expect(writer.calls.map((c) => c.path)).toEqual(["docs/a.md"]);
    expect(result.tool_receipts).toEqual(sink.list());
    expect(result.tools_used).toEqual(["repo_read_blob", "repo_write_path"]);
    expect(result.written_paths).toEqual(["docs/a.md"]);
    const k = await keys();
    for (const r of sink.list()) {
      expect(r.task_id).toBe(result.task_id);
      expect(r.motebit_id).toBe(A_ID);
      expect(r.public_key).toBe(hex(k.a));
      expect(await verifyToolInvocationReceipt(r, k.a.publicKey)).toBe(true);
    }
  });

  it("a call to a tool the run does not have is denied with a receipt", async () => {
    const { input, sink, writer, tree } = await setup([
      [call("c1", "write_file", { path: "/etc/passwd", content: "x" })],
      "done",
    ]);
    await runRepoTask(input);
    expect(sink.list().map((r) => [r.tool_name, r.status])).toEqual([["write_file", "denied"]]);
    expect(writer.calls).toHaveLength(0);
    expect(tree.lookups).toHaveLength(0);
  });

  it("a sink that rejects aborts the run: no later call runs", async () => {
    const { input, model, writer } = await setup([
      [call("c1", "repo_read_blob", { path: "docs/a.md" })],
      [call("c2", "repo_write_path", { path: "docs/a.md", content: "x" })],
      "done",
    ]);
    const failing = { append: () => Promise.reject(new Error("disk gone")) };
    await expect(runRepoTask({ ...input, receipts: failing })).rejects.toBeInstanceOf(
      RepoTaskAbortedError,
    );
    expect(model.packs).toHaveLength(1);
    expect(writer.calls).toHaveLength(0);
  });

  it("the run stops at the bundle's 256-receipt ceiling", async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      call(`c${i}`, "repo_read_blob", { path: "docs/a.md" }),
    );
    const { input, sink } = await setup([many, "done"]);
    const result = await runRepoTask(input);
    expect(sink.list()).toHaveLength(256);
    expect(result.ended).toBe("receipt_limit");
  });
});

describe("repo task: repo_write_path is closed over the allowed paths", () => {
  async function writeOnce(args: Record<string, unknown>, tree?: MemTree, bundle?: BundleOpts) {
    const s = await setup([[call("c1", "repo_write_path", args)], "done"], { tree, bundle });
    await runRepoTask(s.input);
    return s;
  }

  it("refuses any other path string before touching any I/O", async () => {
    for (const path of [
      "docs/A.md",
      "docs/a.md ",
      "./docs/a.md",
      "docs//a.md",
      "/docs/a.md",
      "docs/a.md\0",
    ]) {
      const { sink, writer, tree } = await writeOnce({ path, content: "x" });
      expect(sink.list().map((r) => r.status)).toEqual(["denied"]);
      expect(writer.calls).toHaveLength(0);
      expect(tree.lookups).toHaveLength(0);
    }
  });

  it("refuses content with a NUL byte", async () => {
    const { sink, writer } = await writeOnce({ path: "docs/a.md", content: "a\0b" });
    expect(sink.list()[0]!.status).toBe("denied");
    expect(writer.calls).toHaveLength(0);
  });

  it("refuses a tracked path that is not a regular 100644 file", async () => {
    for (const entry of [
      { kind: "blob" as const, mode: "100755", oid: "2".repeat(40) },
      { kind: "symlink" as const, mode: "120000", oid: "3".repeat(40) },
      { kind: "gitlink" as const, mode: "160000", oid: "4".repeat(40) },
    ]) {
      const tree = new MemTree().set("docs/a.md", entry);
      const { sink, writer } = await writeOnce({ path: "docs/a.md", content: "x" }, tree);
      expect(sink.list()[0]!.status).toBe("denied");
      expect(writer.calls).toHaveLength(0);
    }
  });

  it("a writer refusal (symlink component) is denied", async () => {
    const s = await setup([
      [call("c1", "repo_write_path", { path: "docs/a.md", content: "x" })],
      "done",
    ]);
    s.writer.refuse = { ok: false, refusal: "symlink_component" };
    await runRepoTask(s.input);
    expect(s.sink.list()[0]!.status).toBe("denied");
  });

  it("a writer that throws is failed", async () => {
    const s = await setup([
      [call("c1", "repo_write_path", { path: "docs/a.md", content: "x" })],
      "done",
    ]);
    s.writer.throwOnWrite = true;
    await runRepoTask(s.input);
    expect(s.sink.list()[0]!.status).toBe("failed");
  });

  it("refuses a write past max_changed_files", async () => {
    const s = await setup(
      [
        [
          call("c1", "repo_write_path", { path: "docs/a.md", content: "x" }),
          call("c2", "repo_write_path", { path: "docs/b.md", content: "y" }),
          call("c3", "repo_write_path", { path: "docs/a.md", content: "z" }),
        ],
        "done",
      ],
      { bundle: { scope: (sc) => void (sc.allowed_paths = ["docs/a.md", "docs/b.md"]) } },
    );
    await runRepoTask(s.input);
    expect(s.sink.list().map((r) => r.status)).toEqual(["completed", "denied", "completed"]);
    expect(s.writer.calls.map((c) => c.path)).toEqual(["docs/a.md", "docs/a.md"]);
  });

  it("a tick without repo_write_path builds no write tool: the call is denied", async () => {
    const s = await setup(
      [[call("c1", "repo_write_path", { path: "docs/a.md", content: "x" })], "done"],
      { bundle: { tick: (t) => void (t.scope = "repo_read_blob") } },
    );
    await runRepoTask(s.input);
    expect(s.model.packs[0]!.tools!.map((t) => t.name)).toEqual(["repo_read_blob"]);
    expect(s.sink.list()[0]!.status).toBe("denied");
    expect(s.writer.calls).toHaveLength(0);
  });
});

describe("repo task: repo_write_path refuses a case alias (the verifier's case rule)", () => {
  async function writeTo(tree: MemTree, bundle?: BundleOpts) {
    const s = await setup(
      [[call("c1", "repo_write_path", { path: "docs/a.md", content: "x" })], "done"],
      { tree, bundle },
    );
    await runRepoTask(s.input);
    return s;
  }

  it("a tracked Docs/A.md (100755) makes docs/a.md denied, before the writer is touched", async () => {
    const tree = new MemTree().set("Docs/A.md", {
      kind: "blob",
      mode: "100755",
      oid: "8".repeat(40),
    });
    const { sink, writer } = await writeTo(tree);
    expect(sink.list().map((r) => r.status)).toEqual(["denied"]);
    expect(writer.calls).toHaveLength(0);
  });

  it("a tracked directory spelled in another case (DOCS/x.md) makes docs/a.md denied", async () => {
    const tree = new MemTree().set("DOCS/x.md", {
      kind: "blob",
      mode: "100644",
      oid: "8".repeat(40),
    });
    const { sink, writer } = await writeTo(tree);
    expect(sink.list().map((r) => r.status)).toEqual(["denied"]);
    expect(writer.calls).toHaveLength(0);
  });

  it("two allowed paths that alias by case are both refused", async () => {
    const { sink, writer } = await writeTo(new MemTree(), {
      scope: (s) => void (s.allowed_paths = ["docs/a.md", "docs/A.md"]),
    });
    expect(sink.list().map((r) => r.status)).toEqual(["denied"]);
    expect(writer.calls).toHaveLength(0);
  });

  it("a tracked path that is not UTF-8 refuses every write (no collision can be ruled out)", async () => {
    const tree = new MemTree();
    tree.extraTrackedBytes.push(new Uint8Array([0x64, 0xff, 0x2e, 0x6d, 0x64]));
    const { sink, writer } = await writeTo(tree);
    expect(sink.list().map((r) => r.status)).toEqual(["denied"]);
    expect(writer.calls).toHaveLength(0);
  });

  it("the same spelling, tracked, is a modify and is written (positive control)", async () => {
    const { sink, writer } = await writeTo(MemTree.withFile("docs/a.md", "old"));
    expect(sink.list().map((r) => r.status)).toEqual(["completed"]);
    expect(writer.calls).toHaveLength(1);
  });
});

describe("repo task: a path counts toward max_changed_files once the writer may open it", () => {
  const twoPaths: BundleOpts = {
    scope: (s) => void (s.allowed_paths = ["docs/a.md", "docs/b.md"]),
  };
  const twoWrites = [
    [
      call("c1", "repo_write_path", { path: "docs/a.md", content: "x" }),
      call("c2", "repo_write_path", { path: "docs/b.md", content: "y" }),
    ],
    "done",
  ] as Turn[];

  it("a write that fails part-way is failed and still counts", async () => {
    const s = await setup(twoWrites, { bundle: twoPaths });
    s.writer.throwNext = 1;
    await runRepoTask(s.input);
    expect(s.sink.list().map((r) => r.status)).toEqual(["failed", "denied"]);
    expect(s.writer.calls.map((c) => c.path)).toEqual(["docs/a.md"]);
  });

  it("a race refused after the open still counts", async () => {
    const s = await setup(twoWrites, { bundle: twoPaths });
    s.writer.refuseNext = [{ ok: false, refusal: "path_raced" }];
    await runRepoTask(s.input);
    expect(s.sink.list().map((r) => r.status)).toEqual(["denied", "denied"]);
    expect(s.writer.calls.map((c) => c.path)).toEqual(["docs/a.md"]);
  });

  it("a refusal made before anything was opened gives the slot back", async () => {
    const s = await setup(twoWrites, { bundle: twoPaths });
    s.writer.refuseNext = [{ ok: false, refusal: "symlink_component" }];
    await runRepoTask(s.input);
    expect(s.sink.list().map((r) => r.status)).toEqual(["denied", "completed"]);
  });
});

describe("repo task: repo_read_blob reads only tracked blobs at the tip", () => {
  async function readOnce(path: unknown, tree: MemTree) {
    const s = await setup([[call("c1", "repo_read_blob", { path })], "done"], { tree });
    await runRepoTask(s.input);
    return s;
  }

  it("returns a tracked blob's text", async () => {
    const s = await readOnce("docs/a.md", MemTree.withFile("docs/a.md", "hello\n"));
    expect(s.sink.list()[0]!.status).toBe("completed");
    const toolMsg = s.model.packs[1]!.conversation_history!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("hello");
    expect(toolMsg.content).toContain("EXTERNAL_DATA");
  });

  it("refuses untracked paths, symlinks, gitlinks and trees", async () => {
    const tree = new MemTree()
      .set("link", { kind: "symlink", mode: "120000", oid: "5".repeat(40) })
      .set("sub", { kind: "gitlink", mode: "160000", oid: "6".repeat(40) })
      .set("docs", { kind: "tree", mode: "040000", oid: "7".repeat(40) });
    for (const p of ["untracked.md", "link", "sub", "docs"]) {
      const s = await readOnce(p, tree);
      expect(s.sink.list()[0]!.status).toBe("denied");
    }
    expect(tree.reads).toHaveLength(0);
  });

  it("refuses an out-of-tree path before any lookup", async () => {
    const tree = MemTree.withFile("docs/a.md", "x");
    for (const p of ["../etc/passwd", "/etc/passwd", "docs/../a.md", "", "a\0b", 7]) {
      const s = await readOnce(p, tree);
      expect(s.sink.list()[0]!.status).toBe("denied");
    }
    expect(tree.lookups).toHaveLength(0);
  });
});

describe("repo task: the system prompt is a pure function of scope, runtime version and model", () => {
  it("records the digest of exactly what the provider renders, the same on every call", async () => {
    const { input, model } = await setup(
      [[call("c1", "repo_read_blob", { path: "docs/a.md" })], "done"],
      { bundle: { scope: (s) => void (s.task = "Line one.\nLine two: fix docs/a.md.") } },
    );
    const result = await runRepoTask(input);
    expect(model.packs).toHaveLength(2);
    const rendered = model.packs.map((p) => buildSystemPrompt(p, undefined, { model: "model-1" }));
    expect(rendered[0]).toBe(result.system_prompt);
    expect(rendered[1]).toBe(result.system_prompt);
    expect(result.system_prompt).not.toContain("Line two");
    expect(result.system_prompt_digest).toEqual({
      algorithm: "sha-256",
      value: await hash(enc.encode(result.system_prompt)),
    });
    expect(result.prompt_hash).toBe(await hash(enc.encode(input.authority.scope.task)));
  });

  it("two runs of the same inputs record the same digest; the runtime version changes it", async () => {
    const a = await runRepoTask((await setup(["done"])).input);
    const b = await runRepoTask((await setup(["done"])).input);
    expect(a.system_prompt_digest).toEqual(b.system_prompt_digest);
    const c = await runRepoTask({ ...(await setup(["done"])).input, runtimeVersion: "9.9.10" });
    expect(c.system_prompt_digest).not.toEqual(a.system_prompt_digest);
    const bundle = await makeBundle();
    expect(a.system_prompt).toContain(
      repoTaskFrame(bundle.scope, ["repo_read_blob", "repo_write_path"], "9.9.9"),
    );
  });

  it("the pack carries the task on the first call only", async () => {
    const bundle = await makeBundle();
    const pack = buildRepoTaskPack({
      scope: bundle.scope,
      tools: [],
      frame: "f",
      history: [],
      first: true,
    });
    expect(pack.user_message).toBe(bundle.scope.task);
    expect(
      buildRepoTaskPack({ scope: bundle.scope, tools: [], frame: "f", history: [], first: false })
        .user_message,
    ).toBe("");
  });
});
