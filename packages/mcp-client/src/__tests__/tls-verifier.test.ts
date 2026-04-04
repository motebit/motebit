import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServerConfig } from "../index.js";
import * as tls from "node:tls";

vi.mock("node:tls", () => ({
  connect: vi.fn(),
}));

const mockTlsConnect = tls.connect as ReturnType<typeof vi.fn>;

import { TlsCertificateVerifier } from "../tls-verifier.js";

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "test-server",
    transport: "http",
    url: "https://example.com/mcp",
    ...overrides,
  };
}

function mockTlsSocket(fingerprint256: string) {
  const socket = {
    getPeerCertificate: () => ({ fingerprint256 }),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  mockTlsConnect.mockImplementation((_opts: unknown, callback: () => void) => {
    // Call the connect callback synchronously
    void Promise.resolve().then(callback);
    return socket;
  });
  return socket;
}

function mockTlsError(error: string) {
  const socket = {
    getPeerCertificate: () => null,
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === "error") {
        void Promise.resolve().then(() => handler(new Error(error)));
      }
    }),
  };
  mockTlsConnect.mockImplementation((_opts: unknown, _callback: () => void) => {
    return socket;
  });
  return socket;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TlsCertificateVerifier", () => {
  const verifier = new TlsCertificateVerifier();

  it("pins certificate fingerprint on first connect", async () => {
    mockTlsSocket(
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    );

    const result = await verifier.verify(makeConfig(), []);
    expect(result.ok).toBe(true);
    expect(result.configUpdates?.tlsCertFingerprint).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  it("accepts when fingerprint matches pinned value", async () => {
    mockTlsSocket(
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    );

    const config = makeConfig({
      tlsCertFingerprint: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    const result = await verifier.verify(config, []);
    expect(result.ok).toBe(true);
    expect(result.configUpdates).toBeUndefined();
  });

  it("rejects when fingerprint changes", async () => {
    mockTlsSocket(
      "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
    );

    const config = makeConfig({
      tlsCertFingerprint: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    const result = await verifier.verify(config, []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("TLS certificate changed");
  });

  it("skips verification for stdio transport", async () => {
    const config = makeConfig({ transport: "stdio", url: undefined });
    const result = await verifier.verify(config, []);
    expect(result.ok).toBe(true);
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("skips verification for non-HTTPS URLs", async () => {
    const config = makeConfig({ url: "http://localhost:3000/mcp" });
    const result = await verifier.verify(config, []);
    expect(result.ok).toBe(true);
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("fails closed on TLS connection error", async () => {
    mockTlsError("ECONNREFUSED");

    const result = await verifier.verify(makeConfig(), []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("TLS probe failed");
  });

  it("uses correct port from URL", async () => {
    mockTlsSocket(
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    );

    await verifier.verify(makeConfig({ url: "https://example.com:8443/mcp" }), []);

    const connectOpts = mockTlsConnect.mock.calls[0]![0] as { host: string; port: number };
    expect(connectOpts.host).toBe("example.com");
    expect(connectOpts.port).toBe(8443);
  });

  it("defaults to port 443 for standard HTTPS", async () => {
    mockTlsSocket(
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    );

    await verifier.verify(makeConfig({ url: "https://example.com/mcp" }), []);

    const connectOpts = mockTlsConnect.mock.calls[0]![0] as { host: string; port: number };
    expect(connectOpts.port).toBe(443);
  });
});
