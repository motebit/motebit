import { describe, it, expect, vi } from "vitest";
import {
  checkOutboundUrl,
  assertOutboundUrl,
  fetchPublic,
  isPublicAddress,
  OutboundUrlRefusedError,
} from "../outbound-url";

const ok = async (u: string) => (await checkOutboundUrl(u)).ok;
const reason = async (u: string) => {
  const v = await checkOutboundUrl(u);
  return v.ok ? "ok" : v.reason;
};

describe("checkOutboundUrl — scheme + shape", () => {
  it("accepts plain public http(s)", async () => {
    expect(await ok("https://example.com/path?q=1")).toBe(true);
    expect(await ok("http://93.184.216.34/")).toBe(true);
  });
  it("refuses other schemes, credentials, junk", async () => {
    expect(await reason("file:///etc/passwd")).toBe("scheme_not_allowed");
    expect(await reason("gopher://example.com")).toBe("scheme_not_allowed");
    expect(await reason("javascript:alert(1)")).toBe("scheme_not_allowed");
    expect(await reason("https://user:pw@example.com/")).toBe("credentials_in_url");
    expect(await reason("not a url")).toBe("invalid_url");
    expect((await checkOutboundUrl(undefined)).ok).toBe(false);
    expect((await checkOutboundUrl("x".repeat(9000))).ok).toBe(false);
  });
});

describe("checkOutboundUrl — non-public literals are refused", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.5.5/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.5]/",
    "http://[64:ff9b::a00:1]/",
    "http://[2002:0a00:0001::]/",
  ])("%s", async (u) => {
    expect(await reason(u)).toBe("host_not_public");
  });

  it("refuses IPv4 written as decimal / octal / hex / short forms (WHATWG normalises them)", async () => {
    // 2130706433 = 127.0.0.1; 0x7f000001; 0177.0.0.1; 127.1
    for (const u of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ]) {
      expect(await reason(u)).toBe("host_not_public");
    }
  });

  it("but 172.32.x and 100.128.x are public (range edges)", async () => {
    expect(await ok("http://172.32.0.1/")).toBe(true);
    expect(await ok("http://100.128.0.1/")).toBe(true);
    expect(await ok("http://[2001:4860:4860::8888]/")).toBe(true);
  });
});

describe("checkOutboundUrl — blocked names", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST:3000/",
    "http://foo.localhost/",
    "http://printer.local/",
    "http://motebit-sync.internal:8080/api/v1/admin",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://router.home.arpa/",
    "http://localhost./",
  ])("%s", async (u) => {
    expect(await reason(u)).toBe("host_not_public");
  });
});

describe("checkOutboundUrl — resolver", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34", "10.0.0.7"]);
    const v = await checkOutboundUrl("https://rebind.example/", { resolve });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("resolved_address_not_public");
    expect(resolve).toHaveBeenCalledWith("rebind.example");
  });
  it("refuses when resolution fails or is empty; accepts when all addresses are public", async () => {
    expect(
      (
        await checkOutboundUrl("https://x.example/", {
          resolve: async () => {
            throw new Error("NXDOMAIN");
          },
        })
      ).ok,
    ).toBe(false);
    expect((await checkOutboundUrl("https://x.example/", { resolve: async () => [] })).ok).toBe(
      false,
    );
    expect(
      (
        await checkOutboundUrl("https://x.example/", {
          resolve: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
        })
      ).ok,
    ).toBe(true);
  });
  it("does not resolve literals (nothing to resolve) and never resolves blocked names", async () => {
    const resolve = vi.fn(async () => ["1.1.1.1"]);
    await checkOutboundUrl("http://10.1.1.1/", { resolve });
    await checkOutboundUrl("http://localhost/", { resolve });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("allowPrivateNetwork (local development only)", () => {
  it("permits loopback + private when explicitly allowed; scheme law still applies", async () => {
    expect(
      (await checkOutboundUrl("http://localhost:3000/", { allowPrivateNetwork: true })).ok,
    ).toBe(true);
    expect((await checkOutboundUrl("http://192.168.1.10/", { allowPrivateNetwork: true })).ok).toBe(
      true,
    );
    expect((await checkOutboundUrl("file:///x", { allowPrivateNetwork: true })).ok).toBe(false);
  });
});

describe("isPublicAddress", () => {
  it("classifies bare addresses; non-addresses are not public", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1%en0")).toBe(false);
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("fetchPublic — redirects re-apply the law", () => {
  const redirectTo = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  it("follows a public → public redirect and returns the final response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectTo("https://cdn.example/final"))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    const res = await fetchPublic("https://example.com/start", {}, { fetchImpl });
    expect(await res.text()).toBe("done");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).redirect).toBe("manual");
  });

  it("refuses a public → metadata redirect at the hop, never fetching the private target", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectTo("http://169.254.169.254/latest/meta-data/"));
    await expect(fetchPublic("https://example.com/x", {}, { fetchImpl })).rejects.toBeInstanceOf(
      OutboundUrlRefusedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves relative Location against the current URL and caps hops", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => redirectTo("/again"));
    await expect(
      fetchPublic("https://example.com/a", {}, { fetchImpl, maxRedirects: 3 }),
    ).rejects.toThrow(/too many redirects/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://example.com/again");
  });

  it("refuses the initial URL before any network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchPublic("http://10.0.0.1/", {}, { fetchImpl })).rejects.toBeInstanceOf(
      OutboundUrlRefusedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("assertOutboundUrl throws a typed error carrying the reason", async () => {
    await expect(assertOutboundUrl("http://localhost/")).rejects.toMatchObject({
      name: "OutboundUrlRefusedError",
      reason: "host_not_public",
    });
  });
});
