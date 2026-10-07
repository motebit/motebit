/**
 * Relay sync is opt-in (`sync-opt-in.ts`) — and with a relay CONFIGURED, every
 * door that introduces the device's key still signs that introduction (#875).
 *
 * The opt-in refactor moved the REPL's relay wiring and re-gated register,
 * `/connect` and the daemon; this suite pins that none of those moves can drop
 * the signature silently. `fetch` is stubbed to CAPTURE every
 * `POST /api/v1/agents/bootstrap` body (and answer 200); the rest is refused.
 * For each door — `motebit register`, REPL startup (`startReplRelay`),
 * `/connect`, and daemon start (`registerWithRelay` + the push loop's
 * re-bootstrap) — every captured body carries `timestamp`, `suite` and
 * `signature`, and verifies under the key it introduces.
 */
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-optin-sig-cfg-"));
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
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  verifyDeviceRegistration,
} from "@motebit/encryption";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { SyncEngine } from "@motebit/sync-engine";
import { parseCliArgs } from "../args.js";
import { bootstrapReplIdentity, startRunEventSync } from "../cli-event-push.js";
import { loadFullConfig, saveFullConfig, type FullConfig } from "../config.js";
import type { DaemonRelaySync } from "../daemon-relay-sync.js";
import { registerWithRelay } from "../relay-registration.js";
import { startReplRelay } from "../repl-relay.js";
import { createRuntime, InMemoryToolRegistry } from "../runtime-factory.js";
import { handleSlashCommand } from "../slash-commands.js";
import { daemonRelay } from "../sync-configured.js";
import { resolveRelayUrl } from "../subcommands/_helpers.js";
import { handleRegister } from "../subcommands/register.js";

const RELAY = "https://signed.optin.example";
const PASS = "pass-optin-signed";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Every bootstrap body sent, parsed. */
let bootstraps: Captured[] = [];

function captureBootstraps(): void {
  bootstraps = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request).url);
    if (url.endsWith("/api/v1/agents/bootstrap")) {
      bootstraps.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return new Response(JSON.stringify({ registered: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`network denied: ${url}`);
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: unknown) {
        throw new Error(`network denied: ${String(url)}`);
      }
    },
  );
}

/** Each captured body: aimed at the configured relay, signed, and verifying under its own key. */
async function expectAllSigned(min: number): Promise<void> {
  expect(bootstraps.length).toBeGreaterThanOrEqual(min);
  for (const { url, body } of bootstraps) {
    expect(url.startsWith(`${RELAY}/`)).toBe(true);
    expect(typeof body["timestamp"]).toBe("number");
    expect(typeof body["suite"]).toBe("string");
    expect(typeof body["signature"]).toBe("string");
    const verdict = await verifyDeviceRegistration(
      body as unknown as Parameters<typeof verifyDeviceRegistration>[0],
    );
    expect(verdict).toEqual({ valid: true });
  }
}

async function deviceKeys(): Promise<{
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
}> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const motebitId = await deriveSovereignMotebitId(publicKeyHex);
  return { motebitId, deviceId: `${motebitId}-dev`, publicKeyHex, privateKey: kp.privateKey };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "motebit-optin-sig-"));
}

beforeEach(() => {
  captureBootstraps();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["MOTEBIT_PASSPHRASE"];
});

describe("relay configured — every bootstrap is signed (#875 survives the opt-in)", () => {
  it("motebit register", async () => {
    const full = {} as FullConfig;
    await bootstrapReplIdentity({
      dbPath: join(freshDir(), "motebit.db"),
      fullConfig: full,
      passphrase: PASS,
      syncConfigured: true,
    });
    const saved = loadFullConfig();
    saved.sync_url = RELAY;
    saveFullConfig(saved);
    process.env["MOTEBIT_PASSPHRASE"] = PASS;
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });

    await handleRegister(parseCliArgs(["register"]));

    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]!.body["public_key"]).toBe(saved.device_public_key);
    await expectAllSigned(1);
  });

  it("REPL startup (startReplRelay)", async () => {
    const config = {
      ...parseCliArgs(["--provider", "local-server", "--sync-url", RELAY]),
      dbPath: join(freshDir(), "motebit.db"),
    };
    const keys = await deviceKeys();
    const { runtime, moteDb } = await createRuntime(
      config,
      keys.motebitId,
      new InMemoryToolRegistry(),
      [],
    );
    try {
      const push = await startReplRelay({
        runtime,
        config,
        syncUrl: resolveRelayUrl(config),
        motebitId: keys.motebitId,
        eventStore: moteDb.eventStore,
        privateKeyBytes: keys.privateKey,
        deviceId: keys.deviceId,
        devicePublicKey: keys.publicKeyHex,
        relayPublicKey: undefined,
        log: () => {},
        warn: () => {},
        pushIntervalMs: 60_000,
      });
      push?.stop();
      await expectAllSigned(1);
    } finally {
      runtime.stop();
      moteDb.close();
    }
  });

  it("/connect <url>", async () => {
    const config = {
      ...parseCliArgs(["--provider", "local-server", "--sync-url", RELAY]),
      dbPath: join(freshDir(), "motebit.db"),
    };
    const keys = await deviceKeys();
    const { runtime, moteDb } = await createRuntime(
      config,
      keys.motebitId,
      new InMemoryToolRegistry(),
      [],
    );
    try {
      await handleSlashCommand(
        "connect",
        RELAY,
        runtime,
        config,
        { device_public_key: keys.publicKeyHex } as FullConfig,
        {
          moteDb,
          motebitId: keys.motebitId,
          mcpAdapters: [],
          privateKeyBytes: keys.privateKey,
          deviceId: keys.deviceId,
        },
      );
      await expectAllSigned(1);
    } finally {
      runtime.stop();
      moteDb.close();
    }
  });

  it("daemon start (`motebit run`: registerWithRelay + the push loop's re-bootstrap)", async () => {
    const c = loadFullConfig();
    c.sync_url = RELAY;
    saveFullConfig(c);
    const { syncUrl } = daemonRelay(parseCliArgs([]), loadFullConfig(), "run");
    expect(syncUrl).toBe(RELAY);
    const keys = await deviceKeys();

    // registerWithRelay — the daemon's registration, through the global fetch.
    const registration = await registerWithRelay({
      syncUrl: syncUrl!,
      identity: keys,
      registration: { motebit_id: keys.motebitId },
      toolNames: [],
      description: "daemon-optin",
      log: () => {},
      env: {},
    });
    registration.stop();
    const afterRegister = bootstraps.length;
    expect(afterRegister).toBeGreaterThanOrEqual(1);

    // startRunEventSync — a refused push (401) re-introduces the device's key.
    let refused = true;
    const sync = {
      sync: () => Promise.resolve(null),
      getLastError: () => (refused ? new Error("push failed: 401 Unauthorized") : null),
    } as unknown as SyncEngine;
    const runtime = {
      motebitId: keys.motebitId,
      sync,
      connectSync: (_remote: EventStoreAdapter) => {},
    };
    const relaySync = { transport: { remote: {} } } as unknown as DaemonRelaySync;
    const push = startRunEventSync(runtime, relaySync, {
      syncUrl: syncUrl!,
      log: () => {},
      device: keys,
      pushIntervalMs: 60_000,
    });
    try {
      await vi.waitFor(() => expect(bootstraps.length).toBeGreaterThan(afterRegister));
    } finally {
      refused = false;
      push.stop();
    }
    await expectAllSigned(2);

    const cleared = loadFullConfig();
    delete cleared.sync_url;
    saveFullConfig(cleared);
  });
});
