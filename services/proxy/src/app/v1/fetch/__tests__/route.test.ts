import { describe, it, expect, vi, beforeEach } from "vitest";

// The route reads KV lazily; with no KV_REST_API_URL it skips rate limiting.
delete process.env.KV_REST_API_URL;

const { POST } = await import("../route");

function req(url: unknown, origin = "https://motebit.com"): Request {
  return new Request("https://api.motebit.com/v1/fetch", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ url }),
  });
}

describe("POST /v1/fetch — outbound URL law", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "http://127.0.0.1:8080/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://motebit-sync.internal:8080/api/v1/admin",
    "http://localhost:3000/",
    "http://2130706433/",
  ])("refuses %s with 400 and never fetches", async (url) => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req(url));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("url_not_allowed");
    expect(body.reason).toBe("host_not_public");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses non-http schemes and credentials", async () => {
    for (const url of ["file:///etc/passwd", "ftp://x/", "https://a:b@example.com/"]) {
      const res = await POST(req(url));
      expect(res.status).toBe(400);
    }
  });

  it("refuses a public → private redirect at the hop", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      );
    const res = await POST(req("https://example.com/start"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("url_not_allowed");
    expect(body.reason).toBe("host_not_public");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });

  it("fetches a public URL manually-redirected to another public URL", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "https://cdn.example/x" } }),
      )
      .mockResolvedValueOnce(
        new Response("<p>hello</p>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    const res = await POST(req("https://example.com/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: string };
    expect(body.ok).toBe(true);
    expect(body.data).toContain("hello");
  });

  it("still requires an allowed Origin (CORS gate, not auth)", async () => {
    const res = await POST(req("https://example.com/", "https://evil.example"));
    expect(res.status).toBe(403);
  });
});
