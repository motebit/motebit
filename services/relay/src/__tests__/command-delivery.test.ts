/**
 * First-wins command delivery, over REAL sockets (issue #691).
 *
 * `command-route.test.ts` proves which peer the relay CHOSE with doubles
 * that record a payload. What it cannot prove is the round trip: that the
 * socket handler hands an answer to the route with the motebit it arrived
 * on, that a socket leaving settles the request it was holding, and that a
 * relay keeps its own deadline. Those facts live in the composition of
 * `websocket.ts`, `index.ts` and `command-route.ts`, so this file drives
 * `createTestRelay` behind `@hono/node-server` with `ws` clients presenting
 * signed `sync` tokens, and posts signed commands to the real route.
 *
 *  1. Delivery prefers the NEWEST open socket (verified peers first), and
 *     never falls through to another socket of the machine on silence (the
 *     envelope is single-use per machine; see `sendToOne`).
 *  4. A socket that closes — or is retired — after delivery gets a short
 *     close grace: its device's reconnect may still answer (the daemon
 *     replies on whatever socket is current). Without one, the request
 *     settles as `outcome: "closed_after_delivery"` after the grace, not
 *     the deadline — still a 504 ("delivered, no answer"). A socket that was
 *     NOT delivered to settles nothing; a relay's `close()` settles all.
 *  5. Two relays in one process each honour their own deadline.
 *  6. An answer carrying the right command id from ANOTHER motebit's
 *     socket, or from another DEVICE of the same motebit, settles nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  mintAudienceToken,
  signAgentCommandEnvelope,
  signDeviceRegistration,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
import { API_TOKEN, JSON_AUTH, createTestRelay } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

interface Stack {
  relay: SyncRelay;
  server: ReturnType<typeof serve>;
  port: number;
  /** Set when a test closed the relay itself. */
  relayClosed?: boolean;
}

const stacks: Stack[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of stacks.splice(0)) {
    if (s.relayClosed !== true) await s.relay.close();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

async function startRelay(overrides?: Partial<SyncRelayConfig>): Promise<Stack> {
  const relay = await createTestRelay(overrides);
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  const stack = { relay, server, port: (server.address() as AddressInfo).port };
  stacks.push(stack);
  return stack;
}

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Identity {
  mid: string;
  kp: KeyPair;
  /** Device ids are unique relay-wide, so each identity names its own. */
  did: string;
}

/** A sovereign identity with one device row and a registry key. */
async function identity(s: Stack): Promise<Identity> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const did = `laptop-${crypto.randomUUID().slice(0, 8)}`;
  const reg = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: did,
      public_key: hex(kp),
      device_name: "t",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const r1 = await s.relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(reg),
  });
  expect(r1.status).toBe(201);
  const bearer = (await mintAudienceToken({ mid, did, aud: "admin:query" }, kp.privateKey)).token;
  const r2 = await s.relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      public_key: hex(kp),
    }),
  });
  expect(r2.status).toBe(200);
  return { mid, kp, did };
}

interface Frame {
  type: string;
  id?: string;
  command?: string;
}

interface Sock {
  ws: WebSocket;
  jti: string;
  frames: Frame[];
  commands: () => Frame[];
  answer: (id: string, result: unknown, extra?: Record<string, unknown>) => void;
}

/** A daemon socket for the identity's machine, registered with the relay before returning. */
async function daemon(
  s: Stack,
  who: Identity,
  // The token that admits the socket. Default: a `sync` token whose `did` IS
  // the declared device id, so the socket is VERIFIED. Pass another to make
  // it declared-only (a token for another device, or the master token).
  as?: { token: string; jti?: string; deviceId?: string },
): Promise<Sock> {
  const minted =
    as == null
      ? await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey)
      : null;
  const token = as?.token ?? minted!.token;
  const before = s.relay.connections.get(who.mid)?.length ?? 0;
  const ws = new WebSocket(
    `ws://127.0.0.1:${s.port}/ws/sync/${who.mid}?token=${token}&device_id=${as?.deviceId ?? who.did}&capabilities=unattended_runtime`,
  );
  sockets.push(ws);
  ws.on("error", () => {});
  const frames: Frame[] = [];
  ws.on("message", (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString()) as Frame);
    } catch {
      /* not ours */
    }
  });
  await waitFor(
    () => (s.relay.connections.get(who.mid)?.length ?? 0) > before,
    "the relay to register the socket",
  );
  return {
    ws,
    jti: minted?.payload.jti ?? as?.jti ?? "",
    frames,
    commands: () => frames.filter((f) => f.type === "command_request"),
    answer: (id, result, extra) =>
      ws.send(JSON.stringify({ ...extra, type: "command_response", id, result })),
  };
}

