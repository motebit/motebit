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
  parseHeldRotation,
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
  held: () => HeldRotation | null | "unreadable";
  /** Every write-ahead the kit set aside (kept), in order. */
  keptAside: (HeldRotation | "unreadable")[];
  /** How many times the kit DELETED the write-ahead. */
  cleared: number;
  /** The `relay` the kit told `commit`. */
  committedRelay: string[];
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
  opts: {
    held?: HeldRotation | null | "unreadable";
    deviceId?: string;
    published?: string | null;
  } = {},
): Fake {
  let priv: string | null = bytesToHex(a.privateKey);
  let pub: string | null = opts.published === undefined ? hex(a) : opts.published;
  let held: HeldRotation | null | "unreadable" = opts.held ?? null;
  const fake: Fake = {
    keptAside: [],
    cleared: 0,
    committedRelay: [],
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
      publishedPublicKeyHex: async () => pub,
      writeAhead: {
        load: async () => held,
        save: async (h) => {
          held = h;
        },
        clear: async () => {
          fake.cleared++;
          held = null;
        },
        setAside: async () => {
          if (held != null) fake.keptAside.push(held);
          held = null;
        },
      },
      commit: async (next) => {
        fake.commits++;
        fake.committedRelay.push(next.relay);
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
    let seen: { held: HeldRotation | null | "unreadable"; commits: number } | null = null;
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
    // Superseded, not destroyed: its bytes are kept aside.
    expect(f.keptAside).toEqual([held]);
  });

  it("a write-ahead that is not this device's is said and SET ASIDE (kept), never finished, never deleted", async () => {
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
    // #759 finding (a): another identity's in-flight key may be the only copy
    // of a key the relay accepted for it. It is kept, never deleted.
    expect(f.keptAside).toEqual([held]);
    // The only delete is the post-commit one, of the write-ahead for the key
    // just committed.
    expect(f.cleared).toBe(1);
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

  it("refused ⇒ old key works, nothing committed, write-ahead set aside (kept), not deleted", async () => {
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
    expect(f.keptAside).toHaveLength(1);
    expect(f.cleared).toBe(0);
    expect(o.notes).toContainEqual({ kind: "refused-write-ahead-set-aside" });
  });

  it("no relay configured, a held rotation of THIS key: set aside (the relay once configured may hold it), never deleted", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(b),
      record: await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey),
      new_private_key_hex: bytesToHex(b.privateKey),
      written_at: 1,
    };
    const f = device(a, null, { held });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "none" });
    expect(f.keptAside).toEqual([held]);
    expect(f.committedRelay).toEqual(["none"]);
  });

  it("unregistered relay, a held rotation of THIS key: set aside, never deleted", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(b),
      record: await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey),
      new_private_key_hex: bytesToHex(b.privateKey),
      written_at: 1,
    };
    const f = device(a, { departable: false, held_public_key: null }, { held });
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "none" });
    expect(f.keptAside).toEqual([held]);
  });

  it("a set-aside that fails STOPS the rotation: nothing minted, nothing committed, the write-ahead left where it was", async () => {
    const a = await generateKeypair();
    const other = await generateKeypair();
    const held: HeldRotation = {
      motebit_id: "someone-else",
      old_public_key: hex(other),
      new_public_key: hex(other),
      record: await signKeySuccession(
        other.privateKey,
        other.privateKey,
        other.publicKey,
        other.publicKey,
      ),
      new_private_key_hex: bytesToHex(other.privateKey),
      written_at: 1,
    };
    const f = device(a, { departable: true, held_public_key: hex(a) }, { held });
    f.ports.writeAhead.setAside = () => Promise.reject(new Error("disk full"));
    await expect(performKeyRotation(f.ports)).rejects.toThrow("disk full");
    expect(f.commits).toBe(0);
    expect(f.posts).toBe(0);
    expect(f.held()).toEqual(held);
  });

  it("commit is told what the relay did: recorded after a 200, none when unregistered", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a) });
    await performKeyRotation(f.ports);
    expect(f.committedRelay).toEqual(["recorded"]);
    const g = device(a, { departable: false, held_public_key: null });
    await performKeyRotation(g.ports);
    expect(g.committedRelay).toEqual(["none"]);
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
    expect((f.held() as HeldRotation).new_public_key).toBe(
      (o as { newPublicKeyHex: string }).newPublicKeyHex,
    );
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

  it("torn commit, key stored but not published: finished from the bridging write-ahead, nothing sent, never cleared as stale", async () => {
    // Desktop's order: keyring_set(B) landed, write_config(B) did not.
    // Derived = B, published = A, write-ahead A→B. The old rule read
    // "A ≠ B" as stale and DELETED the only copy of the record.
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
    const f = device(
      b,
      { departable: false, held_public_key: hex(b), chain: [record] },
      { held, published: hex(a) },
    );
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "already-held", newPublicKeyHex: hex(b) });
    expect(o.notes).toContainEqual({
      kind: "interrupted-commit-finished",
      newPublicKeyHex: hex(b),
    });
    expect(f.commits).toBe(1);
    expect(f.posts).toBe(0);
    expect(f.publicKeyHex()).toBe(hex(b));
    expect(f.held()).toBeNull();
  });

  it("torn commit, published but key not stored: finished the same way", async () => {
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
    // Derived = A (key not stored), published = B.
    const f = device(
      a,
      { departable: false, held_public_key: hex(b), chain: [record] },
      { held, published: hex(b) },
    );
    const o = await performKeyRotation(f.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "already-held", newPublicKeyHex: hex(b) });
    expect(f.privateKeyHex()).toBe(bytesToHex(b.privateKey));
    expect(f.posts).toBe(0);
  });

  it("published and held keys disagree with no bridging write-ahead: refuse to guess, clear nothing", async () => {
    const a = await generateKeypair();
    const other = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a) }, { published: hex(other) });
    expect(await performKeyRotation(f.ports)).toMatchObject({
      kind: "stopped",
      state: "inconsistent",
    });
    expect(f.commits).toBe(0);
    expect(f.posts).toBe(0);
  });

  it("a write-ahead whose private key does not derive to the key it names is never committed", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const wrong = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(b),
      record,
      new_private_key_hex: bytesToHex(wrong.privateKey),
      written_at: 1,
    };
    const f = device(a, { departable: false, held_public_key: hex(b), chain: [record] }, { held });
    expect(await performKeyRotation(f.ports)).toMatchObject({
      kind: "stopped",
      state: "held-corrupt",
    });
    expect(f.commits).toBe(0);
    expect(f.privateKeyHex()).toBe(bytesToHex(a.privateKey));
  });

  it("an unreadable write-ahead is not an absent one: stop, do not clear, do not read the relay", async () => {
    const a = await generateKeypair();
    const f = device(a, { departable: true, held_public_key: hex(a) }, { held: "unreadable" });
    expect(await performKeyRotation(f.ports)).toMatchObject({
      kind: "stopped",
      state: "held-unreadable",
    });
    expect(f.held()).toBe("unreadable");
    expect(f.commits).toBe(0);
    expect(f.posts).toBe(0);
  });

  it("parseHeldRotation: empty ⇒ null; malformed or partial ⇒ unreadable; well-formed ⇒ the record", () => {
    expect(parseHeldRotation(null)).toBeNull();
    expect(parseHeldRotation("")).toBeNull();
    expect(parseHeldRotation("{not json")).toBe("unreadable");
    expect(parseHeldRotation(JSON.stringify({ motebit_id: "m", old_public_key: "a" }))).toBe(
      "unreadable",
    );
    const ok = {
      motebit_id: "m",
      old_public_key: "a",
      new_public_key: "b",
      record: {},
      new_private_key_hex: "c",
      written_at: 1,
    };
    expect(parseHeldRotation(JSON.stringify(ok))).toEqual(ok);
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
