/**
 * The socket's half of a composed answer: WHO an answer is from.
 *
 * `command-route` composes one line per machine and trusts the `from`
 * it is handed. The multi-runtime harness supplies that value itself,
 * so it proves what the relay does WITH an attribution and nothing
 * about where a real one comes from. This drives the real handler: the
 * attribution must be the device id the connection was upgraded with,
 * and nothing the frame says about itself.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerWebSocketRoutes } from "../websocket.js";
import type { WebSocketDeps, ConnectedDevice } from "../websocket.js";

type Heard = Array<[string, unknown, { motebitId: string; deviceId: string } | undefined]>;

/** How the socket authenticates, per test. */
interface Auth {
  /** Device auth on, and the signed token's `did`. `null` ⇒ it fails to verify. */
  tokenDid?: string | null;
  /** The relay's master token, and whether the socket presents it. */
  master?: boolean;
}

interface Handlers {
  onOpen(event: unknown, ws: unknown): Promise<void>;
  onMessage(event: { data: string }, ws: unknown): Promise<void>;
}

/** Upgrade one connection through the real route and return its handlers. */
function connect(query: string, heard: Heard, auth: Auth = {}) {
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
    onCommandResponse: (id: string, result: unknown, from?: Heard[number][2]) => {
      heard.push([id, result, from]);
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

describe("a command_response is attributed by its connection", () => {
  it("hands on the device id the socket DECLARED at upgrade", async () => {
    const heard: Heard = [];
    const { handlers, ws, connections } = connect("?device_id=dev-2", heard);
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]?.deviceId).toBe("dev-2");

    await handlers.onMessage(
      {
        data: JSON.stringify({ type: "command_response", id: "cmd-1", result: { summary: "ok" } }),
      },
      ws,
    );
    expect(heard).toEqual([
      ["cmd-1", { summary: "ok" }, { motebitId: "mote-1", deviceId: "dev-2" }],
    ]);
  });

  it("ignores what the frame claims about where it came from", async () => {
    // One runtime must not be able to answer in another machine's name.
    const heard: Heard = [];
    const { handlers, ws } = connect("?device_id=dev-2", heard);
    await handlers.onOpen({}, ws);
    await handlers.onMessage(
      {
        data: JSON.stringify({
          type: "command_response",
          id: "cmd-1",
          result: { summary: "ok" },
          from: "dev-1",
          device_id: "dev-1",
        }),
      },
      ws,
    );
    expect(heard[0]?.[2]).toEqual({ motebitId: "mote-1", deviceId: "dev-2" });
  });

  it("an UNDECLARED socket is attributed to its relay-invented id, which no question is aimed at", async () => {
    const heard: Heard = [];
    const { handlers, ws, connections } = connect("", heard);
    await handlers.onOpen({}, ws);
    const invented = connections.get("mote-1")?.[0];
    expect(invented?.deviceIdDeclared).toBe(false);
    await handlers.onMessage(
      { data: JSON.stringify({ type: "command_response", id: "cmd-1", result: null }) },
      ws,
    );
    expect(heard[0]?.[2]?.deviceId).toBe(invented?.deviceId);
  });
});

describe("a declared device id is VERIFIED only when the signed token proves it", () => {
  // `?device_id=` is a query string. A composed answer files each reply
  // under a device id and may call the picture whole, so the id has to
  // have been proven by a key registered to that device — otherwise any
  // surface holding a sync token could answer in another machine's name.
  const token = "?token=a.signed.token";

  it("declared id === the token's did ⇒ verified", async () => {
    const { handlers, ws, connections } = connect(`${token}&device_id=dev-2`, [], {
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
    const { handlers, ws, connections } = connect(`${token}&device_id=dev-2`, [], {
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
    const { handlers, ws, connections } = connect("?token=master&device_id=dev-2", [], {
      master: true,
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]).toMatchObject({
      deviceIdDeclared: true,
      deviceIdVerified: false,
    });
  });

  it("device auth off ⇒ nothing was proven ⇒ not verified", async () => {
    const { handlers, ws, connections } = connect("?device_id=dev-2", []);
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]?.deviceIdVerified).toBe(false);
  });

  it("a token that FAILS verification never connects — its claims are never read", async () => {
    const { handlers, ws, connections } = connect(`${token}&device_id=forged-did`, [], {
      tokenDid: null,
    });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1") ?? []).toEqual([]);
  });

  it("proven through the post-connect auth frame too, not only the query token", async () => {
    const { handlers, ws, connections } = connect("?device_id=dev-2", [], { tokenDid: "dev-2" });
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1") ?? []).toEqual([]); // waiting for the frame
    await handlers.onMessage(
      { data: JSON.stringify({ type: "auth", token: "a.signed.token" }) },
      ws,
    );
    expect(connections.get("mote-1")?.[0]?.deviceIdVerified).toBe(true);
  });
});
