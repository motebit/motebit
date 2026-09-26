/**
 * `/revoke` answers from what it RECORDED, for every identity the relay
 * authenticates (#787), and the revocation is terminal (#788).
 *
 * The defect: `/revoke` recorded the revocation only as
 * `agent_registry.revoked = 1`. For an identity with no registry row — one
 * that only called `/devices/register-self` — the UPDATE touched nothing, the
 * route answered 200 `{revoked: true}`, `isAgentRevoked` stayed false, and the
 * identity kept authenticating on HTTP and WebSocket.
 *
 * The fix: `relay_identity_revocations` (identity-revocation.ts), written by
 * `/revoke` for every KNOWN identity (404 otherwise), read by `isAgentRevoked`
 * beside the registry mark, never cleared. The doors that could otherwise
 * clear it or re-shelve the identity — restore-listing, the master-token
 * `/agents/register`, accept-migration — refuse. restore-listing clears only
 * the operator's own hold: not a self-revocation, not a migration departure
 * still in effect.
 *
 * Driven through the REAL routes over REAL sockets (`createTestRelay` behind
 * `@hono/node-server`, `ws` clients presenting signed `sync` tokens), plus a
 * file-backed relay reopened on the same database for the restart case.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  ed25519Sign,
  mintAudienceToken,
  signCredentialBundle,
  signDeviceRegistration,
  signMigrationRequest,
  toBase64Url,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { API_TOKEN, JSON_AUTH, createTestRelay } from "./test-helpers.js";
import { WS_CLOSE_IDENTITY_REVOKED } from "../websocket.js";
import { liftRevocation } from "../identity-revocation.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
let server: ReturnType<typeof serve> | null = null;
let port: number;
const open: WebSocket[] = [];

async function listen(r: SyncRelay): Promise<void> {
  server = serve({ fetch: r.app.fetch, port: 0, hostname: "127.0.0.1" });
  (r.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  const s = server;
  await new Promise<void>((res) => {
    if (s.listening) res();
    else s.once("listening", () => res());
  });
  port = (s.address() as AddressInfo).port;
}

async function stop(): Promise<void> {
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  const s = server;
  server = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
}

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
}

function openSocket(mid: string, query: string): Sock {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?${query}`);
  open.push(ws);
  const closed = new Promise<number>((r) => ws.once("close", (c: number) => r(c)));
  ws.on("error", () => {
    /* surfaced through `closed` */
  });
  return { ws, closed };
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

const token = async (mid: string, did: string, kp: KeyPair, aud: TokenAudience) =>
  (await mintAudienceToken({ mid, did, aud }, kp.privateKey)).token;

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

/** A register-self-only identity: identities + devices rows, NO registry row. */
async function selfOnlyIdentity() {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  await registerSelf(mid, "laptop", kp);
  return { kp, mid };
}

