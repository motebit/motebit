/**
 * An ended credential stops holding the sockets it admitted — every door
 * (#776, the sibling doors of #767's rotation).
 *
 * The class: a door ends a key or an identity in the database, so the
 * credential admits no NEW socket, but a socket it had already admitted
 * stayed open until it dropped on its own — receiving sync traffic, acting
 * as the identity, keeping a roster liveness row. `key-retirement-sockets
 * .test.ts` covers the rotation doors (`applySuccession`). This file drives
 * every other door through its REAL route over REAL sockets
 * (`createTestRelay` behind `@hono/node-server`, `ws` clients presenting
 * signed `sync` tokens):
 *
 *  - `POST /api/v1/agents/accept-migration`       — registry + holder key overwritten → 4010
 *  - `POST /agent/:id/task/:taskId/result` heal   — registry fallback moved → 4010
 *  - `POST /pairing/:id/update-key`               — ONE device row's key, per (device, key) → 4010
 *  - `POST /api/v1/agents/:id/revoke`             — identity revoked → 4011
 *  - `POST /api/v1/agents/:id/migrate/depart`     — identity departed (revoked) → 4011
 *  - `POST /api/v1/agents/:id/revoke-listing`     — operator hold (revoked) → 4011
 *  - `POST /api/v1/agents/:id/revoke-tokens`      — a token's jti revoked → 4012
 *
 * plus the verification window: an identity revoked, or a token revoked,
 * while a socket's token is still being verified must not let that socket
 * register afterwards.
 *
 * Each door's call was severed and its test here seen red (recorded in the
 * PR for #776).
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
  canonicalJson,
  deriveSovereignMotebitId,
  ed25519Sign,
  hash as sha256,
  mintAudienceToken,
  signBySuite,
  signCredentialBundle,
  signDeviceRegistration,
  signExecutionReceipt,
  signMigrationRequest,
  toBase64Url,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import {
  API_TOKEN,
  JSON_AUTH,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { readHostLiveness } from "../host-roster-store.js";
import {
  WS_CLOSE_IDENTITY_REVOKED,
  WS_CLOSE_KEY_RETIRED,
  WS_CLOSE_TOKEN_REVOKED,
} from "../websocket.js";

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

async function connect(mid: string, query: string): Promise<Sock> {
  const before = peers(mid).length;
  const sock = openSocket(mid, query);
  await waitFor(() => peers(mid).length > before, "the relay to register the socket");
  return sock;
}

async function closeCodeOf(sock: Sock): Promise<number> {
  return await Promise.race([
    sock.closed,
    new Promise<number>((_, rej) => setTimeout(() => rej(new Error("socket not closed")), 3_000)),
  ]);
}

async function refused(mid: string, query: string): Promise<number> {
  return await closeCodeOf(openSocket(mid, query));
}

async function expectStillOpen(mid: string, sock: Sock): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
  expect(sock.closeCode()).toBeNull();
  expect(sock.ws.readyState).toBe(WebSocket.OPEN);
  expect(peers(mid).some((p) => p.retired !== true)).toBe(true);
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

/** A device linked WITHOUT key transfer: it holds its own key. */
async function registerOwnKeyDevice(mid: string, kp: KeyPair): Promise<string> {
  const res = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id: mid, device_name: "phone", public_key: hex(kp) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { device_id: string }).device_id;
}

