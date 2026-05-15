/**
 * Re-key memory-shaped IDB stores from one `motebit_id` to another.
 *
 * The `preserveMemories=true` option on the restore flow (see
 * `docs/doctrine/identity-restore.md`) migrates the user's
 * accumulated conversations, semantic memory, plans, and per-peer
 * trust under the restored identity. The four stores re-keyed here
 * are the ones a user means when they say "preserve my memories" —
 * the content the agent has gathered about the world, not the
 * cryptographically-signed audit / event trail that names the prior
 * `motebit_id` in its body.
 *
 * **Why these four and not others:**
 *
 *   - `conversations` (`motebitId` camelCase field) — chat history
 *   - `memory_nodes` (`motebit_id`) — semantic-memory rows; the
 *     edges store has no `motebit_id` field, it joins via
 *     `source_id` / `target_id` so it follows naturally
 *   - `plans` (`motebit_id`) — execution-history rows; plan_steps
 *     follows via `plan_id`
 *   - `agent_trust` (composite PK `[motebit_id, remote_motebit_id]`)
 *     — accumulated trust toward other agents
 *
 * **Why NOT re-keyed** — these stores are intentionally orphaned
 * because re-keying would break the signing-chain integrity that
 * `docs/doctrine/receipts-unified.md` mandates:
 *
 *   - `events` — signed, append-only; an `event_type:
 *     IdentityCreated` for the prior motebit_id is true at the time
 *     of signing and stays true under sync replay
 *   - `audit_log` — signed
 *   - `issued_credentials` — signed claims about the old subject
 *   - `identities` (the old motebit_id row) — kept as historical
 *     marker; the user explicitly chose to replace it
 *   - `devices` — the old device registration belongs to the old
 *     identity
 *
 * The split is doctrinal, not arbitrary. Memory survives because
 * it's content; the signed trail orphans because its cryptographic
 * meaning is tied to the prior identity.
 *
 * **Collision behavior.** This helper assumes the destination
 * `newMotebitId` has no pre-existing rows in any of these four
 * stores (the common case: restoring an identity onto a device
 * whose identity was just re-minted as part of the same flow, so
 * the destination motebit_id was freshly synthesized). If
 * collisions are present (the unusual case: restoring onto a
 * device that already held data under the destination motebit_id),
 * IDB's `put` semantics replace by key for the simple-keyed stores
 * (conversations / memory_nodes / plans) — the migrated rows
 * overwrite. For `agent_trust`'s composite key, the cursor's
 * delete + new-record put rebuilds entries cleanly.
 *
 * Sibling-boundary: same migration shape lives in
 * `apps/desktop/src/index.ts` and `apps/mobile/src/mobile-app.ts`
 * as SQL `UPDATE`s on the same four logical tables. Each surface's
 * own primitive is tested separately because the storage layer
 * differs; the cross-surface contract is just "re-key these four
 * stores."
 */

import { openMotebitDB, idbRequest, idbTransaction } from "./idb.js";

interface MotebitIdCarrier {
  motebit_id?: string;
  /** Conversations use camelCase for historical IDB schema reasons. */
  motebitId?: string;
}

/**
 * The four stores carrying `motebit_id` (or `motebitId`) as a field
 * the user's content lives under. Order is intentional — events /
 * audit / credentials / identities / devices are NOT in this list
 * by design (see the file doc above).
 */
const REKEYED_STORES: ReadonlyArray<{
  name: string;
  fieldName: "motebit_id" | "motebitId";
}> = [
  { name: "conversations", fieldName: "motebitId" },
  { name: "memory_nodes", fieldName: "motebit_id" },
  { name: "plans", fieldName: "motebit_id" },
  { name: "agent_trust", fieldName: "motebit_id" },
];

/**
 * Re-key the four memory-shaped IDB stores from `oldMotebitId` to
 * `newMotebitId`. Atomic per-store transaction; if any store fails
 * the rest still attempt (best-effort migration). Returns a tuple
 * of per-store counts so the caller can log or surface migration
 * stats. A no-op when `oldMotebitId === newMotebitId`.
 */
export async function migrateMotebitId(
  oldMotebitId: string,
  newMotebitId: string,
  dbName?: string,
): Promise<{ store: string; rekeyed: number }[]> {
  if (oldMotebitId === newMotebitId) return [];
  const db = await openMotebitDB(dbName);
  const results: { store: string; rekeyed: number }[] = [];
  try {
    for (const { name, fieldName } of REKEYED_STORES) {
      const tx = db.transaction(name, "readwrite");
      const store = tx.objectStore(name);
      // Two-phase: (1) collect matching rows via cursor, (2)
      // delete old keys and put rewritten rows. The two-phase
      // shape handles composite-keyed stores (agent_trust)
      // where the primary key itself contains motebit_id and
      // an in-place cursor.update() would fail.
      const matches: Array<{ key: IDBValidKey; record: MotebitIdCarrier }> = [];
      const cursorReq = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const record = cursor.value as MotebitIdCarrier;
            if (record[fieldName] === oldMotebitId) {
              matches.push({ key: cursor.primaryKey, record });
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error("IDB cursor failed"));
      });
      for (const { key, record } of matches) {
        await idbRequest(store.delete(key));
        const rewritten = { ...record, [fieldName]: newMotebitId } as MotebitIdCarrier;
        await idbRequest(store.put(rewritten));
      }
      await idbTransaction(tx);
      results.push({ store: name, rekeyed: matches.length });
    }
  } finally {
    db.close();
  }
  return results;
}
