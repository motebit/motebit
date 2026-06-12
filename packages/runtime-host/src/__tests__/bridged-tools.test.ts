/**
 * Bridged organs → coordinator tools: the consumer step of capability
 * bridging. The registry view must track the live bridged set, execute
 * over the bridge with honest ToolResult verdicts, refuse excluded
 * organs at wire time, and leave no orphaned tools behind a contributor
 * disconnect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolRegistry } from "@motebit/protocol";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AI_LOOP_EXCLUDED_ORGANS,
  BRIDGED_ORGAN_TOOL_SOURCE,
  bridgedToolRegistry,
  wireBridgedOrganTools,
  type BridgedToolHost,
} from "../bridged-tools.js";
import { mintAttachToken, RuntimeHostClient } from "../client.js";
import { nodePlatform } from "../node-platform.js";
import { RuntimeHostServer, type RuntimeHostServerOptions } from "../server.js";

const platform = nodePlatform();
const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000006";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-btools-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function serverOptions(): RuntimeHostServerOptions {
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
  };
}

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
    token: await mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
    capabilities,
  });
  cleanups.push(() => client.close());
  return client;
}

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const COMPUTER_DEF: ToolDefinition = {
  name: "computer",
  description: "drive the desktop",
  inputSchema: { type: "object" },
  mode: "pixels",
};

const DEFS = { computer_use: COMPUTER_DEF } as const;

describe("bridgedToolRegistry", () => {
  it("refuses a definition for an AI-loop-excluded organ at wire time", async () => {
    const server = await bindServer();
    expect(AI_LOOP_EXCLUDED_ORGANS.has("se_attestation")).toBe(true);
    expect(() =>
      bridgedToolRegistry(server, { se_attestation: { ...COMPUTER_DEF, name: "se" } }),
    ).toThrow(/must not surface to the AI loop/);
  });

  it("lists exactly the bridged organs that have an injected definition", async () => {
    const server = await bindServer();
    const registry = bridgedToolRegistry(server, DEFS);
    expect(registry.list()).toEqual([]);

    const client = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield "done";
      },
      // Contributed but deliberately definition-less: must stay invisible.
      // eslint-disable-next-line @typescript-eslint/require-await
      se_attestation: async function* () {
        yield "attested";
      },
    });
    await tick();
    expect(registry.list()).toEqual([COMPUTER_DEF]);

    client.close();
    await tick();
    expect(registry.list()).toEqual([]);
  });

  it("executes over the bridge: typed args in, wrapped result out", async () => {
    const server = await bindServer();
    const seen: unknown[] = [];
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* (prompt, options) {
        seen.push({ prompt, options });
        yield { screenshot: "png-bytes" };
      },
    });
    await tick();

    const registry = bridgedToolRegistry(server, DEFS);
    const result = await registry.execute("computer", { action: { kind: "screenshot" } });
    expect(result).toEqual({ ok: true, data: { screenshot: "png-bytes" } });
    // The prompt slot stays empty by design — organs consume typed args.
    expect(seen).toEqual([{ prompt: "", options: { action: { kind: "screenshot" } } }]);
  });

  it("collects a multi-chunk answer into an array", async () => {
    const server = await bindServer();
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield "first";
        yield "second";
      },
    });
    await tick();
    const result = await bridgedToolRegistry(server, DEFS).execute("computer", {});
    expect(result).toEqual({ ok: true, data: ["first", "second"] });
  });

  it("passes a ToolResult-shaped answer through, preserving the organ's own verdict", async () => {
    const server = await bindServer();
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield { ok: false, error: "not_in_control", reason: "not_in_control" };
      },
    });
    await tick();
    const result = await bridgedToolRegistry(server, DEFS).execute("computer", {});
    expect(result).toEqual({ ok: false, error: "not_in_control", reason: "not_in_control" });
  });

  it("surfaces a handler failure as ok:false with the reason", async () => {
    const server = await bindServer();
    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      // eslint-disable-next-line require-yield
      computer_use: async function* () {
        throw new Error("enigo refused the click");
      },
    });
    await tick();
    const result = await bridgedToolRegistry(server, DEFS).execute("computer", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/enigo refused the click/);
  });

  it("answers honestly when no frontend currently contributes the tool", async () => {
    const server = await bindServer();
    const result = await bridgedToolRegistry(server, DEFS).execute("computer", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no attached frontend currently contributes tool "computer"/);
  });

  it("fails honestly when the contributor disconnects mid-invocation", async () => {
    const server = await bindServer();
    const client = await attachClient({
      computer_use: async function* () {
        await new Promise<void>(() => {}); // hang forever
        yield "unreachable";
      },
    });
    await tick();

    const pending = bridgedToolRegistry(server, DEFS).execute("computer", {});
    await tick();
    client.close();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disconnected mid-invocation/);
  });

  it("is a read-only view — register() throws", async () => {
    const server = await bindServer();
    const registry = bridgedToolRegistry(server, DEFS);
    expect(() => registry.register(COMPUTER_DEF, () => Promise.resolve({ ok: true }))).toThrow(
      /read-only view/,
    );
  });
});

describe("onBridgedCapabilitiesChanged", () => {
  it("fires with the full current set on register and on contributor disconnect", async () => {
    const server = await bindServer();
    const observed: string[][] = [];
    server.onBridgedCapabilitiesChanged((capabilities) => observed.push(capabilities));

    const client = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield "done";
      },
    });
    await tick();
    expect(observed).toEqual([["computer_use"]]);

    client.close();
    await tick();
    expect(observed).toEqual([["computer_use"], []]);
  });

  it("does not fire when a non-contributing frontend disconnects", async () => {
    const server = await bindServer();
    const observed: string[][] = [];
    server.onBridgedCapabilitiesChanged((capabilities) => observed.push(capabilities));

    const client = await attachClient(); // no organs
    await tick();
    client.close();
    await tick();
    expect(observed).toEqual([]);
  });
});

describe("wireBridgedOrganTools", () => {
  function stubHost(): BridgedToolHost & {
    registered: Map<string, ToolRegistry>;
    calls: string[];
  } {
    const registered = new Map<string, ToolRegistry>();
    const calls: string[] = [];
    return {
      registered,
      calls,
      registerExternalTools(sourceId, registry) {
        calls.push(`register:${sourceId}`);
        registered.set(sourceId, registry);
      },
      unregisterExternalTools(sourceId) {
        calls.push(`unregister:${sourceId}`);
        registered.delete(sourceId);
      },
    };
  }

  it("keeps the host registry in sync across attach and disconnect", async () => {
    const server = await bindServer();
    const host = stubHost();
    wireBridgedOrganTools(server, host, DEFS);

    // Initial sync ran with nothing bridged yet.
    const initial = host.registered.get(BRIDGED_ORGAN_TOOL_SOURCE);
    expect(initial?.list()).toEqual([]);

    const client = await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield "done";
      },
    });
    await tick();
    expect(host.registered.get(BRIDGED_ORGAN_TOOL_SOURCE)?.list()).toEqual([COMPUTER_DEF]);

    client.close();
    await tick();
    expect(host.registered.get(BRIDGED_ORGAN_TOOL_SOURCE)?.list()).toEqual([]);
    // Every sync is unregister-then-register under the one source id.
    expect(host.calls.slice(0, 2)).toEqual([
      `unregister:${BRIDGED_ORGAN_TOOL_SOURCE}`,
      `register:${BRIDGED_ORGAN_TOOL_SOURCE}`,
    ]);
  });

  it("unsubscribe stops further syncs", async () => {
    const server = await bindServer();
    const host = stubHost();
    const unsubscribe = wireBridgedOrganTools(server, host, DEFS);
    const callsAfterWire = host.calls.length;
    unsubscribe();

    await attachClient({
      // eslint-disable-next-line @typescript-eslint/require-await
      computer_use: async function* () {
        yield "done";
      },
    });
    await tick();
    expect(host.calls.length).toBe(callsAfterWire);
  });
});
