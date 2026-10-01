/**
 * The relay test network guard's decision and its hooks — plain ESM so the
 * same code guards the vitest workers (`network-guard.setup.ts`) and the
 * relay CHILDREN the booted-entry harness spawns (`network-guard.preload.mjs`,
 * loaded with `node --import` before `dist/server.js` or the tsx entry).
 *
 * Deny by default. A socket connect is allowed only when it is PROVABLY
 * local: a unix socket (a non-empty string `path`) or a loopback host
 * (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`). Anything
 * else — a non-loopback host, a missing host, `path: null` (what Node's
 * http Agent passes for every `http.request` / `https.request`, `ws` and
 * Stripe dial) — is refused before it dials.
 *
 * SCOPE — what the guard covers, in the process it is installed in:
 *   - TCP/TLS: `net.Socket.prototype.connect` (undici/fetch, http(s), ws,
 *     tls, Stripe) and `globalThis.fetch`;
 *   - UDP: `dgram.Socket.prototype.send` / `connect` to a non-loopback
 *     address;
 *   - proxies: a request written over an (allowed) loopback socket that is
 *     an HTTP `CONNECT` or an absolute-form request to a non-loopback host
 *     (a loopback forward proxy); the `*_PROXY` env vars are deleted;
 *   - worker threads: creating a `worker_threads.Worker` is REFUSED (a
 *     Worker never runs the setup file, so it would be unguarded).
 * What it does NOT cover — declared limits, not open rounds:
 *   - native addons and anything that opens sockets below Node's JS
 *     `net`/`dgram` layer (raw `process.binding`/`internalBinding` handles);
 *   - DNS lookups themselves (`dns.lookup`/`dns.resolve` still query the
 *     resolver; only the dial that follows is refused);
 *   - child processes other than the relay children the booted-entry
 *     harness spawns (`child_process.spawn('curl', …)` is unguarded);
 *   - a proxy protocol other than HTTP (SOCKS over loopback), or a loopback
 *     peer that relays bytes it was not asked to via HTTP;
 *   - code that captured `net.Socket.prototype.connect`, `dgram`'s
 *     `send`, `Worker` or `fetch` before the guard was installed.
 */
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import workerThreads from "node:worker_threads";

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

/**
 * The destination of `dgram.Socket.prototype.send`, in every form Node
 * accepts: `(msg[, offset, length], port[, address][, cb])`. A send with no
 * port is a CONNECTED send (its `connect` was guarded); a missing address is
 * Node's loopback default.
 * @param {unknown[]} args
 * @returns {{ allowed: boolean, target: string }}
 */
export function classifyDgramSend(args) {
  const rest = args.slice(1);
  const withRange = typeof rest[0] === "number" && typeof rest[1] === "number" && rest.length >= 3;
  const port = withRange ? rest[2] : rest[0];
  const address = withRange ? rest[3] : rest[1];
  if (port === undefined || typeof port === "function") {
    return { allowed: true, target: "udp <connected>" };
  }
  if (address === undefined || address === null || typeof address === "function") {
    return { allowed: true, target: `udp <loopback default>:${String(port)}` };
  }
  return { allowed: isLoopbackHost(address), target: `udp ${String(address)}:${String(port)}` };
}

/**
 * Patch `dgram.Socket.prototype.send` / `connect`: a non-loopback destination
 * is refused before a datagram leaves — the callback (or the socket's
 * `error` event) receives the refusal.
 * @param {(target: string) => Error} refuse
 */
