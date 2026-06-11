import { describe, expect, it } from "vitest";
import { defaultRuntimeHostPaths } from "../paths.js";

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
