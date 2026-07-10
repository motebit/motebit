/**
 * Integration proof for the Clerk money seam: a self-issued grant + a minted
 * per-tick token must actually VERIFY through the real `verifyGrantForTurn`
 * (the sole verifiedGrant producer). The run-molecule seam test stubs the
 * runtime, so this is the ONLY place the real crypto path is exercised — if
 * `selfIssueGrant`/`mintTick` produced an artifact that failed verification,
 * the Clerk would silently refuse EVERY spend with `requires_verified_grant`.
 *
 * Uses REAL keypairs (a zero key would fail the signature check), so this is a
 * genuine end-to-end crypto assertion, not a shape check.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { verifyGrantForTurn } from "@motebit/runtime";
import { selfIssueGrant, mintTick, makeAuthTokenMinter } from "../index.js";
import type { BootstrapAndEmitIdentityResult } from "@motebit/mcp-server";

async function realIdentity(): Promise<BootstrapAndEmitIdentityResult> {
  const kp = await generateKeypair();
  return {
    motebitId: "mot_clerk_selfgrant",
    deviceId: "dev_clerk",
    publicKeyHex: bytesToHex(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    identityContent: "# motebit.md\n",
    identityPath: "/data/motebit.md",
    isFirstLaunch: true,
  };
}

const MONEY = {
  solanaRpcUrl: "https://rpc.test",
  relayPublicKeyHex: "07".repeat(32),
  spendCeiling: { schema: "motebit.spend-ceiling.v1" as const, lifetime_limit_micro: 1_000_000 },
};

describe("self-grant verifies end-to-end through verifyGrantForTurn", () => {
  it("a self-issued grant + minted tick VERIFIES (not null) and carries the ceiling", async () => {
    const identity = await realIdentity();
    const grant = await selfIssueGrant(identity, MONEY);
    const token = await mintTick(grant, identity);

    const verified = await verifyGrantForTurn(token, grant, []);
    expect(verified).not.toBeNull();
    expect(verified!.grant_id).toBe(grant.grant_id);
    // The signed ceiling rides through — else the meter denies `ceiling_absent`.
    expect(verified!.spend_ceiling?.lifetime_limit_micro).toBe(1_000_000);
    // The tick's issued_at is the meter's replay nonce.
    expect(verified!.token_issued_at).toBe(token.issued_at);
  });

  it("is a SELF-grant (delegator == delegate) so the holder can self-mint ticks", async () => {
    const identity = await realIdentity();
    const grant = await selfIssueGrant(identity, MONEY);
    expect(grant.delegator_public_key).toBe(grant.delegate_public_key);
    expect(grant.delegator_public_key).toBe(identity.publicKeyHex);
    expect(grant.scope).toBe("delegate_to_agent");
  });

  it("honors an explicit grantTtlMs (the grant expires when configured)", async () => {
    const identity = await realIdentity();
    const grant = await selfIssueGrant(identity, { ...MONEY, grantTtlMs: 5 * 60_000 });
    // expires_at ≈ issued_at + 5min (not the 90-day default).
    expect(grant.expires_at - grant.issued_at).toBe(5 * 60_000);
    // Still verifies within its window.
    const token = await mintTick(grant, identity);
    expect(await verifyGrantForTurn(token, grant, [])).not.toBeNull();
  });

  it("makeAuthTokenMinter mints an audience-scoped device-signed token (default + explicit)", async () => {
    const identity = await realIdentity();
    const mint = makeAuthTokenMinter(identity);
    const dflt = await mint(); // default audience "task:submit"
    const explicit = await mint("market:listing");
    expect(typeof dflt).toBe("string");
    expect(dflt.length).toBeGreaterThan(0);
    expect(explicit).not.toBe(dflt);
  });

  it("two ticks carry DISTINCT nonces (no meter replay across spends)", async () => {
    const identity = await realIdentity();
    const grant = await selfIssueGrant(identity, MONEY);
    const t0 = await mintTick(grant, identity);
    await new Promise((r) => setTimeout(r, 2));
    const t1 = await mintTick(grant, identity);
    expect(t0.issued_at).not.toBe(t1.issued_at);
    // Both still verify.
    expect(await verifyGrantForTurn(t0, grant, [])).not.toBeNull();
    expect(await verifyGrantForTurn(t1, grant, [])).not.toBeNull();
  });
});
