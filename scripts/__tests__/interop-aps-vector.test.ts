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
 *     only — that is the claim ceiling stated in INTEROP.md, not APS
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
  generateKeypair,
} from "../../packages/crypto/src/signing.js";
import { ed25519Sign, ed25519Verify } from "../../packages/crypto/src/suite-dispatch.js";

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

// ── Synthetic chains: one validly-signed negative per check ─────────────────
//
// The vendored vector's negative cases all die at the signature or at
// UNANCHORED_ROOT first, so they cannot show that the narrowing, window,
// linkage and key-binding checks bite. These chains are built with the SAME
// §4.1 construction (domain-tagged JCS id + signature) under TEST keys
// generated here, with the synthetic root declared as the trust anchor, so
// every record is cryptographically valid and exactly one check is violated.

const SYN_ROOT = "aps:agent:synthetic-root";
const SYN_PARENT = "aps:agent:synthetic-parent";
const SYN_CHILD = "aps:agent:synthetic-child";
const SYN_OTHER = "aps:agent:synthetic-other";

interface SynKeys {
  root: { publicKey: Uint8Array; privateKey: Uint8Array };
  parent: { publicKey: Uint8Array; privateKey: Uint8Array };
  other: { publicKey: Uint8Array; privateKey: Uint8Array };
}

let synKeys: Promise<SynKeys> | undefined;
function getSynKeys(): Promise<SynKeys> {
  synKeys ??= (async () => ({
    root: await generateKeypair(),
    parent: await generateKeypair(),
    other: await generateKeypair(),
  }))();
  return synKeys;
}

type Unsigned = Omit<ApsRecord, "delegation_id" | "signature">;

async function signApsRecord(unsigned: Unsigned, privateKey: Uint8Array): Promise<ApsRecord> {
  const delegation_id = await computeDelegationId({
    ...unsigned,
    delegation_id: "",
    signature: "",
  });
  const sig = await ed25519Sign(
    domainSeparated(SIG_TAG, { ...unsigned, delegation_id }),
    privateKey,
  );
  return { ...unsigned, delegation_id, signature: bytesToHex(sig) };
}

function synAuthority(
  grants: string[],
  remaining: number,
  not_before: string,
  not_after: string,
): ApsRecord["authority"] {
  return {
    scope: { profile: "aps-hierarchical-v1", grants },
    depth: { remaining },
    time: { not_before, not_after },
  };
}

interface ChildSpec {
  grants?: string[];
  remaining?: number;
  not_before?: string;
  not_after?: string;
  /** Override the child's parent_delegation_id (default: the root's id). */
  parentId?: string;
  /** Sign with the unrelated key and name it as the verification method. */
  signedByOther?: boolean;
}

/** Root: net:http:* · depth 4 · [2026-01-01, 2027-01-01). Child narrows it unless `spec` says otherwise. */
async function buildSyntheticChain(
  spec: ChildSpec = {},
  evaluated_at = "2026-06-01T00:00:00.000Z",
): Promise<Pick<ApsVector, "evaluated_at" | "trust_anchors" | "chain">> {
  const k = await getSynKeys();
  const root = await signApsRecord(
    {
      record_type: "aps:authority-delegation:v1",
      version: "1.0",
      parent_delegation_id: null,
      issuer: SYN_ROOT,
      subject: SYN_PARENT,
      verification_method: `${SYN_ROOT}#key-1`,
      issued_at: "2026-01-01T00:00:00.000Z",
      nonce: "000000000000000000000000000000a1",
      authority: synAuthority(
        ["net:http:*"],
        4,
        "2026-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
      ),
    },
    k.root.privateKey,
  );
  const child = await signApsRecord(
    {
      record_type: "aps:authority-delegation:v1",
      version: "1.0",
      parent_delegation_id: spec.parentId ?? root.delegation_id,
      issuer: SYN_PARENT,
      subject: SYN_CHILD,
      verification_method: spec.signedByOther ? `${SYN_OTHER}#key-1` : `${SYN_PARENT}#key-1`,
      issued_at: "2026-02-01T00:00:00.000Z",
      nonce: "000000000000000000000000000000a2",
      authority: synAuthority(
        spec.grants ?? ["net:http:get"],
        spec.remaining ?? 2,
        spec.not_before ?? "2026-02-01T00:00:00.000Z",
        spec.not_after ?? "2026-12-01T00:00:00.000Z",
      ),
    },
    spec.signedByOther ? k.other.privateKey : k.parent.privateKey,
  );
  return {
    evaluated_at,
    trust_anchors: {
      roots: [{ issuer: SYN_ROOT, subject: SYN_PARENT }],
      verification_keys: {
        [`${SYN_ROOT}#key-1`]: bytesToHex(k.root.publicKey),
        [`${SYN_PARENT}#key-1`]: bytesToHex(k.parent.publicKey),
        [`${SYN_OTHER}#key-1`]: bytesToHex(k.other.publicKey),
      },
    },
    chain: [root, child],
  };
}

