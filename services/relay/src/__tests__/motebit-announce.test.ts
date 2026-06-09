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
import { deriveSovereignMotebitId } from "@motebit/crypto";

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

  // A sovereign mint: the signing key IS the genesis key, so motebit_id is its
  // sovereign commitment — exactly what bootstrapIdentity produces on first
  // launch, and what the relay's binding check requires.
  async function freshSovereign() {
    const kp = await generateKeypair();
    const publicKey = bytesToHex(kp.publicKey);
    const motebitId = await deriveSovereignMotebitId(publicKey);
    return { kp, publicKey, motebitId };
  }

  function signAnnouncement(
    s: {
      kp: { publicKey: Uint8Array; privateKey: Uint8Array };
      publicKey: string;
      motebitId: string;
    },
    overrides: Partial<SignableMotebitAnnouncement> = {},
  ) {
    return signMotebitAnnouncement(
      {
        motebit_id: s.motebitId,
        public_key: s.publicKey,
        surface: "web",
        audience,
        timestamp: Date.now(),
        ...overrides,
      },
      s.kp.privateKey,
    );
  }

  it("accepts a properly signed first announcement (201, first_seen=true) and records intake", async () => {
    const s = await freshSovereign();
    const res = await postAnnounce(relay, await signAnnouncement(s));
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
    const s = await freshSovereign();

    const first = await postAnnounce(relay, await signAnnouncement(s, { timestamp: Date.now() }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { announced_at: number };

    const second = await postAnnounce(
      relay,
      await signAnnouncement(s, { timestamp: Date.now() + 1000 }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { first_seen: boolean; announced_at: number };
    expect(secondBody.first_seen).toBe(false);
    // announced_at is write-once — the re-announce keeps the original.
    expect(secondBody.announced_at).toBe(firstBody.announced_at);

    // Still exactly one acquired motebit.
    expect(aggregateHealthSummary(relay.moteDb.db).motebits.total_announced).toBe(1);
  });

  it("rejects an announcement whose motebit_id is not the sovereign commitment to the key (400, unbound_identity)", async () => {
    // Validly signed by the key, correct audience — but the id is a random
    // UUID, not the sovereign commitment. This is the squat/forge vector: the
    // signature proves key possession, the binding check proves the id is the
    // signer's own sovereign identity.
    const s = await freshSovereign();
    const forged = await signAnnouncement(s, { motebit_id: crypto.randomUUID() });
    const res = await postAnnounce(relay, forged);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { code: string; reason: string };
    expect(parsed.code).toBe("MOTEBIT_ANNOUNCEMENT_REJECTED");
    expect(parsed.reason).toBe("unbound_identity");
    expect(aggregateHealthSummary(relay.moteDb.db).motebits.total_announced).toBe(0);
  });

  it("rejects an announcement bound to a different relay (400, wrong_audience)", async () => {
    const s = await freshSovereign();
    const wrong = await signAnnouncement(s, { audience: crypto.randomUUID() });
    const res = await postAnnounce(relay, wrong);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { code: string; reason: string };
    expect(parsed.code).toBe("MOTEBIT_ANNOUNCEMENT_REJECTED");
    expect(parsed.reason).toBe("wrong_audience");
    // Nothing recorded.
    expect(aggregateHealthSummary(relay.moteDb.db).motebits.total_announced).toBe(0);
  });

  it("rejects an unknown surface (400, malformed)", async () => {
    const s = await freshSovereign();
    const bad = await signAnnouncement(s, {
      surface: "hacker" as SignableMotebitAnnouncement["surface"],
    });
    const res = await postAnnounce(relay, bad);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("malformed");
  });

  it("returns 400 (reason=bad_signature) when the body is tampered after signing", async () => {
    // Tamper motebit_id: it's part of the signed body but isn't checked before
    // the signature step, so verification fails at the signature (not audience
    // or binding). Proves the signature actually covers the body.
    const s = await freshSovereign();
    const body = await signAnnouncement(s);
    const tampered = { ...body, motebit_id: crypto.randomUUID() };
    const res = await postAnnounce(relay, tampered);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("bad_signature");
  });

  it("returns 400 (reason=stale) when timestamp is outside the ±5 minute window", async () => {
    const s = await freshSovereign();
    const body = await signAnnouncement(s, { timestamp: Date.now() - 10 * 60 * 1000 });
    const res = await postAnnounce(relay, body);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { reason: string };
    expect(parsed.reason).toBe("stale");
  });

  it("requires no Authorization header — signature is the auth", async () => {
    const s = await freshSovereign();
    const res = await relay.app.request("/api/v1/motebits/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await signAnnouncement(s)),
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
