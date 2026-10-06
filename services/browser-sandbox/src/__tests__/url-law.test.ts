/**
 * The outbound-URL law at the browser-sandbox seam.
 *
 * The sandbox drives a real Chromium from a server's network position,
 * so every URL the page reaches is a server-side request forgery
 * primitive until proven otherwise — the same law (`checkOutboundUrl`
 * from `@motebit/sdk`) the proxy, the read-url atom and the relay apply.
 * Three enforcement points, each pinned here:
 *
 *   1. Navigation (`navigate` action + user address-bar `navigate`):
 *      refused before `page.goto` runs.
 *   2. Sub-requests (`context.route` guard): in-page fetches, frames,
 *      images to forbidden targets are aborted.
 *   3. Egress proxy (every Chromium connection): redirect hops and
 *      anything the route layer cannot see (Playwright does not route
 *      redirect hops) are refused at connect time, against the
 *      RESOLVED address.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { BrowserContext, Page, Route } from "playwright-core";

import type { BrowserSession } from "../chromium-pool.js";
import { BrowserPool } from "../chromium-pool.js";
import { executeAction, executeUserInput } from "../action-executor.js";
import { isServiceError } from "../errors.js";
import {
  assertNavigableUrl,
  defaultCheckTarget,
  guardSubRequest,
  installSubRequestGuard,
  startEgressProxy,
  type CheckTarget,
  type EgressProxy,
} from "../url-law.js";

const FORBIDDEN = [
  "file:///etc/passwd",
  "http://169.254.169.254/latest/meta-data/",
  "http://[fd00:ec2::254]/latest/meta-data/",
  "http://localhost:3000/",
  "http://127.0.0.1:8080/",
  "http://10.0.0.5/",
  "http://192.168.1.1/",
  "http://my-app.internal/",
  "http://[fdaa:0:1::3]/", // Fly 6PN private network
  "javascript:alert(1)",
  "chrome://settings",
];

function fakeSession(): { session: BrowserSession; goto: ReturnType<typeof vi.fn> } {
  let current = "about:blank";
  const goto = vi.fn(async (url: string) => {
    current = url;
  });
  const page = {
    goto,
    url: () => current,
    waitForLoadState: async () => undefined,
    evaluate: async () => ({ blankish: false, denied: false, botDetection: false }),
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff]),
    viewportSize: () => ({ width: 1280, height: 800 }),
  } as unknown as Page;
  const session = {
    sessionId: "s",
    motebitId: null,
    context: {} as BrowserContext,
    page,
    openedAt: 0,
    lastUsedAt: 0,
    lastCursorX: 0,
    lastCursorY: 0,
    inFlight: 0,
    stopScreencast: null,
  } as BrowserSession;
  return { session, goto };
}

describe("navigation — refused before page.goto", () => {
  for (const url of FORBIDDEN) {
    it(`navigate action refuses ${url}`, async () => {
      const { session, goto } = fakeSession();
      const err = await executeAction(session, { kind: "navigate", url }).catch((e: unknown) => e);
      expect(isServiceError(err)).toBe(true);
      expect((err as { reason: string }).reason).toBe("policy_denied");
      expect(goto).not.toHaveBeenCalled();
    });

    it(`address-bar navigate refuses ${url}`, async () => {
      const { session, goto } = fakeSession();
      const err = await executeUserInput(session, { kind: "navigate", url }).catch(
        (e: unknown) => e,
      );
      expect(isServiceError(err)).toBe(true);
      expect((err as { reason: string }).reason).toBe("policy_denied");
      expect(goto).not.toHaveBeenCalled();
    });
  }

  it("a public URL is still navigated (scheme-less normalised to https)", async () => {
    const { session, goto } = fakeSession();
    await executeAction(session, { kind: "navigate", url: "example.com/about" });
    expect(goto).toHaveBeenCalledWith("https://example.com/about", expect.anything());
    await executeUserInput(session, { kind: "navigate", url: "https://motebit.com" });
    expect(goto).toHaveBeenCalledWith("https://motebit.com", expect.anything());
  });

  it("assertNavigableUrl returns the normalised URL for public hosts", async () => {
    expect(await assertNavigableUrl("example.com")).toBe("https://example.com");
    expect(await assertNavigableUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(await assertNavigableUrl("http://example.com/x")).toBe("http://example.com/x");
  });
});

function fakeRoute(url: string): {
  route: Route;
  abort: ReturnType<typeof vi.fn>;
  cont: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn(async () => undefined);
  const cont = vi.fn(async () => undefined);
  const route = {
    request: () => ({ url: () => url }),
    abort,
    continue: cont,
  } as unknown as Route;
  return { route, abort, cont };
}

describe("sub-requests — context.route guard", () => {
  for (const url of FORBIDDEN.filter((u) => !u.startsWith("javascript:"))) {
    it(`aborts a sub-request to ${url}`, async () => {
      const { route, abort, cont } = fakeRoute(url);
      await guardSubRequest(route);
      expect(abort).toHaveBeenCalledWith("blockedbyclient");
      expect(cont).not.toHaveBeenCalled();
    });
  }

  it("continues public http(s), data: and blob: sub-requests", async () => {
    for (const url of [
      "https://cdn.example.com/app.js",
      "http://example.org/img.png",
      "data:image/png;base64,AAAA",
      "blob:https://example.com/0f3c",
    ]) {
      const { route, abort, cont } = fakeRoute(url);
      await guardSubRequest(route);
      expect(cont).toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    }
  });

  it("aborts a sub-request whose URL does not parse", async () => {
    const { route, abort } = fakeRoute("not a url");
    await guardSubRequest(route);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it("installSubRequestGuard routes every URL on the context", async () => {
    const routeSpy = vi.fn(async () => undefined);
    await installSubRequestGuard({ route: routeSpy } as unknown as BrowserContext);
    expect(routeSpy).toHaveBeenCalledWith("**/*", guardSubRequest);
  });
});

