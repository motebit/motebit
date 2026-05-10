/**
 * Token audience constants — `aud` claim values for the audience-bound
 * signed-token primitive (`SignedTokenPayload`).
 *
 * Audience binding (per `docs/doctrine/security-boundaries.md` and
 * `services/relay/CLAUDE.md` Rule 5) prevents cross-endpoint replay:
 * a token minted for one purpose cannot be reused for another. Every
 * signed bearer in motebit carries `aud`; verifiers reject a missing
 * or unexpected value fail-closed.
 *
 * Two new audiences ship here for the relay-mediated browser-sandbox
 * dispatcher token flow (replaces the v1 shared-bearer model):
 *
 *   - `BROWSER_SANDBOX_GRANT_AUDIENCE` — the token a motebit signs with
 *     its OWN identity key and presents to the relay's
 *     `POST /api/v1/browser-sandbox/token` endpoint to obtain a
 *     short-lived sandbox token.
 *
 *   - `BROWSER_SANDBOX_AUDIENCE` — the token the RELAY mints (signed
 *     with the relay's identity key) and returns to the motebit. The
 *     motebit attaches it as the `Authorization: Bearer …` header on
 *     every browser-sandbox request. Browser-sandbox verifies the
 *     signature against a pinned relay public key (env var) and
 *     extracts `mid` from the payload for audit attribution.
 *
 * Single trust anchor (the pinned relay pubkey) means browser-sandbox
 * never needs to know any motebit's identity directly — it trusts the
 * relay to vouch via the `mid` claim. Same broker/agent shape as the
 * actor principle: relay is the broker, the receipt-shape is the
 * causal log.
 *
 * The other canonical audiences (`sync`, `task:submit`, `admin:query`,
 * `rotate-key`, `pair`, `register-device`) currently live as string
 * literals at their consumer sites; promoting them to typed constants
 * here is a follow-up that doesn't block the browser-sandbox migration.
 */

/**
 * Audience for the motebit-signed grant request to the relay.
 * Verified by the relay via `verifySignedTokenForDevice` with this
 * value as `expectedAudience`.
 */
export const BROWSER_SANDBOX_GRANT_AUDIENCE = "browser-sandbox-grant" as const;

/**
 * Audience for the relay-signed sandbox token. Verified by
 * `services/browser-sandbox` against the pinned relay public key.
 */
export const BROWSER_SANDBOX_AUDIENCE = "browser-sandbox" as const;
