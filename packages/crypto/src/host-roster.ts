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
  bytesToHex,
  canonicalJson,
  canonicalSha256,
  fromBase64Url,
  hexToBytes,
  toBase64Url,
} from "./signing.js";
import { getPublicKeyBySuite, signBySuite, verifyBySuite } from "./suite-dispatch.js";

export const HOST_ROSTER_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// Lowercase only. An entry's id is a hash of exact bytes, so there is
// one spelling of a key — the same law `spec/schemas` states for every
// other hex key on the wire.
const HEX_32 = /^[0-9a-f]{64}$/;
// Unpadded URL-safe base64 of exactly 64 bytes, in its ONE canonical
// spelling. 86 characters carry 516 bits and a signature has 512, so the
// last character holds two signature bits and four that must be zero —
// which leaves `A`, `Q`, `g`, `w`. Allowing the full alphabet there gave
// every signature sixteen well-formed spellings that all verified: the
// reduction did not care (an id excludes the signature), but "one
// spelling" was false, a store deduplicating on bytes held sixteen copies
// of one entry, and `atob`'s tolerance of non-zero trailing bits is not
// uniform across runtimes. `atob` would also take padding, `+/` and stray
// whitespace; a verifier that accepts what the wire schema refuses is a
// second, laxer law.
const ED25519_SIG_B64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;

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
// `-0` is refused too: `JSON.parse("-0")` is -0, it canonicalizes to "0" —
// the same id and the same signature as 0 — and a verdict carrying one or
// the other would depend on which copy arrived first.
const isUnixMs = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0 && !Object.is(n, -0);

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

/**
 * Takes a GUARDED artifact — the parameter type is the narrowed union the
 * `isHostEnrollment` / `isHostRetirement` guards produce, so a caller
 * cannot reach this with an unchecked object, and the guards hold
 * `public_key` to 64 lowercase hex characters (32 bytes by construction).
 * The try/catch covers the one thing the guards do not decide: whether
 * the signature bytes verify (or decode at all).
 */
async function verifyBody(artifact: HostEnrollment | HostRetirement): Promise<boolean> {
  const { signature, ...body } = artifact;
  try {
    const message = new TextEncoder().encode(canonicalJson(body));
    return await verifyBySuite(
      HOST_ROSTER_SUITE,
      message,
      fromBase64Url(signature),
      hexToBytes(artifact.public_key),
    );
  } catch {
    return false;
  }
}

/**
 * A signer must not mint what no verifier will accept.
 *
 * A daemon caches its enrolment and re-presents the same bytes on every
 * start, so an artifact that signs fine and verifies nowhere is a machine
 * that is silently never in "every machine", forever. Two ways to get
 * one, both easy: a body that is not well-formed (a float time from
 * `performance.now()`, an uppercase key), and a `public_key` that is not
 * the key doing the signing. Both throw — a producer's bug, surfaced
 * where the producer is.
 */
async function assertSignable<T extends HostEnrollment | HostRetirement>(
  name: string,
  artifact: T,
  isShape: (v: unknown) => v is T,
  identityPrivateKey: Uint8Array,
): Promise<T> {
  if (!isShape(artifact)) {
    throw new Error(
      `refusing to sign: not a well-formed ${name} — every verifier would reject it. Check that times are non-negative integers, keys are 64 lowercase hex characters, and no field is empty.`,
    );
  }
  const derived = await getPublicKeyBySuite(identityPrivateKey, HOST_ROSTER_SUITE);
  if (bytesToHex(derived) !== artifact.public_key) {
    throw new Error(
      `refusing to sign: ${name}.public_key does not match the signing key — the artifact would name a key its signature was not made with, and verify nowhere.`,
    );
  }
  return artifact;
}

