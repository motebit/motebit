/**
 * The outbound-URL law at the browser-sandbox seam.
 *
 * The sandbox drives a real Chromium from a server's network position.
 * Every URL that browser reaches — the navigate target, every in-page
 * sub-request, every redirect hop — is a server-side request forgery
 * primitive until proven otherwise: cloud metadata (169.254.169.254,
 * fd00:ec2::254), loopback admin ports, RFC 1918 / ULA neighbours, the
 * Fly 6PN private network, `*.internal` service names. The law itself
 * lives in ONE place — `checkOutboundUrl` in `@motebit/sdk`, the same
 * function the proxy's `/v1/fetch`, the read-url atom and the relay's
 * agent/federation fetches apply. This module only binds it to the three
 * enforcement points a browser has:
 *
 *   1. Navigation — `assertNavigableUrl` runs before `page.goto` for the
 *      motebit's `navigate` action and the user's address-bar navigate.
 *      Non-http(s) schemes (`file:`, `javascript:`, `chrome:`, `data:`)
 *      are refused here.
 *   2. Sub-requests — `installSubRequestGuard` puts a `context.route`
 *      handler on every session context; requests to forbidden literals
 *      and names are aborted (`blockedbyclient`).
 *   3. Egress proxy — every Chromium connection (including what the
 *      route layer cannot see: Playwright never routes redirect hops,
 *      WebSockets, service-worker fetches) goes through a local forward
 *      proxy that applies the law to the target and to its RESOLVED
 *      addresses, then connects to the exact address it checked. That is
 *      the connect-time pin `checkOutboundUrl`'s doc says a policy check
 *      alone cannot provide, so a public name re-resolving to 10.0.0.1
 *      between check and connect is closed here too.
 *
 * Points 1 and 2 check literals and names only (no DNS) — cheap, and they
 * give the motebit a typed `policy_denied` instead of a network error.
 * Point 3 is the floor that resolves.
 */

import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { checkOutboundUrl } from "@motebit/sdk";
import type { BrowserContext, Route } from "playwright-core";

import { ServiceError } from "./errors.js";

// ── 1. Navigation ──────────────────────────────────────────────────────

/** `scheme:` at the start of the input, unless it is really `host:port`. */
const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/**
 * Normalise a navigate input and apply the law (literals + names). A
 * scheme-less input (`example.com`, `example.com:8080/x`) is treated as a
 * hostname-leading path and prefixed with `https://`; an explicit scheme
 * other than http/https is refused. Returns the URL to hand `page.goto`, or
 * throws `ServiceError("policy_denied")`.
 */
export async function assertNavigableUrl(raw: string): Promise<string> {
  const scheme = EXPLICIT_SCHEME.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1]!)) {
    throw new ServiceError("policy_denied", `navigation refused: scheme ${scheme[1]}: not allowed`);
  }
  const url = scheme ? raw : `https://${raw}`;
  const verdict = await checkOutboundUrl(url);
  if (!verdict.ok) {
    throw new ServiceError(
      "policy_denied",
      `navigation refused: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    );
  }
  return url;
}

// ── 2. Sub-requests ────────────────────────────────────────────────────

/** In-page schemes that never leave the browser process. */
const LOCAL_SCHEMES = new Set(["data:", "blob:"]);

/**
 * `context.route` handler: abort a request whose URL the law refuses
 * (literals + names), continue the rest. Exported so the pool and tests
 * reference the same function.
 */
export async function guardSubRequest(route: Route): Promise<void> {
  const url = route.request().url();
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    await route.abort("blockedbyclient");
    return;
  }
  if (LOCAL_SCHEMES.has(protocol)) {
    await route.continue();
    return;
  }
  const verdict = await checkOutboundUrl(url);
  if (!verdict.ok) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
}

/** Install the sub-request guard on a session context (every URL). */
export async function installSubRequestGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", guardSubRequest);
}

// ── 3. Egress proxy ────────────────────────────────────────────────────

export type TargetVerdict = { ok: true; address: string } | { ok: false; reason: string };

/** Decide a proxied target (`http://host:port/...`) and name the address to dial. */
export type CheckTarget = (url: string) => Promise<TargetVerdict>;

type Resolve = (hostname: string) => Promise<string[]>;

const systemResolve: Resolve = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The law with resolution: every resolved address must be public, and the
 * address returned is one of the addresses that was checked — the proxy
 * dials exactly that, never re-resolving.
 */
export async function defaultCheckTarget(
  url: string,
  resolve: Resolve = systemResolve,
): Promise<TargetVerdict> {
  let resolved: string[] = [];
  const verdict = await checkOutboundUrl(url, {
    resolve: async (hostname) => {
      resolved = await resolve(hostname);
      return resolved;
    },
  });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: `${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    };
  }
  const host = verdict.url.hostname.replace(/^\[(.*)\]$/, "$1");
  const address = net.isIP(host) !== 0 ? host : resolved[0];
  if (address === undefined) return { ok: false, reason: "resolution_failed" };
  return { ok: true, address };
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` — hand to `newContext({ proxy: { server } })`. */
  readonly url: string;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  readonly checkTarget?: CheckTarget;
  readonly log?: (msg: string) => void;
}

const HOP_BY_HOP = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

function refuseSocket(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/**
 * Start the loopback forward proxy every session context egresses through.
 * Plain-http requests arrive in absolute form and are re-issued to the
 * checked address with the original `Host`; https / wss arrive as CONNECT
 * and are tunnelled to the checked address. A redirect response is passed
 * back to Chromium untouched — the hop it then follows is a new proxied
 * request and meets the law again. Refusals are `403`.
 */
export async function startEgressProxy(opts: EgressProxyOptions = {}): Promise<EgressProxy> {
  const checkTarget = opts.checkTarget ?? defaultCheckTarget;
  const log = opts.log ?? (() => undefined);

  const server = http.createServer((req, res) => {
    void (async () => {
      const target = req.url ?? "";
      if (!/^https?:\/\//i.test(target)) {
        res.writeHead(400).end();
        return;
      }
      const verdict = await checkTarget(target);
      if (!verdict.ok) {
        log(`egress refused ${target}: ${verdict.reason}`);
        res.writeHead(403).end();
        return;
      }
      const u = new URL(target);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      }
      headers["host"] = u.host;
      const upstream = http.request(
        {
          host: verdict.address,
          port: u.port === "" ? 80 : Number(u.port),
          method: req.method,
          path: `${u.pathname}${u.search}`,
          headers,
          setHost: false,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    })();
  });

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    void (async () => {
      client.on("error", () => client.destroy());
      const authority = req.url ?? "";
      let port: number;
      let verdict: TargetVerdict;
      try {
        const u = new URL(`http://${authority}/`);
        port = u.port === "" ? 80 : Number(u.port);
        verdict = await checkTarget(u.href);
      } catch {
        refuseSocket(client, "400 Bad Request");
        return;
      }
      if (!verdict.ok) {
        log(`egress refused CONNECT ${authority}: ${verdict.reason}`);
        refuseSocket(client, "403 Forbidden");
        return;
      }
      const upstream = net.connect(port, verdict.address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => refuseSocket(client, "502 Bad Gateway"));
    })();
  });

  // A plain-http WebSocket upgrade without CONNECT is not a shape Chromium
  // sends through an http proxy; refuse rather than tunnel unchecked.
  server.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => {
    refuseSocket(socket, "403 Forbidden");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
