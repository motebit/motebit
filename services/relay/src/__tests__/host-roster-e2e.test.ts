/**
 * The machine roster's liveness, end to end over a REAL WebSocket.
 *
 * `createTestRelay` behind `@hono/node-server` with `injectWebSocket`, and a
 * `ws` client presenting real signed `sync` tokens — so the whole path is
 * exercised as deployed: the route's verification, `onVerified` capturing
 * `bound_under`, `onPeerBound` / `onPeerClosed` wired in `index.ts`,
 * `observeHostConnection`, and GET's join over `connections`.
 * (docs/proposals/machine-roster-relay-v1.md D4/D6.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IdentityManager } from "@motebit/core-identity";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { API_TOKEN, createTestRelay } from "./test-helpers.js";
import { readHostLiveness } from "../host-roster-store.js";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
let owner: KeyPair;
let pub: string;
let motebitId: string;
const open: WebSocket[] = [];

type Liveness = {
  rows: Array<{
    device_id: string;
    bound_under: string;
    last_seen_at: number | null;
    sockets_open: number;
    host_sockets_open: number;
  }>;
  live_unenrolled: Array<{
    device_id: string;
    bound_under: string;
    sockets_open: number;
    host_sockets_open: number;
  }>;
};

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function bootstrap(deviceId: string, kp: KeyPair) {
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      motebit_id: motebitId,
      device_id: deviceId,
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  expect(res.status).toBeLessThan(300);
}

const syncToken = async (did: string, kp: KeyPair) =>
  (await mintAudienceToken({ mid: motebitId, did, aud: "sync" }, kp.privateKey)).token;

/** Open a real socket and wait until the relay has finalized (or refused) it. */
async function connect(query: string): Promise<WebSocket> {
  const before = relay.connections.get(motebitId)?.length ?? 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${motebitId}?${query}`);
  open.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await waitFor(
    () => (relay.connections.get(motebitId)?.length ?? 0) > before,
    "the relay to finalize the socket",
  );
  return ws;
}

async function close(ws: WebSocket): Promise<void> {
  const before = relay.connections.get(motebitId)?.length ?? 0;
  ws.close();
  await waitFor(
    () => (relay.connections.get(motebitId)?.length ?? 0) < before,
    "the relay to drop the socket",
  );
}

async function liveness(): Promise<Liveness> {
  const { token } = await mintAudienceToken(
    { mid: motebitId, did: "laptop", aud: "device:auth" },
    owner.privateKey,
  );
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/roster`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { liveness: Liveness }).liveness;
}

const persisted = () => readHostLiveness(relay.moteDb.db, motebitId);

