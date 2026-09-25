/**
 * `resolveRosterKeyChain` — docs/proposals/machine-roster-clients-v1.md
 * C1 and §2A, case by case. The quantified claims (only three refusals,
 * order/duplication/junk invariance, suffix invariance against the law)
 * are in `roster-key-chain-properties.test.ts`.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signKeySuccession,
  signGuardianRecoverySuccession,
  verifySuccessionChain,
  deriveSovereignMotebitId,
  hexPublicKeyToDidKey,
  resolveRosterKeyChain,
} from "../index.js";
import type {
  KeyPair,
  KeySuccessionRecord,
  RosterKeyChainOk,
  RosterKeyChainResult,
} from "../index.js";

const LEGACY_ID = "019d903f-13de-75a4-8341-58319e0a2f16"; // UUIDv7: never sovereign

let K: KeyPair[]; // K0..K5
let hex: string[];
let G: KeyPair; // guardian
let S: KeyPair; // stranger

beforeAll(async () => {
  K = await Promise.all([0, 1, 2, 3, 4, 5].map(() => generateKeypair()));
  hex = K.map((k) => bytesToHex(k.publicKey));
  G = await generateKeypair();
  S = await generateKeypair();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const h = (kp: KeyPair) => bytesToHex(kp.publicKey);
const rotate = (a: KeyPair, b: KeyPair) =>
  signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
const recover = (guardian: KeyPair, a: KeyPair, b: KeyPair) =>
  signGuardianRecoverySuccession(guardian.privateKey, b.privateKey, a.publicKey, b.publicKey);

function ok(r: RosterKeyChainResult): RosterKeyChainOk {
  if (!r.ok) throw new Error(`expected a chain, got ${r.reason}: ${r.detail}`);
  return r;
}
function refused(r: RosterKeyChainResult): string {
  if (r.ok) throw new Error(`expected a refusal, got chain ${r.chain.join(",")}`);
  return r.reason;
}
const resolve = (
  held: KeyPair,
  records: unknown[],
  opts: { motebitId?: string; guardianKey?: string } = {},
) =>
  resolveRosterKeyChain({
    motebitId: opts.motebitId ?? LEGACY_ID,
    held: h(held),
    records,
    ...(opts.guardianKey !== undefined ? { guardianKey: opts.guardianKey } : {}),
  });

describe("resolveRosterKeyChain — the walk", () => {
  it("a linear chain under a legacy id resolves oldest → newest, unrooted at the genesis", async () => {
    const links = [
      await rotate(K[0]!, K[1]!),
      await rotate(K[1]!, K[2]!),
      await rotate(K[2]!, K[3]!),
    ];
    const r = ok(await resolve(K[3]!, [...links].reverse()));
    expect(r.chain).toEqual(hex.slice(0, 4));
    expect(r.head).toBe(hex[3]);
    expect(r.links).toEqual(links);
    expect(r.ancestry).toEqual({ kind: "unrooted", key: hex[0] });
    expect(r.sovereign_id).toBe(false);
    expect(r.branches).toEqual([]);
    expect(r.suppress_universal_claims).toBe(false);
  });

  it("no records: the chain is the held key alone", async () => {
    const r = ok(await resolve(K[0]!, []));
    expect(r.chain).toEqual([hex[0]]);
    expect(r.links).toEqual([]);
    expect(r.ancestry).toEqual({ kind: "unrooted", key: hex[0] });
  });

  it("#706 — timestamps are never read: two rotations recorded out of order still resolve", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    const first = await rotate(K[0]!, K[1]!);
    now.mockReturnValue(1_000_000); // the second rotation carries an EARLIER timestamp
    const second = await rotate(K[1]!, K[2]!);
    // The timestamp-ordered verifier cannot accept this chain in either order.
    expect((await verifySuccessionChain([first, second])).valid).toBe(false);
    expect((await verifySuccessionChain([second, first])).valid).toBe(false);
    const r = ok(await resolve(K[2]!, [second, first]));
    expect(r.chain).toEqual([hex[0], hex[1], hex[2]]);
  });

  it("relay loss: the cached records alone resolve the chain the served ones did", async () => {
    const links = [await rotate(K[0]!, K[1]!), await rotate(K[1]!, K[2]!)];
    const served = links;
    const cached = links.map((l) => ({ ...l }));
    const both = ok(await resolve(K[2]!, [...served, ...cached]));
    const afterLoss = ok(await resolve(K[2]!, [/* relay serves [] */ ...cached]));
    expect(afterLoss).toEqual(both);
    expect(afterLoss.chain).toEqual([hex[0], hex[1], hex[2]]);
  });

  it("junk is ignored: bad-signature copies, strangers, malformed objects", async () => {
    const link = await rotate(K[0]!, K[1]!);
    const forged = { ...link, old_key_signature: link.new_key_signature }; // same (old,new), bad sig
    const strangerIn = await rotate(S, K[2]!); // valid record, but into an unrelated key
    const upper = { ...link, old_public_key: link.old_public_key.toUpperCase() };
    const junk: unknown[] = [
      null,
      42,
      "x",
      [link],
      { ...link, suite: "motebit-jcs-ed25519-b64-v1" },
      { ...link, timestamp: -0 },
      { ...link, timestamp: 1.5 },
      { ...link, recovery: "yes" },
      upper,
      strangerIn,
    ];
    const clean = ok(await resolve(K[1]!, [link]));
    // A garbage copy of the SAME link placed first must not displace the real one:
    // records are deduplicated by (old, new) only AFTER verification.
    expect(ok(await resolve(K[1]!, [forged, ...junk, link]))).toEqual(clean);
    expect(ok(await resolve(K[1]!, [forged]))).toEqual({
      ...clean,
      chain: [hex[1]],
      links: [],
      ancestry: { kind: "unrooted", key: hex[1] },
    });
  });

  it("a returned record carries exactly its known fields", async () => {
    const link = await rotate(K[0]!, K[1]!);
    const r = ok(await resolve(K[1]!, [{ ...link, injected: "x", reason: undefined }]));
    expect(r.links).toEqual([link]);
    expect(Object.keys(r.links[0]!).sort()).toEqual(Object.keys(link).sort());
  });
});

