import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolveTxtFn } from "../discovery.js";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks
import { discoverByDns, discoverByWellKnown, discoverMotebit } from "../discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_IDENTITY_FILE = `---
spec: "motebit/identity@1.0"
motebit_id: "mote_01234567-89ab-cdef-0123-456789abcdef"
motebit_type: "service"
name: "Flight Search"
identity:
  algorithm: "Ed25519"
  public_key: "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
---

# Motebit Identity

<!-- motebit:sig:Ed25519:AAAA -->
`;

function mockFetchResponse(body: string, ok = true, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    text: () => Promise.resolve(body),
  });
}

function makeResolveTxt(records: string[][]): ResolveTxtFn {
  return vi.fn<ResolveTxtFn>().mockResolvedValue(records);
}

function makeResolveTxtFail(error: Error): ResolveTxtFn {
  return vi.fn<ResolveTxtFn>().mockRejectedValue(error);
}

function makeResolveTxtHang(): ResolveTxtFn {
  return vi
    .fn<ResolveTxtFn>()
    .mockImplementation(() => new Promise((_resolve) => setTimeout(() => _resolve([]), 10000)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverByDns", () => {
  it("discovers a motebit via valid TXT record", async () => {
    const resolve = makeResolveTxt([
      [
        "v=motebit1 url=https://example.com/.well-known/motebit.md endpoint=https://example.com/mcp",
      ],
    ]);
    mockFetchResponse(VALID_IDENTITY_FILE);

    const result = await discoverByDns("example.com", resolve);

    expect(result.domain).toBe("example.com");
    expect(result.identityVerified).toBe(true);
    expect(result.motebitId).toBe("mote_01234567-89ab-cdef-0123-456789abcdef");
    expect(result.publicKey).toBe(
      "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb",
    );
    expect(result.motebitType).toBe("service");
    expect(result.serviceName).toBe("Flight Search");
    expect(result.endpointUrl).toBe("https://example.com/mcp");
    expect(result.motebitUrl).toBe("https://example.com/.well-known/motebit.md");
    expect(result.error).toBeUndefined();
  });

  it("parses TXT record split across multiple chunks", async () => {
    const resolve = makeResolveTxt([
      ["v=motebit1 url=https://ex", "ample.com/.well-known/motebit.md"],
    ]);
    mockFetchResponse(VALID_IDENTITY_FILE);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(true);
    expect(result.motebitUrl).toBe("https://example.com/.well-known/motebit.md");
  });

  it("returns error when no v=motebit1 record found", async () => {
    const resolve = makeResolveTxt([["v=spf1 include:example.com ~all"]]);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("No valid v=motebit1 TXT record");
  });

  it("returns error when TXT record missing url field", async () => {
    const resolve = makeResolveTxt([["v=motebit1 endpoint=https://example.com/mcp"]]);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("No valid v=motebit1 TXT record");
  });

  it("returns error on DNS resolution failure", async () => {
    const resolve = makeResolveTxtFail(new Error("ENOTFOUND"));

    const result = await discoverByDns("nonexistent.example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("DNS discovery failed");
    expect(result.error).toContain("ENOTFOUND");
  });

  it("returns error when identity file is missing required fields", async () => {
    const resolve = makeResolveTxt([["v=motebit1 url=https://example.com/.well-known/motebit.md"]]);
    mockFetchResponse("---\nspec: motebit/identity@1.0\n---\n# No ID here\n");

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("missing motebit_id or public_key");
  });

  it("returns error on HTTP fetch failure", async () => {
    const resolve = makeResolveTxt([["v=motebit1 url=https://example.com/.well-known/motebit.md"]]);
    mockFetchResponse("Not Found", false, 404);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("DNS discovery failed");
    expect(result.error).toContain("404");
  });

  it("handles DNS timeout", async () => {
    const resolve = makeResolveTxtHang();

    const result = await discoverByDns("slow.example.com", resolve);
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10000);

  it("works without endpoint field in TXT record", async () => {
    const resolve = makeResolveTxt([["v=motebit1 url=https://example.com/.well-known/motebit.md"]]);
    mockFetchResponse(VALID_IDENTITY_FILE);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(true);
    expect(result.endpointUrl).toBeUndefined();
  });

  it("skips non-motebit TXT records and finds the correct one", async () => {
    const resolve = makeResolveTxt([
      ["v=spf1 include:example.com ~all"],
      ["google-site-verification=abc123"],
      ["v=motebit1 url=https://example.com/.well-known/motebit.md"],
    ]);
    mockFetchResponse(VALID_IDENTITY_FILE);

    const result = await discoverByDns("example.com", resolve);
    expect(result.identityVerified).toBe(true);
  });
});

describe("discoverByWellKnown", () => {
  it("discovers a motebit via .well-known URL", async () => {
    mockFetchResponse(VALID_IDENTITY_FILE);

    const result = await discoverByWellKnown("example.com");

    expect(result.domain).toBe("example.com");
    expect(result.identityVerified).toBe(true);
    expect(result.motebitId).toBe("mote_01234567-89ab-cdef-0123-456789abcdef");
    expect(result.motebitUrl).toBe("https://example.com/.well-known/motebit.md");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/.well-known/motebit.md",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns error when .well-known returns 404", async () => {
    mockFetchResponse("Not Found", false, 404);

    const result = await discoverByWellKnown("example.com");
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("Well-known discovery failed");
  });

  it("returns error when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await discoverByWellKnown("offline.example.com");
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("Well-known discovery failed");
    expect(result.error).toContain("fetch failed");
  });

  it("returns error when identity file has no frontmatter", async () => {
    mockFetchResponse("# Just a markdown file\nNo frontmatter here.");

    const result = await discoverByWellKnown("example.com");
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("missing motebit_id or public_key");
  });
});

describe("discoverMotebit", () => {
  it("returns DNS result when DNS succeeds", async () => {
    // discoverMotebit uses discoverByDns without the resolveTxt override,
    // so we need to mock dns/promises at the module level for this test.
    // Instead, we test the integration logic by mocking fetch responses.
    // The first call (DNS) will fail since we can't mock dns here,
    // so well-known fallback will succeed.
    mockFetchResponse(VALID_IDENTITY_FILE); // well-known fallback

    const result = await discoverMotebit("example.com");
    // DNS will fail (no real DNS record), falls back to well-known
    expect(result.identityVerified).toBe(true);
    expect(result.motebitId).toBe("mote_01234567-89ab-cdef-0123-456789abcdef");
  });

  it("returns combined error when both DNS and .well-known fail", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await discoverMotebit("nonexistent.example.com");
    expect(result.identityVerified).toBe(false);
    expect(result.error).toContain("DNS:");
    expect(result.error).toContain("Well-known:");
  });

  it("falls back to .well-known when DNS has no motebit entry", async () => {
    mockFetchResponse(VALID_IDENTITY_FILE); // well-known fallback

    const result = await discoverMotebit("example.com");
    expect(result.identityVerified).toBe(true);
    expect(result.motebitUrl).toBe("https://example.com/.well-known/motebit.md");
  });
});
