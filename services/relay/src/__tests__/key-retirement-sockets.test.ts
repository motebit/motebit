/**
 * A retired key stops holding the sockets it admitted (#767).
 *
 * Rotation rewrites the device rows holding the old key (`applySuccession`),
 * so the old key admits no NEW socket. Before #767 a socket it had already
 * admitted stayed open: it kept receiving sync traffic, and — with the
 * roster relay live — kept a liveness row `(device_id, bound_under = K_old)`
 * beside that machine's superseded roster line.
 *
 * Every door that retires a key a socket can have been admitted under is
 * driven here through its REAL route over a REAL socket (`createTestRelay`
 * behind `@hono/node-server`, `ws` clients presenting signed `sync` tokens):
 *
 *  - `POST /api/v1/agents/:id/rotate-key`          (applySuccession)
 *  - `POST /api/v1/agents/register` with succession (applySuccession)
 *  - `POST /pairing/:id/update-key`                 (the claiming key)
 *
 * plus the verification race: a rotation that lands while a socket's token
 * is still being verified must not let that socket register afterwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IdentityManager } from "@motebit/core-identity";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  mintAudienceToken,
  signDeviceRegistration,
  signKeySuccession,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { API_TOKEN, JSON_AUTH, createTestRelay } from "./test-helpers.js";
import { readHostLiveness } from "../host-roster-store.js";
import { WS_CLOSE_KEY_RETIRED } from "../websocket.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
const open: WebSocket[] = [];

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const peers = (mid: string) => relay.connections.get(mid) ?? [];

interface Sock {
  ws: WebSocket;
  /** Resolves with the close code the client saw. */
  closed: Promise<number>;
  closeCode: () => number | null;
}

function openSocket(mid: string, query: string): Sock {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?${query}`);
  open.push(ws);
  let code: number | null = null;
  const closed = new Promise<number>((r) =>
    ws.once("close", (c: number) => {
      code = c;
      r(c);
    }),
  );
  ws.on("error", () => {
    /* surfaced through `closed` */
  });
  return { ws, closed, closeCode: () => code };
}

/** Open a socket and wait until the relay has registered it. */
async function connect(mid: string, query: string): Promise<Sock> {
  const before = peers(mid).length;
  const sock = openSocket(mid, query);
  await waitFor(() => peers(mid).length > before, "the relay to register the socket");
  return sock;
}

/** The code the socket was closed with — failing fast when it is not closed. */
async function closeCodeOf(sock: Sock): Promise<number> {
  return await Promise.race([
    sock.closed,
    new Promise<number>((_, rej) => setTimeout(() => rej(new Error("socket not closed")), 3_000)),
  ]);
}

/** Open a socket and wait for the relay to close it; returns the code. */
async function refused(mid: string, query: string): Promise<number> {
  return await closeCodeOf(openSocket(mid, query));
}

const syncToken = async (mid: string, did: string, kp: KeyPair) =>
  (await mintAudienceToken({ mid, did, aud: "sync" }, kp.privateKey)).token;

async function bearer(mid: string, did: string, kp: KeyPair, aud: TokenAudience) {
  return (await mintAudienceToken({ mid, did, aud }, kp.privateKey)).token;
}

async function registerSelf(mid: string, deviceId: string, kp: KeyPair): Promise<void> {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: deviceId,
      public_key: hex(kp),
      device_name: "t",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
}

/** A device linked WITHOUT key transfer: it holds its own key, K_d. */
async function registerOwnKeyDevice(mid: string, kp: KeyPair): Promise<string> {
  const res = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id: mid, device_name: "phone", public_key: hex(kp) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { device_id: string }).device_id;
}

async function rotateKey(mid: string, did: string, from: KeyPair, to: KeyPair): Promise<void> {
  const record = await signKeySuccession(
    from.privateKey,
    to.privateKey,
    to.publicKey,
    from.publicKey,
  );
  const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await bearer(mid, did, from, "rotate-key")}`,
    },
    body: JSON.stringify(record),
  });
  expect(res.status).toBe(200);
}

