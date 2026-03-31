import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbServiceListingStore } from "../service-listing-store.js";
import type { AgentServiceListing } from "@motebit/sdk";
import { asListingId, asMotebitId } from "@motebit/sdk";

describe("IdbServiceListingStore", () => {
  let store: IdbServiceListingStore;

  function makeListing(overrides: Partial<AgentServiceListing> = {}): AgentServiceListing {
    return {
      listing_id: asListingId(crypto.randomUUID()),
      motebit_id: asMotebitId("m-service-1"),
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "Test service",
      updated_at: Date.now(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-listing-${crypto.randomUUID()}`);
    store = new IdbServiceListingStore(db);
  });

  it("get returns null for missing motebitId", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("set + get round-trip", async () => {
    const listing = makeListing();
    await store.set(listing);

    await new Promise((r) => setTimeout(r, 50));

    const retrieved = await store.get(listing.motebit_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.listing_id).toBe(listing.listing_id);
    expect(retrieved!.description).toBe("Test service");
    expect(retrieved!.capabilities).toEqual(["web_search"]);
  });

  it("list sorts by updated_at DESC", async () => {
    const l1 = makeListing({
      listing_id: asListingId("l1"),
      motebit_id: asMotebitId("m-1"),
      updated_at: 1000,
    });
    const l2 = makeListing({
      listing_id: asListingId("l2"),
      motebit_id: asMotebitId("m-2"),
      updated_at: 3000,
    });
    const l3 = makeListing({
      listing_id: asListingId("l3"),
      motebit_id: asMotebitId("m-3"),
      updated_at: 2000,
    });

    await store.set(l1);
    await store.set(l2);
    await store.set(l3);

    await new Promise((r) => setTimeout(r, 50));

    const results = await store.list();
    expect(results).toHaveLength(3);
    expect(results[0]!.listing_id).toBe("l2"); // 3000
    expect(results[1]!.listing_id).toBe("l3"); // 2000
    expect(results[2]!.listing_id).toBe("l1"); // 1000
  });

  it("delete removes listing", async () => {
    const listing = makeListing();
    await store.set(listing);

    await new Promise((r) => setTimeout(r, 50));

    await store.delete(listing.listing_id);

    await new Promise((r) => setTimeout(r, 50));

    const results = await store.list();
    expect(results).toHaveLength(0);
  });
});
