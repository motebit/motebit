import { describe, it, expect } from "vitest";
import {
  SPECIES_CONSTRAINTS,
  TrustMode,
  BatteryMode,
  SensitivityLevel,
  EventType,
  RelationType,
} from "../index";
import type {
  MotebitIdentity,
  MotebitState,
  BehaviorCues,
  MemoryNode,
  EventLogEntry,
  ExportManifest,
  SyncCursor,
  ConflictEdge,
} from "../index";

// ---------------------------------------------------------------------------
// SPECIES_CONSTRAINTS
// ---------------------------------------------------------------------------

describe("SPECIES_CONSTRAINTS", () => {
  it("has the correct MAX_AROUSAL value", () => {
    expect(SPECIES_CONSTRAINTS.MAX_AROUSAL).toBe(0.35);
  });

  it("has the correct SMILE_DELTA_MAX value", () => {
    expect(SPECIES_CONSTRAINTS.SMILE_DELTA_MAX).toBe(0.04);
  });

  it("has the correct GLOW_DELTA_MAX value", () => {
    expect(SPECIES_CONSTRAINTS.GLOW_DELTA_MAX).toBe(0.15);
  });

  it("has the correct DRIFT_VARIATION_MAX value", () => {
    expect(SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX).toBe(0.1);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(SPECIES_CONSTRAINTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

describe("TrustMode enum", () => {
  it("has expected values", () => {
    expect(TrustMode.Full).toBe("full");
    expect(TrustMode.Guarded).toBe("guarded");
    expect(TrustMode.Minimal).toBe("minimal");
  });
});

describe("BatteryMode enum", () => {
  it("has expected values", () => {
    expect(BatteryMode.Normal).toBe("normal");
    expect(BatteryMode.LowPower).toBe("low_power");
    expect(BatteryMode.Critical).toBe("critical");
  });
});

describe("SensitivityLevel enum", () => {
  it("has expected values", () => {
    expect(SensitivityLevel.None).toBe("none");
    expect(SensitivityLevel.Personal).toBe("personal");
    expect(SensitivityLevel.Medical).toBe("medical");
    expect(SensitivityLevel.Financial).toBe("financial");
    expect(SensitivityLevel.Secret).toBe("secret");
  });
});

describe("EventType enum", () => {
  it("has all expected event types", () => {
    expect(EventType.IdentityCreated).toBe("identity_created");
    expect(EventType.StateUpdated).toBe("state_updated");
    expect(EventType.MemoryFormed).toBe("memory_formed");
    expect(EventType.MemoryDecayed).toBe("memory_decayed");
    expect(EventType.MemoryDeleted).toBe("memory_deleted");
    expect(EventType.MemoryAccessed).toBe("memory_accessed");
    expect(EventType.ProviderSwapped).toBe("provider_swapped");
    expect(EventType.ExportRequested).toBe("export_requested");
    expect(EventType.DeleteRequested).toBe("delete_requested");
    expect(EventType.SyncCompleted).toBe("sync_completed");
    expect(EventType.AuditEntry).toBe("audit_entry");
  });
});

describe("RelationType enum", () => {
  it("has expected values", () => {
    expect(RelationType.Related).toBe("related");
    expect(RelationType.CausedBy).toBe("caused_by");
    expect(RelationType.FollowedBy).toBe("followed_by");
    expect(RelationType.ConflictsWith).toBe("conflicts_with");
    expect(RelationType.Reinforces).toBe("reinforces");
    expect(RelationType.PartOf).toBe("part_of");
  });
});

// ---------------------------------------------------------------------------
// Type construction checks (compile-time + runtime shape validation)
// ---------------------------------------------------------------------------

describe("Type construction", () => {
  it("constructs a valid MotebitIdentity", () => {
    const identity: MotebitIdentity = {
      motebit_id: "test-id",
      created_at: Date.now(),
      owner_id: "owner-1",
      version_clock: 0,
    };
    expect(identity.motebit_id).toBe("test-id");
    expect(identity.version_clock).toBe(0);
  });

  it("constructs a valid MotebitState", () => {
    const state: MotebitState = {
      attention: 0.5,
      processing: 0.3,
      confidence: 0.7,
      affect_valence: -0.2,
      affect_arousal: 0.1,
      social_distance: 0.4,
      curiosity: 0.6,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    };
    expect(state.attention).toBe(0.5);
    expect(state.trust_mode).toBe(TrustMode.Guarded);
  });

  it("constructs a valid BehaviorCues", () => {
    const cues: BehaviorCues = {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0.3,
      eye_dilation: 0.3,
      smile_curvature: 0,
    };
    expect(cues.hover_distance).toBe(0.4);
  });

  it("constructs a valid MemoryNode", () => {
    const node: MemoryNode = {
      node_id: "n1",
      motebit_id: "m1",
      content: "hello",
      embedding: [0.1, 0.2],
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 7 * 24 * 60 * 60 * 1000,
      tombstoned: false,
      pinned: false,
    };
    expect(node.tombstoned).toBe(false);
  });

  it("constructs a valid EventLogEntry", () => {
    const entry: EventLogEntry = {
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { key: "value" },
      version_clock: 1,
      tombstoned: false,
    };
    expect(entry.event_type).toBe(EventType.StateUpdated);
  });

  it("constructs a valid SyncCursor", () => {
    const cursor: SyncCursor = {
      motebit_id: "m1",
      last_event_id: "e1",
      last_version_clock: 5,
    };
    expect(cursor.last_version_clock).toBe(5);
  });

  it("constructs a valid ConflictEdge", () => {
    const localEvent: EventLogEntry = {
      event_id: "e1",
      motebit_id: "m1",
      timestamp: 100,
      event_type: EventType.StateUpdated,
      payload: {},
      version_clock: 1,
      tombstoned: false,
    };
    const remoteEvent: EventLogEntry = {
      event_id: "e2",
      motebit_id: "m1",
      timestamp: 101,
      event_type: EventType.StateUpdated,
      payload: {},
      version_clock: 1,
      tombstoned: false,
    };
    const conflict: ConflictEdge = {
      local_event: localEvent,
      remote_event: remoteEvent,
      resolution: "unresolved",
    };
    expect(conflict.resolution).toBe("unresolved");
  });

  it("constructs a valid ExportManifest", () => {
    const manifest: ExportManifest = {
      motebit_id: "m1",
      exported_at: Date.now(),
      identity: {
        motebit_id: "m1",
        created_at: Date.now(),
        owner_id: "owner",
        version_clock: 0,
      },
      memories: [],
      edges: [],
      events: [],
      audit_log: [],
    };
    expect(manifest.memories).toHaveLength(0);
  });
});