/** Give it a moment, then assert the socket is still open on both ends. */
async function expectStillOpen(mid: string, sock: Sock): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
  expect(sock.closeCode()).toBeNull();
  expect(sock.ws.readyState).toBe(WebSocket.OPEN);
  expect(peers(mid).length).toBeGreaterThan(0);
}

beforeEach(async () => {
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("rotate-key closes exactly the sockets the retired key admitted", () => {
  it("K_old sockets close with 4010; a K_d device socket and a master-token socket stay; K_old is refused 4003 afterwards and K_new registers", async () => {
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const kd = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    const phone = await registerOwnKeyDevice(mid, kd);

    // A: a host socket under K_old, device id proven — it has a roster row.
    const a = await connect(
      mid,
      `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop&capabilities=unattended_runtime`,
    );
    // A2: also under K_old, but its device id is undeclared, so it has no
    // `boundUnder` — it was admitted by K_old all the same.
    const a2 = await connect(mid, `token=${await syncToken(mid, "laptop", k1)}`);
    // B: the phone, under its own key K_d — rotation is not about it.
    const b = await connect(mid, `token=${await syncToken(mid, phone, kd)}&device_id=${phone}`);
    // C: the master token — admitted by no identity key.
    const c = await connect(mid, `token=${API_TOKEN}&device_id=ops`);
    await waitFor(() => readHostLiveness(relay.moteDb.db, mid).length === 1, "the bind write");
    const boundAt = readHostLiveness(relay.moteDb.db, mid)[0]!.last_seen_at!;
    await new Promise((r) => setTimeout(r, 5));

    await rotateKey(mid, "laptop", k1, k2);

    expect(await closeCodeOf(a)).toBe(WS_CLOSE_KEY_RETIRED);
    expect(await closeCodeOf(a2)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(mid, b);
    await expectStillOpen(mid, c);
    await waitFor(() => peers(mid).length === 2, "the relay to drop the retired sockets");
    expect(
      peers(mid)
        .map((p) => p.deviceId)
        .sort(),
    ).toEqual(["ops", phone].sort());

    // The close went through onClose → onPeerClosed: last_seen_at written,
    // still under the key the socket was bound under.
    await waitFor(
      () => (readHostLiveness(relay.moteDb.db, mid)[0]?.last_seen_at ?? 0) > boundAt,
      "the close write",
    );
    expect(readHostLiveness(relay.moteDb.db, mid)).toEqual([
      expect.objectContaining({ device_id: "laptop", bound_under: hex(k1) }),
    ]);

    // The retired key admits nothing new; the new one does.
    expect(await refused(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`)).toBe(
      4003,
    );
    await connect(mid, `token=${await syncToken(mid, "laptop", k2)}&device_id=laptop`);
    expect(peers(mid).find((p) => p.deviceId === "laptop")?.authenticatedUnder).toBe(hex(k2));
  });

  it("a service-mode socket (agent-registry fallback, no device row) under K_old closes too", async () => {
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(k1),
      }),
    });
    expect(reg.status).toBe(200);
    const svc = await connect(mid, `token=${await syncToken(mid, "svc", k1)}&device_id=svc`);
    expect(peers(mid)[0]?.authenticatedUnder).toBe(hex(k1));

    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    expect(await closeCodeOf(svc)).toBe(WS_CLOSE_KEY_RETIRED);
  });
});

describe("the register door's succession path closes them too", () => {
  it("/agents/register with a succession record closes K_old sockets and leaves K_d", async () => {
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const kd = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    const phone = await registerOwnKeyDevice(mid, kd);
    const first = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await bearer(mid, "laptop", k1, "admin:query")}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(k1),
      }),
    });
    expect(first.status).toBe(200);

    const a = await connect(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`);
    const b = await connect(mid, `token=${await syncToken(mid, phone, kd)}&device_id=${phone}`);

    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await bearer(mid, "laptop", k1, "admin:query")}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(k2),
        succession: record,
      }),
    });
    expect(res.status).toBe(200);

    expect(await closeCodeOf(a)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(mid, b);
  });
});

