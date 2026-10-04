/**
 * Reciprocal CONSUMER test for the vendored APS authority-delegation vector
 * (`examples/interop/aps/case-a-neutral-vector.CANDIDATE.json`, pinned
 * upstream 2508f6a7, see that directory's NOTICE.md and INTEROP.md).
 *
 * The point is an INDEPENDENT implementation: this file imports no APS code.
 * Every byte check runs through Motebit's own primitives:
 *
 *   - canonicalization: `canonicalJson` (@motebit/crypto, signing.ts) — the
 *     JCS used for every Motebit signed artifact;
 *   - SHA-256: `sha256` / `hash` (@motebit/crypto, signing.ts);
 *   - Ed25519: `ed25519Verify` (@motebit/crypto, suite-dispatch.ts — the one
 *     permitted home of the primitive). The raw primitive, not `verifyBySuite`,
 *     because an APS record is not a Motebit artifact and carries no Motebit
 *     `SuiteId`; dressing it in one would be a false claim.
 *
 * APS construction (draft-pidlisnyi-aps-04 §4.1), domain-separated:
 *   delegation_id = "sha256:" + hex(SHA-256(ASCII(ID_TAG) || 0x00 || UTF8(JCS(record − {delegation_id, signature}))))
 *   signature     = Ed25519(ASCII(SIG_TAG) || 0x00 || UTF8(JCS(record − {signature})))   (covers delegation_id)
 *
 * Evaluation (`evaluateApsChain`) — what is reused vs implemented here:
 *   - scope: IMPLEMENTED MINIMALLY. Motebit's `isScopeNarrowed` is a flat
 *     comma-set subset test (only a bare `*` is a wildcard); it does not model
 *     APS `aps-hierarchical-v1` segment wildcards (`net:http:*` ⊇
 *     `net:http:get`). `coversHierarchical` below is the minimal rule:
 *     a grant covers a child iff equal, or it ends in `:*` and the child sits
 *     strictly beneath that prefix. No other wildcard forms are admitted.
 *   - time / depth / linkage / ancestor revocation: implemented minimally here;
 *     Motebit has no APS-shaped primitive for these.
 *   - spend, reputation, values, reversibility: NOT evaluated. They are
 *     reported `not_evaluated` structurally (the dimension record has no
 *     code path that writes `pass` for them), so unknown semantics can never
 *     read as satisfied. `valid` is computed over the evaluated dimensions
 *     only — that is the claim ceiling stated in the README, not APS
 *     compatibility.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  hash,
  hexToBytes,
  sha256,
  bytesToHex,
} from "../../packages/crypto/src/signing.js";
import { ed25519Verify } from "../../packages/crypto/src/suite-dispatch.js";

// The pins live in the interop record, not here: the record is what Motebit
// states publicly, so the test reads it and the two cannot drift apart.
const INTEROP_DIR = resolve(__dirname, "../../examples/interop/aps");

function readInteropPins(): Record<string, string> {
  const record = readFileSync(resolve(INTEROP_DIR, "INTEROP.md"), "utf8");
  const block = /```interop-pins\n([\s\S]*?)\n```/.exec(record);
  if (!block) throw new Error("INTEROP.md has no ```interop-pins block");
  const pins: Record<string, string> = {};
  for (const line of block[1]!.split("\n")) {
    const m = /^([a-z0-9_]+):\s*(\S+)\s*$/.exec(line);
    if (m) pins[m[1]!] = m[2]!;
  }
  return pins;
}

const PINS = readInteropPins();
const VECTOR_PATH = resolve(INTEROP_DIR, PINS["vector_path"] ?? "");
const VECTOR_SHA256 = PINS["vector_sha256"] ?? "";

const ID_TAG = "APS-AUTHORITY-DELEGATION-ID-V1";
const SIG_TAG = "APS-AUTHORITY-DELEGATION-SIGNATURE-V1";

// ── Types (only the fields this consumer reads) ─────────────────────────────

interface ApsRecord {
  record_type: string;
  version: string;
  parent_delegation_id: string | null;
  issuer: string;
  subject: string;
  verification_method: string;
  issued_at: string;
  nonce: string;
  authority: {
    scope: { profile: string; grants: string[] };
    depth: { remaining: number };
    time: { not_before: string; not_after: string };
    [dim: string]: unknown;
  };
  delegation_id: string;
  signature: string;
}

interface ApsVector {
  evaluated_at: string;
  trust_anchors: {
    roots: { issuer: string; subject: string }[];
    verification_keys: Record<string, string>;
  };
  chain: ApsRecord[];
  cases: {
    case_id: string;
    revocation_state: { revoked_delegation_ids: string[] };
    expected: { valid: boolean; failure_codes: string[]; failure_index?: number };
  }[];
}

type DimensionVerdict = "pass" | "fail" | "not_evaluated";

/** Dimensions this consumer evaluates. */
const EVALUATED = [
  "signature",
  "delegation_id",
  "linkage",
  "scope",
  "time",
  "depth",
  "revocation",
] as const;
/** APS dimensions Motebit does not model. Never written as `pass`. */
const NOT_EVALUATED = ["spend", "reputation", "values", "reversibility"] as const;