describe("BrowserPool wires the guard + egress proxy into every context", () => {
  it("routes the context and passes the proxy server to newContext", async () => {
    const route = vi.fn(async () => undefined);
    const newContext = vi.fn(async () => ({
      route,
      newPage: async () => ({}) as Page,
      close: async () => undefined,
    }));
    const pool = new BrowserPool({
      maxConcurrent: 2,
      idleMs: 60_000,
      viewportWidth: 1280,
      viewportHeight: 800,
      egressProxyServer: "http://127.0.0.1:9999",
    });
    await pool.start(async () => ({ newContext, close: async () => undefined }) as never);
    await pool.openSession();
    expect(newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { server: "http://127.0.0.1:9999", bypass: "<-loopback>" },
      }),
    );
    expect(route).toHaveBeenCalledWith("**/*", guardSubRequest);
  });
});

describe("BrowserPool fails closed when the guard cannot be installed", () => {
  it("closes the context and refuses the session", async () => {
    const close = vi.fn(async () => undefined);
    const newPage = vi.fn(async () => ({}) as Page);
    const newContext = vi.fn(async () => ({
      route: async () => {
        throw new Error("route failed");
      },
      newPage,
      close,
    }));
    const pool = new BrowserPool({
      maxConcurrent: 2,
      idleMs: 60_000,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    await pool.start(async () => ({ newContext, close: async () => undefined }) as never);
    await expect(pool.openSession()).rejects.toThrow("route failed");
    expect(close).toHaveBeenCalled();
    expect(newPage).not.toHaveBeenCalled();
  });
});

// ── Egress proxy — real sockets, injected resolution ──────────────────

let upstream: http.Server;
let upstreamPort = 0;
const upstreamHits: string[] = [];

/**
 * Test resolution: `public.test` stands in for a public host and maps to
 * the local upstream; everything else goes through the real law (so
 * 169.254.169.254 / localhost / 10.x are refused exactly as in prod).
 */
const testCheck: CheckTarget = async (url) => {
  const u = new URL(url);
  if (u.hostname === "public.test") return { ok: true, address: "127.0.0.1" };
  return defaultCheckTarget(url);
};

let proxy: EgressProxy;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url ?? "");
    if (req.url === "/redirect-to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello ${req.headers.host}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;
  proxy = await startEgressProxy({ checkTarget: testCheck });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function proxyGet(target: string): Promise<{ status: number; body: string; location?: string }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: p.hostname, port: Number(p.port), method: "GET", path: target },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            location: res.headers.location,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function proxyConnect(authority: string): Promise<string> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(p.port), p.hostname, () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.includes("\r\n\r\n")) {
        sock.destroy();
        resolve(buf.split("\r\n")[0] ?? "");
      }
    });
    sock.on("error", reject);
  });
}

