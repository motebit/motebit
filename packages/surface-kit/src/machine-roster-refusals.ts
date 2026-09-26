/**
 * What a relay's refusal of a presented roster entry means to the surface
 * that presented it — the ONE place the kit classifies it (#802).
 *
 * The reason set is the relay's (`spec/machine-roster-v1.md` §11; the
 * reference relay's `RosterRefusalReason` in
 * `services/relay/src/host-roster-store.ts`). Each reason is decided from
 * the entry's own bytes, or from a cap the relay never lowers:
 *
 * | reason          | decided by                                        | class     |
 * | --------------- | ------------------------------------------------- | --------- |
 * | `malformed`     | the wire schema over the bytes                    | permanent |
 * | `wrong_motebit` | the entry's `motebit_id` against the route's id   | permanent |
 * | `too_large`     | the canonical JSON's byte length (4096, §11)      | permanent |
 * | `bad_signature` | the signature over the bytes                      | permanent |
 * | `roster_full`   | a bucket cap; the relay never prunes (D3), so a full bucket stays full (C5, N7) | permanent |
 *
 * Permanent: the same bytes presented to the same relay are refused every
 * time, so they are never presented again — re-presenting them forever,
 * with a notice promising they would be "presented again", was #802.
 *
 * A reason not in this table (a newer relay's, or a junk body) is
 * RETRYABLE. That is the deliberate default: re-presenting is idempotent,
 * and a retryable entry stays in set-pinning, so the count stays
 * suppressed while the relay does not hold it. Reading an unknown reason
 * as permanent would stop replicating an entry for good on a word this
 * surface does not understand, and drop it from the omission check.
 * Transient failures are not per-entry reasons at all: they arrive as a
 * whole-request status (429, 5xx, no answer) and are retried.
 */
import { canonicalJson } from "@motebit/encryption";

/** The per-entry refusal reasons of `spec/machine-roster-v1.md` §11. */
export type RelayEntryRefusalReason =
  "malformed" | "wrong_motebit" | "too_large" | "bad_signature" | "roster_full";

/** A permanent refusal other than `roster_full`: the relay will never hold these bytes. */
export type EntryRefusalReason = Exclude<RelayEntryRefusalReason, "roster_full">;

export type EntryRefusalClass = "permanent" | "retryable";

/**
 * Every known reason, classified. `satisfies` makes a reason added to the
 * union without a class here a compile error.
 */
export const RELAY_ENTRY_REFUSALS = {
  malformed: "permanent",
  wrong_motebit: "permanent",
  too_large: "permanent",
  bad_signature: "permanent",
  roster_full: "permanent",
} as const satisfies Record<RelayEntryRefusalReason, EntryRefusalClass>;

export type EntryRefusal =
  | { class: "permanent"; reason: RelayEntryRefusalReason }
  /** Unknown to this surface (or not a string): presented again. */
  | { class: "retryable"; reason: string };

/** Classify one refused entry's `reason` as the relay sent it. */
export function classifyEntryRefusal(reason: unknown): EntryRefusal {
  if (typeof reason !== "string") return { class: "retryable", reason: "refused" };
  if (Object.prototype.hasOwnProperty.call(RELAY_ENTRY_REFUSALS, reason)) {
    const known = reason as RelayEntryRefusalReason;
    if (RELAY_ENTRY_REFUSALS[known] === "permanent") return { class: "permanent", reason: known };
  }
  return { class: "retryable", reason };
}

/**
 * The reference relay's bound on one held entry: its canonical JSON,
 * signature included, in UTF-8 bytes (spec §11; the relay's
 * `MAX_ROSTER_ENTRY_BYTES`, not importable from a package). The kit
 * refuses to MINT past it, and presents an entry past it alone, so it can
 * never take a whole chunk down with it (a 413). Pinned to the live relay
 * by `apps/cli/src/__tests__/machine-roster-activation.test.ts`.
 */
export const MAX_ROSTER_ENTRY_BYTES = 4096;

/** An entry's size as the relay measures it: the UTF-8 bytes of its canonical JSON. */
export function rosterEntryBytes(artifact: unknown): number {
  return new TextEncoder().encode(canonicalJson(artifact)).length;
}

/** The words for a permanent refusal's reason. */
export const ENTRY_REFUSAL_TEXT: Record<RelayEntryRefusalReason, string> = {
  malformed: "malformed",
  wrong_motebit: "names another motebit",
  too_large: "too large",
  bad_signature: "bad signature",
  roster_full: "roster full",
};
