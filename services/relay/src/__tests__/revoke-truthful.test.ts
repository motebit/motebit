/**
 * `/revoke` answers from what it RECORDED, for every identity the relay
 * authenticates (#787) — and no record is terminal (#794/#796 withdrawn).
 *
 * The defect: `/revoke` recorded the revocation only as
 * `agent_registry.revoked = 1`. For an identity with no registry row — one
 * that only called `/devices/register-self` — the UPDATE touched nothing, the
 * route answered 200 `{revoked: true}`, `isAgentRevoked` stayed false, and the
 * identity kept authenticating on HTTP and WebSocket.
 *
 * The fix: `relay_identity_revocations` (identity-revocation.ts), written by
 * `/revoke` for every KNOWN identity (404 otherwise), read by `isAgentRevoked`
 * beside the registry mark. Two builds made some records TERMINAL and were
 * withdrawn: terminality derived from the revoking KEY let a stranger (a
 * first-come squat, a squat that also wrote the registry key, a thief holding
 * a genesis key the owner rotated away from elsewhere) end the owner forever.
 * So every record is lifted by the owner's verified migration arrival or by
 * the operator's restore-listing; the master-token `/agents/register` refuses
 * (409) and never lifts. restore-listing still refuses while a migration
 * departure is in effect (#788's departure half); an operator reinstate CAN
 * reverse a self-revocation (#788's other half, left open).
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
  signBySuite,
  signMigrationRequest,
  toBase64Url,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { API_TOKEN, JSON_AUTH, createTestRelay } from "./test-helpers.js";
import { WS_CLOSE_IDENTITY_REVOKED } from "../websocket.js";

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

async function acceptMigration(
  mid: string,
  kp: KeyPair,
  sourceKp: KeyPair,
  succession: unknown[] = [],
  identityFile?: unknown,
): Promise<Response> {
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
      key_succession: succession as never,
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
      ...(identityFile != null ? { identity_file: identityFile } : {}),
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

/** A genesis → current succession, signed by both, and the identity file carrying it. */
async function rotatedChain(genesis: KeyPair, current: KeyPair, mid: string) {
  const HEX = "motebit-jcs-ed25519-hex-v1" as const;
  const ts = Date.now() - 30 * 86_400_000;
  const link = {
    old_public_key: hex(genesis),
    new_public_key: hex(current),
    timestamp: ts,
    suite: HEX,
  };
  const msg = new TextEncoder().encode(canonicalJson(link));
  const succession = [
    {
      ...link,
      old_key_signature: bytesToHex(await signBySuite(HEX, msg, genesis.privateKey)),
      new_key_signature: bytesToHex(await signBySuite(HEX, msg, current.privateKey)),
    },
  ];
  const identityFile = {
    spec: "motebit/identity@1.0",
    motebit_id: mid,
    created_at: new Date(ts - 86_400_000).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: hex(current) },
    succession,
  };
  return { succession, identityFile };
}

/** Register in the registry under the caller's own device bearer. */
async function tokenRegister(mid: string, did: string, kp: KeyPair): Promise<number> {
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
  return res.status;
}

const authEvents = (reason: string) =>
  relay.moteDb.db
    .prepare("SELECT COUNT(*) AS n FROM relay_auth_events WHERE reason = ?")
    .get(reason) as { n: number };

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
    // Its own bearer cannot register it onto the shelf, nor can the master
    // token — registration never lifts a revocation (409, recorded).
    expect(await tokenRegister(mid, "laptop", kp)).toBe(401);
    expect(await masterRegister(mid, hex(kp))).toBe(409);
    expect(authEvents("register:identity_revoked").n).toBe(1);
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
    expect(await closeCodeOf(sock)).toBe(WS_CLOSE_IDENTITY_REVOKED);
    expect(await httpStatus(mid, kp)).toBe(403);
  });

  it("an id the relay has never seen is 404, recorded, and nothing is written", async () => {
    const res = await relay.app.request(`/api/v1/agents/never-seen-mote/revoke`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(404);
    expect(hasRecord("never-seen-mote")).toBe(false);
    expect(authEvents("revoke:unknown_identity").n).toBe(1);
  });

  it("another identity's token is refused (403) and recorded", async () => {
    const a = await selfOnlyIdentity();
    const bKp = await generateKeypair();
    const b = { mid: await deriveSovereignMotebitId(hex(bKp)) };
    await registerSelf(b.mid, "desk", bKp);
    const res = await relay.app.request(`/api/v1/agents/${b.mid}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token(a.mid, "laptop", a.kp, "admin:query")}` },
    });
    expect(res.status).toBe(403);
    expect(hasRecord(b.mid)).toBe(false);
    expect(authEvents("revoke:not_own_identity").n).toBe(1);
  });
});

