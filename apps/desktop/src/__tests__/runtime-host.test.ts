/**
 * Desktop runtime-host glue: the bridged organ handlers (the desktop's
 * unique capabilities contributed to a coordinator) and the Tauri
 * platform adapter that lets the package's single TS protocol
 * implementation run in the webview over the Rust dumb pipe.
 */
import { describe, expect, it, vi } from "vitest";
import { desktopOrganHandlers } from "../runtime-host.js";
import { createTauriRuntimeHostPlatform } from "../runtime-host-platform.js";
import type { InvokeFn } from "../tauri-storage.js";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));

type Call = { cmd: string; args: Record<string, unknown> | undefined };

type FakeResponder =
  | ((args: Record<string, unknown> | undefined) => unknown)
  | object
  | string
  | number
  | boolean
  | null;

function fakeInvoke(responses: Record<string, FakeResponder>): {
  invoke: InvokeFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const responder = responses[cmd];
    if (responder === undefined) throw new Error(`no fake for ${cmd}`);
    const value = typeof responder === "function" ? responder(args) : responder;
    if (value instanceof Error) throw value;
    return value;
  }) as InvokeFn;
  return { invoke, calls };
}

const collect = async (gen: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
};

describe("desktopOrganHandlers", () => {
  const identity = {
    motebitId: "m-1",
    deviceId: "d-1",
    identityPublicKeyHex: "ab".repeat(32),
  };

  it("mints an SE attestation with the caller's attested_at", async () => {
    const { invoke, calls } = fakeInvoke({
      se_mint_attestation: { body_base64: "Ym9keQ", signature_der_base64: "c2ln" },
    });
    const handlers = desktopOrganHandlers({ invoke, ...identity });
    const handler = handlers["se_attestation"];
    if (handler === undefined) throw new Error("se_attestation missing");
    const chunks = await collect(
      handler("", { attested_at: 1234 }, { signal: new AbortController().signal }),
    );
    expect(chunks).toEqual([{ body_base64: "Ym9keQ", signature_der_base64: "c2ln" }]);
    expect(calls[0]).toEqual({
      cmd: "se_mint_attestation",
      args: {
        motebitId: "m-1",
        deviceId: "d-1",
        identityPublicKeyHex: identity.identityPublicKeyHex,
        attestedAt: 1234,
      },
    });
  });

  it("defaults attested_at to now when the caller omits it", async () => {
    const { invoke, calls } = fakeInvoke({ se_mint_attestation: { ok: true } });
    const handlers = desktopOrganHandlers({ invoke, ...identity });
    const handler = handlers["se_attestation"];
    if (handler === undefined) throw new Error("se_attestation missing");
    const before = Date.now();
    await collect(handler("", undefined, { signal: new AbortController().signal }));
    const attestedAt = calls[0]?.args?.["attestedAt"];
    expect(typeof attestedAt).toBe("number");
    expect(attestedAt as number).toBeGreaterThanOrEqual(before);
  });

  it("requires options.action for computer_use and forwards it verbatim", async () => {
    const { invoke, calls } = fakeInvoke({ computer_execute: { kind: "screenshot" } });
    const handlers = desktopOrganHandlers({ invoke, ...identity });
    const handler = handlers["computer_use"];
    if (handler === undefined) throw new Error("computer_use missing");

    await expect(
      collect(handler("", undefined, { signal: new AbortController().signal })),
    ).rejects.toThrow(/requires options.action/);

    const action = { kind: "click", x: 1, y: 2 };
    const chunks = await collect(handler("", { action }, { signal: new AbortController().signal }));
    expect(chunks).toEqual([{ kind: "screenshot" }]);
    expect(calls[0]).toEqual({ cmd: "computer_execute", args: { action } });
  });
});

