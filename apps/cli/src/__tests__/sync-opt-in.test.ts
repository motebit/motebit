/**
 * Relay sync is OPT-IN (`sync-opt-in.ts`) — a network-deny harness.
 *
 * `fetch` and `WebSocket` are stubbed to record and THROW. With no relay
 * named (no `--sync-url` / `--sync`, no `MOTEBIT_SYNC_URL`, no `sync_url` in
 * config.json), the first run (identity bootstrap), the REPL's runtime +
 * relay wiring + a turn, and a daemon's start make ZERO relay calls. Each
 * opt-in path (flag, `--sync`, env, `motebit sync enable`) does reach the
 * relay it names. Relay-only commands refuse with the one-line opt-in.
 */
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-optin-cfg-"));
  for (const k of [
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_RELAY_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_SYNC_TOKEN",
  ])
    delete process.env[k];
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import { syncFloorReport } from "@motebit/sync-engine";
import { parseCliArgs } from "../args.js";
import { bootstrapReplIdentity } from "../cli-event-push.js";
import { loadFullConfig, saveFullConfig, type FullConfig } from "../config.js";
import { startReplRelay } from "../repl-relay.js";
import {
  buildStorageAdapters,
  createRuntime,
  InMemoryToolRegistry,
  openMotebitDatabase,
} from "../runtime-factory.js";
import { handleSlashCommand } from "../slash-commands.js";
import { cliRuntimeConfig, daemonRelay } from "../sync-configured.js";
import { PUBLIC_RELAY_URL, SYNC_OFF_MESSAGE, namedRelayUrl } from "../sync-opt-in.js";
import { getRelayUrl, resolveRelayUrl } from "../subcommands/_helpers.js";
import { syncCheck } from "../subcommands/doctor.js";
import { handleRegister } from "../subcommands/register.js";
import { syncDisable, syncEnable } from "../subcommands/sync.js";

const PASS = "pass-optin";

/** Every network attempt, by URL. The stubs throw: nothing leaves the process. */
let calls: string[] = [];

function denyNetwork(): void {
  calls = [];
  vi.stubGlobal("fetch", (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request).url);
    calls.push(url);
    return Promise.reject(new Error(`network denied: ${url}`));
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: unknown) {
        calls.push(String(url));
        throw new Error(`network denied: ${String(url)}`);
      }
    },
  );
}

/** A relay call: anything but the local inference server the REPL turn talks to. */
const relayCalls = (): string[] =>
  calls.filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(u));

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "motebit-optin-"));
}

function clearConfig(): void {
  const c = loadFullConfig();
  delete c.sync_url;
  saveFullConfig(c);
}

beforeEach(() => {
  denyNetwork();
  delete process.env["MOTEBIT_SYNC_URL"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["MOTEBIT_SYNC_URL"];
});

describe("relay sync off (nothing named) — zero relay calls", () => {
  it("resolves no relay: no default is ever picked", () => {
    clearConfig();
    const config = parseCliArgs(["--provider", "local-server"]);
    expect(config.syncUrl).toBeUndefined();
    expect(resolveRelayUrl(config)).toBeUndefined();
    expect(namedRelayUrl(config, {})).toBeUndefined();
  });

  it("first run: the identity is minted, no relay call, no sync intent recorded", async () => {
    clearConfig();
    const dir = freshDir();
    const dbPath = join(dir, "motebit.db");
    const full = {} as FullConfig;
    const { motebitId } = await bootstrapReplIdentity({
      dbPath,
      fullConfig: full,
      passphrase: PASS,
      syncConfigured: resolveRelayUrl(parseCliArgs([]), full) != null,
    });
    expect(motebitId).toBeTruthy();
    const db = await openMotebitDatabase(dbPath);
    try {
      const report = await syncFloorReport(db.eventStore, motebitId);
      expect(report.intent).toBe("never");
    } finally {
      db.close();
    }
    expect(calls).toEqual([]);
  });

  it("REPL: runtime + relay wiring + a turn + /sync make no relay call", async () => {
    clearConfig();
    const dir = freshDir();
    const config = {
      ...parseCliArgs(["--provider", "local-server"]),
      dbPath: join(dir, "motebit.db"),
    };
    const mid = "11111111-1111-4111-8111-111111111111";
    const { runtime, moteDb } = await createRuntime(config, mid, new InMemoryToolRegistry(), []);
    try {
      await runtime.init();
      const push = await startReplRelay({
        runtime,
        config,
        syncUrl: resolveRelayUrl(config),
        motebitId: mid,
        eventStore: moteDb.eventStore,
        privateKeyBytes: undefined,
        deviceId: undefined,
        devicePublicKey: undefined,
        relayPublicKey: undefined,
        log: () => {},
        warn: () => {},
      });
      expect(push).toBeUndefined();
      // A turn: the only network it may attempt is the local inference server.
      await runtime.sendMessage("hello").catch(() => undefined);
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        out.push(a.map(String).join(" "));
      });
      await handleSlashCommand("sync", "", runtime, config);
      expect(out.join("\n")).toMatch(/Relay sync is off/);
      expect(relayCalls()).toEqual([]);
    } finally {
      runtime.stop();
      moteDb.close();
    }
  });

  it("daemon start (`motebit run`'s relay wiring) makes no relay call", async () => {
    clearConfig();
    const dir = freshDir();
    const db = await openMotebitDatabase(join(dir, "motebit.db"));
    const relay = daemonRelay(parseCliArgs([]), loadFullConfig(), "run");
    expect(relay.syncUrl).toBeUndefined();
    const cfg = cliRuntimeConfig({ motebitId: "22222222-2222-4222-8222-222222222222" }, relay);
    expect(cfg.syncConfigured).toBe(false);
    const runtime = new MotebitRuntime(cfg, {
      storage: buildStorageAdapters(db),
      renderer: new NullRenderer(),
    });
    try {
      await runtime.init();
      runtime.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual([]);
    } finally {
      runtime.stop();
      db.close();
    }
  });
});

