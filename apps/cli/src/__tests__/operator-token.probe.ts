/**
 * Operator token per relay — the fixtures, the send-site matrix, and the
 * differential probe, in ONE self-contained file.
 *
 * Why one file: `scripts/differential-vs-main.ts` copies a single probe file
 * into the base tree, so everything the probe needs must live in it and use
 * only surfaces that exist on `origin/main` too (the CLI as a subprocess, its
 * config directory, its environment). The tests of this change
 * (`operator-token-*.test.ts`) import the same fixtures and the same matrix
 * from here, so the branch's assertions and the main-vs-branch observations
 * are made by the same code.
 *
 *   node_modules/.bin/tsx scripts/differential-vs-main.ts \
 *     --probe apps/cli/src/__tests__/operator-token.probe.ts
 *
 * The world of every row: two fake relays on 127.0.0.1, A and B. They record
 * every `Authorization` header and the first frame of every WebSocket. An
 * ephemeral identity lives in a temp config directory (never `~/.motebit`).
 * The CLI runs FROM SOURCE as a subprocess with an environment built from
 * nothing.
 *
 *   leak     A's token is bound to A, and A is the value of every relay-URL
 *            source of LOWER precedence than the one naming B; B is supplied
 *            by one route (flag, variable, saved config). On main B receives
 *            A's token. On the branch it never does, and the site falls back
 *            as it does with no operator token set.
 *   control  B's token is bound to B and B is the relay: B receives it.
 *   source   one of the three token sources set alone, bound to the
 *            command's own relay: the site sends it exactly when it honours
 *            that source on main.
 *
 * The record file is written directly (`writeTokenRecord`): `bind-token` does
 * not exist on main, and main ignores the file.
 *
 * No network: 127.0.0.1 only. No money: the fake relay answers every route
 * with an empty success. Vitest collects `*.test.ts` only, so this file runs
 * as a suite only when the differential drops it in as one (`PROBE_OUT` set).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  signFederationMessage,
} from "@motebit/encryption";
import { generate as generateIdentityFile } from "@motebit/identity-file";

// CONFIG_DIR is read when `../identity.js` loads (below, lazily). As the
// differential probe nothing has set it yet; a test file that imports this
// module sets its own first.
process.env["MOTEBIT_CONFIG_DIR"] ??= fs.mkdtempSync(path.join(os.tmpdir(), "mb-ot-host-"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `apps/cli`. */
export const CLI_ROOT = path.resolve(HERE, "..", "..");
const CLI_ENTRY = path.join(CLI_ROOT, "src", "index.ts");
const require_ = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require_.resolve("tsx")).href;

// `ws` ships no type declarations in this package; these are the few members
// the fake relay uses.
interface WebSocket {
  send(data: string): void;
  terminate(): void;
  on(event: "close", cb: () => void): void;
  on(event: "message", cb: (data: Buffer | string) => void): void;
}
interface WebSocketServerLike {
  on(event: "connection", cb: (socket: WebSocket) => void): void;
  close(cb: () => void): void;
}
const { WebSocketServer } = require_("ws") as {
  WebSocketServer: new (opts: { server: http.Server }) => WebSocketServerLike;
};

