/**
 * CLI-layer tests. We invoke the core `runCli(parseArgs(argv))` directly
 * rather than spawning a child process — it exercises the same code the
 * bin shim drives, without the overhead/flakiness of a subprocess per
 * assertion. The bin shim (`cli.ts`) is a 15-line wrapper we verify
 * shape-wise via a single smoke test.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { ExecutionReceipt } from "@motebit/crypto";

import {
  CliError,
  isCliError,
  parseArgs,
  runCli,
  type CliIo,
  type ParsedArgs,
} from "../cli-core.js";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

// ── fixtures ────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const k of sorted) {
    const v = (obj as Record<string, unknown>)[k];
    if (v === undefined) continue;
    entries.push(JSON.stringify(k) + ":" + canonicalJson(v));
  }
  return "{" + entries.join(",") + "}";
}

async function writeSignedReceipt(): Promise<string> {
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);
  const body: Omit<ExecutionReceipt, "signature" | "suite"> = {
    task_id: "cli-test",
    motebit_id: "01234567-89ab-cdef-0123-456789abcdef",
    public_key: toHex(pk),
    device_id: "dev-1",
    submitted_at: 1_000_000,
    completed_at: 1_001_000,
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a".repeat(16),
    result_hash: "b".repeat(16),
  };
  const withSuite = { ...body, suite: "motebit-jcs-ed25519-b64-v1" as const };
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalJson(withSuite)), sk);
  const receipt = { ...withSuite, signature: toBase64Url(sig) };

  const dir = mkdtempSync(join(tmpdir(), "motebit-verify-cli-"));
  const path = join(dir, "receipt.json");
  writeFileSync(path, JSON.stringify(receipt));
  return path;
}

function captureIo(): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  };
  return { io, stdout: () => out, stderr: () => err };
}

// ── parseArgs ───────────────────────────────────────────────────────

describe("parseArgs — mode routing", () => {
  it("parses a plain file path as a verify invocation", () => {
    const a = parseArgs(["receipt.json"]);
    expect(a.mode).toBe("verify");
    expect(a.file).toBe("receipt.json");
    expect(a.json).toBe(false);
  });

  it("parses --json alongside a file", () => {
    const a = parseArgs(["--json", "r.json"]);
    expect(a.mode).toBe("verify");
    expect(a.json).toBe(true);
  });

  it("parses --expect with all four valid types", () => {
    for (const t of ["identity", "receipt", "credential", "presentation"] as const) {
      const a = parseArgs(["--expect", t, "r.json"]);
      expect(a.expectedType).toBe(t);
    }
  });

  it("parses --clock-skew N", () => {
    const a = parseArgs(["--clock-skew", "30", "r.json"]);
    expect(a.clockSkewSeconds).toBe(30);
  });

  it("routes --help / -h to help mode", () => {
    expect(parseArgs(["--help"]).mode).toBe("help");
    expect(parseArgs(["-h"]).mode).toBe("help");
  });

  it("routes --version / -V to version mode", () => {
    expect(parseArgs(["--version"]).mode).toBe("version");
    expect(parseArgs(["-V"]).mode).toBe("version");
  });
});

describe("parseArgs — usage errors", () => {
  it("rejects unknown flags", () => {
    const a = parseArgs(["--bogus", "r.json"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("--bogus");
  });

  it("rejects --expect without a value", () => {
    const a = parseArgs(["--expect"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("--expect");
  });

  it("rejects unknown --expect value", () => {
    const a = parseArgs(["--expect", "receiptish", "r.json"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("receiptish");
  });

  it("rejects missing --clock-skew value", () => {
    const a = parseArgs(["--clock-skew"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("--clock-skew");
  });

  it("rejects non-integer --clock-skew value", () => {
    const a = parseArgs(["--clock-skew", "thirty"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("integer");
  });

  it("rejects negative --clock-skew value", () => {
    const a = parseArgs(["--clock-skew", "-5"]);
    // Minus sign triggers unknown-flag branch first; either diagnostic is valid.
    expect(a.mode).toBe("help");
    expect(a.usageError).toBeDefined();
  });

  it("rejects a second positional argument", () => {
    const a = parseArgs(["a.json", "b.json"]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("exactly one");
  });

  it("rejects an entirely empty argv", () => {
    const a = parseArgs([]);
    expect(a.mode).toBe("help");
    expect(a.usageError).toContain("missing file");
  });
});

// ── runCli ──────────────────────────────────────────────────────────

describe("runCli — help / version", () => {
  it("help mode prints to stdout and exits 0", async () => {
    const { io, stdout, stderr } = captureIo();
    const code = await runCli({ mode: "help", json: false }, io);
    expect(code).toBe(0);
    expect(stdout()).toContain("motebit-verify");
    expect(stdout()).toContain("USAGE");
    expect(stderr()).toBe("");
  });

  it("help-with-usage-error prints to stderr and exits 2", async () => {
    const { io, stdout, stderr } = captureIo();
    const code = await runCli(
      { mode: "help", json: false, usageError: "missing file argument" },
      io,
    );
    expect(code).toBe(2);
    expect(stderr()).toContain("missing file argument");
    expect(stdout()).toBe("");
  });

  it("version mode prints the version and exits 0", async () => {
    const { io, stdout } = captureIo();
    const code = await runCli({ mode: "version", json: false }, io);
    expect(code).toBe(0);
    // Version is a semver-ish string.
    expect(stdout().trim().length).toBeGreaterThan(0);
  });
});

describe("runCli — verify", () => {
  it("valid receipt file → exit 0 + human-readable output", async () => {
    const path = await writeSignedReceipt();
    const { io, stdout } = captureIo();
    const code = await runCli({ mode: "verify", file: path, json: false }, io);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/^VALID \(receipt\)/);
  });

  it("--json prints structured output", async () => {
    const path = await writeSignedReceipt();
    const { io, stdout } = captureIo();
    const code = await runCli({ mode: "verify", file: path, json: true }, io);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.type).toBe("receipt");
    expect(parsed.valid).toBe(true);
  });

  it("nonexistent file → exit 2 + error on stderr", async () => {
    const { io, stderr } = captureIo();
    const code = await runCli({ mode: "verify", file: "/does/not/exist.json", json: false }, io);
    expect(code).toBe(2);
    expect(stderr()).toContain("cannot read");
  });

  it("tampered receipt → exit 1 + INVALID header", async () => {
    const path = await writeSignedReceipt();
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { result: string };
    raw.result = "TAMPERED";
    writeFileSync(path, JSON.stringify(raw));
    const { io, stdout } = captureIo();
    const code = await runCli({ mode: "verify", file: path, json: false }, io);
    expect(code).toBe(1);
    expect(stdout()).toMatch(/^INVALID /);
  });

  it("--expect credential against a receipt → exit 1, error names the mismatch", async () => {
    const path = await writeSignedReceipt();
    const { io, stdout } = captureIo();
    const args: ParsedArgs = {
      mode: "verify",
      file: path,
      json: false,
      expectedType: "credential",
    };
    const code = await runCli(args, io);
    expect(code).toBe(1);
    expect(stdout()).toContain("credential");
  });

  it("missing-file defensive branch (mode:verify, file undefined) exits 2", async () => {
    const { io, stderr } = captureIo();
    // Synthesize the degenerate case parseArgs can't normally produce —
    // the runCli guard is defensive against callers who bypass
    // parseArgs. Exit code + help-on-stderr is the contract.
    const code = await runCli({ mode: "verify", file: undefined, json: false } as ParsedArgs, io);
    expect(code).toBe(2);
    expect(stderr()).toContain("missing file argument");
  });
});

// ── CliError ────────────────────────────────────────────────────────

describe("runCli — default IO (no io argument)", () => {
  it("writes help to process.stdout when io is omitted", async () => {
    const spy = (() => {
      const calls: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stdout.write = ((chunk: any): boolean => {
        calls.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write;
      return {
        calls,
        restore: () => {
          process.stdout.write = orig;
        },
      };
    })();
    try {
      const code = await runCli({ mode: "help", json: false });
      expect(code).toBe(0);
      expect(spy.calls.join("")).toContain("motebit-verify");
    } finally {
      spy.restore();
    }
  });

  it("writes usage-error help to process.stderr when io is omitted", async () => {
    const spy = (() => {
      const calls: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stderr.write = ((chunk: any): boolean => {
        calls.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stderr.write;
      return {
        calls,
        restore: () => {
          process.stderr.write = orig;
        },
      };
    })();
    try {
      const code = await runCli({
        mode: "help",
        json: false,
        usageError: "missing file argument",
      });
      expect(code).toBe(2);
      expect(spy.calls.join("")).toContain("missing file argument");
    } finally {
      spy.restore();
    }
  });
});

describe("CliError / isCliError", () => {
  it("isCliError distinguishes CliError from generic Error", () => {
    expect(isCliError(new CliError(2, "boom"))).toBe(true);
    expect(isCliError(new Error("boom"))).toBe(false);
    expect(isCliError("boom")).toBe(false);
    expect(isCliError(null)).toBe(false);
  });

  it("CliError carries the exit code", () => {
    const e = new CliError(2, "nope");
    expect(e.code).toBe(2);
    expect(e.message).toBe("nope");
    expect(e.name).toBe("CliError");
  });
});
