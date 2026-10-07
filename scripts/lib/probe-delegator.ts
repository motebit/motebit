/**
 * The conformance probe's delegator — a sovereign motebit, built the way a
 * real client builds itself: from ONE seed.
 *
 * Why this exists (2026-09-28, run 36474395502): the probe paid from a wallet
 * derived from `DELEGATOR_SEED_HEX` but authenticated with the relay
 * operator's master token, naming a `DELEGATOR_MOTEBIT_ID` whose key was a
 * DIFFERENT key. The wallet that paid belonged to no identity the relay knew.
 * #955's law — a P2P proof is admissible only from the submitter's
 * identity-derived wallet (`p2p-payer.ts`: identity key = address) — refused
 * it, correctly. The probe passed for months only because nothing checked.
 *
 * A conforming delegator is one key playing every role:
 *
 *   seed ─► Ed25519 identity key ─► Solana wallet (identity key = address)
 *                                ─► motebit_id = deriveSovereignMotebitId(pub)
 *                                    (identity-restore: seed-only re-derives
 *                                    the sovereign id)
 *                                ─► every relay bearer is a short-lived,
 *                                    audience-bound token SIGNED by that key
 *
 * With a signed token the relay reads the payer candidate from the key the
 * token verified under — the same key the wallet derives from — so the
 * payer rule holds by construction, not by configuration. The probe holds no
 * operator credential on the paid path.
 *
 * Crypto is imported from `packages/crypto/src` by RELATIVE path, the same
 * shape `gen-verdict-corpus.ts` / `gen-eval-attestation-corpus.ts` use: the
 * root workspace declares no `@motebit/crypto` dependency, and this is a
 * repo script, never a published consumer.
 */
import {
  bytesToHex,
  deriveSovereignMotebitId,
  getPublicKeyBySuite,
  mintAudienceToken,
  signDeviceRegistration,
} from "../../packages/crypto/src/index.js";
import type { TokenAudience } from "../../packages/protocol/src/index.js";

/** The cryptosuite of a motebit identity key (Ed25519, hex-encoded). */
const IDENTITY_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

export interface ProbeDelegator {
  /** The sovereign id — the commitment to this seed's genesis key. */
  motebitId: string;
  /** Stable per identity, so `bootstrap` is idempotent across daily runs. */
  deviceId: string;
  /** The Ed25519 identity public key (also the Solana wallet's key). */
  publicKey: Uint8Array;
  /** Lowercase hex — the relay's canonical key spelling. */
  publicKeyHex: string;
  /** The 32-byte seed IS the Ed25519 private key. Never printed. */
  privateKey: Uint8Array;
}

/** Parse a 32-byte hex seed (optional `0x`), refusing anything else. */
export function parseSeedHex(seedHex: string): Uint8Array {
  const hex = seedHex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Say what is wrong, never echo the value — it is a secret.
    throw new Error(
      `DELEGATOR_SEED_HEX must be 32 bytes of hex (64 hex chars); got ${hex.length} chars`,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The whole delegator identity, derived from the seed alone. */
export async function deriveProbeDelegator(seedHex: string): Promise<ProbeDelegator> {
  const privateKey = parseSeedHex(seedHex);
  const publicKey = await getPublicKeyBySuite(privateKey, IDENTITY_SUITE);
  const publicKeyHex = bytesToHex(publicKey).toLowerCase();
  const motebitId = await deriveSovereignMotebitId(publicKeyHex);
  return {
    motebitId,
    deviceId: `${motebitId}-conformance-probe`,
    publicKey,
    publicKeyHex,
    privateKey,
  };
}

/**
 * A `DELEGATOR_MOTEBIT_ID` that disagrees with the seed is exactly the
 * non-conformance that went red: an identity asserted separately from the
 * key that pays. The seed wins (it is the only thing that can sign); the
 * mismatch is reported so the stale setting can be removed. Null when there
 * is nothing to report.
 */
export function declaredIdMismatch(
  declared: string | undefined,
  derived: ProbeDelegator,
): string | null {
  const d = declared?.trim();
  if (d == null || d === "" || d === derived.motebitId) return null;
  return (
    `DELEGATOR_MOTEBIT_ID (${d.slice(0, 13)}…) is not the identity DELEGATOR_SEED_HEX derives ` +
    `(${derived.motebitId}). The probe delegates as the seed's own sovereign identity; ` +
    `remove the DELEGATOR_MOTEBIT_ID setting (the PROBE_DELEGATOR_ID secret) — it is no longer read.`
  );
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Introduce the identity to the relay through the public, rate-limited
 * `POST /api/v1/agents/bootstrap` — the door every fresh sovereign client and
 * every worker (`@motebit/mcp-server` `startServiceServer`) uses before its
 * first signed call. Idempotent on (id, key): 201 the first time, 200 after.
 * A 409 means this id is bound to a different key on this relay, which a
 * seed-derived sovereign id makes a hijack attempt, not a config slip — it
 * throws with the relay's own words.
 */
export async function bootstrapProbeDelegator(
  relayUrl: string,
  d: ProbeDelegator,
  fetchImpl: FetchLike = fetch,
): Promise<{ registered: boolean }> {
  const res = await fetchImpl(`${relayUrl}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Signed by the key it introduces: the relay refuses an unsigned
    // bootstrap (#875 — proof of possession).
    body: JSON.stringify(
      await signDeviceRegistration(
        {
          motebit_id: d.motebitId,
          device_id: d.deviceId,
          public_key: d.publicKeyHex,
          timestamp: Date.now(),
        },
        d.privateKey,
      ),
    ),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `delegator bootstrap refused (${res.status}) for ${d.motebitId}: ${text.slice(0, 300)}` +
        (res.status === 409 ? " — this sovereign id is bound to a different key on the relay" : ""),
    );
  }
  const body = (await res.json().catch(() => ({}))) as { registered?: boolean };
  return { registered: body.registered === true };
}

/**
 * The `authToken` a delegation client takes: a fresh, short-lived bearer per
 * call, bound to the audience the call names and signed by the identity key.
 * Mints through `mintAudienceToken` (the one canonical minter,
 * `check-token-mint-canonical`), as the CLI's `getRelayAuthHeaders` does.
 */
export function probeTokenMinter(d: ProbeDelegator): (audience?: TokenAudience) => Promise<string> {
  return async (audience?: TokenAudience) => {
    const { token } = await mintAudienceToken(
      { mid: d.motebitId, did: d.deviceId, aud: audience ?? "task:submit" },
      d.privateKey,
    );
    return token;
  };
}