async function registerAgent(mid: string, did: string, kp: KeyPair): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await token(mid, did, kp, "admin:query")}`,
    },
    body: JSON.stringify({
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["summarize"],
      public_key: hex(kp),
    }),
  });
  expect(res.status).toBe(200);
}

/** GET a sync-authenticated route under the identity's own token. */
async function httpStatus(mid: string, kp: KeyPair): Promise<number> {
  const res = await relay.app.request(`/sync/${mid}/clock`, {
    headers: { Authorization: `Bearer ${await token(mid, "laptop", kp, "sync")}` },
  });
  return res.status;
}

async function revokeOwn(mid: string, kp: KeyPair): Promise<Response> {
  return revokeAs(mid, "laptop", kp);
}

/** `/revoke` under the token of device `did` of `mid`, signed by `kp`. */
async function revokeAs(mid: string, did: string, kp: KeyPair): Promise<Response> {
  return relay.app.request(`/api/v1/agents/${mid}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(mid, did, kp, "admin:query")}` },
  });
}

/** What kind of revocation the record holds: absent, terminal or liftable (#794). */
const standing = (mid: string): "none" | "terminal" | "liftable" => {
  const row = relay.moteDb.db
    .prepare("SELECT authoritative FROM relay_identity_revocations WHERE motebit_id = ?")
    .get(mid) as { authoritative: number } | undefined;
  return row === undefined ? "none" : row.authoritative === 1 ? "terminal" : "liftable";
};

async function onShelf(mid: string): Promise<boolean> {
  const res = await relay.app.request(`/api/v1/discover/${mid}`);
  return ((await res.json()) as { found: boolean }).found;
}

async function listed(mid: string): Promise<boolean> {
  const res = await relay.app.request("/api/v1/agents/discover?capability=summarize");
  const body = (await res.json()) as { agents: Array<{ motebit_id: string }> };
  return body.agents.some((a) => a.motebit_id === mid);
}

const hasRecord = (mid: string) =>
  relay.moteDb.db
    .prepare("SELECT 1 FROM relay_identity_revocations WHERE motebit_id = ?")
    .get(mid) !== undefined;

const registryRow = (mid: string) =>
  relay.moteDb.db
    .prepare("SELECT revoked, delisted_at FROM agent_registry WHERE motebit_id = ?")
    .get(mid) as { revoked: number; delisted_at: number | null } | undefined;

// ── Arrival (accept-migration) for a never-rotated sovereign identity. ──

async function pinSourceRelay(): Promise<KeyPair> {
  const sourceKp = await generateKeypair();
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
    )
    .run("src-relay", hex(sourceKp), "http://src", "Src", null, "1.0");
  return sourceKp;
}

async function acceptMigration(mid: string, kp: KeyPair, sourceKp: KeyPair): Promise<Response> {
  const now = Date.now();
  const signSrc = async (b: Record<string, unknown>): Promise<string> =>
    toBase64Url(await ed25519Sign(new TextEncoder().encode(canonicalJson(b)), sourceKp.privateKey));
  const tokenBody = {
    token_id: `mig-${now}-${Math.random()}`,
    motebit_id: mid,
    source_relay_id: "src-relay",
    source_relay_url: "http://src",
    issued_at: now,
    expires_at: now + 72 * 60 * 60 * 1000,
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const attBody = {
    attestation_id: `att-${now}`,
    motebit_id: mid,
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
      motebit_id: mid,
      exported_at: now,
      credentials: [],
      anchor_proofs: [],
      key_succession: [],
      suite: "motebit-jcs-ed25519-b64-v1",
    },
    kp.privateKey,
  );
  return relay.app.request("/api/v1/agents/accept-migration", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      migration_token: { ...tokenBody, signature: await signSrc(tokenBody) },
      departure_attestation: { ...attBody, signature: await signSrc(attBody) },
      credential_bundle: bundle,
      motebit_id: mid,
      public_key: hex(kp),
    }),
  });
}

async function depart(mid: string, kp: KeyPair): Promise<void> {
  const request = await signMigrationRequest(
    {
      motebit_id: mid,
      reason: "leaving",
      requested_at: Date.now(),
      suite: "motebit-jcs-ed25519-b64-v1",
    },
    kp.privateKey,
  );
  const init = await relay.app.request(`/api/v1/agents/${mid}/migrate`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(request),
  });
  expect(init.status).toBe(200);
  const res = await relay.app.request(`/api/v1/agents/${mid}/migrate/depart`, {
    method: "POST",
    headers: JSON_AUTH,
  });
  expect(res.status).toBe(200);
}

const operator = (mid: string, act: "revoke-listing" | "restore-listing") =>
  relay.app.request(`/api/v1/agents/${mid}/${act}`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(act === "revoke-listing" ? { reason: "spam" } : {}),
  });

describe("/revoke for an identity with NO registry row (#787)", () => {
  beforeEach(async () => {
    relay = await createTestRelay();
    await listen(relay);
  });
  afterEach(stop);

  it("records the revocation, refuses its tokens on HTTP and WS, closes its sockets 4011, and never shelves it", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    expect(registryRow(mid)).toBeUndefined();
    expect(await httpStatus(mid, kp)).toBe(200);
    const sock = await connect(
      mid,
      `token=${await token(mid, "laptop", kp, "sync")}&device_id=laptop`,
    );
    const master = await connect(mid, `token=${API_TOKEN}&device_id=ops`);

    const res = await revokeOwn(mid, kp);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);
    expect(hasRecord(mid)).toBe(true);
    // The id is the sovereign commitment to the key the token verified under.
    expect(standing(mid)).toBe("terminal");

    // The socket its token admitted ends; the master token's stays.
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(peers(mid).map((p) => p.deviceId)).toEqual(["ops"]);
    expect(master.ws.readyState).toBe(WebSocket.OPEN);
    // New tokens are refused, HTTP and WS.
    expect(await httpStatus(mid, kp)).toBe(403);
    expect(
      await closeCodeOf(
        openSocket(mid, `token=${await token(mid, "laptop", kp, "sync")}&device_id=laptop`),
      ),
    ).toBe(4003);
    // Its own bearer can no longer register it onto the shelf...
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, "laptop", kp, "admin:query")}`,
      },
      body: JSON.stringify({ endpoint_url: "http://localhost:9999/mcp", capabilities: [] }),
    });
    expect(reg.status).toBe(401);
    // ...nor can the master token.
    const masterReg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["summarize"],
        public_key: hex(kp),
      }),
    });
    expect(masterReg.status).toBe(403);
    expect(registryRow(mid)).toBeUndefined();
    expect(await onShelf(mid)).toBe(false);
    expect(await listed(mid)).toBe(false);
  });

  it("the master token revoking on its behalf does the same", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    const sock = await connect(
      mid,
      `token=${await token(mid, "laptop", kp, "sync")}&device_id=laptop`,
    );
    const res = await relay.app.request(`/api/v1/agents/${mid}/revoke`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    expect(hasRecord(mid)).toBe(true);
    // The operator acting for the identity is authoritative.
    expect(standing(mid)).toBe("terminal");
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await httpStatus(mid, kp)).toBe(403);
  });

  it("an id the relay has never seen is 404, and nothing is recorded", async () => {
    const res = await relay.app.request(`/api/v1/agents/never-seen-mote/revoke`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(404);
    expect(hasRecord("never-seen-mote")).toBe(false);
  });

  it("a revoked identity does not arrive back by migration", async () => {
    const sourceKp = await pinSourceRelay();
    const { kp, mid } = await selfOnlyIdentity();
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    const res = await acceptMigration(mid, kp, sourceKp);
    expect(res.status).toBe(403);
    expect(registryRow(mid)).toBeUndefined();
    expect(await httpStatus(mid, kp)).toBe(403);
  });
});