beforeEach(async () => {
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  owner = await generateKeypair();
  pub = bytesToHex(owner.publicKey);
  motebitId = crypto.randomUUID();
  await bootstrap("laptop", owner);
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("liveness over a real socket", () => {
  it("a HOST socket whose token proves its device id is persisted at bind, bound under its key", async () => {
    await connect(
      `token=${await syncToken("laptop", owner)}&device_id=laptop&capabilities=unattended_runtime`,
    );
    await waitFor(() => persisted().length === 1, "the bind write");
    expect(persisted()[0]).toMatchObject({ device_id: "laptop", bound_under: pub });
    const live = await liveness();
    expect(live.rows).toEqual([
      expect.objectContaining({
        device_id: "laptop",
        bound_under: pub,
        sockets_open: 1,
        host_sockets_open: 1,
      }),
    ]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("a NON-host socket persists nothing and is shown only live, in live_unenrolled", async () => {
    await connect(`token=${await syncToken("laptop", owner)}&device_id=laptop`);
    const live = await liveness();
    expect(persisted()).toEqual([]);
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([
      { device_id: "laptop", bound_under: pub, sockets_open: 1, host_sockets_open: 0 },
    ]);
  });

  it("a socket whose token's did is NOT its declared device_id is omitted and persists nothing", async () => {
    await bootstrap("vps", owner);
    await connect(
      `token=${await syncToken("laptop", owner)}&device_id=vps&capabilities=unattended_runtime`,
    );
    const live = await liveness();
    expect(persisted()).toEqual([]);
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("a MASTER-token socket is omitted and persists nothing", async () => {
    await connect(`token=${API_TOKEN}&device_id=laptop&capabilities=unattended_runtime`);
    const live = await liveness();
    expect(persisted()).toEqual([]);
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("a LATE capabilities_announce of unattended_runtime persists the row", async () => {
    const ws = await connect(`token=${await syncToken("laptop", owner)}&device_id=laptop`);
    expect(persisted()).toEqual([]);
    ws.send(
      JSON.stringify({ type: "capabilities_announce", capabilities: ["unattended_runtime"] }),
    );
    await waitFor(() => persisted().length === 1, "the announce write");
    expect(persisted()[0]).toMatchObject({ device_id: "laptop", bound_under: pub });
  });

  it("device row rewritten to K2 under an open socket: it stays (laptop, K1), no K2 row, and close updates last_seen_at", async () => {
    const k2 = await generateKeypair();
    const ws = await connect(
      `token=${await syncToken("laptop", owner)}&device_id=laptop&capabilities=unattended_runtime`,
    );
    await waitFor(() => persisted().length === 1, "the bind write");
    const boundAt = persisted()[0]!.last_seen_at;

    // The row rewrite alone (direct SQL): what `applySuccession` does to the
    // rows. Its socket close (#767) is not in play here — this isolates the
    // capture, which must hold for the whole of a close handshake.
    relay.moteDb.db
      .prepare("UPDATE devices SET public_key = ? WHERE motebit_id = ?")
      .run(bytesToHex(k2.publicKey), motebitId);
    // GET is read by the rotated laptop now, under K2.
    const { token } = await mintAudienceToken(
      { mid: motebitId, did: "laptop", aud: "device:auth" },
      k2.privateKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/roster`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const live = ((await res.json()) as { liveness: Liveness }).liveness;
    expect(live.rows).toEqual([
      expect.objectContaining({
        device_id: "laptop",
        bound_under: pub,
        sockets_open: 1,
        host_sockets_open: 1,
      }),
    ]);
    expect(live.rows.some((r) => r.bound_under === bytesToHex(k2.publicKey))).toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    await close(ws);
    await waitFor(() => (persisted()[0]?.last_seen_at ?? 0) > boundAt, "the close write");
    expect(persisted()).toEqual([
      expect.objectContaining({ device_id: "laptop", bound_under: pub }),
    ]);
  });
});

describe("a socket that closes WHILE its token is being verified is never registered (#769 round 2, A1)", () => {
  // The race: onClose runs during the verification await, finds no peer,
  // and does nothing; finalizeConnection then used to push the CLOSED
  // socket into `connections` and write last_seen_at — served as open,
  // refreshed by every flush, and shielding its row from the sweep until
  // restart. Made deterministic by holding the device-row lookup inside
  // verification until the client's close has been processed.
  function holdVerification() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const original = IdentityManager.prototype.loadDeviceById;
    const spy = vi
      .spyOn(IdentityManager.prototype, "loadDeviceById")
      .mockImplementation(async function (this: IdentityManager, ...args) {
        entered = true;
        await gate;
        return original.apply(this, args);
      });
    return { release, entered: () => entered, restore: () => spy.mockRestore() };
  }

  async function terminateAndRelease(ws: WebSocket, hold: ReturnType<typeof holdVerification>) {
    await waitFor(() => hold.entered(), "verification to start");
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    ws.terminate();
    await closed;
    await new Promise((r) => setTimeout(r, 50)); // the relay's onClose runs
    hold.release();
    await new Promise((r) => setTimeout(r, 50)); // verification completes
    hold.restore();
  }

  async function expectNothingRegistered() {
    expect(relay.connections.get(motebitId) ?? []).toEqual([]);
    expect(persisted()).toEqual([]);
    const live = await liveness();
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([]);
  }

  it("query-token path", async () => {
    const hold = holdVerification();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${motebitId}?token=${await syncToken("laptop", owner)}&device_id=laptop&capabilities=unattended_runtime`,
    );
    open.push(ws);
    await terminateAndRelease(ws, hold);
    await expectNothingRegistered();
  });

  it("auth-frame path", async () => {
    const hold = holdVerification();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${motebitId}?device_id=laptop&capabilities=unattended_runtime`,
    );
    open.push(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "auth", token: await syncToken("laptop", owner) }));
    await terminateAndRelease(ws, hold);
    await expectNothingRegistered();
  });
});