describe("createTauriRuntimeHostPlatform", () => {
  it("exposes pid/home from runtime_host_meta and the fs/pid primitives", async () => {
    const { invoke, calls } = fakeInvoke({
      runtime_host_meta: { pid: 777, home: "/Users/t" },
      runtime_host_read_file: (args: Record<string, unknown> | undefined) =>
        args?.["path"] === "/ok" ? "content" : null,
      runtime_host_write_file: null,
      runtime_host_remove_file: null,
      runtime_host_mkdir_exclusive: "created",
      runtime_host_remove_dir: null,
      runtime_host_pid_alive: (args: Record<string, unknown> | undefined) => args?.["pid"] === 777,
    });
    const { platform, home } = await createTauriRuntimeHostPlatform(invoke);
    expect(home).toBe("/Users/t");
    expect(platform.pid).toBe(777);

    expect(await platform.readFile("/ok")).toBe("content");
    expect(await platform.readFile("/absent")).toBeNull();
    await platform.writeFile("/f", "x");
    await platform.removeFile("/f");
    expect(await platform.mkdirExclusive("/m")).toBe("created");
    await platform.removeDir("/m");
    expect(await platform.isPidAlive(777)).toBe(true);
    expect(await platform.isPidAlive(1)).toBe(false);
    expect(calls.some((c) => c.cmd === "runtime_host_write_file")).toBe(true);
  });

  it("maps a refused connect to null and an in-use bind to 'in_use'", async () => {
    const { invoke } = fakeInvoke({
      runtime_host_meta: { pid: 1, home: "/h" },
      runtime_host_connect: new Error("unreachable"),
      runtime_host_bind: "in_use",
    });
    const { platform } = await createTauriRuntimeHostPlatform(invoke);
    expect(await platform.connect("/h/.motebit/runtime.sock", 100)).toBeNull();
    expect(await platform.bind("/h/.motebit/runtime.sock")).toBe("in_use");
  });

  it("streams channel data/close events into the FrameConnection and orders writes", async () => {
    const channelBox: { ch: { onmessage: (m: unknown) => void } | null } = { ch: null };
    const sent: string[] = [];
    const { invoke } = fakeInvoke({
      runtime_host_meta: { pid: 1, home: "/h" },
      runtime_host_connect: (args: Record<string, unknown> | undefined) => {
        channelBox.ch = args?.["onEvent"] as { onmessage: (m: unknown) => void };
        return 42;
      },
      runtime_host_send: (args: Record<string, unknown> | undefined) => {
        sent.push(args?.["data"] as string);
        return null;
      },
      runtime_host_close: null,
    });
    const { platform } = await createTauriRuntimeHostPlatform(invoke);
    const conn = await platform.connect("/h/.motebit/runtime.sock", 100);
    if (conn === null) throw new Error("connect should succeed");
    expect(channelBox.ch).not.toBeNull();

    const received: string[] = [];
    let closed = false;
    conn.onData((d) => received.push(d as string));
    conn.onClose(() => {
      closed = true;
    });

    conn.send("a\n");
    conn.send("b\n");
    channelBox.ch?.onmessage({ type: "data", conn_id: 42, data: "reply\n" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual(["a\n", "b\n"]);
    expect(received).toEqual(["reply\n"]);

    channelBox.ch?.onmessage({ type: "close", conn_id: 42 });
    expect(closed).toBe(true);
    expect(conn.destroyed).toBe(true);
  });

  it("delivers accepted connections through a bound listener", async () => {
    const channelBox: { ch: { onmessage: (m: unknown) => void } | null } = { ch: null };
    const { invoke } = fakeInvoke({
      runtime_host_meta: { pid: 1, home: "/h" },
      runtime_host_bind: (args: Record<string, unknown> | undefined) => {
        channelBox.ch = args?.["onEvent"] as { onmessage: (m: unknown) => void };
        return "bound";
      },
      runtime_host_send: null,
      runtime_host_close: null,
      runtime_host_unbind: null,
    });
    const { platform } = await createTauriRuntimeHostPlatform(invoke);
    const listener = await platform.bind("/h/.motebit/runtime.sock");
    if (listener === "in_use") throw new Error("bind should succeed");

    const conns: unknown[] = [];
    const received: string[] = [];
    listener.onConnection((conn) => {
      conns.push(conn);
      conn.onData((d) => received.push(d as string));
    });
    channelBox.ch?.onmessage({ type: "connection", conn_id: 1_000_001 });
    expect(conns).toHaveLength(1);
    channelBox.ch?.onmessage({ type: "data", conn_id: 1_000_001, data: "hello\n" });
    expect(received).toEqual(["hello\n"]);
    await listener.close();
  });
});
