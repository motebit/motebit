import { describe, it, expect } from "vitest";
import { SensitivityLevel, MEMORY_SOURCE_MARKERS } from "@motebit/protocol";
import {
  projectFeltConsolidation,
  verifyFeltCoverage,
  defaultFeltRedaction,
  feltHeadline,
  feltMutationLine,
  feltCoverageStatus,
  feltAssuranceGlyph,
  feltReceiptScope,
  type FeltSourceEvent,
  type FeltCoverageAdapter,
  type FeltMutation,
  type FeltConsolidationRecord,
} from "../memory/felt-consolidation";

// Strict-safe first-element access (noUncheckedIndexedAccess is on).
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

const receipt = (cycleId: string, receiptId: string, ts: number): FeltSourceEvent => ({
  event_type: "consolidation_receipt_signed",
  timestamp: ts,
  payload: { receipt: { cycle_id: cycleId, receipt_id: receiptId } },
});

const anchored = (receiptIds: string[], ts: number): FeltSourceEvent => ({
  event_type: "consolidation_receipts_anchored",
  timestamp: ts,
  payload: { anchor: { receipt_ids: receiptIds } },
});

// A canonical cycle window [100, 200].
const window = (cycleId: string, summary: Record<string, number> = {}): FeltSourceEvent[] => [
  cycleRun(cycleId, "started", 100),
  cycleRun(cycleId, "completed", 200, summary),
];