export const PASSPHRASE = "operator-token-test-passphrase";
/** Relay A's operator token, and relay B's. Opaque strings, as a relay's are. */
export const TOKEN_A = `opA-${"a1".repeat(24)}`;
export const TOKEN_B = `opB-${"b2".repeat(24)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── The fake relay ──────────────────────────────────────────────────────────

/** One request the fake relay received. */
export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeRelay {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** The first frame of every WebSocket connection, as received. */
  firstFrames: string[];
  /** Every place `token` was seen: `METHOD path` (ids masked) or `ws first frame`. */
  sightings(token: string, fromIndex?: number, toIndex?: number): string[];
  /** Send a task to every connected socket (granted when claimed). */
  dispatchTask(motebitId: string): string;
  waitForRequest(
    pred: (r: RecordedRequest) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedRequest | undefined>;
  waitForFirstFrame(timeoutMs?: number): Promise<string | undefined>;
  /** Resolves true once a WebSocket has connected (whether or not it sends a frame). */
  waitForSocket(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface FakeRelayOptions {
  /** Per-request response override: return undefined for the default. */
  respond?: (
    req: RecordedRequest,
  ) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A path with ids, ports and query values replaced, so two runs compare. */
export function maskPath(p: string): string {
  return p
    .replace(UUID, ":id")
    .replace(/127\.0\.0\.1%3A\d+/g, "127.0.0.1%3A:port")
    .replace(/(after_seq|after_clock|since)=\d+/g, "$1=:n");
}

/**
 * A relay that accepts everything and records what it was sent. It answers
 * the federation handshake for real (its own key signs the `peer-challenge`),
 * so `federation peer` and `federation mesh` reach the operator-confirm call
 * that carries the operator token.
 */
export async function startFakeRelay(opts: FakeRelayOptions = {}): Promise<FakeRelay> {
  const requests: RecordedRequest[] = [];
  const firstFrames: string[] = [];
  const sockets = new Set<WebSocket>();
  const waiters: Array<() => void> = [];
  const notify = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const relayKey = await generateKeypair();
  const relayPublicKey = bytesToHex(relayKey.publicKey);
  const relayId = await deriveSovereignMotebitId(relayPublicKey);

  const answer = async (rec: RecordedRequest, body: string): Promise<unknown> => {
    const p = rec.path.split("?")[0] ?? rec.path;
    if (p === "/federation/v1/identity") {
      return {
        relay_motebit_id: relayId,
        public_key: relayPublicKey,
        did: `did:motebit:${relayId}`,
        spec: "relay-federation@1.5",
      };
    }
    if (p === "/federation/v1/peer/propose") {
      const proposal = JSON.parse(body) as {
        relay_id: string;
        public_key: string;
        endpoint_url: string;
        nonce: string;
      };
      const nonce = bytesToHex((await generateKeypair()).publicKey);
      const challenge = await signFederationMessage({
        kind: "peer-challenge",
        sender: relayId,
        recipient: proposal.relay_id,
        recipientPublicKey: proposal.public_key,
        body: {
          request_nonce: proposal.nonce,
          nonce,
          proposer_endpoint_url: proposal.endpoint_url,
        },
        privateKey: relayKey.privateKey,
      });
      return { nonce, challenge };
    }
    if (p === "/api/v1/admin/federation/peer-confirm-signature") {
      const ask = JSON.parse(body) as { nonce: string; endpoint_url: string };
      return {
        message: {},
        nonce: ask.nonce,
        public_key: relayPublicKey,
        endpoint_url: ask.endpoint_url,
      };
    }
    if (p === "/api/v1/admin/federation/peer-removal-signature") {
      return { relay_id: relayId, message: {} };
    }
    if (p.endsWith("/agents/discover")) return { agents: [] };
    if (p.endsWith("/credentials")) return { credentials: [] };
    if (p.endsWith("/balance")) return { balance: 0, currency: "USD", transactions: [] };
    if (p === "/federation/v1/peers") return { peers: [] };
    if (p === "/api/v1/proposals") return { proposals: [], proposal_id: "p1", status: "pending" };
    if (p.startsWith("/api/v1/proposals/")) {
      return { proposal_id: "p1", status: "pending", participants: [], steps: [] };
    }
    if (p.includes("/sync/")) return { events: [], accepted: 0, server_clock: 0 };
    return {};
  };

  const server = http.createServer((req, res) => {
    const rec: RecordedRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      authorization: req.headers["authorization"],
    };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push(rec);
      notify();
      const custom = opts.respond?.(rec);
      const send = (status: number, body: unknown, headers: Record<string, string>): void => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (custom !== undefined) {
        send(custom.status, custom.body ?? {}, custom.headers ?? {});
        return;
      }
      answer(rec, Buffer.concat(chunks).toString("utf-8")).then(
        (body) => send(200, body, {}),
        () => send(200, {}, {}),
      );
    });
  });

  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on("connection", (socket) => {
    sockets.add(socket);
    connections++;
    notify();
    let first = true;
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
      if (first) {
        first = false;
        firstFrames.push(text);
        notify();
        socket.send(JSON.stringify({ type: "auth_result", ok: true }));
        return;
      }
      let msg: { type?: string; task_id?: string };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "task_claim" && typeof msg.task_id === "string") {
        socket.send(
          JSON.stringify({ type: "task_claimed", task_id: msg.task_id, lease_ms: 60_000 }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const sightings = (token: string, fromIndex = 0, toIndex = requests.length): string[] => {
    const out: string[] = [];
    for (const r of requests.slice(fromIndex, toIndex)) {
      if (r.authorization != null && r.authorization.includes(token)) {
        out.push(`${r.method} ${maskPath(r.path)}`);
      }
    }
    if (fromIndex === 0) {
      for (const f of firstFrames) if (f.includes(token)) out.push("ws first frame");
    }
    return out;
  };

  const waitUntil = async <T>(
    probe: () => T | undefined,
    timeoutMs: number,
  ): Promise<T | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = probe();
      if (hit !== undefined) return hit;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 200));
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };

  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    firstFrames,
    sightings,
    dispatchTask(motebitId) {
      const taskId = randomUUID();
      const frame = JSON.stringify({
        type: "task_request",
        task: {
          task_id: taskId,
          motebit_id: motebitId,
          prompt: "say ok",
          submitted_at: Date.now(),
          status: "pending",
        },
      });
      for (const s of sockets) s.send(frame);
      return taskId;
    },
    waitForRequest: (pred, timeoutMs = 30_000) => waitUntil(() => requests.find(pred), timeoutMs),
    waitForFirstFrame: (timeoutMs = 30_000) => waitUntil(() => firstFrames[0], timeoutMs),
    waitForSocket: async (timeoutMs = 30_000) =>
      (await waitUntil(() => (connections > 0 ? true : undefined), timeoutMs)) === true,
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** How one request authenticated: with a known operator token, a signed device token, or nothing. */
export function authKind(r: RecordedRequest): "operator" | "device" | "none" | "other" {
  const a = r.authorization;
  if (a == null || a === "") return "none";
  if (a.includes(TOKEN_A) || a.includes(TOKEN_B)) return "operator";
  // A device token is a signed JWT-shaped bearer: two dots, base64url parts.
  return /^Bearer [\w-]+\.[\w-]+(\.[\w-]+)?$/.test(a) ? "device" : "other";
}

// ── Identity ────────────────────────────────────────────────────────────────

export interface EphemeralIdentity {
  /** A fresh `MOTEBIT_CONFIG_DIR`. */
  configDir: string;
  /** A fresh directory to run in (holds no `motebit.yaml`). */
  workDir: string;
  /** A signed `motebit.md` for `--identity`. */
  identityPath: string;
  motebitId: string;
  deviceId: string | undefined;
  /** Rewrite `config.json` with these fields merged in (undefined removes one). */
  patchConfig(patch: Record<string, unknown>): void;
}

interface IdentityMaterial {
  motebitId: string;
  publicKeyHex: string;
  encrypted: unknown;
  /** `motebit.md` with a device, and with none. */
  identityFile: { withDevice: string; withoutDevice: string };
  deviceId: string;
}

let material: Promise<IdentityMaterial> | undefined;

/** One key for the whole file: deriving the encryption key is the slow part. */
function identityMaterial(): Promise<IdentityMaterial> {
  material ??= (async () => {
    const { encryptPrivateKey } = await import("../identity.js");
    const kp = await generateKeypair();
    const publicKeyHex = bytesToHex(kp.publicKey);
    const motebitId = await deriveSovereignMotebitId(publicKeyHex);
    const deviceId = randomUUID();
    const file = (devices: boolean): Promise<string> =>
      generateIdentityFile(
        {
          motebitId,
          ownerId: motebitId,
          publicKeyHex,
          devices: devices
            ? [
                {
                  device_id: deviceId,
                  name: "cli",
                  public_key: publicKeyHex,
                  registered_at: new Date().toISOString(),
                },
              ]
            : [],
        },
        kp.privateKey,
      );
    return {
      motebitId,
      publicKeyHex,
      encrypted: await encryptPrivateKey(bytesToHex(kp.privateKey), PASSPHRASE),
      identityFile: { withDevice: await file(true), withoutDevice: await file(false) },
      deviceId,
    };
  })();
  return material;
}

/**
 * An identity in a fresh config directory, created without a prompt: the key
 * is encrypted under `PASSPHRASE` and written to `config.json`; a signed
 * `motebit.md` sits beside it.
 *
 * `deviceId: false` writes the config with a key and NO `device_id` — the
 * shape under which the daemons can mint no token and fall back to the
 * configured one.
 */
export async function createEphemeralIdentity(
  opts: { deviceId?: boolean } = {},
): Promise<EphemeralIdentity> {
  const m = await identityMaterial();
  // Short paths: the runtime-host socket lives in the config directory and a
  // unix socket path is limited to ~104 bytes on macOS.
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mb-ot-"));
  const configDir = path.join(base, "c");
  const workDir = path.join(base, "w");
  fs.mkdirSync(configDir, { mode: 0o700 });
  fs.mkdirSync(workDir, { mode: 0o700 });
  const withDevice = opts.deviceId !== false;

  const config: Record<string, unknown> = {
    motebit_id: m.motebitId,
    ...(withDevice ? { device_id: m.deviceId } : {}),
    device_public_key: m.publicKeyHex,
    cli_encrypted_key: m.encrypted,
  };
  const configPath = path.join(configDir, "config.json");
  const write = (): void =>
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  write();

  const identityPath = path.join(base, "motebit.md");
  fs.writeFileSync(
    identityPath,
    withDevice ? m.identityFile.withDevice : m.identityFile.withoutDevice,
    "utf-8",
  );

  return {
    configDir,
    workDir,
    identityPath,
    motebitId: m.motebitId,
    deviceId: withDevice ? m.deviceId : undefined,
    patchConfig(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete config[k];
        else config[k] = v;
      }
      write();
    },
  };
}

// ── The token record, written directly ──────────────────────────────────────

/** SHA-256 hex of a token's UTF-8 bytes: what the record stores. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/**
 * Write `relay-operator-tokens.json` directly: `{ <relay url>: <token> }`.
 * Plain URLs only — the record's key for `http://127.0.0.1:<port>` is the URL
 * itself.
 */
