/**
 * The worktree writer against a concurrent local writer: a swap injected
 * right before or right after the writer's `open` (the window between the
 * walk and the write). The writer opens without O_TRUNC, proves the
 * descriptor is the walked file in the walked directory, and only then
 * truncates and writes — so a swap is refused (`path_raced`) and nothing
 * outside the worktree is truncated or written. The one stated cost: an
 * intermediate-directory swap can leave an EMPTY new file outside (Node has
 * no `openat`).
 */
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeOpen: null as null | (() => void),
  afterOpen: null as null | (() => void),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    const before = hooks.beforeOpen;
    hooks.beforeOpen = null;
    before?.();
    const fd = actual.openSync(...args);
    const after = hooks.afterOpen;
    hooks.afterOpen = null;
    after?.();
    return fd;
  };
  return { ...actual, openSync, default: { ...actual, openSync } };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { createWorktreeWriter } = await import("../worktree-writer.js");

let root = "";
let repo = "";
let outside = "";

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-task-race-")));
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "b.md"), "secret\n");
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "original\n");
});

afterEach(() => {
  hooks.beforeOpen = null;
  hooks.afterOpen = null;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Replace repo/docs with a symlink to `outside` (the walked directory is gone). */
const swapDirectoryForSymlink = (): void => {
  fs.renameSync(path.join(repo, "docs"), path.join(repo, "docs-moved"));
  fs.symlinkSync(outside, path.join(repo, "docs"));
};

describe("worktree writer: a swap between the walk and the write is refused", () => {
  it("a directory swapped for a symlink before the open: nothing outside is truncated or written", async () => {
    const writer = createWorktreeWriter({ root: repo });
    hooks.beforeOpen = swapDirectoryForSymlink;
    const result = await writer.write("docs/b.md", new TextEncoder().encode("pwned\n"));
    expect(result).toEqual({ ok: false, refusal: "path_raced" });
    // No O_TRUNC before the check: the existing outside file keeps its bytes.
    expect(fs.readFileSync(path.join(outside, "b.md"), "utf8")).toBe("secret\n");
  });

  it("a directory swap that creates a new file outside leaves it EMPTY (the stated cost)", async () => {
    const writer = createWorktreeWriter({ root: repo });
    hooks.beforeOpen = swapDirectoryForSymlink;
    const result = await writer.write("docs/new.md", new TextEncoder().encode("pwned\n"));
    expect(result).toEqual({ ok: false, refusal: "path_raced" });
    expect(fs.readFileSync(path.join(outside, "new.md"), "utf8")).toBe("");
  });

  it("the file replaced right after the open: the swapped-in file is not written", async () => {
    const writer = createWorktreeWriter({ root: repo });
    hooks.afterOpen = () => {
      const tmp = path.join(repo, "docs", "a.md.swap");
      fs.writeFileSync(tmp, "someone else\n");
      fs.renameSync(tmp, path.join(repo, "docs", "a.md"));
    };
    const result = await writer.write("docs/a.md", new TextEncoder().encode("ours\n"));
    expect(result).toEqual({ ok: false, refusal: "path_raced" });
    expect(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf8")).toBe("someone else\n");
  });

  it("no swap: the write lands (positive control)", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("docs/a.md", new TextEncoder().encode("ours\n"))).toEqual({
      ok: true,
    });
    expect(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf8")).toBe("ours\n");
  });
});
