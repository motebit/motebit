import { describe, it, expect } from "vitest";
import { SensitivityLevel, MEMORY_SOURCE_MARKERS } from "@motebit/protocol";
import {
  resolveFeltConsolidation,
  projectFeltConsolidation,
  verifyFeltCoverage,
  feltReceiptOnly,
  defaultFeltRedaction,
  feltHeadline,
  feltMutationLine,
  feltVerifiedAssurance,
  feltAssuranceGlyph,
  feltReceiptScope,
  type FeltSourceEvent,
  type FeltCoverageAdapter,
  type FeltConsolidationRecord,
} from "../memory/felt-consolidation";

function only<T>(arr: readonly T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  const [first] = arr;
  if (first === undefined) throw new Error("expected a non-empty array");
  return first;
}

// ── event builders ─────────────────────────────────────────────────────
const cycleRun = (
  cycleId: string,
  status: "started" | "completed",
  ts: number,
  summary: Record<string, number> = {},
): FeltSourceEvent => ({
  event_type: "consolidation_cycle_run",
  timestamp: ts,
  payload: { cycle_id: cycleId, status, summary },
});

const formed = (
  ts: number,
  p: {
    node_id?: string;
    content?: string;
    sensitivity?: unknown;
    source?: string;
    redacted_reason?: string;
  },
): FeltSourceEvent => ({
  event_type: "memory_formed",
  timestamp: ts,
  payload: { ...p },
});

const consolidated = (
  ts: number,
  p: { action: string; new_node_id?: string; existing_node_id?: string },
): FeltSourceEvent => ({
  event_type: "memory_consolidated",
  timestamp: ts,
  payload: { reason: "x", ...p },
});

const receiptEvent = (cycleId: string, receiptId: string, ts: number): FeltSourceEvent => ({
  event_type: "consolidation_receipt_signed",
  timestamp: ts,
  payload: { receipt: { cycle_id: cycleId, receipt_id: receiptId } },
});

const anchored = (receiptIds: string[], ts: number): FeltSourceEvent => ({
  event_type: "consolidation_receipts_anchored",
  timestamp: ts,
  payload: { anchor: { receipt_ids: receiptIds } },
});

const window = (cycleId: string, summary: Record<string, number> = {}): FeltSourceEvent[] => [
  cycleRun(cycleId, "started", 100),
  cycleRun(cycleId, "completed", 200, summary),
];

// ── manifest + adapter helpers (for verify) ─────────────────────────────
const adapter = (manifestValid = true): FeltCoverageAdapter => ({
  verifyManifest: async () => manifestValid,
  receiptDigest: async (r) => `rd:${r.receipt_id}`,
  contentDigest: async (c) => `h:${c}`,
});

const commitment = (
  node_id: string,
  content: string,
  sensitivity: SensitivityLevel = SensitivityLevel.Personal,
  provenance = "consolidation_derived",
) => ({
  node_id,
  kind: "formed" as const,
  content_sha256: `h:${content}`,
  provenance,
  sensitivity,
});

const manifestFor = (cycleId: string, receiptId: string, commitments: unknown[]) => ({
  manifest_type: "consolidation_mutation_manifest",
  schema_version: "1",
  manifest_id: "manifest-1",
  motebit_id: "mote",
  cycle_id: cycleId,
  receipt_id: receiptId,
  receipt_digest: `rd:${receiptId}`,
  mutations: commitments,
  created_at: 200,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig",
});

const signedReceiptEvent = (
  cycleId: string,
  receiptId: string,
  ts: number,
  manifest?: Record<string, unknown>,
): FeltSourceEvent => ({
  event_type: "consolidation_receipt_signed",
  timestamp: ts,
  payload: {
    receipt: { cycle_id: cycleId, receipt_id: receiptId },
    ...(manifest ? { mutation_manifest: manifest } : {}),
  },
});

