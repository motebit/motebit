import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  trustToDistance,
  idToHue,
  REMOTE_MIN_DISTANCE,
  REMOTE_MAX_DISTANCE,
  SpatialAdapter,
} from "@motebit/render-engine";
import { SpatialApp } from "../spatial-app";

// ---------------------------------------------------------------------------
// Pure logic: trustToDistance
// ---------------------------------------------------------------------------

describe("trustToDistance", () => {
  it("trust 0.0 → REMOTE_MAX_DISTANCE", () => {
    expect(trustToDistance(0.0)).toBeCloseTo(REMOTE_MAX_DISTANCE, 10);
  });

  it("trust 1.0 → REMOTE_MIN_DISTANCE", () => {
    expect(trustToDistance(1.0)).toBeCloseTo(REMOTE_MIN_DISTANCE, 10);
  });

  it("trust 0.5 → midpoint", () => {
    const mid = (REMOTE_MAX_DISTANCE + REMOTE_MIN_DISTANCE) / 2;
    expect(trustToDistance(0.5)).toBeCloseTo(mid, 5);
  });

  it("result never below REMOTE_MIN_DISTANCE", () => {
    expect(trustToDistance(1.0)).toBeGreaterThanOrEqual(REMOTE_MIN_DISTANCE);
    expect(trustToDistance(2.0)).toBeGreaterThanOrEqual(REMOTE_MIN_DISTANCE);
  });

  it("result never above REMOTE_MAX_DISTANCE", () => {
    expect(trustToDistance(0.0)).toBeLessThanOrEqual(REMOTE_MAX_DISTANCE);
    expect(trustToDistance(-1.0)).toBeLessThanOrEqual(REMOTE_MAX_DISTANCE);
  });

  it("monotonically decreasing — higher trust = closer", () => {
    expect(trustToDistance(0.25)).toBeGreaterThan(trustToDistance(0.75));
    expect(trustToDistance(0.0)).toBeGreaterThan(trustToDistance(0.5));
  });
});

// ---------------------------------------------------------------------------
// Pure logic: idToHue
// ---------------------------------------------------------------------------

