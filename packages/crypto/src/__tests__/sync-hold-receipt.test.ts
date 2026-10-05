/**
 * SyncHoldReceipt envelope law (spec/sync-hold-receipt-v1.md): sign → verify
 * round-trip, every fail-closed rejection, the pin/nonce options, page-range
 * coverage, domain separation against other signed artifacts, and the digest
 * canonicalisation the producer and verifier share.
 */
import { describe, it, expect } from "vitest";
import type { SyncHoldReceipt } from "@motebit/protocol";
import { generateKeypair, bytesToHex, canonicalJson, hash } from "../signing.js";
import {
  signSyncHoldReceipt,
  verifySyncHoldReceipt,
  computeSyncEventDigest,
  computeSyncEventDigestSync,
  SYNC_HOLD_RECEIPT_SUITE,
} from "../sync-hold-receipt.js";
import { createHash } from "node:crypto";
import { signRoutingTranscript } from "../routing-transcript.js";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const NONCE = "q7Zt1nC4cE3d8oN0nCeV4lUeXx"; // ≥128-bit base64url

async function mint(
  extra: Partial<Omit<SyncHoldReceipt, "signature" | "suite">> = {},
): Promise<{ receipt: SyncHoldReceipt; pub: string }> {
  const kp = await generateKeypair();
  const pub = bytesToHex(kp.publicKey);
  const receipt = await signSyncHoldReceipt(
    {
      spec: "motebit/sync-hold-receipt@1.0",
      relay_motebit_id: "relay-1",
      relay_public_key: pub,
      motebit_id: "alice",
      nonce: NONCE,
      issued_at: 1_760_000_000_000,
      events: [
        { event_id: "e1", digest: D1, redacted: false },
        { event_id: "e2", digest: D2, redacted: true },
      ],
      ...extra,
    },
    kp.privateKey,
  );
  return { receipt, pub };
}

async function mintPage(): Promise<{ receipt: SyncHoldReceipt; pub: string }> {
  return mint({
    events: [
      { event_id: "e1", digest: D1, redacted: false, seq: 4 },
      { event_id: "e2", digest: D2, redacted: false, seq: 7 },
    ],
    page: { after_seq: 3, next_seq: 7, has_more: false, latest_seq: 7 },
  });
}

