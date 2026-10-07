/**
 * After a key succession, only the CURRENT key authenticates a caller.
 *
 * The deployed composition: `wireServerDeps` resolves a caller's key from the
 * local trust store (the key first seen for that caller) and only asked the
 * relay when there was no record. A caller that rotated away from a
 * compromised key therefore kept authenticating WITH THE RETIRED KEY at its
 * stored trust level, and its new key was refused. The relay's identity
 * bundle (`/api/v1/identity/:id`, the same surface an external verifier
 * resolves a receipt's producer through) is the authority on the current
 * key; a cached key is never preferred over a newer succession.
 *
 * Driven end to end: REAL Ed25519 keys, a REAL signed succession record, a
 * REAL HTTP MCP server and a fake relay serving the identity bundle.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  bytesToHex,
  createSignedToken,
  generateKeypair,
  signKeySuccession,
  verifySignedToken,
} from "@motebit/encryption";
import { McpServerAdapter, AgentTrustLevel } from "../index.js";
import type { MotebitServerDeps } from "../index.js";
import { wireServerDeps } from "../service.js";
import type { ServiceRuntime } from "../service.js";

const SERVER = "server-0000-0000-0000-00000000c0de";
const CALLER = "caller-0000-0000-0000-00000000c0de";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function fakeRelay(bundle: () => unknown): Promise<string> {
  const srv = http.createServer((req, res) => {
    if (req.url === `/api/v1/identity/${CALLER}`) {
      const b = bundle();
      if (b === "down") {
        res.writeHead(503);
        res.end();
        return;
      }
      if (b == null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => srv.close(() => r())));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

function runtimeWithStoredKey(publicKey: string, trustLevel: AgentTrustLevel): ServiceRuntime {
  return {
    getToolRegistry: () => ({ list: () => [], execute: async () => ({ ok: true }) }),
    policy: {
      filterTools: (t: unknown[]) => t,
      validate: () => ({ allowed: true, requiresApproval: false }),
      createTurnContext: () => ({}),
    },
    getState: () => ({}),
    memory: {
      exportAll: async () => ({ nodes: [] }),
      recallRelevant: async () => [],
      formMemory: async () => ({ node_id: "n" }),
    },
    getAgentTrust: async (id: string) =>
      id === CALLER ? { trust_level: trustLevel, public_key: publicKey } : null,
  } as unknown as ServiceRuntime;
}

async function serve(
  resolveCallerKey: MotebitServerDeps["resolveCallerKey"],
  onCallerVerified?: MotebitServerDeps["onCallerVerified"],
): Promise<number> {
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  const deps: MotebitServerDeps = {
    motebitId: SERVER,
    publicKeyHex: "11".repeat(32),
    listTools: () => [],
    filterTools: (t) => t,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async () => ({ ok: true, data: "ok" }),
    getState: () => ({}),
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken,
    resolveCallerKey,
    ...(onCallerVerified ? { onCallerVerified } : {}),
  };
  const adapter = new McpServerAdapter({ transport: "http", port: 0 }, deps);
  await adapter.start();
  closers.push(() => adapter.stop());
  return ((adapter as unknown as { httpServer: http.Server }).httpServer.address() as AddressInfo)
    .port;
}

async function status(port: number, privateKey: Uint8Array): Promise<number> {
  const now = Date.now();
  const token = await createSignedToken(
    {
      mid: CALLER,
      did: `${CALLER}-device`,
      iat: now,
      exp: now + 60_000,
      jti: crypto.randomUUID(),
      aud: "mcp:call",
      sub: SERVER,
    } as unknown as Parameters<typeof createSignedToken>[0],
    privateKey,
  );
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer motebit:${token}` },
    body: INIT,
  });
  await res.text();
  return res.status;
}

async function rotated() {
  const oldKey = await generateKeypair();
  const newKey = await generateKeypair();
  const record = await signKeySuccession(
    oldKey.privateKey,
    newKey.privateKey,
    newKey.publicKey,
    oldKey.publicKey,
    "compromise",
  );
  return { oldKey, newKey, record };
}

describe("caller key succession — the retired key never authenticates", () => {
  it("refuses the rotated-away key and accepts the successor at the earned trust level", async () => {
    const { oldKey, newKey, record } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [record],
      anchored: null,
    }));
    const deps = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(oldKey.publicKey), AgentTrustLevel.Trusted),
      { motebitId: SERVER, syncUrl },
    );

    // The succession is proven (signed by the old key), so the earned trust carries over.
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(newKey.publicKey),
      trustLevel: AgentTrustLevel.Trusted,
    });

    const port = await serve(deps.resolveCallerKey);
    expect(await status(port, oldKey.privateKey)).toBe(401);
    expect(await status(port, newKey.privateKey)).toBe(200);
  });

  it("an unproven key change from the relay authenticates the relay's key, never above Verified", async () => {
    const { oldKey, newKey } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [],
      anchored: null,
    }));
    const deps = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(oldKey.publicKey), AgentTrustLevel.Trusted),
      { motebitId: SERVER, syncUrl },
    );
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(newKey.publicKey),
      trustLevel: AgentTrustLevel.Verified,
    });
  });

  it("a blocked caller stays blocked across a succession", async () => {
    const { oldKey, newKey, record } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [record],
      anchored: null,
    }));
    const deps = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(oldKey.publicKey), AgentTrustLevel.Blocked),
      { motebitId: SERVER, syncUrl },
    );
    const r = await deps.resolveCallerKey!(CALLER);
    expect(r?.trustLevel).toBe(AgentTrustLevel.Blocked);
  });

  it("an unchanged key keeps the stored trust; an unknown-to-relay caller keeps the local key", async () => {
    const k = await generateKeypair();
    let served: unknown = {
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(k.publicKey),
      succession: [],
      anchored: null,
    };
    const syncUrl = await fakeRelay(() => served);
    const deps = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(k.publicKey), AgentTrustLevel.Trusted),
      { motebitId: SERVER, syncUrl },
    );
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(k.publicKey),
      trustLevel: AgentTrustLevel.Trusted,
    });
    // Unknown to the relay: the stored key stands, but no longer above Verified.
    served = null;
    const deps2 = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(k.publicKey), AgentTrustLevel.Trusted),
      { motebitId: SERVER, syncUrl },
    );
    expect(await deps2.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(k.publicKey),
      trustLevel: AgentTrustLevel.Verified,
    });
  });
});

/**
 * A runtime whose trust store is live: `recordAgentInteraction` follows the
 * runtime's contract — a stored key changes only with `provenSuccession`.
 */
