import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttachRefusedError, mintAttachToken, RuntimeHostClient } from "../client.js";
import { RuntimeHostServer, type RuntimeHostServerOptions } from "../server.js";

const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000001";
const DEVICE_ID = "device-1";

let keys: KeyPair;
let strangerKeys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
  strangerKeys = await generateKeypair();
});

let dir: string;
let server: RuntimeHostServer | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-"));
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function serverOptions(
  overrides: Partial<RuntimeHostServerOptions> = {},
): RuntimeHostServerOptions {
  return {
    socketPath: join(dir, "runtime.sock"),
    lockfilePath: join(dir, "runtime.lock"),
    motebitId: MOTEBIT_ID,
    resolveDevicePublicKey: (deviceId) => (deviceId === DEVICE_ID ? keys.publicKey : null),
    // eslint-disable-next-line @typescript-eslint/require-await
    onInvoke: async function* (capability, prompt) {
      yield { echo: `${capability}:${prompt}` };
    },
    ...overrides,
  };
}

async function attachOk(socketPath: string): Promise<RuntimeHostClient> {
  return RuntimeHostClient.attach({
    socketPath,
    token: await mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
  });
}

describe("attach handshake", () => {
  it("accepts a device-key-signed token and reports the coordinator pid", async () => {
    server = await RuntimeHostServer.bind(serverOptions({ pid: 4242 }));
    const client = await attachOk(serverOptions().socketPath);
    expect(client.coordinatorPid).toBe(4242);
    expect(server.attachedCount).toBe(1);
    client.close();
  });

  it("refuses a token signed by the wrong key", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const token = await mintAttachToken(
      { motebitId: MOTEBIT_ID, deviceId: DEVICE_ID },
      strangerKeys.privateKey,
    );
    await expect(
      RuntimeHostClient.attach({ socketPath: serverOptions().socketPath, token }),
    ).rejects.toThrow(AttachRefusedError);
  });

  it("refuses a token for an unknown device", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const token = await mintAttachToken(
      { motebitId: MOTEBIT_ID, deviceId: "device-unknown" },
      keys.privateKey,
    );
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachRefusedError);
    expect((err as AttachRefusedError).reason).toBe("auth_failed");
    expect((err as AttachRefusedError).detail).toContain("unknown device");
  });

  it("refuses a token for a different motebit identity", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const token = await mintAttachToken(
      { motebitId: "someone-else", deviceId: DEVICE_ID },
      keys.privateKey,
    );
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect((err as AttachRefusedError).detail).toContain("different motebit identity");
  });

  it("refuses a token minted for another audience", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const { createSignedToken } = await import("@motebit/crypto");
    const token = await createSignedToken(
      {
        mid: MOTEBIT_ID,
        did: DEVICE_ID,
        iat: Date.now(),
        exp: Date.now() + 30_000,
        jti: "test-jti",
        aud: "sync",
      },
      keys.privateKey,
    );
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect((err as AttachRefusedError).reason).toBe("auth_failed");
    expect((err as AttachRefusedError).detail).toContain("audience");
  });

  it("refuses an expired token", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const token = await mintAttachToken(
      { motebitId: MOTEBIT_ID, deviceId: DEVICE_ID },
      keys.privateKey,
      { ttlMs: -1000 },
    );
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect((err as AttachRefusedError).detail).toContain("expired");
  });

  it("refuses a malformed token", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token: "garbage",
    }).catch((e: unknown) => e);
    expect((err as AttachRefusedError).detail).toContain("malformed");
  });

  it("refuses when device-key resolution throws (fail-closed)", async () => {
    const warned: string[] = [];
    server = await RuntimeHostServer.bind(
      serverOptions({
        resolveDevicePublicKey: () => {
          throw new Error("store offline");
        },
        logger: { warn: (msg) => warned.push(msg) },
      }),
    );
    const err = await attachOk(serverOptions().socketPath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachRefusedError);
    expect(warned.some((m) => m.includes("device key resolution failed"))).toBe(true);
  });

  it("refuses version skew, naming both versions", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const token = await mintAttachToken(
      { motebitId: MOTEBIT_ID, deviceId: DEVICE_ID },
      keys.privateKey,
    );
    const err = await RuntimeHostClient.attach({
      socketPath: serverOptions().socketPath,
      token,
      protocolVersion: 999,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachRefusedError);
    expect((err as AttachRefusedError).reason).toBe("version_skew");
    expect((err as AttachRefusedError).detail).toContain("v999");
    expect((err as AttachRefusedError).detail).toContain("v1");
  });
});

