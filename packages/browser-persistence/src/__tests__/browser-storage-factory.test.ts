import { describe, it, expect } from "vitest";
import { createBrowserStorage } from "../index.js";

describe("createBrowserStorage", () => {
  it("returns object with all required adapter fields", async () => {
    const storage = await createBrowserStorage();

    expect(storage.eventStore).toBeDefined();
    expect(storage.memoryStorage).toBeDefined();
    expect(storage.identityStorage).toBeDefined();
    expect(storage.auditLog).toBeDefined();
    expect(storage.stateSnapshot).toBeDefined();
    expect(storage.conversationStore).toBeDefined();
    expect(storage.planStore).toBeDefined();
    expect(storage.agentTrustStore).toBeDefined();
    expect(storage.gradientStore).toBeDefined();
    expect(storage.serviceListingStore).toBeDefined();
    expect(storage.budgetAllocationStore).toBeDefined();
    expect(storage.settlementStore).toBeDefined();
    expect(storage.latencyStatsStore).toBeDefined();
    expect(storage.credentialStore).toBeDefined();
  });
});
