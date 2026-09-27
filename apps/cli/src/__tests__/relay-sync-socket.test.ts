/**
 * The daemon's relay socket outlives its token (#820).
 *
 * `motebit run` and `motebit serve` both build their socket with
 * `createRelaySyncSocket`. A signed sync token expires (5 minutes by
 * default), and the adapter reconnects on its own after a sleep, a flap or
 * a relay deploy. Before #820 both paths minted ONE token at startup, so a
 * reconnect after the token's lifetime was refused and the daemon stayed
 * disconnected for good.
 *
 * Driven against a real relay (`createSyncRelay` behind `@hono/node-server`)
 * over real sockets, with a short injected TTL: connect, let the token
 * expire, have the relay drop the socket, and prove the daemon is back —
 * registered, verified, and answering a signed command.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  signAgentCommandEnvelope,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { WebSocketEventStoreAdapter } from "@motebit/sync-engine";
import { registerWithRelay } from "../relay-registration.js";
import { createRelaySyncSocket, deviceSyncCredentialSource } from "../relay-sync-socket.js";

const MASTER = "test-token";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay | undefined;
let server: ReturnType<typeof serve> | undefined;
const sockets: WebSocketEventStoreAdapter[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (relay) await relay.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  relay = undefined;
  server = undefined;
});

async function waitFor(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startRelay(): Promise<string> {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as unknown as { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server!.listening) r();
    else server!.once("listening", () => r());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A registered sovereign identity with one device row (its own key). */
async function registeredDevice(): Promise<{ mid: string; deviceId: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const deviceId = `${mid}-host`;
  const handle = await registerWithRelay({
    syncUrl: "http://relay.test",
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(kp), privateKey: kp.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "relay sync socket",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: async (input, init) =>
      relay!.app.request(typeof input === "string" ? input : (input as Request).url, init),
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return { mid, deviceId, kp };
}

/** Answer every forwarded command the way the daemon's frame handler would reply. */
function answerCommands(socket: WebSocketEventStoreAdapter, summary: string): void {
  socket.onCustomMessage((msg) => {
    if (msg.type !== "command_request") return;
    socket.sendRaw(
      JSON.stringify({ type: "command_response", id: msg["id"], result: { summary } }),
    );
  });
}

async function postCommand(
  mid: string,
  kp: KeyPair,
): Promise<{ status: number; summary: unknown }> {
  const envelope = await signAgentCommandEnvelope({
    command: "state",
    motebitId: mid,
    identityPrivateKey: kp.privateKey,
  });
  const res = await relay!.app.request(`/api/v1/agents/${mid}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER}` },
    body: JSON.stringify({ command: "state", envelope }),
  });
  const body = (await res.json()) as { summary?: unknown };
  return { status: res.status, summary: body.summary };
}

const peers = (mid: string) => relay!.connections.get(mid) ?? [];

describe.each([
  ["motebit run", ["unattended_runtime", "run_ledger"]],
  ["motebit serve", ["http_mcp", "unattended_runtime"]],
])("%s: the socket reconnects after its token's lifetime", (_label, capabilities) => {
  it("expired token, relay drops the socket ⇒ back, verified, and answering a command", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId, kp } = await registeredDevice();
    const socket = createRelaySyncSocket({
      syncUrl,
      motebitId: mid,
      deviceId,
      privateKey: () => kp.privateKey,
      fallbackToken: MASTER,
      capabilities,
      ttlMs: 800,
      reconnectBaseMs: 50,
    });
    sockets.push(socket);
    answerCommands(socket, "answered after the reconnect");
    socket.connect();
    await waitFor(() => peers(mid).length === 1, "the first connection");
    const first = peers(mid)[0]!;
    expect(first.deviceIdVerified).toBe(true);

    // Outlive the token, then lose the connection the way a flap or a
    // relay restart does: the server side goes away.
    await new Promise((r) => setTimeout(r, 1_000));
    first.ws.close(1001, "going away");

    await waitFor(
      () => peers(mid).length === 1 && peers(mid)[0] !== first,
      "the reconnect under a fresh token",
    );
    expect(peers(mid)[0]!.deviceIdVerified).toBe(true);

    const { status, summary } = await postCommand(mid, kp);
    expect(status).toBe(200);
    expect(summary).toBe("answered after the reconnect");
  });
});

/**
 * The tests above drive `createRelaySyncSocket`; this pins that BOTH daemon
 * paths build their socket with it. `handleRun` / `handleServe` open a
 * database, a runtime and an MCP server, so they are not booted here — a
 * scan of the source is the cheapest thing that goes red if either path
 * goes back to a hand-built adapter with a token minted once.
 */
describe("both daemon paths build their relay socket through createRelaySyncSocket", () => {
  it("`motebit run` and `motebit serve`: two calls, and no hand-built adapter", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../daemon.ts", import.meta.url)), "utf8");
    expect(src.match(/createRelaySyncSocket\(\{/g) ?? []).toHaveLength(2);
    expect(src).not.toMatch(/new WebSocketEventStoreAdapter\(/);
    expect(src).not.toMatch(/aud: "sync"/);
  });
});

describe("deviceSyncCredentialSource", () => {
  it("mints a FRESH token on every call", async () => {
    const kp = await generateKeypair();
    const source = deviceSyncCredentialSource({
      motebitId: "m",
      deviceId: "d",
      privateKey: () => kp.privateKey,
    });
    const a = await source.getCredential({ serverUrl: "ws://x" });
    const b = await source.getCredential({ serverUrl: "ws://x" });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("no key or no device id ⇒ the static fallback, the form every other caller still uses", async () => {
    const noKey = deviceSyncCredentialSource({
      motebitId: "m",
      deviceId: "d",
      privateKey: () => undefined,
      fallbackToken: MASTER,
    });
    expect(await noKey.getCredential({ serverUrl: "ws://x" })).toBe(MASTER);
    const noDevice = deviceSyncCredentialSource({
      motebitId: "m",
      deviceId: undefined,
      privateKey: () => new Uint8Array(32),
    });
    expect(await noDevice.getCredential({ serverUrl: "ws://x" })).toBeNull();
  });

  it("never rejects: a failed mint falls back and is reported", async () => {
    const errors: unknown[] = [];
    const source = deviceSyncCredentialSource({
      motebitId: "m",
      deviceId: "d",
      privateKey: () => new Uint8Array(3), // not a key
      fallbackToken: MASTER,
      onMintError: (err) => errors.push(err),
    });
    expect(await source.getCredential({ serverUrl: "ws://x" })).toBe(MASTER);
    expect(errors).toHaveLength(1);
  });

  it("with no key the socket still connects on the static fallback (the master token)", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId } = await registeredDevice();
    const socket = createRelaySyncSocket({
      syncUrl,
      motebitId: mid,
      deviceId,
      privateKey: () => undefined,
      fallbackToken: MASTER,
      capabilities: ["http_mcp"],
    });
    sockets.push(socket);
    socket.connect();
    await waitFor(() => peers(mid).length === 1, "the master-token connection");
  });
});
