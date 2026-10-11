/**
 * Identity-authority requests (`X-Motebit-Authority`;
 * docs/design/identity-authority-writers.md §3.2, Inc 2).
 *
 * A device token proves the caller holds SOME key registered for an identity
 * — any device row, including a paired or planted one. It does not prove the
 * identity's CURRENT key, which is what moving an identity's money or keys
 * must prove (invariant I1). An authority request is that proof: a signature
 * by the identity's current key over the one change it authorizes,
 * domain-separated the same four ways a v2 federation message is
 * (`federation-message.ts`, the pattern this module reuses):
 *
 *   - its ROLE      — `field`, a closed set (`AUTHORITY_FIELDS`); a signature
 *                     for one field never authorizes another;
 *   - its SUBJECT   — `motebit_id`, the identity whose current key must
 *                     verify it;
 *   - its VERIFIER  — `relay_id`, the one relay that may accept it;
 *   - its FRESHNESS — `ts` within ±5 minutes, plus a `nonce`; the verifier
 *                     records each accepted signature and refuses it again
 *                     (the replay store is the verifier's, not this module's).
 *
 * The change itself is bound by `value_sha256` = lowercase-hex SHA-256 of the
 * JCS form of the value the request writes (for the relay's doors, the
 * request's JSON body), so a captured signature sets no other value.
 *
 * Signed bytes:
 *
 *   "motebit/authority/v1\n" ‖ JCS(envelope)
 *
 * Wire: the HTTP header `X-Motebit-Authority` carries
 * base64url(JSON({ envelope, signature })) (`encodeAuthorityHeader`).
 *
 * ONE producer (`signAuthorityRequest`) and ONE verifier
 * (`verifyAuthorityRequest`). The verifier is pure: the caller supplies the
 * identity's current key (from its own records) and its own relay id.
 */
import {
  bytesToHex,
  canonicalJson,
  canonicalJsonForSigning,
  canonicalSha256,
  fromBase64Url,
  hexToBytes,
  toBase64Url,
} from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

/** The byte-prefix domain tag of every authority request. */
export const AUTHORITY_REQUEST_DOMAIN = "motebit/authority/v1" as const;

/** The suite of every authority request: JCS envelope, Ed25519, hex signature. */
export const AUTHORITY_REQUEST_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/** The HTTP header an authority request travels in. */
export const AUTHORITY_REQUEST_HEADER = "X-Motebit-Authority" as const;

/** Freshness window: |now − ts| must not exceed this. */
export const AUTHORITY_REQUEST_MAX_SKEW_MS = 300_000;

/**
 * The closed set of changes an authority request may authorize — one per
 * relay door that writes an identity's money or keys (the design's money
 * doors #1, #3–#6). Adding one is a registry append here plus its door.
 *
 *   - `registration` — `POST /api/v1/agents/register` (key, endpoint,
 *                      capabilities, guardian, settlement, sweep).
 *   - `sweep_config` — `PATCH /api/v1/agents/:id/sweep-config`.
 *   - `listing`      — `POST /api/v1/agents/:id/listing` (pay-to, pricing).
 *   - `withdrawal`   — `POST /api/v1/agents/:id/withdraw` (amount, destination).
 */
export const AUTHORITY_FIELDS = ["registration", "sweep_config", "listing", "withdrawal"] as const;

export type AuthorityField = (typeof AUTHORITY_FIELDS)[number];

/** The signed envelope. Every field is inside the signature. */
export interface AuthorityRequestEnvelope {
  /** The identity whose current key signs. */
  motebit_id: string;
  field: AuthorityField;
  /** Lowercase hex SHA-256 of JCS(value). */
  value_sha256: string;
  /** The one relay that may accept the request. */
  relay_id: string;
  /** Epoch ms at signing. */
  ts: number;
  /** 32 random bytes, hex. */
  nonce: string;
  suite: typeof AUTHORITY_REQUEST_SUITE;
}

/** An authority request on the wire: the envelope and its hex signature. */
export interface SignedAuthorityRequest {
  envelope: AuthorityRequestEnvelope;
  signature: string;
}

export type AuthorityRequestRefusal =
  | "malformed"
  | "unknown_field"
  | "field_mismatch"
  | "unsupported_suite"
  | "wrong_identity"
  | "wrong_relay"
  | "stale"
  | "value_mismatch"
  | "bad_signature";

export type AuthorityRequestVerdict =
  { ok: true; request: SignedAuthorityRequest } | { ok: false; reason: AuthorityRequestRefusal };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/i;

function isField(f: unknown): f is AuthorityField {
  return typeof f === "string" && (AUTHORITY_FIELDS as readonly string[]).includes(f);
}

/**
 * The exact bytes an authority request signs. `canon` is the JCS
 * canonicalizer: the producer passes the guarded `canonicalJsonForSigning`,
 * the verifier the plain one — identical output for every well-formed
 * envelope.
 */
export function authorityRequestBytes(
  envelope: AuthorityRequestEnvelope,
  canon: (value: unknown) => string = canonicalJson,
): Uint8Array {
  return new TextEncoder().encode(`${AUTHORITY_REQUEST_DOMAIN}\n${canon(envelope)}`);
}

/** Lowercase hex SHA-256 of JCS(value) — the `value_sha256` a request commits to. */
export function authorityValueDigest(value: unknown): Promise<string> {
  return canonicalSha256(value);
}

function randomNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/**
 * Sign an authority request: `motebitId`'s key authorizes writing `value` to
 * `field` at relay `relayId`. The only producer of authority signatures.
 */
export async function signAuthorityRequest(args: {
  motebitId: string;
  field: AuthorityField;
  value: unknown;
  relayId: string;
  privateKey: Uint8Array;
  /** Injected for tests; defaults to `Date.now()`. */
  now?: number;
  /** Injected for tests; defaults to 32 fresh random bytes. */
  nonce?: string;
}): Promise<SignedAuthorityRequest> {
  if (!isField(args.field)) throw new Error(`unknown authority field: ${String(args.field)}`);
  if (args.motebitId === "" || args.relayId === "")
    throw new Error("authority request needs a motebit_id and a relay_id");
  const envelope: AuthorityRequestEnvelope = {
    motebit_id: args.motebitId,
    field: args.field,
    value_sha256: await authorityValueDigest(args.value),
    relay_id: args.relayId,
    ts: args.now ?? Date.now(),
    nonce: args.nonce ?? randomNonce(),
    suite: AUTHORITY_REQUEST_SUITE,
  };
  const sig = await signBySuite(
    AUTHORITY_REQUEST_SUITE,
    authorityRequestBytes(envelope, canonicalJsonForSigning),
    args.privateKey,
  );
  return { envelope, signature: bytesToHex(sig) };
}

/**
 * Verify an authority request. The only verifier of authority signatures.
 * Fail-closed and never throws; checks, in order: shape, field (known AND the
 * one the door writes), suite, identity, relay = `self`, freshness, value
 * digest, signature under `publicKeyHex`.
 *
 * It does NOT record the request: the caller records the accepted signature
 * in the same transaction as the write it authorizes, and refuses one it has
 * seen.
 */
export async function verifyAuthorityRequest(
  message: unknown,
  expect: {
    field: AuthorityField;
    motebitId: string;
    /** The verifying relay's own id. */
    self: string;
    /** The identity's current key, as the verifier holds it (hex). */
    publicKeyHex: string;
    /** The value the request must commit to. */
    value: unknown;
    /** Injected for tests; defaults to `Date.now()`. */
    now?: number;
  },
): Promise<AuthorityRequestVerdict> {
  const parsed = parseAuthorityRequest(message);
  if (parsed === null) return { ok: false, reason: "malformed" };
  const { envelope, signature } = parsed;
  if (!isField(envelope.field)) return { ok: false, reason: "unknown_field" };
  if (envelope.field !== expect.field) return { ok: false, reason: "field_mismatch" };
  if (envelope.suite !== AUTHORITY_REQUEST_SUITE) return { ok: false, reason: "unsupported_suite" };
  if (envelope.motebit_id !== expect.motebitId) return { ok: false, reason: "wrong_identity" };
  if (envelope.relay_id !== expect.self) return { ok: false, reason: "wrong_relay" };
  const now = expect.now ?? Date.now();
  if (Math.abs(now - envelope.ts) > AUTHORITY_REQUEST_MAX_SKEW_MS)
    return { ok: false, reason: "stale" };
  if ((await authorityValueDigest(expect.value)) !== envelope.value_sha256)
    return { ok: false, reason: "value_mismatch" };
  let ok = false;
  try {
    ok = await verifyBySuite(
      AUTHORITY_REQUEST_SUITE,
      authorityRequestBytes(envelope),
      hexToBytes(signature),
      hexToBytes(expect.publicKeyHex),
    );
  } catch {
    ok = false;
  }
  return ok ? { ok: true, request: parsed } : { ok: false, reason: "bad_signature" };
}

/**
 * Read a wire value as an authority request, keeping exactly the envelope
 * fields (so an extra field can never ride along unsigned), or null when it
 * is not one.
 */
export function parseAuthorityRequest(message: unknown): SignedAuthorityRequest | null {
  if (message === null || typeof message !== "object") return null;
  const m = message as { envelope?: unknown; signature?: unknown };
  if (typeof m.signature !== "string" || !HEX_SIG.test(m.signature)) return null;
  const e = m.envelope as Record<string, unknown> | null | undefined;
  if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
  const { motebit_id, field, value_sha256, relay_id, ts, nonce, suite } = e;
  if (
    typeof motebit_id !== "string" ||
    motebit_id === "" ||
    typeof field !== "string" ||
    typeof value_sha256 !== "string" ||
    !HEX64.test(value_sha256) ||
    typeof relay_id !== "string" ||
    relay_id === "" ||
    typeof ts !== "number" ||
    !Number.isSafeInteger(ts) ||
    typeof nonce !== "string" ||
    !HEX64.test(nonce) ||
    typeof suite !== "string" ||
    Object.keys(e).length !== 7
  )
    return null;
  return {
    envelope: {
      motebit_id,
      field: field as AuthorityField,
      value_sha256,
      relay_id,
      ts,
      nonce,
      suite: suite as typeof AUTHORITY_REQUEST_SUITE,
    },
    signature: m.signature.toLowerCase(),
  };
}

/** The `X-Motebit-Authority` header value: base64url(JSON({ envelope, signature })). */
export function encodeAuthorityHeader(request: SignedAuthorityRequest): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(request)));
}

/** Decode an `X-Motebit-Authority` header to a wire value, or null when it does not decode. */
export function decodeAuthorityHeader(header: string): unknown {
  if (header.length === 0 || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header)) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(header)));
  } catch {
    return null;
  }
}
