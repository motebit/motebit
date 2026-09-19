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

// Lowercase only. An entry's id is a hash of its exact bytes, so there is
// one spelling of a key — the same law `spec/schemas` states for every
// other hex key on the wire.
const HEX_32 = /^[0-9a-f]{64}$/;

function hasSignedShape(v: Record<string, unknown>): boolean {
  return (
    typeof v.motebit_id === "string" &&
    v.motebit_id !== "" &&
    typeof v.public_key === "string" &&
    HEX_32.test(v.public_key) &&
    typeof v.suite === "string" &&
    typeof v.signature === "string"
  );
}

function isHostEnrollment(value: unknown): value is HostEnrollment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasSignedShape(v) &&
    typeof v.device_id === "string" &&
    v.device_id !== "" &&
    typeof v.enrolled_at === "number" &&
    Number.isFinite(v.enrolled_at)
  );
}

function isHostRetirement(value: unknown): value is HostRetirement {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasSignedShape(v) &&
    typeof v.enrollment_id === "string" &&
    HEX_32.test(v.enrollment_id) &&
    typeof v.retired_at === "number" &&
    Number.isFinite(v.retired_at)
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

/**
 * An enrolment's identity in the set: lowercase hex SHA-256 over the
 * canonical JSON of the COMPLETE artifact, signature included.
 *
 * Ed25519 signatures are deterministic, so the same body under the same
 * key is the same bytes and the same id — which is what lets a daemon
 * re-present its enrolment on every start without the set growing.
 */
export async function hostEnrollmentId(enrollment: HostEnrollment): Promise<string> {
  return hash(new TextEncoder().encode(canonicalJson(enrollment)));
}

/**
 * A retirement's identity in the set, by the same construction as an
 * enrolment's. A store keys what it holds by this, so presenting the
 * same retirement twice is a no-op — ingest is an idempotent union.
 *
 * Exported so a store never hashes a protocol payload for itself: the
 * id is part of the law, and two implementations of it would be two ids.
 */
export async function hostRetirementId(retirement: HostRetirement): Promise<string> {
  return hash(new TextEncoder().encode(canonicalJson(retirement)));
}

export interface HostRosterMember {
  enrollment_id: string;
  enrollment: HostEnrollment;
}

export type HostRosterRejection = {
  kind: "enrollment" | "retirement";
  reason: "malformed" | "wrong_motebit" | "untrusted_key" | "bad_signature";
};

export interface HostRosterVerdict {
  /** Enrolled under a trusted key and named by no valid retirement. */
  active: HostRosterMember[];
  /** Enrolled under a trusted or superseded key, and validly retired. */
  retired: HostRosterMember[];
  /**
   * Enrolled under a key that WAS this motebit's and no longer is, with
   * no line for the same machine under a current key. After a rotation
   * this is precisely the machine that was cut off. Shown, not dropped:
   * rotating a key does not stop the old machine running.
   */
  superseded: HostRosterMember[];
  /**
   * Every validly retired enrolment id, including ones whose enrolment
   * has not been seen. A retirement may arrive first — union has no
   * order — and must still bite when the enrolment shows up.
   */
  tombstones: string[];
  /** What was refused, and why. Never silently dropped. */
  rejected: HostRosterRejection[];
}

/**
 * Reduce a set of roster artifacts to a roster.
 *
 * Pure, and independent of the order or multiplicity of its inputs:
 * merging two copies of a roster is set union, and this gives the same
 * answer for any union of the same entries.
 *
 * `trustedKeys` are the hex identity keys THIS CONSUMER accepts for
 * `motebitId` — its own key, or keys time-valid in the succession chain.
 * Never taken from the entries themselves. Empty ⇒ nothing is trusted.
 * `supersededKeys` are keys that were the motebit's before a rotation:
 * they can no longer add or remove a machine, but their enrolments are
 * still reported (see `superseded`).
 */
export async function verifyHostRoster(input: {
  motebitId: string;
  trustedKeys: readonly string[];
  supersededKeys?: readonly string[];
  enrollments: readonly HostEnrollment[];
  retirements: readonly HostRetirement[];
}): Promise<HostRosterVerdict> {
  const trusted = new Set(input.trustedKeys.map((k) => k.toLowerCase()));
  const superseded = new Set((input.supersededKeys ?? []).map((k) => k.toLowerCase()));
  const rejected: HostRosterRejection[] = [];

  // Retirements first: remove wins, so the tombstones must be known
  // before any enrolment is classified. Only a CURRENT key may retire.
  const tombstones = new Set<string>();
  for (const r of input.retirements) {
    const reason = !isHostRetirement(r)
      ? "malformed"
      : r.motebit_id !== input.motebitId
        ? "wrong_motebit"
        : !trusted.has(r.public_key.toLowerCase())
          ? "untrusted_key"
          : !(await verifyHostRetirement(r))
            ? "bad_signature"
            : null;
    if (reason != null) rejected.push({ kind: "retirement", reason });
    else tombstones.add(r.enrollment_id.toLowerCase());
  }

  const current = new Map<string, HostRosterMember>();
  const old = new Map<string, HostRosterMember>();
  for (const e of input.enrollments) {
    const keyClass = !isHostEnrollment(e)
      ? null
      : trusted.has(e.public_key.toLowerCase())
        ? "trusted"
        : superseded.has(e.public_key.toLowerCase())
          ? "superseded"
          : null;
    const reason = !isHostEnrollment(e)
      ? "malformed"
      : e.motebit_id !== input.motebitId
        ? "wrong_motebit"
        : keyClass == null
          ? "untrusted_key"
          : !(await verifyHostEnrollment(e))
            ? "bad_signature"
            : null;
    if (reason != null) {
      rejected.push({ kind: "enrollment", reason });
      continue;
    }
    const enrollment_id = await hostEnrollmentId(e);
    (keyClass === "trusted" ? current : old).set(enrollment_id, { enrollment_id, enrollment: e });
  }

  const byId = (a: HostRosterMember, b: HostRosterMember) =>
    a.enrollment_id < b.enrollment_id ? -1 : a.enrollment_id > b.enrollment_id ? 1 : 0;
  const all = [...current.values(), ...old.values()];
  const active = [...current.values()].filter((m) => !tombstones.has(m.enrollment_id));
  const currentDevices = new Set(active.map((m) => m.enrollment.device_id));
  return {
    active: active.sort(byId),
    retired: all.filter((m) => tombstones.has(m.enrollment_id)).sort(byId),
    superseded: [...old.values()]
      .filter((m) => !tombstones.has(m.enrollment_id))
      .filter((m) => !currentDevices.has(m.enrollment.device_id))
      .sort(byId),
    tombstones: [...tombstones].sort(),
    rejected,
  };
}
