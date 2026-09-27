/**
 * What a `motebit_id` or `device_id` must be at every door that writes an
 * identity, device, registry or push-token row (#814): a string, no longer
 * than its bound, made only of `CANONICAL_ID_PATTERN`'s characters (#853).
 * And what a guard that reads an identity from a URL path must see there:
 * a literal segment (`pathIdentity`, #853).
 *
 * Not every caller-chosen id: the roster ingest stores a caller-chosen
 * `device_id` inside a signed enrolment, bounded only by the 4096-byte
 * entry cap. That is harmless to retirability — a retirement carries no
 * `device_id`, only the `motebit_id` and the enrolment's 64-hex id.
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
 * registration or push-token row. The roster ingest is NOT one of these
 * doors: it takes the path id of an identity already held, and a refusal there would also
 * refuse the retirements that identity needs. Such an identity can exist
 * only if an earlier relay admitted it.
 */

/** The longest `motebit_id` a writing door admits, in UTF-16 code units. */
export const MAX_MOTEBIT_ID_LENGTH = 256;

/** The longest `device_id` a writing door admits, in UTF-16 code units. */
export const MAX_DEVICE_ID_LENGTH = 256;

/**
 * The characters a `motebit_id` or `device_id` may hold at a door that
 * writes one (#853): ASCII letters, digits, `-` and `_`.
 *
 * Why: the relay binds an identity named in a URL path, and two readers
 * of that path disagreed about a percent-encoded one. The `/sync/*` device
 * auth read the RAW segment (`%37f3…`) and verified the token against it;
 * the route handler read Hono's DECODED param (`7f3…`) and acted on that
 * identity. An attacker bootstrapped the id `%37f3…` — a spelling of a
 * victim's id — minted its own `sync` token, and read and wrote the
 * victim's events and conversations. An id from this set is its own URI
 * encoding (`encodeURIComponent(id) === id`, and every decoder is the
 * identity function on it), so no two readers of a path can disagree
 * about it. `pathIdentity` below is the other half: a guard that reads an
 * id from a path refuses a segment that is not literal.
 *
 * What real clients mint, all inside the set: sovereign UUIDv8
 * (`deriveSovereignMotebitId`), legacy UUIDv7, `crypto.randomUUID()`
 * device ids, and fixed device names (`bootstrap-device`, `mobile-local`,
 * `research-service`, …). Every motebit_id held in production on
 * 2026-09-27 is inside it. Not admitted: a `did:key:…` motebit_id — the
 * sovereign-binding law accepts one, but no client mints one, and `:` is
 * a reserved URI character the two path decoders treat differently.
 *
 * Existing rows are not touched, as with the length bound: an id already
 * held outside the set keeps its rows and authenticates wherever its path
 * segment is literal, and gains no new row at a door that runs this check.
 */
export const CANONICAL_ID_PATTERN = /^[0-9A-Za-z_-]+$/;

export interface IdBoundRefusal {
  error: string;
  code: "ID_TOO_LONG" | "ID_NOT_STRING" | "ID_NOT_CANONICAL";
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
 * only at strings (#814 round 2). A string past its bound is refused, and
 * so is one with a character outside `CANONICAL_ID_PATTERN` (#853).
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
    if (value.length > limit) {
      return {
        error: `${field} is ${value.length} characters; this relay admits at most ${limit}`,
        code: "ID_TOO_LONG",
        field,
        length: value.length,
        limit,
      };
    }
    // Empty is each door's own "missing" refusal, as `undefined` is.
    if (value !== "" && !CANONICAL_ID_PATTERN.test(value)) {
      return {
        error: `${field} may contain only ASCII letters, digits, '-' and '_'`,
        code: "ID_NOT_CANONICAL",
        field,
        length: value.length,
        limit,
      };
    }
    return null;
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

/**
 * The identity a URL path segment names, for a guard that reads it from
 * the raw path instead of from the route's param (#853). Returns the
 * segment when it is literal (no `%`) and `null` otherwise; the caller
 * refuses on `null`.
 *
 * Why literal is enough: Hono routes on the path decoded with `decodeURI`
 * and hands each param through `decodeURIComponent`; both change a string
 * only at a `%`. The URL a guard reads (`c.req.url`) is the same
 * normalized string Hono reads. So for a segment with no `%`, the guard's
 * value, the routed path's value and the handler's `c.req.param()` are one
 * string: the identity a token is verified against IS the identity the
 * handler acts on. A segment with a `%` is refused rather than decoded.
 * No canonical id needs one (`CANONICAL_ID_PATTERN`), and re-implementing
 * Hono's two-stage decode would be one more reader that could drift.
 */
export function pathIdentity(segment: string): string | null {
  return segment.includes("%") ? null : segment;
}
