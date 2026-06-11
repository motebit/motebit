/**
 * Defensive-branch coverage: every fail-closed path in the handshake,
 * the takeover mutex, and the raw-socket boundary. The happy paths live
 * in attach.test.ts / election.test.ts; this file is the adversarial
 * sibling — non-protocol squatters, malformed tokens, protocol abuse on
 * authenticated connections, contended takeovers.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, toBase64Url, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AttachRefusedError,
  CoordinatorUnreachableError,
  mintAttachToken,
  RuntimeHostClient,
} from "../client.js";
import {
  acquireTakeoverMutex,
  electRuntimeHost,
  probeSocketLive,
  releaseTakeoverMutex,
  type ElectRuntimeHostOptions,
} from "../election.js";
import { JsonLineDecoder } from "../protocol.js";
import { nodePlatform } from "../node-platform.js";

const platform = nodePlatform();
import {
  CoordinatorAlreadyBoundError,
  RuntimeHostServer,
  type RuntimeHostServerOptions,
} from "../server.js";

const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000003";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-hard-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function serverOptions(
  overrides: Partial<RuntimeHostServerOptions> = {},
): RuntimeHostServerOptions {
  return {
    platform,
    socketPath: join(dir, "runtime.sock"),
    lockfilePath: join(dir, "runtime.lock"),
    motebitId: MOTEBIT_ID,
    resolveDevicePublicKey: (deviceId) => (deviceId === DEVICE_ID ? keys.publicKey : null),
    // eslint-disable-next-line @typescript-eslint/require-await
    onInvoke: async function* () {
      yield "ok";
    },
    ...overrides,
  };
}

function mintOk(): Promise<string> {
  return mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey);
}

/** A non-protocol listener squatting the socket path. */
function listenRaw(socketPath: string, onConnection?: (socket: Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const accepted = new Set<Socket>();
    const server = createServer((socket) => {
      accepted.add(socket);
      socket.on("error", () => {});
      socket.resume(); // drain unread bytes so close events can fire
      onConnection?.(socket);
    });
    server.listen(socketPath, () => resolve(server));
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const socket of accepted) socket.destroy();
          server.close(() => done());
        }),
    );
  });
}

/** Raw connect + real handshake, for speaking protocol abuse afterwards. */
async function rawAttachedSocket(socketPath: string): Promise<Socket> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`${JSON.stringify({ t: "hello", protocol_version: 1, token: await mintOk() })}\n`);
  const decoder = new JsonLineDecoder();
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (data) => {
      const frames = decoder.push(data);
      for (const frame of frames) {
        if ((frame as { t: string }).t === "hello_ack") resolve();
        else reject(new Error(`unexpected ${JSON.stringify(frame)}`));
      }
    });
  });
  return socket;
}

const waitClose = (socket: Socket): Promise<void> =>
  new Promise((resolve) => socket.once("close", () => resolve()));

describe("probeSocketLive", () => {
  it("reports a live listener and a dead path", async () => {
    const path = join(dir, "probe.sock");
    expect(await probeSocketLive(platform, path, 100)).toBe(false);
    await listenRaw(path);
    expect(await probeSocketLive(platform, path, 100)).toBe(true);
  });
});

