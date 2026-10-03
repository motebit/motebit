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