export function writeTokenRecord(configDir: string, entries: Record<string, string>): string {
  const file = path.join(configDir, "relay-operator-tokens.json");
  const tokens: Record<string, string> = {};
  for (const [url, token] of Object.entries(entries)) tokens[url] = tokenHash(token);
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// ── The CLI as a subprocess ─────────────────────────────────────────────────

export interface CliProcess {
  child: ChildProcess;
  /** stdout and stderr so far, interleaved. */
  output(): string;
  stderr(): string;
  /** Resolves with the exit code (null when killed). */
  exited: Promise<number | null>;
  /** SIGTERM, then SIGKILL after a grace period; resolves when it is gone. */
  stop(): Promise<void>;
}

/**
 * Run the CLI FROM SOURCE (`node --import tsx src/index.ts`), so a subprocess
 * row always exercises the tree it runs in, never a stale build. The
 * environment is built from nothing: no `MOTEBIT_*` variable of the host
 * reaches the child, and `HOME` is the identity's own temp directory.
 */
export function spawnCli(
  args: readonly string[],
  opts: {
    identity: Pick<EphemeralIdentity, "configDir" | "workDir">;
    env?: Record<string, string | undefined>;
    /** `"open"`: keep stdin open (the REPL); a string: write it and close; default: closed. */
    stdin?: string;
  },
): CliProcess {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: path.dirname(opts.identity.configDir),
    TMPDIR: process.env["TMPDIR"] ?? os.tmpdir(),
    MOTEBIT_CONFIG_DIR: opts.identity.configDir,
    MOTEBIT_PASSPHRASE: PASSPHRASE,
    NO_COLOR: "1",
    NODE_ENV: "test",
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: opts.identity.workDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString("utf-8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString("utf-8");
    out += s;
    err += s;
  });
  child.stdin?.on("error", () => {
    // The child exited before reading its input: nothing to write to.
  });
  if (opts.stdin === "open") {
    // Interactive: the caller writes lines as prompts appear.
  } else if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  let done = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      done = true;
      resolve(code);
    });
  });

  return {
    child,
    output: () => out,
    stderr: () => err,
    exited,
    async stop() {
      if (done) return;
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    },
  };
}

