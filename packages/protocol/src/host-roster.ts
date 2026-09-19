/**
 * The machine roster — which machines a motebit runs unattended work on.
 *
 * "Every machine" is a statement about a set. The sovereign signs the
 * set's membership with the two artifacts below; a relay transports them
 * verbatim and observes only liveness. See
 * `docs/doctrine/machine-roster.md`.
 *
 * The roster is a SET, not a chain: entries are unordered, each is
 * identified by the SHA-256 of its signed body, and the roster is
 * every enrolment no retirement names. Every machine of a motebit holds
 * the same identity key and nothing coordinates them, so concurrent
 * writers are the normal case — and a set needs no merge.
 *
 * Both bodies carry only what stays true for the life of a membership.
 * Not what the machine runs (that changes; it is announced on the socket
 * and reported as liveness), and not a display name (it would be served
 * verbatim forever).
 */

export const HOST_ROSTER_SPEC_ID = "motebit/machine-roster@1.0" as const;

export interface HostEnrollment {
  /** MotebitId whose unattended work this machine hosts. */
  motebit_id: string;
  /**
   * The machine. A label under the motebit's one key — not a principal
   * of its own — and MUST be minted fresh per machine: two hosts sharing
   * one are a single line to everyone downstream.
   */
  device_id: string;
  /**
   * Hex of the 32-byte Ed25519 identity public key that signs this
   * entry. Named in the body so a verifier knows WHICH key after a
   * rotation; a consumer accepts it only if it is a key that consumer
   * already trusts for `motebit_id`, never because the entry says so.
   */
  public_key: string;
  /**
   * Unix ms — a non-negative safe INTEGER — self-asserted by the
   * enrolling machine. Informational: never ordered by, never used to
   * break a tie.
   */
  enrolled_at: number;
  /** Cryptosuite discriminator. Verifiers reject unknown values fail-closed. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Ed25519 over canonical JSON of all fields except `signature`. */
  signature: string;
}

export interface HostRetirement {
  /** MotebitId the retired enrolment belongs to. */
  motebit_id: string;
  /**
   * Lowercase hex SHA-256 of the canonical JSON of the SIGNED BODY of
   * the enrolment being ended — every field except `signature`. Naming
   * the entry by that hash is what makes removal terminal: a replayed
   * copy has the same id and stays retired, and so does a copy whose
   * signature was re-spelled, because the spelling is not in the hash.
   */
  enrollment_id: string;
  /**
   * Hex of the identity public key that signs this retirement. ANY
   * holder of the motebit's key may retire any machine — a lost machine
   * cannot sign its own exit, so the phone retires the VPS.
   */
  public_key: string;
  /** Unix ms — a non-negative safe INTEGER — self-asserted. Informational; never ordered by. */
  retired_at: number;
  /** Cryptosuite discriminator. Verifiers reject unknown values fail-closed. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Ed25519 over canonical JSON of all fields except `signature`. */
  signature: string;
}

// Lowercase only. An entry's id is a hash of exact bytes, so there is
// one spelling of a key — the same law `spec/schemas` states for every
// other hex key on the wire.
const HEX_32 = /^[0-9a-f]{64}$/;
// Unpadded URL-safe base64, the one spelling the suite names.
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

// EXACTLY these keys — the guard is as strict as the wire schema. Every
// field but `signature` is signed, so an extra one would verify; a guard
// that let it through would admit a machine a schema-validating store
// refuses, and two consumers of one set would disagree about "every".
function hasExactly(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

// Unix ms is an integer: a float is a cross-language id hazard.
const isUnixMs = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;

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

export function isHostEnrollment(value: unknown): value is HostEnrollment {
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

export function isHostRetirement(value: unknown): value is HostRetirement {
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
