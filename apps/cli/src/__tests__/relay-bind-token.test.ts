/**
 * `motebit relay bind-token` (design test 2): every refusal writes nothing;
 * success writes the hash only; a replacement is announced; no request is
 * made.
 *
 * Tamper: scripts/tampers/cli-operator-token-per-relay.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { CONFIG_DIR } = await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: nothing here reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "mb-ot-bind-"));
  process.env["MOTEBIT_CONFIG_DIR"] = dir;
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"])
    delete process.env[k];
  return { CONFIG_DIR: dir };
});

import { parseCliArgs } from "../args.js";
import { operatorTokenFor, resetOperatorTokenMemoryForTests } from "../relay-operator-token.js";
import { handleRelayBindToken } from "../subcommands/relay-bind-token.js";

const FILE = path.join(CONFIG_DIR, "relay-operator-tokens.json");
const CONFIG_JSON = path.join(CONFIG_DIR, "config.json");
const A = "https://relay-a.test";
const B = "https://relay-b.test";
const TOKEN = "bind-me-0123456789abcdef-operator-token";
const sha = (t: string): string => createHash("sha256").update(t, "utf-8").digest("hex");

let out: string[];
let err: string[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  fs.rmSync(CONFIG_JSON, { force: true });
  resetOperatorTokenMemoryForTests();
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"])
    delete process.env[k];
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${String(code ?? 0)})`);
  }) as never);
  // No request is ever made: any fetch is a failure of the test.
  fetchMock = vi.fn(() => {
    throw new Error("bind-token made a network request");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(fetchMock, "bind-token makes no network request").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run `motebit relay bind-token <args>`; returns the exit code (0 when it returned). */
function bind(...args: string[]): number {
  try {
    handleRelayBindToken(parseCliArgs(["relay", "bind-token", ...args]));
    return 0;
  } catch (e) {
    const m = /^process\.exit\((\d+)\)$/.exec(e instanceof Error ? e.message : "");
    if (m === null) throw e;
    return Number(m[1]);
  }
}

const all = (): string => [...out, ...err].join("\n");