// ── The matrix ──────────────────────────────────────────────────────────────

/** How the relay URL naming B reaches the command. */
export type Route = "flag" | "env" | "saved";
/** One of the three token sources. */
export type Source = "flag" | "api" | "sync";

export const ALL_ROUTES: readonly Route[] = ["flag", "env", "saved"];
export const ALL_SOURCES: readonly Source[] = ["flag", "api", "sync"];

interface World {
  /** The command's own relay under test (B in a leak row). */
  own: FakeRelay;
  /** A second relay: A in a leak row; an unrelated relay otherwise. */
  other: FakeRelay;
  identity: EphemeralIdentity;
}

/** What a row saw. */
export interface Observation {
  /** Where `token` was seen at the command's own relay (ids masked, sorted, unique). */
  tokenAtOwn: string[];
  /** How the command's requests to its own relay authenticated (unique kinds, sorted). */
  authKinds: string[];
  /** Requests the command made to its own relay. */
  requests: number;
  /** stderr carried the "was not sent" line. */
  withheldLine: boolean;
  /** The whole output, for a failing assertion's message. Never recorded by the probe. */
  output: string;
}

export interface SiteSpec {
  /** Stable id: the row's name. */
  id: string;
  /** What kind of process the site runs in. */
  kind: "subcommand" | "daemon" | "repl";
  /** The relay-URL routes the site honours, highest precedence first. */
  routes: readonly Route[];
  /** The token sources the site honours on main, in order. */
  sources: readonly Source[];
  /**
   * What the site does with no operator token: sign as the device, send no
   * auth, or make no request at all (`smoke`).
   */
  fallback: "device" | "none" | "no-request";
  /** `false`: a config with a key and no `device_id`. */
  deviceId?: boolean;
  /** Subcommand argv (without the relay URL flag or the token flag). */
  argv?: (w: { other: string; out: string; id: string }) => string[];
  /** Daemon: which command, and what to wait for at the relay. */
  daemon?: {
    command: (w: { identity: string }) => string[];
    /** Drive the daemon until its channel has fired (or cannot). */
    drive: (w: World) => Promise<void>;
    /** The requests (or frame) that belong to this channel. */
    channel: (r: RecordedRequest) => boolean;
    /** The channel is the socket's first frame, not a request. */
    firstFrame?: boolean;
  };
  /** REPL: the line to type, or undefined for a startup site. */
  repl?: { line?: string; channel: (r: RecordedRequest) => boolean };
}

const FAR_TARGET = "00000000-0000-4000-8000-000000000001";

const sub = (id: string, argv: SiteSpec["argv"], extra: Partial<SiteSpec> = {}): SiteSpec => ({
  id,
  kind: "subcommand",
  routes: ALL_ROUTES,
  sources: ALL_SOURCES,
  fallback: "device",
  argv,
  ...extra,
});

/** Commands whose URL is flag-or-variable only, never the saved config. */
const FLAG_OR_ENV: readonly Route[] = ["flag", "env"];

const isSync = (r: RecordedRequest): boolean => r.path.startsWith("/sync/");
const isResult = (r: RecordedRequest): boolean => r.path.endsWith("/result");
const isTaskSubmit = (r: RecordedRequest): boolean =>
  r.method === "POST" && /^\/agent\/[^/]+\/task$/.test(r.path);