/** Post a signed command; resolves with status, body and elapsed ms. */
async function post(
  s: Stack,
  who: Identity,
  command: string,
): Promise<{ status: number; json: Record<string, unknown>; ms: number }> {
  const envelope = await signAgentCommandEnvelope({
    command,
    motebitId: who.mid,
    identityPrivateKey: who.kp.privateKey,
  });
  const start = Date.now();
  const res = await s.relay.app.request(`/api/v1/agents/${who.mid}/command`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ command, envelope }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    ms: Date.now() - start,
  };
}

/** A promise that reports whether it has settled yet, without awaiting it. */
function tracked<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  return { p, settled: () => done };
}

describe("item 1 — delivery prefers the newest open socket, and never falls through", () => {
  it("of two OPEN sockets on one machine, the NEWER one gets the frame and answers", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    // The older one models a half-open socket after a sleep: the relay
    // still reads it OPEN, and a frame sent into it is lost.
    const stale = await daemon(s, who);
    const live = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => live.commands().length === 1, "the live socket to receive the halt");
    live.answer(live.commands()[0]!.id!, { summary: "Halted.", data: { acknowledged: true } });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
    expect(stale.commands()).toEqual([]);
  });

  it("a SILENT newest socket is reported silent — the frame is never re-sent to the other", async () => {
    const s = await startRelay({ commandTimeoutMs: 300 });
    const who = await identity(s);
    const older = await daemon(s, who);
    const newest = await daemon(s, who);

    const { status, json } = await post(s, who, "halt");

    expect(status).toBe(504);
    expect(json.outcome).toBe("silent");
    expect(newest.commands()).toHaveLength(1);
    // Single-use per machine: a second delivery would be refused by the
    // machine's replay guard (a false "rejected") or executed twice.
    expect(older.commands()).toEqual([]);
  });
});

/**
 * A device linked WITHOUT key transfer holds its own key, so it can mint a
 * valid `sync` token only for its OWN device row. Declaring the daemon's
 * device id with that token makes a declared-only socket: exactly the
 * "any sync-token holder" impostor of #691 item 7.
 */
async function ownKeyDevice(s: Stack, who: Identity): Promise<{ token: string; did: string }> {
  const kd = await generateKeypair();
  const res = await s.relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id: who.mid, device_name: "phone", public_key: hex(kd) }),
  });
  expect(res.status).toBe(201);
  const phone = ((await res.json()) as { device_id: string }).device_id;
  const token = (await mintAudienceToken({ mid: who.mid, did: phone, aud: "sync" }, kd.privateKey))
    .token;
  return { token, did: phone };
}

describe("item 7 (compatible half) — a verified socket outranks a declared-only one", () => {
  it("verified-OLD + declared-only-NEW ⇒ the verified daemon gets the halt, the impostor nothing", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const real = await daemon(s, who);
    // Connects LAST, declaring the daemon's device id under another device's token.
    const impostor = await daemon(s, who, { token: (await ownKeyDevice(s, who)).token });
    const peers = s.relay.connections.get(who.mid)!;
    expect(peers.map((p) => p.deviceIdVerified)).toEqual([true, false]);

    const pending = post(s, who, "halt");
    await waitFor(() => real.commands().length === 1, "the verified daemon to receive the halt");
    real.answer(real.commands()[0]!.id!, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
    expect(impostor.commands()).toEqual([]);
  });

  // NOT "as before": main delivered to the OLDEST open socket. With no
  // verified peer the order is now newest-first (#691 item 1 — a stale
  // half-open socket must not win over the live reconnect). The exposure of
  // master-token / device-auth-off relays to a declared-only impostor is #810.
  it("only declared-only sockets (master token) ⇒ the NEWEST of them (main was oldest-first)", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const older = await daemon(s, who, { token: API_TOKEN });
    const newer = await daemon(s, who, { token: API_TOKEN });
    expect(s.relay.connections.get(who.mid)!.every((p) => p.deviceIdVerified !== true)).toBe(true);

    const pending = post(s, who, "halt");
    await waitFor(() => newer.commands().length === 1, "delivery to the newest");
    newer.answer(newer.commands()[0]!.id!, { summary: "Halted." });
    expect((await pending).status).toBe(200);
    expect(older.commands()).toEqual([]);
  });

  it("a device-auth-OFF relay (nothing is ever verified): no verified tier, so newest wins", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000, enableDeviceAuth: false });
    const who = await identity(s);
    const older = await daemon(s, who, { token: API_TOKEN });
    const newer = await daemon(s, who, { token: API_TOKEN });

    const pending = post(s, who, "halt");
    await waitFor(() => newer.commands().length === 1, "delivery to the newest");
    newer.answer(newer.commands()[0]!.id!, { summary: "Halted." });
    expect((await pending).status).toBe(200);
    expect(older.commands()).toEqual([]);
  });
});