describe("egress proxy — the connect-time law", () => {
  it("forwards a plain-http request to a public host", async () => {
    const res = await proxyGet(`http://public.test:${upstreamPort}/page`);
    expect(res.status).toBe(200);
    // Host header preserved — the upstream sees the name, not the IP.
    expect(res.body).toBe(`hello public.test:${upstreamPort}`);
  });

  it("passes a redirect through, then refuses the forbidden hop the browser follows", async () => {
    const first = await proxyGet(`http://public.test:${upstreamPort}/redirect-to-metadata`);
    expect(first.status).toBe(302);
    const hop = await proxyGet(first.location!);
    expect(hop.status).toBe(403);
  });

  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:1/",
    `http://127.0.0.1:${0}/`,
    "http://10.1.2.3/",
    "http://svc.internal/",
  ]) {
    it(`refuses plain-http ${target}`, async () => {
      const before = upstreamHits.length;
      const res = await proxyGet(target);
      expect(res.status).toBe(403);
      expect(upstreamHits.length).toBe(before);
    });
  }

  it("refuses a non-absolute request line", async () => {
    const res = await proxyGet("/not-a-proxy-request");
    expect(res.status).toBe(400);
  });

  it("tunnels CONNECT to a public host", async () => {
    const line = await proxyConnect(`public.test:${upstreamPort}`);
    expect(line).toMatch(/^HTTP\/1\.1 200/);
  });

  for (const authority of [
    "169.254.169.254:80",
    "[fd00:ec2::254]:443",
    "localhost:443",
    "10.0.0.1:443",
    "metadata.google.internal:80",
  ]) {
    it(`refuses CONNECT ${authority}`, async () => {
      const line = await proxyConnect(authority);
      expect(line).toMatch(/^HTTP\/1\.1 403/);
    });
  }

  it("refuses a malformed CONNECT authority", async () => {
    const line = await proxyConnect("[not-an-address");
    expect(line).toMatch(/^HTTP\/1\.1 400/);
  });

  it("answers 502 when the checked upstream is down", async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect((await proxyGet(`http://public.test:${deadPort}/`)).status).toBe(502);
    expect(await proxyConnect(`public.test:${deadPort}`)).toMatch(/^HTTP\/1\.1 502/);
  });

  it("refuses a plain-http upgrade (never tunnelled unchecked)", async () => {
    const p = new URL(proxy.url);
    const line = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(Number(p.port), p.hostname, () => {
        sock.write(
          `GET http://public.test:${upstreamPort}/ws HTTP/1.1\r\nHost: public.test\r\n` +
            `Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
      let buf = "";
      sock.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("\r\n")) {
          sock.destroy();
          resolve(buf.split("\r\n")[0] ?? "");
        }
      });
      sock.on("error", reject);
    });
    expect(line).toMatch(/^HTTP\/1\.1 403/);
  });

  it("logs refusals through the injected logger", async () => {
    const lines: string[] = [];
    const logged = await startEgressProxy({ log: (m) => lines.push(m) });
    const p = new URL(logged.url);
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: p.hostname, port: Number(p.port), path: "http://169.254.169.254/" },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.end();
    });
    await logged.close();
    expect(lines.some((l) => l.includes("169.254.169.254"))).toBe(true);
  });

  it("defaultCheckTarget fails closed when resolution yields nothing usable", async () => {
    const v = await defaultCheckTarget("http://empty.example/", async () => []);
    expect(v.ok).toBe(false);
  });

  it("defaultCheckTarget refuses a public name that resolves to a private address", async () => {
    const v = await defaultCheckTarget("http://rebind.example/", async () => ["10.0.0.7"]);
    expect(v.ok).toBe(false);
  });

  it("defaultCheckTarget returns the resolved address it checked", async () => {
    const v = await defaultCheckTarget("http://pub.example/", async () => ["93.184.216.34"]);
    expect(v).toEqual({ ok: true, address: "93.184.216.34" });
    const lit = await defaultCheckTarget("http://[2606:4700::1]:8080/");
    expect(lit).toEqual({ ok: true, address: "2606:4700::1" });
  });
});