describe("projectFeltConsolidation", () => {
  it("forms NO record for a no-op cycle (honest by absence)", () => {
    expect(projectFeltConsolidation(window("c1"))).toEqual([]);
  });

  it("surfaces a formed mutation with content for none/personal", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(150, {
        node_id: "n1",
        content: "prefers structured answers",
        sensitivity: SensitivityLevel.Personal,
        source: "consolidation_derived",
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(only(records).mutations).toEqual([
      {
        nodeId: "n1",
        kind: "formed",
        disclosure: "prefers structured answers",
        provenance: "consolidation_derived",
        sensitivity: SensitivityLevel.Personal,
      },
    ]);
  });

  it("redacts content to existence-only for medical/financial/secret", () => {
    for (const tier of [
      SensitivityLevel.Medical,
      SensitivityLevel.Financial,
      SensitivityLevel.Secret,
    ]) {
      const records = projectFeltConsolidation([
        ...window("c1"),
        formed(150, { node_id: "n1", content: "takes medication X at 8am", sensitivity: tier }),
      ]);
      const m = only(only(records).mutations);
      expect(m.disclosure).toBe("a private memory");
      expect(m.disclosure).not.toContain("medication");
    }
  });

  it("keeps taught and inferred provenance distinct — they never collapse", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(140, {
        node_id: "n1",
        content: "lives in LA",
        sensitivity: "none",
        source: "user_stated",
      }),
      formed(160, {
        node_id: "n2",
        content: "likely a morning person",
        sensitivity: "none",
        source: "agent_inferred",
      }),
    ]);
    const provenances = only(records).mutations.map((m) => m.provenance);
    expect(provenances).toContain("user_stated");
    expect(provenances).toContain("agent_inferred");
    expect(new Set(provenances).size).toBe(2);
  });

  it("renders retirements as a count only — never content", () => {
    const records = projectFeltConsolidation([
      ...window("c1", { pruned_decay: 2, pruned_notability: 1, pruned_retention: 0 }),
    ]);
    expect(records).toHaveLength(1);
    expect(only(records).retired.count).toBe(3);
    expect(only(records).mutations).toEqual([]);
  });

  it("never surfaces a deletion-tombstone memory_formed as a learned line", () => {
    const records = projectFeltConsolidation([
      ...window("c1", { pruned_decay: 1 }),
      formed(150, {
        node_id: "n1",
        content: "[REDACTED]",
        sensitivity: "none",
        redacted_reason: "deleted",
      }),
    ]);
    expect(only(records).mutations).toEqual([]);
    expect(only(records).retired.count).toBe(1);
  });

  it("reads the assurance state honestly and never inflates it", () => {
    const formedEv = formed(150, { node_id: "n1", content: "x", sensitivity: "none" });

    expect(only(projectFeltConsolidation([...window("c1"), formedEv])).assurance).toBe("unsigned");

    expect(
      only(projectFeltConsolidation([...window("c1"), formedEv, receipt("c1", "r1", 210)]))
        .assurance,
    ).toBe("signed");

    expect(
      only(
        projectFeltConsolidation([
          ...window("c1"),
          formedEv,
          receipt("c1", "r1", 210),
          anchored(["r1"], 220),
        ]),
      ).assurance,
    ).toBe("anchored");
  });

  it("dedupes the started + completed markers and is replay-idempotent", () => {
    const events = [
      ...window("c1", { pruned_decay: 1 }),
      formed(150, { node_id: "n1", content: "x", sensitivity: "none" }),
    ];
    const once = projectFeltConsolidation(events);
    const twice = projectFeltConsolidation(events);
    expect(once).toHaveLength(1);
    expect(once).toEqual(twice);
    expect(once.filter((r) => r.cycleId === "c1")).toHaveLength(1);
  });

  it("marks merged/superseded nodes as refined, fresh ones as formed", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(140, { node_id: "fresh", content: "new fact", sensitivity: "none" }),
      formed(160, { node_id: "merged", content: "updated fact", sensitivity: "none" }),
      consolidated(161, { action: "merge", new_node_id: "merged", existing_node_id: "old" }),
    ]);
    const byNode = Object.fromEntries(only(records).mutations.map((m) => [m.disclosure, m.kind]));
    expect(byNode["new fact"]).toBe("formed");
    expect(byNode["updated fact"]).toBe("refined");
  });

  it("fails closed: absent/unknown sensitivity is treated as Secret", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(150, { node_id: "n1", content: "untagged secret" }),
    ]);
    const m = only(only(records).mutations);
    expect(m.sensitivity).toBe(SensitivityLevel.Secret);
    expect(m.disclosure).toBe("a private memory");
  });

  it("does not attribute memory formed outside the cycle window", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(50, { node_id: "before", content: "earlier", sensitivity: "none" }),
      formed(250, { node_id: "after", content: "later", sensitivity: "none" }),
    ]);
    expect(records).toEqual([]); // nothing in [100,200] → no-op
  });

  it("orders records newest-first by finishedAt", () => {
    const records = projectFeltConsolidation([
      cycleRun("old", "completed", 200, { pruned_decay: 1 }),
      cycleRun("new", "completed", 400, { pruned_decay: 1 }),
    ]);
    expect(records.map((r) => r.cycleId)).toEqual(["new", "old"]);
  });

  it("cannot express authority — the record shape carries no grant/trust field", () => {
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(150, { node_id: "n1", content: "x", sensitivity: "none", source: "user_stated" }),
    ]);
    const rec = only(records);
    expect(Object.keys(rec).sort()).toEqual([
      "assurance",
      "cycleId",
      "finishedAt",
      "mutations",
      "mutationsCoveredBySignature",
      "retired",
    ]);
    for (const m of rec.mutations) {
      for (const k of Object.keys(m)) {
        expect(["nodeId", "kind", "disclosure", "provenance", "sensitivity"]).toContain(k);
      }
    }
  });

  it("never claims signature coverage of the detail mutations (scope honesty)", () => {
    // The receipt commits to counts; the details are a local time-window
    // reconstruction. Even a signed + anchored cycle must report the detail
    // set as NOT covered by the signature.
    const records = projectFeltConsolidation([
      ...window("c1"),
      formed(150, { node_id: "n1", content: "x", sensitivity: "none" }),
      receipt("c1", "r1", 210),
      anchored(["r1"], 220),
    ]);
    const rec = only(records);
    expect(rec.assurance).toBe("anchored");
    expect(rec.mutationsCoveredBySignature).toBe(false);
  });

  it("default redaction caps long none/personal content", () => {
    const long = "a".repeat(200);
    const out = defaultFeltRedaction({ content: long, sensitivity: SensitivityLevel.None });
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("verifyFeltCoverage", () => {
  // Deterministic stand-ins for the injected crypto. The real Ed25519/SHA-256
  // path is covered in @motebit/crypto; here we test the orchestration:
  // linkage, set-equality, content/provenance/sensitivity matching, fail paths.
  const adapter = (manifestValid = true): FeltCoverageAdapter => ({
    verifyManifest: async () => manifestValid,
    receiptDigest: async (r) => `rd:${r.receipt_id}`,
    contentDigest: async (c) => `h:${c}`,
  });

  const commitment = (node_id: string, content: string) => ({
    node_id,
    kind: "formed" as const,
    content_sha256: `h:${content}`,
    provenance: "consolidation_derived" as const,
    sensitivity: SensitivityLevel.Personal,
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

  const manifestFor = (cycleId: string, receiptId: string, commitments: unknown[]) => ({
    manifest_type: "consolidation_mutation_manifest",
    schema_version: "1",
    manifest_id: "m1",
    motebit_id: "mote",
    cycle_id: cycleId,
    receipt_id: receiptId,
    receipt_digest: `rd:${receiptId}`,
    mutations: commitments,
    created_at: 200,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  });

  const formedC1 = (content = "prefers structured answers"): FeltSourceEvent => ({
    event_type: "memory_formed",
    timestamp: 150,
    payload: {
      node_id: "n1",
      content,
      sensitivity: SensitivityLevel.Personal,
      source: "consolidation_derived",
    },
  });

  const baseEvents = (manifest?: Record<string, unknown>): FeltSourceEvent[] => [
    {
      event_type: "consolidation_cycle_run",
      timestamp: 100,
      payload: { cycle_id: "c1", status: "started", summary: {} },
    },
    {
      event_type: "consolidation_cycle_run",
      timestamp: 200,
      payload: { cycle_id: "c1", status: "completed", summary: {} },
    },
    formedC1(),
    signedReceiptEvent("c1", "r1", 210, manifest),
  ];

  async function coverageFor(events: FeltSourceEvent[], valid = true): Promise<boolean> {
    const records = projectFeltConsolidation(events);
    const verified = await verifyFeltCoverage(records, events, adapter(valid));
    const [rec] = verified;
    expect(rec).toBeDefined();
    return rec ? rec.mutationsCoveredBySignature : false;
  }

  it("covers a record when signature, receipt linkage, and content all verify", async () => {
    const events = baseEvents(
      manifestFor("c1", "r1", [commitment("n1", "prefers structured answers")]),
    );
    expect(await coverageFor(events)).toBe(true);
  });

  it("does NOT cover when the manifest signature is invalid", async () => {
    const events = baseEvents(
      manifestFor("c1", "r1", [commitment("n1", "prefers structured answers")]),
    );
    expect(await coverageFor(events, false)).toBe(false);
  });

  it("does NOT cover when the displayed content does not match the commitment", async () => {
    // Commitment for different content → content digest mismatch.
    const events = baseEvents(manifestFor("c1", "r1", [commitment("n1", "a forged sentence")]));
    expect(await coverageFor(events)).toBe(false);
  });

  it("does NOT cover when receipt linkage is broken", async () => {
    const m = manifestFor("c1", "r1", [commitment("n1", "prefers structured answers")]);
    m.receipt_digest = "rd:someone-elses-receipt";
    expect(await coverageFor(baseEvents(m))).toBe(false);
  });

  it("does NOT cover when the committed set differs from the displayed set", async () => {
    // Manifest commits an extra node the surface never displayed.
    const m = manifestFor("c1", "r1", [
      commitment("n1", "prefers structured answers"),
      commitment("n2", "an uncommitted extra"),
    ]);
    expect(await coverageFor(baseEvents(m))).toBe(false);
  });

  it("does NOT cover when there is no manifest (stays at the honest default)", async () => {
    expect(await coverageFor(baseEvents(undefined))).toBe(false);
  });

  it("does NOT cover when the committed sensitivity tier disagrees with the node", async () => {
    const m = manifestFor("c1", "r1", [
      { ...commitment("n1", "prefers structured answers"), sensitivity: SensitivityLevel.Medical },
    ]);
    expect(await coverageFor(baseEvents(m))).toBe(false);
  });
});

describe("felt copy formatters", () => {
  const mut = (over: Partial<FeltMutation> = {}): FeltMutation => ({
    nodeId: "n1",
    kind: "formed",
    disclosure: "prefers structured answers",
    sensitivity: SensitivityLevel.Personal,
    ...over,
  });
  const rec = (over: Partial<FeltConsolidationRecord> = {}): FeltConsolidationRecord => ({
    cycleId: "c1",
    finishedAt: 200,
    assurance: "signed",
    mutations: [],
    retired: { count: 0 },
    mutationsCoveredBySignature: false,
    ...over,
  });

  it("feltHeadline splits learned/refined/faded so the headline matches the reveal", () => {
    expect(
      feltHeadline(rec({ mutations: [mut(), mut({ kind: "refined" })], retired: { count: 3 } })),
    ).toBe("1 learned · 1 refined · 3 faded");
    // Collapses to the calm two-part form when there are no refinements.
    expect(feltHeadline(rec({ mutations: [mut(), mut()] }))).toBe("2 learned");
    expect(feltHeadline(rec({ mutations: [mut({ kind: "refined" })] }))).toBe("1 refined");
    expect(feltHeadline(rec({ retired: { count: 3 } }))).toBe("3 faded");
  });

  it("feltReceiptScope scopes the glyph to the receipt, NOT the displayed counts", () => {
    expect(feltReceiptScope("anchored")).toContain("anchored");
    expect(feltReceiptScope("signed")).toContain("signed receipt");
    expect(feltReceiptScope("unsigned")).toContain("unsigned");
    // Must not overclaim: the receipt does not attest the displayed
    // learned/refined counts (those are manifest-covered — consolidate_merged
    // can differ, e.g. reinforcements that form no node). It defers to
    // "verified separately".
    expect(feltReceiptScope("signed")).not.toContain("counts above");
    expect(feltReceiptScope("signed")).toContain("verified separately");
  });

  it("feltMutationLine suppresses the redundant consolidation_derived marker", () => {
    expect(feltMutationLine(mut({ provenance: "consolidation_derived" }))).toBe(
      "Learned: prefers structured answers",
    );
    expect(
      feltMutationLine(
        mut({ kind: "refined", provenance: "consolidation_derived", disclosure: "x" }),
      ),
    ).toBe("Refined: x");
    expect(feltMutationLine(mut({ provenance: undefined }))).toBe(
      "Learned: prefers structured answers",
    );
  });

  it("feltMutationLine shows the marker only when provenance varies (taught vs inferred)", () => {
    const taught = feltMutationLine(mut({ provenance: "user_stated", disclosure: "lives in LA" }));
    expect(taught).toBe(`Learned: lives in LA · ${MEMORY_SOURCE_MARKERS.user_stated}`);
    const inferred = feltMutationLine(
      mut({ provenance: "agent_inferred", disclosure: "early riser" }),
    );
    expect(inferred).toContain(MEMORY_SOURCE_MARKERS.agent_inferred);
    expect(taught).not.toBe(inferred);
  });

  it("feltCoverageStatus is honest — Verified only when covered, scoped to displayed changes", () => {
    const v = feltCoverageStatus(rec({ mutationsCoveredBySignature: true }));
    expect(v.label).toBe("Verified");
    expect(v.detail).toContain("displayed changes match the signed mutation manifest");
    expect(feltCoverageStatus(rec({ mutationsCoveredBySignature: false })).label).toBe("Local");
  });

  it("feltAssuranceGlyph never shows a placeholder for unsigned", () => {
    expect(feltAssuranceGlyph("anchored")).toBe("⚓");
    expect(feltAssuranceGlyph("signed")).toBe("✓");
    expect(feltAssuranceGlyph("unsigned")).toBe("");
  });
});
