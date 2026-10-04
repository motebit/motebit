/**
 * `close()` waits for the async work boot started — and is BOUNDED.
 *
 * `createSyncRelay` starts three pieces of network I/O it does not await: the
 * x402 facilitator `initialize()` (task routes), the deposit detector's boot
 * tick, and the Solana network warm-up read. `close()` must let each settle
 * before the database closes (nothing the relay started may log or write
 * after it) — but a peer that accepts and never answers must not hold the
 * shutdown past its deadline: Fly's `kill_timeout` is 5 s and `server.ts`
 * force-exits at 30 s, and a relay killed mid-`close()` never closes its DB.
 *
 * The law, per boot service:
 *   - a SLOW peer (answers within the deadline): close() waits for it;
 *   - a HUNG peer: close() resolves within the shutdown deadline (default
 *     2 s), aborting the in-flight request where the client supports it,
 *     and the database is closed.
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmRpcAdapter } from "@motebit/evm-rpc";
import { createSyncRelay, type SyncRelay } from "../index.js";
import { X402_TEST_CONFIG } from "./test-helpers.js";
import { fakeFacilitatorClient } from "./x402-fake-facilitator.js";
import { startFakeSolanaRpc, type FakeSolanaRpc } from "./booted-entry-harness.js";

/** The default shutdown deadline close() must honour (SyncRelayConfig.shutdownDeadlineMs). */
const DEFAULT_DEADLINE_MS = 2_000;
/** Scheduling slack on top of a deadline. */
const SLACK_MS = 750;

interface HungServer {
  url: string;
  connections(): number;
  close(): Promise<void>;
}

/** A TCP peer that accepts every connection and never writes a byte. */
async function startHungServer(): Promise<HungServer> {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((s) => {
    accepted++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => accepted,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function expectDbClosed(relay: SyncRelay): void {
  expect(() => relay.moteDb.db.prepare("SELECT 1").get()).toThrow();
}

async function timedClose(relay: SyncRelay): Promise<number> {
  const t0 = Date.now();
  await relay.close();
  return Date.now() - t0;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("close() bounds the x402 facilitator initialize", () => {
  it("a hung facilitator: close() resolves within the default deadline and the DB is closed", async () => {
    const hung = await startHungServer();
    cleanups.push(() => hung.close());
    // Production shape: the real HTTP facilitator client, pointed at a peer
    // that accepts and never answers.
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: { ...X402_TEST_CONFIG, facilitatorUrl: hung.url },
      x402ChainReader: null,
      depositDetectorRpc: null,
      drainGraceMs: 10,
    });
    await until(() => hung.connections() > 0);
    const elapsed = await timedClose(relay);
    expect(elapsed).toBeLessThan(DEFAULT_DEADLINE_MS + SLACK_MS);
    expectDbClosed(relay);
  }, 15_000);
});

describe("close() bounds the deposit detector's boot tick", () => {
  it("a hung deposit RPC (the production HTTP adapter): close() aborts the request, resolves within the deadline, and the DB is closed", async () => {
    const requests: Array<{ url: string; aborted: boolean }> = [];
    const realFetch = globalThis.fetch;
    // A network that accepts and never answers — honouring AbortSignal as
    // real fetch does.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
      const rec = { url, aborted: false };
      requests.push(rec);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      drainGraceMs: 10,
    });
    await until(() => requests.length > 0);
    const elapsed = await timedClose(relay);
    expect(elapsed).toBeLessThan(DEFAULT_DEADLINE_MS + SLACK_MS);
    expectDbClosed(relay);
    expect(requests.every((r) => r.aborted)).toBe(true);
  }, 15_000);

  function slowRpc(
    delayMs: number | null,
  ): EvmRpcAdapter & { inFlight(): number; calls(): number } {
    let inFlight = 0;
    let calls = 0;
    const answer = <T>(v: T): Promise<T> => {
      calls++;
      inFlight++;
      if (delayMs === null) return new Promise<T>(() => {}); // never answers
      return new Promise<T>((r) =>
        setTimeout(() => {
          inFlight--;
          r(v);
        }, delayMs),
      );
    };
    return {
      getBlockNumber: () => answer(10n),
      getBalance: () => answer(0n),
      getTransferLogs: () => answer([]),
      inFlight: () => inFlight,
      calls: () => calls,
    };
  }

  it("a slow deposit RPC: close() waits for the boot tick before it resolves", async () => {
    const rpc = slowRpc(300);
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      depositDetectorRpc: rpc,
      drainGraceMs: 10,
    });
    await until(() => rpc.calls() > 0);
    await relay.close();
    expect(rpc.inFlight()).toBe(0);
    expectDbClosed(relay);
  });

  it("a hung deposit RPC (an adapter that cannot be aborted): close() still resolves within the deadline", async () => {
    const rpc = slowRpc(null);
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      depositDetectorRpc: rpc,
      drainGraceMs: 10,
      shutdownDeadlineMs: 400,
    });
    await until(() => rpc.calls() > 0);
    const elapsed = await timedClose(relay);
    expect(elapsed).toBeLessThan(400 + SLACK_MS);
    expectDbClosed(relay);
  }, 15_000);
});

describe("close() bounds the Solana network warm-up", () => {
  async function solanaRelay(rpc: FakeSolanaRpc, deadline?: number): Promise<SyncRelay> {
    vi.stubEnv("SOLANA_RPC_URL", rpc.url);
    return createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      depositDetectorRpc: null,
      drainGraceMs: 10,
      // The resolver's own read bound, raised far past the shutdown deadline:
      // only close()'s bound can end the wait.
      solanaNetworkTimeoutMs: 60_000,
      ...(deadline !== undefined ? { shutdownDeadlineMs: deadline } : {}),
    });
  }

  it("a slow Solana RPC: close() waits for the warm-up read before it resolves", async () => {
    const rpc = await startFakeSolanaRpc({ genesisDelayMs: 300 });
    cleanups.push(() => rpc.close());
    const relay = await solanaRelay(rpc);
    await until(() => rpc.callsOf("getGenesisHash") > 0);
    await relay.close();
    const closedAt = Date.now();
    const answeredAt = rpc.genesisAnsweredAt();
    expect(answeredAt).not.toBeNull();
    expect(answeredAt!).toBeLessThanOrEqual(closedAt);
    expectDbClosed(relay);
  });

  it("a hung Solana RPC: close() resolves within the deadline and the DB is closed", async () => {
    const rpc = await startFakeSolanaRpc({ genesisHang: true });
    const relay = await solanaRelay(rpc, 400);
    await until(() => rpc.callsOf("getGenesisHash") > 0);
    const elapsed = await timedClose(relay);
    expect(elapsed).toBeLessThan(400 + SLACK_MS);
    expectDbClosed(relay);
    // The abandoned read cannot be cancelled; when it finally fails (the RPC
    // goes away here), the relay that shut down says nothing about it.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await rpc.close();
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      spy.mockRestore();
    }
    expect(written.filter((l) => l.includes("solana.network"))).toEqual([]);
  }, 15_000);
});