/**
 * Wait for the daemon's socket to connect, then for its first frame. A daemon
 * that can mint no token and holds no operator token sends no auth frame at
 * all, so the frame gets a short wait of its own.
 */
async function socketThenFrame(w: World): Promise<void> {
  if (!(await w.own.waitForSocket(60_000))) return;
  await w.own.waitForFirstFrame(1_500);
}

/** Wait for the socket, give the daemon a moment to wire its handlers, send a task, wait for the receipt. */
async function driveTaskReceipt(w: World): Promise<void> {
  await w.own.waitForFirstFrame(60_000);
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(700);
    w.own.dispatchTask(w.identity.motebitId);
    if ((await w.own.waitForRequest(isResult, 5_000)) !== undefined) return;
  }
}

/*
 * NOT a row: `motebit run`'s plan-delegation token factory (daemon.ts, the
 * `tokenFactory` handed to `RelayDelegationAdapter`). It returns the operator
 * token only with a key and no `device_id`, and it is called only when the
 * RUNTIME's plan engine delegates a step. Nothing in `motebit run` drives
 * that engine: goals run through the scheduler's own `PlanEngine`, which has
 * no delegation adapter. Measured on the branch and read on main (99e213719):
 * a seeded active plan whose step needs a non-local capability is resumed by
 * the scheduler and fails "Requires capabilities not available locally", even
 * after the daemon logs "Delegation: enabled". So no fixture makes `motebit
 * run` send a token through that factory, on either tree, and this file does
 * not pretend one does. The site is still changed and still held by
 * `check-cli-operator-token-reader`.
 */
const RUN = (w: { identity: string }): string[] => [
  "run",
  "--identity",
  w.identity,
  "--provider",
  "local-server",
];
const SERVE = (): string[] => [
  "serve",
  "--serve-transport",
  "http",
  "--serve-port",
  "0",
  "--direct",
];
const RUN_SOURCES: readonly Source[] = ["flag", "sync"];
const SERVE_SOURCES: readonly Source[] = ["flag", "api"];

const slash = (id: string, line: string, channel: (r: RecordedRequest) => boolean): SiteSpec => ({
  id: `repl ${id}`,
  kind: "repl",
  routes: ALL_ROUTES,
  sources: ALL_SOURCES,
  fallback: "device",
  repl: { line, channel },
});

/**
 * Every send site of the operator token, one row each (design section 1).
 * `routes`, `sources` and `fallback` are what the site does on main, read
 * from the code at 99e213719 and confirmed by the differential.
 */