describe("sync-hold-receipt envelope law", () => {
  it("sign → verify round-trips valid, pinned and nonce-checked", async () => {
    const { receipt, pub } = await mint();
    expect(receipt.suite).toBe(SYNC_HOLD_RECEIPT_SUITE);
    expect(await verifySyncHoldReceipt(receipt)).toEqual({ valid: true });
    expect(
      await verifySyncHoldReceipt(receipt, { expectedPublicKey: pub, expectedNonce: NONCE }),
    ).toEqual({ valid: true });
  });

  it("every single-field tamper fails", async () => {
    const { receipt } = await mint();
    const tampers: Array<Partial<SyncHoldReceipt>> = [
      { relay_motebit_id: "relay-2" },
      { motebit_id: "bob" },
      { nonce: NONCE + "x" },
      { issued_at: receipt.issued_at + 1 },
      { events: [receipt.events[0]!] },
      { events: [{ ...receipt.events[0]!, digest: D2 }, receipt.events[1]!] },
      { events: [{ ...receipt.events[0]!, event_id: "e9" }, receipt.events[1]!] },
      { events: [receipt.events[0]!, { ...receipt.events[1]!, redacted: false }] },
    ];
    for (const t of tampers) {
      const r = await verifySyncHoldReceipt({ ...receipt, ...t });
      expect(r.valid, JSON.stringify(t)).toBe(false);
    }
    // Removing the nonce (a replay as an "un-nonced" receipt) also fails.
    const { nonce: _n, ...noNonce } = receipt;
    expect((await verifySyncHoldReceipt(noNonce as SyncHoldReceipt)).valid).toBe(false);
  });

  it("a wrong pinned key fails; a substituted self-consistent key fails the signature", async () => {
    const { receipt } = await mint();
    const other = bytesToHex((await generateKeypair()).publicKey);
    expect(await verifySyncHoldReceipt(receipt, { expectedPublicKey: other })).toEqual({
      valid: false,
      reason: "public_key_mismatch",
    });
    expect(await verifySyncHoldReceipt({ ...receipt, relay_public_key: other })).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("the nonce must be echoed exactly", async () => {
    const { receipt } = await mint();
    expect(await verifySyncHoldReceipt(receipt, { expectedNonce: "different" })).toEqual({
      valid: false,
      reason: "nonce_mismatch",
    });
    const { receipt: unNonced } = await mint({ nonce: undefined });
    expect("nonce" in unNonced && unNonced.nonce !== undefined).toBe(false);
    expect((await verifySyncHoldReceipt(unNonced, { expectedNonce: NONCE })).reason).toBe(
      "nonce_mismatch",
    );
  });

  it("unknown suite or spec is rejected fail-closed", async () => {
    const { receipt } = await mint();
    expect(
      (
        await verifySyncHoldReceipt({
          ...receipt,
          suite: "motebit-jcs-ed25519-hex-v1" as "motebit-jcs-ed25519-b64-v1",
        })
      ).reason,
    ).toBe("unsupported_suite");
    expect(
      (
        await verifySyncHoldReceipt({
          ...receipt,
          spec: "motebit/routing-transcript@1.0" as "motebit/sync-hold-receipt@1.0",
        })
      ).reason,
    ).toBe("unsupported_spec");
  });

  it("another signed artifact re-labelled as a hold receipt does not verify", async () => {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const transcript = await signRoutingTranscript(
      {
        spec: "motebit/routing-transcript@1.0",
        capability: "x",
        delegator_motebit_id: "relay-1",
        delegator_public_key: pub,
        candidates: [{ motebit_id: "w", trust_axis: 1, reliability_axis: 1 }],
        seed: "s",
        strength: 0,
        weights: { trust: 1, reliability: 0, cost: 0, latency: 0 },
        count_cap: 1,
        bond_explore_boost: 1,
        default_latency_ms: 1,
        algorithm_version: "v",
        winner_motebit_id: "w",
        explored: false,
        issued_at: 1,
      },
      kp.privateKey,
    );
    const relabelled = {
      ...transcript,
      spec: "motebit/sync-hold-receipt@1.0",
      relay_motebit_id: "relay-1",
      relay_public_key: pub,
      motebit_id: "alice",
      events: [],
    } as unknown as SyncHoldReceipt;
    expect((await verifySyncHoldReceipt(relabelled)).valid).toBe(false);
  });

  it("a page receipt covers its seq range — altering from/to or a seq fails", async () => {
    const { receipt, pub } = await mintPage();
    expect(await verifySyncHoldReceipt(receipt, { expectedPublicKey: pub })).toEqual({
      valid: true,
    });
    const page = receipt.page!;
    // Moving `after_seq` below the first listed seq keeps the structure
    // consistent, so only the signature can catch it.
    expect(await verifySyncHoldReceipt({ ...receipt, page: { ...page, after_seq: 0 } })).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
    expect(
      (await verifySyncHoldReceipt({ ...receipt, page: { ...page, next_seq: 9 } })).valid,
    ).toBe(false);
    expect(
      (await verifySyncHoldReceipt({ ...receipt, page: { ...page, has_more: true } })).valid,
    ).toBe(false);
    expect(
      (await verifySyncHoldReceipt({ ...receipt, page: { ...page, latest_seq: 99 } })).valid,
    ).toBe(false);
    // Dropping the page turns it into a push-shaped receipt carrying seqs: refused.
    const { page: _p, ...noPage } = receipt;
    expect((await verifySyncHoldReceipt(noPage as SyncHoldReceipt)).reason).toBe("page_mismatch");
  });

  it("page structure is checked before crypto", async () => {
    const outOfRange = await mint({
      events: [{ event_id: "e1", digest: D1, redacted: false, seq: 9 }],
      page: { after_seq: 3, next_seq: 7, has_more: false, latest_seq: 9 },
    });
    expect((await verifySyncHoldReceipt(outOfRange.receipt)).reason).toBe("page_mismatch");
    const missingSeq = await mint({
      events: [{ event_id: "e1", digest: D1, redacted: false }],
      page: { after_seq: 0, next_seq: 1, has_more: false, latest_seq: 1 },
    });
    expect((await verifySyncHoldReceipt(missingSeq.receipt)).reason).toBe("page_mismatch");
    const empty = await mint({
      events: [],
      page: { after_seq: 5, next_seq: 5, has_more: false, latest_seq: 5 },
    });
    expect((await verifySyncHoldReceipt(empty.receipt)).valid).toBe(true);
  });

  it("malformed shapes are rejected", async () => {
    const { receipt } = await mint();
    const bad: Array<Partial<SyncHoldReceipt>> = [
      { events: [{ event_id: "e1", digest: "nothex", redacted: false }] },
      { events: [{ event_id: "", digest: D1, redacted: false }] },
      {
        events: [
          { event_id: "e1", digest: D1, redacted: false },
          { event_id: "e1", digest: D1, redacted: false },
        ],
      },
    ];
    for (const b of bad) {
      expect((await verifySyncHoldReceipt({ ...receipt, ...b })).reason).toBe("malformed_receipt");
    }
    expect((await verifySyncHoldReceipt({ ...receipt, relay_public_key: "zz" })).reason).toBe(
      "malformed_public_key",
    );
    expect((await verifySyncHoldReceipt({ ...receipt, signature: "AAAA" })).reason).toBe(
      "malformed_signature",
    );
  });

  it("the signed bytes are JCS-canonical: key order does not matter", async () => {
    const { receipt } = await mint();
    const reordered = Object.fromEntries(
      Object.entries(receipt).reverse(),
    ) as unknown as SyncHoldReceipt;
    expect(await verifySyncHoldReceipt(reordered)).toEqual({ valid: true });
  });
});

describe("computeSyncEventDigest", () => {
  it("is SHA-256 over the JCS-canonical entry, independent of key order", async () => {
    const a = {
      event_id: "e1",
      motebit_id: "alice",
      payload: { b: 1, a: [2, 1] },
      tombstoned: false,
    };
    const b = {
      tombstoned: false,
      payload: { a: [2, 1], b: 1 },
      motebit_id: "alice",
      event_id: "e1",
    };
    const expected = await hash(new TextEncoder().encode(canonicalJson(a)));
    expect(await computeSyncEventDigest(a)).toBe(expected);
    expect(await computeSyncEventDigest(b)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeSyncEventDigest({ ...a, payload: { b: 1, a: [1, 2] } })).not.toBe(expected);
  });
});

describe("page subset + synchronous digest", () => {
  it("a page receipt may list a subset of its page (an omitted event is never credited)", async () => {
    // Seqs 4..7 served; only 4 listed (5..7 omitted — status unknown).
    const subset = await mint({
      events: [{ event_id: "e1", digest: D1, redacted: false, seq: 4 }],
      page: { after_seq: 3, next_seq: 7, has_more: false, latest_seq: 7 },
    });
    expect(await verifySyncHoldReceipt(subset.receipt, { expectedPublicKey: subset.pub })).toEqual({
      valid: true,
    });
    const none = await mint({
      events: [],
      page: { after_seq: 3, next_seq: 7, has_more: false, latest_seq: 7 },
    });
    expect((await verifySyncHoldReceipt(none.receipt)).valid).toBe(true);
    // A listed seq above next_seq is still refused structurally.
    const above = await mint({
      events: [{ event_id: "e1", digest: D1, redacted: false, seq: 8 }],
      page: { after_seq: 3, next_seq: 7, has_more: false, latest_seq: 9 },
    });
    expect((await verifySyncHoldReceipt(above.receipt)).reason).toBe("page_mismatch");
  });

  it("computeSyncEventDigestSync equals the async digest, default and injected hash", async () => {
    const entries: unknown[] = [
      { event_id: "x", payload: { b: [1, { z: 2, a: "é" }], a: null }, version_clock: 3 },
      { event_id: "y", payload: { content: "x".repeat(4096) } },
      {},
    ];
    const nodeSha = (b: Uint8Array): Uint8Array =>
      new Uint8Array(createHash("sha256").update(b).digest());
    for (const e of entries) {
      const expected = await computeSyncEventDigest(e);
      expect(computeSyncEventDigestSync(e)).toBe(expected);
      expect(computeSyncEventDigestSync(e, nodeSha)).toBe(expected);
    }
  });
});