type EvaluatedDim = (typeof EVALUATED)[number];
type Dimension = EvaluatedDim | (typeof NOT_EVALUATED)[number];

interface Failure {
  code: string;
  index: number;
  dimension: EvaluatedDim;
}

interface ApsEvaluation {
  valid: boolean;
  failures: Failure[];
  dimensions: Record<Dimension, DimensionVerdict>;
}

// ── APS §4.1 construction over Motebit primitives ───────────────────────────

const enc = new TextEncoder();

function domainSeparated(tag: string, body: unknown): Uint8Array {
  const t = enc.encode(tag);
  const b = enc.encode(canonicalJson(body));
  const out = new Uint8Array(t.length + 1 + b.length);
  out.set(t, 0);
  out[t.length] = 0x00;
  out.set(b, t.length + 1);
  return out;
}

async function computeDelegationId(record: ApsRecord): Promise<string> {
  const { delegation_id: _id, signature: _sig, ...body } = record;
  return "sha256:" + bytesToHex(await sha256(domainSeparated(ID_TAG, body)));
}

async function verifyRecordSignature(
  record: ApsRecord,
  keys: Record<string, string>,
): Promise<boolean> {
  const keyHex = keys[record.verification_method];
  if (keyHex === undefined || !/^[0-9a-f]{64}$/.test(keyHex)) return false;
  if (!/^[0-9a-f]{128}$/.test(record.signature)) return false;
  const { signature, ...body } = record;
  return ed25519Verify(hexToBytes(signature), domainSeparated(SIG_TAG, body), hexToBytes(keyHex));
}

/** aps-hierarchical-v1, minimal: exact match, or `prefix:*` strictly covering. */
function coversHierarchical(parentGrant: string, childGrant: string): boolean {
  if (parentGrant === childGrant) return true;
  if (!parentGrant.endsWith(":*")) return false;
  const prefix = parentGrant.slice(0, -1); // keep the trailing ':'
  return childGrant.startsWith(prefix) && childGrant.length > prefix.length;
}

function scopeNarrows(parent: string[], child: string[]): boolean {
  return child.length > 0 && child.every((c) => parent.some((p) => coversHierarchical(p, c)));
}

// ── Evaluation ──────────────────────────────────────────────────────────────