function liveRuntime(publicKey: string, trustLevel: AgentTrustLevel) {
  const record = { trust_level: trustLevel, public_key: publicKey };
  const calls: Array<{ key?: string; proven?: boolean }> = [];
  const runtime = {
    ...(runtimeWithStoredKey(publicKey, trustLevel) as unknown as Record<string, unknown>),
    getAgentTrust: async (id: string) => (id === CALLER ? { ...record } : null),
    recordAgentInteraction: async (
      _id: string,
      key?: string,
      _type?: string,
      opts?: { provenSuccession?: boolean },
    ) => {
      calls.push({ key, proven: opts?.provenSuccession });
      if (key && (record.public_key === "" || opts?.provenSuccession === true)) {
        record.public_key = key;
      }
      return { ...record };
    },
  } as unknown as ServiceRuntime;
  return { runtime, record, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("caller key succession — trust never rides an unproven key change", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an unproven key change stays at Verified on every request, and the stored key is not replaced", async () => {
    const { oldKey, newKey } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [],
      anchored: null,
    }));
    const { runtime, record, calls } = liveRuntime(
      bytesToHex(oldKey.publicKey),
      AgentTrustLevel.Trusted,
    );
    const deps = wireServerDeps(runtime, { motebitId: SERVER, syncUrl });
    const port = await serve(deps.resolveCallerKey, deps.onCallerVerified);

    expect(await status(port, newKey.privateKey)).toBe(200);
    await tick();
    expect(calls.at(-1)).toEqual({ key: bytesToHex(newKey.publicKey), proven: false });
    expect(record.public_key).toBe(bytesToHex(oldKey.publicKey));
    expect(record.trust_level).toBe(AgentTrustLevel.Trusted);

    // 2nd request: still capped.
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(newKey.publicKey),
      trustLevel: AgentTrustLevel.Verified,
    });
    expect(await status(port, newKey.privateKey)).toBe(200);
    await tick();
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(newKey.publicKey),
      trustLevel: AgentTrustLevel.Verified,
    });
  });

  it("a proven succession is recorded as proven, so the successor keeps the earned level", async () => {
    const { oldKey, newKey, record: succ } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [succ],
      anchored: null,
    }));
    const { runtime, record, calls } = liveRuntime(
      bytesToHex(oldKey.publicKey),
      AgentTrustLevel.Trusted,
    );
    const deps = wireServerDeps(runtime, { motebitId: SERVER, syncUrl });
    const port = await serve(deps.resolveCallerKey, deps.onCallerVerified);
    expect(await status(port, newKey.privateKey)).toBe(200);
    await tick();
    expect(calls.at(-1)).toEqual({ key: bytesToHex(newKey.publicKey), proven: true });
    expect(record.public_key).toBe(bytesToHex(newKey.publicKey));
    expect(await deps.resolveCallerKey!(CALLER)).toEqual({
      publicKey: bytesToHex(newKey.publicKey),
      trustLevel: AgentTrustLevel.Trusted,
    });
  });

  it("a blocked caller stays blocked through an unproven key change and a later request", async () => {
    const { oldKey, newKey } = await rotated();
    const syncUrl = await fakeRelay(() => ({
      motebit_id: CALLER,
      created_at: new Date().toISOString(),
      current_public_key: bytesToHex(newKey.publicKey),
      succession: [],
      anchored: null,
    }));
    const { runtime } = liveRuntime(bytesToHex(oldKey.publicKey), AgentTrustLevel.Blocked);
    const deps = wireServerDeps(runtime, { motebitId: SERVER, syncUrl });
    for (let i = 0; i < 2; i++) {
      const r = await deps.resolveCallerKey!(CALLER);
      expect(r?.trustLevel).toBe(AgentTrustLevel.Blocked);
    }
  });
});