describe("no record is terminal: the owner's verified arrival or the operator lifts it", () => {
  beforeEach(async () => {
    relay = await createTestRelay();
    await listen(relay);
  });
  afterEach(stop);

  it("a register-self-only identity's own revoke: the owner's verified migration arrival lifts it", async () => {
    const sourceKp = await pinSourceRelay();
    const { kp, mid } = await selfOnlyIdentity();
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect((await acceptMigration(mid, kp, sourceKp)).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(await httpStatus(mid, kp)).toBe(200);
  });

  it("restore-listing lifts a record with NO registry row; re-registration is 409 before and admitted after", async () => {
    const { kp, mid } = await selfOnlyIdentity();
    expect((await revokeOwn(mid, kp)).status).toBe(200);
    expect(await masterRegister(mid, hex(kp))).toBe(409);
    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(await httpStatus(mid, kp)).toBe(200);
    expect(await masterRegister(mid, hex(kp))).toBe(200);
  });

  it("a registered identity: /revoke marks and delists the row and records; restore-listing lifts both", async () => {
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

    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(registryRow(mid)!.revoked).toBe(0);
    expect(await httpStatus(mid, kp)).toBe(200);
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

describe("the three withdrawn attacks (#794, #796) are all lifted by the owner's verified arrival", () => {
  beforeEach(async () => {
    relay = await createTestRelay();
    await listen(relay);
  });
  afterEach(stop);

  it("first-come squat: a stranger registers a device under a never-seen sovereign id and revokes it", async () => {
    const sourceKp = await pinSourceRelay();
    const owner = await generateKeypair();
    const stranger = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(owner));
    await registerSelf(mid, "evil", stranger);
    expect((await revokeAs(mid, "evil", stranger)).status).toBe(200);
    expect(await syncStatusAs(mid, "evil", stranger)).toBe(403);

    expect((await acceptMigration(mid, owner, sourceKp)).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(registryRow(mid)!.revoked).toBe(0);
    await connect(mid, `token=${await token(mid, "svc", owner, "sync")}&device_id=svc`);
  });

  it("registry-key squat: the stranger also registers itself (its key in the registry) before revoking", async () => {
    const sourceKp = await pinSourceRelay();
    const owner = await generateKeypair();
    const stranger = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(owner));
    await registerSelf(mid, "evil", stranger);
    expect(await tokenRegister(mid, "evil", stranger)).toBe(200);
    expect((await revokeAs(mid, "evil", stranger)).status).toBe(200);
    expect(await syncStatusAs(mid, "evil", stranger)).toBe(403);

    expect((await acceptMigration(mid, owner, sourceKp)).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(registryRow(mid)!.revoked).toBe(0);
    await connect(mid, `token=${await token(mid, "svc", owner, "sync")}&device_id=svc`);
  });

  for (const withRegistry of [false, true]) {
    it(`retired genesis key: a thief holding the key the owner rotated away from elsewhere revokes (registry=${String(withRegistry)})`, async () => {
      const sourceKp = await pinSourceRelay();
      const genesis = await generateKeypair();
      const current = await generateKeypair();
      const mid = await deriveSovereignMotebitId(hex(genesis));
      const { succession, identityFile } = await rotatedChain(genesis, current, mid);
      await registerSelf(mid, "thief", genesis);
      if (withRegistry) expect(await tokenRegister(mid, "thief", genesis)).toBe(200);
      expect((await revokeAs(mid, "thief", genesis)).status).toBe(200);
      expect(await syncStatusAs(mid, "thief", genesis)).toBe(403);

      // The owner arrives under the CURRENT key, proving the chain.
      expect((await acceptMigration(mid, current, sourceKp, succession, identityFile)).status).toBe(
        200,
      );
      expect(hasRecord(mid)).toBe(false);
      await connect(mid, `token=${await token(mid, "svc", current, "sync")}&device_id=svc`);
    });
  }

  it("a keyless operator-registered id squatted and revoked: the operator's restore-listing lifts it", async () => {
    const mid = `legacy-${crypto.randomUUID()}`;
    expect(await masterRegister(mid)).toBe(200);
    const stranger = await generateKeypair();
    await registerSelf(mid, "evil", stranger);
    expect((await revokeAs(mid, "evil", stranger)).status).toBe(200);
    expect(await masterRegister(mid)).toBe(409);
    expect((await operator(mid, "restore-listing")).status).toBe(200);
    expect(hasRecord(mid)).toBe(false);
    expect(await masterRegister(mid)).toBe(200);
    expect(await onShelf(mid)).toBe(true);
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
