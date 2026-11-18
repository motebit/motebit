/**
 * `/connect` does not change relay in a running session, and never sends an
 * operator token.
 *
 * In a REPL session already on relay A, `/connect B` used to register this
 * device with B, print "Interactive delegation enabled" while the delegation
 * tool stayed on A, send B the operator token when one was set, overwrite the
 * saved relay with B, and print "Connected to B". Two rules replace that:
 *
 *   1. in a session whose runtime is already bound to a relay, `/connect`
 *      sends nothing to any relay and changes no state;
 *   2. `/connect` never sends an operator token: when one is set (by
 *      `--sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN`) it refuses
 *      before any request.
 *
 * The relays are real HTTP servers on 127.0.0.1 that log every request.
 * "Nothing sent" means a relay's log, recorded immediately before the command,
 * is identical immediately after it. A session with a relay at start is bound
 * through the real `startReplRelay`, as index.ts does it. Keys are ephemeral,
 * config lives in a temp `MOTEBIT_CONFIG_DIR`, and any request that is not to
 * 127.0.0.1 is refused.
 */
import { join } from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-connect-cfg-"));
  // Deleted, not emptied: an empty string counts as defined and shadows the next source.
  for (const k of [
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_RELAY_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_SYNC_TOKEN",
  ])
    delete process.env[k];
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  verifyDeviceRegistration,
  verifySignedToken,
} from "@motebit/encryption";
import type { MotebitRuntime } from "@motebit/runtime";
import { parseCliArgs } from "../args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "../config.js";
import { startReplRelay } from "../repl-relay.js";
import { createRuntime, InMemoryToolRegistry } from "../runtime-factory.js";
import { handleSlashCommand, type ReplContext } from "../slash-commands.js";
import { resolveRelayUrl } from "../subcommands/_helpers.js";
import { SessionRelays } from "../subcommands/grant.js";

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const OPERATOR_TOKEN = "operator-token-never-sent-by-connect";

interface Logged {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

interface FakeRelay {
  url: string;
  log: Logged[];
  /** The status the bootstrap route answers with (default 200). */
  bootstrapStatus: number;
  close: () => Promise<void>;
}

/** A relay on 127.0.0.1 that logs every request and answers bootstrap + discovery. */
async function fakeRelay(): Promise<FakeRelay> {
  const log: Logged[] = [];
  const relay: FakeRelay = { url: "", log, bootstrapStatus: 200, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      log.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("Content-Type", "application/json");
      if (path === "/api/v1/agents/bootstrap") {
        res.statusCode = relay.bootstrapStatus;
        res.end(JSON.stringify({ registered: relay.bootstrapStatus === 200 }));
      } else if (path === "/api/v1/agents/discover") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ agents: [{ motebit_id: "another-agent", capabilities: ["review"] }] }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return relay;
}

let keys: { motebitId: string; deviceId: string; publicKeyHex: string; privateKey: Uint8Array };
let publicKeyBytes: Uint8Array;
const relays: FakeRelay[] = [];
const cleanups: Array<() => void> = [];
let output: string[] = [];
/** Every URL any code in the test process asked `fetch` for. */
let fetched: string[] = [];

beforeAll(async () => {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const motebitId = await deriveSovereignMotebitId(publicKeyHex);
  publicKeyBytes = kp.publicKey;
  keys = { motebitId, deviceId: `${motebitId}-dev`, publicKeyHex, privateKey: kp.privateKey };
});

beforeEach(() => {
  rmSync(CONFIG_PATH, { recursive: true, force: true });
  output = [];
  fetched = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (!url.startsWith("http://127.0.0.1:")) {
      return Promise.reject(new TypeError(`network denied: ${url}`));
    }
    return realFetch(input, init);
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: unknown) {
        throw new Error(`network denied: ${String(url)}`);
      }
    },
  );
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await Promise.all(relays.splice(0).map((r) => r.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"])
    delete process.env[k];
  rmSync(CONFIG_PATH, { recursive: true, force: true });
});

