/**
 * The machine roster's artifacts, and the one reduction over them.
 *
 * `docs/doctrine/machine-roster.md`. Sign/verify follow the receipt
 * family (JCS → suite-dispatch → base64url); what is particular to the
 * roster is `verifyHostRoster`, because a roster is never one artifact —
 * it is what survives when a SET of them is reduced.
 */
// Type-only: `@motebit/crypto` verifies standalone, with zero monorepo
// runtime dependencies. The shape checks below are therefore local —
// the same fields `@motebit/protocol`'s guards read, restated because a
// verifier that cannot run without the rest of the monorepo is not one a
// third party can use.
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";
import {
  canonicalJson,
  canonicalSha256,
  fromBase64Url,
  hexToBytes,
  toBase64Url,
} from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

export const HOST_ROSTER_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// Lowercase only. An entry's id is a hash of exact bytes, so there is
// one spelling of a key — the same law `spec/schemas` states for every
// other hex key on the wire.
const HEX_32 = /^[0-9a-f]{64}$/;
// Unpadded URL-safe base64 of exactly 64 bytes — the one spelling and the
// one length an Ed25519 signature has. `atob` would also take padding,
// `+/` and stray whitespace; a verifier that accepts what the wire schema
// refuses is a second, laxer law.
const ED25519_SIG_B64URL = /^[A-Za-z0-9_-]{86}$/;

// Restated from `@motebit/protocol` (see the import note above); a parity
// table in the tests pins the two copies together.
const HOST_ENROLLMENT_TYPE = "motebit/host-enrollment@1";
const HOST_RETIREMENT_TYPE = "motebit/host-retirement@1";

const ENROLLMENT_KEYS = [
  "device_id",
  "enrolled_at",
  "motebit_id",
  "public_key",
  "signature",
  "suite",
  "type",
];
const RETIREMENT_KEYS = [
  "enrollment_id",
  "motebit_id",
  "public_key",
  "retired_at",
  "signature",
  "suite",
  "type",
];

/**
 * EXACTLY these keys. Every field but `signature` is signed, so an extra
 * one verifies happily — and then this verifier admits a machine that a
 * store validating against the strict wire schema refuses, and "every
 * machine" differs between two consumers of the same set.
 */
function hasExactly(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

function hasSignedShape(v: Record<string, unknown>): boolean {
  return (
    typeof v.motebit_id === "string" &&
    v.motebit_id !== "" &&
    typeof v.public_key === "string" &&
    HEX_32.test(v.public_key) &&
    // The LITERAL: the declared suite decides how to verify, so an
    // unknown one is malformed, not merely a bad signature.
    v.suite === HOST_ROSTER_SUITE &&
    typeof v.signature === "string" &&
    ED25519_SIG_B64URL.test(v.signature)
  );
}

// Unix ms is an integer. A float is "valid JSON" and a cross-language id
// hazard: two implementations that print 1.7e21 differently derive two
// ids for one entry, and a retirement minted on one never bites on the
// other.
const isUnixMs = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

function isHostEnrollment(value: unknown): value is HostEnrollment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasExactly(v, ENROLLMENT_KEYS) &&
    v.type === HOST_ENROLLMENT_TYPE &&
    hasSignedShape(v) &&
    typeof v.device_id === "string" &&
    v.device_id !== "" &&
    isUnixMs(v.enrolled_at)
  );
}

function isHostRetirement(value: unknown): value is HostRetirement {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasExactly(v, RETIREMENT_KEYS) &&
    v.type === HOST_RETIREMENT_TYPE &&
    hasSignedShape(v) &&
    typeof v.enrollment_id === "string" &&
    HEX_32.test(v.enrollment_id) &&
    isUnixMs(v.retired_at)
  );
}

async function signBody<T extends object>(body: T, privateKey: Uint8Array): Promise<string> {
  const message = new TextEncoder().encode(canonicalJson(body));
  return toBase64Url(await signBySuite(HOST_ROSTER_SUITE, message, privateKey));
}

async function verifyBody(artifact: { public_key: string; signature: string }): Promise<boolean> {
  let key: Uint8Array;
  try {
    key = hexToBytes(artifact.public_key);
  } catch {
    return false;
  }
  if (key.length !== 32) return false;
  const { signature, ...body } = artifact;
  try {
    const message = new TextEncoder().encode(canonicalJson(body));
    return await verifyBySuite(HOST_ROSTER_SUITE, message, fromBase64Url(signature), key);
  } catch {
    return false;
  }
}

