/**
 * End-to-end test of the CLI's runtime-host glue against the real
 * @motebit/runtime-host package over a real unix socket: the device-key
 * resolver sourced from config fields, the lazy token mint, and the
 * chat / approval / invoke seams dispatching into the (stubbed)
 * runtime. Increment 2 of docs/doctrine/daemon-desktop-unification.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, generateKeypair, type KeyPair } from "@motebit/crypto";
import type { MotebitRuntime } from "@motebit/runtime";
import { AttachRefusedError } from "@motebit/runtime-host";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FullConfig } from "../config.js";
import { electCliRuntimeHost, type CliElectionDeps } from "../runtime-host.js";

const MOTEBIT_ID = "36080ffe-test-8000-a000-00000000cli2";
const DEVICE_ID = "cli-device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-cli-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal runtime stub exposing only the seams the glue wires. */
function stubRuntime(): MotebitRuntime {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    sendMessageStreaming: async function* (text: string, _runId?: string, options?: unknown) {
      yield { type: "text", text: `turn:${text}`, options };
      yield { type: "approval_request", tool_call_id: "tc-1", name: "write_file", args: {} };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    resolveApprovalVote: async function* (approved: boolean, approverId: string) {
      yield { type: "text", text: `resolved:${approved}:${approverId}` };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    invokeCapability: async function* (capability: string, prompt: string) {
      yield { type: "delegation_start", server: "relay", tool: capability };
      yield { type: "text", text: prompt };
    },
  } as unknown as MotebitRuntime;
}

function deps(overrides: Partial<CliElectionDeps> = {}): CliElectionDeps {
  const fullConfig = {
    device_id: DEVICE_ID,
    device_public_key: bytesToHex(keys.publicKey),
  } as FullConfig;
  return {
    fullConfig,
    motebitId: MOTEBIT_ID,
    loadPrivateKey: () => Promise.resolve(keys.privateKey),
    runtimeRef: { current: stubRuntime() },
    paths: {
      socketPath: join(dir, "runtime.sock"),
      lockfilePath: join(dir, "runtime.lock"),
    },
    ...overrides,
  };
}

const collect = async (gen: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
};

describe("electCliRuntimeHost", () => {
  it("coordinates first, attaches second, and proxies a full chat + approval round-trip", async () => {
    const first = await electCliRuntimeHost(deps());
    expect(first.role).toBe("coordinator");
    if (first.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => first.server.close());

    const second = await electCliRuntimeHost(deps());
    expect(second.role).toBe("frontend");
    if (second.role !== "frontend") throw new Error("unreachable");
    cleanups.push(() => second.client.close());

    const turn = await collect(second.client.chat("hello"));
    expect(turn[0]).toMatchObject({ type: "text", text: "turn:hello" });
    expect(turn[1]).toMatchObject({ type: "approval_request", name: "write_file" });

    const continuation = await collect(second.client.resolveApproval(true, MOTEBIT_ID));
    expect(continuation).toEqual([{ type: "text", text: `resolved:true:${MOTEBIT_ID}` }]);

    const invoked = await collect(second.client.invoke("review_pr", "do it"));
    expect(invoked[0]).toMatchObject({ type: "delegation_start", tool: "review_pr" });
  });

  it("strips wire-supplied authority fields before they reach the runtime", async () => {
    const seen: unknown[] = [];
    const runtime = {
      // eslint-disable-next-line @typescript-eslint/require-await
      sendMessageStreaming: async function* (_text: string, _runId?: string, options?: unknown) {
        seen.push(options);
        yield { type: "text", text: "ok" };
      },
    } as unknown as MotebitRuntime;

    const first = await electCliRuntimeHost(deps({ runtimeRef: { current: runtime } }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());
    const second = await electCliRuntimeHost(deps());
    if (second.role !== "frontend") throw new Error("second should attach");
    cleanups.push(() => second.client.close());

    await collect(
      second.client.chat("hi", {
        verifiedGrant: { grant_id: "g-1", verified_at: 1 },
        suppressHistory: true,
      }),
    );
    expect(seen).toEqual([{ suppressHistory: true }]);
  });

  it("refuses an attacher whose device is not this config's device", async () => {
    const first = await electCliRuntimeHost(deps());
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());

    const strangerConfig = {
      device_id: "some-other-device",
      device_public_key: bytesToHex(keys.publicKey),
    } as FullConfig;
    await expect(electCliRuntimeHost(deps({ fullConfig: strangerConfig }))).rejects.toThrow(
      AttachRefusedError,
    );
  });

  it("serves attached reads and acts through the runtime's closed registries", async () => {
    const acts: unknown[] = [];
    const runtime = {
      resolveAttachedRead: (kind: string, params?: Record<string, unknown>) =>
        kind === "memory_export"
          ? Promise.resolve({ nodes: [{ node_id: "n1" }], edges: [], params })
          : Promise.reject(new Error(`unknown attached read kind "${kind}"`)),
      resolveAttachedAct: (kind: string, params?: Record<string, unknown>) => {
        acts.push({ kind, params });
        return Promise.resolve(null);
      },
    } as unknown as MotebitRuntime;

    const first = await electCliRuntimeHost(deps({ runtimeRef: { current: runtime } }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());
    const second = await electCliRuntimeHost(deps());
    if (second.role !== "frontend") throw new Error("second should attach");
    cleanups.push(() => second.client.close());

    const payload = await second.client.query("memory_export", { limit: 3 });
    expect(payload).toMatchObject({ nodes: [{ node_id: "n1" }] });

    await second.client.act("memory_pin", { node_id: "n1", pinned: true });
    expect(acts).toEqual([{ kind: "memory_pin", params: { node_id: "n1", pinned: true } }]);

    // Unknown kinds refuse honestly end-to-end.
    await expect(second.client.query("no_such_kind")).rejects.toThrow(/unknown attached read kind/);
  });

  it("answers an honest error to a frame arriving before the runtime exists", async () => {
    const first = await electCliRuntimeHost(deps({ runtimeRef: { current: null } }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());
    const second = await electCliRuntimeHost(deps());
    if (second.role !== "frontend") throw new Error("second should attach");
    cleanups.push(() => second.client.close());

    await expect(collect(second.client.chat("hi"))).rejects.toThrow(/still starting/);
  });
});
