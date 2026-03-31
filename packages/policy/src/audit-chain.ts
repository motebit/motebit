/**
 * Hash-chain integrity for the audit log.
 *
 * Each entry includes the hash of the previous entry, forming a tamper-evident
 * chain. Pattern: entry[n].hash = SHA256(canonical({previous_hash, ...entry[n].data}))
 *
 * Uses inline SHA-256 (crypto.subtle) and canonical JSON (sorted keys) to avoid
 * cross-layer dependencies — both are trivial utilities (< 10 lines each).
 */

// === Inline trivial utilities (layer boundary — no cross-layer import) ===

/**
 * Deterministic JSON with sorted keys. Matches @motebit/crypto's canonicalJson.
 * undefined values are explicitly serialized as null to prevent silent field erasure.
 */
function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

/** SHA-256 hex digest via crypto.subtle. */
async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// === Types ===

export const GENESIS_HASH = "genesis";

export interface AuditEntry {
  /** Unique entry identifier. */
  entry_id: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Event classification. */
  event_type: string;
  /** Identity of the acting agent or system. */
  actor_id: string;
  /** Arbitrary structured payload. */
  data: Record<string, unknown>;
  /** Hash of the previous entry, or "genesis" for the first entry. */
  previous_hash: string;
  /** SHA-256(previous_hash + canonical(entry data)). */
  hash: string;
}

/** Minimal storage interface — adapters implement this. */
export interface AuditChainStore {
  /** Append an entry to the chain. */
  append(entry: AuditEntry): Promise<void>;
  /** Return entries ordered by insertion (ascending). Optional range by index. */
  getEntries(from?: number, to?: number): Promise<AuditEntry[]>;
  /** Return the last entry, or undefined if empty. */
  getHead(): Promise<AuditEntry | undefined>;
  /** Total number of entries. */
  count(): Promise<number>;
}

// === In-memory adapter ===

export class InMemoryAuditChainStore implements AuditChainStore {
  private entries: AuditEntry[] = [];

  private clone(entry: AuditEntry): AuditEntry {
    return { ...entry, data: structuredClone(entry.data) };
  }

  append(entry: AuditEntry): Promise<void> {
    this.entries.push(this.clone(entry));
    return Promise.resolve();
  }

  getEntries(from?: number, to?: number): Promise<AuditEntry[]> {
    const start = from ?? 0;
    const end = to ?? this.entries.length;
    return Promise.resolve(this.entries.slice(start, end).map((e) => this.clone(e)));
  }

  getHead(): Promise<AuditEntry | undefined> {
    if (this.entries.length === 0) return Promise.resolve(undefined);
    return Promise.resolve(this.clone(this.entries[this.entries.length - 1]!));
  }

  count(): Promise<number> {
    return Promise.resolve(this.entries.length);
  }
}

// === Core operations ===

/**
 * Compute the hash for an entry given its previous hash and data fields.
 * Hash = SHA-256(canonical({previous_hash, entry_id, timestamp, event_type, actor_id, data}))
 *
 * previous_hash is included in the canonical input so that chain linkage
 * is covered by the hash — an attacker cannot reorder or remove entries
 * without detection.
 */
export async function computeEntryHash(
  previousHash: string,
  entry: Pick<AuditEntry, "entry_id" | "timestamp" | "event_type" | "actor_id" | "data">,
): Promise<string> {
  const payload = canonicalJson({
    previous_hash: previousHash,
    entry_id: entry.entry_id,
    timestamp: entry.timestamp,
    event_type: entry.event_type,
    actor_id: entry.actor_id,
    data: entry.data,
  });
  return sha256hex(payload);
}

/**
 * Append a new audit entry. Computes the hash chain link automatically.
 */
export async function appendAuditEntry(
  store: AuditChainStore,
  entry: Omit<AuditEntry, "previous_hash" | "hash">,
): Promise<AuditEntry> {
  if (!entry.entry_id) {
    throw new Error("entry_id must not be empty");
  }
  const head = await store.getHead();
  const previousHash = head?.hash ?? GENESIS_HASH;
  const hash = await computeEntryHash(previousHash, entry);

  const full: AuditEntry = {
    ...entry,
    previous_hash: previousHash,
    hash,
  };

  await store.append(full);
  return full;
}

/**
 * Verify the integrity of the audit chain (or a sub-range).
 *
 * Returns { valid: true } if all hashes match, or { valid: false, brokenAt }
 * with the index of the first broken entry.
 */
export async function verifyAuditChain(
  store: AuditChainStore,
  fromEntry?: number,
  toEntry?: number,
): Promise<{ valid: true } | { valid: false; brokenAt: number }> {
  const entries = await store.getEntries(fromEntry, toEntry);
  if (entries.length === 0) return { valid: true };

  const startIndex = fromEntry ?? 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // Determine expected previous hash
    let expectedPreviousHash: string;
    if (i === 0 && startIndex === 0) {
      // First entry in the full chain must reference genesis
      expectedPreviousHash = GENESIS_HASH;
    } else if (i === 0) {
      // Partial verification — trust the previous_hash of the first entry in range
      expectedPreviousHash = entry.previous_hash;
    } else {
      expectedPreviousHash = entries[i - 1]!.hash;
    }

    // Verify previous_hash linkage
    if (entry.previous_hash !== expectedPreviousHash) {
      return { valid: false, brokenAt: startIndex + i };
    }

    // Verify hash computation
    const computed = await computeEntryHash(entry.previous_hash, entry);
    if (entry.hash !== computed) {
      return { valid: false, brokenAt: startIndex + i };
    }
  }

  return { valid: true };
}

/**
 * Return the hash of the latest entry — useful for external anchoring.
 * Returns "genesis" if the chain is empty.
 */
export async function getChainHead(store: AuditChainStore): Promise<string> {
  const head = await store.getHead();
  return head?.hash ?? GENESIS_HASH;
}
