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
import { describe, it, expect, vi } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  identityVerifyOutcome,
  verifyPairingIdentityBinding,
  signKeySuccession,
  signGuardianRecoverySuccession,
  hexPublicKeyToDidKey,
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
    expect(r).toEqual({ accepted: true, identityBinding: "sovereign", relayCheck: "not_checked" });
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
    expect(r).toEqual({ accepted: true, identityBinding: "unverified", relayCheck: "not_checked" });
  });

  it("refuses a non-canonical spelling of an id that would otherwise bind (uppercase)", async () => {
    // The device would persist a spelling no relay or peer names it by.
    const key = bytesToHex((await generateKeypair()).publicKey);
    const id = (await deriveSovereignMotebitId(key)).toUpperCase();
    const r = await verifyPairingIdentityBinding(id, key);
    expect(r.accepted).toBe(false);
    expect(r.code).toBe("malformed_id");
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
    const r = await verifyPairingIdentityBinding(id, current, { successionSources: [chain] });
    expect(r).toEqual({ accepted: true, identityBinding: "sovereign", relayCheck: "not_checked" });
  });

  it("accepts with a lazily-fetched chain, and fetches only when the direct derivation fails", async () => {
    const { id, current, chain, genesis } = await rotatedIdentity();
    let fetches = 0;
    const loader = async () => {
      fetches++;
      return chain;
    };
    expect(
      await verifyPairingIdentityBinding(id, current, { successionSources: [loader] }),
    ).toEqual({
      accepted: true,
      identityBinding: "sovereign",
      relayCheck: "not_checked",
    });
    expect(fetches).toBe(1);
    // Never-rotated key: direct derivation answers; the loader is not consulted.
    const genesisHex = bytesToHex(genesis.publicKey);
    await verifyPairingIdentityBinding(id, genesisHex, { successionSources: [loader] });
    expect(fetches).toBe(1);
  });

  it("refuses a forged chain (bad signature)", async () => {
    const { id, current, chain } = await rotatedIdentity();
    const forged = [{ ...chain[0]!, old_key_signature: "00".repeat(64) }];
    const r = await verifyPairingIdentityBinding(id, current, { successionSources: [forged] });
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
      successionSources: [victim.chain],
    });
    expect(r.accepted).toBe(false);
  });

  it("refuses a valid chain for the id that ends at a DIFFERENT key than the one transferred", async () => {
    const { id, chain } = await rotatedIdentity();
    const unrelated = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyPairingIdentityBinding(id, unrelated, { successionSources: [chain] });
    expect(r.accepted).toBe(false);
  });

  it("refuses an unrelated key whatever the chain, and a withheld/failed fetch refuses", async () => {
    const { id, current } = await rotatedIdentity();
    expect(
      (await verifyPairingIdentityBinding(id, current, { successionSources: [[]] })).accepted,
    ).toBe(false);
    const failing = async (): Promise<never> => {
      throw new Error("relay down");
    };
    const r = await verifyPairingIdentityBinding(id, current, { successionSources: [failing] });
    expect(r.accepted).toBe(false);
    expect(r.identityBinding).toBe("invalid");
  });

  it("a legacy (UUIDv7) id stays `unverified` and never consults the chain", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    let fetched = false;
    const r = await verifyPairingIdentityBinding("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", key, {
      successionSources: [
        async () => {
          fetched = true;
          return [];
        },
      ],
    });
    expect(r).toEqual({ accepted: true, identityBinding: "unverified", relayCheck: "not_checked" });
    expect(fetched).toBe(false);
  });
});