/** Register the identity in `agent_registry` under its own device bearer. */
async function registerAgent(mid: string, did: string, kp: KeyPair): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await bearer(mid, did, kp, "admin:query")}`,
    },
    body: JSON.stringify({
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      public_key: hex(kp),
    }),
  });
  expect(res.status).toBe(200);
}

/** A service-mode identity: registry row only, no device row (master token). */
async function registerServiceAgent(mid: string, kp: KeyPair): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      public_key: hex(kp),
    }),
  });
  expect(res.status).toBe(200);
}

/**
 * A registered sovereign identity with two machines: `laptop` under the
 * identity key (a host socket that keeps a roster row) and `phone`, linked
 * without key transfer, under its own key.
 */
async function identityWithTwoMachines() {
  const k1 = await generateKeypair();
  const kd = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(k1));
  await registerSelf(mid, "laptop", k1);
  const phone = await registerOwnKeyDevice(mid, kd);
  await registerAgent(mid, "laptop", k1);
  const laptop = await connect(
    mid,
    `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop&capabilities=unattended_runtime`,
  );
  const phoneSock = await connect(
    mid,
    `token=${await syncToken(mid, phone, kd)}&device_id=${phone}`,
  );
  const master = await connect(mid, `token=${API_TOKEN}&device_id=ops`);
  await waitFor(() => readHostLiveness(relay.moteDb.db, mid).length === 1, "the bind write");
  return { k1, kd, mid, phone, laptop, phoneSock, master };
}

/** Another identity's socket — no door here is about it. */
async function bystander() {
  const k = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(k));
  await registerSelf(mid, "desk", k);
  const sock = await connect(mid, `token=${await syncToken(mid, "desk", k)}&device_id=desk`);
  return { mid, sock };
}

/**
 * The roster row of the laptop was written ONCE at retirement (in place of
 * the close-time write its onClose no longer makes) and never again once
 * the client's close completes.
 */
async function expectOneCloseWrite(mid: string, sock: Sock, boundAt: number): Promise<void> {
  const retiredAt = readHostLiveness(relay.moteDb.db, mid)[0]!.last_seen_at!;
  expect(retiredAt).toBeGreaterThan(boundAt);
  await closeCodeOf(sock);
  await new Promise((r) => setTimeout(r, 50));
  expect(readHostLiveness(relay.moteDb.db, mid)).toEqual([
    expect.objectContaining({ device_id: "laptop", last_seen_at: retiredAt }),
  ]);
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
  vi.restoreAllMocks();
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Revocation doors: every socket of the identity, under any key, 4011 ──

describe("identity revocation closes every socket an identity credential admitted", () => {
  it("/revoke: the laptop (identity key) and the phone (its own key) close 4011; the master-token and another identity's sockets stay; the identity is refused afterwards", async () => {
    const { k1, mid, laptop, phoneSock, master } = await identityWithTwoMachines();
    const other = await bystander();
    const boundAt = readHostLiveness(relay.moteDb.db, mid)[0]!.last_seen_at!;
    await new Promise((r) => setTimeout(r, 5));

    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);

    // Synchronously out of `connections`: only the master-token socket is left.
    expect(peers(mid).map((p) => p.deviceId)).toEqual(["ops"]);
    await expectOneCloseWrite(mid, laptop, boundAt);
    expect(await closeCodeOf(laptop)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await closeCodeOf(phoneSock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    await expectStillOpen(mid, master);
    await expectStillOpen(other.mid, other.sock);
    expect(await refused(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`)).toBe(
      4003,
    );
  });

  it("migration departure: every identity-credential socket closes 4011; master and bystander stay", async () => {
    const { k1, mid, laptop, phoneSock, master } = await identityWithTwoMachines();
    const other = await bystander();
    const request = await signMigrationRequest(
      {
        motebit_id: mid,
        reason: "leaving",
        requested_at: Date.now(),
        suite: "motebit-jcs-ed25519-b64-v1",
      },
      k1.privateKey,
    );
    const init = await relay.app.request(`/api/v1/agents/${mid}/migrate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(request),
    });
    expect(init.status).toBe(200);
    // Migration initiation alone ends nothing.
    await expectStillOpen(mid, laptop);

    const depart = await relay.app.request(`/api/v1/agents/${mid}/migrate/depart`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(depart.status).toBe(200);

    expect(await closeCodeOf(laptop)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await closeCodeOf(phoneSock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    await expectStillOpen(mid, master);
    await expectStillOpen(other.mid, other.sock);
  });

  it("operator revoke-listing: the hold refuses the identity's tokens, so its sockets close 4011; after restore-listing it reconnects", async () => {
    const { k1, mid, laptop, phoneSock, master } = await identityWithTwoMachines();
    const other = await bystander();
    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke-listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(res.status).toBe(200);

    expect(await closeCodeOf(laptop)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await closeCodeOf(phoneSock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    await expectStillOpen(mid, master);
    await expectStillOpen(other.mid, other.sock);

    const restore = await relay.app.request(`/api/v1/agents/${mid}/restore-listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(restore.status).toBe(200);
    await connect(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`);
  });
});

// ── Token revocation: exactly the sockets that token admitted, 4012 ──

describe("/revoke-tokens closes the sockets the revoked token admitted", () => {
  it("the socket under jti A closes 4012; a socket of the same key under jti B stays", async () => {
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    const a = await mintAudienceToken({ mid, did: "laptop", aud: "sync" }, k1.privateKey);
    const b = await mintAudienceToken({ mid, did: "laptop", aud: "sync" }, k1.privateKey);
    const sockA = await connect(mid, `token=${a.token}&device_id=laptop`);
    const sockB = await connect(mid, `token=${b.token}&device_id=laptop`);

    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke-tokens`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ jtis: [a.payload.jti] }),
    });
    expect(res.status).toBe(200);

    expect(await closeCodeOf(sockA)).toBe(WS_CLOSE_TOKEN_REVOKED);
    await expectStillOpen(mid, sockB);
    expect(peers(mid)).toHaveLength(1);
  });
});