describe("/revoke for a registered identity is unchanged, and terminal (#788)", () => {
  beforeEach(async () => {
    relay = await createTestRelay();
    await listen(relay);
  });
  afterEach(stop);

  it("marks and delists the row, records the revocation, closes 4011; restore-listing refuses (409) and the tokens stay refused", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    await registerAgent(mid, "laptop", kp);
    expect(await onShelf(mid)).toBe(true);
    const sock = await connect(
      mid,
      `token=${await token(mid, "laptop", kp, "sync")}&device_id=laptop`,
    );

    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect(registryRow(mid)).toEqual({ revoked: 1, delisted_at: expect.any(Number) });
    expect(hasRecord(mid)).toBe(true);
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await onShelf(mid)).toBe(false);

    const restore = await operator(mid, "restore-listing");
    expect(restore.status).toBe(409);
    expect(registryRow(mid)!.revoked).toBe(1);
    expect(await onShelf(mid)).toBe(false);
    expect(await httpStatus(mid, kp)).toBe(403);
  });

  it("restore-listing still reverses the operator's own hold", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    await registerAgent(mid, "laptop", kp);
    expect((await operator(mid, "revoke-listing")).status).toBe(200);
    expect(await httpStatus(mid, kp)).toBe(403);
    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(await onShelf(mid)).toBe(true);
    expect(await httpStatus(mid, kp)).toBe(200);
  });

  it("restore-listing does not reverse a migration departure; the identity arriving back does, and the operator's later hold is reversible again", async () => {
    const sourceKp = await pinSourceRelay();
    const { kp, mid } = await selfOnlyIdentity();
    await registerAgent(mid, "laptop", kp);
    await depart(mid, kp);
    expect(await httpStatus(mid, kp)).toBe(403);

    expect((await operator(mid, "restore-listing")).status).toBe(409);
    expect(registryRow(mid)!.revoked).toBe(1);
    expect(await httpStatus(mid, kp)).toBe(403);

    await new Promise((r) => setTimeout(r, 5));
    expect((await acceptMigration(mid, kp, sourceKp)).status).toBe(200);
    expect(registryRow(mid)!.revoked).toBe(0);
    expect(await httpStatus(mid, kp)).toBe(200);

    expect((await operator(mid, "revoke-listing")).status).toBe(200);
    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(await httpStatus(mid, kp)).toBe(200);
  });
});