async function relay(): Promise<FakeRelay> {
  const r = await fakeRelay();
  relays.push(r);
  return r;
}

interface Session {
  runtime: MotebitRuntime;
  /** The startup config object the REPL keeps and hands to every slash command. */
  startupConfig: ReturnType<typeof loadFullConfig>;
  sessionRelay: SessionRelays;
  /** The REPL context every slash command gets; a test may close the key on it. */
  repl: ReplContext;
  connect: (url: string) => Promise<void>;
  enableCalls: () => number;
  listingCalls: () => number;
}

/**
 * A REPL session, started as apps/cli/src/index.ts starts one: the relay is
 * resolved from the flag, the environment or the saved config, added to the
 * session's relay set, and wired through the real `startReplRelay`.
 */
async function startSession(
  sources: { flag?: string; env?: string; cfg?: string; argv?: string[] } = {},
): Promise<Session> {
  saveFullConfig({
    ...loadFullConfig(),
    device_public_key: keys.publicKeyHex,
    ...(sources.cfg != null ? { sync_url: sources.cfg } : {}),
  });
  if (sources.env != null) process.env["MOTEBIT_SYNC_URL"] = sources.env;
  const config = {
    ...parseCliArgs([
      "--provider",
      "local-server",
      ...(sources.flag != null ? ["--sync-url", sources.flag] : []),
      ...(sources.argv ?? []),
    ]),
    dbPath: join(mkdtempSync(join(tmpdir(), "motebit-connect-db-")), "motebit.db"),
  };
  const { runtime, moteDb } = await createRuntime(
    config,
    keys.motebitId,
    new InMemoryToolRegistry(),
    [],
  );
  const startupConfig = loadFullConfig();
  const syncUrl = resolveRelayUrl(config, startupConfig);
  const sessionRelay = new SessionRelays();
  sessionRelay.add(syncUrl);
  const push = await startReplRelay({
    runtime,
    config,
    syncUrl,
    motebitId: keys.motebitId,
    eventStore: moteDb.eventStore,
    privateKeyBytes: keys.privateKey,
    deviceId: keys.deviceId,
    devicePublicKey: keys.publicKeyHex,
    relayPublicKey: undefined,
    log: () => {},
    warn: () => {},
    pushIntervalMs: 3_600_000,
  });
  push?.stop();
  cleanups.push(() => {
    runtime.stop();
    moteDb.close();
  });
  // Counted from here on: what startup did is not what the command does.
  const enable = vi.spyOn(runtime, "enableInteractiveDelegation");
  const listing = vi.spyOn(runtime, "registerServiceListing");
  const repl: ReplContext = {
    moteDb,
    motebitId: keys.motebitId,
    mcpAdapters: [],
    privateKeyBytes: keys.privateKey,
    deviceId: keys.deviceId,
    sessionRelay,
  };
  return {
    runtime,
    startupConfig,
    sessionRelay,
    repl,
    connect: (url) => handleSlashCommand("connect", url, runtime, config, startupConfig, repl),
    enableCalls: () => enable.mock.calls.length,
    listingCalls: () => listing.mock.calls.length,
  };
}

/** Everything `/connect` could change, read now. */
function observe(s: Session, watched: FakeRelay[]): string {
  return JSON.stringify({
    logs: watched.map((r) => r.log),
    fetched,
    configFile: !existsSync(CONFIG_PATH)
      ? null
      : statSync(CONFIG_PATH).isFile()
        ? readFileSync(CONFIG_PATH).toString("base64")
        : "not a file",
    inMemorySyncUrl: s.startupConfig.sync_url ?? null,
    grantRelaySet: s.sessionRelay.urls,
    runtimeRelay: s.runtime.getDelegationRelay(),
    enableCalls: s.enableCalls(),
    listingCalls: s.listingCalls(),
  });
}

