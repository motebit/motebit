/**
 * Pinned Google Play Integrity JWKS — design scope note.
 *
 * **State of v1:** the acceptance set is empty. The verifier is fail-closed
 * by default — every real token is rejected until an operator has made the
 * design decisions described below and pinned real bytes.
 *
 * **Design gap to close before real traffic:** Google Play Integrity
 * tokens are NOT plain JWS signed by a publicly-discoverable JWKS. The
 * modern protocol (2023+) returns JWE (encrypted) tokens; the receiver
 * either
 *   (a) sends the encrypted token to Google's Play Integrity API for
 *       server-side decryption + verification — a network-bound
 *       verification path, and
 *   (b) decrypts locally using a decryption key the developer downloads
 *       from their Play Console (per-app, private, not committable), then
 *       verifies the inner signature with Google's signing key rotated on
 *       Google's schedule.
 *
 * Neither path maps onto the pinned-public-JWKS model this file was
 * scaffolded under. The verifier's other steps (nonce re-derivation,
 * package binding, device-integrity floor, structured fail-closed result
 * shape) are sound and reusable once the key-acquisition path is
 * redesigned. The operator pass is:
 *   1. Decide between (a) Google-side decryption or (b) local decryption
 *      + public-key verification. Motebit's sovereignty posture favors
 *      (b), which requires committing the signing-key JWKS (public,
 *      rotation-published) AND wiring the private decryption key via a
 *      secret-management path (keyring, not this file).
 *   2. If (b): capture Google's Play Integrity signing keys from the
 *      Android developer documentation (the URL moves and is versioned
 *      per console; there is no single stable `gstatic` endpoint) and
 *      land them in `GOOGLE_PLAY_INTEGRITY_JWKS` below.
 *   3. Wire the operator decryption key through a secret source before
 *      `verifyPlayIntegrityToken` runs — the current function assumes
 *      it's already handed a decrypted JWT.
 *
 * **Test path works today.** Tests inject a fabricated JWKS via the
 * `pinnedJwks` override, and every verify branch is exercised end-to-end
 * against that injected set. The verifier's structure is stable; only the
 * production key-acquisition layer is missing.
 *
 * Shape matches IETF RFC 7517 JSON Web Key Set. The verifier consumes
 * `kty`, `crv`, `alg`, `kid`, `x`, `y` for ES256 keys and `kty`, `alg`,
 * `kid`, `n`, `e` for RS256 keys.
 */

/**
 * One JSON Web Key as published in the Google JWKS. The verifier
 * dispatches on `alg` and reads only the fields the chosen algorithm
 * needs — forward-compatible with future key additions that carry
 * advisory fields (use, key_ops) by ignoring them.
 */
export interface GoogleJwk {
  readonly kty: "EC" | "RSA";
  readonly alg: "ES256" | "RS256";
  readonly kid: string;
  /** ES256 only — base64url P-256 affine-x coordinate. */
  readonly x?: string;
  /** ES256 only — base64url P-256 affine-y coordinate. */
  readonly y?: string;
  /** ES256 only — curve identifier. Always `"P-256"` for our acceptance set. */
  readonly crv?: "P-256";
  /** RS256 only — base64url RSA modulus. */
  readonly n?: string;
  /** RS256 only — base64url RSA public exponent. */
  readonly e?: string;
}

export interface GoogleJwks {
  readonly keys: readonly GoogleJwk[];
}

/**
 * Pinned acceptance set. Empty array at landing — see the file header
 * for why this is fail-closed until an operator closes the
 * encrypted-token design gap. Tests fabricate their own JWKS via the
 * `pinnedJwks` override so every verify branch exercises end-to-end
 * without a real Google-signed fixture.
 */
export const GOOGLE_PLAY_INTEGRITY_JWKS: GoogleJwks = { keys: [] };
