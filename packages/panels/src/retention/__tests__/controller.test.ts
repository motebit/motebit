import { describe, it, expect } from "vitest";
import {
  createRetentionController,
  summarizeRetentionCeilings,
  type RetentionFetchAdapter,
  type RetentionManifest,
  type TransparencyManifestSummary,
} from "../controller";

// ── Helpers ───────────────────────────────────────────────────────────

const KEY_HEX = "a".repeat(64);

function makeManifest(overrides: Partial<RetentionManifest> = {}): RetentionManifest {
  return {
    spec: "motebit/retention-manifest@1",
    operator_id: "relay.motebit.com",
    issued_at: 1000,
    stores: [
      {
        store_id: "memory",
        store_name: "Memory",
        shape: {
          kind: "mutable_pruning",
          max_retention_days_by_sensitivity: {
            none: Infinity,
            personal: 365,
            medical: 90,
            financial: 90,
            secret: 30,
          },
        },
      },
    ],
    suite: "motebit-jcs-ed25519-hex-v1",
    signature: "f".repeat(128),
    ...overrides,
  };
}

function makeAdapter(opts: {
  transparency?: TransparencyManifestSummary | null;
  manifest?: RetentionManifest | null;
  verifyResult?: { valid: boolean; errors: ReadonlyArray<string> };
  fetchTransparencyThrows?: Error;
  fetchManifestThrows?: Error;
  verifyThrows?: Error;
}): RetentionFetchAdapter {
  return {
    fetchTransparency: async () => {
      if (opts.fetchTransparencyThrows !== undefined) throw opts.fetchTransparencyThrows;
      return opts.transparency === undefined
        ? { relay_id: "relay.motebit.com", relay_public_key: KEY_HEX }
        : opts.transparency;
    },
    fetchRetentionManifest: async () => {
      if (opts.fetchManifestThrows !== undefined) throw opts.fetchManifestThrows;
      return opts.manifest === undefined ? makeManifest() : opts.manifest;
    },
    verifyManifest: async () => {
      if (opts.verifyThrows !== undefined) throw opts.verifyThrows;
      return opts.verifyResult ?? { valid: true, errors: [] };
    },
  };
}

// ── Verification status state machine ─────────────────────────────────

describe("RetentionController — verification status", () => {
  it("initial state is `idle` with no manifest", () => {
    const ctrl = createRetentionController(makeAdapter({}));
    const s = ctrl.getState();
    expect(s.verification).toBe("idle");
    expect(s.manifest).toBeNull();
    expect(s.operatorPublicKey).toBeNull();
  });

  it("verified status when both manifests fetch and signature checks", async () => {
    const ctrl = createRetentionController(makeAdapter({}));
    await ctrl.refresh();
    const s = ctrl.getState();
    expect(s.verification).toBe("verified");
    expect(s.manifest?.operator_id).toBe("relay.motebit.com");
    expect(s.operatorPublicKey).toBe(KEY_HEX);
    expect(s.fetchedAt).not.toBeNull();
  });

  it("invalid status when verifier returns valid: false", async () => {
    const ctrl = createRetentionController(
      makeAdapter({
        verifyResult: { valid: false, errors: ["signature mismatch"] },
      }),
    );
    await ctrl.refresh();
    const s = ctrl.getState();
    expect(s.verification).toBe("invalid");
    expect(s.errors).toContain("signature mismatch");
    // Manifest is preserved on `invalid` so a surface can show what was
    // claimed even though the signature didn't verify.
    expect(s.manifest).not.toBeNull();
  });

  it("unreachable status when transparency manifest is null", async () => {
    const ctrl = createRetentionController(makeAdapter({ transparency: null }));
    await ctrl.refresh();
    const s = ctrl.getState();
    expect(s.verification).toBe("unreachable");
    expect(s.errors[0]).toContain("transparency");
    expect(s.manifest).toBeNull();
    expect(s.operatorPublicKey).toBeNull();
  });

  it("unreachable status when retention manifest is null", async () => {
    const ctrl = createRetentionController(makeAdapter({ manifest: null }));
    await ctrl.refresh();
    const s = ctrl.getState();
    expect(s.verification).toBe("unreachable");
    expect(s.errors[0]).toContain("retention");
    // Operator id + key still surfaced from the successful transparency fetch.
    expect(s.operatorPublicKey).toBe(KEY_HEX);
  });

  it("unreachable status when transparency fetch throws", async () => {
    const ctrl = createRetentionController(
      makeAdapter({ fetchTransparencyThrows: new Error("network down") }),
    );
    await ctrl.refresh();
    const s = ctrl.getState();
    expect(s.verification).toBe("unreachable");
    expect(s.errors[0]).toContain("network down");
  });

  it("invalid status when verifier itself throws — fail-closed", async () => {
    const ctrl = createRetentionController(
      makeAdapter({ verifyThrows: new Error("bad pubkey hex") }),
    );
    await ctrl.refresh();
    expect(ctrl.getState().verification).toBe("invalid");
    expect(ctrl.getState().errors[0]).toContain("bad pubkey hex");
  });

  it("loading status fires through subscribers during refresh", async () => {
    const ctrl = createRetentionController(makeAdapter({}));
    const seen: string[] = [];
    ctrl.subscribe((s) => seen.push(s.verification));
    await ctrl.refresh();
    expect(seen).toContain("loading");
    expect(seen[seen.length - 1]).toBe("verified");
  });
});