export async function signHostEnrollment(
  enrollment: Omit<HostEnrollment, "signature" | "suite" | "type">,
  identityPrivateKey: Uint8Array,
): Promise<HostEnrollment> {
  const body = { ...enrollment, type: HOST_ENROLLMENT_TYPE, suite: HOST_ROSTER_SUITE } as const;
  return { ...body, signature: await signBody(body, identityPrivateKey) };
}

/**
 * Integrity only: the entry was signed by the key it names. Whether
 * that key speaks for `motebit_id` is the CONSUMER's question, answered
 * by `verifyHostRoster` against a key chain the consumer verified — an
 * entry that is perfectly self-consistent under a stranger's key is
 * exactly what a hostile relay would serve.
 */
export async function verifyHostEnrollment(enrollment: HostEnrollment): Promise<boolean> {
  if (!isHostEnrollment(enrollment)) return false;
  return verifyBody(enrollment);
}

export async function signHostRetirement(
  retirement: Omit<HostRetirement, "signature" | "suite" | "type">,
  identityPrivateKey: Uint8Array,
): Promise<HostRetirement> {
  const body = { ...retirement, type: HOST_RETIREMENT_TYPE, suite: HOST_ROSTER_SUITE } as const;
  return { ...body, signature: await signBody(body, identityPrivateKey) };
}

/** Integrity only — see `verifyHostEnrollment`. */
export async function verifyHostRetirement(retirement: HostRetirement): Promise<boolean> {
  if (!isHostRetirement(retirement)) return false;
  return verifyBody(retirement);
}

/** SHA-256 over the canonical JSON of every field EXCEPT `signature`. */
function signedBodyId(artifact: { signature?: unknown }): Promise<string> {
  const { signature: _unsigned, ...body } = artifact;
  return canonicalSha256(body);
}

/**
 * An enrolment's identity in the set: lowercase hex SHA-256 over the
 * canonical JSON of its SIGNED BODY — every field except `signature`.
 *
 * Not over the whole artifact, and the difference is the whole point of
 * a retirement. The signature's spelling is the one part of an artifact
 * nothing signs, and base64 has more than one spelling of the same
 * bytes. Hash it, and anyone holding a copy — no key needed — can
 * re-spell a RETIRED enrolment into a new id that still verifies, and
 * the machine is back in "every machine". The signed body admits no
 * such freedom: every byte of it is covered by the signature.
 *
 * It also means the id does not depend on the signer being
 * deterministic, so a future suite with randomized signatures keeps
 * "re-presenting the same entry adds nothing".
 */
export async function hostEnrollmentId(enrollment: HostEnrollment): Promise<string> {
  return signedBodyId(enrollment);
}

/**
 * A retirement's identity in the set, by the same construction. A store
 * keys what it holds by this, so presenting the same retirement twice is
 * a no-op — ingest is an idempotent union.
 *
 * Exported so a store never hashes a protocol payload for itself: the
 * id is part of the law, and two implementations of it would be two ids.
 */
export async function hostRetirementId(retirement: HostRetirement): Promise<string> {
  return signedBodyId(retirement);
}

/**
 * How many signature spellings of ONE entry are tried before it is
 * refused. Part of the law, not a tuning knob: a store can attach any
 * number of garbage-signature copies to an id, the reduction runs on a
 * phone, and a cap that differed between implementations would make the
 * verdict differ. Copies are tried in sorted signature order.
 */
export const MAX_SIGNATURE_COPIES_TRIED = 8;

export interface HostRosterEntry {
  enrollment_id: string;
  /**
   * The signed body — never the signature. A verdict is a statement
   * about what was SIGNED; carrying one spelling of the signature would
   * make two reductions of the same set unequal.
   */
  body: Omit<HostEnrollment, "signature">;
}

/**
 * The roster's unit is the MACHINE, not the entry. One machine may hold
 * several enrolments — a daemon that lost its cached artifact mints a
 * new one — and counting entries would count that machine twice in
 * every "N machines" a consumer computes.
 */
export interface HostRosterMachine {
  device_id: string;
  /** H — the highest epoch at which this machine has an admissible enrolment. */
  epoch: number;
  /**
   * `epoch === chain_head.epoch`. ONLY these statuses are authenticated.
   * A status at an older epoch is advisory: any holder of a key at that
   * epoch or later — including a superseded, stolen key — can flip it in
   * either direction, and can mint any number of such lines.
   */
  authenticated: boolean;
  /**
   * Sorted by `enrollment_id`. For `active` and `superseded`: the
   * enrolments at `epoch` that nothing ends — retire ALL of them to
   * retire the machine. For `retired`: its enrolments at `epoch`, every
   * one of them ended.
   */
  entries: HostRosterEntry[];
}

