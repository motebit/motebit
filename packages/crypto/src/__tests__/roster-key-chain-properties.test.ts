/**
 * `resolveRosterKeyChain`'s UNIVERSAL claims, checked as such
 * (docs/proposals/machine-roster-clients-v1.md C7, C-0).
 *
 * A pool of AUTHENTICALLY signed succession records is minted once —
 * the true chain K0→K1→K2→K3, plus everything the design names as a
 * hazard: an ancestor fork, a guardian-verified and a normal sibling
 * branch, a rotation back to an earlier key (#775), an uncheckable
 * recovery, a genesis predecessor, strangers, forged copies, malformed
 * objects. Properties draw subsets of it, so the cases combine in ways
 * nobody listed.
 *
 * Suffix invariance is pinned against THE LAW: a host-roster pool (the
 * pattern of `host-roster-properties.test.ts`) is reduced by
 * `verifyHostRoster` under the chain this primitive resolves and under
 * the whole true chain, and the active set and the head's key must
 * agree for every resolvable suffix.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  generateKeypair,
  bytesToHex,
  signKeySuccession,
  signGuardianRecoverySuccession,
  signHostEnrollment,
  signHostRetirement,
  hostEnrollmentId,
  verifyHostRoster,
  deriveSovereignMotebitId,
  resolveRosterKeyChain,
} from "../index.js";
import type {
  KeyPair,
  KeySuccessionRecord,
  HostRosterResult,
  HostRosterVerdict,
  RosterKeyChainResult,
} from "../index.js";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";

const LEGACY_ID = "019d903f-13de-75a4-8341-58319e0a2f16";
const REFUSALS = new Set(["duplicate_key", "fork_at_held", "held_key_superseded"]);

let K: KeyPair[]; // K0..K3 the true chain; K4..K11 the keys the hazards bring in
let hex: string[];
let G: KeyPair;
let sovereignId: string;
let truth: KeySuccessionRecord[]; // K0→K1, K1→K2, K2→K3
let hazards: KeySuccessionRecord[];
let junk: unknown[]; // records that can never verify or never touch a path

let enrolments: HostEnrollment[];
let retirements: HostRetirement[];

const rotate = (a: KeyPair, b: KeyPair) =>
  signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
const recover = (g: KeyPair, a: KeyPair, b: KeyPair) =>
  signGuardianRecoverySuccession(g.privateKey, b.privateKey, a.publicKey, b.publicKey);

beforeAll(async () => {
  K = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(() => generateKeypair()));
  hex = K.map((k) => bytesToHex(k.publicKey));
  G = await generateKeypair();
  const S = await generateKeypair();
  const T = await generateKeypair();
  sovereignId = await deriveSovereignMotebitId(hex[0]!);

  truth = [await rotate(K[0]!, K[1]!), await rotate(K[1]!, K[2]!), await rotate(K[2]!, K[3]!)];
  // Each hazard brings in its OWN key, so the pool is acyclic except
  // where a cycle is the hazard (#775, and the cycles below the head).
  hazards = [
    await rotate(K[4]!, K[1]!), // ancestor fork at K1
    await rotate(K[1]!, K[6]!), // normal sibling branch at K1
    await recover(G, K[2]!, K[5]!), // guardian-verified sibling at K2
    await recover(G, K[7]!, K[2]!), // recovery predecessor of K2 (uncheckable without G)
    await rotate(K[8]!, K[0]!), // a predecessor of the genesis (N10)
    await rotate(K[3]!, K[1]!), // rotation back to an earlier key (#775)
    await rotate(K[3]!, K[9]!), // rotates the head away
    // Cycles BELOW the head, each minted by old keys alone (W1):
    await rotate(K[1]!, K[1]!), // a self-loop (the relay refuses these; a holder of K1 can still sign one)
    await rotate(K[0]!, K[10]!), // with the next: a 2-cycle by the legacy-genesis holder
    await rotate(K[10]!, K[0]!),
    await rotate(K[1]!, K[11]!), // with the next: a 2-cycle at a non-genesis key (bites when K0→K1 is withheld)
    await rotate(K[11]!, K[1]!),
  ];
  const base = truth[1]!;
  junk = [
    { ...base, old_key_signature: base.new_key_signature }, // forged copy of a true link
    { ...base, new_key_signature: base.old_key_signature }, // forged the other way
    await rotate(S, T), // valid, unrelated
    await recover(S, K[3]!, T), // stranger "recovery" away from the head
    { ...(await recover(S, K[0]!, S)), new_public_key: hex[1]! }, // bad new-key sig into K1
    { ...base, suite: "nope" },
    { ...base, new_public_key: hex[2]!.toUpperCase() },
    null,
    7,
    [base],
  ];

  // Host-roster pool: every device enrolled under every true key and a
  // stranger; every enrolment retired by every key.
  enrolments = [];
  retirements = [];
  const signers = [K[0]!, K[1]!, K[2]!, K[3]!, S];
  for (const kp of signers) {
    for (const device_id of ["a", "b", "c"]) {
      enrolments.push(
        await signHostEnrollment(
          {
            motebit_id: LEGACY_ID,
            device_id,
            public_key: bytesToHex(kp.publicKey),
            enrolled_at: 1_000,
          },
          kp.privateKey,
        ),
      );
    }
  }
  for (const e of enrolments) {
    for (const kp of signers) {
      retirements.push(
        await signHostRetirement(
          {
            motebit_id: LEGACY_ID,
            enrollment_id: await hostEnrollmentId(e),
            public_key: bytesToHex(kp.publicKey),
            retired_at: 2_000,
          },
          kp.privateKey,
        ),
      );
    }
  }
});

// BOUNDED draws, as in host-roster-properties: each touched record costs
// one or two Ed25519 verifications, and more runs buy more coverage than
// bigger draws do.
const RUNS = { numRuns: 60 };
const SLOW = 120_000;

const pool = () => [...truth, ...hazards];
const subset = () => fc.subarray(pool(), { maxLength: 10 });
const heldIndex = () => fc.integer({ min: 0, max: 11 });
const guardianOpt = () => fc.constantFrom<"G" | "none">("G", "none");
const idOpt = () => fc.constantFrom<"legacy" | "sovereign">("legacy", "sovereign");

const run = (
  records: unknown[],
  held: number,
  guardian: "G" | "none",
  id: "legacy" | "sovereign",
): Promise<RosterKeyChainResult> =>
  resolveRosterKeyChain({
    motebitId: id === "legacy" ? LEGACY_ID : sovereignId,
    held: hex[held]!,
    records,
    ...(guardian === "G" ? { guardianKey: bytesToHex(G.publicKey) } : {}),
  });

function shuffleWith<T>(xs: T[], seed: fc.Stream<number>): T[] {
  return xs
    .map((x) => [seed.next().value as number, x] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, x]) => x);
}

describe("resolveRosterKeyChain — properties", () => {
  it("the pool reaches every outcome (so the properties below quantify over all of them)", async () => {
    const [f41, s16, g25, r72, p80, back31, away39, loop11, c0a, c0b, c1a, c1b] = hazards;
    const outcome = (r: RosterKeyChainResult) =>
      r.ok ? `${r.ancestry.kind}${r.suppress_universal_claims ? "+suppressed" : ""}` : r.reason;
    const cases: Array<[unknown[], number, "G" | "none", "legacy" | "sovereign", string]> = [
      [truth, 3, "none", "legacy", "unrooted"],
      [truth, 3, "none", "sovereign", "rooted"],
      [[...truth, p80!], 3, "none", "sovereign", "rooted"],
      [[...truth, f41!], 3, "none", "legacy", "forked_below"],
      [[truth[1]!, truth[2]!, r72!], 3, "none", "legacy", "recovery_limited"],
      [[...truth, g25!], 3, "G", "legacy", "unrooted+suppressed"],
      [[...truth, s16!], 3, "G", "legacy", "unrooted"],
      [[...truth, back31!], 3, "none", "legacy", "duplicate_key"],
      [[truth[1]!, r72!], 2, "G", "legacy", "fork_at_held"],
      [[...truth, away39!], 3, "none", "legacy", "held_key_superseded"],
      [[...truth, loop11!], 3, "none", "legacy", "cycle_below"],
      [[...truth, c0a!, c0b!], 3, "none", "legacy", "cycle_below"],
      [[truth[1]!, truth[2]!, c1a!, c1b!], 3, "none", "sovereign", "cycle_below"],
    ];
    for (const [recs, held, g, id, want] of cases) {
      expect(outcome(await run(recs, held, g, id))).toBe(want);
    }
  });

  it(
    "only the three refusals ever occur, and every chain is one the law accepts",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          subset(),
          fc.subarray(junk, { maxLength: 4 }),
          heldIndex(),
          guardianOpt(),
          idOpt(),
          async (recs, j, held, g, id) => {
            const r = await run([...recs, ...j], held, g, id);
            if (!r.ok) {
              expect(REFUSALS.has(r.reason)).toBe(true);
              return;
            }
            expect(r.chain[r.chain.length - 1]).toBe(hex[held]);
            expect(r.head).toBe(hex[held]);
            expect(r.ancestry.key).toBe(r.chain[0]);
            expect(new Set(r.chain).size).toBe(r.chain.length);
            expect(r.links.length).toBe(r.chain.length - 1);
            r.links.forEach((l, i) => {
              expect(l.old_public_key).toBe(r.chain[i]);
              expect(l.new_public_key).toBe(r.chain[i + 1]);
            });
            for (const b of r.branches) {
              expect(r.chain).toContain(b.at);
              expect(b.at).not.toBe(r.head);
            }
            expect(r.suppress_universal_claims).toBe(r.branches.some((b) => b.guardian_verified));
            const law = await verifyHostRoster({
              motebitId: LEGACY_ID,
              keyChain: r.chain,
              enrollments: [],
              retirements: [],
            });
            expect(law.ok).toBe(true);
          },
        ),
        RUNS,
      );
    },
    SLOW,
  );

  it(
    "the WHOLE result is independent of record order and multiplicity",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          subset(),
          heldIndex(),
          guardianOpt(),
          idOpt(),
          fc.infiniteStream(fc.nat()),
          async (recs, held, g, id, seed) => {
            const base = await run(recs, held, g, id);
            const again = await run(shuffleWith([...recs, ...recs, ...recs], seed), held, g, id);
            expect(again).toEqual(base);
          },
        ),
        RUNS,
      );
    },
    SLOW,
  );

  it(
    "junk and unrelated records change nothing",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          subset(),
          fc.subarray(junk, { minLength: 1 }),
          heldIndex(),
          guardianOpt(),
          fc.infiniteStream(fc.nat()),
          async (recs, j, held, g, seed) => {
            const base = await run(recs, held, g, "legacy");
            expect(await run(shuffleWith([...j, ...recs], seed), held, g, "legacy")).toEqual(base);
          },
        ),
        RUNS,
      );
    },
    SLOW,
  );

  it(
    "ancestry hazards below the held key are disclosed, never refused",
    async () => {
      // Every hazard that touches only keys BELOW the head — ancestor
      // fork, uncheckable recovery, sibling branches, genesis predecessor,
      // truncation — combined arbitrarily with any part of the true chain.
      const below = () => fc.subarray(hazards.filter((x) => x.old_public_key !== hex[3]));
      await fc.assert(
        fc.asyncProperty(
          fc.subarray(truth),
          below(),
          guardianOpt(),
          idOpt(),
          async (t, hz, g, id) => {
            // No hazard kept here enters the head or rotates it away, and
            // none closes a cycle, so no refusal is reachable.
            const r = await run([...t, ...hz], 3, g, id);
            if (!r.ok) throw new Error(`refused: ${r.reason}`);
            expect(r.chain[r.chain.length - 1]).toBe(hex[3]);
          },
        ),
        RUNS,
      );
    },
    SLOW,
  );

  it(
    "SUFFIX INVARIANCE against the law — the active set and the head's key are the same under every resolvable suffix",
    async () => {
      const byDevice = (v: HostRosterVerdict) =>
        v.active.map((m) => [m.device_id, m.entries.map((x) => x.enrollment_id)]);
      const law = (keyChain: string[], e: HostEnrollment[], r: HostRetirement[]) =>
        verifyHostRoster({ motebitId: LEGACY_ID, keyChain, enrollments: e, retirements: r });
      const okLaw = (x: HostRosterResult): HostRosterVerdict => {
        if (!x.ok) throw new Error(x.reason);
        return x;
      };
      // Every hazard that leaves the head the head: disclosures that stop
      // or divert the walk below it.
      const stoppers = () =>
        fc.subarray(
          hazards.filter((x) => x.old_public_key !== hex[3]),
          { maxLength: 3 },
        );
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 3 }),
          stoppers(),
          fc.subarray(junk, { maxLength: 3 }),
          guardianOpt(),
          fc.subarray(enrolments, { maxLength: 8 }),
          fc.subarray(retirements, { maxLength: 12 }),
          async (drop, hz, j, g, e, r) => {
            // The records a client can see after losing the first `drop` links.
            const seen = [...truth.slice(drop), ...hz, ...j];
            const resolved = await run(seen, 3, g, "legacy");
            if (!resolved.ok) throw new Error(`refused: ${resolved.reason}`);
            expect(resolved.chain[resolved.chain.length - 1]).toBe(hex[3]);
            // With no hazard, the resolved chain IS the truth's suffix. With
            // one, it may carry an ancestry the truth does not (a recovery
            // into K2 from K7) — and the active set must STILL agree.
            if (hz.length === 0) expect(resolved.chain).toEqual(hex.slice(drop, 4));
            const whole = okLaw(await law(hex.slice(0, 4), e, r));
            const mine = okLaw(await law(resolved.chain, e, r));
            expect(mine.chain_head.public_key).toBe(whole.chain_head.public_key);
            expect(byDevice(mine)).toEqual(byDevice(whole));
          },
        ),
        { numRuns: 40 },
      );
    },
    SLOW,
  );
});
