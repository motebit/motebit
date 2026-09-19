/**
 * The roster reduction's UNIVERSAL claims, checked as such.
 *
 * `spec/machine-roster-v1.md` §6. The first draft of this reducer passed
 * sixteen example tests while being wrong in seven ways, and the second
 * was wrong about rotation in a way only a SECOND rotation showed. Every
 * claim below is quantified — "for any order", "after any number of
 * rotations", "for any artifacts a holder of an old key can mint" — so it
 * is tested over generated inputs, not over the cases I thought of.
 *
 * The generators sign AUTHENTICALLY. A pool is minted once across a
 * four-key chain plus a stranger: every machine enrolled at every epoch,
 * and every enrolment retired by every key. A property then draws
 * subsets of that pool and prefixes/suffixes of the chain, which covers
 * retire-then-rotate, rotate-then-retire, a thief holding any old key,
 * replays, duplicates and withheld entries without naming any of them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  generateKeypair,
  bytesToHex,
  signHostEnrollment,
  signHostRetirement,
  hostEnrollmentId,
  verifyHostRoster,
} from "../index.js";
import type { HostRosterMachine, HostRosterResult, HostRosterVerdict } from "../index.js";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";

const MOTEBIT = "019d903f-13de-75a4-8341-58319e0a2f16";
const DEVICES = ["a", "b", "c"];

let chain: string[]; // K0 → K3, oldest → newest
let enrolments: HostEnrollment[];
let retirements: HostRetirement[];
const signer = new Map<string, number>(); // artifact signature → epoch (-1 = stranger)

beforeAll(async () => {
  const kps = await Promise.all([0, 1, 2, 3, 4].map(() => generateKeypair()));
  const pubs = kps.map((k) => bytesToHex(k.publicKey));
  chain = pubs.slice(0, 4);
  enrolments = [];
  retirements = [];
  for (let k = 0; k < kps.length; k++) {
    const epoch = k < 4 ? k : -1;
    for (const device_id of DEVICES) {
      for (const enrolled_at of [1_000, 2_000]) {
        const e = await signHostEnrollment(
          { motebit_id: MOTEBIT, device_id, public_key: pubs[k]!, enrolled_at },
          kps[k]!.privateKey,
        );
        enrolments.push(e);
        signer.set(e.signature, epoch);
      }
    }
  }
  for (const e of enrolments) {
    for (let k = 0; k < kps.length; k++) {
      const r = await signHostRetirement(
        {
          motebit_id: MOTEBIT,
          enrollment_id: await hostEnrollmentId(e),
          public_key: pubs[k]!,
          retired_at: 3_000,
        },
        kps[k]!.privateKey,
      );
      retirements.push(r);
      signer.set(r.signature, k < 4 ? k : -1);
    }
  }
});

const reduce = (keyChain: string[], e: HostEnrollment[], r: HostRetirement[]) =>
  verifyHostRoster({ motebitId: MOTEBIT, keyChain, enrollments: e, retirements: r });

function ok(result: HostRosterResult): HostRosterVerdict {
  if (!result.ok) throw new Error(`expected a roster, got ${result.reason}`);
  return result;
}

type Status = "active" | "retired" | "superseded";
/** device → [status, entry ids] — what a machine IS, without the epoch numbering. */
function statuses(v: HostRosterVerdict): Map<string, [Status, string[]]> {
  const out = new Map<string, [Status, string[]]>();
  const put = (s: Status, ms: HostRosterMachine[]) => {
    for (const m of ms) out.set(m.device_id, [s, m.entries.map((x) => x.enrollment_id)]);
  };
  put("active", v.active);
  put("retired", v.retired);
  put("superseded", v.superseded);
  return out;
}

const subE = () => fc.subarray(enrolments);
const subR = () => fc.subarray(retirements);
const RUNS = { numRuns: 60 };

