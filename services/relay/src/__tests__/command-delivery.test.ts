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
 *  1. Delivery picks what MAIN picks (the oldest open candidate), except
 *     that a verified pick goes to the newest open verified socket of the
 *     SAME device — its own reconnect. Every reordering across peer kinds
 *     lost an answer main returns (#812, #815), so there is none. It never
 *     falls through to another socket of the machine on silence (the
 *     envelope is single-use per machine; see `sendToOne`).
 *  4. A socket that closes — or is retired — after delivery settles NOTHING:
 *     the runtime answers on whatever socket is current, so its reconnect's
 *     answer before the deadline wins with its real result, exactly as on
 *     main. Only the deadline's 504 changes: `closed_after_delivery` instead
 *     of `silent`. A relay's `close()` settles everything at once.
 *  5. Two relays in one process each honour their own deadline.
 *  6. An answer is accepted only from the delivered peer's STABLE identity:
 *     the same declared device id, else the same token `did`, else (neither)
 *     any socket of the motebit. Another motebit, or another device of the
 *     same motebit, settles nothing.
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
  // `deviceId: null` connects WITHOUT declaring one — the surfaces that never
  // pass `device_id` (desktop, mobile, web, spatial) and no-id daemons.
  // `caps` replaces the announced capabilities (default: unattended_runtime).
  as?: { token: string; jti?: string; deviceId?: string | null; caps?: string },
): Promise<Sock> {
  const minted =
    as == null
      ? await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey)
      : null;
  const token = as?.token ?? minted!.token;
  const before = s.relay.connections.get(who.mid)?.length ?? 0;
  const declared = as?.deviceId === null ? "" : `&device_id=${as?.deviceId ?? who.did}`;
  const ws = new WebSocket(
    `ws://127.0.0.1:${s.port}/ws/sync/${who.mid}?token=${token}${declared}&capabilities=${as?.caps ?? "unattended_runtime"}`,
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
  // The relay registers in its onOpen, which can run before the client sees
  // `open`; a test that answers at once must not write to a CONNECTING socket.
  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise<void>((r) => ws.once("open", () => r()));
  }
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