/** Run `/connect url`; return what it printed and whether anything observable changed. */
async function runConnect(
  s: Session,
  url: string,
  watched: FakeRelay[],
): Promise<{ printed: string[]; unchanged: boolean }> {
  const before = observe(s, watched);
  output = [];
  await s.connect(url);
  const printed = [...output];
  return { printed, unchanged: observe(s, watched) === before };
}

const R1 = (from: string, to: string): string[] => [
  `This session is on ${from}. /connect cannot change relay while the session is running; nothing was sent to ${to}.`,
  "Another relay is not yet safe for paid delegation or with an operator token: this install's relay key pin and credentials are not kept per relay.",
  "A session keeps the relay it started with or first connected to.",
];
const R2 = (source: string, to: string): string[] => [
  `An operator token is set for this session (${source}). /connect does not send an operator token to a relay named inside a session; nothing was sent to ${to}.`,
  "/connect is available in a session started with no relay and no operator token.",
];
const ALREADY = (on: string): string[] => [
  `This session is already on ${on}. Nothing was sent and nothing changed.`,
];
const NO_KEYS = ["Error: no signing keys available — cannot authenticate with relay."];

// URL suffixes carrying what `sanitizeRelayText` removes, and what is left:
// a CSI escape sequence (it would recolour the terminal), a zero-width space.
const UNPRINTABLE = ["/\x1b[31mred", "/re\u200bd"];
const PRINTED_AS = "/red";

/** Row 3, asserted: `/connect B` on a session bound to A sends nothing, changes nothing, prints R1. */
async function expectRefusedSwitch(s: Session, a: FakeRelay, b: FakeRelay): Promise<void> {
  expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
  expect(a.log.length).toBeGreaterThan(0);
  const { printed, unchanged } = await runConnect(s, b.url, [a, b]);
  expect(b.log).toEqual([]);
  expect(unchanged).toBe(true);
  expect(s.sessionRelay.urls).toEqual([a.url]);
  expect(printed).toEqual(R1(a.url, b.url));
}