describe("verifyPairingIdentityBinding — canonical ids, sources, guardian", () => {
  it.each([
    ["empty", (_id: string) => ""],
    ["urn:uuid: prefix", (id: string) => `urn:uuid:${id}`],
    ["trailing space", (id: string) => `${id} `],
    ["braced", (id: string) => `{${id}}`],
    ["hyphenless", (id: string) => id.replace(/-/g, "")],
  ])("refuses a non-canonical id (%s) with malformed_id", async (_label, mangle) => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyPairingIdentityBinding(mangle(await deriveSovereignMotebitId(key)), key);
    expect(r).toMatchObject({ accepted: false, identityBinding: "invalid", code: "malformed_id" });
  });

  it("refuses an uppercase DID:key prefix, accepts the canonical did:key that binds", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const did = hexPublicKeyToDidKey(key);
    expect(
      (await verifyPairingIdentityBinding(did.replace("did:key:", "DID:key:"), key)).code,
    ).toBe("malformed_id");
    expect(await verifyPairingIdentityBinding(did, key)).toEqual({
      accepted: true,
      identityBinding: "sovereign",
      relayCheck: "not_checked",
    });
  });

  it("accepts a canonical UUIDv4 (seed-only restore 2026-05-15..22) at `unverified`, like a v7", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    let asked = false;
    const r = await verifyPairingIdentityBinding("3f1c2a9e-5b7d-4e21-9c0a-6d8e2f4b1a37", key, {
      relaySuccession: async () => {
        asked = true;
        return [];
      },
    });
    expect(r).toEqual({ accepted: true, identityBinding: "unverified", relayCheck: "not_checked" });
    expect(asked).toBe(false);
  });

  it("refuses free text and non-canonical UUIDv4 / unminted UUID versions", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    for (const id of [
      "agent-alice",
      "3F1C2A9E-5B7D-4E21-9C0A-6D8E2F4B1A37",
      "3f1c2a9e5b7d4e219c0a6d8e2f4b1a37",
      "3f1c2a9e-5b7d-4e21-cc0a-6d8e2f4b1a37",
      "3f1c2a9e-5b7d-1e21-9c0a-6d8e2f4b1a37",
    ]) {
      expect((await verifyPairingIdentityBinding(id, key)).code).toBe("malformed_id");
    }
  });

  it("refuses a malformed transferred key", async () => {
    const r = await verifyPairingIdentityBinding("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", "zz");
    expect(r.code).toBe("malformed_key");
  });

  it("tries sources in order: a later source is consulted only when the earlier ones do not bind", async () => {
    const g = await generateKeypair();
    const k = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(g.publicKey));
    const rec = await signKeySuccession(g.privateKey, k.privateKey, k.publicKey, g.publicKey);
    let relayAsked = 0;
    const relay = async () => {
      relayAsked++;
      return [rec];
    };
    const viaTransfer = await verifyPairingIdentityBinding(id, bytesToHex(k.publicKey), {
      successionSources: [[rec], relay],
    });
    expect(viaTransfer.identityBinding).toBe("sovereign");
    expect(relayAsked).toBe(0);
    const viaRelay = await verifyPairingIdentityBinding(id, bytesToHex(k.publicKey), {
      successionSources: [[], relay],
    });
    expect(viaRelay.identityBinding).toBe("sovereign");
    expect(relayAsked).toBe(1);
  });

  it("joins sources: a chain split across the transfer and the relay still binds", async () => {
    const g = await generateKeypair();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(g.publicKey));
    const r1 = await signKeySuccession(g.privateKey, k1.privateKey, k1.publicKey, g.publicKey);
    await new Promise((r) => setTimeout(r, 2));
    const r2 = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const r = await verifyPairingIdentityBinding(id, bytesToHex(k2.publicKey), {
      successionSources: [[r2], async () => [r1]],
    });
    expect(r.identityBinding).toBe("sovereign");
  });

  it("a guardian-recovered identity: refused with an explicit reason unless the guardian key is pinned", async () => {
    const g = await generateKeypair();
    const k = await generateKeypair();
    const guardian = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(g.publicKey));
    const rec = await signGuardianRecoverySuccession(
      guardian.privateKey,
      k.privateKey,
      g.publicKey,
      k.publicKey,
    );
    const held = bytesToHex(k.publicKey);
    const refused = await verifyPairingIdentityBinding(id, held, { successionSources: [[rec]] });
    expect(refused).toMatchObject({ accepted: false, code: "guardian_recovery_unverifiable" });
    expect(refused.reason).toMatch(/guardian.*motebit\.md/);
    const pinned = await verifyPairingIdentityBinding(id, held, {
      successionSources: [[rec]],
      guardianKey: bytesToHex(guardian.publicKey),
    });
    expect(pinned).toEqual({
      accepted: true,
      identityBinding: "sovereign",
      relayCheck: "not_checked",
    });
  });

  it("a chain out of temporal order is not a lineage", async () => {
    const g = await generateKeypair();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(g.publicKey));
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(2_000_000_000_000);
      const r1 = await signKeySuccession(g.privateKey, k1.privateKey, k1.publicKey, g.publicKey);
      now.mockReturnValue(1_000_000_000_000); // the second link predates the first
      const r2 = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
      const r = await verifyPairingIdentityBinding(id, bytesToHex(k2.publicKey), {
        successionSources: [[r1, r2]],
      });
      expect(r).toMatchObject({ accepted: false, code: "no_verified_lineage" });
    } finally {
      now.mockRestore();
    }
  });

  it("bounds what one source may make it verify", async () => {
    const g = await generateKeypair();
    const k = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(g.publicKey));
    const rec = await signKeySuccession(g.privateKey, k.privateKey, k.publicKey, g.publicKey);
    const junk = Array.from({ length: 10_000 }, () => ({ junk: true }));
    // The real link sits past the bound: the source's tail is never read.
    const r = await verifyPairingIdentityBinding(id, bytesToHex(k.publicKey), {
      successionSources: [[...junk, rec]],
    });
    expect(r.accepted).toBe(false);
  });
});

