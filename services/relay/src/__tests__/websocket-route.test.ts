/**
 * The relay's WebSocket route, driven directly.
 *
 * Everything that routes or attributes by machine reads facts this handler
 * establishes and nothing else can: whether a socket's declared device id
 * was PROVEN by its signed token, which key that token verified under
 * (captured at verification, never re-read), and that a bound or closed
 * socket is reported to whoever keeps the roster's liveness record.
 *
 * The verifier here is the REAL `verifySignedTokenForDevice` over real
 * signed tokens; only the device store is a map, so a test can rotate a
 * device's key under an open socket the way `succession-apply.ts` does.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { registerWebSocketRoutes } from "../websocket.js";
import type { WebSocketDeps, ConnectedDevice } from "../websocket.js";
import { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "../auth.js";

const MID = "mote-1";

interface Harness {
  /** device_id → public key hex: the relay's device rows. */
  devices: Map<string, string>;
  /** Agent-registry fallback key, for service-mode tokens. */
  registryKey?: string;
  deviceAuth?: boolean;
  master?: boolean;
  bound: ConnectedDevice[];
  closed: ConnectedDevice[];
}

interface Handlers {
  onOpen(event: unknown, ws: unknown): Promise<void>;
  onClose(event: unknown, ws: unknown): void;
  onMessage(event: { data: string }, ws: unknown): Promise<void>;
}

function harness(over: Partial<Harness> = {}): Harness {
  return { devices: new Map(), bound: [], closed: [], deviceAuth: true, ...over };
}

async function tokenFor(did: string, kp: KeyPair): Promise<string> {
  const now = Date.now();
  return createSignedToken(
    { mid: MID, did, iat: now, exp: now + 300_000, jti: crypto.randomUUID(), aud: "sync" },
    kp.privateKey,
  );
}