describe("motebit relay bind-token — refusals write nothing", () => {
  it("no --sync-url, with MOTEBIT_SYNC_URL and a saved sync_url both naming a bindable relay", () => {
    process.env["MOTEBIT_SYNC_URL"] = A;
    fs.writeFileSync(CONFIG_JSON, JSON.stringify({ sync_url: A }), { mode: 0o600 });
    expect(bind("--sync-token", TOKEN)).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(err.join("\n")).toContain("needs the relay URL on the command line");
    expect(err.join("\n")).toContain("does not read MOTEBIT_SYNC_URL or the saved config");
  });

  it("--sync instead of --sync-url", () => {
    expect(bind("--sync", "--sync-token", TOKEN)).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(err.join("\n")).toContain("does not accept --sync");
  });

  it("an empty --sync-url", () => {
    expect(bind("--sync-url", "", "--sync-token", TOKEN)).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  for (const [what, url] of [
    ["userinfo", "https://user@relay-a.test"],
    ["a query", `${A}?x=1`],
    ["a fragment", `${A}#frag`],
    ["a space", "https://relay-a.test /x"],
    ["a backslash", "https:\\\\relay-a.test"],
    ["a scheme that is not http(s)", "ftp://relay-a.test"],
    ["no scheme", "relay-a.test"],
  ] as const) {
    it(`a relay URL with ${what}`, () => {
      expect(bind("--sync-url", url, "--sync-token", TOKEN)).toBe(1);
      expect(fs.existsSync(FILE)).toBe(false);
      expect(err.join("\n")).toContain("Nothing was written");
    });
  }

  it("no token anywhere", () => {
    expect(bind("--sync-url", A)).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(err.join("\n")).toContain("No operator token to bind");
  });

  it("an empty token from the flag, even with a variable set (the flag hides it)", () => {
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    expect(bind("--sync-url", A, "--sync-token", "")).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(err.join("\n")).toContain("is empty");
  });

  it("an empty token from a variable", () => {
    process.env["MOTEBIT_API_TOKEN"] = "";
    process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
    expect(bind("--sync-url", A)).toBe(1);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  for (const [what, bytes] of [
    ["not JSON", "{ not json"],
    ["another version", JSON.stringify({ version: 2, tokens: {} })],
    ["a non-string entry", JSON.stringify({ version: 1, tokens: { [B]: 1 } })],
  ] as const) {
    it(`a record that is ${what}: named, and not overwritten`, () => {
      fs.writeFileSync(FILE, bytes, { mode: 0o600 });
      expect(bind("--sync-url", A, "--sync-token", TOKEN)).toBe(1);
      expect(fs.readFileSync(FILE, "utf-8")).toBe(bytes);
      expect(err.join("\n")).toContain(FILE);
      expect(err.join("\n")).toContain("was not overwritten");
    });
  }

  it("a refusal never prints the token", () => {
    bind("--sync", "--sync-token", TOKEN);
    bind("--sync-url", "ftp://x", "--sync-token", TOKEN);
    expect(all()).not.toContain(TOKEN);
  });
});

describe("motebit relay bind-token — binding", () => {
  it("writes the hash only, owner-only, and says the source and six characters of the hash", () => {
    expect(bind("--sync-url", A, "--sync-token", TOKEN)).toBe(0);
    const raw = fs.readFileSync(FILE, "utf-8");
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw)).toEqual({ version: 1, tokens: { [A]: sha(TOKEN) } });
    expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
    const text = all();
    expect(text).toContain(`Bound the operator token to ${A}`);
    expect(text).toContain("from --sync-token");
    expect(text).toContain(`sha256 ${sha(TOKEN).slice(0, 6)}…`);
    expect(text).not.toContain(sha(TOKEN).slice(0, 7));
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("No request was made");
  });

  it("the bound token is then sent to that relay, and to no other", () => {
    expect(bind("--sync-url", `${A}/`, "--sync-token", TOKEN)).toBe(0);
    expect(operatorTokenFor(A, ["flag"], { syncToken: TOKEN })?.token).toBe(TOKEN);
    expect(operatorTokenFor(B, ["flag"], { syncToken: TOKEN })).toBeUndefined();
  });

  it("takes the flag, then MOTEBIT_API_TOKEN, then MOTEBIT_SYNC_TOKEN, and names the one used", () => {
    process.env["MOTEBIT_API_TOKEN"] = "from-api-variable";
    process.env["MOTEBIT_SYNC_TOKEN"] = "from-sync-variable";
    expect(bind("--sync-url", A, "--sync-token", TOKEN)).toBe(0);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8")).tokens[A]).toBe(sha(TOKEN));
    expect(all()).toContain("from --sync-token");

    out.length = 0;
    expect(bind("--sync-url", A)).toBe(0);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8")).tokens[A]).toBe(sha("from-api-variable"));
    expect(all()).toContain("from MOTEBIT_API_TOKEN");

    out.length = 0;
    delete process.env["MOTEBIT_API_TOKEN"];
    expect(bind("--sync-url", A)).toBe(0);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8")).tokens[A]).toBe(sha("from-sync-variable"));
    expect(all()).toContain("from MOTEBIT_SYNC_TOKEN");
  });

  it("replaces an existing entry (a rotated token) and says so", () => {
    expect(bind("--sync-url", A, "--sync-token", "the-old-token")).toBe(0);
    expect(all()).not.toContain("Replaced");
    out.length = 0;
    expect(bind("--sync-url", A, "--sync-token", TOKEN)).toBe(0);
    expect(all()).toContain(`Replaced the operator token bound to ${A}`);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8"))).toEqual({
      version: 1,
      tokens: { [A]: sha(TOKEN) },
    });
  });

  it("keeps the other relays' entries", () => {
    expect(bind("--sync-url", A, "--sync-token", "token-a")).toBe(0);
    expect(bind("--sync-url", B, "--sync-token", "token-b")).toBe(0);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8"))).toEqual({
      version: 1,
      tokens: { [A]: sha("token-a"), [B]: sha("token-b") },
    });
  });

  it("the same token already bound to another relay: says so, and still binds", () => {
    expect(bind("--sync-url", A, "--sync-token", TOKEN)).toBe(0);
    out.length = 0;
    expect(bind("--sync-url", B, "--sync-token", TOKEN)).toBe(0);
    expect(all()).toContain(`The same token is already bound to ${A}`);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8")).tokens[B]).toBe(sha(TOKEN));
  });

  it("no such warning for a different token", () => {
    expect(bind("--sync-url", A, "--sync-token", "token-a")).toBe(0);
    out.length = 0;
    expect(bind("--sync-url", B, "--sync-token", "token-b")).toBe(0);
    expect(all()).not.toContain("already bound");
  });

  it("the two variables set and different: says so, names the one bound, and what run and serve read", () => {
    process.env["MOTEBIT_API_TOKEN"] = "api-value";
    process.env["MOTEBIT_SYNC_TOKEN"] = "sync-value";
    expect(bind("--sync-url", A)).toBe(0);
    const text = all();
    expect(text).toContain("MOTEBIT_API_TOKEN and MOTEBIT_SYNC_TOKEN are both set and differ");
    expect(text).toContain("the one bound is MOTEBIT_API_TOKEN");
    expect(text).toContain("`motebit run` reads only MOTEBIT_SYNC_TOKEN");
    expect(text).toContain("`motebit serve` reads only MOTEBIT_API_TOKEN");
    expect(text).not.toContain("api-value");
    expect(text).not.toContain("sync-value");
  });

  it("no such warning when the two variables agree", () => {
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
    expect(bind("--sync-url", A)).toBe(0);
    expect(all()).not.toContain("both set and differ");
  });
});
