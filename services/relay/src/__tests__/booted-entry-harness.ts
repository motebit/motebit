/**
 * Shared boot harness for BOOTED-ARTIFACT activation suites
 * (docs/doctrine/composition-preserves-enforcement.md).
 *
 * Spawns a real deployed entry — the tsx source rung or the compiled
 * `dist/server.js` rung (the exact command `run.sh`, `package.json#start`,
 * and the DEPLOY.md systemd unit all exec) — as a child process with a
 * production-shaped STRICT env, and resolves when the entry's own boot
 * logger reports `relay.listening`. Consumers probe it over real HTTP.
 *
 * The strict base env carries NO security-boundary overrides, and ambient
 * overrides are DELETED (not empty-stringed) so a dev shell exporting an
 * opt-out cannot leak into the child's resolution. Suites layer their own
 * additions (e.g. an operator master token for provisioning) via
 * `envOverrides` — additions only; the deletions always win.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHILD_REFUSAL_MARKER, deleteProxyEnv } from "./network-guard-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(HERE, "..", "server.ts");
const DIST_ENTRY = resolve(HERE, "..", "..", "dist", "server.js");
export const BOOT_TIMEOUT_MS = 60_000;
/**
 * Preloaded into every spawned entry (NODE_OPTIONS `--import`): the child
 * relay is under the same deny-by-default network guard as the vitest
 * worker. Each refused dial is one {@link CHILD_REFUSAL_MARKER} line on the
 * child's stderr — `BootedEntry.egressRefusals()` reads them back.
 */
const CHILD_NETWORK_GUARD = pathToFileURL(resolve(HERE, "network-guard.preload.mjs")).href;

/** `NODE_OPTIONS` for a spawned entry: the caller's, plus the network guard preload. */
export function guardedNodeOptions(base: string | undefined): string {
  return [base, `--import=${CHILD_NETWORK_GUARD}`]
    .filter((v) => v !== undefined && v !== "")
    .join(" ");
}

export interface EntryTier {
  /** Which rung of the booted-artifact ladder this is. */
  name: string;
  command: string;
  args: string[];
  /** Throws with a repair instruction when the rung's input is absent. */
  precondition?: () => void;
}

export const SOURCE_TIER: EntryTier = {
  name: "source entry (tsx src/server.ts)",
  command: "npx",
  args: ["--yes", "tsx", SERVER_ENTRY],
};

export const DIST_TIER: EntryTier = {
  name: "compiled artifact (node dist/server.js — the run.sh exec line)",
  command: process.execPath,
  args: [DIST_ENTRY],
  precondition: () => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(
        `${DIST_ENTRY} is missing — this rung boots the COMPILED artifact. ` +
          `Run \`pnpm --filter @motebit/relay build\` first; the canonical ` +
          `pipeline (turbo test → build dependency) does this for you.`,
      );
    }
  },
};

export interface BootedEntry {
  child: ChildProcess;
  baseUrl: string;
  /** Everything the entry has logged so far (stdout + stderr, JSON lines). */
  log(): string;
  /** The non-loopback dials the child's network guard refused so far (one target each). */
  egressRefusals(): string[];
}

function refusalsIn(log: string): string[] {
  return log
    .split("\n")
    .filter((l) => l.startsWith(CHILD_REFUSAL_MARKER))
    .map((l) => l.slice(CHILD_REFUSAL_MARKER.length).trim());
}