/** A device linked by the operator WITHOUT key transfer: it holds its own key. */
async function registerOwnKeyDevice(mid: string, kp: KeyPair): Promise<string> {
  const res = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id: mid, device_name: "phone", public_key: hex(kp) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { device_id: string }).device_id;
}

async function masterRegister(mid: string, publicKey?: string): Promise<number> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["summarize"],
      ...(publicKey != null ? { public_key: publicKey } : {}),
    }),
  });
  return res.status;
}

async function syncStatusAs(mid: string, did: string, kp: KeyPair): Promise<number> {
  const res = await relay.app.request(`/sync/${mid}/clock`, {
    headers: { Authorization: `Bearer ${await token(mid, did, kp, "sync")}` },
  });
  return res.status;
}

describe("terminality follows authority the relay can verify (#794)", () => {
  beforeEach(async () => {
    relay = await createTestRelay();
    await listen(relay);
  });
  afterEach(stop);

  it("a stranger squats a never-seen sovereign id and revokes it: effective at once, but liftable — the owner's verified migration arrival lifts it", async () => {
    const sourceKp = await pinSourceRelay();
    const owner = await generateKeypair();
    const stranger = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(owner));
    await registerSelf(mid, "evil", stranger);

    expect((await revokeAs(mid, "evil", stranger)).status).toBe(200);
    // No false success: the revocation holds at once.
    expect(standing(mid)).toBe("liftable");
    expect(await syncStatusAs(mid, "evil", stranger)).toBe(403);

    // The owner proves the key the id commits to — the arrival is admitted
    // and the unproven revocation ends.
    expect((await acceptMigration(mid, owner, sourceKp)).status).toBe(200);
    expect(standing(mid)).toBe("none");
    expect(registryRow(mid)!.revoked).toBe(0);
    await connect(mid, `token=${await token(mid, "svc", owner, "sync")}&device_id=svc`);
  });

  it("a stranger squats a keyless operator-registered id and revokes it: the operator's restore-listing lifts it, and re-registration is admitted again", async () => {
    const mid = `legacy-${crypto.randomUUID()}`;
    expect(await masterRegister(mid)).toBe(200);
    const stranger = await generateKeypair();
    await registerSelf(mid, "evil", stranger);

    expect((await revokeAs(mid, "evil", stranger)).status).toBe(200);
    expect(standing(mid)).toBe("liftable");
    expect(await syncStatusAs(mid, "evil", stranger)).toBe(403);
    // Registration is not a lifting door.
    expect(await masterRegister(mid)).toBe(409);

    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(standing(mid)).toBe("none");
    expect(await masterRegister(mid)).toBe(200);
    expect(await onShelf(mid)).toBe(true);
  });

  it("a legacy (non-sovereign) id known only through register-self: its revoke holds but is liftable — first-come is not proof — and restore-listing lifts it with no registry row", async () => {
    const kp = await generateKeypair();
    const mid = `legacy-${crypto.randomUUID()}`;
    await registerSelf(mid, "laptop", kp);

    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect(standing(mid)).toBe("liftable");
    expect(await httpStatus(mid, kp)).toBe(403);

    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(standing(mid)).toBe("none");
    expect(await httpStatus(mid, kp)).toBe(200);
  });

  it("a paired device's own key revokes liftably; the owner's key then makes it terminal, and nothing lifts it after", async () => {
    const k1 = await generateKeypair();
    const kd = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    await registerSelf(mid, "laptop", k1);
    await registerAgent(mid, "laptop", k1);
    const phone = await registerOwnKeyDevice(mid, kd);

    expect((await revokeAs(mid, phone, kd)).status).toBe(200);
    expect(standing(mid)).toBe("liftable");
    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(standing(mid)).toBe("none");
    expect(await httpStatus(mid, k1)).toBe(200);

    expect((await revokeAs(mid, phone, kd)).status).toBe(200);
    expect(standing(mid)).toBe("liftable");
    // The owner revokes through the operator (its own tokens are refused
    // now): an authoritative act upgrades the record.
    expect(
      (
        await relay.app.request(`/api/v1/agents/${mid}/revoke`, {
          method: "POST",
          headers: JSON_AUTH,
        })
      ).status,
    ).toBe(200);
    expect(standing(mid)).toBe("terminal");
    expect((await operator(mid, "restore-listing")).status).toBe(409);
    expect(await httpStatus(mid, k1)).toBe(403);
  });

  it("no holder on file: a key the id is the sovereign commitment to revokes terminally; the registry key does too", async () => {
    // A device row with no holder behind it (a legacy link — no evidence was
    // presented), so the binding is what proves the key.
    const plantDevice = (id: string, kp: KeyPair): string => {
      const deviceId = `dev-${crypto.randomUUID()}`;
      relay.moteDb.db
        .prepare(
          "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(deviceId, id, `tok-${deviceId}`, hex(kp), Date.now());
      return deviceId;
    };
    const holderRow = (id: string) =>
      relay.moteDb.db.prepare("SELECT 1 FROM identity_keys WHERE motebit_id = ?").get(id);
    const owner = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(owner));
    const did = plantDevice(mid, owner);
    expect(holderRow(mid)).toBeUndefined();
    expect((await revokeAs(mid, did, owner)).status).toBe(200);
    expect(standing(mid)).toBe("terminal");

    // A legacy id: the registry key is the proven one when there is no holder.
    const svc = await generateKeypair();
    const legacy = `legacy-${crypto.randomUUID()}`;
    const legacyDid = plantDevice(legacy, svc);
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at) VALUES (?, ?, '', 0, 0, 0)",
      )
      .run(legacy, hex(svc));
    expect(holderRow(legacy)).toBeUndefined();
    expect((await revokeAs(legacy, legacyDid, svc)).status).toBe(200);
    expect(standing(legacy)).toBe("terminal");
  });

  it("the lift statement itself cannot touch a terminal record", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect(standing(mid)).toBe("terminal");
    liftRevocation(relay.moteDb.db, mid);
    expect(standing(mid)).toBe("terminal");
  });

  it("with a holder on file, only the holder is proven: a key the id merely commits to (a rotated-away genesis key) revokes liftably", async () => {
    const genesis = await generateKeypair();
    const current = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(genesis));
    const deviceId = `dev-${crypto.randomUUID()}`;
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(deviceId, mid, `tok-${deviceId}`, hex(genesis), Date.now());
    relay.moteDb.db
      .prepare(
        "INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at) VALUES (?, ?, NULL, 'succession', ?, ?)",
      )
      .run(mid, hex(current), Date.now(), Date.now());
    expect((await revokeAs(mid, deviceId, genesis)).status).toBe(200);
    expect(standing(mid)).toBe("liftable");
  });

  it("the owner's own proven-key revoke is terminal: arrival, re-registration and restore-listing all refused", async () => {
    const sourceKp = await pinSourceRelay();
    const { kp, mid } = await selfOnlyIdentity();
    await registerAgent(mid, "laptop", kp);
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect(standing(mid)).toBe("terminal");
    expect((await acceptMigration(mid, kp, sourceKp)).status).toBe(403);
    expect(await masterRegister(mid, hex(kp))).toBe(403);
    expect((await operator(mid, "restore-listing")).status).toBe(409);
    expect(standing(mid)).toBe("terminal");
    expect(await httpStatus(mid, kp)).toBe(403);
  });
});

describe("the revocation survives a restart (#787)", () => {
  afterEach(stop);

  it("a register-self-only identity revoked, the relay reopened on the same database: still refused", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "motebit-revoke-")), "relay.db");
    relay = await createTestRelay({ dbPath });
    await listen(relay);
    const { kp, mid } = await selfOnlyIdentity();
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    await stop();

    relay = await createTestRelay({ dbPath });
    await listen(relay);
    expect(hasRecord(mid)).toBe(true);
    expect(await httpStatus(mid, kp)).toBe(403);
    expect(
      await closeCodeOf(
        openSocket(mid, `token=${await token(mid, "laptop", kp, "sync")}&device_id=laptop`),
      ),
    ).toBe(4003);
  });
});