// ── Key-moving doors: per (did, key), 4010 ──

describe("pairing's update-key closes per (device, key), not per key (#776 B4)", () => {
  it("the paired device's pre-transfer socket closes 4010; another device whose row holds the SAME claiming key stays open", async () => {
    const ka = await generateKeypair();
    const kd = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(ka));
    await registerSelf(mid, "desktop", ka);
    // A device linked earlier without key transfer, holding its own key kd.
    const phone = await registerOwnKeyDevice(mid, kd);
    const auth = `Bearer ${await bearer(mid, "desktop", ka, "device:auth")}`;
    const init = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: auth },
    });
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    // The claim presents kd too — claim accepts any canonical key.
    const claim = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: hex(kd) }),
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

    const phoneSock = await connect(
      mid,
      `token=${await syncToken(mid, phone, kd)}&device_id=${phone}`,
    );
    const pre = await connect(mid, `token=${await syncToken(mid, mobile, kd)}&device_id=${mobile}`);
    const desktop = await connect(
      mid,
      `token=${await syncToken(mid, "desktop", ka)}&device_id=desktop`,
    );

    const update = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(ka) }),
    });
    expect(update.status).toBe(200);

    expect(await closeCodeOf(pre)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(mid, phoneSock);
    await expectStillOpen(mid, desktop);
    expect(
      peers(mid)
        .map((p) => p.deviceId)
        .sort(),
    ).toEqual(["desktop", phone].sort());
  });
});

