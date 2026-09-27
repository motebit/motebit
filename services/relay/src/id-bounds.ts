/**
 * How long a caller-chosen `motebit_id` or `device_id` may be at a door
 * that writes it into this relay's durable state (#814).
 *
 * Why a bound at all: the machine roster (`host-roster-store.ts`) refuses
 * an entry whose canonical JSON exceeds `MAX_ROSTER_ENTRY_BYTES` (4096) as
 * `too_large`, and the law bounds no string length. A `HostRetirement`
 * names the `motebit_id` plus a 64-hex `enrollment_id`, so for a short
 * `device_id` it is larger than the enrolment it ends. An id long enough
 * put the enrolment under the cap and its retirement over it: the relay
 * held the machine and could never hold its exit, so a retired machine
 * stayed active on every surface. Bounding the ids where they ENTER makes
 * every entry the relay can hold retirable.
 *
 * The number: real ids are 36-character UUIDs (sovereign UUIDv8 from
 * `deriveSovereignMotebitId`, legacy UUIDv7, `crypto.randomUUID()` device
 * ids). 256 leaves room for any opaque format a client already uses. It is
 * measured in UTF-16 code units (`String.length`), and the worst a code
 * unit costs in canonical JSON is 6 bytes (`\u0001`, a lone surrogate).
 * At 256 + 256 of those, the largest enrolment is 3,388 bytes and the
 * largest retirement 1,919 — both under 4096, computed with the real
 * signing and canonicalization code in `__tests__/id-bounds.test.ts`,
 * which goes red if either constant grows past what the cap allows.
 *
 * Existing rows are not touched. An id already held past the bound keeps
 * its rows and keeps authenticating; every door in the inventory that
 * would write under it again refuses, so it gains no new device or
 * registration. The roster ingest is NOT one of these doors: it takes the
 * path id of an identity already held, and a refusal there would also
 * refuse the retirements that identity needs. Such an identity can exist
 * only if an earlier relay admitted it.
 */

/** The longest `motebit_id` a writing door admits, in UTF-16 code units. */
export const MAX_MOTEBIT_ID_LENGTH = 256;

/** The longest `device_id` a writing door admits, in UTF-16 code units. */
export const MAX_DEVICE_ID_LENGTH = 256;

export interface IdBoundRefusal {
  error: string;
  code: "ID_TOO_LONG";
  field: "motebit_id" | "device_id";
  length: number;
  limit: number;
}

/**
 * The one check every writing door runs. A non-string or absent value is
 * not this function's concern (each door already refuses a missing id in
 * its own words); a string past its bound is refused.
 */
export function refuseOverlongIds(ids: {
  motebitId?: unknown;
  deviceId?: unknown;
}): IdBoundRefusal | null {
  const over = (
    field: IdBoundRefusal["field"],
    value: unknown,
    limit: number,
  ): IdBoundRefusal | null =>
    typeof value === "string" && value.length > limit
      ? {
          error: `${field} is ${value.length} characters; this relay admits at most ${limit}`,
          code: "ID_TOO_LONG",
          field,
          length: value.length,
          limit,
        }
      : null;
  return (
    over("motebit_id", ids.motebitId, MAX_MOTEBIT_ID_LENGTH) ??
    over("device_id", ids.deviceId, MAX_DEVICE_ID_LENGTH)
  );
}
