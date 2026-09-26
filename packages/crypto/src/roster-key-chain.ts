/**
 * The key chain a consumer reduces a machine roster under.
 *
 * `docs/proposals/machine-roster-clients-v1.md` C1 and §2A.
 * `verifyHostRoster` takes `keyChain` from "a succession chain the
 * CONSUMER verified". This is how a consumer gets one: from the key it
 * holds, and every succession record it can see, from any source.
 *
 * **The principle.** Spec §6 property 7 (suffix invariance): for every
 * suffix of the chain that contains the head, the roster's `active` set
 * and the head's key are the same. Ancestry therefore never changes the
 * quantified set; it changes only advisory lines. So an ancestry problem
 * — truncation, a fork below the held key, a recovery link this client
 * cannot check — is a DISCLOSURE that stops the walk, never a refusal. A
 * refusal would buy nothing and could strand a motebit for good.
 *
 * **Exactly three refusals**, each one only a narrow set of parties can
 * cause:
 *
 * - `duplicate_key` — a cycle through `held`: `held` is its own verified
 *   ancestor (#775 accepts a rotation back to an earlier key). It needs a
 *   record with `old == held`, so only the holder of `held` or the
 *   guardian makes one. Checked first. A repeat met strictly BELOW `held`
 *   is ancestry, which an old-key holder alone can mint, so it is the
 *   disclosure `cycle_below`, never a refusal.
 * - `fork_at_held` — two verified predecessors of `held`. Each carries
 *   `held`'s own new-key signature, so only the holder of `held` makes one.
 * - `held_key_superseded` — a verified record with `old == held`: normal
 *   (signed by `held`) or a guardian-verified recovery. This client's key
 *   was rotated away. (R23.)
 *
 * A malformed CALL — `motebitId`, `held` or `guardianKey` of the wrong
 * shape, or `records` not an array — is `malformed_input`. No content of
 * `records` can produce it: a record that is not a well-formed succession
 * record is ignored like any other junk.
 *
 * **What this primitive does not do.** It does not persist anything
 * (R26 — keeping every verified record, including those a refusal
 * carries, is the client's concern; every result carries the verified
 * records it rests on so the client can). It does not read the relay's
 * `current_public_key` hint (C1.7), and it does not decide which link
 * the relay is missing: `links` is the verified path, and "the relay is
 * missing k links" is a set difference the client takes against what
 * the relay served.
 */
import { verifySovereignBinding } from "./index.js";
import { KEY_SUCCESSION_SUITE, verifyKeySuccession } from "./artifacts.js";
import type { KeySuccessionRecord } from "./artifacts.js";
import { canonicalJson } from "./signing.js";

// One spelling of a key: lowercase hex, the same law `verifyHostRoster`
// holds its `keyChain` to. A key spelled otherwise is not a key this
// chain can hand the law.
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;

// A sovereign id is decidable from the id alone: a `did:key`, or the
// UUIDv8 commitment `deriveSovereignMotebitId` mints (version nibble 8,
// variant 10b). A legacy random UUIDv7 can never be one.
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True iff `motebitId` has the sovereign shape (see `verifySovereignBinding`). */
function isSovereignShaped(motebitId: string): boolean {
  return motebitId.startsWith("did:key:") || UUID_V8.test(motebitId);
}

/**
 * Where the walk stopped, and why. `key` is always `chain[0]`: the
 * earliest key this client can prove. Every kind is a disclosure; none
 * is a refusal, and none gates minting, rendering or retiring (C1.8).
 */
export type RosterChainAncestry =
  /**
   * `chain[0]` binds to a sovereign-shaped `motebitId`
   * (`verifySovereignBinding`): the genesis key. It ends the walk (N10);
   * any verified predecessor of it is listed in `predecessors`,
   * never walked.
   */
  | { kind: "rooted"; key: string; predecessors: string[] }
  /**
   * No verified predecessor of `chain[0]`, and it does not bind to the
   * id (a legacy id, or a sovereign id whose older links this client
   * cannot see — see `RosterKeyChainOk.sovereign_id`).
   */
  | { kind: "unrooted"; key: string }
  /**
   * Two or more verified predecessors of `chain[0]`, which is not
   * `held`. Each carries `key`'s own new-key signature: the holder of
   * `key` signed two histories leading to it. Stopped here, not refused:
   * the history below cannot change the active set.
   */
  | { kind: "forked_below"; key: string; predecessors: string[] }
  /**
   * A guardian-recovery predecessor of `chain[0]` whose new-key
   * signature verifies but whose guardian signature this client cannot
   * check (no pinned guardian key), alone or beside a verified
   * predecessor. `predecessors` lists the old keys of those records.
   */
  | { kind: "recovery_limited"; key: string; predecessors: string[] }
  /**
   * A verified predecessor of `chain[0]` is already on the chain: the
   * history below closes a cycle (a self-loop, or a rotation back to a
   * key below `held`). The walk stops BEFORE the repeat. Only holders of
   * keys below `held` can mint one — ancestry, which cannot change the
   * active set — so it is disclosed, never refused. `predecessors` lists
   * the repeated keys.
   */
  | { kind: "cycle_below"; key: string; predecessors: string[] };