// A canonical verified scenario: one formed memory, a receipt + a manifest
// committing it. Knobs flip individual pieces for the regression matrix.
function scenario(
  opts: {
    manifest?: Record<string, unknown> | null;
    content?: string;
  } = {},
): FeltSourceEvent[] {
  const content = opts.content ?? "prefers structured answers";
  const manifest =
    opts.manifest === null
      ? undefined
      : (opts.manifest ?? manifestFor("c1", "r1", [commitment("n1", content)]));
  return [
    ...window("c1", { consolidate_merged: 1 }),
    formed(150, {
      node_id: "n1",
      content,
      sensitivity: SensitivityLevel.Personal,
      source: "consolidation_derived",
    }),
    signedReceiptEvent("c1", "r1", 210, manifest),
  ];
}

async function recordsFor(
  events: FeltSourceEvent[],
  valid = true,
): Promise<FeltConsolidationRecord[]> {
  return verifyFeltCoverage(projectFeltConsolidation(events), events, adapter(valid));
}

describe("projectFeltConsolidation (candidates)", () => {
  it("forms NO candidate for a no-op cycle (honest by absence)", () => {
    expect(projectFeltConsolidation(window("c1"))).toEqual([]);
  });

  it("produces a candidate mutation with sensitivity-bounded disclosure", () => {
    const cands = projectFeltConsolidation([
      ...window("c1", { consolidate_merged: 1 }),
      formed(150, {
        node_id: "n1",
        content: "prefers structured answers",
        sensitivity: SensitivityLevel.Personal,
        source: "consolidation_derived",
      }),
    ]);
    expect(only(cands).candidateMutations).toEqual([
      {
        nodeId: "n1",
        kind: "formed",
        disclosure: "prefers structured answers",
        provenance: "consolidation_derived",
        sensitivity: SensitivityLevel.Personal,
      },
    ]);
    expect(only(cands).receiptSummary).toEqual({ consolidated: 1, pruned: 0 });
  });

  it("redacts content to existence-only for medical/financial/secret", () => {
    for (const tier of [
      SensitivityLevel.Medical,
      SensitivityLevel.Financial,
      SensitivityLevel.Secret,
    ]) {
      const cands = projectFeltConsolidation([
        ...window("c1"),
        formed(150, { node_id: "n1", content: "takes medication X at 8am", sensitivity: tier }),
      ]);
      expect(only(only(cands).candidateMutations).disclosure).toBe("a private memory");
    }
  });

  it("captures the signed receipt summary (consolidated + pruned)", () => {
    const cands = projectFeltConsolidation([
      ...window("c1", { consolidate_merged: 3, pruned_decay: 2, pruned_notability: 1 }),
    ]);
    expect(only(cands).receiptSummary).toEqual({ consolidated: 3, pruned: 3 });
    expect(only(cands).candidateMutations).toEqual([]);
  });

  it("never surfaces a deletion-tombstone memory_formed as a candidate", () => {
    const cands = projectFeltConsolidation([
      ...window("c1", { pruned_decay: 1 }),
      formed(150, {
        node_id: "n1",
        content: "[REDACTED]",
        sensitivity: "none",
        redacted_reason: "deleted",
      }),
    ]);
    expect(only(cands).candidateMutations).toEqual([]);
    expect(only(cands).receiptSummary.pruned).toBe(1);
  });

  it("reads the assurance state honestly and never inflates it", () => {
    const f = formed(150, { node_id: "n1", content: "x", sensitivity: "none" });
    expect(
      only(projectFeltConsolidation([...window("c1", { consolidate_merged: 1 }), f])).assurance,
    ).toBe("unsigned");
    expect(
      only(
        projectFeltConsolidation([
          ...window("c1", { consolidate_merged: 1 }),
          f,
          receiptEvent("c1", "r1", 210),
        ]),
      ).assurance,
    ).toBe("signed");
    expect(
      only(
        projectFeltConsolidation([
          ...window("c1", { consolidate_merged: 1 }),
          f,
          receiptEvent("c1", "r1", 210),
          anchored(["r1"], 220),
        ]),
      ).assurance,
    ).toBe("anchored");
  });

  it("dedupes started + completed markers and is replay-idempotent", () => {
    const events = [
      ...window("c1", { consolidate_merged: 1, pruned_decay: 1 }),
      formed(150, { node_id: "n1", content: "x", sensitivity: "none" }),
    ];
    expect(projectFeltConsolidation(events)).toEqual(projectFeltConsolidation(events));
    expect(projectFeltConsolidation(events)).toHaveLength(1);
  });

  it("marks merged/superseded nodes as refined, fresh ones as formed", () => {
    const cands = projectFeltConsolidation([
      ...window("c1"),
      formed(140, { node_id: "fresh", content: "new fact", sensitivity: "none" }),
      formed(160, { node_id: "merged", content: "updated fact", sensitivity: "none" }),
      consolidated(161, { action: "merge", new_node_id: "merged", existing_node_id: "old" }),
    ]);
    const byNode = Object.fromEntries(
      only(cands).candidateMutations.map((m) => [m.disclosure, m.kind]),
    );
    expect(byNode["new fact"]).toBe("formed");
    expect(byNode["updated fact"]).toBe("refined");
  });

  it("fails closed: absent/unknown sensitivity is treated as Secret", () => {
    const cands = projectFeltConsolidation([
      ...window("c1"),
      formed(150, { node_id: "n1", content: "untagged secret" }),
    ]);
    expect(only(only(cands).candidateMutations).sensitivity).toBe(SensitivityLevel.Secret);
  });

  it("does not attribute memory formed outside the cycle window", () => {
    const cands = projectFeltConsolidation([
      ...window("c1"),
      formed(50, { node_id: "before", content: "earlier", sensitivity: "none" }),
      formed(250, { node_id: "after", content: "later", sensitivity: "none" }),
    ]);
    expect(cands).toEqual([]); // nothing in [100,200] and no counts → no candidate
  });

  it("a pure-prune cycle surfaces as a receipt-only candidate (no mutations)", () => {
    const cands = projectFeltConsolidation([...window("c1", { pruned_retention: 4 })]);
    expect(only(cands).candidateMutations).toEqual([]);
    expect(only(cands).receiptSummary).toEqual({ consolidated: 0, pruned: 4 });
  });
});