/** Spawn a real deployed entry and resolve when it reports listening. */
export function bootRealEntry(
  tier: EntryTier,
  envOverrides: Record<string, string> = {},
): Promise<BootedEntry> {
  tier.precondition?.();
  return new Promise((resolveBooted, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000000",
      MOTEBIT_FEDERATION_ENDPOINT_URL: "https://relay-under-test.example/federation",
      PORT: "0", // ephemeral — the entry logs the real bound port
      NODE_ENV: "test",
      ...envOverrides,
    };
    delete env.MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE;
    delete env.MOTEBIT_ENABLE_DEVICE_AUTH;
    delete env.MOTEBIT_FEDERATION_AUTO_ACCEPT;
    delete env.MOTEBIT_DB_PATH; // ":memory:" default
    // No proxy reaches the child, even one an override names (the preload
    // deletes them again inside the child).
    deleteProxyEnv(env);
    // Always last: no override drops the guard.
    env.NODE_OPTIONS = guardedNodeOptions(env.NODE_OPTIONS);
    let bootLog = "";
    const child = spawn(tier.command, tier.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      reject(
        new Error(`${tier.name} did not report listening within ${BOOT_TIMEOUT_MS}ms:\n${bootLog}`),
      );
    }, BOOT_TIMEOUT_MS - 2_000);
    const onChunk = (chunk: Buffer): void => {
      bootLog += chunk.toString();
      // The entry's own boot logger emits {"msg":"relay.listening","port":N}.
      for (const line of bootLog.split("\n")) {
        if (!line.includes("relay.listening")) continue;
        try {
          const parsed = JSON.parse(line) as { port?: number };
          if (typeof parsed.port === "number") {
            clearTimeout(timer);
            resolveBooted({
              child,
              baseUrl: `http://127.0.0.1:${parsed.port}`,
              log: () => bootLog,
              egressRefusals: () => refusalsIn(bootLog),
            });
            return;
          }
        } catch {
          // partial line — keep buffering
        }
      }
    };
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", onChunk);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${tier.name} exited before listening (code ${code}):\n${bootLog}`));
    });
  });
}

/**
 * A fake Solana JSON-RPC endpoint for a booted entry (#918). A booted relay
 * reads the payer of every P2P proof from `SOLANA_RPC_URL` and refuses P2P
 * when it cannot, so a booted P2P test points the entry here and names the
 * payer once its delegator exists (`setPayer`). `getTransaction` answers every
 * signature as a landed USDC transfer whose single payer is that address;
 * `getGenesisHash` answers the cluster the fake serves (#954: the relay reads
 * its Solana network from it, lazily). Options: `genesisHash` names the
 * cluster (default mainnet-beta; `null` = JSON-RPC error),
 * `genesisFailures` answers the first N reads with HTTP 503, `genesisHang`
 * never answers them. The fake also answers what an anchor write and a
 * reconciliation cycle need (`getLatestBlockhash`, `getBalance`,
 * `sendTransaction`, `getAccountInfo` = no token account, `getBlockHeight`
 * past every blockhash so a confirm fails fast); every other method is a
 * JSON-RPC error. `callsOf(method)` counts requests per method.
 */
export interface FakeSolanaRpc {
  url: string;
  setPayer(address: string): void;
  getTransactionCalls(): number;
  callsOf(method: string): number;
  /** `sendTransaction` requests that arrived before any genesis read was answered. */
  writesBeforeGenesis(): number;
  /** `Date.now()` when a getGenesisHash answer was first written; null while none has been. */
  genesisAnsweredAt(): number | null;
  close(): Promise<void>;
}

export interface FakeSolanaRpcOptions {
  genesisHash?: string | null;
  genesisFailures?: number;
  genesisHang?: boolean;
  /** Answer getGenesisHash only after this many ms (a slow, not hung, RPC). */
  genesisDelayMs?: number;
}

