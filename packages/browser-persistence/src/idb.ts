/**
 * IndexedDB database open + schema + helpers.
 *
 * Opens the "motebit" database with object stores for events, memory nodes,
 * memory edges, identities, devices, and audit log.
 */

const DB_VERSION = 8;

export function openMotebitDB(dbName = "motebit"): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Events
      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", { keyPath: "event_id" });
        events.createIndex("motebit_clock", ["motebit_id", "version_clock"]);
        events.createIndex("motebit_time", ["motebit_id", "timestamp"]);
      }

      // Memory nodes
      if (!db.objectStoreNames.contains("memory_nodes")) {
        const nodes = db.createObjectStore("memory_nodes", { keyPath: "node_id" });
        nodes.createIndex("motebit_id", "motebit_id");
      }

      // Memory edges
      if (!db.objectStoreNames.contains("memory_edges")) {
        const edges = db.createObjectStore("memory_edges", { keyPath: "edge_id" });
        edges.createIndex("source_id", "source_id");
        edges.createIndex("target_id", "target_id");
      }

      // Identities
      if (!db.objectStoreNames.contains("identities")) {
        const identities = db.createObjectStore("identities", { keyPath: "motebit_id" });
        identities.createIndex("owner_id", "owner_id");
      }

      // Devices
      if (!db.objectStoreNames.contains("devices")) {
        const devices = db.createObjectStore("devices", { keyPath: "device_id" });
        devices.createIndex("device_token", "device_token", { unique: true });
        devices.createIndex("motebit_id", "motebit_id");
      }

      // Audit log
      if (!db.objectStoreNames.contains("audit_log")) {
        const audit = db.createObjectStore("audit_log", { keyPath: "audit_id" });
        audit.createIndex("motebit_time", ["motebit_id", "timestamp"]);
      }

      // Conversations
      if (!db.objectStoreNames.contains("conversations")) {
        const convs = db.createObjectStore("conversations", { keyPath: "conversationId" });
        convs.createIndex("motebit_id", "motebitId");
      }

      // Conversation messages
      if (!db.objectStoreNames.contains("conversation_messages")) {
        const msgs = db.createObjectStore("conversation_messages", { keyPath: "messageId" });
        msgs.createIndex("conversation_id", "conversationId");
      }

      // Plans
      if (!db.objectStoreNames.contains("plans")) {
        const plans = db.createObjectStore("plans", { keyPath: "plan_id" });
        plans.createIndex("goal_id", "goal_id");
        plans.createIndex("motebit_id", "motebit_id");
      }

      // Plan steps
      if (!db.objectStoreNames.contains("plan_steps")) {
        const steps = db.createObjectStore("plan_steps", { keyPath: "step_id" });
        steps.createIndex("plan_id", "plan_id");
      }

      // Agent trust
      if (!db.objectStoreNames.contains("agent_trust")) {
        const trust = db.createObjectStore("agent_trust", {
          keyPath: ["motebit_id", "remote_motebit_id"],
        });
        trust.createIndex("motebit_id", "motebit_id");
      }

      // Gradient snapshots
      if (!db.objectStoreNames.contains("gradient_snapshots")) {
        const grad = db.createObjectStore("gradient_snapshots", {
          autoIncrement: true,
        });
        grad.createIndex("motebit_time", ["motebit_id", "timestamp"]);
      }

      // Service listings
      if (!db.objectStoreNames.contains("service_listings")) {
        const listings = db.createObjectStore("service_listings", { keyPath: "listing_id" });
        listings.createIndex("motebit_id", "motebit_id");
      }

      // Budget allocations
      if (!db.objectStoreNames.contains("budget_allocations")) {
        const allocs = db.createObjectStore("budget_allocations", { keyPath: "allocation_id" });
        allocs.createIndex("goal_id", "goal_id");
      }

      // Settlements
      if (!db.objectStoreNames.contains("settlements")) {
        const settlements = db.createObjectStore("settlements", { keyPath: "settlement_id" });
        settlements.createIndex("allocation_id", "allocation_id");
      }

      // Latency stats
      if (!db.objectStoreNames.contains("latency_stats")) {
        const latency = db.createObjectStore("latency_stats", { autoIncrement: true });
        latency.createIndex("motebit_remote", ["motebit_id", "remote_motebit_id"]);
      }

      // Approvals
      if (!db.objectStoreNames.contains("approvals")) {
        db.createObjectStore("approvals", { keyPath: "approval_id" });
      }

      // Tool audit
      if (!db.objectStoreNames.contains("tool_audit")) {
        const toolAudit = db.createObjectStore("tool_audit", { autoIncrement: true });
        toolAudit.createIndex("turnId", "turnId");
        toolAudit.createIndex("runId", "runId");
        toolAudit.createIndex("timestamp", "timestamp");
      }

      // Issued credentials
      if (!db.objectStoreNames.contains("issued_credentials")) {
        const creds = db.createObjectStore("issued_credentials", { keyPath: "credential_id" });
        creds.createIndex("subject", "subject_motebit_id");
        creds.createIndex("type", "credential_type");
      }

      // Skills — installed procedural-knowledge bundles per
      // `spec/skills-v1.md`. The IDB row holds the bytes the desktop
      // sidecar otherwise stores at `~/.motebit/skills/<name>/`. Schema
      // mirrors the StoredSkill shape from `@motebit/skills/storage`.
      // Single store keyed by `name`. Insertion order is preserved for
      // `list()` to match the fs adapter's `installed.json` semantics.
      if (!db.objectStoreNames.contains("skills")) {
        db.createObjectStore("skills", { keyPath: "name" });
      }

      // Skill audit log — append-only stream of `SkillAuditEvent` per
      // `@motebit/skills`. Holds `skill_trust_grant` / `skill_remove` /
      // `skill_consent_granted` entries emitted by the registry and the
      // panels-side `RegistryBackedSkillsPanelAdapter`. Auto-increment
      // `audit_id` keypath; index by skill_name + at for retrospective
      // queries ("did the user approve installing X on this surface?").
      // Sibling of the existing `tool_audit` store — same append-only
      // shape, separate domain.
      if (!db.objectStoreNames.contains("skill_audit")) {
        const skillAudit = db.createObjectStore("skill_audit", { autoIncrement: true });
        skillAudit.createIndex("skill_name", "skill_name");
        skillAudit.createIndex("at", "at");
        skillAudit.createIndex("type", "type");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IDB open failed"));
  });
}

/** Promise wrapper for IDBRequest. Handles sync completion in headless browsers. */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  // If the request already completed synchronously, resolve immediately.
  // This can happen in headless Chromium on empty/cached databases.
  if (req.readyState === "done") {
    return req.error ? Promise.reject(req.error) : Promise.resolve(req.result);
  }
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB request failed"));
  });
}

/** Promise that resolves on transaction complete, rejects on error. */
export function idbTransaction(tx: IDBTransaction): Promise<void> {
  if (tx.error) return Promise.reject(tx.error);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transaction error"));
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}