export async function signHostEnrollment(
  enrollment: Omit<HostEnrollment, "signature" | "suite" | "type">,
  identityPrivateKey: Uint8Array,
): Promise<HostEnrollment> {
  // Field by field, never a spread of the caller's object. The natural
  // way to re-enrol under a new key is `{ ...oldEnrolment, public_key }`,
  // TypeScript does not excess-check a spread, and the old `signature`
  // would ride along INSIDE the body being signed.
  const body = {
    type: HOST_ENROLLMENT_TYPE,
    motebit_id: enrollment.motebit_id,
    device_id: enrollment.device_id,
    public_key: enrollment.public_key,
    enrolled_at: enrollment.enrolled_at,
    suite: HOST_ROSTER_SUITE,
  } as const;
  await assertSignable(
    "HostEnrollment",
    { ...body, signature: "A".repeat(86) },
    isHostEnrollment,
    identityPrivateKey,
  );
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
  // Field by field — see `signHostEnrollment`.
  const body = {
    type: HOST_RETIREMENT_TYPE,
    motebit_id: retirement.motebit_id,
    enrollment_id: retirement.enrollment_id,
    public_key: retirement.public_key,
    retired_at: retirement.retired_at,
    suite: HOST_ROSTER_SUITE,
  } as const;
  await assertSignable(
    "HostRetirement",
    { ...body, signature: "A".repeat(86) },
    isHostRetirement,
    identityPrivateKey,
  );
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
  /**
   * The entry's id. `null` for input that is not a JSON object or cannot
   * be canonicalized: such inputs cannot be told apart, so they are ONE
   * refusal, with no key.
   */
  id: string | null;
  /**
   * The key it claimed, when it has an id and the claim is a string —
   * what a person would investigate. Copies that share an id share a
   * canonical body, so this never depends on which copy arrived first.
   */
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
   * PENDING tombstones only: admissible retirements naming an enrolment
   * that is NOT in this input, with the highest epoch that named each. A
   * retirement may arrive first — union has no order — and a consumer
   * keeps these so they bite when the enrolment appears (it ends an
   * enrolment at epoch `e` iff `epoch >= e`).
   *
   * Retirements naming an enrolment that IS present are not listed: their
   * whole effect is already in the three buckets, and listing them let a
   * reader mistake one that Rule A ignores — a stolen old key naming a
   * current enrolment — for a machine being retired. "Am I retired?" is
   * answered by the buckets, never by this list.
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
  | {
      ok: false;
      reason: "malformed_input" | "empty_chain" | "malformed_key" | "duplicate_key";
    }
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
  // Step 0 — is the QUESTION usable at all? Hostile or merely broken
  // input reaches here untyped, whatever the signature says: a config
  // read that failed gives an empty motebit id, under which every entry
  // is `wrong_motebit` and the roster is empty — fail-open by another
  // door; and a store with no retirements that omits the key would throw
  // out of a function whose contract is a result, for a caller to catch
  // and default.
  const raw = input as {
    motebitId?: unknown;
    keyChain?: unknown;
    enrollments?: unknown;
    retirements?: unknown;
  };
  if (
    typeof raw.motebitId !== "string" ||
    raw.motebitId === "" ||
    !Array.isArray(raw.keyChain) ||
    !Array.isArray(raw.enrollments) ||
    !Array.isArray(raw.retirements)
  ) {
    return { ok: false, reason: "malformed_input" };
  }
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
  //
  // Nothing a party with NO key can add may change the outcome for an
  // id. A consumer unions what several stores serve, and one of them may
  // be hostile or merely unverifying, so beside an authentic entry there
  // may be any number of copies of its body under garbage signatures,
  // and copies that canonicalize to the SAME id and signature while not
  // being well-formed (`{...e, device_name: undefined}` — canonical JSON
  // skips an undefined value). So: well-formed copies are kept apart from
  // the rest and never displaced by them; EVERY distinct well-formed copy
  // is tried, with no cap — a cap let eight garbage copies that sort
  // first suppress a real retirement; and an id with one verifying copy
  // is admitted and refuses nothing. The cost of a flood is bounded by
  // whoever hands this function its input, which is where it can be.
  async function admit<T extends HostEnrollment | HostRetirement>(
    kind: "enrollment" | "retirement",
    items: readonly unknown[],
    isShape: (v: unknown) => v is T,
  ): Promise<Array<{ id: string; artifact: T; epoch: number }>> {
    const groups = new Map<string, { claimed: string | null; shaped: Map<string, T> }>();
    let unidentifiable = false;
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
      if (id == null) {
        unidentifiable = true;
        continue;
      }
      let group = groups.get(id);
      if (group == null) {
        const claimed = (item as { public_key?: unknown }).public_key;
        group = { claimed: typeof claimed === "string" ? claimed : null, shaped: new Map() };
        groups.set(id, group);
      }
      if (isShape(item)) group.shaped.set(item.signature, item);
    }
    if (unidentifiable) {
      rejected.set(`${kind}||malformed`, { kind, id: null, public_key: null, reason: "malformed" });
    }

    const out: Array<{ id: string; artifact: T; epoch: number }> = [];
    for (const [id, group] of groups) {
      const refuse = (reason: HostRosterRejection["reason"]): void => {
        rejected.set(`${kind}|${id}|${reason}`, { kind, id, public_key: group.claimed, reason });
      };
      // Copies share a signed body, so motebit and key belong to the GROUP.
      const sample = group.shaped.values().next().value;
      if (sample == null) {
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
      let good: T | undefined;
      for (const copy of group.shaped.values()) {
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
    tombstones: [], // filled below, once the enrolments present are known
    rejected: [...rejected.values()].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.id ?? "", b.id ?? "") || cmp(a.reason, b.reason),
    ),
  };

  const present = new Set<string>();
  for (const all of byDevice.values()) for (const e of all) present.add(e.id);
  verdict.tombstones = [...endedAtEpoch]
    .filter(([enrollment_id]) => !present.has(enrollment_id))
    .map(([enrollment_id, epoch]) => ({ enrollment_id, epoch }))
    .sort((a, b) => cmp(a.enrollment_id, b.enrollment_id));

  for (const [device_id, all] of byDevice) {
    // A loop, not `Math.max(...spread)`: a holder of an old key may mint
    // any number of enrolments for one device, and a spread that large
    // throws — denying a consumer even the active set an old key cannot
    // otherwise touch.
    let H = -1;
    for (const e of all) if (e.epoch > H) H = e.epoch;
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
