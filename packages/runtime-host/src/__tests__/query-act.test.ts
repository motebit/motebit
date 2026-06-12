/**
 * Attach-mode parity frames: `query` (records) and `act` (typed panel
 * acts) — distinct verbs end-to-end, answered by `query_result` /
 * `query_error`. Kinds are opaque to the transport; refusals are
 * honest; in-flight requests die loudly with the connection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintAttachToken, RuntimeHostClient } from "../client.js";
import { nodePlatform } from "../node-platform.js";
import { RuntimeHostServer, type RuntimeHostServerOptions } from "../server.js";

const platform = nodePlatform();
const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000007";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-query-"));
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

async function bindServer(
  overrides: Partial<RuntimeHostServerOptions> = {},
): Promise<RuntimeHostServer> {
  const server = await RuntimeHostServer.bind(serverOptions(overrides));
  cleanups.push(() => server.close());
  return server;
}

async function attachClient(): Promise<RuntimeHostClient> {
  const client = await RuntimeHostClient.attach({
    platform,
    socketPath: serverOptions().socketPath,
    token: await mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
  });
  cleanups.push(() => client.close());
  return client;
}

describe("query / act frames", () => {
  it("round-trips a read: kind and params reach the seam, payload returns", async () => {
    const seen: unknown[] = [];
    await bindServer({
      onQuery: (kind, params) => {
        seen.push({ kind, params });
        return Promise.resolve({ nodes: [{ node_id: "n1" }], edges: [] });
      },
    });
    const client = await attachClient();
    const payload = await client.query("memory_export", { limit: 5 });
    expect(payload).toEqual({ nodes: [{ node_id: "n1" }], edges: [] });
    expect(seen).toEqual([{ kind: "memory_export", params: { limit: 5 } }]);
  });

  it("round-trips an act through the DISTINCT act seam, never the read seam", async () => {
    const reads: string[] = [];
    const acts: unknown[] = [];
    await bindServer({
      onQuery: (kind) => {
        reads.push(kind);
        return Promise.resolve(null);
      },
      onAct: (kind, params) => {
        acts.push({ kind, params });
        return Promise.resolve({ deleted: true });
      },
    });
    const client = await attachClient();
    const result = await client.act("memory_delete", { node_id: "n1" });
    expect(result).toEqual({ deleted: true });
    expect(acts).toEqual([{ kind: "memory_delete", params: { node_id: "n1" } }]);
    expect(reads).toEqual([]);
  });

  it("answers an honest refusal when the coordinator serves no read seam", async () => {
    await bindServer(); // no onQuery
    const client = await attachClient();
    await expect(client.query("state")).rejects.toThrow(/does not serve reads/);
  });

  it("answers an honest refusal when the coordinator serves no act seam", async () => {
    await bindServer({ onQuery: () => Promise.resolve(null) });
    const client = await attachClient();
    await expect(client.act("memory_delete")).rejects.toThrow(/does not serve acts/);
  });

  it("surfaces a seam rejection (unknown kind) as the request's error", async () => {
    await bindServer({
      onQuery: (kind) => Promise.reject(new Error(`unknown attached read kind "${kind}"`)),
    });
    const client = await attachClient();
    await expect(client.query("no_such_kind")).rejects.toThrow(
      /unknown attached read kind "no_such_kind"/,
    );
  });

  it("rejects in-flight requests loudly when the coordinator goes away", async () => {
    const server = await bindServer({
      onQuery: () => new Promise<never>(() => {}), // never answers
    });
    const client = await attachClient();
    const pending = client.query("state");
    await server.close();
    await expect(pending).rejects.toThrow();
  });

  it("interleaves concurrent reads by correlation id", async () => {
    await bindServer({
      onQuery: async (kind) => {
        // Answer the first-sent kind slower than the second.
        if (kind === "slow") await new Promise((r) => setTimeout(r, 60));
        return `answer:${kind}`;
      },
    });
    const client = await attachClient();
    const [slow, fast] = await Promise.all([client.query("slow"), client.query("fast")]);
    expect(slow).toBe("answer:slow");
    expect(fast).toBe("answer:fast");
  });
});