export interface HostRosterRejection {
  kind: "enrollment" | "retirement";
  /** The entry's id, or `null` when it was not even a JSON object. */
  id: string | null;
  /** The key it claimed, when readable — what a person would investigate. */
  public_key: string | null;
  /** The FIRST that applies, in this order. */
  reason: "malformed" | "wrong_motebit" | "untrusted_key" | "bad_signature";
}

export interface HostRosterVerdict {
  /**
   * The view this verdict was computed under. A claim derived from it —
   * "a halt reached every machine", "N machines" — MUST cite it: a
   * consumer whose chain lags the truth computes a confident, wrong
   * roster, and the head is what makes that detectable.
   */
  chain_head: { epoch: number; public_key: string };
  /** Enrolled under the CURRENT key, with an enrolment nothing ends. */
  active: HostRosterMachine[];
  /** Nothing at its highest epoch stands. */
  retired: HostRosterMachine[];
  /**
   * Its highest epoch is an OLD one, and something there stands: it
   * never received the new key. Shown, never dropped — rotating a key
   * does not stop the old machine running. Advisory (see
   * `HostRosterMachine.authenticated`), and NOT covered by a statement
   * quantified over `active`.
   */
  superseded: HostRosterMachine[];
  /**
   * Every enrolment id an admissible retirement names, with the highest
   * epoch that named it — including ids whose enrolment has not been
   * seen. A retirement may arrive first; union has no order.
   */
  tombstones: Array<{ enrollment_id: string; epoch: number }>;
  /** One per distinct refused entry, sorted. Never silently dropped. */
  rejected: HostRosterRejection[];
}

/**
 * Never an empty roster for an unusable input. "A halt reached every
 * machine" over zero machines is vacuously TRUE — fail-open on the one
 * quantifier the roster exists for. A statement quantified over
 * `ok: false` is UNKNOWN.
 */
export type HostRosterResult =
  | { ok: false; reason: "empty_chain" | "malformed_key" | "duplicate_key" }
  | ({ ok: true } & HostRosterVerdict);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reduce a set of roster artifacts to a roster — `spec/machine-roster-v1.md` §6.
 *
 * Structurally: a 2P-set per entry (add, then tombstone by id), an
 * observed-remove set per machine, and a forward-only epoch guard on
 * removes. Pure; the whole result is independent of the order and
 * multiplicity of its inputs.
 *
 * `keyChain` is the motebit's identity keys, OLDEST → NEWEST, from a
 * succession chain the CONSUMER verified. Never taken from the entries
 * or on a store's say-so. A key's EPOCH is its index; only the relative
 * order of epochs is used.
 *
 * **Rule A — authority flows forward only.** A retirement signed at
 * epoch `r` ends an enrolment at epoch `e` iff `r >= e`. One rule, where
 * the first two drafts had two special cases that each failed: an old
 * (possibly stolen) key can never end an enrolment made under a newer
 * key, AND a retirement signed before a rotation keeps ending what it
 * ended, because `r >= e` does not change when the chain grows.
 *
 * **Rule B — a machine's status is a function of its HIGHEST-epoch
 * enrolments only.** Enrolments below that are history: the machine
 * moved epochs. This is what makes the verdict monotone under rotation —
 * appending a key can turn `active` into `superseded` and nothing else —
 * where classifying against "current vs old" let a SECOND rotation
 * un-retire a machine.
 */
