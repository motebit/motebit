import type { CredentialStoreAdapter, StoredCredential } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed CredentialStore with preload+cache pattern.
 *
 * CredentialStoreAdapter has sync methods but IDB is async.
 * Preload credentials at bootstrap, then serve reads from cache
 * with write-through to IDB (fire-and-forget).
 */
export class IdbCredentialStore implements CredentialStoreAdapter {
  private _credentials: StoredCredential[] = []; // sorted by issued_at DESC

  constructor(private db: IDBDatabase) {}

  /** Preload credentials. Call before runtime construction. */
  async preload(): Promise<void> {
    const tx = this.db.transaction("issued_credentials", "readonly");
    const store = tx.objectStore("issued_credentials");
    const all = (await idbRequest(store.getAll())) as StoredCredential[];
    this._credentials = all.sort((a, b) => b.issued_at - a.issued_at);
  }

  save(credential: StoredCredential): void {
    this._credentials.unshift(credential);
    const tx = this.db.transaction("issued_credentials", "readwrite");
    tx.objectStore("issued_credentials").put({ ...credential });
  }

  listBySubject(subjectMotebitId: string, limit = 100): StoredCredential[] {
    return this._credentials
      .filter((c) => c.subject_motebit_id === subjectMotebitId)
      .slice(0, limit);
  }

  list(motebitId: string, type?: string, limit = 100): StoredCredential[] {
    let matching = this._credentials.filter(
      (c) => c.subject_motebit_id.includes(motebitId) || c.issuer_did.includes(motebitId),
    );
    if (type) {
      matching = matching.filter((c) => c.credential_type === type);
    }
    return matching.slice(0, limit);
  }
}