describe("caller key resolution — relay unavailable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts the stored key at most at Verified while the relay is down", async () => {
    const k = await generateKeypair();
    const syncUrl = await fakeRelay(() => "down");
    for (const level of [AgentTrustLevel.Trusted, AgentTrustLevel.Verified]) {
      const deps = wireServerDeps(runtimeWithStoredKey(bytesToHex(k.publicKey), level), {
        motebitId: SERVER,
        syncUrl,
      });
      expect(await deps.resolveCallerKey!(CALLER)).toEqual({
        publicKey: bytesToHex(k.publicKey),
        trustLevel: AgentTrustLevel.Verified,
      });
    }
    const blocked = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(k.publicKey), AgentTrustLevel.Blocked),
      { motebitId: SERVER, syncUrl },
    );
    expect((await blocked.resolveCallerKey!(CALLER))?.trustLevel).toBe(AgentTrustLevel.Blocked);
  });

  it("never falls back to the stored key for a caller whose rotation was observed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { oldKey, newKey } = await rotated();
    let up = true;
    const syncUrl = await fakeRelay(() =>
      up
        ? {
            motebit_id: CALLER,
            created_at: new Date().toISOString(),
            current_public_key: bytesToHex(newKey.publicKey),
            succession: [],
            anchored: null,
          }
        : "down",
    );
    const deps = wireServerDeps(
      runtimeWithStoredKey(bytesToHex(oldKey.publicKey), AgentTrustLevel.Trusted),
      { motebitId: SERVER, syncUrl },
    );
    expect((await deps.resolveCallerKey!(CALLER))?.publicKey).toBe(bytesToHex(newKey.publicKey));
    up = false;
    vi.setSystemTime(Date.now() + 60_000);
    expect(await deps.resolveCallerKey!(CALLER)).toBeNull();
  });
});
