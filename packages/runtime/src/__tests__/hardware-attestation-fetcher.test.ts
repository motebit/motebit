/**
 * Unit tests for the relay capabilities fetcher — the production wiring
 * that converts a relay base URL into a `HardwareAttestationFetcher` the
 * runtime's `bumpTrustFromReceipt` hook can consume.
 *
 * Best-effort by design: every error surface (network throw, non-2xx,
 * malformed JSON, missing fields, wrong types) returns `[]` so the
 * existing reputation-credential path runs unchanged. These tests pin
 * each error surface plus the success path.
 */

import { describe, it, expect, vi } from "vitest";
import { createRelayCapabilitiesFetcher } from "../hardware-attestation-fetcher.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRelayCapabilitiesFetcher", () => {
  it("hits GET /agent/:id/capabilities and returns the hardware_attestations array", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.test/agent/m-123/capabilities");
      return jsonResponse({
        motebit_id: "m-123",
        public_key: "abc",
        hardware_attestations: [
          {
            device_id: "d-1",
            public_key: "abc",
            hardware_attestation_credential: '{"vc":"yes"}',
          },
          {
            device_id: "d-2",
            public_key: "def",
          },
        ],
      });
    });
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const out = await fetcher("m-123");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      device_id: "d-1",
      public_key: "abc",
      hardware_attestation_credential: '{"vc":"yes"}',
    });
    expect(out[1]).toEqual({
      device_id: "d-2",
      public_key: "def",
      hardware_attestation_credential: undefined,
    });
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.test/agent/m-1/capabilities");
      return jsonResponse({ hardware_attestations: [] });
    });
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test/",
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await fetcher("m-1");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("URL-encodes the motebit id", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.test/agent/weird%20id/capabilities");
      return jsonResponse({ hardware_attestations: [] });
    });
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await fetcher("weird id");
  });

  it("returns [] and logs warn on network error", async () => {
    const warn = vi.fn();
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
      logger: { warn },
    });
    const out = await fetcher("m-1");
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "hardware_attestation.fetch.network_error",
      expect.objectContaining({ error: "ECONNREFUSED" }),
    );
  });

  it("returns [] and logs warn on non-2xx", async () => {
    const warn = vi.fn();
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: (async () =>
        new Response("nope", { status: 404 })) as unknown as typeof globalThis.fetch,
      logger: { warn },
    });
    const out = await fetcher("m-1");
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "hardware_attestation.fetch.bad_status",
      expect.objectContaining({ status: 404 }),
    );
  });

  it("returns [] and logs warn on malformed JSON", async () => {
    const warn = vi.fn();
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: (async () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch,
      logger: { warn },
    });
    const out = await fetcher("m-1");
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith("hardware_attestation.fetch.bad_json", expect.any(Object));
  });

  it("returns [] when hardware_attestations field is missing", async () => {
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: (async () =>
        jsonResponse({ motebit_id: "m-1" })) as unknown as typeof globalThis.fetch,
    });
    const out = await fetcher("m-1");
    expect(out).toEqual([]);
  });

  it("skips entries with non-string device_id or public_key", async () => {
    const fetcher = createRelayCapabilitiesFetcher({
      baseUrl: "https://relay.test",
      fetch: (async () =>
        jsonResponse({
          hardware_attestations: [
            { device_id: 42, public_key: "abc" },
            { device_id: "d-1", public_key: null },
            null,
            "weird",
            { device_id: "d-2", public_key: "abc" },
          ],
        })) as unknown as typeof globalThis.fetch,
    });
    const out = await fetcher("m-1");
    expect(out).toHaveLength(1);
    expect(out[0]?.device_id).toBe("d-2");
  });
});