describe("verifyFeltCoverage — evidence regression matrix", () => {
  it("(6) valid manifest → verified, mutations exposed with the manifest id", async () => {
    const recs = await recordsFor(scenario());
    const rec = only(recs);
    expect(rec.evidence.status).toBe("verified");
    if (rec.evidence.status === "verified") {
      expect(rec.evidence.manifestId).toBe("manifest-1");
      expect(rec.evidence.mutations.map((m) => m.disclosure)).toEqual([
        "prefers structured answers",
      ]);
    }
  });

  it("(1) manifest absent → receipt_only, no mutations", async () => {
    const rec = only(await recordsFor(scenario({ manifest: null })));
    expect(rec.evidence.status).toBe("receipt_only");
    expect(rec.evidence).not.toHaveProperty("mutations");
  });

  it("(2) bad signature → receipt_only", async () => {
    const rec = only(await recordsFor(scenario(), /* valid */ false));
    expect(rec.evidence.status).toBe("receipt_only");
  });

  it("(3) receipt digest mismatch → receipt_only", async () => {
    const m = manifestFor("c1", "r1", [commitment("n1", "prefers structured answers")]);
    m.receipt_digest = "rd:someone-elses-receipt";
    const rec = only(await recordsFor(scenario({ manifest: m })));
    expect(rec.evidence.status).toBe("receipt_only");
  });

  it("(4) exact-set mismatch (manifest commits an extra node) → receipt_only", async () => {
    const m = manifestFor("c1", "r1", [
      commitment("n1", "prefers structured answers"),
      commitment("n2", "an uncommitted extra"),
    ]);
    const rec = only(await recordsFor(scenario({ manifest: m })));
    expect(rec.evidence.status).toBe("receipt_only");
  });

  it("(5) current-key mismatch (verifyManifest false) → receipt_only", async () => {
    // The adapter abstracts the key check; a manifest signed by a rotated /
    // wrong key makes verifyManifest return false → receipt_only, never a
    // false verified.
    const rec = only(await recordsFor(scenario(), false));
    expect(rec.evidence.status).toBe("receipt_only");
  });

  it("(7) a concurrent memory event in-window but absent from the manifest → receipt_only", async () => {
    const content = "prefers structured answers";
    const m = manifestFor("c1", "r1", [commitment("n1", content)]);
    const events = [
      ...window("c1", { consolidate_merged: 1 }),
      formed(150, {
        node_id: "n1",
        content,
        sensitivity: SensitivityLevel.Personal,
        source: "consolidation_derived",
      }),
      // A concurrent interactive write that fell inside the window but the
      // manifest does NOT commit — must break the exact-set check, not leak in.
      formed(155, { node_id: "intruder", content: "unrelated", sensitivity: "none" }),
      signedReceiptEvent("c1", "r1", 210, m),
    ];
    const rec = only(await recordsFor(events));
    expect(rec.evidence.status).toBe("receipt_only");
  });

  it("(8) pure-prune cycle → receipt_only with no mutations", async () => {
    const rec = only(await recordsFor([...window("c1", { pruned_retention: 4 })]));
    expect(rec.evidence.status).toBe("receipt_only");
    expect(rec.receiptSummary.pruned).toBe(4);
  });

  it("(9) synced manifest-less receipt never shows details or verified", async () => {
    // Synced cross-device cycle: receipt present (counts), manifest stripped at
    // the relay, plus synced memory_formed events that time-correlate.
    const events = [
      ...window("c1", { consolidate_merged: 2 }),
      formed(150, {
        node_id: "synced",
        content: "from another device",
        sensitivity: "none",
        source: "consolidation_derived",
      }),
      signedReceiptEvent("c1", "r1", 210 /* no manifest */),
    ];
    const rec = only(await recordsFor(events));
    expect(rec.evidence.status).toBe("receipt_only");
    expect(rec.evidence).not.toHaveProperty("mutations");
  });

  it("(10) the shared contract: both verified and receipt_only render through the same formatters", () => {
    const verified: FeltConsolidationRecord = {
      cycleId: "c1",
      finishedAt: 200,
      assurance: "signed",
      receiptSummary: { consolidated: 3, pruned: 3 },
      evidence: {
        status: "verified",
        manifestId: "m1",
        mutations: [
          { nodeId: "a", kind: "formed", disclosure: "x", sensitivity: SensitivityLevel.None },
          { nodeId: "b", kind: "refined", disclosure: "y", sensitivity: SensitivityLevel.None },
        ],
      },
    };
    const receiptOnly: FeltConsolidationRecord = {
      cycleId: "c2",
      finishedAt: 200,
      assurance: "signed",
      receiptSummary: { consolidated: 3, pruned: 3 },
      evidence: { status: "receipt_only" },
    };
    // Verified uses the per-mutation split; receipt-only uses the signed aggregate.
    expect(feltHeadline(verified)).toBe("1 learned · 1 refined · 3 faded");
    expect(feltHeadline(receiptOnly)).toBe("3 consolidated · 3 faded");
  });

  it("feltReceiptOnly degrades every candidate (no-keys path)", () => {
    const cands = projectFeltConsolidation(scenario());
    const recs = feltReceiptOnly(cands);
    expect(only(recs).evidence.status).toBe("receipt_only");
  });
});

