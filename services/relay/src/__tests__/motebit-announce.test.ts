/**
 * Self-attesting motebit announcement — relay-side round-trip.
 *
 * Asserts the wire-format outcomes for `POST /api/v1/motebits/announce`:
 *   (a) auth-less endpoint accepts a properly signed announcement (201, first_seen),
 *   (b) re-announcing the same motebit_id returns 200 (first_seen=false), no dup row,
 *   (c) an announcement bound to a DIFFERENT relay (audience) is rejected 400 (wrong_audience),
 *   (d) tampered / stale requests return 400 with reason codes,
 *   (e) the intake row lands in `relay_motebit_intake` so the health metric counts it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { aggregateHealthSummary } from "../health-summary.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  signMotebitAnnouncement,
  bytesToHex,
  generateKeypair,
  type SignableMotebitAnnouncement,
} from "@motebit/encryption";

const API_TOKEN = "test-token";

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

async function postAnnounce(
  relay: SyncRelay,
  body: SignableMotebitAnnouncement,
): Promise<Response> {
  return relay.app.request("/api/v1/motebits/announce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/motebits/announce — self-attesting intake", () => {
  let relay: SyncRelay;
  let audience: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    audience = relay.relayIdentity.relayMotebitId;
  });

  afterEach(async () => {
    await relay.close();
  });

  async function signFor(motebitId: string, overrides: Partial<SignableMotebitAnnouncement> = {}) {
    const kp = await generateKeypair();
    return signMotebitAnnouncement(
      {
        motebit_id: motebitId,
        public_key: bytesToHex(kp.publicKey),
        surface: "web",
        audience,
        timestamp: Date.now(),
        ...overrides,
      },
      kp.privateKey,
    );
  }

  it("accepts a properly signed first announcement (201, first_seen=true) and records intake", async () => {
    const motebitId = crypto.randomUUID();
    const res = await postAnnounce(relay, await signFor(motebitId));
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as { ok: boolean; first_seen: boolean; announced_at: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.first_seen).toBe(true);
    expect(typeof parsed.announced_at).toBe("number");

    // The intake metric counts it.
    const health = aggregateHealthSummary(relay.moteDb.db);
    expect(health.motebits.total_announced).toBe(1);
    expect(health.motebits.new_24h).toBe(1);
  });

  it("returns 200 (first_seen=false) on idempotent re-announce, no duplicate row", async () => {
    const kp = await generateKeypair();
    const motebitId = crypto.randomUUID();
    const sign = (ts: number) =>
      signMotebitAnnouncement(
        {
          motebit_id: motebitId,
          public_key: bytesToHex(kp.publicKey),
          surface: "web",
          audience,
          timestamp: ts,
        },
        kp.privateKey,
      );

    const first = await postAnnounce(relay, await sign(Date.now()));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { announced_at: number };

    const second = await postAnnounce(relay, await sign(Date.now() + 1000));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { first_seen: boolean; announced_at: number };
    expect(secondBody.first_seen).toBe(false);
    // announced_at is write-once — the re-announce keeps the original.
    expect(secondBody.announced_at).toBe(firstBody.announced_at);

    // Still exactly one acquired motebit.
    expect(aggregateHealthSummary(relay.moteDb.db).motebits.total_announced).toBe(1);
  });

  it("rejects an announcement bound to a different relay (400, wrong_audience)", async () => {
    const motebitId = crypto.randomUUID();
    const wrong = await signFor(motebitId, { audience: crypto.randomUUID() });
    const res = await postAnnounce(relay, wrong);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { code: string; reason: string };
    expect(parsed.code).toBe("MOTEBIT_ANNOUNCEMENT_REJECTED");
    expect(parsed.reason).toBe("wrong_audience");
    // Nothing recorded.
    expect(aggregateHealthSummary(relay.moteDb.db).motebits.total_announced).toBe(0);
  });

  it("returns 400 (reason=bad_signature) when the body is tampered after signing", async () => {
    const motebitId = crypto.randomUUID();
    const body = await signFor(motebitId);
    const tampered = { ...body, motebit_id: crypto.randomUUID() };
    const res = await postAnnounce(relay, tampered);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("bad_signature");
  });

  it("returns 400 (reason=stale) when timestamp is outside the ±5 minute window", async () => {
    const motebitId = crypto.randomUUID();
    const body = await signFor(motebitId, { timestamp: Date.now() - 10 * 60 * 1000 });
    const res = await postAnnounce(relay, body);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("stale");
  });

  it("requires no Authorization header — signature is the auth", async () => {
    const motebitId = crypto.randomUUID();
    const res = await relay.app.request("/api/v1/motebits/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await signFor(motebitId)),
    });
    expect(res.status).toBe(201);
  });

  it("rejects non-JSON body with 400", async () => {
    const res = await relay.app.request("/api/v1/motebits/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