describe("item 4 — a socket that leaves after delivery settles after a short grace, not the deadline", () => {
  it("the delivered socket CLOSES and nothing answers ⇒ 504 closed_after_delivery after the GRACE", async () => {
    const s = await startRelay({ commandTimeoutMs: 10_000, commandCloseGraceMs: 300 });
    const who = await identity(s);
    const sock = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => sock.commands().length === 1, "delivery");
    sock.ws.close();
    const { status, json, ms } = await pending;

    // Still the "delivered, no answer" status every client already reads
    // honestly — the runtime may have acted before it went.
    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
    expect(String(json.summary)).toMatch(/whether it acted is unknown/);
    expect(String(json.summary)).not.toMatch(/nothing was delivered/i);
    // Waited the grace for a reconnect, then settled — not the 10 s deadline.
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(3_000);
  });

  it("the runtime RECONNECTS within the grace and answers on the new socket ⇒ 200, its real answer", async () => {
    // The sleep/flap case item 1 exists for: the daemon replies on whatever
    // socket is current (ws-adapter `sendRaw`), which is now a new one.
    const s = await startRelay({ commandTimeoutMs: 10_000, commandCloseGraceMs: 3_000 });
    const who = await identity(s);
    const first = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    first.ws.close();
    await waitFor(
      () => (s.relay.connections.get(who.mid)?.length ?? 0) === 0,
      "the socket to leave",
    );
    const reconnect = await daemon(s, who);
    reconnect.answer(id, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
  });

  it("within the grace, ANOTHER device of the same motebit answering is refused ⇒ still closed_after_delivery", async () => {
    const s = await startRelay({ commandTimeoutMs: 10_000, commandCloseGraceMs: 400 });
    const who = await identity(s);
    const sock = await daemon(s, who);
    const phone = await ownKeyDevice(s, who);
    // Verified, but as a DIFFERENT device (its own did, declared as such).
    const other = await daemon(s, who, { token: phone.token, deviceId: phone.did });

    // `halt-status`, not `halt`: a halt on two machines is refused outright.
    const pending = post(s, who, "halt-status");
    await waitFor(() => other.commands().length + sock.commands().length === 1, "delivery");
    // Close whichever socket got it, and let the OTHER device answer the id.
    const delivered = other.commands().length === 1 ? other : sock;
    const bystander = delivered === other ? sock : other;
    const id = delivered.commands()[0]!.id!;
    delivered.ws.close();
    await waitFor(
      () => (s.relay.connections.get(who.mid)?.length ?? 0) === 1,
      "the socket to leave",
    );
    bystander.answer(id, { summary: "Running — nothing is halted." });
    const { status, json } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
  });

  it("the delivered socket is RETIRED (its token revoked) ⇒ settles the same way", async () => {
    const s = await startRelay({ commandTimeoutMs: 10_000, commandCloseGraceMs: 300 });
    const who = await identity(s);
    const sock = await daemon(s, who);

    const pending = post(s, who, "halt-status");
    await waitFor(() => sock.commands().length === 1, "delivery");
    const res = await s.relay.app.request(`/api/v1/agents/${who.mid}/revoke-tokens`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ jtis: [sock.jti] }),
    });
    expect(res.status).toBe(200);
    const { status, json, ms } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
    // A read gets the read's sentence, never the mutating verbs' one.
    expect(String(json.summary)).toMatch(/not a report that nothing happened/);
    expect(ms).toBeLessThan(3_000);
  });

  it("a socket the frame did NOT go to closing settles nothing — the answer still arrives", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const other = await daemon(s, who);
    const target = await daemon(s, who);

    const pending = tracked(post(s, who, "halt"));
    await waitFor(() => target.commands().length === 1, "delivery");
    other.ws.close();
    await waitFor(
      () => (s.relay.connections.get(who.mid)?.length ?? 0) === 1,
      "the other socket to leave",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(pending.settled()).toBe(false);

    target.answer(target.commands()[0]!.id!, { summary: "Halted." });
    const { status, json } = await pending.p;
    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
  });
});

