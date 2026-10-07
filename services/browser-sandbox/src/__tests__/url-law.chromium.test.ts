/**
 * End-to-end: the outbound-URL law against a REAL Chromium.
 *
 * The unit suite (url-law.test.ts) pins each enforcement point in
 * isolation. This file proves they compose in a live browser — in
 * particular the case `context.route` alone cannot catch, because
 * Playwright never routes redirect hops: a public page that 302s to a
 * forbidden address, and a public page whose script / frame / image
 * reach for one. The forbidden target is the test's own loopback server,
 * so a bypass shows up as a recorded hit.
 *
 * Skipped when no Chromium binary is installed (the unit suite still
 * runs); runs wherever Playwright's Chromium is present, or point
 * `CHROMIUM_EXECUTABLE_PATH` at one.
 */

import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { chromium } from "playwright-core";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { BrowserPool } from "../chromium-pool.js";
import { executeAction } from "../action-executor.js";
import { defaultCheckTarget, startEgressProxy, type EgressProxy } from "../url-law.js";

const executable = (() => {
  try {
    const p = process.env["CHROMIUM_EXECUTABLE_PATH"] || chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

describe.skipIf(executable === null)("url law — real Chromium", () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  let proxy: EgressProxy;
  let pool: BrowserPool;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      const forbidden = `http://127.0.0.1:${port}`;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `${forbidden}/secret-redirect` });
        res.end();
        return;
      }
      if (req.url === "/reaches") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<p>public</p>` +
            `<script>fetch("${forbidden}/secret-fetch").catch(()=>{})</script>` +
            `<img src="http://localhost:${port}/secret-img">` +
            `<iframe src="/redirect"></iframe>`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p>hello</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    // `public.test` stands in for a public host (mapped to the local
    // server); every other target meets the production law.
    proxy = await startEgressProxy({
      checkTarget: async (url) =>
        new URL(url).hostname === "public.test"
          ? { ok: true, address: "127.0.0.1" }
          : defaultCheckTarget(url),
    });
    pool = new BrowserPool({
      maxConcurrent: 1,
      idleMs: 60_000,
      viewportWidth: 800,
      viewportHeight: 600,
      egressProxyServer: proxy.url,
    });
    await pool.start(() => chromium.launch({ executablePath: executable!, headless: true }));
  }, 60_000);

  afterAll(async () => {
    await pool?.shutdown();
    await proxy?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("public browsing works through the egress proxy", async () => {
    const session = await pool.openSession();
    const result = await executeAction(session, {
      kind: "navigate",
      url: `http://public.test:${port}/hello`,
    });
    expect(result.ok).toBe(true);
    expect(await session.page.textContent("p")).toBe("hello");
    await pool.closeSession(session.sessionId);
  }, 30_000);

  it("refuses a redirect hop and in-page reaches to forbidden targets", async () => {
    const session = await pool.openSession();
    // The hop is refused by the egress proxy (403), so the navigation
    // fails rather than rendering the forbidden target.
    await expect(
      executeAction(session, { kind: "navigate", url: `http://public.test:${port}/redirect` }),
    ).rejects.toThrow(/navigate failed/);
    await pool.closeSession(session.sessionId);

    const second = await pool.openSession();
    await executeAction(second, { kind: "navigate", url: `http://public.test:${port}/reaches` });
    await second.page.waitForTimeout(1_000);
    expect(hits).toContain("/reaches");
    expect(hits).toContain("/redirect");
    expect(hits.filter((h) => h.startsWith("/secret"))).toEqual([]);
    await pool.closeSession(second.sessionId);
  }, 30_000);
});