describe("(9) synthetic validly-signed chains — each check bites on its own", () => {
  it("the narrowing synthetic chain is valid (every record signed, root anchored)", async () => {
    const chain = await buildSyntheticChain();
    for (const rec of chain.chain) {
      expect(await computeDelegationId(rec)).toBe(rec.delegation_id);
      expect(await verifyRecordSignature(rec, chain.trust_anchors.verification_keys)).toBe(true);
    }
    const r = await evaluateApsChain(chain, []);
    expect(r.failures).toEqual([]);
    expect(r.valid).toBe(true);
  });

  const negatives: [string, ChildSpec, string | undefined, Failure][] = [
    [
      "widened scope ⇒ SCOPE_WIDENED",
      { grants: ["net:https:get"] },
      undefined,
      { dimension: "scope", code: "SCOPE_WIDENED", index: 1 },
    ],
    [
      "equal depth ⇒ DEPTH_NOT_DECREASING",
      { remaining: 4 },
      undefined,
      { dimension: "depth", code: "DEPTH_NOT_DECREASING", index: 1 },
    ],
    [
      "greater depth ⇒ DEPTH_NOT_DECREASING",
      { remaining: 5 },
      undefined,
      { dimension: "depth", code: "DEPTH_NOT_DECREASING", index: 1 },
    ],
    [
      "window wider than the parent's ⇒ WINDOW_WIDENED",
      { not_after: "2027-06-01T00:00:00.000Z" },
      undefined,
      { dimension: "time", code: "WINDOW_WIDENED", index: 1 },
    ],
    [
      "window inside the parent's but excluding evaluated_at ⇒ OUTSIDE_WINDOW",
      { not_before: "2026-07-01T00:00:00.000Z" },
      undefined,
      { dimension: "time", code: "OUTSIDE_WINDOW", index: 1 },
    ],
    [
      "evaluated_at == not_after (exclusive bound) ⇒ OUTSIDE_WINDOW",
      { not_after: "2026-06-01T00:00:00.000Z" },
      "2026-06-01T00:00:00.000Z",
      { dimension: "time", code: "OUTSIDE_WINDOW", index: 1 },
    ],
    [
      "wrong parent_delegation_id under an anchored root ⇒ BROKEN_LINK",
      { parentId: "sha256:" + "0".repeat(64) },
      undefined,
      { dimension: "linkage", code: "BROKEN_LINK", index: 1 },
    ],
    [
      "child signed by a key that is not the issuer's ⇒ KEY_NOT_ISSUERS",
      { signedByOther: true },
      undefined,
      { dimension: "signature", code: "KEY_NOT_ISSUERS", index: 1 },
    ],
  ];
  for (const [name, spec, evaluatedAt, expected] of negatives) {
    it(name, async () => {
      const chain = await buildSyntheticChain(spec, evaluatedAt);
      // Precondition: the violation is not cryptographic — every record verifies.
      for (const rec of chain.chain) {
        expect(await computeDelegationId(rec)).toBe(rec.delegation_id);
        expect(await verifyRecordSignature(rec, chain.trust_anchors.verification_keys)).toBe(true);
      }
      const r = await evaluateApsChain(chain, []);
      expect(r.valid).toBe(false);
      expect(r.failures).toEqual([expected]);
    });
  }

  it("evaluated_at == not_before (inclusive bound) is inside the window", async () => {
    const chain = await buildSyntheticChain(
      { not_before: "2026-06-01T00:00:00.000Z" },
      "2026-06-01T00:00:00.000Z",
    );
    expect((await evaluateApsChain(chain, [])).valid).toBe(true);
  });
});
