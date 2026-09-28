/**
 * Delegation-revocation cache — ingestion + incremental read (standing-
 * delegation §5/§6 D2; Inc 3a of the money-execution arc, checkpoint D4).
 *
 * The artifact is the security boundary: a revocation signed by a key this
 * relay holds for its delegator is recorded from ANY submitter (revocation
 * propagation is a feature); an invalid signature is rejected fail-closed; a
 * signature under a key the delegator does not hold is refused (#850 —
 * `credential-and-revocation-binding-850.test.ts`); a stored revocation only
 * has authority over grants whose delegator key matches (the consumer-side
 * `findGrantRevocation` law, proven in @motebit/crypto's suite — not
 * re-proven here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDelegationRevocation,
  type DelegationRevocation,
} from "@motebit/crypto";
import { isGrantRevokedBy } from "../delegation-revocations.js";
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array; motebitId: string };

/** A delegator this relay knows: an identity whose device row holds the key. */
async function registeredDelegator(relay: SyncRelay): Promise<Kp> {
  const kp = await generateKeypair();
  const { motebitId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { ...kp, motebitId };
}

async function makeRevocation(
  delegator: Kp,
  grantId: string,
  revokedAt: number = Date.now(),
): Promise<DelegationRevocation> {
  return signDelegationRevocation(
    {
      grant_id: grantId,
      delegator_id: delegator.motebitId,
      delegator_public_key: bytesToHex(delegator.publicKey),
      revoked_at: revokedAt,
    },
    delegator.privateKey,
  );
}

const post = (relay: SyncRelay, body: unknown) =>
  relay.app.request("/api/v1/delegations/revocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (relay: SyncRelay, since?: number) =>
  relay.app.request(
    `/api/v1/delegations/revocations${since !== undefined ? `?since=${since}` : ""}`,
  );

interface FeedBody {
  generated_at: number;
  next_since: number;
  records: DelegationRevocation[];
}

describe("delegation-revocation cache", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("records a validly-signed revocation and serves it back verbatim", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-1");

    const res = await post(relay, revocation);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, grant_id: "grant-1", status: "recorded" });

    const feed = (await (await get(relay)).json()) as FeedBody;
    expect(feed.records).toHaveLength(1);
    // Verbatim: the served record is byte-equivalent to what was signed.
    expect(feed.records[0]).toEqual(revocation);
  });

  it("re-submission is idempotent — one row, status already_recorded", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-1");

    await post(relay, revocation);
    const second = await post(relay, revocation);
    expect(((await second.json()) as { status: string }).status).toBe("already_recorded");

    const feed = (await (await get(relay)).json()) as FeedBody;
    expect(feed.records).toHaveLength(1);
  });

  it("rejects a tampered revocation fail-closed (422) and stores nothing", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-1");
    const tampered = { ...revocation, grant_id: "some-other-grant" };

    const res = await post(relay, tampered);
    expect(res.status).toBe(422);

    const feed = (await (await get(relay)).json()) as FeedBody;
    expect(feed.records).toHaveLength(0);
  });

  it("rejects a malformed body (400) — wire-schema validation, not just shape-sniffing", async () => {
    const res = await post(relay, { grant_id: "g", signature: "not-a-revocation" });
    expect(res.status).toBe(400);
    const bad = await get(relay, -5);
    expect(bad.status).toBe(400);
  });

  it("a third party may propagate someone else's valid revocation (feature, not forgery)", async () => {
    // "Submitter" identity is irrelevant — there is no auth on the route; the
    // artifact is the security boundary (its signature, under a key the relay
    // holds for alice). A revocation signed by alice is accepted no matter who
    // carries it.
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-alice");
    const res = await post(relay, revocation);
    expect(res.status).toBe(200);
  });

  it("`since` is an incremental cursor over the relay receipt clock", async () => {
    const alice = await registeredDelegator(relay);
    await post(relay, await makeRevocation(alice, "grant-1"));

    const first = (await (await get(relay)).json()) as FeedBody;
    expect(first.records).toHaveLength(1);

    // Nothing new after the cursor…
    const empty = (await (await get(relay, first.next_since)).json()) as FeedBody;
    expect(empty.records).toHaveLength(0);
    expect(empty.next_since).toBe(first.next_since);

    // …until a second revocation arrives (received_at strictly after cursor).
    await new Promise((r) => setTimeout(r, 2));
    await post(relay, await makeRevocation(alice, "grant-2"));
    const delta = (await (await get(relay, first.next_since)).json()) as FeedBody;
    expect(delta.records).toHaveLength(1);
    expect(delta.records[0]!.grant_id).toBe("grant-2");
  });

  it("isGrantRevokedBy answers only for the revoking delegator (the fence's seam, #850)", async () => {
    const alice = await registeredDelegator(relay);
    const bob = await registeredDelegator(relay);
    await post(relay, await makeRevocation(alice, "grant-1"));
    await post(relay, await makeRevocation(alice, "grant-2"));

    const db = relay.moteDb.db;
    expect(isGrantRevokedBy(db, "grant-1", alice.motebitId)).toBe(true);
    expect(isGrantRevokedBy(db, "grant-2", alice.motebitId)).toBe(true);
    expect(isGrantRevokedBy(db, "grant-3", alice.motebitId)).toBe(false);
    // Another identity's grant_id collision is not a revocation of its grant.
    expect(isGrantRevokedBy(db, "grant-1", bob.motebitId)).toBe(false);
    // No submitter (operator master token, no submitted_by): fail CLOSED —
    // any cached revocation of the grant_id fences (main's behaviour).
    expect(isGrantRevokedBy(db, "grant-1", undefined)).toBe(true);
    expect(isGrantRevokedBy(db, "grant-1", "")).toBe(true);
    expect(isGrantRevokedBy(db, "grant-3", undefined)).toBe(false);
  });
});