export function installDgramGuard(refuse) {
  const proto = dgram.Socket.prototype;
  const realSend = proto.send;
  const realConnect = proto.connect;
  /** @param {dgram.Socket} socket @param {unknown} cb @param {Error} err */
  const fail = (socket, cb, err) =>
    process.nextTick(() => (typeof cb === "function" ? cb(err) : socket.emit("error", err)));
  /** @this {dgram.Socket} @param {unknown[]} args */
  function guardedSend(...args) {
    const { allowed, target } = classifyDgramSend(args);
    if (allowed) return Reflect.apply(realSend, this, args);
    fail(this, args[args.length - 1], refuse(target));
  }
  /** @this {dgram.Socket} @param {unknown[]} args */
  function guardedConnect(...args) {
    const address = typeof args[1] === "string" ? args[1] : undefined;
    if (address === undefined || isLoopbackHost(address)) {
      return Reflect.apply(realConnect, this, args);
    }
    fail(this, args[args.length - 1], refuse(`udp ${address}:${String(args[0])}`));
  }
  proto.send = /** @type {typeof realSend} */ (/** @type {unknown} */ (guardedSend));
  proto.connect = /** @type {typeof realConnect} */ (/** @type {unknown} */ (guardedConnect));
}

/** The proxy environment variables Node clients (and undici's EnvHttpProxyAgent) honor. */
export const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/** @param {Record<string, string | undefined>} env */
export function deleteProxyEnv(env) {
  for (const k of PROXY_ENV_VARS) delete env[k];
}

/**
 * Whether the first bytes written to a socket are a request that asks a
 * (loopback) peer to reach somewhere else: an HTTP `CONNECT`, or an
 * absolute-form request line naming a non-loopback host — what a client
 * sends to a forward proxy. Returns the target, or null.
 * @param {unknown} chunk
 * @returns {string | null}
 */
export function proxiedRequestTarget(chunk) {
  let head;
  if (typeof chunk === "string") head = chunk.slice(0, 512);
  else if (chunk instanceof Uint8Array) {
    head = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, 512)).toString(
      "latin1",
    );
  } else return null;
  const connect = /^CONNECT ([^\s]+)/.exec(head);
  if (connect) return `proxy CONNECT ${connect[1]}`;
  const absolute = /^[A-Z]+ (?:https?|wss?):\/\/(\[[^\]]*\]|[^/:?#\s]+)[^\s]*/.exec(head);
  if (absolute && !isLoopbackHost(absolute[1])) return `proxy ${absolute[0]}`;
  return null;
}

/**
 * Patch `net.Socket.prototype.write`: a write that would make a loopback
 * forward proxy dial out (see {@link proxiedRequestTarget}) is refused and
 * the socket destroyed before the bytes are sent.
 * @param {(target: string) => Error} refuse
 */
export function installProxyGuard(refuse) {
  const realWrite = net.Socket.prototype.write;
  /** @this {net.Socket} @param {unknown[]} args */
  function guardedWrite(...args) {
    const target = proxiedRequestTarget(args[0]);
    if (target === null) return Reflect.apply(realWrite, this, args);
    const err = refuse(target);
    process.nextTick(() => this.destroy(err));
    return false;
  }
  net.Socket.prototype.write = /** @type {typeof realWrite} */ (
    /** @type {unknown} */ (guardedWrite)
  );
}

/**
 * Refuse `new Worker(...)`: a worker thread never runs the setup file (or a
 * `--import` preload), so it would dial unguarded. The relay tests create
 * none; one that needs a Worker must install the guard inside it first.
 * @param {(target: string) => Error} refuse
 */
export function installWorkerGuard(refuse) {
  class RefusedWorker {
    /** @param {unknown} filename */
    constructor(filename) {
      throw refuse(`worker_threads.Worker ${String(filename).slice(0, 120)} (unguarded thread)`);
    }
  }
  workerThreads.Worker = /** @type {typeof workerThreads.Worker} */ (
    /** @type {unknown} */ (RefusedWorker)
  );
  // `import { Worker } from "node:worker_threads"` reads the ESM facade.
  syncBuiltinESMExports();
}

/**
 * Every hook, plus the proxy env scrub — what the setup file and the child
 * preload both install.
 * @param {(target: string) => Error} refuse
 */
export function installNetworkGuard(refuse) {
  deleteProxyEnv(process.env);
  installFetchGuard(refuse);
  installSocketGuard(refuse);
  installProxyGuard(refuse);
  installDgramGuard(refuse);
  installWorkerGuard(refuse);
}
