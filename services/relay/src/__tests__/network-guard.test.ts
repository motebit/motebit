/**
 * The relay test network guard (`network-guard.setup.ts`, decision in
 * `network-guard-core.mjs`) is DENY BY DEFAULT: every client that dials a
 * non-loopback host is refused before it dials — not just `fetch`, but
 * Node's http Agent (`http.request` / `https.get`, which pass
 * `{ host, path: null }`), `ws` and `tls.connect`. Loopback and unix
 * sockets stay open. Third round: UDP (`dgram`), worker threads (refused —
 * a Worker never runs the setup file) and a loopback forward proxy
 * (`CONNECT` / absolute-form over loopback; `*_PROXY` env deleted). The
 * target is TEST-NET-1 (192.0.2.1, RFC 5737): even an
 * unguarded dial reaches nobody.
 */
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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

describe("network guard: UDP, worker threads, loopback forward proxy", () => {
  it("refuses a dgram send to a non-loopback address (and allows loopback)", async () => {
    const sock = dgram.createSocket("udp4");
    sock.on("error", () => {});
    try {
      const err = await errorOf((onError) => {
        sock.send(Buffer.from("x"), 9, REMOTE, (e) => onError(e ?? new Error("sent")));
      });
      expectRefused(err);
      const ranged = await errorOf((onError) => {
        sock.send(Buffer.from("xy"), 0, 1, 9, REMOTE, (e) => onError(e ?? new Error("sent")));
      });
      expectRefused(ranged);
      const local = await errorOf((onError) => {
        sock.send(Buffer.from("x"), 9, "127.0.0.1", (e) => onError(e ?? new Error("sent")));
      });
      expect(local?.message).toBe("sent");
      expect(GUARD.drain()).toEqual([]);
    } finally {
      sock.close();
    }
  });

  it("refuses a dgram connect to a non-loopback address", async () => {
    const sock = dgram.createSocket("udp4");
    sock.on("error", () => {});
    try {
      const err = await errorOf((onError) => {
        // Node calls a connect callback with the error when the connect fails.
        sock.connect(9, REMOTE, ((e?: Error) =>
          onError(e ?? new Error("connected"))) as () => void);
      });
      expectRefused(err);
    } finally {
      sock.close();
    }
  });

  it("refuses creating a worker thread (it would run unguarded)", async () => {
    let worker: Worker | undefined;
    try {
      expect(() => {
        worker = new Worker("require('node:net')", { eval: true });
      }).toThrow(/relay test reached the network: worker_threads\.Worker/);
      expect(GUARD.drain().some((l) => l.includes("worker_threads.Worker"))).toBe(true);
    } finally {
      await worker?.terminate();
    }
  });

  it("deletes every *_PROXY env var", () => {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      expect(process.env[k], k).toBeUndefined();
      expect(process.env[k.toLowerCase()], k.toLowerCase()).toBeUndefined();
    }
  });

  it("refuses CONNECT and absolute-form requests through a loopback forward proxy", async () => {
    const received: string[] = [];
    const proxy = net.createServer((s) => {
      s.on("data", (c: Buffer) => received.push(c.toString("latin1")));
      s.on("error", () => {});
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const { port } = proxy.address() as net.AddressInfo;
    try {
      const viaConnect = await errorOf((onError) => {
        http
          .request({ host: "127.0.0.1", port, method: "CONNECT", path: `${REMOTE}:443` })
          .on("error", onError)
          .end();
      });
      expectRefused(viaConnect);
      const viaAbsolute = await errorOf((onError) => {
        http.get({ host: "127.0.0.1", port, path: `http://${REMOTE}/` }).on("error", onError);
      });
      expectRefused(viaAbsolute);
      await new Promise((r) => setTimeout(r, 50));
      expect(received.join("")).not.toContain(REMOTE);
    } finally {
      proxy.close();
    }
  });
});

describe("network guard: the RESOLVED address is checked, not just the host name", () => {
  it("refuses a loopback-named connect whose lookup resolves to a non-loopback address", async () => {
    const lookup = ((
      _host: string,
      opts: { all?: boolean },
      cb: (err: Error | null, address: unknown, family?: number) => void,
    ) =>
      opts.all === true
        ? cb(null, [{ address: REMOTE, family: 4 }])
        : cb(null, REMOTE, 4)) as unknown as net.LookupFunction;
    for (const autoSelectFamily of [true, false]) {
      let connected = false;
      const err = await errorOf((onError) => {
        const sock = net.connect({ host: "localhost", port: 9, lookup, autoSelectFamily });
        sock.on("connect", () => (connected = true));
        sock.on("error", onError);
      });
      expect(connected).toBe(false);
      expectRefused(err);
    }
  });

  it("refuses when ANY resolved address is non-loopback (happy-eyeballs fallback)", async () => {
    const lookup = ((
      _host: string,
      _opts: unknown,
      cb: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
    ) =>
      cb(null, [
        { address: "127.0.0.1", family: 4 },
        { address: REMOTE, family: 4 },
      ])) as unknown as net.LookupFunction;
    const err = await errorOf((onError) => {
      net
        .connect({ host: "localhost", port: 1, lookup, autoSelectFamily: true })
        .on("error", onError);
    });
    expectRefused(err);
  });

  it("still allows a loopback-named connect that resolves to loopback", async () => {
    const server = net.createServer((s) => s.end("hi"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    try {
      const got = await new Promise<string>((resolve, reject) => {
        let b = "";
        net
          .connect({ host: "localhost", port, family: 4 })
          .on("data", (c: Buffer) => (b += c.toString()))
          .on("end", () => resolve(b))
          .on("error", reject);
      });
      expect(got).toBe("hi");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(GUARD.drain()).toEqual([]);
  });
});