describe("item 1 — a verified pick goes to its own machine's newest socket, and delivery never falls through", () => {
  it("D7: a stale OLDER verified socket + the live NEWER one of the same device ⇒ the newer gets it, 200", async () => {
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

/**
 * Main's pick is kept ACROSS peer kinds. In each case an older live peer
 * answers and a newer socket stays silent — a half-open verified daemon
 * socket, or a deaf undeclared one. Main returns 200 for every one of these;
 * any tiering of verified over other peers turned them into 504s (#815).
 */
describe("main's pick across peer kinds — the older live peer answers, as on main", () => {
  /** An older live `first` answers; the newer `silent` must not have been asked. */
  async function firstAnswers(
    s: Stack,
    who: Identity,
    command: string,
    first: Sock,
    silent: Sock,
  ): Promise<void> {
    const pending = post(s, who, command);
    await waitFor(() => first.commands().length === 1, "delivery to the older live peer");
    first.answer(first.commands()[0]!.id!, { summary: "answered by the older peer" });
    const { status, json } = await pending;
    expect(status).toBe(200);
    expect(json.summary).toBe("answered by the older peer");
    expect(silent.commands()).toEqual([]);
  }

  it("D1: an older undeclared phone (signed token) + a newer half-open verified daemon — `state` ⇒ the phone, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const phone = await ownKeyDevice(s, who);
    const phoneSock = await daemon(s, who, {
      token: phone.token,
      deviceId: null,
      caps: "push_wake",
    });
    const daemonSock = await daemon(s, who);
    await firstAnswers(s, who, "state", phoneSock, daemonSock);
  });

  it("D1c: an older VERIFIED phone (its own device) + a newer half-open verified daemon — `state` ⇒ the phone, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const phone = await ownKeyDevice(s, who);
    const phoneSock = await daemon(s, who, {
      token: phone.token,
      deviceId: phone.did,
      caps: "push_wake",
    });
    const daemonSock = await daemon(s, who);
    await firstAnswers(s, who, "state", phoneSock, daemonSock);
  });

  it("D1d: an older DECLARED-ONLY phone (master token) + a newer half-open verified daemon — `state` ⇒ the phone, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 1_500 });
    const who = await identity(s);
    const phoneSock = await daemon(s, who, {
      token: API_TOKEN,
      deviceId: "phone-1",
      caps: "push_wake",
    });
    const daemonSock = await daemon(s, who);
    await firstAnswers(s, who, "state", phoneSock, daemonSock);
  });

  it("D2: an older live verified daemon + a newer half-open verified socket of ANOTHER device — `state` ⇒ the daemon, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const daemonSock = await daemon(s, who);
    const phone = await ownKeyDevice(s, who);
    const other = await daemon(s, who, {
      token: phone.token,
      deviceId: phone.did,
      caps: "push_wake",
    });
    await firstAnswers(s, who, "state", daemonSock, other);
  });

  it("D4: an older live DECLARED-ONLY daemon + a newer half-open verified socket of the same id — halt ⇒ the declared-only one, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const declaredOnly = await daemon(s, who, { token: API_TOKEN });
    const verified = await daemon(s, who);
    expect(s.relay.connections.get(who.mid)!.map((p) => p.deviceIdVerified)).toEqual([false, true]);
    await firstAnswers(s, who, "halt", declaredOnly, verified);
  });

  it("D5: an older live UNDECLARED master-token daemon + a newer half-open verified daemon — halt ⇒ the older, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const undeclared = await daemon(s, who, { token: API_TOKEN, deviceId: null });
    const verified = await daemon(s, who);
    await firstAnswers(s, who, "halt", undeclared, verified);
  });

  it("D5c: the same with `runs` (both keep a run ledger) ⇒ the older, 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 3_000 });
    const who = await identity(s);
    const caps = "unattended_runtime,run_ledger";
    const undeclared = await daemon(s, who, { token: API_TOKEN, deviceId: null, caps });
    const minted = await mintAudienceToken(
      { mid: who.mid, did: who.did, aud: "sync" },
      who.kp.privateKey,
    );
    const verified = await daemon(s, who, { token: minted.token, caps });
    expect(s.relay.connections.get(who.mid)![1]!.deviceIdVerified).toBe(true);
    await firstAnswers(s, who, "runs", undeclared, verified);
  });

  it("verified-OLD + declared-only-NEW ⇒ the verified daemon gets the halt, the impostor nothing (main's pick)", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const real = await daemon(s, who);
    const impostor = await daemon(s, who, { token: (await ownKeyDevice(s, who)).token });
    expect(s.relay.connections.get(who.mid)!.map((p) => p.deviceIdVerified)).toEqual([true, false]);
    await firstAnswers(s, who, "halt", real, impostor);
  });

  it("D12 (#810 residual): a declared-only impostor connected FIRST + the verified daemon ⇒ the impostor gets it, exactly as on main", async () => {
    // Deliberately unchanged: which of a verified and a declared-only peer
    // should win is #810's decision. This pins that the build does not
    // quietly decide it either way.
    const s = await startRelay({ commandTimeoutMs: 400 });
    const who = await identity(s);
    const impostor = await daemon(s, who, { token: (await ownKeyDevice(s, who)).token });
    const real = await daemon(s, who);
    expect(s.relay.connections.get(who.mid)!.map((p) => p.deviceIdVerified)).toEqual([false, true]);
    const { status } = await post(s, who, "halt");
    expect(status).toBe(504);
    expect(impostor.commands()).toHaveLength(1);
    expect(real.commands()).toEqual([]);
  });

  // No verified peer at all: main's oldest-first. For undeclared clients the
  // newest socket is NOT the live one — web and desktop attach their command
  // handler only to their original adapter, and the sockets later token
  // refreshes open stay deaf (#816). These cases model an older socket that
  // answers beside a newer deaf one, and pin that main's pick is kept.
  async function oldestAnswersNewerDeaf(
    s: Stack,
    who: Identity,
    as: () => Promise<{ token: string; deviceId?: string | null }>,
  ): Promise<void> {
    const first = await daemon(s, who, await as());
    const deaf = await daemon(s, who, await as());
    expect(s.relay.connections.get(who.mid)!.every((p) => p.deviceIdVerified !== true)).toBe(true);
    await firstAnswers(s, who, "halt", first, deaf);
  }

  it("C1: undeclared signed sockets (token did, no device_id) ⇒ the OLDEST gets it, as main — the newer one is deaf", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    await oldestAnswersNewerDeaf(s, who, async () => ({
      token: (
        await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey)
      ).token,
      deviceId: null,
    }));
  });

  it("C2: undeclared master-token sockets ⇒ the OLDEST gets it, as main", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    await oldestAnswersNewerDeaf(s, who, async () => ({ token: API_TOKEN, deviceId: null }));
  });

  it("C3: declared master-token sockets (declared-only, never verified) ⇒ the OLDEST gets it, as main", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    await oldestAnswersNewerDeaf(s, who, async () => ({ token: API_TOKEN }));
  });

  it("a device-auth-OFF relay (nothing is ever verified) ⇒ the OLDEST gets it, as main", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000, enableDeviceAuth: false });
    const who = await identity(s);
    await oldestAnswersNewerDeaf(s, who, async () => ({ token: API_TOKEN }));
  });
});