describe("resolveRosterKeyChain — ancestry is disclosed, never refused", () => {
  it("a sovereign id: rooted when the genesis is reachable, UNROOTED (not refused) when truncated", async () => {
    const id = await deriveSovereignMotebitId(hex[0]!);
    const l01 = await rotate(K[0]!, K[1]!);
    const l12 = await rotate(K[1]!, K[2]!);
    const whole = ok(await resolve(K[2]!, [l01, l12], { motebitId: id }));
    expect(whole.ancestry).toEqual({ kind: "rooted", key: hex[0], predecessors: [] });
    expect(whole.sovereign_id).toBe(true);
    const truncated = ok(await resolve(K[2]!, [l12], { motebitId: id }));
    expect(truncated.chain).toEqual([hex[1], hex[2]]);
    expect(truncated.ancestry).toEqual({ kind: "unrooted", key: hex[1] });
    expect(truncated.sovereign_id).toBe(true);
  });

  it("a did:key id is sovereign-shaped and roots at the key it encodes", async () => {
    const id = hexPublicKeyToDidKey(hex[0]!);
    const r = ok(await resolve(K[1]!, [await rotate(K[0]!, K[1]!)], { motebitId: id }));
    expect(r.ancestry).toEqual({ kind: "rooted", key: hex[0], predecessors: [] });
    expect(r.sovereign_id).toBe(true);
  });

  it("N10 — the genesis ends the walk; its predecessors are disclosed, never walked", async () => {
    const id = await deriveSovereignMotebitId(hex[1]!);
    const before = await rotate(K[0]!, K[1]!); // a record INTO the genesis (holder of K1 signed it)
    const other = await rotate(K[5]!, K[1]!);
    const r = ok(
      await resolve(K[2]!, [before, other, await rotate(K[1]!, K[2]!)], { motebitId: id }),
    );
    expect(r.chain).toEqual([hex[1], hex[2]]);
    expect(r.ancestry).toEqual({
      kind: "rooted",
      key: hex[1],
      predecessors: [hex[0]!, hex[5]!].sort(),
    });
    // At the held key too: two predecessors of a held GENESIS is not `fork_at_held`.
    const atHeld = ok(await resolve(K[1]!, [before, other], { motebitId: id }));
    expect(atHeld.chain).toEqual([hex[1]]);
    expect(atHeld.ancestry.kind).toBe("rooted");
  });

  it("an ancestor fork stops the walk and is disclosed as forked_below", async () => {
    const r = ok(
      await resolve(K[2]!, [
        await rotate(K[0]!, K[1]!),
        await rotate(K[5]!, K[1]!),
        await rotate(K[1]!, K[2]!),
      ]),
    );
    expect(r.chain).toEqual([hex[1], hex[2]]);
    expect(r.ancestry).toEqual({
      kind: "forked_below",
      key: hex[1],
      predecessors: [hex[0]!, hex[5]!].sort(),
    });
  });

  it("an uncheckable recovery predecessor stops the walk as recovery_limited; a pinned guardian walks through it", async () => {
    const rec = await recover(G, K[0]!, K[1]!);
    const l12 = await rotate(K[1]!, K[2]!);
    const limited = ok(await resolve(K[2]!, [rec, l12]));
    expect(limited.chain).toEqual([hex[1], hex[2]]);
    expect(limited.ancestry).toEqual({
      kind: "recovery_limited",
      key: hex[1],
      predecessors: [hex[0]],
    });
    const withGuardian = ok(await resolve(K[2]!, [rec, l12], { guardianKey: h(G) }));
    expect(withGuardian.chain).toEqual([hex[0], hex[1], hex[2]]);
    expect(withGuardian.links).toEqual([rec, l12]);
    // A WRONG pinned guardian: the link is checked and fails — ignored, not "limited".
    const wrong = ok(await resolve(K[2]!, [rec, l12], { guardianKey: h(S) }));
    expect(wrong.ancestry).toEqual({ kind: "unrooted", key: hex[1] });
  });

  it("an uncheckable recovery beside a verified normal predecessor still stops at that key", async () => {
    const r = ok(
      await resolve(K[2]!, [
        await rotate(K[5]!, K[1]!),
        await recover(G, K[0]!, K[1]!),
        await rotate(K[1]!, K[2]!),
      ]),
    );
    expect(r.chain).toEqual([hex[1], hex[2]]);
    expect(r.ancestry).toEqual({ kind: "recovery_limited", key: hex[1], predecessors: [hex[0]] });
  });

  it("a 'recovery' predecessor whose NEW-key signature fails is junk anyone could mint — ignored", async () => {
    // A stranger signs a recovery INTO K1 with its own key standing in for K1's.
    const forged = await recover(S, K[0]!, S);
    const into = { ...forged, new_public_key: hex[1]! };
    const r = ok(await resolve(K[2]!, [into, await rotate(K[1]!, K[2]!)]));
    expect(r.ancestry).toEqual({ kind: "unrooted", key: hex[1] });
  });
});