/**
 * A verified successor of a key on the path that is NOT the next key on
 * the path: a branch this device is not on (C1.3).
 */
export interface RosterChainBranch {
  /** The key on the path that has two successors. */
  at: string;
  /** The successor that is not on this path. */
  to: string;
  /**
   * The branch link is a guardian-verified recovery: a legitimate
   * recovery this device is not on. Universal claims are suppressed.
   * When false, the holder of `at` signed two successors (N11) — an
   * old-key thief, or two offline rotations on two surfaces — and the
   * branch is disclosed, never suppressing (a suppression here would
   * hand an old-key thief a permanent denial of service).
   */
  guardian_verified: boolean;
  /** One verified record of the branch link, for the client to keep (R26). */
  record: KeySuccessionRecord;
}

export interface RosterKeyChainOk {
  ok: true;
  /** Oldest → newest; ends at `held`. The `keyChain` to hand `verifyHostRoster`. */
  chain: string[];
  /** Always `held`. Cite the head by key, never by an index (§2A). */
  head: string;
  /** One verified record per consecutive pair of `chain`, oldest → newest. */
  links: KeySuccessionRecord[];
  ancestry: RosterChainAncestry;
  /** `motebitId` is sovereign-shaped (a UUIDv8 commitment or a `did:key`). */
  sovereign_id: boolean;
  /** Sorted by the position of `at` on the chain, then by `to`. */
  branches: RosterChainBranch[];
  /**
   * True iff some branch is guardian-verified (C1.3): the chain has a
   * branch this device is not on, so no universal claim ("every
   * machine", "N machines") may be rendered from this chain.
   */
  suppress_universal_claims: boolean;
}

export type RosterKeyChainRefusal =
  | {
      ok: false;
      reason: "duplicate_key";
      /** Always `held`: the key that is its own ancestor. */
      key: string;
      /** The verified cycle `held` → … → `held`, oldest → newest. */
      evidence: KeySuccessionRecord[];
      detail: string;
    }
  | {
      ok: false;
      reason: "fork_at_held";
      key: string;
      /** One verified record per distinct predecessor of `held`. */
      evidence: KeySuccessionRecord[];
      detail: string;
    }
  | {
      ok: false;
      reason: "held_key_superseded";
      key: string;
      /** One verified record per distinct successor of `held` (R26: keep them). */
      evidence: KeySuccessionRecord[];
      detail: string;
    }
  | { ok: false; reason: "malformed_input"; detail: string };

export type RosterKeyChainResult = RosterKeyChainOk | RosterKeyChainRefusal;

type LinkKind = "normal" | "recovery" | "recovery_unchecked";

interface Candidate {
  record: KeySuccessionRecord;
  canonical: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Rebuild a record from exactly its known fields, or `null` when it is
 * not a well-formed succession record. Extra fields are dropped (no
 * signature covers them), so two copies that differ only in junk are one
 * candidate, and what the client is handed back is clean.
 */
function normalize(value: unknown): Candidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.suite !== KEY_SUCCESSION_SUITE) return null;
  if (typeof v.old_public_key !== "string" || !HEX_32.test(v.old_public_key)) return null;
  if (typeof v.new_public_key !== "string" || !HEX_32.test(v.new_public_key)) return null;
  // `-0` canonicalizes to `0`: two spellings, one signed body. Refused
  // so the record handed back never depends on which copy came first.
  if (!Number.isSafeInteger(v.timestamp) || Object.is(v.timestamp, -0)) return null;
  if (typeof v.new_key_signature !== "string" || !HEX_SIG.test(v.new_key_signature)) return null;
  if (v.reason !== undefined && typeof v.reason !== "string") return null;
  if (v.recovery !== undefined && typeof v.recovery !== "boolean") return null;
  const recovery = v.recovery === true;
  const sigField = recovery ? v.guardian_signature : v.old_key_signature;
  if (typeof sigField !== "string" || !HEX_SIG.test(sigField)) return null;
  const record: KeySuccessionRecord = {
    old_public_key: v.old_public_key,
    new_public_key: v.new_public_key,
    timestamp: v.timestamp as number,
    ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    suite: KEY_SUCCESSION_SUITE,
    ...(recovery ? {} : { old_key_signature: sigField }),
    new_key_signature: v.new_key_signature,
    ...(recovery ? { recovery: true, guardian_signature: sigField } : {}),
  };
  return { record, canonical: canonicalJson(record) };
}

