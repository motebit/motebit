/**
 * Exact canonical form for every identity-bearing field the signer writes
 * (`canonical.ts`), and the page's own revocation-memo scan (`memo-scan.ts`):
 * keyed on the DECODED key, and reporting any memo that names it — with or
 * without a usable date.
 */
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  getPublicKeyBySuite,
  publicKeyToDidKey,
  signBySuite,
  toBase64Url,
} from "@motebit/crypto";
import {
  RECEIPT_SUITE,
  canonicalKeyHexOfDid,
  formReason,
  isCanonicalKeyHex,
  isCanonicalSignature,
  isRecognizedSuite,
  noncanonicalFields,
} from "../canonical.js";
import { scanRevocationMemos } from "../memo-scan.js";

const priv = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const pub = await getPublicKeyBySuite(priv, RECEIPT_SUITE);
const HEX = bytesToHex(pub);
const SIG = toBase64Url(await signBySuite(RECEIPT_SUITE, new Uint8Array([1, 2, 3]), priv));
const ID = "019dc500-0000-7abc-8000-00000000beef";

describe("canonical form", () => {
  it("public_key: exactly 64 lowercase hex characters", () => {
    expect(isCanonicalKeyHex(HEX)).toBe(true);
    for (const k of [
      `${HEX}x`,
      `${HEX} `,
      `${HEX}\n`,
      `${HEX}\u0000`,
      `${HEX}\u200b`,
      HEX.toUpperCase(),
      `0${HEX}`,
      `00${HEX}`,
      `0x${HEX}`,
      `+${HEX.slice(1)}`,
      `-1${HEX.slice(2)}`,
      HEX.slice(0, 63),
      "",
      42,
      undefined,
    ]) {
      expect(isCanonicalKeyHex(k), JSON.stringify(k)).toBe(false);
    }
  });

  it("signature: exactly unpadded base64url of 64 bytes, zero trailing bits", () => {
    expect(SIG).toHaveLength(86);
    expect(isCanonicalSignature(SIG)).toBe(true);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bump = `${SIG.slice(0, -1)}${alphabet[alphabet.indexOf(SIG.at(-1)!) | 1]!}`;
    for (const s of [
      `${SIG}==`,
      `${SIG} `,
      `${SIG.slice(0, 40)}\n${SIG.slice(40)}`,
      SIG.replace(/./, "+"),
      SIG.replace(/./, "/"),
      bump,
      SIG.slice(0, 85),
      `${SIG}A`,
      bytesToHex(new Uint8Array(64)),
      "",
      null,
    ]) {
      expect(isCanonicalSignature(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("suite: exactly the receipt suite", () => {
    expect(isRecognizedSuite(RECEIPT_SUITE)).toBe(true);
    for (const s of [
      "motebit-jcs-ed25519-hex-v1",
      `${RECEIPT_SUITE} `,
      RECEIPT_SUITE.toUpperCase(),
      `${RECEIPT_SUITE}\u200b`,
      "",
      undefined,
    ]) {
      expect(isRecognizedSuite(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("noncanonicalFields names every field not in canonical form, in a fixed order", () => {
    const ok = { motebit_id: ID, public_key: HEX, signature: SIG, suite: RECEIPT_SUITE };
    expect(noncanonicalFields(ok)).toEqual([]);
    expect(noncanonicalFields({ ...ok, public_key: `${HEX} ` })).toEqual(["public_key"]);
    expect(noncanonicalFields({ ...ok, signature: `${SIG}==` })).toEqual(["signature"]);
    expect(noncanonicalFields({ ...ok, suite: "x" })).toEqual(["suite"]);
    expect(noncanonicalFields({ ...ok, motebit_id: ID.toUpperCase() })).toEqual(["motebit_id"]);
    expect(noncanonicalFields({})).toEqual(["motebit_id", "public_key", "signature", "suite"]);
    expect(noncanonicalFields(null)).toEqual(["motebit_id", "public_key", "signature", "suite"]);
  });

  it("every field has a reason that never says forged; the suite's says it is not recognized", () => {
    for (const f of ["motebit_id", "public_key", "signature"] as const) {
      expect(formReason(f)).toContain("not in canonical form");
      expect(formReason(f)).not.toMatch(/forg/i);
    }
    expect(formReason("suite")).toContain("suite not recognized");
  });

  it("the decoded key's canonical hex comes from the verifier's did:key, whatever the spelling", () => {
    expect(canonicalKeyHexOfDid(publicKeyToDidKey(pub))).toBe(HEX);
    expect(canonicalKeyHexOfDid(undefined)).toBeUndefined();
    expect(canonicalKeyHexOfDid("did:key:zbad")).toBeUndefined();
  });
});

function rpc(memos: Array<string | null>, opts: { fail?: boolean; err?: boolean } = {}) {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (opts.fail) return new Response("down", { status: 503 });
    const req = JSON.parse(init!.body as string) as { params: [string, { limit: number }] };
    const result = memos.map((m, i) => ({
      signature: `tx${i}`,
      slot: 1,
      err: opts.err ? { InstructionError: [0, "x"] } : null,
      memo: m === null ? null : `[1] ${m}`,
      blockTime: null,
    }));
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: result.slice(0, req.params[1].limit) }),
    );
  }) as typeof fetch;
}

describe("scanRevocationMemos", () => {
  const scan = (memos: Array<string | null>, opts?: { fail?: boolean; err?: boolean }) =>
    scanRevocationMemos("Addr", HEX, { rpcUrl: "http://rpc", fetch: rpc(memos, opts) });
  const P = "motebit:revocation:v1:";

  it("reports the earliest usable date", async () => {
    expect(await scan([`${P}${HEX}:9`, `${P}${HEX}:5`])).toEqual({
      status: "found",
      revokedAt: 5,
    });
  });

  it("reports a memo naming the key with no usable date — never ignores it", async () => {
    for (const m of [
      `${P}${HEX}:`,
      `${P}${HEX}:revoked`,
      `${P}${HEX}`,
      `${P}${HEX}:${"9".repeat(400)}`,
      `${P}${HEX}:99999999999999999`,
      `gm ${P}${HEX.toUpperCase()}:x`,
    ]) {
      const r = await scan([m]);
      expect(r.status, m).toBe("found");
      expect(r.status === "found" ? r.revokedAt : 0, m).toBeUndefined();
    }
  });

  it("a date stays when another memo for the key has none", async () => {
    expect(await scan([`${P}${HEX}:`, `${P}${HEX}:7`])).toEqual({ status: "found", revokedAt: 7 });
  });

  it("a memo on a failed transaction still names the key, so it is reported", async () => {
    expect((await scan([`${P}${HEX}:5`], { err: true })).status).toBe("found");
  });

  it("another key's memo, an empty memo and no memo are not a revocation", async () => {
    expect(await scan([`${P}${"0".repeat(64)}:5`, null, ""])).toEqual({ status: "none" });
  });

  it("an RPC failure is unknown, never none", async () => {
    expect((await scan([], { fail: true })).status).toBe("unknown");
  });
});