describe("resolveRosterKeyChain — the three refusals", () => {
  it("#775 [A,B,A] — duplicate_key, checked BEFORE held_key_superseded", async () => {
    // Pinned against #775 (open): /rotate-key accepts a rotation back to an earlier key.
    const ab = await rotate(K[0]!, K[1]!);
    const ba = await rotate(K[1]!, K[0]!);
    const r = await resolve(K[0]!, [ab, ba]);
    // A→B has old == held, so held_key_superseded ALSO applies — duplicate_key wins.
    expect(refused(r)).toBe("duplicate_key");
    if (!r.ok && r.reason === "duplicate_key") expect(r.key).toBe(hex[0]);
  });

  it("#775 with history — a rotation back to a NON-genesis key is duplicate_key, not fork_at_held", async () => {
    // K0 → K1 → K2 → K1: K1 now has two predecessors (K0 and K2), which the
    // walk alone would read as a fork at the held key. It is a repeated key.
    const l01 = await rotate(K[0]!, K[1]!);
    const l12 = await rotate(K[1]!, K[2]!);
    const l21 = await rotate(K[2]!, K[1]!);
    const r = await resolve(K[1]!, [l01, l12, l21]);
    expect(refused(r)).toBe("duplicate_key");
    if (!r.ok && r.reason === "duplicate_key") {
      expect(r.key).toBe(hex[1]);
      expect(r.evidence).toEqual([l12, l21]); // K1 → K2 → K1, oldest → newest
    }
    // Held under the key rotated away from, the cycle still passes through it.
    expect(refused(await resolve(K[2]!, [l01, l12, l21]))).toBe("duplicate_key");
    // Under a sovereign id whose genesis is the held key, N10 does not hide it.
    const id = await deriveSovereignMotebitId(hex[0]!);
    const back = await rotate(K[1]!, K[0]!);
    expect(refused(await resolve(K[0]!, [l01, back], { motebitId: id }))).toBe("duplicate_key");
  });

  it("a cycle below the held key is duplicate_key", async () => {
    const r = await resolve(K[2]!, [
      await rotate(K[0]!, K[1]!),
      await rotate(K[1]!, K[0]!),
      await rotate(K[1]!, K[2]!),
    ]);
    // K2 ← K1 ← K0 ← K1: K1 has one verified predecessor (K0), K0 one (K1).
    expect(refused(r)).toBe("duplicate_key");
  });

  it("fork_at_held — two verified predecessors of the held key", async () => {
    const a = await rotate(K[0]!, K[2]!);
    const b = await rotate(K[1]!, K[2]!);
    const r = await resolve(K[2]!, [a, b]);
    expect(refused(r)).toBe("fork_at_held");
    if (!r.ok && r.reason === "fork_at_held") {
      expect(new Set(r.evidence)).toEqual(new Set([a, b]));
    }
  });

  it("held_key_superseded — a normal record rotating the held key away", async () => {
    const l01 = await rotate(K[0]!, K[1]!);
    const l12 = await rotate(K[1]!, K[2]!);
    const r = await resolve(K[1]!, [l01, l12]);
    expect(refused(r)).toBe("held_key_superseded");
    if (!r.ok && r.reason === "held_key_superseded") expect(r.evidence).toEqual([l12]);
  });

  it("held_key_superseded — a guardian-verified recovery away from the held key (R23)", async () => {
    const rec = await recover(G, K[1]!, K[2]!);
    expect(refused(await resolve(K[1]!, [rec], { guardianKey: h(G) }))).toBe("held_key_superseded");
    // Uncheckable (no guardian): anyone can mint a recovery to a key of their own. Ignored.
    expect(ok(await resolve(K[1]!, [rec])).chain).toEqual([hex[1]]);
    // A stranger's "recovery" away from the held key, even with a guardian pinned: ignored.
    const junk = await recover(S, K[1]!, S);
    expect(ok(await resolve(K[1]!, [junk], { guardianKey: h(G) })).chain).toEqual([hex[1]]);
  });

  it("malformed_input only for a malformed CALL", async () => {
    const bad = [
      { motebitId: "", held: hex[0], records: [] },
      { motebitId: LEGACY_ID, held: hex[0]!.toUpperCase(), records: [] },
      { motebitId: LEGACY_ID, held: "zz", records: [] },
      { motebitId: LEGACY_ID, held: hex[0], records: "nope" },
      { motebitId: LEGACY_ID, held: hex[0], records: [], guardianKey: "G" },
    ];
    for (const input of bad) {
      expect(refused(await resolveRosterKeyChain(input as never))).toBe("malformed_input");
    }
  });
});