/**
 * Resolve the key chain to reduce a machine roster under — C1.
 *
 * Walks BACKWARD from `held` by linkage: at key `K`, the records whose
 * `new_public_key` is `K`, each verified (`verifyKeySuccession`; a
 * recovery link against the pinned `guardianKey`), deduplicated by
 * `(old, new)` AFTER verification — so a copy under a garbage signature
 * never displaces or doubles a real link. **Timestamps are never read**:
 * spec §6 uses only the relative order of epochs, and linkage gives it,
 * so two genuine rotations recorded out of order (#706) resolve.
 *
 * First, `duplicate_key` if `held` is its own verified ancestor (a
 * rotation back to it, #775 — which the walk alone would misread as a
 * fork at `held`). Then, at each key `K`:
 * 1. `K` binds to a sovereign-shaped id → stop, `rooted` (N10: its
 *    predecessors are disclosed, never walked).
 * 2. A verified predecessor already on the path (a cycle strictly below
 *    `held`) → stop before it, `cycle_below(K)`.
 * 3. `K ≠ held` with two or more verified predecessors → stop,
 *    `forked_below(K)`. At `held` → refusal `fork_at_held`.
 * 4. An uncheckable recovery predecessor → stop, `recovery_limited(K)`.
 * 5. Exactly one verified predecessor → prepend it; none → stop,
 *    `unrooted`.
 *
 * Then every key on the path is checked for successors: one of `held`
 * is `held_key_superseded`; one of an older key that is not the next key
 * on the path is a branch (see `RosterChainBranch`).
 *
 * `records` is the union of every source the client has — its cache,
 * the relay's `/succession`, local `motebit.md` files — in any order,
 * duplicates allowed; records unrelated to this chain are ignored. The
 * CACHE IS RECORDS, not a list of keys: a key list carries no signature,
 * so it could only be trusted (storage as authority) or ignored; after a
 * relay loses its database, the cached records alone resolve the same
 * chain.
 *
 * `guardianKey` comes from a pinned local source only (`motebit.md`
 * `guardian`, or config) — never from the relay (C1.5).
 */