/** Upgrade one connection through the real route and return its handlers. */
function connect(query: string, h: Harness) {
  let factory: ((c: unknown) => Handlers) | undefined;
  const connections = new Map<string, ConnectedDevice[]>();
  const deps = {
    app: new Hono(),
    // The adapter's contract: it is handed a factory and returns a route
    // handler. Capturing the factory is all a test needs of it.
    upgradeWebSocket: (f: (c: unknown) => Handlers) => {
      factory = f;
      return () => new Response(null);
    },
    connections,
    taskQueue: new Map(),
    apiToken: h.master === true ? "master" : undefined,
    enableDeviceAuth: h.deviceAuth !== false,
    isTokenBlacklisted: () => false,
    isAgentRevoked: () => false,
    identityManager: {
      loadDeviceById: async (did: string) => {
        const key = h.devices.get(did);
        return key == null ? null : { public_key: key };
      },
    },
    verifySignedTokenForDevice: ((token, mid, im, aud, bl, rev, lookup, onReject, onVerified) =>
      verifySignedTokenForDevice(
        token,
        mid,
        im,
        aud,
        bl,
        rev,
        lookup ?? (() => h.registryKey ?? null),
        onReject,
        onVerified,
      )) as typeof verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
    // index.ts's resolution over the harness's own stores: device row, else registry.
    keyThatVerifiesNow: (_mid: string, did: string) => h.devices.get(did) ?? h.registryKey ?? null,
    wsLimiter: { check: () => ({ allowed: true }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onPeerBound: (_m: string, peer: ConnectedDevice) => h.bound.push({ ...peer }),
    onPeerClosed: (_m: string, peer: ConnectedDevice) => h.closed.push({ ...peer }),
  } as unknown as WebSocketDeps;
  registerWebSocketRoutes(deps);
  if (factory == null) throw new Error("the route never asked for an upgrade");
  const handlers = factory({
    req: { param: () => MID, url: `http://relay.test/ws/sync/${MID}${query}` },
  });
  const ws = { send: () => {}, close: () => {}, readyState: 1 };
  return { handlers, ws, connections };
}

describe("a declared device id is VERIFIED only when the signed token proves it", () => {
  it("declared id === the token's did ⇒ verified, and bound under the key that verified it", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("dev-2", kp)}&device_id=dev-2`,
      h,
    );
    await handlers.onOpen({}, ws);
    expect(connections.get(MID)?.[0]).toMatchObject({
      deviceId: "dev-2",
      deviceIdDeclared: true,
      deviceIdVerified: true,
      boundUnder: bytesToHex(kp.publicKey),
    });
  });

  it("a VALID token for one device, declaring ANOTHER's id ⇒ declared, never verified, never bound", async () => {
    // The attack: the web session authenticates honestly as itself and
    // types the VPS's id into the URL.
    const web = await generateKeypair();
    const vps = await generateKeypair();
    const h = harness({
      devices: new Map([
        ["web-session", bytesToHex(web.publicKey)],
        ["dev-2", bytesToHex(vps.publicKey)],
      ]),
    });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("web-session", web)}&device_id=dev-2`,
      h,
    );
    await handlers.onOpen({}, ws);
    const peer = connections.get(MID)?.[0];
    expect(peer).toMatchObject({ deviceId: "dev-2", deviceIdDeclared: true });
    expect(peer?.deviceIdVerified).toBe(false);
    expect(peer?.boundUnder).toBeUndefined();
  });

  it("the master token proves no device ⇒ not verified, not bound", async () => {
    const { handlers, ws, connections } = connect(
      "?token=master&device_id=dev-2",
      harness({ master: true }),
    );
    await handlers.onOpen({}, ws);
    const peer = connections.get(MID)?.[0];
    expect(peer?.deviceIdVerified).toBe(false);
    expect(peer?.boundUnder).toBeUndefined();
  });

  it("device auth off ⇒ nothing was proven ⇒ not verified, not bound", async () => {
    const { handlers, ws, connections } = connect(
      "?device_id=dev-2",
      harness({ deviceAuth: false }),
    );
    await handlers.onOpen({}, ws);
    expect(connections.get(MID)?.[0]?.deviceIdVerified).toBe(false);
    expect(connections.get(MID)?.[0]?.boundUnder).toBeUndefined();
  });

  it("a token that FAILS verification never connects", async () => {
    const kp = await generateKeypair();
    const stranger = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("dev-2", stranger)}&device_id=dev-2`,
      h,
    );
    await handlers.onOpen({}, ws);
    expect(connections.get(MID) ?? []).toEqual([]);
    expect(h.bound).toEqual([]);
  });

  it("a token verified through the agent-registry fallback binds nothing — there is no device row", async () => {
    const kp = await generateKeypair();
    const h = harness({ registryKey: bytesToHex(kp.publicKey) });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("svc", kp)}&device_id=svc`,
      h,
    );
    await handlers.onOpen({}, ws);
    expect(connections.get(MID)?.[0]?.boundUnder).toBeUndefined();
  });

  it("two auth frames racing through verification register the socket ONCE", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect("?device_id=dev-2", h);
    await handlers.onOpen({}, ws);
    const frame = { data: JSON.stringify({ type: "auth", token: await tokenFor("dev-2", kp) }) };
    await Promise.all([handlers.onMessage(frame, ws), handlers.onMessage(frame, ws)]);
    expect(connections.get(MID)).toHaveLength(1);
    expect(h.bound).toHaveLength(1);
  });

  it("a socket no longer OPEN when verification finishes is never registered", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect("?device_id=dev-2", h);
    await handlers.onOpen({}, ws);
    const pending = handlers.onMessage(
      { data: JSON.stringify({ type: "auth", token: await tokenFor("dev-2", kp) }) },
      ws,
    );
    (ws as { readyState: number }).readyState = 3; // the client went away mid-verification
    handlers.onClose({}, ws);
    await pending;
    expect(connections.get(MID) ?? []).toEqual([]);
    expect(h.bound).toEqual([]);
  });

  it("proven through the post-connect auth frame too, not only the query token", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect("?device_id=dev-2", h);
    await handlers.onOpen({}, ws);
    expect(connections.get(MID) ?? []).toEqual([]); // waiting for the frame
    await handlers.onMessage(
      { data: JSON.stringify({ type: "auth", token: await tokenFor("dev-2", kp) }) },
      ws,
    );
    expect(connections.get(MID)?.[0]).toMatchObject({
      deviceIdVerified: true,
      boundUnder: bytesToHex(kp.publicKey),
    });
  });
});