export const SITES: readonly SiteSpec[] = [
  // ── Subcommands through `getRelayAuthHeaders` ──
  sub("balance", () => ["balance"]),
  sub("withdraw", () => ["withdraw", "1"]),
  sub("fund", () => ["fund", "1"]),
  sub("discover", () => ["discover", FAR_TARGET]),
  sub("discover (relay metadata)", () => ["discover"]),
  sub("credentials", () => ["credentials"], { routes: FLAG_OR_ENV }),
  sub("credentials --presentation", () => ["credentials", "--presentation"], {
    routes: FLAG_OR_ENV,
  }),
  sub("ledger", () => ["ledger", "goal-1"], { routes: FLAG_OR_ENV }),
  sub("export", (w) => ["export", "--output", w.out], { routes: FLAG_OR_ENV }),
  sub("delegate", () => ["delegate", "say ok", "--target", FAR_TARGET]),
  sub("delegate --plan", () => ["delegate", "say ok", "--plan", "--provider", "local-server"]),
  sub("migrate", (w) => ["migrate", "--destination", w.other]),
  sub("migrate status", () => ["migrate", "status"]),
  sub("migrate cancel", () => ["migrate", "cancel"]),
  sub("federation peers", () => ["federation", "peers"]),
  sub("federation peer", (w) => ["federation", "peer", w.other]),
  sub("federation peer-remove", (w) => ["federation", "peer-remove", w.other]),
  sub("federation mesh", (w) => ["federation", "mesh", "@own", w.other], {
    // The URLs are positional: no relay-URL source is read at all.
    routes: ["flag"],
  }),
  // ── Direct readers ──
  sub("smoke reconciliation", () => ["smoke", "reconciliation"], { fallback: "no-request" }),
  sub("doctor", () => ["doctor"], {
    routes: ["env", "saved"],
    sources: ["api", "sync"],
    fallback: "none",
  }),
  // ── `motebit run` ──
  {
    id: "run event sync",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: RUN_SOURCES,
    fallback: "device",
    daemon: {
      command: RUN,
      drive: async (w) => void (await w.own.waitForRequest(isSync, 60_000)),
      channel: isSync,
    },
  },
  {
    id: "run task-receipt POST",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: RUN_SOURCES,
    fallback: "device",
    daemon: { command: RUN, drive: driveTaskReceipt, channel: isResult },
  },
  {
    id: "run WebSocket first frame (key, no device id)",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: RUN_SOURCES,
    fallback: "none",
    deviceId: false,
    daemon: {
      command: RUN,
      drive: socketThenFrame,
      channel: () => false,
      firstFrame: true,
    },
  },
  // ── `motebit serve` ──
  {
    id: "serve event sync",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: SERVE_SOURCES,
    fallback: "device",
    daemon: {
      command: SERVE,
      drive: async (w) => void (await w.own.waitForRequest(isSync, 60_000)),
      channel: isSync,
    },
  },
  {
    id: "serve task-receipt POST",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: SERVE_SOURCES,
    fallback: "device",
    daemon: { command: SERVE, drive: driveTaskReceipt, channel: isResult },
  },
  {
    id: "serve WebSocket first frame (key, no device id)",
    kind: "daemon",
    routes: ALL_ROUTES,
    sources: SERVE_SOURCES,
    fallback: "none",
    deviceId: false,
    daemon: {
      command: SERVE,
      drive: socketThenFrame,
      channel: () => false,
      firstFrame: true,
    },
  },
  // ── REPL startup ──
  {
    id: "repl startup event sync",
    kind: "repl",
    routes: ALL_ROUTES,
    sources: ALL_SOURCES,
    fallback: "device",
    repl: { channel: isSync },
  },
  {
    id: "repl startup agent discovery",
    kind: "repl",
    routes: ALL_ROUTES,
    sources: ["flag", "api"],
    fallback: "none",
    repl: { channel: (r) => r.path === "/api/v1/agents/discover" },
  },
  {
    id: "repl delegation wiring (key, no device id)",
    kind: "repl",
    routes: ALL_ROUTES,
    sources: ["flag", "api"],
    fallback: "no-request",
    deviceId: false,
    repl: { line: "/invoke web_search say ok", channel: isTaskSubmit },
  },
  // ── REPL slash commands through `getRelayToken` ──
  slash("/sync", "/sync", (r) => /\/(conversations|plans)\b/.test(r.path)),
  slash("/serve", "/serve @port", (r) => r.path === "/api/v1/agents/register"),
  slash("/discover", "/discover", (r) => r.path.startsWith("/api/v1/agents/discover")),
  slash("/delegate", `/delegate ${FAR_TARGET} say ok`, isTaskSubmit),
  slash("/propose", `/propose ${FAR_TARGET} do it`, (r) => r.path === "/api/v1/proposals"),
  slash("/proposals", "/proposals", (r) => r.path.startsWith("/api/v1/proposals")),
  slash("/proposal", "/proposal p1", (r) => r.path === "/api/v1/proposals/p1"),
  slash("/ledger", "/ledger goal-1", (r) => r.path.includes("/ledger/")),
  slash("/balance", "/balance", (r) => r.path.endsWith("/balance")),
  slash("/withdraw", "/withdraw 1", (r) => r.path.endsWith("/withdraw")),
  slash("/deposits", "/deposits", (r) => r.path.endsWith("/balance")),
];