describe("/connect in a session already on a relay: nothing sent, nothing changed", () => {
  it("bound to A from the saved config, /connect B: refused with R1", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession({ cfg: a.url });
    await expectRefusedSwitch(s, a, b);
    expect(loadFullConfig().sync_url).toBe(a.url);
    expect(s.startupConfig.sync_url).toBe(a.url);
  });

  it("bound to A from --sync-url, /connect B: refused with R1", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession({ flag: a.url });
    await expectRefusedSwitch(s, a, b);
    expect(loadFullConfig().sync_url).toBeUndefined();
    expect(s.startupConfig.sync_url).toBeUndefined();
  });

  it("bound to A from MOTEBIT_SYNC_URL, /connect B: refused with R1", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession({ env: a.url });
    await expectRefusedSwitch(s, a, b);
    expect(loadFullConfig().sync_url).toBeUndefined();
    expect(s.startupConfig.sync_url).toBeUndefined();
  });

  it("bound to A, /connect A and /connect A/: the already-on-A line, nothing sent to A, nothing changed", async () => {
    const a = await relay();
    const s = await startSession({ flag: a.url });
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
    for (const spelled of [a.url, `${a.url}/`]) {
      const { printed, unchanged } = await runConnect(s, spelled, [a]);
      expect(unchanged).toBe(true);
      expect(printed).toEqual(ALREADY(a.url));
    }
    // Started with --sync-url: /connect A used to write A into the saved config.
    expect(loadFullConfig().sync_url).toBeUndefined();
  });

  it("bound to A with an operator token set, /connect B: R1, not R2 (the session's relay is checked first)", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession({ flag: a.url, argv: ["--sync-token", OPERATOR_TOKEN] });
    await expectRefusedSwitch(s, a, b);
  });

  it("bound to A with an operator token set and no open identity key, /connect B: the no-signing-keys error, not R1 or R2", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession({ flag: a.url, argv: ["--sync-token", OPERATOR_TOKEN] });
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
    delete s.repl.privateKeyBytes;
    const { printed, unchanged } = await runConnect(s, b.url, [a, b]);
    expect(b.log).toEqual([]);
    expect(unchanged).toBe(true);
    expect(printed).toEqual(NO_KEYS);
  });

  it("bound to A, /connect with A's scheme in upper case: a different spelling is a different relay, refused with R1, nothing sent", async () => {
    const a = await relay();
    const s = await startSession({ flag: a.url });
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
    const spelled = a.url.replace(/^http:/, "HTTP:");
    expect(spelled).not.toBe(a.url);
    const { printed, unchanged } = await runConnect(s, spelled, [a]);
    expect(unchanged).toBe(true);
    expect(printed).toEqual(R1(a.url, spelled));
  });

  it("bound to A, /connect A/x: an extra path segment is a different relay, refused with R1, nothing sent", async () => {
    const a = await relay();
    const s = await startSession({ flag: a.url });
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
    const { printed, unchanged } = await runConnect(s, `${a.url}/x`, [a]);
    expect(unchanged).toBe(true);
    expect(printed).toEqual(R1(a.url, `${a.url}/x`));
  });

  it("the already-on line prints the session's relay without an escape sequence or a zero-width character", async () => {
    for (const suffix of UNPRINTABLE) {
      const a = await relay();
      const s = await startSession({ flag: `${a.url}${suffix}` });
      expect(s.runtime.getDelegationRelay()).toEqual({ url: `${a.url}${suffix}` });
      const { printed, unchanged } = await runConnect(s, `${a.url}${suffix}`, [a]);
      expect(unchanged).toBe(true);
      expect(printed).toEqual(ALREADY(`${a.url}${PRINTED_AS}`));
    }
  });

  it("R1 prints the session's relay and the named relay without an escape sequence or a zero-width character", async () => {
    for (const suffix of UNPRINTABLE) {
      const [a, b] = [await relay(), await relay()];
      const s = await startSession({ flag: `${a.url}${suffix}` });
      expect(s.runtime.getDelegationRelay()).toEqual({ url: `${a.url}${suffix}` });
      const { printed, unchanged } = await runConnect(s, `${b.url}${suffix}`, [a, b]);
      expect(b.log).toEqual([]);
      expect(unchanged).toBe(true);
      expect(printed).toEqual(R1(`${a.url}${PRINTED_AS}`, `${b.url}${PRINTED_AS}`));
    }
  });
});