describe("bound_under is captured at verification and never re-read (review F1)", () => {
  it("a socket verified under K_old stays bound under K_old after its device row is rotated to K_new", async () => {
    // succession-apply.ts rewrites device rows; its socket close (#767) is a
    // handshake, and a hand-built harness has no applySuccession at all. A
    // socket opened under the old key must never read as bound under the
    // new one — not at a later announce, and not at close.
    const kOld = await generateKeypair();
    const kNew = await generateKeypair();
    const h = harness({ devices: new Map([["vps", bytesToHex(kOld.publicKey)]]) });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("vps", kOld)}&device_id=vps&capabilities=unattended_runtime`,
      h,
    );
    await handlers.onOpen({}, ws);

    h.devices.set("vps", bytesToHex(kNew.publicKey)); // the rotation
    await handlers.onMessage(
      {
        data: JSON.stringify({
          type: "capabilities_announce",
          capabilities: ["unattended_runtime", "halt"],
        }),
      },
      ws,
    );
    expect(connections.get(MID)?.[0]?.boundUnder).toBe(bytesToHex(kOld.publicKey));
    handlers.onClose({}, ws);

    const reported = [...h.bound, ...h.closed].map((p) => p.boundUnder);
    expect(reported).toHaveLength(3); // bind, announce, close
    expect(new Set(reported)).toEqual(new Set([bytesToHex(kOld.publicKey)]));
  });
});

describe("a bound or closed connection is reported to the liveness observer", () => {
  it("reports bind with the peer as bound, and a later announce", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws } = connect(
      `?token=${await tokenFor("dev-2", kp)}&device_id=dev-2&capabilities=sync`,
      h,
    );
    await handlers.onOpen({}, ws);
    await handlers.onMessage(
      {
        data: JSON.stringify({
          type: "capabilities_announce",
          capabilities: ["unattended_runtime"],
        }),
      },
      ws,
    );
    expect(h.bound.map((p) => p.capabilities)).toEqual([["sync"], ["unattended_runtime"]]);
  });

  it("hands the departed peer to onPeerClosed after removing it, once", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws, connections } = connect(
      `?token=${await tokenFor("dev-2", kp)}&device_id=dev-2&capabilities=unattended_runtime`,
      h,
    );
    await handlers.onOpen({}, ws);
    handlers.onClose({}, ws);
    expect(connections.get(MID) ?? []).toEqual([]);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]).toMatchObject({
      deviceId: "dev-2",
      deviceIdVerified: true,
      boundUnder: bytesToHex(kp.publicKey),
      capabilities: ["unattended_runtime"],
    });
    // A second close of the same socket reports nothing: it already left.
    handlers.onClose({}, ws);
    expect(h.closed).toHaveLength(1);
  });

  it("a socket that never finished authenticating was never a peer, and is not reported", async () => {
    const kp = await generateKeypair();
    const h = harness({ devices: new Map([["dev-2", bytesToHex(kp.publicKey)]]) });
    const { handlers, ws } = connect("?device_id=dev-2", h);
    await handlers.onOpen({}, ws); // waiting for the auth frame
    handlers.onClose({}, ws);
    expect(h.bound).toEqual([]);
    expect(h.closed).toEqual([]);
  });
});
