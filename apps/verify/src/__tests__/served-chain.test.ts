/**
 * The page's own check of a relay-served identity chain (`served-chain.ts`):
 * time-windowed, with no guardian named inside the served file honoured, and a
 * self-certifying id required to root at the key it commits to.
 */
import { describe, it, expect } from "vitest";
import { verifyKeyBindingAtTime, type MotebitIdentityFile } from "@motebit/crypto";
import {
  checkServedChain,
  chainReason,
  idCommitsToKey,
  classifyId,
  isSelfCertifyingId,
} from "../served-chain.js";
import G1 from "./fixtures/G1-genesis-current-chain-served.json?raw";
import G1_CTX from "./fixtures/G1-genesis-current-chain-served.ctx.json?raw";
import G2 from "./fixtures/G2-historical-before-rotation-chain-served.json?raw";
import G2_CTX from "./fixtures/G2-historical-before-rotation-chain-served.ctx.json?raw";
import G3 from "./fixtures/G3-rotated-key-chain-served.json?raw";
import G3_CTX from "./fixtures/G3-rotated-key-chain-served.ctx.json?raw";
import D4A from "./fixtures/D4a-retired-genesis-after-rotation.json?raw";
import D4A_CTX from "./fixtures/D4a-retired-genesis-after-rotation.ctx.json?raw";
import D5 from "./fixtures/D5-pinned.json?raw";
import D5_CTX from "./fixtures/D5-pinned.ctx.json?raw";
import FG from "./fixtures/FG-forged-guardian-recovery.json?raw";
import FG_CTX from "./fixtures/FG-forged-guardian-recovery.ctx.json?raw";
import FGL from "./fixtures/FGL-forged-guardian-recovery-legacy.json?raw";
import FGL_CTX from "./fixtures/FGL-forged-guardian-recovery-legacy.ctx.json?raw";
import FS from "./fixtures/FS-served-genesis-not-id-commitment.json?raw";
import FS_CTX from "./fixtures/FS-served-genesis-not-id-commitment.ctx.json?raw";

interface Bundle {
  motebit_id: string;
  created_at: string;
  current_public_key: string;
  guardian_public_key?: string;
  succession: MotebitIdentityFile["succession"];
}
interface Receipt {
  motebit_id: string;
  public_key: string;
  completed_at: number;
}

/** The same reconstruction relay-binding.ts does: binding-relevant fields only. */
function identityOf(ctx: string): MotebitIdentityFile {
  const b = (JSON.parse(ctx) as { bundle: Bundle }).bundle;
  return {
    spec: "motebit/identity@1.0",
    motebit_id: b.motebit_id,
    created_at: b.created_at,
    owner_id: "",
    identity: { algorithm: "Ed25519", public_key: b.current_public_key },
    ...(b.guardian_public_key
      ? { guardian: { public_key: b.guardian_public_key, established_at: b.created_at } }
      : {}),
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession: b.succession,
  } as MotebitIdentityFile;
}
const r = (text: string): Receipt => JSON.parse(text) as Receipt;