describe("/connect never sends an operator token", () => {
  /** Row 4, asserted: no relay at start, a token set: nothing sent, nothing changed, R2. */
  async function expectRefusedForToken(s: Session, x: FakeRelay, source: string): Promise<void> {
    expect(s.runtime.getDelegationRelay()).toBeNull();
    const { printed, unchanged } = await runConnect(s, x.url, [x]);
    expect(x.log).toEqual([]);
    expect(fetched).toEqual([]);
    expect(unchanged).toBe(true);
    expect(s.runtime.getDelegationRelay()).toBeNull();
    expect(s.sessionRelay.urls).toEqual([]);
    expect(printed).toEqual(R2(source, x.url));
  }

  it("no relay, operator token from --sync-token: /connect X sends nothing and prints R2", async () => {
    const x = await relay();
    const s = await startSession({ argv: ["--sync-token", OPERATOR_TOKEN] });
    await expectRefusedForToken(s, x, "--sync-token");
  });

  it("no relay, operator token from MOTEBIT_API_TOKEN: /connect X sends nothing and prints R2", async () => {
    const x = await relay();
    process.env["MOTEBIT_API_TOKEN"] = OPERATOR_TOKEN;
    const s = await startSession();
    await expectRefusedForToken(s, x, "MOTEBIT_API_TOKEN");
  });

  it("no relay, operator token from MOTEBIT_SYNC_TOKEN (MOTEBIT_API_TOKEN unset): /connect X sends nothing and prints R2", async () => {
    const x = await relay();
    expect("MOTEBIT_API_TOKEN" in process.env).toBe(false);
    process.env["MOTEBIT_SYNC_TOKEN"] = OPERATOR_TOKEN;
    const s = await startSession();
    await expectRefusedForToken(s, x, "MOTEBIT_SYNC_TOKEN");
  });

  it("R2 prints the named relay without an escape sequence or a zero-width character", async () => {
    for (const suffix of UNPRINTABLE) {
      const x = await relay();
      const s = await startSession({ argv: ["--sync-token", OPERATOR_TOKEN] });
      const { printed, unchanged } = await runConnect(s, `${x.url}${suffix}`, [x]);
      expect(x.log).toEqual([]);
      expect(unchanged).toBe(true);
      expect(printed).toEqual(R2("--sync-token", `${x.url}${PRINTED_AS}`));
    }
  });

  /** Row 5 with a shadowed token: the connect runs, and no request carries the shadowed value. */
  async function expectConnectsWithoutToken(s: Session, x: FakeRelay): Promise<void> {
    const { printed } = await runConnect(s, x.url, [x]);
    expect(printed.join("\n")).toContain(`Connected to ${x.url}`);
    expect(s.runtime.getDelegationRelay()).toEqual({ url: x.url });
    expect(x.log.map((r) => r.path)).toEqual([
      "/api/v1/agents/bootstrap",
      "/api/v1/agents/discover",
    ]);
    for (const r of x.log) {
      expect(r.authorization ?? "").not.toContain(OPERATOR_TOKEN);
      expect(r.body).not.toContain(OPERATOR_TOKEN);
    }
    expect(await deviceSigned(x.log[1]!)).toBe(true);
  }

  it('--sync-token "" with MOTEBIT_API_TOKEN set, no relay: /connect X proceeds and no request carries the variable\'s value', async () => {
    const x = await relay();
    process.env["MOTEBIT_API_TOKEN"] = OPERATOR_TOKEN;
    const s = await startSession({ argv: ["--sync-token", ""] });
    await expectConnectsWithoutToken(s, x);
  });

  it('MOTEBIT_API_TOKEN="" with MOTEBIT_SYNC_TOKEN set, no relay: /connect X proceeds and no request carries the variable\'s value', async () => {
    const x = await relay();
    process.env["MOTEBIT_API_TOKEN"] = "";
    process.env["MOTEBIT_SYNC_TOKEN"] = OPERATOR_TOKEN;
    const s = await startSession();
    await expectConnectsWithoutToken(s, x);
  });
});

/** Does this request's bearer verify as a token signed by this device's key? */
async function deviceSigned(r: Logged): Promise<boolean> {
  const bearer = /^Bearer (.+)$/.exec(r.authorization ?? "")?.[1];
  if (bearer == null) return false;
  const payload = await verifySignedToken(bearer, publicKeyBytes);
  return payload != null && payload.mid === keys.motebitId && payload.did === keys.deviceId;
}

