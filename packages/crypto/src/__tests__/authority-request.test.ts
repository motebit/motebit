/**
 * Identity-authority requests — one producer, one verifier. Each
 * domain-separation axis (field, identity, relay, freshness, value, key) is
 * flipped alone and must refuse with its own reason; the header round-trips.
 */
import { describe, expect, it } from "vitest";

import {
  AUTHORITY_REQUEST_DOMAIN,
  authorityRequestBytes,
  decodeAuthorityHeader,
  encodeAuthorityHeader,
  parseAuthorityRequest,
  signAuthorityRequest,
  verifyAuthorityRequest,
  type SignedAuthorityRequest,
} from "../authority-request.js";
import { bytesToHex, generateKeypair } from "../index.js";

const ID = "019a0000-0000-8000-8000-000000000001";
const RELAY = "relay-a";
const NOW = 1_800_000_000_000;
const VALUE = { sweep_threshold: 5_000_000, settlement_address: "So1ana" };

async function setup() {
  const kp = await generateKeypair();
  const req = await signAuthorityRequest({
    motebitId: ID,
    field: "sweep_config",
    value: VALUE,
    relayId: RELAY,
    privateKey: kp.privateKey,
    now: NOW,
  });
  return { kp, req, pub: bytesToHex(kp.publicKey) };
}

const expectFor = (pub: string, over: Record<string, unknown> = {}) => ({
  field: "sweep_config" as const,
  motebitId: ID,
  self: RELAY,
  publicKeyHex: pub,
  value: VALUE,
  now: NOW,
  ...over,
});

describe("authority request", () => {
  it("verifies at the named relay under the identity's key", async () => {
    const { req, pub } = await setup();
    const v = await verifyAuthorityRequest(req, expectFor(pub));
    expect(v.ok).toBe(true);
  });

  it("signs the domain-separated bytes: tag, newline, JCS(envelope)", async () => {
    const { req } = await setup();
    const text = new TextDecoder().decode(authorityRequestBytes(req.envelope));
    expect(text.startsWith(`${AUTHORITY_REQUEST_DOMAIN}\n{`)).toBe(true);
    expect(Object.keys(req.envelope).sort()).toEqual(
      ["field", "motebit_id", "nonce", "relay_id", "suite", "ts", "value_sha256"].sort(),
    );
  });

  it("each axis flipped alone refuses by name", async () => {
    const { req, pub } = await setup();
    const other = bytesToHex((await generateKeypair()).publicKey);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ field: "listing" }, "field_mismatch"],
      [{ motebitId: "019a0000-0000-8000-8000-000000000002" }, "wrong_identity"],
      [{ self: "relay-b" }, "wrong_relay"],
      [{ now: NOW + 300_001 }, "stale"],
      [{ now: NOW - 300_001 }, "stale"],
      [{ value: { ...VALUE, sweep_threshold: 1 } }, "value_mismatch"],
      [{ publicKeyHex: other }, "bad_signature"],
    ];
    for (const [over, reason] of cases) {
      const v = await verifyAuthorityRequest(req, expectFor(pub, over));
      expect(v, JSON.stringify(over)).toEqual({ ok: false, reason });
    }
  });

  it("an envelope altered after signing does not verify (every field is signed)", async () => {
    const { req, pub } = await setup();
    const altered: SignedAuthorityRequest = {
      ...req,
      envelope: { ...req.envelope, nonce: "0".repeat(64) },
    };
    expect(await verifyAuthorityRequest(altered, expectFor(pub))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("an unknown field, a foreign suite, an extra envelope field are refused before any signature work", async () => {
    const { req, pub } = await setup();
    expect(
      await verifyAuthorityRequest(
        { ...req, envelope: { ...req.envelope, field: "guardian" } },
        expectFor(pub),
      ),
    ).toEqual({ ok: false, reason: "unknown_field" });
    expect(
      await verifyAuthorityRequest(
        { ...req, envelope: { ...req.envelope, suite: "motebit-jcs-ed25519-b64-v1" } },
        expectFor(pub),
      ),
    ).toEqual({ ok: false, reason: "unsupported_suite" });
    expect(parseAuthorityRequest({ ...req, envelope: { ...req.envelope, extra: 1 } })).toBeNull();
    expect(await verifyAuthorityRequest(null, expectFor(pub))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("the header round-trips, and garbage decodes to null", async () => {
    const { req, pub } = await setup();
    const header = encodeAuthorityHeader(req);
    expect(/^[A-Za-z0-9_-]+$/.test(header)).toBe(true);
    const decoded = decodeAuthorityHeader(header);
    expect((await verifyAuthorityRequest(decoded, expectFor(pub))).ok).toBe(true);
    expect(decodeAuthorityHeader("")).toBeNull();
    expect(decodeAuthorityHeader("not base64url!")).toBeNull();
    expect(decodeAuthorityHeader("A".repeat(5000))).toBeNull();
  });

  it("refuses to sign for an unknown field or with no identity or relay", async () => {
    const kp = await generateKeypair();
    const base = { motebitId: ID, value: VALUE, relayId: RELAY, privateKey: kp.privateKey };
    await expect(signAuthorityRequest({ ...base, field: "guardian" as never })).rejects.toThrow();
    await expect(
      signAuthorityRequest({ ...base, field: "listing", motebitId: "" }),
    ).rejects.toThrow();
    await expect(
      signAuthorityRequest({ ...base, field: "listing", relayId: "" }),
    ).rejects.toThrow();
  });
});
