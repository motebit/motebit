/**
 * Keychain adapter (#438): never touches a real keychain — the exec seam
 * is injected. Platform honesty and fail-open-to-prompt are the contract.
 */
import { describe, it, expect } from "vitest";
import {
  isKeychainSupported,
  readKeychainPassphrase,
  writeKeychainPassphrase,
  deleteKeychainPassphrase,
  keychainEnrollmentStatus,
  type RunSecurity,
} from "../keychain.js";

describe("keychain adapter (injected exec — no real keychain)", () => {
  it("unsupported off macOS: every operation is an honest no-op", () => {
    expect(isKeychainSupported("linux")).toBe(false);
    const run: RunSecurity = () => {
      throw new Error("must not be called");
    };
    expect(readKeychainPassphrase("id", run, "linux")).toBeNull();
    expect(writeKeychainPassphrase("id", "pw", run, "linux")).toBe(false);
    expect(deleteKeychainPassphrase("id", run, "linux")).toBe(false);
    expect(keychainEnrollmentStatus("id", run, "linux")).toBe("unsupported");
  });

  it("read: strips the trailing newline `security -w` emits", () => {
    const run: RunSecurity = (args) => {
      expect(args).toContain("find-generic-password");
      expect(args).toContain("motebit-cli");
      return { status: 0, stdout: "hunter2\n" };
    };
    expect(readKeychainPassphrase("mid-1", run, "darwin")).toBe("hunter2");
  });

  it("read: non-zero exit (item absent, keychain locked) → null, never a throw", () => {
    const run: RunSecurity = () => ({ status: 44, stdout: "" });
    expect(readKeychainPassphrase("mid-1", run, "darwin")).toBeNull();
    expect(keychainEnrollmentStatus("mid-1", run, "darwin")).toBe("not_enrolled");
  });

  it("read: exec throwing → null (fail-open to the interactive prompt)", () => {
    const run: RunSecurity = () => {
      throw new Error("spawn failed");
    };
    expect(readKeychainPassphrase("mid-1", run, "darwin")).toBeNull();
  });

  it("write uses -U (update in place) and the account it was given", () => {
    let seen: string[] = [];
    const run: RunSecurity = (args) => {
      seen = args;
      return { status: 0, stdout: "" };
    };
    expect(writeKeychainPassphrase("mid-1", "pw", run, "darwin")).toBe(true);
    expect(seen).toContain("-U");
    expect(seen).toContain("mid-1");
  });

  it("enrolled status when a value reads back", () => {
    const run: RunSecurity = () => ({ status: 0, stdout: "pw\n" });
    expect(keychainEnrollmentStatus("mid-1", run, "darwin")).toBe("enrolled");
  });
});
