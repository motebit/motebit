/**
 * Deny-by-default network for the relay suite (vitest `setupFiles`).
 *
 * A relay test never reaches the network. Before this guard, `createSyncRelay`
 * called with `x402` fired the facilitator `initialize()` — a real fetch to
 * x402.org — and the deposit detector's boot tick — a real `eth_blockNumber`
 * to a public Base RPC. In a sandbox without network those requests failed
 * late and logged into a worker already tearing down; on a HANGING network
 * they held `close()` until the hook timed out. Every suite run was silently
 * talking to the internet.
 *
 * The guard fails the test on any non-loopback request, two layers deep:
 *
 *   - `globalThis.fetch` — rejects at once with the URL (the precise message);
 *   - `net.Socket.prototype.connect` — every TCP client (undici's pool,
 *     `http.request`, a captured pre-guard fetch) is refused before it dials.
 *
 * A test that stubs `fetch` itself (`vi.stubGlobal`) owns what that stub
 * does; the socket layer still refuses a real dial. Loopback (`localhost`,
 * `127.0.0.0/8`, `::1`) and unix sockets stay open — in-process fakes,
 * the booted-entry harness, fake RPC servers.
 *
 * Repair: inject the in-process fakes. `createTestRelay()` does it for you;
 * a direct `createSyncRelay({...})` spreads `...TEST_RELAY_NETWORK` from
 * `test-helpers.ts` (the fake facilitator + the deposit detector off).
 */
import net from "node:net";
import { afterAll, afterEach } from "vitest";

const REPAIR =
  "repair: a relay test never reaches the network — use createTestRelay(), or spread " +
  "`...TEST_RELAY_NETWORK` (services/relay/src/__tests__/test-helpers.ts: in-process x402 " +
  "facilitator, deposit detector off) into a direct createSyncRelay({...}); a service that " +
  "needs an RPC gets a loopback fake (e.g. startFakeSolanaRpc). Guard: " +
  "services/relay/src/__tests__/network-guard.setup.ts";

const violations: string[] = [];

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return true; // Node defaults to localhost
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

function refuse(target: string): Error {
  const line = `relay test reached the network: ${target}`;
  violations.push(line);
  return new TypeError(`${line}\n${REPAIR}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  let url: string;
  try {
    url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ws:") &&
      !isLoopbackHost(parsed.hostname)
    ) {
      return Promise.reject(refuse(`fetch ${parsed.origin}${parsed.pathname}`));
    }
  } catch {
    // A relative or unparsable URL never leaves the process — let fetch decide.
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;

type ConnectFn = (this: net.Socket, ...args: unknown[]) => net.Socket;
const realConnect = net.Socket.prototype.connect as unknown as ConnectFn;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  let host: string | undefined;
  let path: string | undefined;
  if (Array.isArray(first)) {
    // Internal normalized form: [options, cb].
    const opts = first[0] as { host?: string; path?: string } | undefined;
    host = opts?.host;
    path = opts?.path;
  } else if (typeof first === "object" && first !== null) {
    const opts = first as { host?: string; path?: string };
    host = opts.host;
    path = opts.path;
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    path = first; // connect(path) — a unix socket
  } else {
    host = typeof args[1] === "string" ? args[1] : undefined;
  }
  if (path === undefined && !isLoopbackHost(host)) {
    const err = refuse(`socket ${host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;

function assertNoViolations(): void {
  if (violations.length === 0) return;
  const seen = [...new Set(violations.splice(0))];
  throw new Error(`${seen.join("\n")}\n${REPAIR}`);
}

afterEach(assertNoViolations);
afterAll(assertNoViolations);