describe("idToHue", () => {
  it("returns a value in [0, 360)", () => {
    const ids = ["abc", "00000000-0000-0000-0000-000000000000", "agent-alpha", "", "zzz"];
    for (const id of ids) {
      const hue = idToHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("is deterministic — same input always gives same output", () => {
    const id = "motebit-test-id-12345";
    expect(idToHue(id)).toBe(idToHue(id));
    expect(idToHue(id)).toBe(idToHue(id));
  });

  it("different IDs produce different hues (distribution test)", () => {
    const uuids = [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "b2c3d4e5-f6a7-8901-bcde-f01234567891",
      "c3d4e5f6-a7b8-9012-cdef-012345678902",
      "d4e5f6a7-b8c9-0123-defa-123456789013",
      "e5f6a7b8-c9d0-1234-efab-234567890124",
      "f6a7b8c9-d0e1-2345-fabc-345678901235",
      "07b8c9d0-e1f2-3456-abcd-456789012346",
      "18c9d0e1-f2a3-4567-bcde-567890123457",
      "29d0e1f2-a3b4-5678-cdef-678901234568",
      "3ae1f2a3-b4c5-6789-defa-789012345679",
    ];

    const hues = uuids.map(idToHue);
    const uniqueHues = new Set(hues);
    expect(uniqueHues.size).toBe(10);
  });

  it("handles empty string without throwing", () => {
    expect(() => idToHue("")).not.toThrow();
  });

  it("handles very long IDs", () => {
    const long = "x".repeat(1000);
    expect(() => idToHue(long)).not.toThrow();
    const hue = idToHue(long);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

// ---------------------------------------------------------------------------
// SpatialAdapter (headless) — physical travel presence model
// ---------------------------------------------------------------------------

describe("SpatialAdapter physical travel (headless)", () => {
  let adapter: SpatialAdapter;

  beforeEach(() => {
    adapter = new SpatialAdapter();
  });

  it("initial presence is home", () => {
    expect(adapter.getMainPresence()).toBe("home");
  });

  it("departCreature transitions to departing", () => {
    adapter.departCreature({ direction: { x: 0, y: 0, z: -1 } });
    expect(adapter.getMainPresence()).toBe("departing");
  });

  it("returnCreature transitions to returning", () => {
    adapter.departCreature();
    adapter.returnCreature();
    expect(adapter.getMainPresence()).toBe("returning");
  });

  it("arriveVisitor adds a visitor with correct trust score", () => {
    adapter.arriveVisitor("visitor-1", { motebitId: "visitor-1", trustScore: 0.8 });
    const visitors = adapter.getVisitors();
    expect(visitors.has("visitor-1")).toBe(true);
    expect(visitors.get("visitor-1")!.trustScore).toBe(0.8);
  });

  it("arriveVisitor sets initial presence to arriving", () => {
    adapter.arriveVisitor("visitor-1", { motebitId: "visitor-1", trustScore: 0.7 });
    expect(adapter.getVisitors().get("visitor-1")!.presence).toBe("arriving");
  });

  it("arriveVisitor is idempotent — duplicate call is ignored", () => {
    adapter.arriveVisitor("visitor-1", { motebitId: "visitor-1", trustScore: 0.8 });
    adapter.arriveVisitor("visitor-1", { motebitId: "visitor-1", trustScore: 0.5 });
    expect(adapter.getVisitors().size).toBe(1);
    expect(adapter.getVisitors().get("visitor-1")!.trustScore).toBe(0.8);
  });

  it("departVisitor transitions visitor to leaving", () => {
    adapter.arriveVisitor("visitor-1", { motebitId: "visitor-1", trustScore: 0.8 });
    adapter.departVisitor("visitor-1");
    expect(adapter.getVisitors().get("visitor-1")!.presence).toBe("leaving");
  });

  it("departVisitor is safe for unknown ID", () => {
    expect(() => adapter.departVisitor("nonexistent")).not.toThrow();
  });

  it("multiple visitors are tracked independently", () => {
    adapter.arriveVisitor("visitor-a", { motebitId: "visitor-a", trustScore: 0.9 });
    adapter.arriveVisitor("visitor-b", { motebitId: "visitor-b", trustScore: 0.3 });
    expect(adapter.getVisitors().size).toBe(2);
    expect(adapter.getVisitors().get("visitor-a")!.trustScore).toBe(0.9);
    expect(adapter.getVisitors().get("visitor-b")!.trustScore).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// SpatialApp integration — physical travel model
// ---------------------------------------------------------------------------

describe("SpatialApp physical travel integration", () => {
  let app: SpatialApp;

  const mockFetch = vi.fn();

  beforeEach(() => {
    app = new SpatialApp();
    vi.spyOn(app.adapter, "departCreature");
    vi.spyOn(app.adapter, "returnCreature");
    vi.spyOn(app.adapter, "arriveVisitor");
    vi.spyOn(app.adapter, "departVisitor");
    vi.spyOn(app.adapter, "getMainPresence");
    vi.spyOn(app.adapter, "getVisitors");
    vi.stubGlobal("fetch", mockFetch);
  });

  // 1. Departure flow
  it("delegation_departed triggers departure and sets presence away", async () => {
    await app._handlePresenceEvent({
      type: "delegation_departed",
      target_motebit_id: "target-agent-abc",
    });

    expect(app.adapter.departCreature).toHaveBeenCalledWith({ direction: { x: 0, y: 0, z: -1 } });
    expect(app.delegationPresence).toBe("away");
    expect(app.delegationTarget).toBe("target-agent-abc");
  });

  // 2. Visitor arrival with known trust
  it("delegation_arrived with Verified trust calls arriveVisitor with correct score", async () => {
    (
      app as unknown as {
        agentTrustStore: { getAgentTrust: () => Promise<{ trust_level: string }> };
      }
    ).agentTrustStore = {
      getAgentTrust: vi.fn().mockResolvedValue({ trust_level: "verified" }),
    };

    await app._handlePresenceEvent({
      type: "delegation_arrived",
      source_motebit_id: "visitor-xyz",
      task_description: "search for recent AI papers",
    });

    expect(app.adapter.arriveVisitor).toHaveBeenCalledWith(
      "visitor-xyz",
      expect.objectContaining({ motebitId: "visitor-xyz" }),
    );
    expect(app.visitors.has("visitor-xyz")).toBe(true);
    expect(app.visitors.get("visitor-xyz")!.taskDescription).toBe("search for recent AI papers");
  });

  // 3. Trust admission — Blocked agent → NOT rendered
  it("delegation_arrived from Blocked agent does NOT call arriveVisitor", async () => {
    (
      app as unknown as {
        agentTrustStore: { getAgentTrust: () => Promise<{ trust_level: string }> };
      }
    ).agentTrustStore = {
      getAgentTrust: vi.fn().mockResolvedValue({ trust_level: "blocked" }),
    };

    await app._handlePresenceEvent({
      type: "delegation_arrived",
      source_motebit_id: "blocked-agent",
    });

    expect(app.adapter.arriveVisitor).not.toHaveBeenCalled();
    expect(app.visitors.has("blocked-agent")).toBe(false);
  });

  // 4. Return flow
  it("delegation_returning triggers return and sets presence home", async () => {
    await app._handlePresenceEvent({
      type: "delegation_departed",
      target_motebit_id: "some-agent",
    });
    expect(app.delegationPresence).toBe("away");

    await app._handlePresenceEvent({ type: "delegation_returning" });

    expect(app.adapter.returnCreature).toHaveBeenCalledWith({
      fromDirection: { x: 0, y: 0, z: -1 },
    });
    expect(app.delegationPresence).toBe("home");
    expect(app.delegationTarget).toBeNull();
  });

  // 5. Visitor departure
  it("delegation_visitor_departing calls departVisitor and removes visitor", async () => {
    (
      app as unknown as {
        agentTrustStore: { getAgentTrust: () => Promise<{ trust_level: string }> };
      }
    ).agentTrustStore = {
      getAgentTrust: vi.fn().mockResolvedValue({ trust_level: "verified" }),
    };

    await app._handlePresenceEvent({
      type: "delegation_arrived",
      source_motebit_id: "visitor-abc",
    });
    expect(app.visitors.has("visitor-abc")).toBe(true);

    await app._handlePresenceEvent({
      type: "delegation_visitor_departing",
      source_motebit_id: "visitor-abc",
    });

    expect(app.adapter.departVisitor).toHaveBeenCalledWith("visitor-abc");
    expect(app.visitors.has("visitor-abc")).toBe(false);
  });

  // 6. Full round trip
  it("full round trip: depart → away → return → home, all states correct", async () => {
    expect(app.delegationPresence).toBe("home");

    await app._handlePresenceEvent({ type: "delegation_departed", target_motebit_id: "agent-x" });
    expect(app.delegationPresence).toBe("away");
    expect(app.delegationTarget).toBe("agent-x");

    await app._handlePresenceEvent({ type: "delegation_returning" });
    expect(app.delegationPresence).toBe("home");
    expect(app.delegationTarget).toBeNull();

    expect(app.adapter.departCreature).toHaveBeenCalledTimes(1);
    expect(app.adapter.returnCreature).toHaveBeenCalledTimes(1);
  });

  // 7. Unknown agent falls back to Unknown trust — visible but faint
  it("delegation_arrived with no trust store renders visitor at Unknown trust score", async () => {
    (app as unknown as { agentTrustStore: null }).agentTrustStore = null;

    await app._handlePresenceEvent({
      type: "delegation_arrived",
      source_motebit_id: "unknown-visitor",
    });

    // Unknown trust is non-zero (AgentTrustLevel.Unknown → ~0.1)
    expect(app.adapter.arriveVisitor).toHaveBeenCalled();
    expect(app.visitors.has("unknown-visitor")).toBe(true);
    const visitor = app.visitors.get("unknown-visitor")!;
    expect(visitor.trustScore).toBeGreaterThan(0);
    expect(visitor.trustScore).toBeLessThan(0.3);
  });

  // 8. Inbound task: visitor arrives processing, then departs when done
  it("inbound task flow: visitor arrives, task executes, visitor departs", async () => {
    (
      app as unknown as {
        agentTrustStore: { getAgentTrust: () => Promise<{ trust_level: string }> };
      }
    ).agentTrustStore = {
      getAgentTrust: vi.fn().mockResolvedValue({ trust_level: "trusted" }),
    };

    // Visitor arrives with a task
    await app._handlePresenceEvent({
      type: "delegation_arrived",
      source_motebit_id: "task-carrier",
      task_description: "summarise the docs",
    });
    expect(app.visitors.has("task-carrier")).toBe(true);
    expect(app.visitors.get("task-carrier")!.taskDescription).toBe("summarise the docs");

    // Relay signals the visitor's work is done
    await app._handlePresenceEvent({
      type: "delegation_visitor_departing",
      source_motebit_id: "task-carrier",
    });
    expect(app.adapter.departVisitor).toHaveBeenCalledWith("task-carrier");
    expect(app.visitors.has("task-carrier")).toBe(false);
  });

  // 9. Adapter exposes physical travel API
  it("SpatialApp exposes the adapter with physical travel methods", () => {
    expect(typeof app.adapter.departCreature).toBe("function");
    expect(typeof app.adapter.returnCreature).toBe("function");
    expect(typeof app.adapter.arriveVisitor).toBe("function");
    expect(typeof app.adapter.departVisitor).toBe("function");
    expect(typeof app.adapter.getMainPresence).toBe("function");
    expect(typeof app.adapter.getVisitors).toBe("function");
  });

  // 10. Dispose cleans up correctly
  it("dispose cleans up correctly", () => {
    const disposeSpy = vi.spyOn(app.adapter, "dispose");
    app.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });
});