describe("/connect in a session with no relay and no operator token", () => {
  it("/connect / : usage is printed, nothing is sent, and no 'undefined' appears", async () => {
    const s = await startSession();
    const { printed, unchanged } = await runConnect(s, "/", []);
    expect(unchanged).toBe(true);
    expect(fetched).toEqual([]);
    expect(printed).toEqual([
      "Usage: /connect <relay-url>",
      "  Example: /connect https://relay.motebit.com",
    ]);
    expect(printed.join("\n")).not.toContain("undefined");
  });

  /** Half an identity (the key or the device id missing): nothing sent, nothing changed, the error. */
  async function expectRefusedForIdentity(s: Session, x: FakeRelay): Promise<void> {
    expect(s.runtime.getDelegationRelay()).toBeNull();
    const { printed, unchanged } = await runConnect(s, x.url, [x]);
    expect(x.log).toEqual([]);
    expect(fetched).toEqual([]);
    expect(unchanged).toBe(true);
    expect(s.runtime.getDelegationRelay()).toBeNull();
    expect(s.sessionRelay.urls).toEqual([]);
    expect(loadFullConfig().sync_url).toBeUndefined();
    expect(s.startupConfig.sync_url).toBeUndefined();
    expect(s.enableCalls()).toBe(0);
    expect(printed).toEqual(NO_KEYS);
  }

  it("a signing key and no device id: /connect X sends nothing, changes nothing, and prints the no-signing-keys error", async () => {
    const x = await relay();
    const s = await startSession();
    delete s.repl.deviceId;
    expect(s.repl.privateKeyBytes).toBeInstanceOf(Uint8Array);
    await expectRefusedForIdentity(s, x);
  });

  it("a device id and no signing key: /connect X sends nothing, changes nothing, and prints the no-signing-keys error", async () => {
    const x = await relay();
    const s = await startSession();
    delete s.repl.privateKeyBytes;
    expect(s.repl.deviceId).toBe(keys.deviceId);
    await expectRefusedForIdentity(s, x);
  });

  it("/connect A succeeds on a 409 bootstrap with device-signed requests only; then /connect B is refused with R1", async () => {
    const [a, b] = [await relay(), await relay()];
    a.bootstrapStatus = 409;
    const s = await startSession();
    expect(s.runtime.getDelegationRelay()).toBeNull();

    const first = await runConnect(s, a.url, [a]);
    expect(first.printed.join("\n")).toContain(`Connected to ${a.url}`);
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });
    expect(s.sessionRelay.urls).toEqual([a.url]);
    expect(loadFullConfig().sync_url).toBe(a.url);
    expect(s.listingCalls()).toBe(1);

    // Every request to A: a signed body (bootstrap) or a device-signed token.
    expect(a.log.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/agents/bootstrap",
      "GET /api/v1/agents/discover",
    ]);
    const [bootstrap, discover] = a.log;
    expect(bootstrap!.authorization).toBeNull();
    expect(
      await verifyDeviceRegistration(
        JSON.parse(bootstrap!.body) as Parameters<typeof verifyDeviceRegistration>[0],
      ),
    ).toEqual({ valid: true });
    expect(await deviceSigned(discover!)).toBe(true);

    const second = await runConnect(s, b.url, [a, b]);
    expect(b.log).toEqual([]);
    expect(second.unchanged).toBe(true);
    expect(second.printed).toEqual(R1(a.url, b.url));
  });

  it("/connect A fails at bootstrap: the session is still on no relay, and /connect B is allowed", async () => {
    const [a, b] = [await relay(), await relay()];
    a.bootstrapStatus = 500;
    const s = await startSession();

    const first = await runConnect(s, a.url, [a]);
    expect(first.printed.join("\n")).toContain("Registration failed: 500");
    expect(a.log.map((r) => r.path)).toEqual(["/api/v1/agents/bootstrap"]);
    expect(s.runtime.getDelegationRelay()).toBeNull();
    expect(s.sessionRelay.urls).toEqual([]);

    const second = await runConnect(s, b.url, [b]);
    expect(second.printed.join("\n")).toContain(`Connected to ${b.url}`);
    expect(s.runtime.getDelegationRelay()).toEqual({ url: b.url });
    expect(loadFullConfig().sync_url).toBe(b.url);
  });

  it("/connect A binds the runtime and then the config save throws: /connect B is still refused", async () => {
    const [a, b] = [await relay(), await relay()];
    const s = await startSession();
    // The saved config becomes a directory: the save at the end of /connect throws.
    rmSync(CONFIG_PATH, { force: true });
    mkdirSync(CONFIG_PATH);

    await expect(s.connect(a.url)).rejects.toThrow();
    expect(a.log.map((r) => r.path)).toEqual([
      "/api/v1/agents/bootstrap",
      "/api/v1/agents/discover",
    ]);
    expect(s.runtime.getDelegationRelay()).toEqual({ url: a.url });

    const second = await runConnect(s, b.url, [a, b]);
    expect(b.log).toEqual([]);
    expect(second.unchanged).toBe(true);
    expect(second.printed).toEqual(R1(a.url, b.url));
  });
});