export async function startFakeSolanaRpc(
  options: FakeSolanaRpcOptions = {},
): Promise<FakeSolanaRpc> {
  const { createServer } = await import("node:http");
  const { USDC_MINT_MAINNET, SOLANA_MAINNET_GENESIS_HASH } = await import("@motebit/wallet-solana");
  const genesisHash =
    options.genesisHash === undefined ? SOLANA_MAINNET_GENESIS_HASH : options.genesisHash;
  let payer = "11111111111111111111111111111111";
  let calls = 0;
  const perMethod = new Map<string, number>();
  let genesisFailuresLeft = options.genesisFailures ?? 0;
  const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
  let genesisAnswered = false;
  let genesisAnsweredAt: number | null = null;
  let earlyWrites = 0;
  const amount = (a: string) => ({
    amount: a,
    decimals: 6,
    uiAmount: Number(a) / 1e6,
    uiAmountString: String(Number(a) / 1e6),
  });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const msg = JSON.parse(raw) as { id: unknown; method: string; params?: unknown[] };
      perMethod.set(msg.method, (perMethod.get(msg.method) ?? 0) + 1);
      let body: unknown;
      if (msg.method === "getGenesisHash" && options.genesisHang === true) {
        return; // never answered (the request is destroyed on close)
      }
      if (msg.method === "getGenesisHash" && genesisFailuresLeft > 0) {
        genesisFailuresLeft--;
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Service Unavailable");
        return;
      }
      if (msg.method === "sendTransaction" && !genesisAnswered) earlyWrites++;
      if (
        msg.method === "getGenesisHash" &&
        genesisHash !== null &&
        options.genesisDelayMs !== undefined
      ) {
        setTimeout(() => {
          genesisAnswered = true;
          genesisAnsweredAt ??= Date.now();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(ok(msg.id, genesisHash)));
        }, options.genesisDelayMs);
        return;
      }
      if (msg.method === "getGenesisHash" && genesisHash !== null) {
        genesisAnswered = true;
        genesisAnsweredAt ??= Date.now();
        body = ok(msg.id, genesisHash);
      } else if (msg.method === "getLatestBlockhash") {
        body = ok(msg.id, {
          context: { slot: 1 },
          value: {
            blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
            lastValidBlockHeight: 1,
          },
        });
      } else if (msg.method === "getBalance") {
        body = ok(msg.id, { context: { slot: 1 }, value: 1_000_000_000 });
      } else if (msg.method === "sendTransaction") {
        body = ok(
          msg.id,
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
        );
      } else if (msg.method === "getAccountInfo") {
        body = ok(msg.id, { context: { slot: 1 }, value: null });
      } else if (msg.method === "getBlockHeight") {
        body = ok(msg.id, 1_000_000);
      } else if (msg.method === "getSignatureStatuses") {
        body = ok(msg.id, { context: { slot: 1 }, value: [null] });
      } else if (msg.method === "getTransaction") {
        calls++;
        const first = msg.params?.[0];
        const sig = typeof first === "string" ? first : "";
        const recipient = "So11111111111111111111111111111111111111112";
        body = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            slot: 1,
            blockTime: null,
            version: 0,
            meta: {
              err: null,
              fee: 5000,
              preBalances: [],
              postBalances: [],
              preTokenBalances: [
                {
                  accountIndex: 1,
                  mint: USDC_MINT_MAINNET,
                  owner: payer,
                  uiTokenAmount: amount("10000000"),
                },
                {
                  accountIndex: 2,
                  mint: USDC_MINT_MAINNET,
                  owner: recipient,
                  uiTokenAmount: amount("0"),
                },
              ],
              postTokenBalances: [
                {
                  accountIndex: 1,
                  mint: USDC_MINT_MAINNET,
                  owner: payer,
                  uiTokenAmount: amount("9000000"),
                },
                {
                  accountIndex: 2,
                  mint: USDC_MINT_MAINNET,
                  owner: recipient,
                  uiTokenAmount: amount("1000000"),
                },
              ],
            },
            transaction: {
              signatures: [sig],
              message: {
                accountKeys: [],
                header: {
                  numRequiredSignatures: 1,
                  numReadonlySignedAccounts: 0,
                  numReadonlyUnsignedAccounts: 0,
                },
                instructions: [],
                recentBlockhash: "11111111111111111111111111111111",
              },
            },
          },
        };
      } else {
        body = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "fake rpc" } };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setPayer: (a) => {
      payer = a;
    },
    getTransactionCalls: () => calls,
    callsOf: (method) => perMethod.get(method) ?? 0,
    writesBeforeGenesis: () => earlyWrites,
    genesisAnsweredAt: () => genesisAnsweredAt,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** SIGTERM with a SIGKILL backstop — standard afterAll teardown. */
export function killBootedEntry(booted: BootedEntry | null): void {
  if (booted != null) {
    const c = booted.child;
    c.kill("SIGTERM");
    setTimeout(() => c.kill("SIGKILL"), 5_000).unref();
  }
}