describe("pairing's update-key closes the sockets the claiming key admitted", () => {
  it("the paired device's pre-transfer socket closes with 4010; the approving device's stays", async () => {
    const ka = await generateKeypair();
    const kb = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(ka));
    await registerSelf(mid, "desktop", ka);
    const auth = `Bearer ${await bearer(mid, "desktop", ka, "device:auth")}`;
    const init = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: auth },
    });
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    const claim = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: hex(kb) }),
    });
    expect(claim.status).toBe(200);
    const approve = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: { Authorization: auth, ...JSON_HEADERS },
      body: JSON.stringify({
        key_transfer: {
          x25519_pubkey: "a".repeat(64),
          encrypted_seed: "c".repeat(96),
          nonce: "d".repeat(24),
          tag: "e".repeat(32),
          identity_pubkey_check: hex(ka),
        },
      }),
    });
    expect(approve.status).toBe(200);
    const mobile = ((await approve.json()) as { device_id: string }).device_id;

    const desktop = await connect(
      mid,
      `token=${await syncToken(mid, "desktop", ka)}&device_id=desktop`,
    );
    const pre = await connect(mid, `token=${await syncToken(mid, mobile, kb)}&device_id=${mobile}`);

    const update = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(ka) }),
    });
    expect(update.status).toBe(200);

    expect(await closeCodeOf(pre)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(mid, desktop);
    // The paired device now authenticates under the transferred key.
    await connect(mid, `token=${await syncToken(mid, mobile, ka)}&device_id=${mobile}`);
  });
});

describe("a rotation that lands WHILE a socket's token is being verified (#767)", () => {
  // The verifier has already read the device row (K_old) and is awaiting the
  // signature check when the rotation applies; the socket is not registered
  // yet, so the close pass cannot see it. Held deterministically: the
  // device-row read completes, THEN waits on a gate.
  function holdAfterRowRead() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let read = false;
    const original = IdentityManager.prototype.loadDeviceById;
    const spy = vi
      .spyOn(IdentityManager.prototype, "loadDeviceById")
      .mockImplementation(async function (this: IdentityManager, ...args) {
        const row = await original.apply(this, args);
        read = true;
        await gate;
        return row;
      });
    return { release, read: () => read, restore: () => spy.mockRestore() };
  }

  async function setup() {
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    return { k1, k2, mid };
  }

  it("query-token path: the socket is closed 4010 and never registered", async () => {
    const { k1, k2, mid } = await setup();
    // The rotate-key route verifies its own bearer through the same
    // device-row read, so the hold is lifted (for new calls) as soon as the
    // socket's read is caught; the socket's call stays parked on the gate.
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const rotateBearer = await bearer(mid, "laptop", k1, "rotate-key");
    const hold = holdAfterRowRead();
    const sock = openSocket(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`);
    await waitFor(() => hold.read(), "the socket's device-row read");
    hold.restore(); // the route's own read must not be held
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${rotateBearer}` },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    hold.release();
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_KEY_RETIRED);
    expect(peers(mid)).toEqual([]);
  });

  it("auth-frame path: auth_result is refused and the socket closed 4010, never registered", async () => {
    const { k1, k2, mid } = await setup();
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const rotateBearer = await bearer(mid, "laptop", k1, "rotate-key");
    const sock = openSocket(mid, `device_id=laptop`);
    await new Promise<void>((r) => sock.ws.once("open", () => r()));
    const frames: Array<{ type: string; ok?: boolean }> = [];
    sock.ws.on("message", (d: Buffer) =>
      frames.push(JSON.parse(d.toString("utf8")) as { type: string; ok?: boolean }),
    );
    const hold = holdAfterRowRead();
    sock.ws.send(JSON.stringify({ type: "auth", token: await syncToken(mid, "laptop", k1) }));
    await waitFor(() => hold.read(), "the socket's device-row read");
    hold.restore();
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${rotateBearer}` },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    hold.release();
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_KEY_RETIRED);
    expect(frames.find((f) => f.type === "auth_result")?.ok).toBe(false);
    expect(peers(mid)).toEqual([]);
  });
});
