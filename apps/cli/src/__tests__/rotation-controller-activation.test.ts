/**
 * The SHARED rotation controller (`@motebit/surface-kit`, adopted by web,
 * mobile and desktop in #709) driven against a REAL in-process relay with the
 * #702 relay half applied — the composition proof the port-level tests in
 * surface-kit cannot give. Lives here because the CLI package is the one
 * that already depends on the relay for its own activation tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { performKeyRotation, type HeldRotation, type KeyRotationPorts } from "@motebit/surface-kit";

import { registerWithRelay } from "../relay-registration.js";

const SYNC_URL = "http://relay.test";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
let posts: number;

const viaRelay: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/rotate-key")) posts++;
  return relay.app.request(url, init);
};

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: "test-token",
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  posts = 0;
});
afterEach(async () => {
  await relay.close();
});

/** A surface's plumbing, in memory: one key slot, one write-ahead slot. */
function device(mid: string, deviceId: string, a: KeyPair, fetchImpl: typeof fetch = viaRelay) {
  let priv: string | null = bytesToHex(a.privateKey);
  let pub = hex(a);
  let held: HeldRotation | null = null;
  let commits = 0;
  const ports: KeyRotationPorts = {
    motebitId: mid,
    deviceId,
    syncUrl: SYNC_URL,
    loadPrivateKeyHex: async () => priv,
    writeAhead: {
      load: async () => held,
      save: async (h) => {
        held = h;
      },
      clear: async () => {
        held = null;
      },
      setAside: async () => {
        held = null;
      },
    },
    commit: async (next) => {
      commits++;
      priv = next.privateKeyHex;
      pub = next.publicKeyHex;
    },
    fetchImpl,
  };
  return { ports, key: () => pub, held: () => held, commits: () => commits };
}

async function registered(): Promise<{ mid: string; deviceId: string; a: KeyPair }> {
  const mid = crypto.randomUUID();
  const a = await generateKeypair();
  const deviceId = `${mid}-phone`;
  const handle = await registerWithRelay({
    syncUrl: SYNC_URL,
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(a), privateKey: a.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "controller activation",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: viaRelay,
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return { mid, deviceId, a };
}

const relayKey = (mid: string) =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key;
const deviceKey = (did: string) =>
  (
    relay.moteDb.db.prepare("SELECT public_key FROM devices WHERE device_id = ?").get(did) as
      { public_key: string } | undefined
  )?.public_key;
const chainLength = (mid: string) =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;

describe("the shared controller against the real relay", () => {
  it("S0 → S2: records the link, moves the device row, commits locally after", async () => {
    const { mid, deviceId, a } = await registered();
    const d = device(mid, deviceId, a);
    const o = await performKeyRotation(d.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "recorded" });
    expect(chainLength(mid)).toBe(1);
    expect(relayKey(mid)).toBe(d.key());
    expect(deviceKey(deviceId)).toBe(d.key());
    expect(d.held()).toBeNull();
    expect(posts).toBe(1);
  });

  it("S1: a lost response is finished on the next run by READING — zero POSTs, committed from the write-ahead", async () => {
    const { mid, deviceId, a } = await registered();
    const lossy: typeof fetch = async (input, init) => {
      const res = await viaRelay(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/rotate-key")) throw new Error("socket hang up");
      return res;
    };
    const d = device(mid, deviceId, a, lossy);
    expect((await performKeyRotation(d.ports)).kind).toBe("held");
    expect(chainLength(mid)).toBe(1);
    expect(d.commits()).toBe(0);
    const heldKey = d.held()!.new_public_key;
    posts = 0;
    d.ports.fetchImpl = viaRelay;
    const again = await performKeyRotation(d.ports);
    expect(again).toMatchObject({
      kind: "rotated",
      relay: "already-held",
      newPublicKeyHex: heldKey,
    });
    expect(posts).toBe(0);
    expect(d.key()).toBe(heldKey);
    expect(chainLength(mid)).toBe(1);
  });

  it("a daemon that shut down (key only on a device row) still rotates — the relay's own answer is taken", async () => {
    const { mid, deviceId, a } = await registered();
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(mid);
    const d = device(mid, deviceId, a);
    expect(await performKeyRotation(d.ports)).toMatchObject({ kind: "rotated", relay: "recorded" });
    expect(deviceKey(deviceId)).toBe(d.key());
  });

  it("S5: someone else rotated first ⇒ stopped, nothing moves", async () => {
    const { mid, deviceId, a } = await registered();
    const c = await generateKeypair();
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(c), mid);
    const d = device(mid, deviceId, a);
    expect(await performKeyRotation(d.ports)).toMatchObject({
      kind: "stopped",
      state: "diverged",
      relayKey: hex(c),
    });
    expect(d.commits()).toBe(0);
    expect(posts).toBe(0);
  });

  it("the bearer is signed by the RETIRING key under rotate-key — the relay half's own tests refuse anything else", async () => {
    // Composition: if the controller signed with B or used another audience,
    // the relay's middleware would 401 and this would not be `rotated`.
    const { mid, deviceId, a } = await registered();
    expect((await performKeyRotation(device(mid, deviceId, a).ports)).kind).toBe("rotated");
  });
});
