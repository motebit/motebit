/**
 * IndexedDB database open + schema + helpers.
 *
 * Opens the "motebit" database with object stores for events, memory nodes,
 * memory edges, identities, devices, and audit log.
 */

const DB_VERSION = 2;

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
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Promise wrapper for IDBRequest. */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promise that resolves on transaction complete, rejects on error. */
export function idbTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}