describe("acceptance-time revocation fence (checkpoint D4)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  async function registerWorker(motebitId: string): Promise<void> {
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
      }),
    });
  }

  // The operator's master token, naming the submitter in the body (the relay's
  // `submittedBy` for a master-token submission): the fence honours only the
  // submitter's own revocations (#850), so the submitter must be named.
  async function submitTask(motebitId: string, grantId?: string) {
    return relay.app.request(`/agent/${motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do the daily research",
        submitted_by: motebitId,
        ...(grantId !== undefined ? { grant_id: grantId } : {}),
      }),
    });
  }

  it("no submitter (master token, no submitted_by) fails CLOSED: any cached revocation of the grant fences (403)", async () => {
    const kp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(kp.publicKey));
    const alice = { ...kp, motebitId: worker.motebitId };
    await registerWorker(worker.motebitId);
    expect((await post(relay, await makeRevocation(alice, "grant-nosub"))).status).toBe(200);

    const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "do the daily research", grant_id: "grant-nosub" }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("REVOKED");
  });

  it("refuses a task declared under a REVOKED grant before any hold commits (403)", async () => {
    const kp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(kp.publicKey));
    const alice = { ...kp, motebitId: worker.motebitId };
    await registerWorker(worker.motebitId);
    expect((await post(relay, await makeRevocation(alice, "grant-money-1"))).status).toBe(200);

    const res = await submitTask(worker.motebitId, "grant-money-1");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(JSON.stringify(body)).toContain("REVOKED");
  });

  it("accepts a task under an unrevoked grant and a grantless task unchanged", async () => {
    const kp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(kp.publicKey));
    const alice = { ...kp, motebitId: worker.motebitId };
    await registerWorker(worker.motebitId);
    expect((await post(relay, await makeRevocation(alice, "some-other-grant"))).status).toBe(200);

    const ok = await submitTask(worker.motebitId, "grant-money-1");
    expect(ok.status).toBe(201);
    const bare = await submitTask(worker.motebitId);
    expect(bare.status).toBe(201);
  });

  it("rejects a malformed grant_id (400)", async () => {
    const alice = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(alice.publicKey));
    await registerWorker(worker.motebitId);
    const res = await submitTask(worker.motebitId, "   ");
    expect(res.status).toBe(400);
  });
});
