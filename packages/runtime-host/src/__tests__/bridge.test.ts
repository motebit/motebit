/**
 * Capability bridging — the half of the election doctrine that makes
 * the outcome operationally neutral: an attached frontend's unique
 * organs (desktop SE-attest, computer-use) stay reachable through the
 * coordinator via the bridge_invoke reverse channel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintAttachToken, RuntimeHostClient } from "../client.js";
import { nodePlatform } from "../node-platform.js";
import { JsonLineDecoder } from "../protocol.js";
import { RuntimeHostServer, type RuntimeHostServerOptions } from "../server.js";

const platform = nodePlatform();
const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000005";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-bridge-"));
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

const mintOk = (): Promise<string> =>
  mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey);

async function bindServer(): Promise<RuntimeHostServer> {
  const server = await RuntimeHostServer.bind(serverOptions());
  cleanups.push(() => server.close());
  return server;
}

async function attachClient(
  capabilities?: Parameters<typeof RuntimeHostClient.attach>[0]["capabilities"],
): Promise<RuntimeHostClient> {
  const client = await RuntimeHostClient.attach({
    platform,
    socketPath: serverOptions().socketPath,
    token: await mintOk(),
    capabilities,
  });
  cleanups.push(() => client.close());
  return client;
}

const collect = async (gen: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
};

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("capability bridging", () => {
  it("invokes a frontend-contributed organ through the coordinator", async () => {
    const server = await bindServer();
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      se_attestation: async function* (prompt, options) {
        yield { body: `attested:${prompt}`, options };
      },
    });
    await tick();
    expect(server.bridgedCapabilities).toEqual(["se_attestation"]);

    const chunks = await collect(server.invokeBridged("se_attestation", "key-hex", { at: 1 }));
    expect(chunks).toEqual([{ body: "attested:key-hex", options: { at: 1 } }]);
  });

  it("errors honestly when no frontend contributes the capability", async () => {
    const server = await bindServer();
    await attachClient(); // no capabilities
    await tick();
    await expect(collect(server.invokeBridged("computer_use", "click"))).rejects.toThrow(
      /no attached frontend contributes/,
    );
  });

  it("surfaces a frontend handler failure as a thrown error", async () => {
    const server = await bindServer();
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      boom: async function* () {
        yield 1;
        throw new Error("enclave said no");
      },
    });
    await tick();
    const received: unknown[] = [];
    await expect(async () => {
      for await (const chunk of server.invokeBridged("boom", "")) received.push(chunk);
    }).rejects.toThrow("enclave said no");
    expect(received).toEqual([1]);
  });

  it("fails an in-flight bridged invocation loudly when the contributor disconnects", async () => {
    const server = await bindServer();
    let started: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = await attachClient({
      boomless: async function* (_p, _o, ctx) {
        started?.();
        yield 1;
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve());
        });
      },
    });
    await tick();
    const consuming = collect(server.invokeBridged("boomless", ""));
    await startedPromise;
    client.close();
    await expect(consuming).rejects.toThrow(/disconnected mid-invocation/);
    expect(server.bridgedCapabilities).toEqual([]);
  });

  it("re-registration replaces the contributed set; last registrar wins across frontends", async () => {
    const server = await bindServer();
    const a = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      organ: async function* () {
        yield "from-a";
      },
    });
    await tick();
    const b = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      organ: async function* () {
        yield "from-b";
      },
    });
    await tick();
    expect(await collect(server.invokeBridged("organ", ""))).toEqual(["from-b"]);

    // b withdraws; the organ disappears (a's registration was displaced).
    b.setBridgedCapabilities({});
    await tick();
    expect(server.bridgedCapabilities).toEqual([]);

    // a re-registers and is reachable again.
    a.setBridgedCapabilities({
      // eslint-disable-next-line @typescript-eslint/require-await
      organ: async function* () {
        yield "from-a-again";
      },
    });
    await tick();
    expect(await collect(server.invokeBridged("organ", ""))).toEqual(["from-a-again"]);
  });

  it("a frontend answers a bridged capability it no longer holds with bridge_error", async () => {
    const server = await bindServer();
    const client = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      organ: async function* () {
        yield 1;
      },
    });
    await tick();
    // Local handlers drop but the coordinator hasn't heard yet — the
    // frontend must answer bridge_error, not hang.
    (client as unknown as { capabilityHandlers: Map<string, unknown> }).capabilityHandlers =
      new Map();
    await expect(collect(server.invokeBridged("organ", ""))).rejects.toThrow(/not contributed/);
  });

  it("ignores another connection's attempt to answer a bridged invocation", async () => {
    const server = await bindServer();
    const release: { fn: (() => void) | null } = { fn: null };
    await attachClient({
      slow_organ: async function* () {
        await new Promise<void>((resolve) => {
          release.fn = resolve;
        });
        yield "honest-answer";
      },
    });
    await tick();

    // A second, fully authenticated connection tries to inject chunks
    // into the first frontend's in-flight bridge id.
    const attacker: Socket = connect(serverOptions().socketPath);
    await new Promise<void>((resolve) => attacker.once("connect", () => resolve()));
    attacker.write(
      `${JSON.stringify({ t: "hello", protocol_version: 1, token: await mintOk() })}\n`,
    );
    const decoder = new JsonLineDecoder();
    await new Promise<void>((resolve) => {
      attacker.on("data", (data) => {
        for (const frame of decoder.push(data)) {
          if ((frame as { t: string }).t === "hello_ack") resolve();
        }
      });
    });
    cleanups.push(() => {
      attacker.destroy();
    });

    const consuming = collect(server.invokeBridged("slow_organ", ""));
    await tick();
    // The server numbers bridge ids sequentially; the first is bridge-1.
    attacker.write(`${JSON.stringify({ t: "bridge_chunk", id: "bridge-1", chunk: "forged" })}\n`);
    attacker.write(`${JSON.stringify({ t: "bridge_end", id: "bridge-1" })}\n`);
    await tick();
    release.fn?.();
    expect(await consuming).toEqual(["honest-answer"]);
  });
});
