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
 *   - `net.Socket.prototype.connect` — every TCP/TLS client (undici's pool,
 *     `http(s).request`, `ws`, Stripe, `tls.connect`, a captured pre-guard
 *     fetch) is refused before it dials. DENY BY DEFAULT: only a provable
 *     unix socket (non-empty string `path`) or a loopback host is allowed —
 *     Node's http Agent dials with `{ host, path: null }`, a missing host is
 *     refused too.
 *
 * A test that stubs `fetch` itself (`vi.stubGlobal`) owns what that stub
 * does; the socket layer still refuses a real dial. Loopback (`localhost`,
 * `127.0.0.0/8`, `::1`) and unix sockets stay open — in-process fakes,
 * the booted-entry harness, fake RPC servers. The decision and both hooks
 * live in `network-guard-core.mjs`, shared with the guard the booted-entry
 * harness preloads into every relay CHILD it spawns
 * (`network-guard.preload.mjs`).
 *
 * Repair: inject the in-process fakes. `createTestRelay()` does it for you;
 * a direct `createSyncRelay({...})` spreads `...TEST_RELAY_NETWORK` from
 * `test-helpers.ts` (the fake facilitator + the deposit detector off).
 */
import { afterAll, afterEach } from "vitest";
import { installFetchGuard, installSocketGuard } from "./network-guard-core.mjs";

const REPAIR =
  "repair: a relay test never reaches the network — use createTestRelay(), or spread " +
  "`...TEST_RELAY_NETWORK` (services/relay/src/__tests__/test-helpers.ts: in-process x402 " +
  "facilitator, deposit detector off) into a direct createSyncRelay({...}); a service that " +
  "needs an RPC gets a loopback fake (e.g. startFakeSolanaRpc). Guard: " +
  "services/relay/src/__tests__/network-guard.setup.ts";

const violations: string[] = [];

function refuse(target: string): Error {
  const line = `relay test reached the network: ${target}`;
  violations.push(line);
  return new TypeError(`${line}\n${REPAIR}`);
}

installFetchGuard(refuse);
installSocketGuard(refuse);

/**
 * The guard's own tests (`network-guard.test.ts`) provoke refusals on
 * purpose; they drain what they caused so the hooks below see only real ones.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for("motebit.relay.networkGuard")] = {
  drain: (): string[] => violations.splice(0),
};

function assertNoViolations(): void {
  if (violations.length === 0) return;
  const seen = [...new Set(violations.splice(0))];
  throw new Error(`${seen.join("\n")}\n${REPAIR}`);
}

afterEach(assertNoViolations);
afterAll(assertNoViolations);
