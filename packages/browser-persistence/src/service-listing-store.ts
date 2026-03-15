import type { ServiceListingStoreAdapter } from "@motebit/sdk";
import type { AgentServiceListing } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed ServiceListingStore.
 *
 * All ServiceListingStoreAdapter methods are async, so direct IDB reads/writes
 * are fine — no cache needed.
 */
export class IdbServiceListingStore implements ServiceListingStoreAdapter {
  constructor(private db: IDBDatabase) {}

  async get(motebitId: string): Promise<AgentServiceListing | null> {
    const tx = this.db.transaction("service_listings", "readonly");
    const store = tx.objectStore("service_listings");
    const index = store.index("motebit_id");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- IDB .get() returns any
    const result = await idbRequest(index.get(motebitId));
    return (result as AgentServiceListing | undefined) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fire-and-forget IDB put
  async set(listing: AgentServiceListing): Promise<void> {
    const tx = this.db.transaction("service_listings", "readwrite");
    tx.objectStore("service_listings").put({ ...listing });
  }

  async list(): Promise<AgentServiceListing[]> {
    const tx = this.db.transaction("service_listings", "readonly");
    const store = tx.objectStore("service_listings");
    const records = (await idbRequest(store.getAll())) as AgentServiceListing[];
    return records.sort((a, b) => b.updated_at - a.updated_at);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fire-and-forget IDB delete
  async delete(listingId: string): Promise<void> {
    const tx = this.db.transaction("service_listings", "readwrite");
    tx.objectStore("service_listings").delete(listingId);
  }
}
