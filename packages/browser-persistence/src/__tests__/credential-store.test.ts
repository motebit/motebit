import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbCredentialStore } from "../credential-store.js";
import type { StoredCredential } from "@motebit/sdk";

describe("IdbCredentialStore", () => {
  let store: IdbCredentialStore;

  function makeCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
    return {
      credential_id: crypto.randomUUID(),
      subject_motebit_id: "m-subject-1",
      issuer_did: "did:key:z6MkTest",
      credential_type: "AgentReputationCredential",
      credential_json: '{"type":"VerifiableCredential"}',
      issued_at: Date.now(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-cred-${crypto.randomUUID()}`);
    store = new IdbCredentialStore(db);
  });

  it("preload loads and sorts by issued_at DESC", async () => {
    // Save directly, then preload from IDB
    store.save(makeCredential({ credential_id: "c1", issued_at: 1000 }));
    store.save(makeCredential({ credential_id: "c2", issued_at: 3000 }));
    store.save(makeCredential({ credential_id: "c3", issued_at: 2000 }));

    await new Promise((r) => setTimeout(r, 50));

    // Create a new store and preload from IDB
    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbCredentialStore(db);
    await store2.preload();

    const all = store2.list("m-subject-1");
    expect(all).toHaveLength(3);
    // Sorted by issued_at DESC after preload
    expect(all[0]!.credential_id).toBe("c2"); // 3000
    expect(all[1]!.credential_id).toBe("c3"); // 2000
    expect(all[2]!.credential_id).toBe("c1"); // 1000
  });

  it("save prepends to cache and writes to IDB", async () => {
    await store.preload();

    store.save(makeCredential({ credential_id: "first", issued_at: 1000 }));
    store.save(makeCredential({ credential_id: "second", issued_at: 2000 }));

    // Cache should have second first (prepend order)
    const all = store.list("m-subject-1");
    expect(all).toHaveLength(2);
    expect(all[0]!.credential_id).toBe("second");
    expect(all[1]!.credential_id).toBe("first");

    // Verify IDB write
    await new Promise((r) => setTimeout(r, 50));
    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbCredentialStore(db);
    await store2.preload();
    expect(store2.list("m-subject-1")).toHaveLength(2);
  });

  it("listBySubject filters by subject and respects limit", async () => {
    await store.preload();

    store.save(makeCredential({ credential_id: "c1", subject_motebit_id: "m-alice" }));
    store.save(makeCredential({ credential_id: "c2", subject_motebit_id: "m-bob" }));
    store.save(makeCredential({ credential_id: "c3", subject_motebit_id: "m-alice" }));
    store.save(makeCredential({ credential_id: "c4", subject_motebit_id: "m-alice" }));

    const aliceCreds = store.listBySubject("m-alice");
    expect(aliceCreds).toHaveLength(3);
    expect(aliceCreds.every((c) => c.subject_motebit_id === "m-alice")).toBe(true);

    const limited = store.listBySubject("m-alice", 2);
    expect(limited).toHaveLength(2);
  });

  it("list filters by motebitId in issuer_did or subject_motebit_id", async () => {
    await store.preload();

    store.save(
      makeCredential({
        credential_id: "c1",
        subject_motebit_id: "m-agent-1",
        issuer_did: "did:key:z6MkOther",
      }),
    );
    store.save(
      makeCredential({
        credential_id: "c2",
        subject_motebit_id: "m-other",
        issuer_did: "did:key:m-agent-1",
      }),
    );
    store.save(
      makeCredential({
        credential_id: "c3",
        subject_motebit_id: "m-unrelated",
        issuer_did: "did:key:z6MkUnrelated",
      }),
    );

    const results = store.list("m-agent-1");
    expect(results).toHaveLength(2);
  });

  it("list filters by optional type", async () => {
    await store.preload();

    store.save(
      makeCredential({
        credential_id: "c1",
        credential_type: "AgentReputationCredential",
      }),
    );
    store.save(
      makeCredential({
        credential_id: "c2",
        credential_type: "AgentTrustCredential",
      }),
    );

    const reputationOnly = store.list("m-subject-1", "AgentReputationCredential");
    expect(reputationOnly).toHaveLength(1);
    expect(reputationOnly[0]!.credential_type).toBe("AgentReputationCredential");
  });

  it("list respects limit", async () => {
    await store.preload();

    for (let i = 0; i < 5; i++) {
      store.save(makeCredential({ credential_id: `c${i}` }));
    }

    const limited = store.list("m-subject-1", undefined, 3);
    expect(limited).toHaveLength(3);
  });
});