describe("resolveFeltConsolidation — canonical boundary", () => {
  it("verifies when given an expected-key adapter", async () => {
    const recs = await resolveFeltConsolidation(scenario(), adapter(true));
    expect(only(recs).evidence.status).toBe("verified");
  });

  it("degrades to receipt_only when the adapter rejects (wrong/rotated key)", async () => {
    const recs = await resolveFeltConsolidation(scenario(), adapter(false));
    expect(only(recs).evidence.status).toBe("receipt_only");
  });

  it("degrades every cycle to receipt_only when no adapter is supplied (no keys)", async () => {
    const recs = await resolveFeltConsolidation(scenario());
    expect(only(recs).evidence.status).toBe("receipt_only");
    expect(only(recs).evidence).not.toHaveProperty("mutations");
  });

  it("returns only render-safe records — never exposes candidates", async () => {
    const recs = await resolveFeltConsolidation(scenario(), adapter(true));
    // The returned shape is FeltConsolidationRecord (evidence), never a
    // FeltCandidate (candidateMutations) — the unverified mutations cannot
    // cross this boundary.
    expect(only(recs)).not.toHaveProperty("candidateMutations");
    expect(only(recs)).toHaveProperty("evidence");
  });
});

describe("felt copy formatters", () => {
  it("feltHeadline (verified) splits learned/refined + faded", () => {
    const rec: FeltConsolidationRecord = {
      cycleId: "c1",
      finishedAt: 200,
      assurance: "signed",
      receiptSummary: { consolidated: 9, pruned: 3 },
      evidence: {
        status: "verified",
        manifestId: "m1",
        mutations: [
          { nodeId: "a", kind: "formed", disclosure: "x", sensitivity: SensitivityLevel.None },
          { nodeId: "b", kind: "formed", disclosure: "y", sensitivity: SensitivityLevel.None },
          { nodeId: "c", kind: "refined", disclosure: "z", sensitivity: SensitivityLevel.None },
        ],
      },
    };
    expect(feltHeadline(rec)).toBe("2 learned · 1 refined · 3 faded");
  });

  it("feltMutationLine suppresses the consolidation_derived marker, shows others", () => {
    expect(
      feltMutationLine({
        nodeId: "n",
        kind: "formed",
        disclosure: "x",
        provenance: "consolidation_derived",
        sensitivity: SensitivityLevel.None,
      }),
    ).toBe("Learned: x");
    expect(
      feltMutationLine({
        nodeId: "n",
        kind: "formed",
        disclosure: "lives in LA",
        provenance: "user_stated",
        sensitivity: SensitivityLevel.None,
      }),
    ).toBe(`Learned: lives in LA · ${MEMORY_SOURCE_MARKERS.user_stated}`);
  });

  it("feltVerifiedAssurance is the only coverage label, scoped to displayed changes", () => {
    const a = feltVerifiedAssurance();
    expect(a.label).toBe("Verified");
    expect(a.detail).toContain("displayed changes match the signed mutation manifest");
  });

  it("feltReceiptScope scopes to the receipt, not the displayed counts", () => {
    expect(feltReceiptScope("signed", "verified")).toContain("signed receipt");
    expect(feltReceiptScope("signed", "verified")).not.toContain("counts above");
    expect(feltReceiptScope("signed", "verified")).toContain("verified separately");
  });

  it("feltReceiptScope is evidence-aware: receipt_only never claims displayed changes", () => {
    // A receipt-only row shows no detail lines, so the label must not imply
    // changes are shown/verified — it says they are unavailable.
    for (const a of ["signed", "anchored"] as const) {
      const ro = feltReceiptScope(a, "receipt_only");
      expect(ro).toContain("signed receipt");
      expect(ro).not.toContain("changes shown");
      expect(ro).not.toContain("verified separately");
      expect(ro).toContain("unavailable without a verified mutation manifest");

      const v = feltReceiptScope(a, "verified");
      expect(v).toContain("changes shown");
      expect(v).toContain("verified separately");
      expect(v).not.toContain("unavailable");
    }
    // Unsigned is evidence-independent (no receipt at all).
    expect(feltReceiptScope("unsigned", "receipt_only")).toContain("unsigned");
    expect(feltReceiptScope("unsigned", "verified")).toContain("unsigned");
  });

  it("feltAssuranceGlyph never shows a placeholder for unsigned", () => {
    expect(feltAssuranceGlyph("anchored")).toBe("⚓");
    expect(feltAssuranceGlyph("signed")).toBe("✓");
    expect(feltAssuranceGlyph("unsigned")).toBe("");
  });

  it("default redaction caps long none/personal content", () => {
    const out = defaultFeltRedaction({
      content: "a".repeat(200),
      sensitivity: SensitivityLevel.None,
    });
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });
});
