import { describe, it, expect, vi } from "vitest";
import type { InvokeFn } from "../tauri-storage";
import {
  tauriReadFileDefinition,
  createTauriReadFileHandler,
  tauriWriteFileDefinition,
  createTauriWriteFileHandler,
  tauriShellExecDefinition,
  createTauriShellExecHandler,
} from "../tauri-tools";

// ---------------------------------------------------------------------------
// Tool Definitions — schema validation
// ---------------------------------------------------------------------------

describe("tauriReadFileDefinition", () => {
  it("has the correct name and required fields", () => {
    expect(tauriReadFileDefinition.name).toBe("read_file");
    expect(tauriReadFileDefinition.inputSchema).toBeDefined();
    const schema = tauriReadFileDefinition.inputSchema as { required: string[] };
    expect(schema.required).toContain("path");
  });

  it("does not require approval", () => {
    expect(tauriReadFileDefinition.requiresApproval).toBeFalsy();
  });
});

describe("tauriWriteFileDefinition", () => {
  it("has the correct name and required fields", () => {
    expect(tauriWriteFileDefinition.name).toBe("write_file");
    expect(tauriWriteFileDefinition.inputSchema).toBeDefined();
    const schema = tauriWriteFileDefinition.inputSchema as { required: string[] };
    expect(schema.required).toContain("path");
    expect(schema.required).toContain("content");
  });

  it("requires approval", () => {
    expect(tauriWriteFileDefinition.requiresApproval).toBe(true);
  });
});

describe("tauriShellExecDefinition", () => {
  it("has the correct name and required fields", () => {
    expect(tauriShellExecDefinition.name).toBe("shell_exec");
    expect(tauriShellExecDefinition.inputSchema).toBeDefined();
    const schema = tauriShellExecDefinition.inputSchema as { required: string[] };
    expect(schema.required).toContain("command");
  });

  it("requires approval", () => {
    expect(tauriShellExecDefinition.requiresApproval).toBe(true);
  });

  it("has cwd as optional", () => {
    const schema = tauriShellExecDefinition.inputSchema as { required: string[] };
    expect(schema.required).not.toContain("cwd");
  });
});

// ---------------------------------------------------------------------------
// read_file handler
// ---------------------------------------------------------------------------

describe("createTauriReadFileHandler", () => {
  it("returns file contents on success", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue("hello world");
    const handler = createTauriReadFileHandler(invoke);

    const result = await handler({ path: "/tmp/test.txt" });

    expect(result.ok).toBe(true);
    expect(result.data).toBe("hello world");
    expect(invoke).toHaveBeenCalledWith("read_file_tool", { path: "/tmp/test.txt" });
  });

  it("returns error when path is missing", async () => {
    const invoke: InvokeFn = vi.fn();
    const handler = createTauriReadFileHandler(invoke);

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter: path");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns error when invoke rejects", async () => {
    const invoke: InvokeFn = vi.fn().mockRejectedValue(new Error("File not found: /nope"));
    const handler = createTauriReadFileHandler(invoke);

    const result = await handler({ path: "/nope" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("truncates content to 16KB", async () => {
    const bigContent = "x".repeat(20000);
    const invoke: InvokeFn = vi.fn().mockResolvedValue(bigContent);
    const handler = createTauriReadFileHandler(invoke);

    const result = await handler({ path: "/tmp/big.txt" });

    expect(result.ok).toBe(true);
    expect((result.data as string).length).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// write_file handler
// ---------------------------------------------------------------------------

describe("createTauriWriteFileHandler", () => {
  it("returns success message on write", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue("Written 5 bytes to /tmp/out.txt");
    const handler = createTauriWriteFileHandler(invoke);

    const result = await handler({ path: "/tmp/out.txt", content: "hello" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("Written");
    expect(invoke).toHaveBeenCalledWith("write_file_tool", {
      path: "/tmp/out.txt",
      content: "hello",
    });
  });

  it("returns error when path is missing", async () => {
    const invoke: InvokeFn = vi.fn();
    const handler = createTauriWriteFileHandler(invoke);

    const result = await handler({ content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameters");
  });

  it("returns error when content is missing", async () => {
    const invoke: InvokeFn = vi.fn();
    const handler = createTauriWriteFileHandler(invoke);

    const result = await handler({ path: "/tmp/out.txt" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameters");
  });

  it("returns error when invoke rejects", async () => {
    const invoke: InvokeFn = vi.fn().mockRejectedValue(new Error("Permission denied: /root/x"));
    const handler = createTauriWriteFileHandler(invoke);

    const result = await handler({ path: "/root/x", content: "data" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// shell_exec handler
// ---------------------------------------------------------------------------

describe("createTauriShellExecHandler", () => {
  it("returns stdout/stderr/exitCode on success", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
    });
    const handler = createTauriShellExecHandler(invoke);

    const result = await handler({ command: "echo hello" });

    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; stderr: string; exitCode: number };
    expect(data.stdout).toBe("hello\n");
    expect(data.stderr).toBe("");
    expect(data.exitCode).toBe(0);
    expect(invoke).toHaveBeenCalledWith("shell_exec_tool", {
      command: "echo hello",
      cwd: null,
    });
  });

  it("passes cwd when provided", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: 0,
    });
    const handler = createTauriShellExecHandler(invoke);

    await handler({ command: "ls", cwd: "/tmp" });

    expect(invoke).toHaveBeenCalledWith("shell_exec_tool", {
      command: "ls",
      cwd: "/tmp",
    });
  });

  it("returns ok: false when exit code is non-zero", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "not found\n",
      exit_code: 1,
    });
    const handler = createTauriShellExecHandler(invoke);

    const result = await handler({ command: "false" });

    expect(result.ok).toBe(false);
    const data = result.data as { stdout: string; stderr: string; exitCode: number };
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toContain("not found");
  });

  it("returns error when command is missing", async () => {
    const invoke: InvokeFn = vi.fn();
    const handler = createTauriShellExecHandler(invoke);

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter: command");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns error when invoke rejects (e.g. timeout)", async () => {
    const invoke: InvokeFn = vi.fn().mockRejectedValue(
      new Error("Command timed out after 30 seconds"),
    );
    const handler = createTauriShellExecHandler(invoke);

    const result = await handler({ command: "sleep 60" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("truncates stdout and stderr to 8KB", async () => {
    const invoke: InvokeFn = vi.fn().mockResolvedValue({
      stdout: "x".repeat(10000),
      stderr: "y".repeat(10000),
      exit_code: 0,
    });
    const handler = createTauriShellExecHandler(invoke);

    const result = await handler({ command: "cat /dev/urandom" });

    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; stderr: string; exitCode: number };
    expect(data.stdout.length).toBe(8000);
    expect(data.stderr.length).toBe(8000);
  });
});
