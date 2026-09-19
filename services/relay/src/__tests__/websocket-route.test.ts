/**
 * The relay's WebSocket route, driven directly.
 *
 * It had no test of its own. Everything that routes or attributes by
 * machine reads two facts this handler establishes and nothing else
 * can: whether a socket's declared device id was PROVEN by its signed
 * token, and that a closed socket is reported to whoever is keeping the
 * roster's liveness record.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerWebSocketRoutes } from "../websocket.js";
import type { WebSocketDeps, ConnectedDevice } from "../websocket.js";

/** How the socket authenticates, per test. */
interface Auth {
  /** Device auth on, and the signed token's `did`. `null` ⇒ it fails to verify. */
  tokenDid?: string | null;
  /** The relay's master token, and whether the socket presents it. */
  master?: boolean;
}

interface Handlers {
  onOpen(event: unknown, ws: unknown): Promise<void>;
  onClose(event: unknown, ws: unknown): void;
  onMessage(event: { data: string }, ws: unknown): Promise<void>;
}

/** Upgrade one connection through the real route and return its handlers. */
function connect(query: string, auth: Auth = {}, closed: ConnectedDevice[] = []) {
  let factory: ((c: unknown) => Handlers) | undefined;
  const connections = new Map<string, ConnectedDevice[]>();
  const deps = {
    app: new Hono(),
    // The adapter's contract: it is handed a factory and returns a
    // route handler. Capturing the factory is all a test needs of it.
    upgradeWebSocket: (f: (c: unknown) => Handlers) => {
      factory = f;
      return () => new Response(null);
    },
    connections,
    taskQueue: new Map(),
    apiToken: auth.master === true ? "master" : undefined,
    enableDeviceAuth: auth.tokenDid !== undefined || auth.master === true,
    isTokenBlacklisted: () => false,
    isAgentRevoked: () => false,
    identityManager: {},
    // The signature check is `auth.ts`'s and is tested there. What this
    // file holds the socket to is what it does with the VERDICT — so the
    // verdict is the dial, and the claims are only readable beside it.
    verifySignedTokenForDevice: () => Promise.resolve(auth.tokenDid != null),
    parseTokenPayloadUnsafe: () => ({ mid: "mote-1", did: auth.tokenDid ?? "forged-did" }),
    wsLimiter: { check: () => ({ allowed: true }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onPeerClosed: (_motebitId: string, peer: ConnectedDevice) => {
      closed.push(peer);
    },
  } as unknown as WebSocketDeps;
  registerWebSocketRoutes(deps);
  if (factory == null) throw new Error("the route never asked for an upgrade");
  const handlers = factory({
    req: { param: () => "mote-1", url: `http://relay.test/ws/sync/mote-1${query}` },
  });
  const ws = { send: () => {}, close: () => {}, readyState: 1 };
  return { handlers, ws, connections };
}

describe("a declared device id is VERIFIED only when the signed token proves it", () => {
  // `?device_id=` is a query string. A composed answer files each reply
  // under a device id and may call the picture whole, so the id has to
  // have been proven by a key registered to that device — otherwise any
  // surface holding a sync token could answer in another machine's name.
  const token = "?token=a.signed.token";

  it("declared id === the token's did ⇒ verified", async () => {
    const { handlers, ws, connections } = connect(`${token}&device_id=dev-2`, {
      tokenDid: "dev-2",
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]).toMatchObject({
      deviceId: "dev-2",
      deviceIdDeclared: true,
      deviceIdVerified: true,
    });
  });

  it("a VALID token for one device, declaring ANOTHER's id ⇒ declared, never verified", async () => {
    // The attack: the web session authenticates honestly as itself and
    // types the VPS's id into the URL.
    const { handlers, ws, connections } = connect(`${token}&device_id=dev-2`, {
      tokenDid: "web-session",
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]).toMatchObject({
      deviceId: "dev-2",
      deviceIdDeclared: true,
      deviceIdVerified: false,
    });
  });

  it("the master token proves no device ⇒ not verified", async () => {
    const { handlers, ws, connections } = connect("?token=master&device_id=dev-2", {
      master: true,
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]).toMatchObject({
      deviceIdDeclared: true,
      deviceIdVerified: false,
    });
  });

  it("device auth off ⇒ nothing was proven ⇒ not verified", async () => {
    const { handlers, ws, connections } = connect("?device_id=dev-2");
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]?.deviceIdVerified).toBe(false);
  });

  it("a token that FAILS verification never connects — its claims are never read", async () => {
    const { handlers, ws, connections } = connect(`${token}&device_id=forged-did`, {
      tokenDid: null,
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1") ?? []).toEqual([]);
  });

  it("proven through the post-connect auth frame too, not only the query token", async () => {
    const { handlers, ws, connections } = connect("?device_id=dev-2", { tokenDid: "dev-2" });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1") ?? []).toEqual([]); // waiting for the frame
    await handlers.onMessage(
      { data: JSON.stringify({ type: "auth", token: "a.signed.token" }) },
      ws,
    );
    expect(connections.get("mote-1")?.[0]?.deviceIdVerified).toBe(true);
  });
});

describe("a closed connection is reported, once, as it was", () => {
  it("hands the departed peer to onPeerClosed after removing it", async () => {
    const closed: ConnectedDevice[] = [];
    const { handlers, ws, connections } = connect(
      "?token=a.signed.token&device_id=dev-2&capabilities=unattended_runtime",
      { tokenDid: "dev-2" },
      closed,
    );
    await handlers.onOpen({}, ws);
    handlers.onClose({}, ws);
    expect(connections.get("mote-1") ?? []).toEqual([]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      deviceId: "dev-2",
      deviceIdVerified: true,
      capabilities: ["unattended_runtime"],
    });
    // A second close of the same socket reports nothing: it already left.
    handlers.onClose({}, ws);
    expect(closed).toHaveLength(1);
  });

  it("a socket that never finished authenticating was never a peer, and is not reported", async () => {
    const closed: ConnectedDevice[] = [];
    const { handlers, ws } = connect("?device_id=dev-2", { tokenDid: "dev-2" }, closed);
    await handlers.onOpen({}, ws); // waiting for the auth frame
    handlers.onClose({}, ws);
    expect(closed).toEqual([]);
  });
});
