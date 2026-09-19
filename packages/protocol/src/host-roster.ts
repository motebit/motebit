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
 * every MACHINE with an enrolment, at its highest epoch, that no
 * retirement ends. Every machine of a motebit holds
 * the same identity key and nothing coordinates them, so concurrent
 * writers are the normal case — and a set needs no merge.
 *
 * Both bodies carry only what stays true for the life of a membership.
 * Not what the machine runs (that changes; it is announced on the socket
 * and reported as liveness), and not a display name (it would be served
 * verbatim forever).
 */

export const HOST_ROSTER_SPEC_ID = "motebit/machine-roster@1.0" as const;

/**
 * Domain tags, INSIDE the signed body.
 *
 * Without one, a `HostEnrollment` and a device self-registration are the
 * same suite over `{motebit_id, device_id, public_key, <one time field>,
 * suite}` — separated by a single field name. And "a new major version"
 * would have no expression in what is signed: a major-2 artifact with the
 * same fields would have the same id and a valid signature under both
 * laws. The body is frozen for the life of major 1
 * (`spec/machine-roster-v1.md` §10), so the tag goes in now or never.
 *
 * Named `type`, not `artifact_type`: that name belongs to the
 * `ContentArtifactType` closed registry, a different vocabulary.
 */
export const HOST_ENROLLMENT_TYPE = "motebit/host-enrollment@1" as const;
export const HOST_RETIREMENT_TYPE = "motebit/host-retirement@1" as const;

export interface HostEnrollment {
  /** Domain tag — always `motebit/host-enrollment@1`. Signed. */
  type: typeof HOST_ENROLLMENT_TYPE;
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
  /** Domain tag — always `motebit/host-retirement@1`. Signed. */
  type: typeof HOST_RETIREMENT_TYPE;
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
   * Hex of the identity public key that signs this retirement. A lost
   * machine cannot sign its own exit, so any holder of a key at an epoch
   * NO OLDER than the enrolment's may retire it — the phone retires the
   * VPS. Authority flows forward only: a key from an older epoch, which
   * after a rotation may be in a thief's hands, never ends an enrolment
   * made under a newer one.
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
// Unpadded URL-safe base64 of exactly 64 bytes, in its ONE canonical
// spelling: 86 characters carry 516 bits and a signature has 512, so the
// last character's four low bits are zero — `A`, `Q`, `g` or `w`. The
// full alphabet there gave every signature sixteen verifying spellings.
const ED25519_SIG_B64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const SUITE = "motebit-jcs-ed25519-b64-v1";

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

// EXACTLY these keys — the guard is as strict as the wire schema. Every
// field but `signature` is signed, so an extra one would verify; a guard
// that let it through would admit a machine a schema-validating store
// refuses, and two consumers of one set would disagree about "every".
function hasExactly(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

// Unix ms is an integer: a float is a cross-language id hazard.
// `-0` too: `JSON.parse("-0")` is -0 and it canonicalizes to "0" — the same
// id and signature as 0 — so admitting it makes a verdict order-dependent.
const isUnixMs = (n: unknown): boolean =>
  Number.isSafeInteger(n) && (n as number) >= 0 && !Object.is(n, -0);

function hasSignedShape(v: Record<string, unknown>): boolean {
  return (
    typeof v.motebit_id === "string" &&
    v.motebit_id !== "" &&
    typeof v.public_key === "string" &&
    HEX_32.test(v.public_key) &&
    // The LITERAL. A guard that narrows to a type whose `suite` is one
    // string while accepting any string is a lie the compiler believes.
    v.suite === SUITE &&
    typeof v.signature === "string" &&
    ED25519_SIG_B64URL.test(v.signature)
  );
}

export function isHostEnrollment(value: unknown): value is HostEnrollment {
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

export function isHostRetirement(value: unknown): value is HostRetirement {
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
