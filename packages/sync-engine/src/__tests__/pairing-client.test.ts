import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PairingClient } from "../pairing-client.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as Response;
}

describe("PairingClient", () => {
  let client: PairingClient;

  beforeEach(() => {
    client = new PairingClient({ relayUrl: "https://relay.example.com" });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initiate", () => {
    it("sends POST to /pairing/initiate with auth token", async () => {
      mockFetch.mockResolvedValue(
        mockResponse(201, {
          pairing_id: "pid-1",
          pairing_code: "ABC123",
          expires_at: Date.now() + 300000,
        }),
      );

      const result = await client.initiate("my-auth-token");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://relay.example.com/pairing/initiate",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer my-auth-token" }),
        }),
      );
      expect(result.pairingId).toBe("pid-1");
      expect(result.pairingCode).toBe("ABC123");
      expect(result.expiresAt).toBeGreaterThan(0);
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValue(mockResponse(401, { error: "Unauthorized" }));
      await expect(client.initiate("bad-token")).rejects.toThrow("Unauthorized");
    });
  });

  describe("claim", () => {
    it("sends POST to /pairing/claim without auth", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { pairing_id: "pid-1", motebit_id: "mote-1" }));

      const result = await client.claim("ABC123", "Mobile", "a".repeat(64));

      expect(mockFetch).toHaveBeenCalledWith(
        "https://relay.example.com/pairing/claim",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pairing_code: "ABC123",
            device_name: "Mobile",
            public_key: "a".repeat(64),
          }),
        }),
      );
      expect(result.pairingId).toBe("pid-1");
      expect(result.motebitId).toBe("mote-1");
    });

    it("throws on invalid code", async () => {
      mockFetch.mockResolvedValue(mockResponse(404, { error: "Invalid pairing code" }));
      await expect(client.claim("ZZZZZZ", "Mobile", "a".repeat(64))).rejects.toThrow(
        "Invalid pairing code",
      );
    });
  });

  describe("getSession", () => {
    it("fetches session with auth", async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          pairing_id: "pid-1",
          motebit_id: "mote-1",
          status: "claimed",
          pairing_code: "ABC123",
          claiming_device_name: "Mobile",
          claiming_public_key: "a".repeat(64),
          created_at: Date.now(),
          expires_at: Date.now() + 300000,
        }),
      );

      const session = await client.getSession("pid-1", "my-token");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://relay.example.com/pairing/pid-1",
        expect.objectContaining({
          headers: { Authorization: "Bearer my-token" },
        }),
      );
      expect(session.status).toBe("claimed");
      expect(session.claiming_device_name).toBe("Mobile");
    });
  });

  describe("approve", () => {
    it("sends POST and returns device info", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { device_id: "dev-2", motebit_id: "mote-1" }));

      const result = await client.approve("pid-1", "my-token");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://relay.example.com/pairing/pid-1/approve",
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.deviceId).toBe("dev-2");
      expect(result.motebitId).toBe("mote-1");
    });
  });

  describe("deny", () => {
    it("sends POST to deny", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { status: "denied" }));

      await client.deny("pid-1", "my-token");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://relay.example.com/pairing/pid-1/deny",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("pollStatus", () => {
    it("fetches status without auth", async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          status: "approved",
          motebit_id: "mote-1",
          device_id: "dev-2",
        }),
      );

      const status = await client.pollStatus("pid-1");

      expect(mockFetch).toHaveBeenCalledWith("https://relay.example.com/pairing/pid-1/status");
      expect(status.status).toBe("approved");
      expect(status.motebit_id).toBe("mote-1");
      expect(status.device_id).toBe("dev-2");
    });

    it("returns pending status without extra fields", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { status: "pending" }));

      const status = await client.pollStatus("pid-1");

      expect(status.status).toBe("pending");
      expect(status.motebit_id).toBeUndefined();
    });
  });

  describe("URL normalization", () => {
    it("strips trailing slash from relay URL", async () => {
      const clientWithSlash = new PairingClient({ relayUrl: "https://relay.example.com/" });
      mockFetch.mockResolvedValue(mockResponse(200, { status: "pending" }));

      await clientWithSlash.pollStatus("pid-1");

      expect(mockFetch).toHaveBeenCalledWith("https://relay.example.com/pairing/pid-1/status");
    });
  });
});
