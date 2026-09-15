/**
 * The evidence seam: the ONE fetcher the audit engine receives is pinned to
 * the relay origin (absolute paths only), and every digest/ref helper is a
 * pure function of the bytes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createRelayFetcher,
  sha256Hex,
  digestRef,
  evidenceRefFor,
  isWellFormedMotebitId,
} from "../evidence.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("createRelayFetcher", () => {
  it("strips trailing slashes from the base, requires an absolute path, and decodes the body", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(href).toBe("https://relay.example/api/v1/agents/x");
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = createRelayFetcher("https://relay.example///", fetchImpl);
    const got = await fetcher("/api/v1/agents/x");
    expect(got.status).toBe(200);
    expect(got.text).toBe('{"ok":true}');
    expect(Array.from(got.bytes)).toEqual(Array.from(bytes('{"ok":true}')));
    await expect(fetcher("api/v1/agents/x")).rejects.toThrow(/must be absolute/);
    await expect(fetcher("https://evil.example/x")).rejects.toThrow(/must be absolute/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("defaults to the global fetch when none is injected", () => {
    // Construction alone must not call anything; the default-parameter branch is what we cover.
    const fetcher = createRelayFetcher("https://relay.example");
    expect(typeof fetcher).toBe("function");
  });
});

describe("digests and refs", () => {
  it("sha256Hex / digestRef are deterministic over the bytes", () => {
    const a = sha256Hex(bytes("abc"));
    expect(a).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const ref = digestRef(bytes("abc"));
    expect(JSON.stringify(ref)).toContain(a);
    expect(digestRef(bytes("abc"))).toEqual(ref);
  });

  it("evidenceRefFor carries the kind and the digest, with and without a span", () => {
    const withSpan = evidenceRefFor("relay.agent", bytes("payload"), "pay");
    const withoutSpan = evidenceRefFor("relay.agent", bytes("payload"));
    const s1 = JSON.stringify(withSpan);
    const s2 = JSON.stringify(withoutSpan);
    expect(s1).toContain("relay.agent");
    expect(s1).toContain(sha256Hex(bytes("payload")));
    expect(s1).toContain("pay");
    expect(s2).not.toContain('"pay"');
  });

  it("isWellFormedMotebitId accepts a UUID-shaped id and rejects junk", () => {
    expect(isWellFormedMotebitId("019d0400-0000-7000-8000-000000000000")).toBe(true);
    expect(isWellFormedMotebitId("../../etc/passwd")).toBe(false);
    expect(isWellFormedMotebitId("")).toBe(false);
  });
});