describe("F2 — a relay shutting down settles what it still has pending", () => {
  it("relay.close() with a delivered, unanswered halt ⇒ 504 closed_after_delivery at once", async () => {
    const s = await startRelay({ commandTimeoutMs: 10_000 });
    const who = await identity(s);
    const sock = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => sock.commands().length === 1, "delivery");
    s.relayClosed = true;
    await s.relay.close();
    const { status, json, ms } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
    expect(ms).toBeLessThan(3_000);
  });
});

describe("item 5 — each relay honours its own deadline", () => {
  it("two relays in one process: the short one answers 504 first, the long one keeps waiting", async () => {
    const quick = await startRelay({ commandTimeoutMs: 200 });
    const slow = await startRelay({ commandTimeoutMs: 1_500 });
    const a = await identity(quick);
    const b = await identity(slow);
    await daemon(quick, a);
    await daemon(slow, b);

    const onSlow = tracked(post(slow, b, "halt-status"));
    const onQuick = await post(quick, a, "halt-status");

    expect(onQuick.status).toBe(504);
    expect(onQuick.ms).toBeLessThan(1_000);
    // Built second, the slow relay must not have lent its deadline to the
    // quick one — nor the quick one its deadline to the slow one.
    expect(onSlow.settled()).toBe(false);
    const late = await onSlow.p;
    expect(late.status).toBe(504);
    expect(late.ms).toBeGreaterThanOrEqual(1_400);
  });
});

describe("item 6 — an answer settles only the request of the motebit and device it was sent to", () => {
  it("another DEVICE of the same motebit answering the right id is ignored; the delivered device's answer lands", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const laptop = await daemon(s, who);
    const phone = await ownKeyDevice(s, who);
    // Verified as a SECOND device of the same motebit (its own did).
    const phoneSock = await daemon(s, who, { token: phone.token, deviceId: phone.did });
    // Whichever socket got the frame, the OTHER device answers it first.
    const pending = tracked(post(s, who, "halt-status"));
    await waitFor(() => laptop.commands().length + phoneSock.commands().length === 1, "delivery");
    const delivered = laptop.commands().length === 1 ? laptop : phoneSock;
    const other = delivered === laptop ? phoneSock : laptop;
    const id = delivered.commands()[0]!.id!;

    other.answer(id, { summary: "Running — nothing is halted." });
    await new Promise((r) => setTimeout(r, 150));
    expect(pending.settled()).toBe(false);

    delivered.answer(id, { summary: "Halted at 12:00." });
    const { status, json } = await pending.p;
    expect(status).toBe(200);
    expect(json.summary).toBe("Halted at 12:00.");
  });

  it("the right command id on ANOTHER motebit's socket is ignored; the real answer still lands", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const victim = await identity(s);
    const stranger = await identity(s);
    const victimSock = await daemon(s, victim);
    const strangerSock = await daemon(s, stranger);

    const pending = tracked(post(s, victim, "halt-status"));
    await waitFor(() => victimSock.commands().length === 1, "delivery");
    const id = victimSock.commands()[0]!.id!;

    // The forged frame even NAMES the victim: the motebit an answer is from
    // is the socket's, never a field the sender writes.
    strangerSock.answer(
      id,
      { summary: "Running — nothing is halted." },
      { motebit_id: victim.mid },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(pending.settled()).toBe(false);

    victimSock.answer(id, { summary: "Halted at 12:00." });
    const { status, json } = await pending.p;
    expect(status).toBe(200);
    expect(json.summary).toBe("Halted at 12:00.");
  });
});
