import { describe, expect, it } from "vitest";
import { defaultRuntimeHostPaths, runtimeHostPathsForDir } from "../paths.js";

describe("defaultRuntimeHostPaths", () => {
  it("resolves the unix socket + lockfile under ~/.motebit", () => {
    const paths = defaultRuntimeHostPaths("/home/alice", "linux");
    expect(paths.socketPath).toBe("/home/alice/.motebit/runtime.sock");
    expect(paths.lockfilePath).toBe("/home/alice/.motebit/runtime.lock");
  });

  it("uses the same shape on darwin", () => {
    const paths = defaultRuntimeHostPaths("/Users/bob", "darwin");
    expect(paths.socketPath).toBe("/Users/bob/.motebit/runtime.sock");
  });

  it("maps to a home-derived named pipe on Windows, lockfile stays a file", () => {
    const paths = defaultRuntimeHostPaths("C:\\Users\\carol", "win32");
    expect(paths.socketPath).toMatch(/^\\\\\.\\pipe\\motebit-runtime-[0-9a-f]{16}$/);
    expect(paths.lockfilePath.endsWith("runtime.lock")).toBe(true);
  });

  it("derives distinct pipe names for distinct Windows homes, deterministically", () => {
    const a = defaultRuntimeHostPaths("C:\\Users\\carol", "win32");
    const b = defaultRuntimeHostPaths("C:\\Users\\dave", "win32");
    expect(a.socketPath).not.toBe(b.socketPath);
    expect(defaultRuntimeHostPaths("C:\\Users\\carol", "win32").socketPath).toBe(a.socketPath);
  });
});

// #512 — the election root follows the config root. A sandboxed
// MOTEBIT_CONFIG_DIR is a different sovereign; sharing homedir()'s socket
// attached it to the user's live coordinator (witnessed 2026-07-31).
describe("runtimeHostPathsForDir", () => {
  it("puts socket + lockfile inside the given config root", () => {
    const paths = runtimeHostPathsForDir("/tmp/agent-a/.motebit", "linux");
    expect(paths.socketPath).toBe("/tmp/agent-a/.motebit/runtime.sock");
    expect(paths.lockfilePath).toBe("/tmp/agent-a/.motebit/runtime.lock");
  });

  it("two config roots elect independently — different sockets", () => {
    const a = runtimeHostPathsForDir("/tmp/agent-a/.motebit", "linux");
    const b = runtimeHostPathsForDir("/tmp/agent-b/.motebit", "linux");
    expect(a.socketPath).not.toBe(b.socketPath);
  });

  it("defaultRuntimeHostPaths is the same derivation rooted at ~/.motebit", () => {
    expect(defaultRuntimeHostPaths("/home/alice", "linux")).toEqual(
      runtimeHostPathsForDir("/home/alice/.motebit", "linux"),
    );
  });

  it("fails LOUD past the unix sun_path limit, naming the repair", () => {
    const deep = "/tmp/" + "x".repeat(120) + "/.motebit";
    expect(() => runtimeHostPathsForDir(deep, "darwin")).toThrow(/shorter|limit|104/i);
  });

  it("windows named pipes have no length constraint — deep dirs hash fine", () => {
    const deep = "C:\\Users\\" + "x".repeat(200) + "\\.motebit";
    const paths = runtimeHostPathsForDir(deep, "win32");
    expect(paths.socketPath).toMatch(/^\\\\\.\\pipe\\motebit-runtime-[0-9a-f]{16}$/);
  });
});
