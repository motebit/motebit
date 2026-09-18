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

interface Handlers {
  onOpen(event: unknown, ws: unknown): Promise<void>;
  onMessage(event: { data: string }, ws: unknown): Promise<void>;
}

/** Upgrade one connection through the real route and return its handlers. */
function connect(query: string, heard: Array<[string, unknown, string | undefined]>) {
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
    apiToken: undefined,
    enableDeviceAuth: false,
    wsLimiter: { check: () => ({ allowed: true }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onCommandResponse: (id: string, result: unknown, from?: string) => {
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
    const heard: Array<[string, unknown, string | undefined]> = [];
    const { handlers, ws, connections } = connect("?device_id=dev-2", heard);
    await handlers.onOpen({}, ws);
    expect(connections.get("mote-1")?.[0]?.deviceId).toBe("dev-2");

    await handlers.onMessage(
      {
        data: JSON.stringify({ type: "command_response", id: "cmd-1", result: { summary: "ok" } }),
      },
      ws,
    );
    expect(heard).toEqual([["cmd-1", { summary: "ok" }, "dev-2"]]);
  });

  it("ignores what the frame claims about where it came from", async () => {
    // One runtime must not be able to answer in another machine's name.
    const heard: Array<[string, unknown, string | undefined]> = [];
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
    expect(heard[0]?.[2]).toBe("dev-2");
  });

  it("an UNDECLARED socket is attributed to its relay-invented id, which no question is aimed at", async () => {
    const heard: Array<[string, unknown, string | undefined]> = [];
    const { handlers, ws, connections } = connect("", heard);
    await handlers.onOpen({}, ws);
    const invented = connections.get("mote-1")?.[0];
    expect(invented?.deviceIdDeclared).toBe(false);
    await handlers.onMessage(
      { data: JSON.stringify({ type: "command_response", id: "cmd-1", result: null }) },
      ws,
    );
    expect(heard[0]?.[2]).toBe(invented?.deviceId);
  });
});
