/**
 * The two identity checks every surface shares (one helper each, never five
 * copies):
 *
 *  - `identityVerifyOutcome` — an identity file is intact only when its
 *    signature AND its succession chain verify. A file re-signed by a key the
 *    chain does not legitimately reach is not intact, however valid its
 *    signature.
 *  - `verifyPairingIdentityBinding` — the motebit_id a relay hands a pairing
 *    device must not contradict the identity key the pairing transferred.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  identityVerifyOutcome,
  verifyPairingIdentityBinding,
  signKeySuccession,
  type IdentityVerifyResult,
} from "../index.js";

function identityResult(over: Partial<IdentityVerifyResult>): IdentityVerifyResult {
  return {
    type: "identity",
    valid: true,
    identity: { motebit_id: "m" } as IdentityVerifyResult["identity"],
    ...over,
  };
}

describe("identityVerifyOutcome", () => {
  it("valid signature and no succession chain → intact", () => {
    expect(identityVerifyOutcome(identityResult({}))).toEqual({ valid: true });
  });

  it("valid signature and a valid succession chain → intact", () => {
    const r = identityResult({ succession: { valid: true, rotations: 1 } });
    expect(identityVerifyOutcome(r)).toEqual({ valid: true });
  });

  it("valid signature but an INVALID succession chain → not intact, with the chain's reason", () => {
    const r = identityResult({
      succession: { valid: false, rotations: 1, error: "Succession record 0: bad signature" },
    });
    const out = identityVerifyOutcome(r);
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/succession/i);
    expect(out.error).toContain("Succession record 0: bad signature");
  });

  it("invalid signature → not intact, first error passed through", () => {
    const r = identityResult({ valid: false, identity: null, errors: [{ message: "bad sig" }] });
    expect(identityVerifyOutcome(r)).toEqual({ valid: false, error: "bad sig" });
  });

  it("a non-identity result is never intact", () => {
    const out = identityVerifyOutcome({ type: "unknown", valid: false } as never);
    expect(out.valid).toBe(false);
  });
});

describe("verifyPairingIdentityBinding", () => {
  it("accepts an id that is the self-certifying commitment to the transferred key", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const id = await deriveSovereignMotebitId(key);
    const r = await verifyPairingIdentityBinding(id, key);
    expect(r).toEqual({ accepted: true, identityBinding: "sovereign" });
  });

  it("refuses a self-certifying id that commits to a DIFFERENT key (relay-supplied mismatch)", async () => {
    const transferred = bytesToHex((await generateKeypair()).publicKey);
    const other = bytesToHex((await generateKeypair()).publicKey);
    const wrongId = await deriveSovereignMotebitId(other);
    const r = await verifyPairingIdentityBinding(wrongId, transferred);
    expect(r.accepted).toBe(false);
    expect(r.identityBinding).toBe("invalid");
    expect(r.reason).toMatch(/does not bind/);
  });

  it("refuses a did:key id naming a different key", async () => {
    const transferred = bytesToHex((await generateKeypair()).publicKey);
    // did:key for an all-zero key — never the transferred key.
    const r = await verifyPairingIdentityBinding(
      "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd",
      transferred,
    );
    expect(r.accepted).toBe(false);
  });

  it("accepts a legacy (UUIDv7) id at the unverified rung — it commits to no key", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyPairingIdentityBinding("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", key);
    expect(r).toEqual({ accepted: true, identityBinding: "unverified" });
  });

  it("is case-insensitive on the id", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const id = (await deriveSovereignMotebitId(key)).toUpperCase();
    expect((await verifyPairingIdentityBinding(id, key)).accepted).toBe(true);
  });
});

describe("verifyPairingIdentityBinding — a ROTATED sovereign identity (succession chain)", () => {
  async function rotatedIdentity() {
    const genesis = await generateKeypair();
    const next = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const record = await signKeySuccession(
      genesis.privateKey,
      next.privateKey,
      next.publicKey,
      genesis.publicKey,
      "routine",
    );
    return { id, current: bytesToHex(next.publicKey), chain: [record], genesis, next };
  }

  it("without the chain, the rotated current key fails closed", async () => {
    const { id, current } = await rotatedIdentity();
    const r = await verifyPairingIdentityBinding(id, current);
    expect(r.accepted).toBe(false);
    expect(r.identityBinding).toBe("invalid");
  });

  it("accepts the rotated current key at `sovereign` when a valid chain links the id's genesis to it", async () => {
    const { id, current, chain } = await rotatedIdentity();
    const r = await verifyPairingIdentityBinding(id, current, { successionChain: chain });
    expect(r).toEqual({ accepted: true, identityBinding: "sovereign" });
  });

  it("accepts with a lazily-fetched chain, and fetches only when the direct derivation fails", async () => {
    const { id, current, chain, genesis } = await rotatedIdentity();
    let fetches = 0;
    const loader = async () => {
      fetches++;
      return chain;
    };
    expect(await verifyPairingIdentityBinding(id, current, { successionChain: loader })).toEqual({
      accepted: true,
      identityBinding: "sovereign",
    });
    expect(fetches).toBe(1);
    // Never-rotated key: direct derivation answers; the loader is not consulted.
    const genesisHex = bytesToHex(genesis.publicKey);
    await verifyPairingIdentityBinding(id, genesisHex, { successionChain: loader });
    expect(fetches).toBe(1);
  });

  it("refuses a forged chain (bad signature)", async () => {
    const { id, current, chain } = await rotatedIdentity();
    const forged = [{ ...chain[0]!, old_key_signature: "00".repeat(64) }];
    const r = await verifyPairingIdentityBinding(id, current, { successionChain: forged });
    expect(r.accepted).toBe(false);
    expect(r.identityBinding).toBe("invalid");
  });

  it("refuses a valid chain rooted at a genesis the id does NOT commit to (relay-forged lineage)", async () => {
    const { current } = await rotatedIdentity();
    // Attacker builds a genuine chain from their own genesis to the transferred key? They
    // cannot sign as the transferred key — but a chain from an unrelated genesis to an
    // unrelated key is internally valid; it must not bind to the victim id.
    const victim = await rotatedIdentity();
    const r = await verifyPairingIdentityBinding(victim.id, current, {
      successionChain: victim.chain,
    });
    expect(r.accepted).toBe(false);
  });

  it("refuses a valid chain for the id that ends at a DIFFERENT key than the one transferred", async () => {
    const { id, chain } = await rotatedIdentity();
    const unrelated = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyPairingIdentityBinding(id, unrelated, { successionChain: chain });
    expect(r.accepted).toBe(false);
  });

  it("refuses an unrelated key whatever the chain, and a withheld/failed fetch refuses", async () => {
    const { id, current } = await rotatedIdentity();
    expect(
      (await verifyPairingIdentityBinding(id, current, { successionChain: [] })).accepted,
    ).toBe(false);
    const failing = async (): Promise<never> => {
      throw new Error("relay down");
    };
    const r = await verifyPairingIdentityBinding(id, current, { successionChain: failing });
    expect(r.accepted).toBe(false);
    expect(r.identityBinding).toBe("invalid");
  });

  it("a legacy (UUIDv7) id stays `unverified` and never consults the chain", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    let fetched = false;
    const r = await verifyPairingIdentityBinding("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", key, {
      successionChain: async () => {
        fetched = true;
        return [];
      },
    });
    expect(r).toEqual({ accepted: true, identityBinding: "unverified" });
    expect(fetched).toBe(false);
  });
});