describe("checkServedChain", () => {
  it("binds the key at the receipt's time: genesis, historical, rotated-to", async () => {
    for (const [rec, ctx] of [
      [G1, G1_CTX],
      [G2, G2_CTX],
      [G3, G3_CTX],
    ] as const) {
      expect(await checkServedChain(r(rec), identityOf(ctx))).toEqual({
        kind: "bound",
        root: "id-commitment",
      });
    }
  });

  it("a legacy id binds with the relay's record as the root", async () => {
    expect(await checkServedChain(r(D5), identityOf(D5_CTX))).toEqual({
      kind: "bound",
      root: "relay-record",
    });
  });

  it("a retired key signing after its rotation is not active", async () => {
    expect(await checkServedChain(r(D4A), identityOf(D4A_CTX))).toEqual({ kind: "not_active" });
  });

  it("a guardian named only inside the served file never binds — and the library agrees", async () => {
    for (const [rec, ctx] of [
      [FG, FG_CTX],
      [FGL, FGL_CTX],
    ] as const) {
      const id = identityOf(ctx);
      // The library no longer honours a guardian named only by the file it is
      // verifying (@motebit/crypto: a file-named guardian is never a trust root),
      // so the hazard this module was built against is closed at the source too.
      const lib = await verifyKeyBindingAtTime(id, r(rec).public_key, r(rec).completed_at);
      expect(lib.bound).toBe(false);
      expect(lib.guardianAuthority).toBe("not_established");
      expect(await checkServedChain(r(rec), id)).toEqual({ kind: "recovery_unverifiable" });
    }
  });

  it("a self-certifying id whose served chain roots elsewhere does not bind", async () => {
    expect(await checkServedChain(r(FS), identityOf(FS_CTX))).toEqual({ kind: "root_mismatch" });
  });

  it("another motebit's record, a key outside the chain, and unusable input fail closed", async () => {
    const other = { ...r(D5), motebit_id: "019dc500-0000-7abc-8000-0000000000aa" };
    expect(await checkServedChain(other, identityOf(D5_CTX))).toEqual({ kind: "other_motebit" });
    expect(await checkServedChain(r(FS), identityOf(G1_CTX))).toEqual({ kind: "not_in_chain" });
    const bad = await checkServedChain({ motebit_id: "x" }, identityOf(D5_CTX));
    expect(bad.kind).toBe("invalid");
  });

  it("self-certifying ids and key commitments", async () => {
    expect(isSelfCertifyingId(r(G1).motebit_id)).toBe(true);
    expect(isSelfCertifyingId("did:key:z6Mk")).toBe(true);
    expect(isSelfCertifyingId(r(D5).motebit_id)).toBe(false);
    expect(await idCommitsToKey(r(G1).motebit_id, r(G1).public_key)).toBe(true);
    expect(await idCommitsToKey(r(G3).motebit_id, r(G3).public_key)).toBe(false);
    expect(await idCommitsToKey(undefined, r(G1).public_key)).toBe(false);
  });

  it("only an exactly canonical id is classified as one; every other form is noncanonical", async () => {
    const v8 = r(G1).motebit_id;
    const legacy = r(D5).motebit_id;
    expect(classifyId(v8)).toBe("uuidv8");
    expect(classifyId(legacy)).toBe("legacy-uuid");
    expect(classifyId("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBe("legacy-uuid");
    expect(classifyId("did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7")).toBe("did:key");
    for (const id of [
      `${v8}\u200b`,
      ` ${v8}`,
      `${v8} `,
      v8.toUpperCase(),
      v8.replace("a", "\u0430"),
      `\u202e${legacy}`,
      legacy.toUpperCase(),
      `urn:uuid:${legacy}`,
      `{${legacy}}`,
      legacy.replace(/-/g, ""),
      "019dc500-0000-1abc-8000-00000000beef",
      "00000000-0000-0000-0000-000000000000",
      "DID:KEY:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7",
      "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c0",
      "did:key:",
      "",
      42,
      undefined,
    ]) {
      expect(classifyId(id), JSON.stringify(id)).toBe("noncanonical");
    }
    // A non-canonical id commits to nothing and binds nothing, whatever is served for it.
    expect(await idCommitsToKey(v8.toUpperCase(), r(G1).public_key)).toBe(false);
    const zw = { ...r(G1), motebit_id: `${v8}\u200b` };
    expect(
      await checkServedChain(zw, { ...identityOf(G1_CTX), motebit_id: zw.motebit_id }),
    ).toEqual({ kind: "noncanonical_id" });
  });

  it("a signing key not in canonical form commits to nothing and binds nothing (round 4: K1)", async () => {
    const g = r(G1);
    for (const key of [
      `${g.public_key}x`,
      `${g.public_key} `,
      `${g.public_key}\n`,
      g.public_key.toUpperCase(),
    ]) {
      expect(await idCommitsToKey(g.motebit_id, key), JSON.stringify(key)).toBe(false);
      expect(
        await checkServedChain({ ...g, public_key: key }, identityOf(G1_CTX)),
        JSON.stringify(key),
      ).toEqual({ kind: "noncanonical_key" });
    }
  });

  it("every non-binding outcome has a reason clause", () => {
    for (const k of [
      "not_active",
      "not_in_chain",
      "recovery_unverifiable",
      "root_mismatch",
      "other_motebit",
      "noncanonical_id",
      "noncanonical_key",
      "invalid",
    ] as const) {
      expect(chainReason(k).length).toBeGreaterThan(10);
    }
  });
});