// ── summarizeRetentionCeilings ────────────────────────────────────────

describe("summarizeRetentionCeilings", () => {
  it("returns per-sensitivity ceilings sorted strictest-first", () => {
    const summary = summarizeRetentionCeilings(makeManifest());
    // none = Infinity → null; finite tiers sorted ascending: secret (30), medical (90), financial (90), personal (365).
    expect(summary.map((s) => s.sensitivity)).toEqual([
      "secret",
      "medical",
      "financial",
      "personal",
      "none",
    ]);
    expect(summary.find((s) => s.sensitivity === "secret")?.days).toBe(30);
    expect(summary.find((s) => s.sensitivity === "none")?.days).toBeNull();
  });

  it("walks every mutable_pruning store and takes the strictest ceiling per tier", () => {
    const m = makeManifest({
      stores: [
        {
          store_id: "memory",
          store_name: "Memory",
          shape: {
            kind: "mutable_pruning",
            max_retention_days_by_sensitivity: { medical: 90, secret: 60 },
          },
        },
        {
          store_id: "second_memory",
          store_name: "Second",
          shape: {
            kind: "mutable_pruning",
            max_retention_days_by_sensitivity: { medical: 30, secret: 90 },
          },
        },
      ],
    });
    const summary = summarizeRetentionCeilings(m);
    expect(summary.find((s) => s.sensitivity === "medical")?.days).toBe(30);
    expect(summary.find((s) => s.sensitivity === "secret")?.days).toBe(60);
  });

  it("ignores append_only_horizon and consolidation_flush stores (no per-sensitivity ceiling)", () => {
    const m = makeManifest({
      stores: [
        {
          store_id: "event_log",
          store_name: "Event log",
          shape: {
            kind: "append_only_horizon",
            horizon_advance_period_days: 365,
            witness_required: false,
          },
        },
        {
          store_id: "memory",
          store_name: "Memory",
          shape: {
            kind: "mutable_pruning",
            max_retention_days_by_sensitivity: { medical: 90 },
          },
        },
        {
          store_id: "conversation_messages",
          store_name: "Conversations",
          shape: {
            kind: "consolidation_flush",
            flush_to: "expire",
            has_min_floor_resolver: false,
          },
        },
      ],
    });
    const summary = summarizeRetentionCeilings(m);
    // Only the mutable_pruning store contributes.
    expect(summary).toHaveLength(1);
    expect(summary[0]?.sensitivity).toBe("medical");
    expect(summary[0]?.days).toBe(90);
  });
});
