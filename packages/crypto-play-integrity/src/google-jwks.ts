/**
 * Pinned Google Play Integrity JWKS.
 *
 * This constant is the root of trust for every `platform: "play_integrity"`
 * hardware-attestation claim. Pinning is the self-attesting contract — a
 * verifier that dynamically fetched Google's JWKS would have no sovereign
 * story, because a third party auditing our output could never reproduce
 * the decision without trusting our fetch path. By committing the exact
 * keys we accept, anyone can audit this file, pin the same keys in their
 * own verifier, and reach the same yes/no answer.
 *
 * Upstream fetch URL (for operators reviewing or advancing the pinned
 * set): https://www.gstatic.com/play-integrity/jwks
 *
 * Rotation caveats: Google rotates signing keys on a published cadence
 * (kid values change, new JWKs added, old JWKs retired). When a rotation
 * lands upstream, the operator pass is:
 *   1. Fetch the new JWKS from the gstatic URL above.
 *   2. Diff against `GOOGLE_PLAY_INTEGRITY_JWKS` here.
 *   3. Land the additive entries as a named commit (preserving the old
 *      entries during the rotation window so in-flight receipts still
 *      verify).
 *   4. Once upstream retires the old kid, land the subtractive commit.
 * This is a judgment call — it belongs in BSL with the rest of the
 * chain-validation policy.
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
 * Pinned acceptance set. Empty array at landing — the first real pin
 * lands the moment a human operator runs the rotation procedure above
 * against production receipts. Tests fabricate their own JWKS (via the
 * `pinnedJwks` override on `verifyPlayIntegrityToken`) so every verify
 * branch is exercised without a real Google-signed fixture.
 *
 * Leaving the production pin empty keeps the verifier fail-closed by
 * default — a caller that forgets to pass a `pinnedJwks` override lands
 * with zero accepted keys, and every real token is rejected with a
 * descriptive `kid not found in pinned JWKS` error. That is the right
 * default: no silent acceptance of a key the operator has never audited.
 */
export const GOOGLE_PLAY_INTEGRITY_JWKS: GoogleJwks = { keys: [] };

/** Wire format identifier for the Play Integrity JWT acceptance set. */
export const GOOGLE_PLAY_INTEGRITY_JWKS_URL = "https://www.gstatic.com/play-integrity/jwks";
