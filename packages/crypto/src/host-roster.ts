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
import { canonicalJson, fromBase64Url, hexToBytes, toBase64Url, hash } from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

export const HOST_ROSTER_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// Lowercase only. An entry's id is a hash of exact bytes, so there is
// one spelling of a key — the same law `spec/schemas` states for every
// other hex key on the wire.
const HEX_32 = /^[0-9a-f]{64}$/;
// Unpadded URL-safe base64, the one spelling the suite names. `atob`
// would also take padding, `+/` and stray whitespace; a verifier that
// accepts what the wire schema refuses is a second, laxer law.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const ENROLLMENT_KEYS = [
  "device_id",
  "enrolled_at",
  "motebit_id",
  "public_key",
  "signature",
  "suite",
];
const RETIREMENT_KEYS = [
  "enrollment_id",
  "motebit_id",
  "public_key",
  "retired_at",
  "signature",
  "suite",
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
    typeof v.suite === "string" &&
    typeof v.signature === "string" &&
    BASE64URL.test(v.signature)
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

async function verifyBody(artifact: {
  suite: string;
  public_key: string;
  signature: string;
}): Promise<boolean> {
  if (artifact.suite !== HOST_ROSTER_SUITE) return false;
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
  enrollment: Omit<HostEnrollment, "signature" | "suite">,
  identityPrivateKey: Uint8Array,
): Promise<HostEnrollment> {
  const body = { ...enrollment, suite: HOST_ROSTER_SUITE };
  return { ...body, signature: await signBody(body, identityPrivateKey) };
}

/**
 * Integrity only: the entry was signed by the key it names. Whether
 * that key speaks for `motebit_id` is the CONSUMER's question, answered
 * by `verifyHostRoster` against keys the consumer already trusts — an
 * entry that is perfectly self-consistent under a stranger's key is
 * exactly what a hostile relay would serve.
 */
export async function verifyHostEnrollment(enrollment: HostEnrollment): Promise<boolean> {
  if (!isHostEnrollment(enrollment)) return false;
  return verifyBody(enrollment);
}

export async function signHostRetirement(
  retirement: Omit<HostRetirement, "signature" | "suite">,
  identityPrivateKey: Uint8Array,
): Promise<HostRetirement> {
  const body = { ...retirement, suite: HOST_ROSTER_SUITE };
  return { ...body, signature: await signBody(body, identityPrivateKey) };
}

/** Integrity only — see `verifyHostEnrollment`. */
export async function verifyHostRetirement(retirement: HostRetirement): Promise<boolean> {
  if (!isHostRetirement(retirement)) return false;
  return verifyBody(retirement);
}

/** SHA-256 over the canonical JSON of every field EXCEPT `signature`. */
async function signedBodyId(artifact: { signature: string }): Promise<string> {
  const { signature: _unsigned, ...body } = artifact;
  return hash(new TextEncoder().encode(canonicalJson(body)));
}

/**
 * An enrolment's identity in the set: lowercase hex SHA-256 over the
 * canonical JSON of its SIGNED BODY — every field except `signature`.
 *
 * Not over the whole artifact, and the difference is the whole point of
 * a retirement. The signature's spelling is the one part of an artifact
 * nothing signs, and base64 has many spellings of the same bytes: a
 * trailing `=`, `+/` for `-_`, the unused low bits of the last
 * character. Hash it, and anyone holding a copy — no key needed — can
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

export interface HostRosterEntry {
  enrollment_id: string;
  enrollment: HostEnrollment;
}

/**
 * The roster's unit is the MACHINE, not the entry. One machine may hold
 * several enrolments — a daemon that lost its cached artifact mints a
 * new one — and counting entries would count that machine twice in
 * every "N machines" a consumer computes.
 */
export interface HostRosterMachine {
  device_id: string;
  /** Sorted by `enrollment_id`. Which entries, per bucket, is stated on the verdict. */
  entries: HostRosterEntry[];
}

export interface HostRosterRejection {
  kind: "enrollment" | "retirement";
  /** The entry's id, or `null` when it was too malformed to have one. */
  id: string | null;
  /** The key it claimed, when readable — what a person would investigate. */
  public_key: string | null;
  reason: "malformed" | "wrong_motebit" | "untrusted_key" | "bad_signature";
}

export interface HostRosterTombstone {
  enrollment_id: string;
  /**
   * `any` — signed by a current key: ends whatever it names.
   * `superseded_only` — signed by a superseded key: ends only an
   * enrolment made under a superseded key (see `verifyHostRoster`).
   */
  scope: "any" | "superseded_only";
}

/**
 * Every admissible machine lands in EXACTLY ONE of `active`, `retired`,
 * `superseded`.
 */
export interface HostRosterVerdict {
  /**
   * At least one enrolment under a current key that no retirement ends.
   * `entries` are those standing enrolments — to retire the machine,
   * retire every one of them.
   */
  active: HostRosterMachine[];
  /** Every enrolment it has is ended. `entries` are all of them. */
  retired: HostRosterMachine[];
  /**
   * No enrolment under a current key at all, and at least one under a
   * superseded key still standing. After a rotation this is precisely
   * the machine that never received the new key. Shown, not dropped:
   * rotating a key does not stop the old machine running. `entries` are
   * its standing old-key enrolments.
   */
  superseded: HostRosterMachine[];
  /**
   * Every valid retirement's target, including ones whose enrolment has
   * not been seen. A retirement may arrive first — union has no order —
   * and must still bite when the enrolment shows up.
   */
  tombstones: HostRosterTombstone[];
  /** What was refused, and why. Deduplicated and sorted; never silently dropped. */
  rejected: HostRosterRejection[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reduce a set of roster artifacts to a roster.
 *
 * Pure, and the WHOLE verdict — not just `active` — is independent of
 * the order and multiplicity of its inputs: merging two copies of a
 * roster is set union, and any union of the same entries reduces to a
 * deep-equal result.
 *
 * `trustedKeys` are the hex identity keys THIS CONSUMER accepts for
 * `motebitId` — its own key, or keys time-valid in the succession chain.
 * Never taken from the entries themselves. Empty ⇒ nothing is trusted.
 * `supersededKeys` are keys that were the motebit's before a rotation.
 *
 * What a superseded key may still do is scoped to its own epoch. It can
 * no longer ADD a machine that counts, and it cannot end an enrolment
 * made under a current key — after a rotation the old key may be held by
 * whoever took the machine, and must not be able to strike the
 * sovereign's other machines out of "every machine" before a halt. But a
 * retirement it signed still ends an enrolment made under a superseded
 * key: otherwise rotating would silently un-retire every machine retired
 * before it, and there is no trusted clock here to tell "signed before
 * the rotation" from "signed after it by a thief". The worst a thief
 * gains is to mark an old-epoch line — most plausibly the stolen
 * machine's own — as retired rather than cut off; it stays visible
 * either way, and nothing current is touched.
 */
export async function verifyHostRoster(input: {
  motebitId: string;
  trustedKeys: readonly string[];
  supersededKeys?: readonly string[];
  enrollments: readonly HostEnrollment[];
  retirements: readonly HostRetirement[];
}): Promise<HostRosterVerdict> {
  const trusted = new Set(input.trustedKeys.map((k) => k.toLowerCase()));
  const old = new Set((input.supersededKeys ?? []).map((k) => k.toLowerCase()));
  const keyClass = (k: string): "trusted" | "superseded" | null =>
    trusted.has(k) ? "trusted" : old.has(k) ? "superseded" : null;

  const rejections = new Map<string, HostRosterRejection>();
  const reject = (r: HostRosterRejection): void => {
    rejections.set(`${r.kind}|${r.id ?? ""}|${r.public_key ?? ""}|${r.reason}`, r);
  };

  /**
   * Admit each DISTINCT entry once. Copies of one signed body share an
   * id however their signatures are spelled, so they are grouped first
   * and tried in sorted order — which copy represents the entry must not
   * depend on which arrived first.
   */
  async function admit<T extends HostEnrollment | HostRetirement>(
    kind: "enrollment" | "retirement",
    items: readonly T[],
    isShape: (v: unknown) => v is T,
    verify: (v: T) => Promise<boolean>,
  ): Promise<Array<{ id: string; artifact: T; signer: "trusted" | "superseded" }>> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      if (!isShape(item)) {
        reject({ kind, id: null, public_key: null, reason: "malformed" });
        continue;
      }
      const id = await signedBodyId(item);
      groups.set(id, [...(groups.get(id) ?? []), item]);
    }
    const out: Array<{ id: string; artifact: T; signer: "trusted" | "superseded" }> = [];
    for (const [id, copies] of groups) {
      const first = copies[0]!;
      const signer = keyClass(first.public_key);
      const reason =
        first.motebit_id !== input.motebitId
          ? "wrong_motebit"
          : signer == null
            ? "untrusted_key"
            : null;
      if (reason != null || signer == null) {
        reject({ kind, id, public_key: first.public_key, reason: reason ?? "untrusted_key" });
        continue;
      }
      const spellings = [...new Map(copies.map((c) => [c.signature, c])).values()].sort((a, b) =>
        cmp(a.signature, b.signature),
      );
      let good: T | undefined;
      for (const copy of spellings) {
        if (await verify(copy)) {
          good = copy;
          break;
        }
      }
      if (good == null) reject({ kind, id, public_key: first.public_key, reason: "bad_signature" });
      else out.push({ id, artifact: good, signer });
    }
    return out;
  }

  // Retirements first: remove wins, so every tombstone is known before
  // any machine is classified.
  const scopes = new Map<string, HostRosterTombstone["scope"]>();
  for (const r of await admit(
    "retirement",
    input.retirements,
    isHostRetirement,
    verifyHostRetirement,
  )) {
    const target = r.artifact.enrollment_id;
    if (r.signer === "trusted") scopes.set(target, "any");
    else if (!scopes.has(target)) scopes.set(target, "superseded_only");
  }

  const byDevice = new Map<string, { cur: HostRosterEntry[]; old: HostRosterEntry[] }>();
  const ended = new Set<string>();
  for (const e of await admit(
    "enrollment",
    input.enrollments,
    isHostEnrollment,
    verifyHostEnrollment,
  )) {
    const scope = scopes.get(e.id);
    if (scope === "any" || (scope === "superseded_only" && e.signer === "superseded")) {
      ended.add(e.id);
    }
    const slot = byDevice.get(e.artifact.device_id) ?? { cur: [], old: [] };
    (e.signer === "trusted" ? slot.cur : slot.old).push({
      enrollment_id: e.id,
      enrollment: e.artifact,
    });
    byDevice.set(e.artifact.device_id, slot);
  }

  const verdict: HostRosterVerdict = {
    active: [],
    retired: [],
    superseded: [],
    tombstones: [...scopes]
      .map(([enrollment_id, scope]) => ({ enrollment_id, scope }))
      .sort((a, b) => cmp(a.enrollment_id, b.enrollment_id)),
    rejected: [...rejections.values()].sort(
      (a, b) =>
        cmp(a.kind, b.kind) ||
        cmp(a.id ?? "", b.id ?? "") ||
        cmp(a.public_key ?? "", b.public_key ?? "") ||
        cmp(a.reason, b.reason),
    ),
  };
  const byId = (a: HostRosterEntry, b: HostRosterEntry): number =>
    cmp(a.enrollment_id, b.enrollment_id);
  const standing = (es: HostRosterEntry[]): HostRosterEntry[] =>
    es.filter((e) => !ended.has(e.enrollment_id)).sort(byId);

  for (const [device_id, slot] of byDevice) {
    const curStanding = standing(slot.cur);
    if (curStanding.length > 0) {
      verdict.active.push({ device_id, entries: curStanding });
    } else if (slot.cur.length > 0) {
      // It HAD a current-key enrolment and every one is ended: retired.
      // Its old-key lines do not resurrect it as "cut off" — it received
      // the new key and was explicitly let go.
      verdict.retired.push({ device_id, entries: [...slot.cur, ...slot.old].sort(byId) });
    } else {
      const oldStanding = standing(slot.old);
      if (oldStanding.length > 0) verdict.superseded.push({ device_id, entries: oldStanding });
      else verdict.retired.push({ device_id, entries: [...slot.old].sort(byId) });
    }
  }
  const byDeviceId = (a: HostRosterMachine, b: HostRosterMachine): number =>
    cmp(a.device_id, b.device_id);
  verdict.active.sort(byDeviceId);
  verdict.retired.sort(byDeviceId);
  verdict.superseded.sort(byDeviceId);
  return verdict;
}