async function evaluateApsChain(
  vector: Pick<ApsVector, "evaluated_at" | "trust_anchors" | "chain">,
  revokedIds: readonly string[],
): Promise<ApsEvaluation> {
  const failures: Failure[] = [];
  const fail = (dimension: EvaluatedDim, code: string, index: number): void => {
    failures.push({ dimension, code, index });
  };
  const at = Date.parse(vector.evaluated_at);
  const { chain, trust_anchors } = vector;

  if (chain.length === 0) fail("linkage", "EMPTY_CHAIN", 0);

  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i]!;
    if ((await computeDelegationId(rec)) !== rec.delegation_id) {
      fail("delegation_id", "DELEGATION_ID_MISMATCH", i);
    }
    if (!(await verifyRecordSignature(rec, trust_anchors.verification_keys))) {
      fail("signature", "BAD_SIGNATURE", i);
    }
    if (!rec.verification_method.startsWith(rec.issuer + "#")) {
      fail("signature", "KEY_NOT_ISSUERS", i);
    }

    const nb = Date.parse(rec.authority.time.not_before);
    const na = Date.parse(rec.authority.time.not_after);
    if (!(Number.isFinite(nb) && Number.isFinite(na) && nb <= at && at < na)) {
      fail("time", "OUTSIDE_WINDOW", i);
    }
    if (!Number.isInteger(rec.authority.depth.remaining) || rec.authority.depth.remaining < 0) {
      fail("depth", "BAD_DEPTH", i);
    }
    if (rec.authority.scope.profile !== "aps-hierarchical-v1") {
      fail("scope", "UNSUPPORTED_SCOPE_PROFILE", i);
    }
    if (revokedIds.includes(rec.delegation_id)) fail("revocation", "REVOKED", i);

    if (i === 0) {
      const anchored = trust_anchors.roots.some(
        (r) => r.issuer === rec.issuer && r.subject === rec.subject,
      );
      if (rec.parent_delegation_id !== null || !anchored) fail("linkage", "UNANCHORED_ROOT", 0);
      continue;
    }

    const parent = chain[i - 1]!;
    if (rec.parent_delegation_id !== parent.delegation_id || rec.issuer !== parent.subject) {
      fail("linkage", "BROKEN_LINK", i);
    }
    if (!scopeNarrows(parent.authority.scope.grants, rec.authority.scope.grants)) {
      fail("scope", "SCOPE_WIDENED", i);
    }
    if (
      Date.parse(rec.authority.time.not_before) < Date.parse(parent.authority.time.not_before) ||
      Date.parse(rec.authority.time.not_after) > Date.parse(parent.authority.time.not_after)
    ) {
      fail("time", "WINDOW_WIDENED", i);
    }
    if (!(rec.authority.depth.remaining < parent.authority.depth.remaining)) {
      fail("depth", "DEPTH_NOT_DECREASING", i);
    }
  }

  const dimensions = {} as Record<Dimension, DimensionVerdict>;
  for (const d of EVALUATED) {
    dimensions[d] = failures.some((f) => f.dimension === d) ? "fail" : "pass";
  }
  for (const d of NOT_EVALUATED) dimensions[d] = "not_evaluated";

  return { valid: failures.length === 0, failures, dimensions };
}

// ── Tests ───────────────────────────────────────────────────────────────────