describe("acquireTakeoverMutex", () => {
  const probeAlive = (): boolean => true;
  const probeDead = (): boolean => false;

  it("acquires fresh, refuses a live holder, releases cleanly", async () => {
    const mutex = join(dir, "runtime.lock.takeover");
    expect(await acquireTakeoverMutex(platform, mutex, 100, probeAlive)).toBe(true);
    expect(await acquireTakeoverMutex(platform, mutex, 200, probeAlive)).toBe(false);
    await releaseTakeoverMutex(platform, mutex);
    expect(await acquireTakeoverMutex(platform, mutex, 200, probeAlive)).toBe(true);
    await releaseTakeoverMutex(platform, mutex);
  });

  it("steals a dead holder's mutex", async () => {
    const mutex = join(dir, "runtime.lock.takeover");
    expect(await acquireTakeoverMutex(platform, mutex, 100, probeDead)).toBe(true);
    expect(await acquireTakeoverMutex(platform, mutex, 200, probeDead)).toBe(true);
    await releaseTakeoverMutex(platform, mutex);
  });

  it("treats a holder mid-write (no pid file yet) as live", async () => {
    const mutex = join(dir, "runtime.lock.takeover");
    mkdirSync(mutex, { recursive: true });
    expect(await acquireTakeoverMutex(platform, mutex, 200, probeDead)).toBe(false);
  });

  it("ignores a garbage pid file via the integer guard", async () => {
    const mutex = join(dir, "runtime.lock.takeover");
    mkdirSync(mutex, { recursive: true });
    writeFileSync(join(mutex, "pid"), "not-a-pid");
    // NaN holder fails the integer guard → treated as dead → stolen.
    expect(await acquireTakeoverMutex(platform, mutex, 200, probeAlive)).toBe(true);
    await releaseTakeoverMutex(platform, mutex);
  });
});

