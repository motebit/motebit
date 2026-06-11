/**
 * The conversational seams added for CLI adoption (increment 2): chat
 * and approval-resolution proxying, the hook-absent honest refusals,
 * and the election's probe-before-mint ordering.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintAttachToken, RuntimeHostClient } from "../client.js";
import { electRuntimeHost, type ElectRuntimeHostOptions } from "../election.js";
import { RuntimeHostServer, type RuntimeHostServerOptions } from "../server.js";

const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000004";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-chat-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
    onInvoke: async function* () {
      yield "ok";
    },
    ...overrides,
  };
}

async function bindAndAttach(
  overrides: Partial<RuntimeHostServerOptions> = {},
): Promise<{ server: RuntimeHostServer; client: RuntimeHostClient }> {
  const server = await RuntimeHostServer.bind(serverOptions(overrides));
  cleanups.push(() => server.close());
  const client = await RuntimeHostClient.attach({
    socketPath: serverOptions().socketPath,
    token: await mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
  });
  cleanups.push(() => client.close());
  return { server, client };
}

const collect = async (gen: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
};

describe("chat proxying", () => {
  it("streams a conversational turn through the coordinator", async () => {
    const { client } = await bindAndAttach({
      // eslint-disable-next-line @typescript-eslint/require-await
      onChat: async function* (text, options) {
        yield { type: "text", text: `echo:${text}` };
        yield { type: "result", options };
      },
    });
    const chunks = await collect(client.chat("hello", { suppressHistory: true }));
    expect(chunks).toEqual([
      { type: "text", text: "echo:hello" },
      { type: "result", options: { suppressHistory: true } },
    ]);
  });

  it("answers invoke_error when the coordinator does not proxy chat", async () => {
    const { client } = await bindAndAttach(); // no onChat
    await expect(collect(client.chat("hello"))).rejects.toThrow(/does not proxy chat/);
  });

  it("surfaces a chat handler throw (e.g. already-processing) loudly", async () => {
    const { client } = await bindAndAttach({
      // eslint-disable-next-line @typescript-eslint/require-await
      onChat: async function* () {
        throw new Error("Already processing a message");
        yield 0; // unreachable; keeps this a generator
      },
    });
    await expect(collect(client.chat("hi"))).rejects.toThrow(/Already processing/);
  });
});

describe("approval resolution proxying", () => {
  it("streams the continuation turn after an approval round-trip", async () => {
    const received: Array<{ approved: boolean; approverId: string }> = [];
    const { client } = await bindAndAttach({
      // eslint-disable-next-line @typescript-eslint/require-await
      onChat: async function* () {
        yield {
          type: "approval_request",
          tool_call_id: "tc-1",
          name: "write_file",
          args: { path: "/tmp/x" },
        };
        // The in-process contract: the turn pauses here; the stream ends.
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      onResolveApproval: async function* (approved, approverId) {
        received.push({ approved, approverId });
        yield { type: "text", text: approved ? "tool ran" : "denied" };
      },
    });

    const turn = await collect(client.chat("do the thing"));
    expect(turn).toEqual([
      {
        type: "approval_request",
        tool_call_id: "tc-1",
        name: "write_file",
        args: { path: "/tmp/x" },
      },
    ]);

    const continuation = await collect(client.resolveApproval(true, MOTEBIT_ID));
    expect(continuation).toEqual([{ type: "text", text: "tool ran" }]);
    expect(received).toEqual([{ approved: true, approverId: MOTEBIT_ID }]);
  });

  it("answers invoke_error when approval resolution is not proxied", async () => {
    const { client } = await bindAndAttach(); // no onResolveApproval
    await expect(collect(client.resolveApproval(false, MOTEBIT_ID))).rejects.toThrow(
      /does not proxy approval/,
    );
  });
});

describe("election probe-before-mint", () => {
  function electionOptions(
    overrides: Partial<ElectRuntimeHostOptions> = {},
  ): ElectRuntimeHostOptions {
    return {
      ...serverOptions(),
      mintToken: () =>
        mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
      retryDelayMs: 20,
      handshakeTimeoutMs: 60,
      ...overrides,
    };
  }

  it("becomes coordinator without ever minting when nothing listens", async () => {
    let minted = 0;
    const outcome = await electRuntimeHost(
      electionOptions({
        mintToken: () => {
          minted += 1;
          throw new Error("signing key locked");
        },
      }),
    );
    expect(outcome.role).toBe("coordinator");
    if (outcome.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => outcome.server.close());
    expect(minted).toBe(0);
  });

  it("fails honestly when a coordinator is live but the token cannot be minted", async () => {
    const first = await electRuntimeHost(electionOptions({ pid: 8001 }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());

    await expect(
      electRuntimeHost(
        electionOptions({
          mintToken: () => {
            throw new Error("signing key locked");
          },
        }),
      ),
    ).rejects.toThrow(/live .* but minting the attach token failed/);
  });
});