export async function resolveRosterKeyChain(input: {
  motebitId: string;
  held: string;
  records: readonly unknown[];
  guardianKey?: string;
}): Promise<RosterKeyChainResult> {
  const raw = input as {
    motebitId?: unknown;
    held?: unknown;
    records?: unknown;
    guardianKey?: unknown;
  };
  if (typeof raw.motebitId !== "string" || raw.motebitId === "") {
    return { ok: false, reason: "malformed_input", detail: "motebitId must be a non-empty string" };
  }
  if (typeof raw.held !== "string" || !HEX_32.test(raw.held)) {
    return {
      ok: false,
      reason: "malformed_input",
      detail: "held must be a 32-byte public key in lowercase hex",
    };
  }
  if (
    raw.guardianKey !== undefined &&
    (typeof raw.guardianKey !== "string" || !HEX_32.test(raw.guardianKey))
  ) {
    return {
      ok: false,
      reason: "malformed_input",
      detail: "guardianKey, when given, must be a 32-byte public key in lowercase hex",
    };
  }
  if (!Array.isArray(raw.records)) {
    return { ok: false, reason: "malformed_input", detail: "records must be an array" };
  }
  const motebitId = raw.motebitId;
  const held = raw.held;
  const guardianKey = raw.guardianKey;
  const sovereignId = isSovereignShaped(motebitId);

  // Index every well-formed candidate by both ends. Nothing is verified
  // yet: only records backward-reachable from `held` (the cycle check),
  // or leaving a key on the path, ever cost a verification.
  const byNew = new Map<string, Map<string, Candidate>>();
  const byOld = new Map<string, Map<string, Candidate>>();
  const put = (index: Map<string, Map<string, Candidate>>, key: string, c: Candidate): void => {
    let bucket = index.get(key);
    if (bucket == null) index.set(key, (bucket = new Map<string, Candidate>()));
    bucket.set(c.canonical, c);
  };
  for (const item of raw.records as unknown[]) {
    const c = normalize(item);
    if (c == null) continue;
    put(byNew, c.record.new_public_key, c);
    put(byOld, c.record.old_public_key, c);
  }

  const verdicts = new Map<string, LinkKind | null>();
  async function classify(c: Candidate): Promise<LinkKind | null> {
    const memo = verdicts.get(c.canonical);
    if (memo !== undefined) return memo;
    let kind: LinkKind | null = null;
    if (c.record.recovery !== true) {
      if (await verifyKeySuccession(c.record)) kind = "normal";
    } else if (guardianKey !== undefined) {
      if (await verifyKeySuccession(c.record, guardianKey)) kind = "recovery";
    } else {
      // No pinned guardian: check what CAN be checked — the new key's
      // signature over the recovery payload. `verifyKeySuccession` with
      // the new key standing in as "guardian" and its own signature as
      // the guardian's checks exactly that, twice. A recovery record
      // whose new-key signature fails is junk anyone could mint and is
      // ignored; one that passes was signed by the holder of the new key.
      const probe = { ...c.record, guardian_signature: c.record.new_key_signature };
      if (await verifyKeySuccession(probe, c.record.new_public_key)) kind = "recovery_unchecked";
    }
    verdicts.set(c.canonical, kind);
    return kind;
  }

  /**
   * Verified links touching `key` on one side, deduplicated by the key
   * at the OTHER end — after verification. Per distinct other key: the
   * link's strongest kind, and one record chosen independently of input
   * order (least canonical form among the verified copies of that kind).
   */
  async function links(
    index: Map<string, Map<string, Candidate>>,
    key: string,
    other: (r: KeySuccessionRecord) => string,
  ): Promise<Map<string, { kind: LinkKind; record: KeySuccessionRecord; canonical: string }>> {
    // A guardian-verified copy of a link outranks a normal one (it is what
    // makes a branch suppress); an uncheckable recovery copy ranks last,
    // so a link with any verified copy counts as verified.
    const rank: Record<LinkKind, number> = { recovery: 0, normal: 1, recovery_unchecked: 2 };
    const out = new Map<
      string,
      { kind: LinkKind; record: KeySuccessionRecord; canonical: string }
    >();
    for (const c of index.get(key)?.values() ?? []) {
      const kind = await classify(c);
      if (kind == null) continue;
      const o = other(c.record);
      const prev = out.get(o);
      const better =
        prev == null ||
        rank[kind] < rank[prev.kind] ||
        (rank[kind] === rank[prev.kind] && cmp(c.canonical, prev.canonical) < 0);
      if (better) out.set(o, { kind, record: c.record, canonical: c.canonical });
    }
    return out;
  }

  const duplicate = (key: string, evidence: KeySuccessionRecord[]): RosterKeyChainRefusal => ({
    ok: false,
    reason: "duplicate_key",
    key,
    evidence,
    detail: `the held key ${key} is its own ancestor (a cycle through it); a chain with a repeated key has no epoch order`,
  });

  // ── duplicate_key through the held key, checked FIRST ─────────────
  // A rotation back to an earlier key (#775) makes `held` its own
  // ancestor. Unless `held` is the genesis, the walk would meet that as
  // a second predecessor of `held` — `fork_at_held` — although the
  // records prove a repeated key, not two histories. So before the
  // walk: breadth-first backward over verified links, in sorted order so
  // the evidence does not depend on input order; if `held` is reachable
  // from itself, the refusal is `duplicate_key`. This is a statement
  // about the held key itself, so N10 does not stop it.
  {
    const parent = new Map<string, { next: string; record: KeySuccessionRecord }>();
    const seen = new Set<string>([held]);
    const queue: string[] = [held];
    while (queue.length > 0) {
      const k = queue.shift()!;
      const preds = await links(byNew, k, (r) => r.old_public_key);
      for (const p of [...preds.keys()].sort(cmp)) {
        const l = preds.get(p)!;
        if (l.kind === "recovery_unchecked") continue;
        if (p === held) {
          // held → k → … → held, oldest → newest.
          const evidence = [l.record];
          for (let cur = k; cur !== held;) {
            const step = parent.get(cur)!;
            evidence.push(step.record);
            cur = step.next;
          }
          return duplicate(held, evidence);
        }
        if (!seen.has(p)) {
          seen.add(p);
          parent.set(p, { next: k, record: l.record });
          queue.push(p);
        }
      }
    }
  }

  // ── The backward walk ──────────────────────────────────────────────
  const chain: string[] = [held];
  const pathLinks: KeySuccessionRecord[] = [];
  const onPath = new Set<string>([held]);
  let ancestry: RosterChainAncestry | null = null;
  let heldFork: KeySuccessionRecord[] | null = null;

  for (;;) {
    const key = chain[0]!;
    const preds = await links(byNew, key, (r) => r.old_public_key);
    const sortedPreds = [...preds.keys()].sort(cmp);

    // N10 — the genesis key ends the walk, at `held` too.
    if (sovereignId && (await verifySovereignBinding(motebitId, key))) {
      // A self-loop is not a predecessor: it cannot be a real rotation.
      ancestry = { kind: "rooted", key, predecessors: sortedPreds.filter((k) => k !== key) };
      break;
    }

    const verified = sortedPreds.filter((k) => preds.get(k)!.kind !== "recovery_unchecked");
    const unchecked = sortedPreds.filter((k) => preds.get(k)!.kind === "recovery_unchecked");

    // A verified predecessor already on the path closes a cycle. The
    // pre-walk check has ruled out a cycle through `held`, so this one is
    // strictly below it: stop before the repeat and disclose. Checked
    // before a fork at the same key, which it would otherwise read as.
    const repeats = verified.filter((k) => onPath.has(k));
    if (repeats.length > 0) {
      ancestry = { kind: "cycle_below", key, predecessors: repeats };
      break;
    }

    if (verified.length >= 2) {
      if (key === held) {
        heldFork = verified.map((k) => preds.get(k)!.record);
        break;
      }
      ancestry = { kind: "forked_below", key, predecessors: verified };
      break;
    }
    if (unchecked.length > 0) {
      ancestry = { kind: "recovery_limited", key, predecessors: unchecked };
      break;
    }
    if (verified.length === 0) {
      ancestry = { kind: "unrooted", key };
      break;
    }
    const prev = verified[0]!;
    pathLinks.unshift(preds.get(prev)!.record);
    chain.unshift(prev);
    onPath.add(prev);
  }

  if (heldFork != null) {
    return {
      ok: false,
      reason: "fork_at_held",
      key: held,
      evidence: heldFork,
      detail: "the held key has two verified predecessors; only its holder could sign both",
    };
  }

  // ── Successors: the held key's, and branches below it ─────────────
  const heldSuccessors = await links(byOld, held, (r) => r.new_public_key);
  const superseding = [...heldSuccessors.entries()]
    .filter(([, l]) => l.kind !== "recovery_unchecked")
    .sort(([a], [b]) => cmp(a, b));
  if (superseding.length > 0) {
    return {
      ok: false,
      reason: "held_key_superseded",
      key: held,
      evidence: superseding.map(([, l]) => l.record),
      detail: "a verified succession record rotates the held key away",
    };
  }

  const branches: RosterChainBranch[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const at = chain[i]!;
    const next = chain[i + 1]!;
    const succ = await links(byOld, at, (r) => r.new_public_key);
    for (const to of [...succ.keys()].sort(cmp)) {
      const l = succ.get(to)!;
      // An uncheckable recovery SUCCESSOR carries only its new key's
      // signature — anyone can mint one to a key of their own. Ignored.
      // A self-loop is never a sibling: it cannot be a real rotation.
      if (to === next || to === at || l.kind === "recovery_unchecked") continue;
      branches.push({ at, to, guardian_verified: l.kind === "recovery", record: l.record });
    }
  }

  return {
    ok: true,
    chain,
    head: held,
    links: pathLinks,
    ancestry: ancestry!,
    sovereign_id: sovereignId,
    branches,
    suppress_universal_claims: branches.some((b) => b.guardian_verified),
  };
}