describe("client boundary", () => {
  it("reports an empty path as unreachable", async () => {
    await expect(
      RuntimeHostClient.attach({
        platform,
        socketPath: join(dir, "absent.sock"),
        token: await mintOk(),
      }),
    ).rejects.toThrow(CoordinatorUnreachableError);
  });

  it("times out a listener that accepts but never answers", async () => {
    const path = join(dir, "silent.sock");
    await listenRaw(path);
    const err = await RuntimeHostClient.attach({
      platform,
      socketPath: path,
      token: await mintOk(),
      handshakeTimeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoordinatorUnreachableError);
    expect(((err as Error).cause as Error).message).toContain("handshake timeout");
  });

  it("reports a listener that hangs up mid-handshake as unreachable", async () => {
    const path = join(dir, "hangup.sock");
    await listenRaw(path, (socket) => socket.end());
    await expect(
      RuntimeHostClient.attach({ platform, socketPath: path, token: await mintOk() }),
    ).rejects.toThrow(CoordinatorUnreachableError);
  });

  it("rejects garbage first frames", async () => {
    const path = join(dir, "garbage.sock");
    await listenRaw(path, (socket) => socket.write("not json\n"));
    await expect(
      RuntimeHostClient.attach({ platform, socketPath: path, token: await mintOk() }),
    ).rejects.toThrow(/malformed coordinator frame/);
  });

  it("rejects an unexpected first frame type", async () => {
    const path = join(dir, "weird.sock");
    await listenRaw(path, (socket) =>
      socket.write(`${JSON.stringify({ t: "event", channel: "x", payload: 1 })}\n`),
    );
    await expect(
      RuntimeHostClient.attach({ platform, socketPath: path, token: await mintOk() }),
    ).rejects.toThrow(/unexpected first coordinator frame/);
  });

  it("refuses to invoke after close", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const client = await RuntimeHostClient.attach({
      platform,
      socketPath: serverOptions().socketPath,
      token: await mintOk(),
    });
    client.close();
    await expect(async () => {
      for await (const _ of client.invoke("c", "p")) {
        // unreachable
      }
    }).rejects.toThrow(/closed/);
  });

  it("shares one wire subscription across handlers on the same channel", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const client = await RuntimeHostClient.attach({
      platform,
      socketPath: serverOptions().socketPath,
      token: await mintOk(),
    });
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = client.subscribe("ch", (p) => a.push(p));
    const offB = client.subscribe("ch", (p) => b.push(p));
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.publishEvent("ch", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
    offA();
    server.publishEvent("ch", 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    offB();
    offB(); // double-unsubscribe is a no-op
    client.close();
  });
});

describe("server boundary", () => {
  it("throws CoordinatorAlreadyBoundError on a second bind", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    await expect(RuntimeHostServer.bind(serverOptions())).rejects.toThrow(
      CoordinatorAlreadyBoundError,
    );
  });

  it("wraps non-EADDRINUSE bind failures honestly", async () => {
    await expect(
      RuntimeHostServer.bind(
        serverOptions({ socketPath: join(dir, "no-such-dir", "deep", "runtime.sock") }),
      ),
    ).rejects.toThrow(/runtime-host bind failed/);
  });

  it("refuses a hello missing required fields", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = connect(serverOptions().socketPath);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ t: "hello" })}\n`);
    const decoder = new JsonLineDecoder();
    const frame = await new Promise<unknown>((resolve) => {
      socket.on("data", (data) => {
        const frames = decoder.push(data);
        if (frames.length > 0) resolve(frames[0]);
      });
    });
    expect(frame).toMatchObject({ t: "refuse", reason: "malformed_hello" });
    socket.destroy();
  });

  it("refuses a token whose payload is not an object", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const token = `${toBase64Url(new TextEncoder().encode(JSON.stringify("just-a-string")))}.sig`;
    const err = await RuntimeHostClient.attach({
      platform,
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachRefusedError);
    expect((err as AttachRefusedError).detail).toContain("malformed");
  });

  it("refuses a token payload missing claims", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const token = `${toBase64Url(new TextEncoder().encode(JSON.stringify({ mid: MOTEBIT_ID })))}.sig`;
    const err = await RuntimeHostClient.attach({
      platform,
      socketPath: serverOptions().socketPath,
      token,
    }).catch((e: unknown) => e);
    expect((err as AttachRefusedError).detail).toContain("malformed");
  });

  it("destroys a connection that re-hellos after attaching", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = await rawAttachedSocket(serverOptions().socketPath);
    expect(server.attachedCount).toBe(1);
    socket.write(`${JSON.stringify({ t: "hello", protocol_version: 1, token: await mintOk() })}\n`);
    await waitClose(socket);
    expect(server.attachedCount).toBe(0);
  });

  it("destroys an authenticated connection on a garbage frame", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = await rawAttachedSocket(serverOptions().socketPath);
    socket.write("garbage that is not json\n");
    await waitClose(socket);
    expect(server.attachedCount).toBe(0);
  });

  it("destroys on an invoke with non-string fields", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = await rawAttachedSocket(serverOptions().socketPath);
    socket.write(`${JSON.stringify({ t: "invoke", id: 5, capability: "c", prompt: "p" })}\n`);
    await waitClose(socket);
    expect(server.attachedCount).toBe(0);
  });

  it("destroys on an unknown post-auth message type", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = await rawAttachedSocket(serverOptions().socketPath);
    socket.write(`${JSON.stringify({ t: "totally-unknown" })}\n`);
    await waitClose(socket);
    expect(server.attachedCount).toBe(0);
  });

  it("times out a connection that never says hello", async () => {
    const server = await RuntimeHostServer.bind(serverOptions({ handshakeTimeoutMs: 30 }));
    cleanups.push(() => server.close());
    const socket = connect(serverOptions().socketPath);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    await waitClose(socket);
    expect(server.attachedCount).toBe(0);
  });

  it("ignores non-string subscribe channels and keeps the connection", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const socket = await rawAttachedSocket(serverOptions().socketPath);
    socket.write(`${JSON.stringify({ t: "subscribe", channel: 42 })}\n`);
    socket.write(`${JSON.stringify({ t: "subscribe", channel: "real" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.attachedCount).toBe(1);
    const decoder = new JsonLineDecoder();
    const eventFrame = new Promise<unknown>((resolve) => {
      socket.on("data", (data) => {
        for (const frame of decoder.push(data)) {
          if ((frame as { t: string }).t === "event") resolve(frame);
        }
      });
    });
    server.publishEvent("real", { ping: true });
    expect(await eventFrame).toMatchObject({
      t: "event",
      channel: "real",
      payload: { ping: true },
    });
    socket.destroy();
  });

  it("publishes into the void without error when nothing subscribes", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    expect(() => server.publishEvent("nobody", 1)).not.toThrow();
    await server.close(); // double-close is a no-op
  });
});