describe("opt-in paths name the relay — and reach it", () => {
  it("--sync-url names that relay", () => {
    clearConfig();
    expect(resolveRelayUrl(parseCliArgs(["--sync-url", "https://relay.example/"]))).toBe(
      "https://relay.example",
    );
  });

  it("--sync names the public relay; --sync-url wins over it", () => {
    clearConfig();
    expect(resolveRelayUrl(parseCliArgs(["--sync"]))).toBe(PUBLIC_RELAY_URL);
    expect(resolveRelayUrl(parseCliArgs(["--sync", "--sync-url", "https://r.example"]))).toBe(
      "https://r.example",
    );
  });

  it("MOTEBIT_SYNC_URL names that relay", () => {
    clearConfig();
    process.env["MOTEBIT_SYNC_URL"] = "https://env.example";
    expect(resolveRelayUrl(parseCliArgs([]))).toBe("https://env.example");
  });

  it("`motebit sync enable [url]` persists it; `disable` removes it (existing configs keep working)", () => {
    clearConfig();
    const lines: string[] = [];
    const ctx = {
      load: loadFullConfig,
      save: (c: FullConfig) => void saveFullConfig(c),
      print: (l: string) => lines.push(l),
    };
    expect(syncEnable(undefined, ctx)).toBe(0);
    expect(loadFullConfig().sync_url).toBe(PUBLIC_RELAY_URL);
    expect(resolveRelayUrl(parseCliArgs([]))).toBe(PUBLIC_RELAY_URL);
    expect(syncEnable("https://mine.example/", ctx)).toBe(0);
    expect(loadFullConfig().sync_url).toBe("https://mine.example");
    expect(syncEnable("ftp://nope", ctx)).toBe(2);
    expect(syncDisable(ctx)).toBe(0);
    expect(loadFullConfig().sync_url).toBeUndefined();
    expect(resolveRelayUrl(parseCliArgs([]))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("REPL with a relay named: the runtime and relay wiring reach that relay", async () => {
    clearConfig();
    const dir = freshDir();
    const config = {
      ...parseCliArgs(["--provider", "local-server", "--sync-url", "https://optin.example"]),
      dbPath: join(dir, "motebit.db"),
    };
    const mid = "33333333-3333-4333-8333-333333333333";
    const { runtime, moteDb } = await createRuntime(config, mid, new InMemoryToolRegistry(), []);
    try {
      const push = await startReplRelay({
        runtime,
        config,
        syncUrl: resolveRelayUrl(config),
        motebitId: mid,
        eventStore: moteDb.eventStore,
        privateKeyBytes: undefined,
        deviceId: undefined,
        devicePublicKey: undefined,
        relayPublicKey: undefined,
        log: () => {},
        warn: () => {},
        pushIntervalMs: 60_000,
      });
      expect(push).toBeDefined();
      push?.stop();
      expect(relayCalls().length).toBeGreaterThan(0);
      expect(relayCalls().every((u) => u.startsWith("https://optin.example/"))).toBe(true);
    } finally {
      runtime.stop();
      moteDb.close();
    }
  });

  it("daemon with a relay in config.json: `motebit run` wiring names it", () => {
    const c = loadFullConfig();
    c.sync_url = "https://cfg.example";
    saveFullConfig(c);
    const relay = daemonRelay(parseCliArgs([]), loadFullConfig(), "run");
    expect(relay.syncUrl).toBe("https://cfg.example");
    expect(cliRuntimeConfig({ motebitId: "x" }, relay).syncConfigured).toBe(true);
    clearConfig();
  });
});

describe("relay-only commands refuse with the one-line opt-in", () => {
  function captureExit(): { errors: string[] } {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);
    return { errors };
  }

  it("getRelayUrl (delegate, market, discover, smoke-x402, rotate, machines, …)", () => {
    clearConfig();
    const { errors } = captureExit();
    expect(() => getRelayUrl(parseCliArgs([]))).toThrow("process.exit(1)");
    expect(errors).toEqual([SYNC_OFF_MESSAGE]);
    expect(SYNC_OFF_MESSAGE).toMatch(/--sync-url/);
    expect(calls).toEqual([]);
  });

  it("register never picks the public relay silently", async () => {
    clearConfig();
    const { errors } = captureExit();
    await expect(handleRegister(parseCliArgs(["register"]))).rejects.toThrow("process.exit(1)");
    expect(errors).toEqual([SYNC_OFF_MESSAGE]);
    expect(calls).toEqual([]);
  });

  it("doctor: sync off is INFO, never FAIL", () => {
    expect(syncCheck(undefined)).toMatchObject({
      ok: true,
      info: true,
      detail: "off (opt in with --sync-url)",
    });
    expect(syncCheck("https://r.example")).toMatchObject({ ok: true, detail: "https://r.example" });
  });
});
