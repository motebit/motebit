/**
 * Delegation-revocation cache — ingestion + incremental read (standing-
 * delegation §5/§6 D2; Inc 3a of the money-execution arc, checkpoint D4).
 *
 * The artifact is the security boundary: a validly-signed revocation from ANY
 * submitter is recorded (revocation propagation is a feature); an invalid
 * signature is rejected fail-closed; a stored revocation only has authority
 * over grants whose delegator key matches (the consumer-side
 * `findGrantRevocation` law, proven in @motebit/crypto's suite — not re-proven
 * here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDelegationRevocation,
  type DelegationRevocation,
} from "@motebit/crypto";
import { listRevokedGrantIds } from "../delegation-revocations.js";
import { createTestRelay } from "./test-helpers.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

async function makeRevocation(
  delegator: Kp,
  grantId: string,
  revokedAt: number = Date.now(),
): Promise<DelegationRevocation> {
  return signDelegationRevocation(
    {
      grant_id: grantId,
      delegator_id: "did:motebit:alice",
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
    const alice = await generateKeypair();
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
    const alice = await generateKeypair();
    const revocation = await makeRevocation(alice, "grant-1");

    await post(relay, revocation);
    const second = await post(relay, revocation);
    expect(((await second.json()) as { status: string }).status).toBe("already_recorded");

    const feed = (await (await get(relay)).json()) as FeedBody;
    expect(feed.records).toHaveLength(1);
  });

  it("rejects a tampered revocation fail-closed (422) and stores nothing", async () => {
    const alice = await generateKeypair();
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
    // artifact's own signature is the entire security boundary. A revocation
    // signed by alice is accepted no matter who carries it.
    const alice = await generateKeypair();
    const revocation = await makeRevocation(alice, "grant-alice");
    const res = await post(relay, revocation);
    expect(res.status).toBe(200);
  });

  it("`since` is an incremental cursor over the relay receipt clock", async () => {
    const alice = await generateKeypair();
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

  it("listRevokedGrantIds exposes the settlement-time isRevoked seam input", async () => {
    const alice = await generateKeypair();
    await post(relay, await makeRevocation(alice, "grant-1"));
    await post(relay, await makeRevocation(alice, "grant-2"));

    const revoked = listRevokedGrantIds(relay.moteDb.db);
    expect(revoked).toEqual(new Set(["grant-1", "grant-2"]));
  });
});
