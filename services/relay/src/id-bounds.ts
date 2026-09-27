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
 * would write under it again refuses (push-token included: it bounds the
 * caller's id, not only the body's), so it gains no new device,
 * registration or push-token row. The roster ingest is NOT one of these doors: it takes the
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
  code: "ID_TOO_LONG" | "ID_NOT_STRING";
  field: "motebit_id" | "device_id";
  /** Length in UTF-16 code units; absent when the value is not a string. */
  length?: number;
  limit: number;
}

/**
 * The one check every writing door runs, before any write. `undefined`
 * means the caller did not supply the field (JSON has no `undefined`), and
 * each door refuses a MISSING id in its own words. Any value that IS
 * present must be a string: an array, object, number, boolean or `null` is
 * refused. The storage layer binds a one-element array as its text, so
 * `["z"x5000]` reached a device row whole, past a length check that looked
 * only at strings (#814 round 2). A string past its bound is refused.
 */
export function refuseInvalidIds(ids: {
  motebitId?: unknown;
  deviceId?: unknown;
}): IdBoundRefusal | null {
  const check = (
    field: IdBoundRefusal["field"],
    value: unknown,
    limit: number,
  ): IdBoundRefusal | null => {
    if (value === undefined) return null;
    if (typeof value !== "string") {
      return { error: `${field} must be a string`, code: "ID_NOT_STRING", field, limit };
    }
    return value.length > limit
      ? {
          error: `${field} is ${value.length} characters; this relay admits at most ${limit}`,
          code: "ID_TOO_LONG",
          field,
          length: value.length,
          limit,
        }
      : null;
  };
  return (
    check("motebit_id", ids.motebitId, MAX_MOTEBIT_ID_LENGTH) ??
    check("device_id", ids.deviceId, MAX_DEVICE_ID_LENGTH)
  );
}

/**
 * An optional free-text field a door writes beside an id (`device_name`,
 * `owner_id`, `push_token`): absent (`undefined` or `null`) is allowed, any
 * other non-string is refused, for the same reason as above.
 */
export function refuseNonStringText(field: string, value: unknown): string | null {
  return value === undefined || value === null || typeof value === "string"
    ? null
    : `${field} must be a string`;
}