describe("verifyPairingIdentityBinding — the relay's chain is always the fork check", () => {
  async function history() {
    const k0 = await generateKeypair();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(2_000_000_000_000);
      const r1 = await signKeySuccession(k0.privateKey, k1.privateKey, k1.publicKey, k0.publicKey);
      now.mockReturnValue(2_000_000_001_000);
      const r2 = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
      return { k0, k1, k2, r1, r2, id: await deriveSovereignMotebitId(bytesToHex(k0.publicKey)) };
    } finally {
      now.mockRestore();
    }
  }

  it("a key the relay's verified chain supersedes → identity_fork", async () => {
    const h = await history();
    const r = await verifyPairingIdentityBinding(h.id, bytesToHex(h.k1.publicKey), {
      successionSources: [[h.r1]],
      relaySuccession: async () => [h.r1, h.r2],
    });
    expect(r).toMatchObject({ accepted: false, code: "identity_fork" });
    expect(r.reason).toMatch(/^identity fork detected/);
  });

  it("a second successor of a lineage key → identity_fork", async () => {
    const h = await history();
    const kx = await generateKeypair();
    const fork = await signKeySuccession(
      h.k0.privateKey,
      kx.privateKey,
      kx.publicKey,
      h.k0.publicKey,
    );
    const r = await verifyPairingIdentityBinding(h.id, bytesToHex(kx.publicKey), {
      successionSources: [[fork]],
      relaySuccession: async () => [h.r1],
    });
    expect(r.code).toBe("identity_fork");
  });

  it("relay chain equal to / a prefix of the lineage → no_conflict; unreachable → reported", async () => {
    const h = await history();
    const held = bytesToHex(h.k2.publicKey);
    for (const served of [[h.r1, h.r2], [h.r1], []]) {
      const r = await verifyPairingIdentityBinding(h.id, held, {
        successionSources: [[h.r1, h.r2]],
        relaySuccession: async () => served,
      });
      expect(r).toEqual({
        accepted: true,
        identityBinding: "sovereign",
        relayCheck: "no_conflict",
      });
    }
    const down = await verifyPairingIdentityBinding(h.id, held, {
      successionSources: [[h.r1, h.r2]],
      relaySuccession: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down).toEqual({
      accepted: true,
      identityBinding: "sovereign",
      relayCheck: "unreachable",
    });
  });

  it("the relay is fetched once: the fallback source and the fork check share it", async () => {
    const h = await history();
    let fetches = 0;
    const r = await verifyPairingIdentityBinding(h.id, bytesToHex(h.k2.publicKey), {
      relaySuccession: async () => {
        fetches++;
        return [h.r1, h.r2];
      },
    });
    expect(r.relayCheck).toBe("no_conflict");
    expect(fetches).toBe(1);
  });
});