/** Close a socket and wait until the relay has let it go. */
async function drop(s: Stack, who: Identity, sock: Sock): Promise<void> {
  const before = s.relay.connections.get(who.mid)?.length ?? 0;
  sock.ws.close();
  await waitFor(
    () => (s.relay.connections.get(who.mid)?.length ?? 0) < before,
    "the socket to leave",
  );
}

describe("item 4 — the delivered socket leaving settles nothing; a valid answer before the deadline wins", () => {
  it("a DECLARED daemon reconnects and answers a second later ⇒ 200, its real answer", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const first = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    await new Promise((r) => setTimeout(r, 1_000));
    const reconnect = await daemon(s, who);
    reconnect.answer(id, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
  });

  it("K2: a DECLARED daemon reconnects UNDECLARED with a token whose did is its device id, and answers ⇒ 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const first = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    const token = (
      await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey)
    ).token;
    const reconnect = await daemon(s, who, { token, deviceId: null });
    reconnect.answer(id, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
  });

  it("an UNDECLARED read surface (token did, no device_id) reconnects and answers ⇒ 200", async () => {
    // Desktop, mobile, web and spatial never pass device_id: the relay makes
    // up a new id per connection, so the answer is bound to the token's did.
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const mint = async () =>
      (await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey))
        .token;
    const first = await daemon(s, who, { token: await mint(), deviceId: null });
    expect(s.relay.connections.get(who.mid)![0]!.deviceIdDeclared).toBe(false);

    const pending = post(s, who, "state");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    const reconnect = await daemon(s, who, { token: await mint(), deviceId: null });
    reconnect.answer(id, { summary: "State: ok" });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("State: ok");
  });

  it("an UNDECLARED surface bound by its token did: an undeclared socket of ANOTHER did answering is refused", async () => {
    const s = await startRelay({ commandTimeoutMs: 600 });
    const who = await identity(s);
    const mine = (
      await mintAudienceToken({ mid: who.mid, did: who.did, aud: "sync" }, who.kp.privateKey)
    ).token;
    const first = await daemon(s, who, { token: mine, deviceId: null });

    const pending = post(s, who, "state");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    // Another device of the motebit, also undeclared: its token's did differs.
    const phone = await ownKeyDevice(s, who);
    const stranger = await daemon(s, who, { token: phone.token, deviceId: null });
    stranger.answer(id, { summary: "State: forged" });
    const { status, json } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
  });

  it("an UNDECLARED master-token daemon's halt, answered on its reconnect ⇒ 200 (main's rule)", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const first = await daemon(s, who, { token: API_TOKEN, deviceId: null });

    const pending = post(s, who, "halt");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    const reconnect = await daemon(s, who, { token: API_TOKEN, deviceId: null });
    reconnect.answer(id, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
  });

  it("a device-auth-OFF relay: the same undeclared reconnect-and-answer ⇒ 200", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000, enableDeviceAuth: false });
    const who = await identity(s);
    const first = await daemon(s, who, { token: API_TOKEN, deviceId: null });

    const pending = post(s, who, "halt");
    await waitFor(() => first.commands().length === 1, "delivery");
    const id = first.commands()[0]!.id!;
    await drop(s, who, first);
    const reconnect = await daemon(s, who, { token: API_TOKEN, deviceId: null });
    reconnect.answer(id, { summary: "Halted." });
    expect((await pending).status).toBe(200);
  });

  it("delivered socket closed, ANOTHER device of the motebit answers ⇒ refused; 504 closed_after_delivery AT the deadline", async () => {
    const s = await startRelay({ commandTimeoutMs: 800 });
    const who = await identity(s);
    const sock = await daemon(s, who);
    const phone = await ownKeyDevice(s, who);
    const other = await daemon(s, who, { token: phone.token, deviceId: phone.did });

    // `halt-status`, not `halt`: a halt on two machines is refused outright.
    const pending = post(s, who, "halt-status");
    await waitFor(() => other.commands().length + sock.commands().length === 1, "delivery");
    const delivered = other.commands().length === 1 ? other : sock;
    const bystander = delivered === other ? sock : other;
    const id = delivered.commands()[0]!.id!;
    await drop(s, who, delivered);
    bystander.answer(id, { summary: "Running — nothing is halted." });
    const { status, json, ms } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("closed_after_delivery");
    expect(ms).toBeGreaterThanOrEqual(750);
  });

  it("the delivered socket CLOSES and nothing answers ⇒ 504 closed_after_delivery at the deadline, not before", async () => {
    const s = await startRelay({ commandTimeoutMs: 600 });
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
    expect(ms).toBeGreaterThanOrEqual(550);
  });

  it("the delivered socket is RETIRED (its token revoked) and nothing answers ⇒ the same, at the deadline", async () => {
    const s = await startRelay({ commandTimeoutMs: 600 });
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
    expect(ms).toBeGreaterThanOrEqual(550);
  });

  it("an UNRELATED socket closing marks nothing: the delivered command's deadline 504 stays `silent`", async () => {
    const s = await startRelay({ commandTimeoutMs: 600 });
    const who = await identity(s);
    const phone = await ownKeyDevice(s, who);
    const bystander = await daemon(s, who, {
      token: phone.token,
      deviceId: null,
      caps: "push_wake",
    });
    const delivered = await daemon(s, who);

    const pending = post(s, who, "halt");
    await waitFor(() => delivered.commands().length === 1, "delivery to the daemon");
    expect(bystander.commands()).toEqual([]);
    await drop(s, who, bystander);
    const { status, json } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("silent");
  });

  it("a delivered socket that stays open and silent ⇒ 504 silent (the mark is the only difference)", async () => {
    const s = await startRelay({ commandTimeoutMs: 400 });
    const who = await identity(s);
    await daemon(s, who);
    const { status, json } = await post(s, who, "halt");
    expect(status).toBe(504);
    expect(json.outcome).toBe("silent");
  });

  it("a socket the frame did NOT go to closing changes nothing — the answer still arrives", async () => {
    const s = await startRelay({ commandTimeoutMs: 5_000 });
    const who = await identity(s);
    const other = await daemon(s, who);
    const target = await daemon(s, who);

    const pending = tracked(post(s, who, "halt"));
    await waitFor(() => target.commands().length === 1, "delivery");
    await drop(s, who, other);
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

describe("F2 — a relay's close() settles only its OWN pending commands", () => {
  it("two relays in one process: A.close() settles A's command and leaves B's, whose answer still lands", async () => {
    const a = await startRelay({ commandTimeoutMs: 10_000 });
    const b = await startRelay({ commandTimeoutMs: 10_000 });
    const onA = await identity(a);
    const onB = await identity(b);
    const sockA = await daemon(a, onA);
    const sockB = await daemon(b, onB);

    const pendingA = post(a, onA, "halt");
    const pendingB = tracked(post(b, onB, "halt"));
    await waitFor(
      () => sockA.commands().length === 1 && sockB.commands().length === 1,
      "both deliveries",
    );

    a.relayClosed = true;
    await a.relay.close();
    expect((await pendingA).json.outcome).toBe("closed_after_delivery");
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingB.settled()).toBe(false);

    sockB.answer(sockB.commands()[0]!.id!, { summary: "Halted." });
    const { status, json } = await pendingB.p;
    expect(status).toBe(200);
    expect(json.summary).toBe("Halted.");
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

  it("an UNDECLARED master-token peer (motebit-only key): ANOTHER motebit's socket answering is still refused", async () => {
    // With no device id and no token did the only binding left is the
    // motebit — main's rule — so the motebit check is all that stands here.
    const s = await startRelay({ commandTimeoutMs: 600 });
    const victim = await identity(s);
    const stranger = await identity(s);
    const victimSock = await daemon(s, victim, { token: API_TOKEN, deviceId: null });
    const strangerSock = await daemon(s, stranger, { token: API_TOKEN, deviceId: null });

    const pending = post(s, victim, "halt");
    await waitFor(() => victimSock.commands().length === 1, "delivery");
    strangerSock.answer(victimSock.commands()[0]!.id!, { summary: "Halted." });
    const { status, json } = await pending;

    expect(status).toBe(504);
    expect(json.outcome).toBe("silent");
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
