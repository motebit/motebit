/**
 * A committed rotation invalidates the previous seed backup — structurally:
 * the acknowledgment names the key it covers, and the posture is read
 * against the identity's CURRENT key. Driven through the real rotation state
 * machine (`performKeyRotation`) so every commit path — fresh, resumed from
 * a lost answer, finished after an interrupted commit, re-run — is the one
 * the surfaces run. Nothing here writes the acknowledgment on rotation, so
 * nothing can destroy it: it stays as the record of the retired key.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  signKeySuccession,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import { performKeyRotation, type HeldRotation, type KeyRotationPorts } from "../key-rotation.js";
import { seedBackupPosture, type SeedBackupAcknowledgment } from "../seed-backup.js";

const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const MID = "mid-seed";

interface Relay {
  held_public_key: string | null;
  departable: boolean;
  chain?: unknown[];
  /** POST answer: "ok" (applied), "lost" (network error after send), "refused" (409). */
  post?: "ok" | "lost" | "refused";
}

/** A device holding `a`; `relay` null ⇒ none configured. All state in memory. */
function device(
  a: KeyPair,
  relay: Relay | null,
  opts: { held?: HeldRotation | null; published?: string } = {},
) {
  const s = {
    priv: bytesToHex(a.privateKey),
    pub: opts.published ?? hex(a),
    held: (opts.held ?? null) as HeldRotation | null,
    keptAside: [] as HeldRotation[],
    commits: 0,
  };
  const ports: KeyRotationPorts = {
    motebitId: MID,
    deviceId: "d-1",
    syncUrl: relay === null ? null : "http://relay",
    loadPrivateKeyHex: async () => s.priv,
    publishedPublicKeyHex: async () => s.pub,
    readWalletHoldings: async () => ({ solLamports: 0n, tokens: [] }),
    writeAhead: {
      load: async () => s.held,
      save: async (h) => {
        s.held = h;
      },
      clear: async () => {
        s.held = null;
      },
      setAside: async () => {
        if (s.held != null) s.keptAside.push(s.held);
        s.held = null;
      },
    },
    commit: async (next) => {
      s.commits++;
      s.priv = next.privateKeyHex;
      s.pub = next.publicKeyHex;
    },
    fetchImpl: (async (input: string, init?: RequestInit) => {
      if (relay === null) throw new Error("ECONNREFUSED");
      if (input.includes("/rotation-obligations")) {
        return new Response(JSON.stringify({ address: "addr", obligations: [] }), { status: 200 });
      }
      if ((init?.method ?? "GET") === "POST") {
        if (relay.post === "lost") throw new Error("socket hang up");
        if (relay.post === "refused") {
          return new Response(JSON.stringify({ error: "no" }), { status: 409 });
        }
        return new Response(JSON.stringify({ ok: true, motebit_id: MID, applied: true }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          chain: relay.chain ?? [],
          held_public_key: relay.held_public_key,
          departable: relay.departable,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  };
  return { s, ports };
}

/** The posture a surface reads: its acknowledgment against its published key. */
const postureOf = (ack: SeedBackupAcknowledgment, current: string, motebitId = MID) =>
  seedBackupPosture({ ack, currentPublicKeyHex: current, motebitId });

/** The owner wrote down a's seed: the acknowledgment binds a's public key. */
const ackFor = (kp: KeyPair): SeedBackupAcknowledgment => ({ at: 1_000, publicKeyHex: hex(kp) });

describe("seedBackupPosture — the acknowledgment covers the key it names", () => {
  it("never acknowledged ⇒ not backed up (not stale)", async () => {
    const a = await generateKeypair();
    expect(await postureOf({}, hex(a))).toEqual({ status: "not_backed_up", stale: false });
  });

  it("acknowledged for the current key ⇒ backed up", async () => {
    const a = await generateKeypair();
    expect(await postureOf(ackFor(a), hex(a))).toEqual({ status: "backed_up", at: 1_000 });
  });

  it("an old backup presented as current (key mismatch) ⇒ not backed up, naming the covered key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(await postureOf(ackFor(a), hex(b))).toEqual({
      status: "not_backed_up",
      stale: true,
      coveredPublicKeyHex: hex(a),
    });
  });

  it("no current key ⇒ never backed up", async () => {
    const a = await generateKeypair();
    expect((await postureOf(ackFor(a), "")).status).toBe("not_backed_up");
  });

  describe("legacy acknowledgment (no key recorded)", () => {
    it("honoured while the current key is the sovereign genesis key (never rotated)", async () => {
      const a = await generateKeypair();
      const sovereign = await deriveSovereignMotebitId(hex(a));
      expect(await postureOf({ at: 5 }, hex(a), sovereign)).toEqual({
        status: "backed_up",
        at: 5,
      });
    });

    it("NOT honoured once a sovereign identity has rotated (the already-rotated upgrader)", async () => {
      const a = await generateKeypair();
      const sovereign = await deriveSovereignMotebitId(hex(a));
      const { s, ports } = device(a, null);
      ports.motebitId = sovereign;
      expect((await performKeyRotation(ports)).kind).toBe("rotated");
      expect(await postureOf({ at: 5 }, s.pub, sovereign)).toEqual({
        status: "not_backed_up",
        stale: true,
        coveredPublicKeyHex: null,
      });
    });

    it("NOT honoured for a legacy (random) motebit_id — it cannot prove which key it covers", async () => {
      const a = await generateKeypair();
      expect(
        (await postureOf({ at: 5 }, hex(a), "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).status,
      ).toBe("not_backed_up");
    });
  });
});

describe("a committed rotation invalidates the previous seed backup", () => {
  it("rotate (no relay) ⇒ not backed up; the old acknowledgment is untouched", async () => {
    const a = await generateKeypair();
    const ack = ackFor(a);
    const { s, ports } = device(a, null);
    expect((await postureOf(ack, s.pub)).status).toBe("backed_up");
    const o = await performKeyRotation(ports);
    expect(o.kind).toBe("rotated");
    expect(await postureOf(ack, s.pub)).toEqual({
      status: "not_backed_up",
      stale: true,
      coveredPublicKeyHex: hex(a),
    });
    expect(ack).toEqual({ at: 1_000, publicKeyHex: hex(a) });
  });

  it("rotate (relay records it) ⇒ not backed up", async () => {
    const a = await generateKeypair();
    const { s, ports } = device(a, { departable: true, held_public_key: hex(a), post: "ok" });
    expect((await performKeyRotation(ports)).kind).toBe("rotated");
    expect((await postureOf(ackFor(a), s.pub)).status).toBe("not_backed_up");
  });

  it("refused rotation (old key stays) ⇒ unchanged; the write-ahead is kept aside", async () => {
    const a = await generateKeypair();
    const { s, ports } = device(a, { departable: true, held_public_key: hex(a), post: "refused" });
    const o = await performKeyRotation(ports);
    expect(o).toMatchObject({ kind: "stopped", state: "refused" });
    expect(await postureOf(ackFor(a), s.pub)).toEqual({ status: "backed_up", at: 1_000 });
    expect(s.keptAside).toHaveLength(1);
  });

  it("funds stop (abandoned before anything moves) ⇒ unchanged", async () => {
    const a = await generateKeypair();
    const { s, ports } = device(a, null);
    ports.readWalletHoldings = async () => ({ solLamports: 5_000_000n, tokens: [] });
    const o = await performKeyRotation(ports);
    expect(o).toMatchObject({ kind: "stopped", state: "funds-at-risk" });
    expect(s.commits).toBe(0);
    expect((await postureOf(ackFor(a), s.pub)).status).toBe("backed_up");
  });

  it("interrupted (answer lost ⇒ held) then resumed to commit ⇒ unchanged while held, invalidated at the commit", async () => {
    const a = await generateKeypair();
    const ack = ackFor(a);
    const first = device(a, { departable: true, held_public_key: hex(a), post: "lost" });
    const held = await performKeyRotation(first.ports);
    expect(held.kind).toBe("held");
    expect(first.s.pub).toBe(hex(a));
    expect((await postureOf(ack, first.s.pub)).status).toBe("backed_up");

    // Later run: the relay DID record it (S1 applied) — committed from the write-ahead.
    const w = first.s.held!;
    const resume = device(
      a,
      { departable: false, held_public_key: w.new_public_key, chain: [w.record] },
      { held: w },
    );
    const o = await performKeyRotation(resume.ports);
    expect(o).toMatchObject({ kind: "rotated", relay: "already-held" });
    expect((await postureOf(ack, resume.s.pub)).status).toBe("not_backed_up");
  });

  it("commit interrupted between its writes, finished on the next run ⇒ invalidated; re-running never re-marks", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const w: HeldRotation = {
      motebit_id: MID,
      old_public_key: hex(a),
      new_public_key: hex(b),
      record,
      new_private_key_hex: bytesToHex(b.privateKey),
      written_at: 1,
    };
    // The private key landed (b), the published key did not (still a).
    const { s, ports } = device(b, null, { held: w, published: hex(a) });
    const o = await performKeyRotation(ports);
    expect(o.notes).toContainEqual({
      kind: "interrupted-commit-finished",
      newPublicKeyHex: hex(b),
    });
    expect(s.pub).toBe(hex(b));
    expect((await postureOf(ackFor(a), s.pub)).status).toBe("not_backed_up");

    // Idempotent commit: calling it again with the same arguments (the
    // contract's "finish an interrupted commit") cannot bring "backed up" back.
    await ports.commit({
      privateKeyHex: w.new_private_key_hex,
      publicKeyHex: w.new_public_key,
      record,
      relay: "already-held",
    });
    expect((await postureOf(ackFor(a), s.pub)).status).toBe("not_backed_up");
  });

  it("restore (seed ⇒ key, acknowledgment bound to it) then rotate ⇒ invalidated", async () => {
    const restored = await generateKeypair();
    const ack = ackFor(restored); // restore: holding the seed IS the backup, for this key
    const { s, ports } = device(restored, null);
    expect((await postureOf(ack, s.pub)).status).toBe("backed_up");
    expect((await performKeyRotation(ports)).kind).toBe("rotated");
    expect((await postureOf(ack, s.pub)).status).toBe("not_backed_up");
  });

  it("two rotations: a backup of the middle key is stale after the second", async () => {
    const a = await generateKeypair();
    const { s, ports } = device(a, null);
    await performKeyRotation(ports);
    const middle: SeedBackupAcknowledgment = { at: 2_000, publicKeyHex: s.pub };
    expect((await postureOf(middle, s.pub)).status).toBe("backed_up");
    await performKeyRotation(ports);
    expect((await postureOf(middle, s.pub)).status).toBe("not_backed_up");
  });
});