describe("impostor coordinator", () => {
  /** A listener that acks the handshake without verifying anything. */
  function listenImpostor(socketPath: string, afterAck: (socket: Socket) => void): Promise<Server> {
    return listenRaw(socketPath, (socket) => {
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({ t: "hello_ack", protocol_version: 1, coordinator_pid: 1 })}\n`,
        );
        afterAck(socket);
      });
    });
  }

  it("tears down on a malformed post-attach frame, failing in-flight invokes loudly", async () => {
    const path = join(dir, "impostor.sock");
    await listenImpostor(path, (socket) => {
      socket.on("data", () => socket.write("garbage after ack\n"));
    });
    const client = await RuntimeHostClient.attach({
      platform,
      socketPath: path,
      token: await mintOk(),
    });
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    await expect(async () => {
      for await (const _ of client.invoke("c", "p")) {
        // unreachable
      }
    }).rejects.toThrow(/malformed coordinator frame/);
    expect(closed).toBe(true);
  });

  it("ignores unknown server frame types without dying", async () => {
    const path = join(dir, "impostor2.sock");
    await listenImpostor(path, (socket) => {
      socket.write(`${JSON.stringify({ t: "totally-unknown", x: 1 })}\n`);
      socket.write(`${JSON.stringify({ t: "chunk", id: "no-such-invoke", chunk: 1 })}\n`);
      socket.write(`${JSON.stringify({ t: "end", id: "no-such-invoke" })}\n`);
      socket.write(
        `${JSON.stringify({ t: "invoke_error", id: "no-such-invoke", message: "x" })}\n`,
      );
      socket.write(`${JSON.stringify({ t: "event", channel: "unsubscribed", payload: 1 })}\n`);
    });
    const client = await RuntimeHostClient.attach({
      platform,
      socketPath: path,
      token: await mintOk(),
    });
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(closed).toBe(false);
    client.close();
  });
});

describe("election under adversity", () => {
  function electionOptions(
    overrides: Partial<ElectRuntimeHostOptions> = {},
  ): ElectRuntimeHostOptions {
    return {
      ...serverOptions(),
      mintToken: mintOk,
      retryDelayMs: 20,
      handshakeTimeoutMs: 60,
      ...overrides,
    };
  }

  it("does not converge onto a silent squatter — and never unlinks its live socket", async () => {
    const opts = electionOptions({ maxAttempts: 2 });
    await listenRaw(opts.socketPath);
    await expect(electRuntimeHost(opts)).rejects.toThrow(/did not converge/);
    // The squatter's socket file must survive: live sockets are never unlinked.
    expect(existsSync(opts.socketPath)).toBe(true);
  });

  it("waits out a contended takeover mutex instead of binding", async () => {
    const opts = electionOptions({ maxAttempts: 2 });
    const mutex = `${opts.lockfilePath}.takeover`;
    mkdirSync(mutex, { recursive: true });
    writeFileSync(join(mutex, "pid"), String(process.pid));
    await expect(electRuntimeHost(opts)).rejects.toThrow(/did not converge/);
    expect(existsSync(mutex)).toBe(true);
  });

  it("wraps a non-protocol attach failure with context", async () => {
    const opts = electionOptions();
    await listenRaw(opts.socketPath, (socket) => socket.write("broken\n"));
    await expect(electRuntimeHost(opts)).rejects.toThrow(/runtime-host attach failed/);
  });

  it("rethrows a takeover bind failure instead of looping", async () => {
    const opts = electionOptions({
      socketPath: join(dir, "no-such-dir", "runtime.sock"),
      maxAttempts: 1,
    });
    await expect(electRuntimeHost(opts)).rejects.toThrow(/runtime-host bind failed/);
  });
});

describe("invalid token encodings", () => {
  it("refuses a token whose payload is not base64url", async () => {
    const server = await RuntimeHostServer.bind(serverOptions());
    cleanups.push(() => server.close());
    const err = await RuntimeHostClient.attach({
      platform,
      socketPath: serverOptions().socketPath,
      token: "!!!not-base64!!!.sig",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachRefusedError);
    expect((err as AttachRefusedError).detail).toContain("malformed");
  });
});