describe("resolveRosterKeyChain — sibling branches (C1.3)", () => {
  let ab: KeySuccessionRecord;
  let acNormal: KeySuccessionRecord;
  let acRecovery: KeySuccessionRecord;
  beforeAll(async () => {
    // A = K0, B = K1, C = K2
    ab = await rotate(K[0]!, K[1]!);
    acNormal = await rotate(K[0]!, K[2]!);
    acRecovery = await recover(G, K[0]!, K[2]!);
  });

  it("this device holds C: accept C; B is an abandoned branch, disclosed, not suppressing", async () => {
    const r = ok(await resolve(K[2]!, [ab /* the cache's link */, acNormal]));
    expect(r.chain).toEqual([hex[0], hex[2]]);
    expect(r.branches).toEqual([{ at: hex[0], to: hex[1], guardian_verified: false, record: ab }]);
    expect(r.suppress_universal_claims).toBe(false);
  });

  it("this device holds B and the sibling A→C is guardian-verified: universal claims suppressed", async () => {
    const r = ok(await resolve(K[1]!, [ab, acRecovery], { guardianKey: h(G) }));
    expect(r.chain).toEqual([hex[0], hex[1]]);
    expect(r.branches).toEqual([
      { at: hex[0], to: hex[2], guardian_verified: true, record: acRecovery },
    ]);
    expect(r.suppress_universal_claims).toBe(true);
  });

  it("the sibling is signed normally: branch_seen(A) disclosed, never suppressing", async () => {
    const r = ok(await resolve(K[1]!, [ab, acNormal]));
    expect(r.branches).toEqual([
      { at: hex[0], to: hex[2], guardian_verified: false, record: acNormal },
    ]);
    expect(r.suppress_universal_claims).toBe(false);
  });

  it("an uncheckable recovery sibling (no guardian) is not a branch", async () => {
    const r = ok(await resolve(K[1]!, [ab, acRecovery]));
    expect(r.branches).toEqual([]);
    expect(r.suppress_universal_claims).toBe(false);
  });

  it("a link with both a normal and a guardian-verified copy is guardian-verified", async () => {
    const r = ok(await resolve(K[1]!, [ab, acNormal, acRecovery], { guardianKey: h(G) }));
    expect(r.branches.map((b) => b.guardian_verified)).toEqual([true]);
    expect(r.suppress_universal_claims).toBe(true);
  });
});