describe("§6 properties", () => {
  it("P1 partition — every machine with an admissible enrolment is in exactly one bucket", async () => {
    await fc.assert(
      fc.asyncProperty(subE(), subR(), fc.integer({ min: 1, max: 4 }), async (e, r, n) => {
        const c = chain.slice(0, n);
        const v = ok(await reduce(c, e, r));
        const placed = [...v.active, ...v.retired, ...v.superseded].map((m) => m.device_id);
        expect(new Set(placed).size).toBe(placed.length);
        const admissible = new Set(
          e.filter((x) => c.includes(x.public_key)).map((x) => x.device_id),
        );
        expect(placed.slice().sort()).toEqual([...admissible].sort());
        // The view stamp, and what it authenticates — under chains of
        // EVERY length, so an implementation comparing against a fixed
        // index cannot pass by coincidence.
        expect(v.chain_head).toEqual({ epoch: n - 1, public_key: c[n - 1] });
        for (const m of [...v.active, ...v.retired, ...v.superseded]) {
          expect(m.authenticated).toBe(m.epoch === n - 1);
          expect(m.entries.length).toBeGreaterThan(0);
        }
        for (const m of v.active) expect(m.epoch).toBe(n - 1);
        for (const m of v.superseded) expect(m.epoch).toBeLessThan(n - 1);
      }),
      RUNS,
    );
  });

  it("P2 — the WHOLE result is independent of input order and multiplicity", async () => {
    await fc.assert(
      fc.asyncProperty(
        subE(),
        subR(),
        fc.integer({ min: 1, max: 4 }),
        fc.infiniteStream(fc.nat()),
        async (e, r, n, seed) => {
          const c = chain.slice(0, n);
          const base = await reduce(c, e, r);
          const shuffle = <T>(xs: T[]): T[] =>
            xs
              .map((x) => [seed.next().value as number, x] as const)
              .sort((a, b) => a[0] - b[0])
              .map(([, x]) => x);
          expect(await reduce(c, shuffle([...e, ...e]), shuffle([...r, ...r, ...r]))).toEqual(base);
        },
      ),
      RUNS,
    );
  });

  it("P3 monotone under rotation — appending a key nothing here is signed by changes ONLY active → superseded", async () => {
    // Restated after design review: it is FALSE for sets that already
    // hold artifacts signed by the appended key (a store learns of K3
    // artifacts before a consumer learns K3), so those are excluded here
    // and their effect is P6's business. The composition is tested below.
    await fc.assert(
      fc.asyncProperty(subE(), subR(), fc.integer({ min: 1, max: 3 }), async (e, r, n) => {
        const before = chain.slice(0, n);
        const notByAppended = <T extends { signature: string }>(xs: T[]) =>
          xs.filter((x) => signer.get(x.signature) !== n);
        const [ee, rr] = [notByAppended(e), notByAppended(r)];
        const a = ok(await reduce(before, ee, rr));
        const b = ok(await reduce(chain.slice(0, n + 1), ee, rr));
        // WHOLE machines, not a projection. The first version compared
        // through `statuses()`, which drops `authenticated` — and so hid
        // that the spec's statement of this property was false as written.
        //
        // Exactly three things change, all functions of the head moving:
        //   1. `chain_head` names the appended key;
        //   2. every `active` machine becomes `superseded`;
        //   3. `authenticated` becomes false for EVERY machine, since none
        //      has an enrolment at the new head (the set holds nothing
        //      signed by it) — including machines that stay `retired`.
        expect(b.chain_head).toEqual({ epoch: n, public_key: chain[n] });
        expect(b.active).toEqual([]);
        const stale = (ms: HostRosterMachine[]) => ms.map((m) => ({ ...m, authenticated: false }));
        const byDevice = (x: HostRosterMachine, y: HostRosterMachine) =>
          x.device_id < y.device_id ? -1 : 1;
        expect(b.retired).toEqual(stale(a.retired));
        expect(b.superseded).toEqual(stale([...a.superseded, ...a.active]).sort(byDevice));
        expect(b.rejected).toEqual(a.rejected);
        expect(b.tombstones).toEqual(a.tombstones);
      }),
      RUNS,
    );
  });

  it("P4 no backward authority — nothing signed below epoch t can move a machine whose H ≥ t", async () => {
    // The stolen-laptop property: a holder of an old key can mint
    // anything at its own epoch and must not touch a newer line.
    await fc.assert(
      fc.asyncProperty(
        subE(),
        subR(),
        subE(),
        subR(),
        fc.integer({ min: 1, max: 3 }),
        async (e, r, thiefE, thiefR, t) => {
          const below = <T extends { signature: string }>(xs: T[]) =>
            xs.filter((x) => {
              const ep = signer.get(x.signature) ?? -1;
              return ep >= 0 && ep < t;
            });
          const a = ok(await reduce(chain, e, r));
          const b = ok(await reduce(chain, [...e, ...below(thiefE)], [...r, ...below(thiefR)]));
          const sb = statuses(b);
          for (const m of [...a.active, ...a.retired, ...a.superseded]) {
            if (m.epoch >= t) expect(sb.get(m.device_id)).toEqual(statuses(a).get(m.device_id));
          }
        },
      ),
      RUNS,
    );
  });

  it("P5 re-spelling invariance — another valid spelling of a signature changes nothing", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = <T extends { signature: string }>(x: T): T => {
      const last = x.signature.slice(-1);
      return { ...x, signature: x.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1]! };
    };
    await fc.assert(
      fc.asyncProperty(subE(), subR(), async (e, r) => {
        expect(await reduce(chain, e.map(twin), r.map(twin))).toEqual(await reduce(chain, e, r));
      }),
      RUNS,
    );
  });

  it("P6 monotone under union — more RETIREMENTS never bring a retired machine back", async () => {
    await fc.assert(
      fc.asyncProperty(subE(), subR(), subR(), async (e, r, more) => {
        const a = statuses(ok(await reduce(chain, e, r)));
        const b = statuses(ok(await reduce(chain, e, [...r, ...more])));
        for (const [device, [status]] of a) {
          if (status === "retired") expect(b.get(device)?.[0]).toBe("retired");
        }
      }),
      RUNS,
    );
  });

  it("P3∘P6 — learning a key AND the artifacts it signed equals reducing the full set under the full chain", async () => {
    // The composition that P3's restatement sets aside: a stale consumer
    // catching up. Whatever order it learns things in, it lands on the
    // same verdict as a consumer that always knew.
    await fc.assert(
      fc.asyncProperty(subE(), subR(), fc.integer({ min: 1, max: 3 }), async (e, r, n) => {
        const full = chain.slice(0, n + 1);
        expect(await reduce(full, [...e], [...r])).toEqual(
          await reduce(full, [...e].reverse(), [...r].reverse()),
        );
      }),
      { numRuns: 20 },
    );
  });

  it("P7 suffix invariance — the ACTIVE set depends only on the current key and what it signed", async () => {
    // What makes `authenticated` mean something: no history, true or
    // forged, can add or remove an active line.
    await fc.assert(
      fc.asyncProperty(subE(), subR(), fc.integer({ min: 0, max: 3 }), async (e, r, drop) => {
        const whole = ok(await reduce(chain, e, r));
        const suffix = ok(await reduce(chain.slice(drop), e, r));
        const pick = (v: HostRosterVerdict) =>
          v.active.map((m) => [m.device_id, m.entries.map((x) => x.enrollment_id)]);
        expect(pick(suffix)).toEqual(pick(whole));
        for (const m of whole.active) expect(m.authenticated).toBe(true);
        for (const m of [...whole.superseded]) expect(m.authenticated).toBe(false);
      }),
      RUNS,
    );
  });

  it("P8 relative order only — re-rooting the chain on an unrelated older key moves no machine", async () => {
    const unrelated = bytesToHex((await generateKeypair()).publicKey);
    await fc.assert(
      fc.asyncProperty(subE(), subR(), async (e, r) => {
        const a = statuses(ok(await reduce(chain, e, r)));
        const b = statuses(ok(await reduce([unrelated, ...chain], e, r)));
        expect(b).toEqual(a);
      }),
      RUNS,
    );
  });

  it("P11 keyless additions — nothing a party with NO key can add moves any machine", async () => {
    // Every other property draws from an authentically signed pool, so
    // no keyless adversary ever appeared in them — and two defects lived
    // exactly there. A hostile store, or merely an unverifying one whose
    // set a consumer UNIONS with an honest store's, can add: copies of a
    // real artifact under garbage signatures (any number, sorting
    // anywhere); copies carrying an `undefined`-valued extra key, which
    // canonicalize to the SAME id and signature; `-0` for `0`; and junk.
    // None of it may suppress, resurrect, or reclassify anything.
    const sigChar = fc.constantFrom(..."-_0189AZaz".split(""));
    const garbageSig = fc.array(sigChar, { minLength: 86, maxLength: 86 }).map((cs) => cs.join(""));
    const forge = <T extends { signature: string }>(pool: T[]) =>
      fc.array(
        fc
          .tuple(fc.constantFrom(...pool), garbageSig, fc.integer({ min: 0, max: 3 }))
          .map(([artifact, sig, mode]) => {
            if (mode === 0) return { ...artifact, signature: sig };
            // Same id, same signature, NOT well-formed.
            if (mode === 1) return { ...artifact, device_name: undefined };
            if (mode === 2) return { ...artifact, signature: sig, hosts: undefined };
            return "junk";
          }),
        { maxLength: 40 },
      );
    // ...and a FLOOD: many garbage copies of ONE real artifact, all
    // sorting ahead of any genuine signature. Random garbage almost never
    // stacks up on a single id, which is how a cap on spellings tried
    // slipped past this property the first time.
    const flood = <T extends { signature: string }>(pool: T[]) =>
      fc.tuple(fc.constantFrom(...pool), fc.integer({ min: 9, max: 24 })).map(([real, n]) => ({
        real,
        copies: Array.from({ length: n }, (_, i) => ({
          ...real,
          signature: `${"-".repeat(84)}${String(i).padStart(2, "0")}`,
        })),
      }));
    await fc.assert(
      fc.asyncProperty(
        subE(),
        subR(),
        forge(enrolments),
        forge(retirements),
        flood(enrolments),
        flood(retirements),
        fc.boolean(),
        async (e0, r0, junkE, junkR, floodE, floodR, front) => {
          // The flooded artifacts are IN the honest set, so suppressing
          // one would show.
          const e = [...new Set([...e0, floodE.real])];
          const r = [...new Set([...r0, floodR.real])];
          const fakeE = [...junkE, ...floodE.copies];
          const fakeR = [...junkR, ...floodR.copies];
          const honest = ok(await reduce(chain, e, r));
          const mix = <T>(real: T[], fake: unknown[]) =>
            (front ? [...fake, ...real] : [...real, ...fake]) as T[];
          const flooded = ok(await reduce(chain, mix(e, fakeE), mix(r, fakeR)));
          expect(statuses(flooded)).toEqual(statuses(honest));
          // And the flood is order-independent too.
          expect(ok(await reduce(chain, mix(e, fakeE).reverse(), mix(r, fakeR).reverse()))).toEqual(
            flooded,
          );
        },
      ),
      RUNS,
    );
  });

  it("P10 — an unusable chain never yields a roster, so no 'every machine' can be vacuously true", async () => {
    const e = enrolments.slice(0, 3);
    expect(await reduce([], e, [])).toEqual({ ok: false, reason: "empty_chain" });
    expect(await reduce([chain[0]!, chain[1]!, chain[0]!], e, [])).toEqual({
      ok: false,
      reason: "duplicate_key",
    });
    expect(await reduce([chain[0]!.toUpperCase()], e, [])).toEqual({
      ok: false,
      reason: "malformed_key",
    });
    expect(await reduce(["not-a-key"], e, [])).toEqual({ ok: false, reason: "malformed_key" });
  });
});
