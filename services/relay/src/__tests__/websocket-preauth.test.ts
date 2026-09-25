/**
 * No frame from a sync socket is acted on before the socket is registered.
 *
 * The query-param token path (`/ws/sync/:id?token=…`) verifies inside `onOpen`,
 * which `@hono/node-ws` does not await — frames the client sends right after
 * the upgrade reach `onMessage` while verification is still pending. Before the
 * `registered` gate, the only pre-auth check was `awaitingAuthFrame`, which is
 * false on that path, so a socket holding a token signed by ANY key could write
 * conversations and events into any motebit's sync store and have them fanned
 * out to that motebit's real devices — then be closed 4003.
 *
 * Real WebSocket over `@hono/node-server`; verification is held open
 * deterministically so the window is not a timing accident.
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
import { createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
let owner: KeyPair;
let motebitId: string;
const open: WebSocket[] = [];

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const syncToken = async (did: string, kp: KeyPair) =>
  (await mintAudienceToken({ mid: motebitId, did, aud: "sync" }, kp.privateKey)).token;

const conversation = (id: string) => ({
  type: "push_conversations",
  conversations: [
    {
      conversation_id: id,
      motebit_id: motebitId,
      started_at: 1,
      last_active_at: 2,
      title: "injected",
      summary: null,
      message_count: 1,
    },
  ],
});

const conversationRows = (id: string) =>
  relay.moteDb.db.prepare("SELECT * FROM sync_conversations WHERE conversation_id = ?").all(id);

/**
 * Hold device-key lookup (the await inside token verification) until released,
 * so frames sent on open land while verification is provably still pending.
 */
function holdVerification(): { release: () => void; entered: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const original = IdentityManager.prototype.loadDeviceById;
  vi.spyOn(IdentityManager.prototype, "loadDeviceById").mockImplementation(async function (
    this: IdentityManager,
    ...args: Parameters<IdentityManager["loadDeviceById"]>
  ) {
    entered = true;
    await gate;
    return original.apply(this, args);
  });
  return { release, entered: () => entered };
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
  owner = await generateKeypair();
  motebitId = crypto.randomUUID();
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      motebit_id: motebitId,
      device_id: "laptop",
      public_key: bytesToHex(owner.publicKey),
    }),
  });
  expect(res.status).toBeLessThan(300);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function socket(query: string): {
  ws: WebSocket;
  recv: string[];
  closed: () => number;
  opened: Promise<void>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${motebitId}?${query}`);
  open.push(ws);
  const recv: string[] = [];
  let code = 0;
  ws.on("message", (d: Buffer) => recv.push(d.toString("utf8")));
  ws.on("close", (c) => (code = c));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, recv, closed: () => code, opened };
}

describe("sync socket: nothing is acted on before registration", () => {
  it("a forged query token's frames are refused while verification is pending — no write, no fan-out", async () => {
    // A legitimate device is connected, to observe fan-out.
    const legit = socket(`token=${await syncToken("laptop", owner)}&device_id=laptop`);
    await legit.opened;
    await waitFor(() => (relay.connections.get(motebitId)?.length ?? 0) === 1, "legit registered");

    const hold = holdVerification();
    const attackerKey = await generateKeypair(); // never registered for this motebit
    const attacker = socket(`token=${await syncToken("laptop", attackerKey)}`);
    await attacker.opened;
    await waitFor(hold.entered, "verification to start");

    attacker.ws.send(JSON.stringify(conversation(`INJECTED-${motebitId}`)));
    attacker.ws.send(
      JSON.stringify({
        type: "push",
        events: [
          {
            event_id: crypto.randomUUID(),
            motebit_id: motebitId,
            timestamp: Date.now(),
            event_type: "memory_formed",
            payload: { content: "injected" },
            version_clock: 1,
            tombstoned: false,
          },
        ],
      }),
    );
    await waitFor(
      () => attacker.recv.filter((m) => m.includes("Authentication required")).length === 2,
      "both frames refused",
    );

    hold.release();
    await waitFor(() => attacker.closed() === 4003, "forged token closed 4003");

    expect(conversationRows(`INJECTED-${motebitId}`)).toHaveLength(0);
    const events = relay.moteDb.db
      .prepare("SELECT payload FROM events WHERE motebit_id = ?")
      .all(motebitId) as Array<{ payload: string }>;
    expect(events.filter((e) => String(e.payload).includes("injected"))).toHaveLength(0);
    expect(legit.recv.filter((m) => m.includes("INJECTED") || m.includes("injected"))).toHaveLength(
      0,
    );
    expect(relay.connections.get(motebitId)?.length).toBe(1);

    // Relay rule 6: the refusal is recorded (this door used to record nothing).
    const refusals = relay.moteDb.db
      .prepare(
        "SELECT kind, path, motebit_id, audience, reason FROM relay_auth_events WHERE path = ?",
      )
      .all(`/ws/sync/${motebitId}`) as Array<Record<string, string>>;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      kind: "device_token_rejected",
      motebit_id: motebitId,
      audience: "sync",
    });
  });

  it("a valid query token's frames sent before registration are refused, and accepted after", async () => {
    const hold = holdVerification();
    const client = socket(`token=${await syncToken("laptop", owner)}&device_id=laptop`);
    await client.opened;
    await waitFor(hold.entered, "verification to start");

    client.ws.send(JSON.stringify(conversation("early")));
    await waitFor(
      () => client.recv.some((m) => m.includes("Authentication required")),
      "early frame refused",
    );
    hold.release();
    await waitFor(() => (relay.connections.get(motebitId)?.length ?? 0) === 1, "registered");
    expect(conversationRows("early")).toHaveLength(0);

    client.ws.send(JSON.stringify(conversation("after")));
    await waitFor(() => conversationRows("after").length === 1, "post-registration write lands");
  });

  it("a query token and an auth frame both verifying register the socket once", async () => {
    const hold = holdVerification();
    const client = socket(`token=${await syncToken("laptop", owner)}&device_id=laptop`);
    await client.opened;
    await waitFor(hold.entered, "verification to start");
    client.ws.send(JSON.stringify({ type: "auth", token: await syncToken("laptop", owner) }));
    await new Promise((r) => setTimeout(r, 50));
    hold.release();
    await waitFor(() => client.recv.some((m) => m.includes('"auth_result"')), "auth_result");
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.connections.get(motebitId)?.length).toBe(1);
  });
});
