/**
 * #928 / #927 — the daemons' relay EVENT transport (`createRelayEventTransport`).
 *
 * `motebit run` synced events through a bare HTTP adapter while holding the
 * identity key, so the relay stored those payloads in plaintext; and both
 * daemons captured one token (or none) for the life of the process. Driven
 * against a REAL relay (`createSyncRelay`): what the relay stores is read back
 * from its own pull route.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  deriveSyncEncryptionKey,
  generateKeypair,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { isEncryptedPayload } from "@motebit/sync-engine";
import { registerWithRelay } from "../relay-registration.js";
import { createRelayEventTransport } from "../relay-sync-socket.js";

const MASTER = "test-token";
const SECRET = "zz928-daemon-plaintext";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay | undefined;
let realFetch: typeof globalThis.fetch | undefined;

afterEach(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  if (relay) await relay.close();
  relay = undefined;
});

/** A relay reached in-process: the adapters' `fetch` is routed to its app. */
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
  realFetch = globalThis.fetch;
  const base = "http://relay.zz928.test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return relay!.app.request(url.replace(base, ""), init);
  }) as typeof globalThis.fetch;
  return base;
}

async function registeredDevice(): Promise<{ mid: string; deviceId: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const deviceId = `${mid}-host`;
  const handle = await registerWithRelay({
    syncUrl: "http://relay.test",
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(kp), privateKey: kp.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "relay event transport",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: async (input, init) =>
      relay!.app.request(typeof input === "string" ? input : (input as Request).url, init),
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return { mid, deviceId, kp };
}

function event(mid: string, id: string, clock: number): EventLogEntry {
  return {
    event_id: id,
    motebit_id: mid as EventLogEntry["motebit_id"],
    timestamp: Date.now(),
    event_type: EventType.MemoryFormed,
    payload: { content: `${SECRET}-${id}` },
    version_clock: clock,
    tombstoned: false,
  };
}

/** What the relay holds for `mid`, read with the operator token from its own pull route. */
async function relayHolds(mid: string): Promise<EventLogEntry[]> {
  const res = await relay!.app.request(`/sync/${mid}/pull?after_clock=0`, {
    headers: { Authorization: `Bearer ${MASTER}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: EventLogEntry[] }).events;
}

describe("the daemons' relay event transport", () => {
  it("with the key held: a push reaches the relay as an E2E envelope, authenticated by a minted token", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId, kp } = await registeredDevice();
    const t = createRelayEventTransport({
      syncUrl,
      motebitId: mid,
      deviceId,
      privateKey: () => kp.privateKey,
      // No configured token: before, this path went unauthenticated for good.
      encKey: await deriveSyncEncryptionKey(kp.privateKey),
    });
    expect(t.e2e).toBe(true);
    await t.remote.append(event(mid, "e1", 1));

    const held = await relayHolds(mid);
    expect(held.map((e) => e.event_id)).toEqual(["e1"]);
    expect(isEncryptedPayload(held[0]!.payload)).toBe(true);
    expect(JSON.stringify(held)).not.toContain(SECRET);
    // And it reads back, decrypted, through the same transport.
    const mine = await t.remote.query({
      motebit_id: mid as EventLogEntry["motebit_id"],
      after_version_clock: 0,
    });
    expect(mine[0]!.payload).toEqual({ content: `${SECRET}-e1` });
  });

  it("a configured token is presented as before", async () => {
    const syncUrl = await startRelay();
    const { mid, kp } = await registeredDevice();
    const t = createRelayEventTransport({
      syncUrl,
      motebitId: mid,
      deviceId: undefined, // cannot mint: only the configured token can authenticate
      privateKey: () => undefined,
      configuredToken: MASTER,
      encKey: await deriveSyncEncryptionKey(kp.privateKey),
    });
    await t.remote.append(event(mid, "e2", 2));
    expect((await relayHolds(mid)).map((e) => e.event_id)).toEqual(["e2"]);
    expect(await t.credentials.getCredential({ serverUrl: syncUrl })).toBe(MASTER);
  });

  it("without the key (raw by design) the transport is raw — and says so", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId, kp } = await registeredDevice();
    const t = createRelayEventTransport({
      syncUrl,
      motebitId: mid,
      deviceId,
      privateKey: () => kp.privateKey,
    });
    expect(t.e2e).toBe(false);
  });
});