const raw = readFileSync(VECTOR_PATH);
const vector = JSON.parse(raw.toString("utf8")) as ApsVector;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("APS authority-delegation vector — Motebit consumer", () => {
  it("(0) INTEROP.md declares the pins this test verifies", () => {
    expect(PINS["vector_path"]).toBe("case-a-neutral-vector.CANDIDATE.json");
    expect(PINS["vector_upstream_commit"]).toMatch(/^[0-9a-f]{7,40}$/);
    expect(VECTOR_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(1) the vendored fixture is byte-identical to the pinned SHA-256", async () => {
    expect(await hash(new Uint8Array(raw))).toBe(VECTOR_SHA256);
  });

  it("(2) both delegation_ids reproduce under the §4.1 ID construction", async () => {
    expect(vector.chain).toHaveLength(2);
    for (const rec of vector.chain) {
      expect(await computeDelegationId(rec)).toBe(rec.delegation_id);
    }
  });

  it("(3) both signatures verify with Motebit's Ed25519 primitive", async () => {
    for (const rec of vector.chain) {
      expect(await verifyRecordSignature(rec, vector.trust_anchors.verification_keys)).toBe(true);
    }
  });

  describe("(4) tampering any signed field fails verification", () => {
    const tampers: [string, number, (r: ApsRecord) => void][] = [
      ["nonce", 0, (r) => void (r.nonce = "00000000000000000000000000000009")],
      ["scope grant", 1, (r) => void (r.authority.scope.grants = ["net:http:post"])],
      ["depth", 1, (r) => void (r.authority.depth.remaining = 3)],
      ["not_after", 0, (r) => void (r.authority.time.not_after = "2028-01-01T00:00:00.000Z")],
    ];
    for (const [field, idx, mutate] of tampers) {
      it(`${field} (chain[${idx}])`, async () => {
        const rec = clone(vector.chain[idx]!);
        mutate(rec);
        expect(await computeDelegationId(rec)).not.toBe(rec.delegation_id);
        expect(await verifyRecordSignature(rec, vector.trust_anchors.verification_keys)).toBe(
          false,
        );
        // And the signature still fails if the attacker also recomputes the id:
        // the signature covers delegation_id, so re-deriving it cannot help.
        rec.delegation_id = await computeDelegationId(rec);
        expect(await verifyRecordSignature(rec, vector.trust_anchors.verification_keys)).toBe(
          false,
        );
        const tampered = clone(vector);
        tampered.chain[idx] = rec;
        const result = await evaluateApsChain(tampered, []);
        expect(result.valid).toBe(false);
        expect(result.dimensions.signature).toBe("fail");
      });
    }
  });

  it("(5) linkage: parent id, issuer = parent subject, root issuer anchored", () => {
    const [root, child] = vector.chain as [ApsRecord, ApsRecord];
    expect(child.parent_delegation_id).toBe(root.delegation_id);
    expect(child.issuer).toBe(root.subject);
    expect(root.parent_delegation_id).toBeNull();
    expect(vector.trust_anchors.roots.map((r) => r.issuer)).toContain(root.issuer);
  });

  it("(6) grant 0 → grant 1 narrows on scope, time and depth", () => {
    const [p, c] = vector.chain as [ApsRecord, ApsRecord];
    expect(coversHierarchical("net:http:*", "net:http:get")).toBe(true);
    expect(coversHierarchical("net:http:get", "net:http:*")).toBe(false);
    expect(coversHierarchical("net:http:*", "net:https:get")).toBe(false);
    expect(coversHierarchical("net:http:*", "net:http:")).toBe(false);
    expect(scopeNarrows(p.authority.scope.grants, c.authority.scope.grants)).toBe(true);
    expect(scopeNarrows(c.authority.scope.grants, p.authority.scope.grants)).toBe(false);

    const at = Date.parse(vector.evaluated_at);
    const pt = p.authority.time;
    const ct = c.authority.time;
    expect(Date.parse(ct.not_before)).toBeGreaterThanOrEqual(Date.parse(pt.not_before));
    expect(Date.parse(ct.not_after)).toBeLessThanOrEqual(Date.parse(pt.not_after));
    expect(Date.parse(ct.not_before)).toBeLessThanOrEqual(at);
    expect(Date.parse(ct.not_after)).toBeGreaterThan(at);

    expect(c.authority.depth.remaining).toBeLessThan(p.authority.depth.remaining);
  });

  describe("(7) the vector's cases reproduce", () => {
    for (const kase of vector.cases) {
      it(kase.case_id, async () => {
        const result = await evaluateApsChain(vector, kase.revocation_state.revoked_delegation_ids);
        expect(result.valid).toBe(kase.expected.valid);
        expect(result.failures.map((f) => f.code)).toEqual(kase.expected.failure_codes);
        if (kase.expected.failure_index !== undefined) {
          expect(result.failures[0]!.index).toBe(kase.expected.failure_index);
        }
      });
    }

    it("ancestor-active ⇒ valid; ancestor-revoked ⇒ REVOKED at index 0", async () => {
      const active = await evaluateApsChain(vector, []);
      expect(active.valid).toBe(true);
      expect(active.failures).toEqual([]);

      const revoked = await evaluateApsChain(vector, [vector.chain[0]!.delegation_id]);
      expect(revoked.valid).toBe(false);
      expect(revoked.failures).toEqual([{ dimension: "revocation", code: "REVOKED", index: 0 }]);
      expect(revoked.dimensions.revocation).toBe("fail");
    });

    it("an unanchored root or broken link is rejected", async () => {
      const noRoot = clone(vector);
      noRoot.trust_anchors.roots = [];
      expect((await evaluateApsChain(noRoot, [])).failures.map((f) => f.code)).toContain(
        "UNANCHORED_ROOT",
      );
      const reversed = clone(vector);
      reversed.chain.reverse();
      const r = await evaluateApsChain(reversed, []);
      expect(r.valid).toBe(false);
      expect(r.dimensions.linkage).toBe("fail");
    });
  });

  it("(8) reputation, reversibility, values (and spend) are never treated as satisfied", async () => {
    for (const revoked of [[], [vector.chain[0]!.delegation_id]]) {
      const r = await evaluateApsChain(vector, revoked);
      expect(r.dimensions.reputation).toBe("not_evaluated");
      expect(r.dimensions.reversibility).toBe("not_evaluated");
      expect(r.dimensions.values).toBe("not_evaluated");
      expect(r.dimensions.spend).toBe("not_evaluated");
      for (const d of NOT_EVALUATED) expect(r.dimensions[d]).not.toBe("pass");
    }
    // Every dimension is accounted for: evaluated ones are pass/fail, the rest
    // are explicitly not_evaluated — nothing is silently omitted.
    expect(Object.keys((await evaluateApsChain(vector, [])).dimensions).sort()).toEqual(
      [...EVALUATED, ...NOT_EVALUATED].sort(),
    );
  });
});