export function site(id: string): SiteSpec {
  const s = SITES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no such site: ${id}`);
  return s;
}

/** One row's setup: where each relay URL source points, and which tokens are set and bound. */
interface RowSetup {
  /** The route that names the command's own relay. */
  route: Route;
  /** What every lower-precedence URL source holds (`other`), or nothing. */
  lowerSources: "other" | "unset";
  /** Token per source (undefined: unset). */
  tokens: Partial<Record<Source, string>>;
  /** Which relay the record binds, and to which token. */
  bind: Array<{ relay: "own" | "other"; token: string }>;
  /** The token whose arrival at the command's own relay is observed. */
  watch: string;
}

const routeRank = (r: Route): number => ALL_ROUTES.indexOf(r);

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** Type one line into the REPL and wait for it to come back to its prompt. */
export async function replLine(
  cli: CliProcess,
  line: string,
  fired: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const before = cli.output().length;
  cli.child.stdin?.write(`${line}\r`);
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = Date.now();
  let firedAt: number | undefined;
  let exited = false;
  void cli.exited.then(() => {
    exited = true;
  });
  for (;;) {
    await sleep(100);
    // The command's request arrived: give the rest of the command a moment,
    // then stop waiting (a command that polls for a result never returns).
    if (firedAt === undefined && fired()) firedAt = Date.now();
    if (firedAt !== undefined && Date.now() - firedAt > 1_500) return;
    if (exited) return;
    const out = cli.output();
    if (out.length !== last) {
      last = out.length;
      stableSince = Date.now();
    }
    const tail = out
      .slice(out.lastIndexOf("you> ") + 5)
      // eslint-disable-next-line no-control-regex -- terminal escapes are what is stripped
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    const back = out.length > before && out.lastIndexOf("you> ") > before && tail.trim() === "";
    if (back && Date.now() - stableSince > 400) return;
    if (Date.now() > deadline) return;
  }
}

export async function waitForPrompt(cli: CliProcess, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cli.output().includes("you> ")) {
    if (Date.now() > deadline) return false;
    if ((await Promise.race([cli.exited.then(() => true), sleep(100).then(() => false)])) === true)
      return false;
  }
  await sleep(300);
  return true;
}

/** Run one site under one setup and report what its own relay saw. */
export async function runRow(spec: SiteSpec, setup: RowSetup): Promise<Observation> {
  const own = await startFakeRelay();
  const other = await startFakeRelay();
  const identity = await createEphemeralIdentity(
    spec.deviceId === false ? { deviceId: false } : {},
  );
  const world: World = { own, other, identity };
  let cli: CliProcess | undefined;
  try {
    // Relay URL sources: `route` names the own relay; every source of lower
    // precedence holds the other relay (or nothing).
    const lower = setup.lowerSources === "other" ? other.url : undefined;
    const urlFor = (r: Route): string | undefined =>
      r === setup.route ? own.url : routeRank(r) > routeRank(setup.route) ? lower : undefined;
    const env: Record<string, string | undefined> = {
      MOTEBIT_SYNC_URL: urlFor("env"),
      MOTEBIT_API_TOKEN: setup.tokens.api,
      MOTEBIT_SYNC_TOKEN: setup.tokens.sync,
    };
    identity.patchConfig({ sync_url: urlFor("saved") });
    const record: Record<string, string> = {};
    for (const b of setup.bind) record[(b.relay === "own" ? own : other).url] = b.token;
    writeTokenRecord(identity.configDir, record);

    const urlArgs = urlFor("flag") !== undefined ? ["--sync-url", urlFor("flag")!] : [];
    const tokenArgs = setup.tokens.flag !== undefined ? ["--sync-token", setup.tokens.flag] : [];

    let from = 0;
    let to: number | undefined;
    if (spec.kind === "subcommand") {
      const out = path.join(identity.workDir, "export-out");
      const argv = spec.argv!({ other: other.url, out, id: identity.motebitId }).map((a) =>
        a === "@own" ? own.url : a,
      );
      // `federation mesh` names its relays positionally: no URL flag.
      const flags = spec.id === "federation mesh" ? tokenArgs : [...urlArgs, ...tokenArgs];
      cli = spawnCli([...argv, ...flags], { identity, env });
      await Promise.race([cli.exited, sleep(90_000)]);
    } else if (spec.kind === "daemon") {
      cli = spawnCli(
        [...spec.daemon!.command({ identity: identity.identityPath }), ...urlArgs, ...tokenArgs],
        { identity, env },
      );
      await Promise.race([spec.daemon!.drive(world), cli.exited]);
    } else {
      cli = spawnCli(["--provider", "local-server", ...urlArgs, ...tokenArgs], {
        identity,
        env,
        stdin: "open",
      });
      const ready = await waitForPrompt(cli);
      if (ready && spec.repl!.line !== undefined) {
        from = own.requests.length;
        const line = spec.repl!.line.replace("@port", String(await freePort()));
        const start = from;
        await replLine(cli, line, () => own.requests.slice(start).some(spec.repl!.channel));
        to = own.requests.length;
      }
    }
    await cli.stop();

    const channel =
      spec.kind === "daemon"
        ? spec.daemon!.channel
        : spec.kind === "repl"
          ? spec.repl!.channel
          : null;
    const window = own.requests.slice(from, to);
    const mine = channel === null ? window : window.filter(channel);
    const seen = new Set<string>();
    for (const r of mine) {
      if (r.authorization != null && r.authorization.includes(setup.watch)) {
        seen.add(`${r.method} ${maskPath(r.path)}`);
      }
    }
    const firstFrame = spec.kind === "daemon" && spec.daemon!.firstFrame === true;
    if (firstFrame && own.firstFrames.some((f) => f.includes(setup.watch))) {
      seen.add("ws first frame");
    }
    const kinds = new Set<string>(mine.map((r) => authKind(r)));
    if (firstFrame) {
      const f = own.firstFrames[0];
      kinds.add(
        f === undefined
          ? "no-frame"
          : f.includes(TOKEN_A) || f.includes(TOKEN_B)
            ? "operator"
            : f.includes('"type":"auth"')
              ? "device"
              : "none",
      );
    }
    return {
      tokenAtOwn: [...seen].sort(),
      authKinds: [...kinds].sort(),
      requests: mine.length,
      withheldLine: cli.output().includes("was not sent to"),
      output: cli.output().slice(-4000),
    };
  } finally {
    await cli?.stop();
    await own.close();
    await other.close();
    fs.rmSync(path.dirname(identity.configDir), { recursive: true, force: true });
  }
}

/** Both variables and (where honoured) nothing else: every site reads at least one. */
const bothVariables = (token: string): Partial<Record<Source, string>> => ({
  api: token,
  sync: token,
});

/**
 * LEAK: relay A's token, bound to A; A in every relay-URL source below the
 * one naming B. Observed at B. Main: B receives A's token. Branch: never.
 */
export function leakRow(spec: SiteSpec, route: Route): Promise<Observation> {
  return runRow(spec, {
    route,
    lowerSources: "other",
    tokens: bothVariables(TOKEN_A),
    bind: [{ relay: "other", token: TOKEN_A }],
    watch: TOKEN_A,
  });
}

/** CONTROL: B's token bound to B, and B is the relay: B receives it, as on main. */
export function controlRow(spec: SiteSpec): Promise<Observation> {
  return runRow(spec, {
    route: spec.routes[0]!,
    lowerSources: "unset",
    tokens: bothVariables(TOKEN_B),
    bind: [{ relay: "own", token: TOKEN_B }],
    watch: TOKEN_B,
  });
}

/** SOURCE: one source set alone, bound to the command's own relay. */
export function sourceRow(spec: SiteSpec, source: Source): Promise<Observation> {
  return runRow(spec, {
    route: spec.routes[0]!,
    lowerSources: "unset",
    tokens: { [source]: TOKEN_B },
    bind: [{ relay: "own", token: TOKEN_B }],
    watch: TOKEN_B,
  });
}

/** Run `tasks` with at most `limit` at once; results in order. */
export async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        results[i] = await tasks[i]!();
      }
    }),
  );
  return results;
}

// ── The rows as tests ───────────────────────────────────────────────────────

/** A row's exact title, so a tamper catalog can name the test that must go red. */
export const leakTitle = (id: string, route: Route): string => `leak | ${id} | B named by ${route}`;
export const controlTitle = (id: string): string => `control | ${id}`;
export const sourceTitle = (id: string, source: Source): string => `source | ${id} | ${source}`;
/** The describe every row of a kind sits under. */
export const rowsDescribe = (kind: SiteSpec["kind"]): string =>
  `operator token per relay: ${kind} send sites`;

const ROW_TIMEOUT_MS = 180_000;

/**
 * Register one test per row for every site of `kind`: the branch's
 * assertions over the same rows the differential records.
 */
export function defineSiteRows(kind: SiteSpec["kind"]): void {
  describe.concurrent(rowsDescribe(kind), () => {
    for (const spec of SITES.filter((s) => s.kind === kind)) {
      for (const route of spec.routes) {
        it(
          leakTitle(spec.id, route),
          async () => {
            const o = await leakRow(spec, route);
            // B never receives A's token.
            expect(o.tokenAtOwn, o.output).toEqual([]);
            expect(o.authKinds, o.output).not.toContain("operator");
            // And the site falls back as it does with no operator token set.
            if (spec.fallback === "device") expect(o.authKinds, o.output).toContain("device");
            if (spec.fallback === "none") {
              expect(o.authKinds, o.output).not.toContain("device");
              expect(o.authKinds.length, o.output).toBeGreaterThan(0);
            }
            if (spec.fallback === "no-request") expect(o.requests, o.output).toBe(0);
            // The owner is told, without the token.
            expect(o.withheldLine, o.output).toBe(true);
            expect(o.output).not.toContain(TOKEN_A);
          },
          ROW_TIMEOUT_MS,
        );
      }
      it(
        controlTitle(spec.id),
        async () => {
          const o = await controlRow(spec);
          expect(o.tokenAtOwn.length, o.output).toBeGreaterThan(0);
          // A bound token draws no warning. (`federation mesh` also names a
          // second relay the token is NOT bound to, and says so.)
          if (spec.id !== "federation mesh") expect(o.withheldLine, o.output).toBe(false);
        },
        ROW_TIMEOUT_MS,
      );
      for (const source of ALL_SOURCES) {
        it(
          sourceTitle(spec.id, source),
          async () => {
            const o = await sourceRow(spec, source);
            expect(o.tokenAtOwn.length > 0, o.output).toBe(spec.sources.includes(source));
          },
          ROW_TIMEOUT_MS,
        );
      }
    }
  });
}

// ── The differential probe ──────────────────────────────────────────────────

const probeOut = process.env["PROBE_OUT"];
if (probeOut !== undefined && probeOut !== "") {
  const observations: Record<string, unknown> = {};
  const record = (o: Observation): unknown => ({
    tokenAtRelay: o.tokenAtOwn,
    authKinds: o.authKinds,
  });

  describe("operator token per relay — what each tree sends", () => {
    it("records every send site, leak / control / source", async () => {
      const tasks: Array<() => Promise<void>> = [];
      for (const spec of SITES) {
        for (const route of spec.routes) {
          tasks.push(async () => {
            observations[`leak | ${spec.id} | B named by ${route}`] = record(
              await leakRow(spec, route),
            );
          });
        }
        tasks.push(async () => {
          observations[`control | ${spec.id}`] = record(await controlRow(spec));
        });
        for (const source of ALL_SOURCES) {
          tasks.push(async () => {
            observations[`source | ${spec.id} | ${source}`] =
              (await sourceRow(spec, source)).tokenAtOwn.length > 0 ? "sent" : "not sent";
          });
        }
      }
      await pooled(tasks, Math.max(2, Math.min(8, os.availableParallelism() - 2)));
    }, 3_600_000);
  });

  afterAll(() => {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(observations).sort()) sorted[k] = observations[k];
    fs.writeFileSync(probeOut, JSON.stringify(sorted, null, 2));
  });
}
