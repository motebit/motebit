/**
 * Thin CBOR decoder for WebAuthn attestation objects.
 *
 * `navigator.credentials.create({ publicKey: { attestation: "direct", … }})`
 * returns a `PublicKeyCredential` whose `.response.attestationObject` is
 * a CBOR-encoded W3C WebAuthn shape:
 *
 *   {
 *     fmt:     "packed" | "tpm" | "android-key" | "android-safetynet"
 *            | "fido-u2f" | "apple" | "none",
 *     attStmt: { alg: int, sig: bytes, x5c?: bytes[] },
 *     authData: bytes
 *   }
 *
 * Delegating to `cbor2` lets us parse that without writing a full CBOR
 * implementation. We expose a typed `parseWebAuthnAttestationObjectCbor`
 * so the verifier never touches raw `unknown` shapes — every field is
 * validated as it's lifted out.
 *
 * Intentionally a fork of the `@motebit/crypto-appattest` CBOR parser:
 * the App Attest shape carries `attStmt.receipt` (Apple's server-side
 * refresh blob) and does NOT carry `attStmt.alg` or `attStmt.sig`; the
 * WebAuthn packed shape is the inverse. Forking keeps each adapter's
 * parser narrow and self-documenting — no shared base that silently
 * papers over two different wire-format contracts.
 */

import { decode as cborDecode } from "cbor2";

export interface WebAuthnAttestationObjectCbor {
  readonly fmt: string;
  /** COSE algorithm identifier (e.g. -7 for ES256). Only relevant for `packed` fmt. */
  readonly alg: number | null;
  /** Signature over `authData || clientDataHash`. Required for packed fmt. */
  readonly sig: Uint8Array | null;
  /**
   * Certificate chain. Empty when the attestation is self-attested
   * (the credential's own key signed the challenge — no vendor chain).
   */
  readonly x5c: readonly Uint8Array[];
  readonly authData: Uint8Array;
}

/**
 * Parse a CBOR-encoded WebAuthn attestation object.
 *
 * Returns a typed view or throws on malformed / unexpected shape. The
 * caller (`verify.ts`) catches the throw and converts to the
 * `{ valid: false, errors: [...] }` result shape.
 */
export function parseWebAuthnAttestationObjectCbor(
  attestationObjectBytes: Uint8Array,
): WebAuthnAttestationObjectCbor {
  const decoded: unknown = cborDecode(attestationObjectBytes);

  if (decoded === null || typeof decoded !== "object") {
    throw new Error("attestation object is not a CBOR map");
  }

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

  // `alg` and `sig` are specific to the `packed` fmt (and a couple of
  // others); for shapes that lack them we surface null and let the
  // verifier reject based on the fmt arm.
  const algRaw = attStmtGet("alg");
  const alg = typeof algRaw === "number" ? algRaw : algRaw === undefined ? null : NaN;
  if (Number.isNaN(alg)) throw new Error("attestation `attStmt.alg` present but not a number");

  const sigRaw = attStmtGet("sig");
  const sig = sigRaw === undefined ? null : coerceBytes(sigRaw);
  if (sigRaw !== undefined && sig === null) {
    throw new Error("attestation `attStmt.sig` present but not bytes");
  }

  const x5cRaw = attStmtGet("x5c");
  const x5c: Uint8Array[] = [];
  if (x5cRaw !== undefined) {
    if (!Array.isArray(x5cRaw)) {
      throw new Error("attestation `attStmt.x5c` present but not an array");
    }
    for (const entry of x5cRaw) {
      const bytes = coerceBytes(entry);
      if (!bytes) throw new Error("attestation `attStmt.x5c` entry is not bytes");
      x5c.push(bytes);
    }
  }

  const authDataRaw = getFromAny("authData");
  const authData = coerceBytes(authDataRaw);
  if (!authData) throw new Error("attestation `authData` missing or not bytes");

  return { fmt, alg, sig, x5c, authData };
}

/**
 * cbor2 can surface byte strings as `Uint8Array` or, in some Node builds,
 * as `Buffer` (a Uint8Array subclass). This helper collapses both shapes
 * into a plain `Uint8Array` copy the rest of the verifier operates on.
 */
function coerceBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) {
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  }
  return null;
}