describe("accept-migration closes the sockets the overwritten registry key admitted", () => {
  it("a returning identity that rotated elsewhere: the registry-fallback socket under the old key closes 4010; its device-row, master-token and bystander sockets stay; the new key registers", async () => {
    // The source relay, pinned as an active federation peer.
    const sourceKp = await generateKeypair();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
         VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
      )
      .run("src-relay", hex(sourceKp), "http://src", "Src", null, "1.0");

    // The identity was a service-mode agent here under its genesis key.
    const genesis = await generateKeypair();
    const rotated = await generateKeypair();
    const kd = await generateKeypair();
    const sid = await deriveSovereignMotebitId(hex(genesis));
    await registerServiceAgent(sid, genesis);
    // A device of the identity holding its own key — the arrival does not
    // touch device rows, so it still admits this socket.
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("phone", sid, "tok-phone", hex(kd), Date.now());

    const svc = await connect(sid, `token=${await syncToken(sid, "svc", genesis)}&device_id=svc`);
    expect(peers(sid)[0]?.authenticatedUnder).toBe(hex(genesis));
    const phoneSock = await connect(
      sid,
      `token=${await syncToken(sid, "phone", kd)}&device_id=phone`,
    );
    const master = await connect(sid, `token=${API_TOKEN}&device_id=ops`);
    const other = await bystander();

    // It rotated genesis → rotated on the source relay and now returns.
    const HEX = "motebit-jcs-ed25519-hex-v1" as const;
    const rotTs = Date.now() - 24 * 60 * 60 * 1000;
    const rotMsg = new TextEncoder().encode(
      canonicalJson({
        old_public_key: hex(genesis),
        new_public_key: hex(rotated),
        timestamp: rotTs,
        suite: HEX,
      }),
    );
    const succession = [
      {
        old_public_key: hex(genesis),
        new_public_key: hex(rotated),
        timestamp: rotTs,
        suite: HEX,
        old_key_signature: bytesToHex(await signBySuite(HEX, rotMsg, genesis.privateKey)),
        new_key_signature: bytesToHex(await signBySuite(HEX, rotMsg, rotated.privateKey)),
      },
    ];
    const identity_file = {
      spec: "motebit/identity@1.0",
      motebit_id: sid,
      created_at: new Date(rotTs - 24 * 60 * 60 * 1000).toISOString(),
      owner_id: "owner",
      identity: { algorithm: "Ed25519", public_key: hex(rotated) },
      succession,
    };
    const now = Date.now();
    const signSrc = async (b: Record<string, unknown>): Promise<string> =>
      toBase64Url(
        await ed25519Sign(new TextEncoder().encode(canonicalJson(b)), sourceKp.privateKey),
      );
    const tokenBody = {
      token_id: `mig-${now}`,
      motebit_id: sid,
      source_relay_id: "src-relay",
      source_relay_url: "http://src",
      issued_at: now,
      expires_at: now + 72 * 60 * 60 * 1000,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
    };
    const attBody = {
      attestation_id: `att-${now}`,
      motebit_id: sid,
      source_relay_id: "src-relay",
      source_relay_url: "http://src",
      first_seen: now - 1_000_000,
      last_active: now,
      trust_level: "verified",
      successful_tasks: 1,
      failed_tasks: 0,
      credentials_issued: 0,
      balance_at_departure: 0,
      attested_at: now,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
    };
    const bundle = await signCredentialBundle(
      {
        motebit_id: sid,
        exported_at: now,
        credentials: [],
        anchor_proofs: [],
        key_succession: succession,
        suite: "motebit-jcs-ed25519-b64-v1",
      },
      rotated.privateKey,
    );
    const res = await relay.app.request("/api/v1/agents/accept-migration", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        migration_token: { ...tokenBody, signature: await signSrc(tokenBody) },
        departure_attestation: { ...attBody, signature: await signSrc(attBody) },
        credential_bundle: bundle,
        identity_file,
        motebit_id: sid,
        public_key: hex(rotated),
      }),
    });
    expect(res.status).toBe(200);

    expect(await closeCodeOf(svc)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(sid, phoneSock);
    await expectStillOpen(sid, master);
    await expectStillOpen(other.mid, other.sock);
    // The old key admits nothing new through the fallback; the new one does.
    expect(await refused(sid, `token=${await syncToken(sid, "svc", genesis)}&device_id=svc`)).toBe(
      4003,
    );
    await connect(sid, `token=${await syncToken(sid, "svc", rotated)}&device_id=svc`);
  });
});