export async function verifyHostRoster(input: {
  motebitId: string;
  keyChain: readonly string[];
  enrollments: readonly HostEnrollment[];
  retirements: readonly HostRetirement[];
}): Promise<HostRosterResult> {
  // Step 0 — is the chain usable at all?
  const { keyChain } = input;
  if (keyChain.length === 0) return { ok: false, reason: "empty_chain" };
  if (!keyChain.every((k) => typeof k === "string" && HEX_32.test(k))) {
    return { ok: false, reason: "malformed_key" };
  }
  // A repeated key makes an epoch ambiguous, and both readings are
  // wrong: first-index strands the current key in the past; last-index
  // promotes every old artifact, a thief's included, to the present.
  if (new Set(keyChain).size !== keyChain.length) return { ok: false, reason: "duplicate_key" };
  const epochOf = new Map(keyChain.map((k, i) => [k, i]));
  const current = keyChain.length - 1;

  const rejected = new Map<string, HostRosterRejection>();

  // Step 1 — admit each DISTINCT entry once.
  async function admit<T extends HostEnrollment | HostRetirement>(
    kind: "enrollment" | "retirement",
    items: readonly unknown[],
    isShape: (v: unknown) => v is T,
  ): Promise<Array<{ id: string; artifact: T; epoch: number }>> {
    const groups = new Map<string, { first: unknown; copies: Map<string, unknown> }>();
    for (const item of items) {
      // Anything that is a JSON object has an id, well-formed or not, so
      // fifty malformed entries are fifty refusals, not one anonymous one.
      let id: string | null = null;
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        try {
          id = await signedBodyId(item);
        } catch {
          id = null;
        }
      }
      const key = id ?? "";
      const group = groups.get(key) ?? { first: item, copies: new Map<string, unknown>() };
      const sig = (item as { signature?: unknown } | null)?.signature;
      group.copies.set(typeof sig === "string" ? sig : "", item);
      groups.set(key, group);
    }

    const out: Array<{ id: string; artifact: T; epoch: number }> = [];
    for (const [key, group] of groups) {
      const id = key === "" ? null : key;
      const claimed = (group.first as { public_key?: unknown } | null)?.public_key;
      const public_key = typeof claimed === "string" ? claimed : null;
      const refuse = (reason: HostRosterRejection["reason"]): void => {
        rejected.set(`${kind}|${key}|${reason}`, { kind, id, public_key, reason });
      };
      // Copies share a signed body, so shape (bar the signature's own
      // spelling), motebit and key are properties of the GROUP.
      const shaped = [...group.copies.entries()]
        .filter((entry): entry is [string, T] => isShape(entry[1]))
        .sort((a, b) => cmp(a[0], b[0]));
      const sample = shaped[0]?.[1];
      if (id == null || sample == null) {
        refuse("malformed");
        continue;
      }
      if (sample.motebit_id !== input.motebitId) {
        refuse("wrong_motebit");
        continue;
      }
      const epoch = epochOf.get(sample.public_key);
      if (epoch == null) {
        refuse("untrusted_key");
        continue;
      }
      // An id with at least one verifying copy is admitted and yields NO
      // refusal, whatever garbage copies accompany it.
      let good: T | undefined;
      for (const [, copy] of shaped.slice(0, MAX_SIGNATURE_COPIES_TRIED)) {
        if (await verifyBody(copy)) {
          good = copy;
          break;
        }
      }
      if (good == null) refuse("bad_signature");
      else out.push({ id, artifact: good, epoch });
    }
    return out;
  }

  // Step 2 — tombstones, each at the highest epoch that named it.
  const endedAtEpoch = new Map<string, number>();
  for (const r of await admit("retirement", input.retirements, isHostRetirement)) {
    const target = r.artifact.enrollment_id;
    endedAtEpoch.set(target, Math.max(endedAtEpoch.get(target) ?? -1, r.epoch));
  }

  // Step 3 — Rule B, per machine.
  const byDevice = new Map<
    string,
    Array<{ id: string; artifact: HostEnrollment; epoch: number }>
  >();
  for (const e of await admit("enrollment", input.enrollments, isHostEnrollment)) {
    const list = byDevice.get(e.artifact.device_id) ?? [];
    list.push(e);
    byDevice.set(e.artifact.device_id, list);
  }

  const verdict: HostRosterVerdict = {
    chain_head: { epoch: current, public_key: keyChain[current]! },
    active: [],
    retired: [],
    superseded: [],
    tombstones: [...endedAtEpoch]
      .map(([enrollment_id, epoch]) => ({ enrollment_id, epoch }))
      .sort((a, b) => cmp(a.enrollment_id, b.enrollment_id)),
    rejected: [...rejected.values()].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.id ?? "", b.id ?? "") || cmp(a.reason, b.reason),
    ),
  };

  for (const [device_id, all] of byDevice) {
    const H = Math.max(...all.map((e) => e.epoch));
    const atH = all.filter((e) => e.epoch === H);
    // Rule A: ended iff some retirement at an epoch >= the enrolment's names it.
    const standing = atH.filter((e) => (endedAtEpoch.get(e.id) ?? -1) < e.epoch);
    const entries = (standing.length > 0 ? standing : atH)
      .map((e) => {
        const { signature: _unsigned, ...body } = e.artifact;
        return { enrollment_id: e.id, body };
      })
      .sort((a, b) => cmp(a.enrollment_id, b.enrollment_id));
    const machine: HostRosterMachine = {
      device_id,
      epoch: H,
      authenticated: H === current,
      entries,
    };
    if (standing.length === 0) verdict.retired.push(machine);
    else if (H === current) verdict.active.push(machine);
    else verdict.superseded.push(machine);
  }
  const byDeviceId = (a: HostRosterMachine, b: HostRosterMachine): number =>
    cmp(a.device_id, b.device_id);
  verdict.active.sort(byDeviceId);
  verdict.retired.sort(byDeviceId);
  verdict.superseded.sort(byDeviceId);
  return { ok: true, ...verdict };
}
