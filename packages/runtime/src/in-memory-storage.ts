// === In-Memory Storage Factory ===

import { InMemoryEventStore } from "@motebit/event-log";
import { InMemoryMemoryStorage } from "@motebit/memory-graph";
import { InMemoryIdentityStorage } from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import type { StorageAdapters } from "@motebit/sdk";
import { InMemoryAgentTrustStore } from "./in-memory-agent-trust-store.js";

export function createInMemoryStorage(): StorageAdapters {
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
    agentTrustStore: new InMemoryAgentTrustStore(),
  };
}