describe("the receipt heal closes the sockets the moved registry fallback admitted", () => {
  it("a registry-fallback socket under the old registry key closes 4010; a device-row socket under the SAME key stays, as do the paired device's and the master token's", async () => {
    const ownerKp = await generateKeypair();
    const pairedKp = await generateKeypair();
    const ownerPub = hex(ownerKp);
    const pairedPub = hex(pairedKp);
    const owner = await createAgent(relay, ownerPub);
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: owner.motebitId,
        public_key: ownerPub,
        endpoint_url: "http://localhost:1/mcp",
        capabilities: ["web_search"],
      }),
    });
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("paired", owner.motebitId, "tok-paired", pairedPub, Date.now());
    const mid = owner.motebitId;

    // `svc` has no device row: admitted by the registry fallback (ownerPub).
    const fallback = await connect(mid, `token=${await syncToken(mid, "svc", ownerKp)}`);
    // The owner's device row holds the same key: admitted by its row.
    const deviceSock = await connect(
      mid,
      `token=${await syncToken(mid, owner.deviceId, ownerKp)}&device_id=${owner.deviceId}`,
    );
    const pairedSock = await connect(
      mid,
      `token=${await syncToken(mid, "paired", pairedKp)}&device_id=paired`,
    );
    const master = await connect(mid, `token=${API_TOKEN}&device_id=ops`);
    const other = await bystander();

    const taskRes = await relay.app.request(`/agent/${mid}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "heal probe",
        submitted_by: mid,
        target_agent: mid,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id } = (await taskRes.json()) as { task_id: string };
    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id,
        relay_task_id: task_id,
        motebit_id: mid,
        public_key: pairedPub,
        device_id: "paired",
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "ok",
        tools_used: [] as string[],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("heal probe")),
        result_hash: await sha256(enc.encode("ok")),
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      pairedKp.privateKey,
      pairedKp.publicKey,
    );
    const res = await relay.app.request(`/agent/${mid}/task/${task_id}/result`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await bearer(mid, "paired", pairedKp, "task:result")}`,
      },
      body: JSON.stringify(receipt),
    });
    expect(res.status).toBe(200);
    // The heal ran: the registry fallback now answers the paired key.
    expect(
      (
        relay.moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(mid) as { public_key: string }
      ).public_key,
    ).toBe(pairedPub);

    expect(await closeCodeOf(fallback)).toBe(WS_CLOSE_KEY_RETIRED);
    await expectStillOpen(mid, deviceSock);
    await expectStillOpen(mid, pairedSock);
    await expectStillOpen(mid, master);
    await expectStillOpen(other.mid, other.sock);
  });
});

// ── The verification window ──

describe("a revocation that lands WHILE a socket's token is being verified (#776)", () => {
  // The verifier checks revocation and the jti blacklist BEFORE its awaited
  // device-row read; a revocation landing inside that await closes only
  // registered sockets, and this one is not yet. Held deterministically.
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

  function refusalReasons(mid: string): string[] {
    return (
      relay.moteDb.db
        .prepare("SELECT reason FROM relay_auth_events WHERE path = ?")
        .all(`/ws/sync/${mid}`) as Array<{ reason: string }>
    ).map((r) => r.reason);
  }

  it("identity revoked mid-verification: closed 4011, never registered, recorded", async () => {
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    await registerAgent(mid, "laptop", k1);
    const hold = holdAfterRowRead();
    const sock = openSocket(mid, `token=${await syncToken(mid, "laptop", k1)}&device_id=laptop`);
    await waitFor(() => hold.read(), "the socket's device-row read");
    hold.restore();
    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    hold.release();
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(peers(mid)).toEqual([]);
    expect(refusalReasons(mid)).toEqual(["agent_revoked_during_verification"]);
  });

  it("token revoked mid-verification: closed 4012, never registered, recorded", async () => {
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    const minted = await mintAudienceToken({ mid, did: "laptop", aud: "sync" }, k1.privateKey);
    const hold = holdAfterRowRead();
    const sock = openSocket(mid, `token=${minted.token}&device_id=laptop`);
    await waitFor(() => hold.read(), "the socket's device-row read");
    hold.restore();
    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke-tokens`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ jtis: [minted.payload.jti] }),
    });
    expect(res.status).toBe(200);
    hold.release();
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_TOKEN_REVOKED);
    expect(peers(mid)).toEqual([]);
    expect(refusalReasons(mid)).toEqual(["jti_blacklisted_during_verification"]);
  });
});
