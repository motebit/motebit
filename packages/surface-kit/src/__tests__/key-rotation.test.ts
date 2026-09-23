/**
 * The shared rotation state machine at the port seam — one case per row of
 * `docs/proposals/key-rotation-client-v1.md` §3, with the relay stubbed at
 * fetch. The activation against a REAL relay lives in
 * `apps/cli/src/__tests__/rotation-controller-activation.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signKeySuccession,
  verifySignedToken,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import {
  performKeyRotation,
  rotateOrThrow,
  KeyRotationError,
  type HeldRotation,
  type KeyRotationPorts,
} from "../key-rotation.js";

const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const MID = "mid-1";

interface Fake {
  ports: KeyRotationPorts;
  privateKeyHex: () => string | null;
  publicKeyHex: () => string | null;
  held: () => HeldRotation | null;
  commits: number;
  posts: number;
}

/** A device holding `a`, talking to a relay that answers as `relay` says. */
function device(
  a: KeyPair,
  relay: {
    departable: boolean;
    held_public_key: string | null;
    chain?: unknown[];
    onPost?: (record: unknown) => Response | Error;
    down?: boolean;
  } | null,
  opts: { held?: HeldRotation | null; deviceId?: string } = {},
): Fake {
  let priv: string | null = bytesToHex(a.privateKey);
  let pub: string | null = hex(a);
  let held: HeldRotation | null = opts.held ?? null;
  const fake: Fake = {
    commits: 0,
    posts: 0,
    privateKeyHex: () => priv,
    publicKeyHex: () => pub,
    held: () => held,
    ports: {
      motebitId: MID,
      deviceId: opts.deviceId ?? "d-1",
      syncUrl: relay === null ? null : "http://relay",
      loadPrivateKeyHex: async () => priv,
      writeAhead: {
        load: async () => held,
        save: async (h) => {
          held = h;
        },
        clear: async () => {
          held = null;
        },
      },
      commit: async (next) => {
        fake.commits++;
        priv = next.privateKeyHex;
        pub = next.publicKeyHex;
      },
      fetchImpl: (async (input: string, init?: RequestInit) => {
        if (relay === null || relay.down) throw new Error("ECONNREFUSED");
        if ((init?.method ?? "GET") === "POST") {
          fake.posts++;
          const r = relay.onPost?.(JSON.parse(init!.body as string));
          if (r instanceof Error) throw r;
          return (
            r ??
            new Response(JSON.stringify({ ok: true, motebit_id: MID, applied: true }), {
              status: 200,
            })
          );
        }
        void input;
        return new Response(
          JSON.stringify({
            chain: relay.chain ?? [],
            held_public_key: relay.held_public_key,
            departable: relay.departable,
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    },
  };
  return fake;
}

describe("performKeyRotation", () => {
  it("S0: mints, writes ahead, submits signed by the retiring key, commits only after 200", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a) });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "recorded" });
    expect(f.commits).toBe(1);
    expect(f.posts).toBe(1);
    expect(f.publicKeyHex()).toBe((o as { newPublicKeyHex: string }).newPublicKeyHex);
    expect(f.held()).toBeNull();
  });

  it("I2: the write-ahead exists BEFORE the request leaves, and I1: local state has not moved when it does", async () => {
    const a = await generateKeypair();
    let seen: { held: HeldRotation | null; commits: number } | null = null;
    const f: Fake = device(a, {
      departable: true,
      held_public_key: hex(a),
      onPost: () => {
        seen = { held: f.held(), commits: f.commits };
        return new Response(JSON.stringify({ ok: true, applied: true }), { status: 200 });
      },
    });
    await performKeyRotation(f.ports);
    expect(seen!.held).not.toBeNull();
    expect(seen!.commits).toBe(0);
  });

  it("S1: the relay holds the write-ahead's key ⇒ commits from it and sends nothing", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(b),
      record,
      new_private_key_hex: bytesToHex(b.privateKey),
      written_at: 1,
    };
    const f = device(a, { departable: false, held_public_key: hex(b), chain: [record] }, { held });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "already-held", newPublicKeyHex: hex(b) });
    expect(f.posts).toBe(0);
    expect(f.privateKeyHex()).toBe(bytesToHex(b.privateKey));
    expect(f.held()).toBeNull();
  });

  it("S0 with a stale write-ahead the relay never applied: discarded with its age said, fresh mint", async () => {
    const a = await generateKeypair();
    const ghost = await generateKeypair();
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(ghost),
      record: await signKeySuccession(a.privateKey, ghost.privateKey, ghost.publicKey, a.publicKey),
      new_private_key_hex: bytesToHex(ghost.privateKey),
      written_at: 1000,
    };
    const f = device(a, { departable: true, held_public_key: hex(a) }, { held });
    f.ports.now = () => 1000 + 16 * 60_000;
    const o = await performKeyRotation(f.ports);
    expect(o.kind).toBe("rotated");
    expect(o.notes).toContainEqual({ kind: "write-ahead-discarded", ageMs: 16 * 60_000 });
    expect(f.publicKeyHex()).not.toBe(hex(ghost));
  });

  it("a write-ahead that is not this device's is said and cleared, never finished", async () => {
    const a = await generateKeypair();
    const other = await generateKeypair();
    const held: HeldRotation = {
      motebit_id: "someone-else",
      old_public_key: hex(other),
      new_public_key: hex(other),
      record: {
        old_public_key: hex(other),
        new_public_key: hex(other),
        timestamp: 1,
        suite: "motebit-jcs-ed25519-hex-v1",
        new_key_signature: "00",
      },
      new_private_key_hex: "00",
      written_at: 1,
    };
    const f = device(a, { departable: true, held_public_key: hex(a) }, { held });
    const o = await performKeyRotation(f.ports);
    expect(o.notes).toContainEqual({
      kind: "stale-write-ahead-cleared",
      motebitId: "someone-else",
      oldPublicKey: hex(other),
    });
    expect(f.held()).toBeNull();
  });

  it("S4: the relay holds nothing ⇒ rotates locally, relay: none, no POST", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: false, held_public_key: null });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "none" });
    expect(f.posts).toBe(0);
    expect(f.commits).toBe(1);
  });

  it("S5: the relay holds another key ⇒ stops naming it and guardian recovery; nothing moves", async () => {
    const a = await generateKeypair();
    const c = await generateKeypair();
    const f = device(a, { departable: false, held_public_key: hex(c) });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "stopped", state: "diverged", relayKey: hex(c) });
    expect((o as { message: string }).message).toContain("guardian");
    expect(f.commits).toBe(0);
    expect(f.held()).toBeNull();
  });

  it("S6: unreachable ⇒ stops with the old key intact and no write-ahead", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a), down: true });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "stopped", state: "unreachable" });
    expect(f.commits).toBe(0);
    expect(f.held()).toBeNull();
  });

  it("refused ⇒ old key works, nothing committed, write-ahead removed", async () => {
    const a = await generateKeypair();
    const f = device(a, {
      departable: true,
      held_public_key: hex(a),
      onPost: () => new Response("not from current key", { status: 400 }),
    });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "stopped", state: "refused" });
    expect(f.commits).toBe(0);
    expect(f.publicKeyHex()).toBe(hex(a));
    expect(f.held()).toBeNull();
  });

  it("lost response ⇒ held: nothing committed, the write-ahead stays for the next run", async () => {
    const a = await generateKeypair();
    const f = device(a, {
      departable: true,
      held_public_key: hex(a),
      onPost: () => new Error("socket hang up"),
    });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "held" });
    expect(f.commits).toBe(0);
    expect(f.held()).not.toBeNull();
    expect(f.held()!.new_public_key).toBe((o as { newPublicKeyHex: string }).newPublicKeyHex);
  });

  it("no relay configured ⇒ rotates locally and says so; no read, no POST", async () => {
    const a = await generateKeypair();
    const f = device(a, null);
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "none" });
    expect(o.notes).toContainEqual({ kind: "no-relay-configured" });
    expect(f.posts).toBe(0);
  });

  it("no private key ⇒ stops before anything is read or minted", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a) });
    f.ports.loadPrivateKeyHex = async () => null;
    expect(await performKeyRotation(f.ports)).toMatchObject({ kind: "stopped", state: "no-key" });
    expect(f.commits).toBe(0);
  });

  it("with no device id, the bearer names the identity's own did:key and the reason travels in the record", async () => {
    const a = await generateKeypair();
    let bearer = "";
    let record: { reason?: string } | null = null;
    const f = device(
      a,
      {
        departable: true,
        held_public_key: hex(a),
        onPost: (r) => {
          record = r as { reason?: string };
          return new Response(JSON.stringify({ ok: true, applied: true }), { status: 200 });
        },
      },
      { deviceId: "" },
    );
    const inner = f.ports.fetchImpl!;
    f.ports.fetchImpl = (async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST")
        bearer = (init!.headers as Record<string, string>)["Authorization"]!.replace("Bearer ", "");
      return inner(input, init);
    }) as unknown as typeof fetch;
    f.ports.reason = "laptop lost";
    expect((await performKeyRotation(f.ports)).kind).toBe("rotated");
    const claims = await verifySignedToken(bearer, a.publicKey);
    expect(claims).toMatchObject({ mid: MID, aud: "rotate-key" });
    expect((claims as { did: string }).did.startsWith("did:key:")).toBe(true);
    expect(record!.reason).toBe("laptop lost");
  });

  it("without an injected fetch it uses the global one", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: false, held_public_key: null });
    const saved = globalThis.fetch;
    globalThis.fetch = f.ports.fetchImpl!;
    delete f.ports.fetchImpl;
    try {
      expect(await performKeyRotation(f.ports)).toMatchObject({ kind: "rotated", relay: "none" });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it("rotateOrThrow keeps the settings screens' contract: resolve on rotated, reject with the honest message otherwise", async () => {
    const a = await generateKeypair();
    const ok = device(a, { departable: true, held_public_key: hex(a) });
    await expect(rotateOrThrow(ok.ports)).resolves.toMatchObject({ kind: "rotated" });
    const c = await generateKeypair();
    const bad = device(a, { departable: false, held_public_key: hex(c) });
    const err = await rotateOrThrow(bad.ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyRotationError);
    expect((err as KeyRotationError).outcome.kind).toBe("stopped");
    expect((err as Error).message).toContain("guardian");
  });
});