describe("capability proxying", () => {
  it("streams chunks then end", async () => {
    server = await RuntimeHostServer.bind(
      serverOptions({
        // eslint-disable-next-line @typescript-eslint/require-await
        onInvoke: async function* (capability, prompt, options) {
          yield { n: 1, capability };
          yield { n: 2, prompt };
          yield { n: 3, options };
        },
      }),
    );
    const client = await attachOk(serverOptions().socketPath);
    const chunks: unknown[] = [];
    for await (const chunk of client.invoke("review_pr", "do it", { origin: "user-tap" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { n: 1, capability: "review_pr" },
      { n: 2, prompt: "do it" },
      { n: 3, options: { origin: "user-tap" } },
    ]);
    client.close();
  });

  it("surfaces handler failure as a thrown invoke error", async () => {
    server = await RuntimeHostServer.bind(
      serverOptions({
        // eslint-disable-next-line @typescript-eslint/require-await
        onInvoke: async function* () {
          yield 1;
          throw new Error("capability exploded");
        },
      }),
    );
    const client = await attachOk(serverOptions().socketPath);
    const received: unknown[] = [];
    await expect(async () => {
      for await (const chunk of client.invoke("boom", "x")) received.push(chunk);
    }).rejects.toThrow("capability exploded");
    expect(received).toEqual([1]);
    client.close();
  });

  it("runs concurrent invocations without crosstalk", async () => {
    server = await RuntimeHostServer.bind(
      serverOptions({
        onInvoke: async function* (capability) {
          await new Promise((resolve) => setTimeout(resolve, capability === "slow" ? 30 : 1));
          yield capability;
        },
      }),
    );
    const client = await attachOk(serverOptions().socketPath);
    const collect = async (capability: string): Promise<unknown[]> => {
      const out: unknown[] = [];
      for await (const chunk of client.invoke(capability, "")) out.push(chunk);
      return out;
    };
    const [slow, fast] = await Promise.all([collect("slow"), collect("fast")]);
    expect(slow).toEqual(["slow"]);
    expect(fast).toEqual(["fast"]);
    client.close();
  });

  it("aborts the in-flight handler when the frontend disconnects", async () => {
    let aborted = false;
    let started: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    server = await RuntimeHostServer.bind(
      serverOptions({
        onInvoke: async function* (_c, _p, _o, ctx) {
          started?.();
          yield 1;
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          });
        },
      }),
    );
    const client = await attachOk(serverOptions().socketPath);
    const consumer = (async () => {
      try {
        for await (const _ of client.invoke("hang", "")) {
          // first chunk arrives, then we drop the connection
          break;
        }
      } catch {
        // teardown race is acceptable; the assertion is the abort
      }
    })();
    await startedPromise;
    await consumer;
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(true);
  });
});

describe("events", () => {
  it("delivers published events to subscribed frontends only", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const client = await attachOk(serverOptions().socketPath);
    const received: unknown[] = [];
    const unsubscribe = client.subscribe("presence", (payload) => received.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.publishEvent("presence", { mode: "tending" });
    server.publishEvent("other-channel", { mode: "ignored" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([{ mode: "tending" }]);

    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.publishEvent("presence", { mode: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([{ mode: "tending" }]);
    client.close();
  });
});

describe("boundary discipline", () => {
  it("destroys a connection that speaks before authenticating", async () => {
    server = await RuntimeHostServer.bind(serverOptions());
    const { connect } = await import("node:net");
    const socket = connect(serverOptions().socketPath);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ t: "invoke", id: "x", capability: "c", prompt: "p" })}\n`);
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    expect(server.attachedCount).toBe(0);
  });

  it("fires onClose and fails in-flight invocations when the coordinator exits", async () => {
    server = await RuntimeHostServer.bind(
      serverOptions({
        onInvoke: async function* () {
          yield 1;
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        },
      }),
    );
    const client = await attachOk(serverOptions().socketPath);
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    const consuming = (async () => {
      const out: unknown[] = [];
      for await (const chunk of client.invoke("hang", "")) out.push(chunk);
      return out;
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.close();
    server = null;
    await expect(consuming).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
