/**
 * The relay test network guard's decision and its two hooks — plain ESM so
 * the same code guards the vitest workers (`network-guard.setup.ts`) and the
 * relay CHILDREN the booted-entry harness spawns (`network-guard.preload.mjs`,
 * loaded with `node --import` before `dist/server.js` or the tsx entry).
 *
 * Deny by default. A socket connect is allowed only when it is PROVABLY
 * local: a unix socket (a non-empty string `path`) or a loopback host
 * (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`). Anything
 * else — a non-loopback host, a missing host, `path: null` (what Node's
 * http Agent passes for every `http.request` / `https.request`, `ws` and
 * Stripe dial) — is refused before it dials.
 */
import net from "node:net";

/** The line prefix a guarded relay child writes to stderr per refused dial. */
export const CHILD_REFUSAL_MARKER = "[network-guard] relay test reached the network:";

/** @param {unknown} host */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || host === "") return false;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    h === "::ffff:127.0.0.1" ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === "0.0.0.0"
  );
}

/**
 * Classify the arguments of `net.Socket.prototype.connect` — every form Node
 * accepts: the internal normalized `[options, cb]`, `(options[, cb])`,
 * `(path[, cb])`, `(port[, host][, cb])`.
 * @param {unknown[]} args
 * @returns {{ allowed: boolean, target: string }}
 */
export function classifyConnect(args) {
  const first = args[0];
  /** @type {unknown} */ let host;
  /** @type {unknown} */ let path;
  /** @type {unknown} */ let port;
  const opts = Array.isArray(first) ? first[0] : first;
  if (typeof opts === "object" && opts !== null) {
    const o = /** @type {Record<string, unknown>} */ (opts);
    host = o.host;
    path = o.path;
    port = o.port;
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    path = first;
  } else {
    port = first;
    host = typeof args[1] === "string" ? args[1] : undefined;
  }
  if (typeof path === "string" && path !== "") return { allowed: true, target: `unix ${path}` };
  const target = `socket ${typeof host === "string" && host !== "" ? host : "<no host>"}:${String(port)}`;
  return { allowed: isLoopbackHost(host), target };
}

/**
 * Patch `net.Socket.prototype.connect` (every TCP/TLS client: undici,
 * `http(s).request`, `ws`, `tls.connect`). `refuse(target)` records the
 * violation and returns the error the socket is destroyed with.
 * @param {(target: string) => Error} refuse
 */
export function installSocketGuard(refuse) {
  const realConnect = net.Socket.prototype.connect;
  /** @this {net.Socket} @param {unknown[]} args */
  function guardedConnect(...args) {
    const { allowed, target } = classifyConnect(args);
    if (!allowed) {
      const err = refuse(target);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return Reflect.apply(realConnect, this, args);
  }
  net.Socket.prototype.connect = /** @type {typeof realConnect} */ (
    /** @type {unknown} */ (guardedConnect)
  );
}

/**
 * Wrap `globalThis.fetch`: a non-loopback http(s)/ws URL rejects at once
 * with the URL (the precise message; the socket hook still backs it).
 * @param {(target: string) => Error} refuse
 */
export function installFetchGuard(refuse) {
  const realFetch = globalThis.fetch;
  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  const guardedFetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (
        ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) &&
        !isLoopbackHost(parsed.hostname)
      ) {
        return Promise.reject(refuse(`fetch ${parsed.origin}${parsed.pathname}`));
      }
    } catch {
      // A relative or unparsable URL never leaves the process — let fetch decide.
    }
    return realFetch(input, init);
  };
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (guardedFetch);
}
