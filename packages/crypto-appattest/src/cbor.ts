/**
 * Thin CBOR decoder for Apple's App Attest attestation object.
 *
 * Apple's `DCAppAttestService.attestKey` returns a CBOR-encoded
 * attestation object with the W3C WebAuthn-compatible shape:
 *
 *   {
 *     fmt:     "apple-appattest",
 *     attStmt: { x5c: [leafDer, intermediateDer], receipt: <bytes> },
 *     authData: <bytes>
 *   }
 *
 * Delegating to `cbor2` lets us parse that without writing a full CBOR
 * implementation. We expose a typed `parseAppAttestCbor` so the verifier
 * never touches raw `unknown` shapes — every field is validated as it's
 * lifted out.
 */

import { decode as cborDecode } from "cbor2";

export interface AppAttestCbor {
  readonly fmt: string;
  readonly x5c: readonly Uint8Array[];
  readonly receipt: Uint8Array | null;
  readonly authData: Uint8Array;
}

/**
 * Parse a CBOR-encoded App Attest attestation object.
 *
 * Returns a typed view or throws on malformed / unexpected shape. The
 * caller (`verify.ts`) catches the throw and converts to the
 * `{ valid: false, errors: [...] }` result shape.
 */
export function parseAppAttestCbor(attestationObjectBytes: Uint8Array): AppAttestCbor {
  // cbor2's `decode` accepts ArrayBuffer-like; `Uint8Array` satisfies.
  const decoded = cborDecode(attestationObjectBytes) as unknown;

  if (decoded === null || typeof decoded !== "object") {
    throw new Error("attestation object is not a CBOR map");
  }

  // cbor2 returns JS `Map` for CBOR maps by default for non-string keys;
  // but Apple's outer map uses string keys so we accept either `Map` or
  // plain `Record`.
  const getFromAny = (key: string): unknown => {
    if (decoded instanceof Map) return decoded.get(key);
    return (decoded as Record<string, unknown>)[key];
  };

  const fmt = getFromAny("fmt");
  if (typeof fmt !== "string") throw new Error("attestation `fmt` missing or not a string");

  const attStmt = getFromAny("attStmt");
  if (attStmt === null || typeof attStmt !== "object") {
    throw new Error("attestation `attStmt` missing or not an object");
  }
  const attStmtGet = (key: string): unknown => {
    if (attStmt instanceof Map) return attStmt.get(key);
    return (attStmt as Record<string, unknown>)[key];
  };

  const x5cRaw = attStmtGet("x5c");
  if (!Array.isArray(x5cRaw) || x5cRaw.length === 0) {
    throw new Error("attestation `attStmt.x5c` missing or empty");
  }
  const x5c: Uint8Array[] = [];
  for (const entry of x5cRaw) {
    const bytes = coerceBytes(entry);
    if (!bytes) throw new Error("attestation `attStmt.x5c` entry is not bytes");
    x5c.push(bytes);
  }

  const receiptRaw = attStmtGet("receipt");
  const receipt = receiptRaw === undefined ? null : coerceBytes(receiptRaw);
  if (receiptRaw !== undefined && receipt === null) {
    throw new Error("attestation `attStmt.receipt` present but not bytes");
  }

  const authDataRaw = getFromAny("authData");
  const authData = coerceBytes(authDataRaw);
  if (!authData) throw new Error("attestation `authData` missing or not bytes");

  return { fmt, x5c, receipt, authData };
}

/**
 * cbor2 can surface byte strings as `Uint8Array` or, in some Node
 * builds, as `Buffer` (which is also a Uint8Array subclass). This
 * helper collapses both shapes into a plain `Uint8Array` copy the
 * rest of the verifier operates on.
 */
function coerceBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) {
    // Normalize to a detached copy — downstream crypto libs expect
    // tight-bounded views and Buffer's offset+length can surprise them.
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  }
  return null;
}
