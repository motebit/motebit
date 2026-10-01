/**
 * The relay test network guard (`network-guard.setup.ts`, decision in
 * `network-guard-core.mjs`) is DENY BY DEFAULT: every client that dials a
 * non-loopback host is refused before it dials — not just `fetch`, but
 * Node's http Agent (`http.request` / `https.get`, which pass
 * `{ host, path: null }`), `ws` and `tls.connect`. Loopback and unix
 * sockets stay open. The target is TEST-NET-1 (192.0.2.1, RFC 5737): even an
 * unguarded dial reaches nobody.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { classifyConnect } from "./network-guard-core.mjs";

const GUARD = (globalThis as Record<symbol, unknown>)[Symbol.for("motebit.relay.networkGuard")] as {
  drain(): string[];
};
const REMOTE = "192.0.2.1";

/** The error the client surfaces, or null if it neither erred nor connected within `ms`. */
function errorOf(
  start: (onError: (err: Error) => void) => void,
  ms = 3_000,
): Promise<Error | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    start((err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

function expectRefused(err: Error | null): void {
  expect(err?.message ?? "no error").toContain("relay test reached the network");
  const drained = GUARD.drain();
  expect(drained.some((l) => l.includes(REMOTE))).toBe(true);
}

describe("network guard: deny by default", () => {
  it("refuses https.get to a non-loopback host", async () => {
    const err = await errorOf((onError) => {
      https.get(`https://${REMOTE}/`).on("error", onError);
    });
    expectRefused(err);
  });

  it("refuses http.request to a non-loopback host", async () => {
    const err = await errorOf((onError) => {
      const req = http.request({ host: REMOTE, port: 80, path: "/x", method: "POST" });
      req.on("error", onError);
      req.end("{}");
    });
    expectRefused(err);
  });

  it("refuses a ws client to a non-loopback host", async () => {
    const err = await errorOf((onError) => {
      new WebSocket(`ws://${REMOTE}/`).on("error", onError);
    });
    expectRefused(err);
  });

  it("refuses tls.connect to a non-loopback host", async () => {
    const err = await errorOf((onError) => {
      tls.connect({ host: REMOTE, port: 443, servername: "example.com" }).on("error", onError);
    });
    expectRefused(err);
  });

  it("refuses a connect with no host (never assumed local)", () => {
    expect(classifyConnect([{ port: 80 }]).allowed).toBe(false);
    expect(classifyConnect([{ host: "example.com", port: 443, path: null }]).allowed).toBe(false);
    expect(classifyConnect([{ host: REMOTE, port: 80, path: "" }]).allowed).toBe(false);
  });

  it("allows a loopback http server", async () => {
    const server = http.createServer((_, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
            let b = "";
            res.on("data", (c: Buffer) => (b += c.toString()));
            res.on("end", () => resolve(b));
          })
          .on("error", reject);
      });
      expect(body).toBe("ok");
      const viaLocalhost = await fetch(`http://localhost:${port}/`).then((r) => r.text());
      expect(viaLocalhost).toBe("ok");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(GUARD.drain()).toEqual([]);
  });

  it("allows a unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-guard-"));
    const socketPath = join(dir, "s.sock");
    const server = http.createServer((_, res) => res.end("unix"));
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ socketPath, path: "/" }, (res) => {
            let b = "";
            res.on("data", (c: Buffer) => (b += c.toString()));
            res.on("end", () => resolve(b));
          })
          .on("error", reject);
      });
      expect(body).toBe("unix");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
    expect(GUARD.drain()).toEqual([]);
  });
});
