/**
 * demo-anchor — end-to-end demo of the proactive interior's onchain moat.
 *
 * Boots a fresh in-memory motebit with a sovereign Ed25519 identity,
 * seeds some episodic memories so the cycle has work to do, runs N
 * consolidation cycles with auto-anchor enabled, and prints the
 * resulting ConsolidationAnchor + a verification result.
 *
 * Three modes:
 *
 *   local   (default) — auto-anchor runs with no submitter. The Merkle
 *                       root is computed and emitted as a local-only
 *                       anchor; no Solana tx, no SOL needed. Offline
 *                       verification still works — the same
 *                       `verifyConsolidationAnchor` path runs and
 *                       confirms the root matches the signed receipts.
 *   devnet  — submits the anchor to Solana devnet. Free SOL from any
 *             devnet faucet; any Solana dev environment works.
 *   mainnet — submits to Solana mainnet-beta. Real SOL, ~5000 lamports
 *             (~$0.001) per batch. Demonstrates the moat live — the
 *             resulting tx_hash is a permanent onchain artifact anyone
 *             can verify.
 *
 * Usage:
 *   pnpm demo-anchor                          # local (offline)
 *   pnpm demo-anchor --network devnet         # onchain devnet
 *   pnpm demo-anchor --network mainnet        # onchain mainnet
 *   pnpm demo-anchor --cycles 5               # run 5 cycles (default 3)
 *   pnpm demo-anchor --seed-hex <64 hex chars>
 *                                             # use a specific identity
 *                                             # (default: fresh random)
 *
 * What a verifier does with the printed output:
 *   1. Reads the anchor + receipts JSON (printed at the end)
 *   2. Reads the motebit's public key (printed at the top)
 *   3. Calls `verifyConsolidationAnchor(anchor, receipts, publicKey)`
 *   4. If `tx_hash` is present: fetches the Solana tx, parses the memo
 *      via `parseMemoAnchor`, confirms the root matches
 *   5. Gets `{ ok: true, recomputedMerkleRoot: ... }` — proof that this
 *      motebit performed this work at this time, independently of any
 *      motebit-operated relay or billing provider.
 */

import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeypair, bytesToHex, hexToBytes, getPublicKeyBySuite } from "@motebit/crypto";
import { base58btcEncode, verifyConsolidationAnchor } from "@motebit/encryption";
import type { ConsolidationAnchor, ConsolidationReceipt } from "@motebit/protocol";
import { MemoryType, EventType, SensitivityLevel } from "@motebit/sdk";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { ChainAnchorSubmitter } from "@motebit/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const NETWORKS = {
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    explorerBase: "https://explorer.solana.com/tx",
    explorerSuffix: "?cluster=devnet",
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  },
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerBase: "https://explorer.solana.com/tx",
    explorerSuffix: "",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  },
} as const;

interface Args {
  network: "local" | "devnet" | "mainnet";
  cycles: number;
  seedHex: string | null;
  rpcUrlOverride: string | null;
  dumpPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    network: "local",
    cycles: 3,
    seedHex: null,
    rpcUrlOverride: null,
    dumpPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--network") {
      const v = argv[++i];
      if (v !== "local" && v !== "devnet" && v !== "mainnet") {
        throw new Error(`--network must be one of local|devnet|mainnet, got "${v}"`);
      }
      out.network = v;
    } else if (arg === "--cycles") {
      out.cycles = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(out.cycles) || out.cycles < 1) {
        throw new Error(`--cycles must be a positive integer`);
      }
    } else if (arg === "--seed-hex") {
      out.seedHex = argv[++i]!;
      if (out.seedHex.length !== 64) {
        throw new Error(`--seed-hex must be exactly 64 hex chars (32 bytes)`);
      }
    } else if (arg === "--rpc-url") {
      out.rpcUrlOverride = argv[++i]!;
    } else if (arg === "--dump") {
      out.dumpPath = argv[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: pnpm demo-anchor [--network local|devnet|mainnet] [--cycles N] [--seed-hex HEX] [--rpc-url URL] [--dump PATH]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  return out;
}

function b(msg: string): string {
  return `\x1b[1m${msg}\x1b[0m`;
}
function dim(msg: string): string {
  return `\x1b[2m${msg}\x1b[0m`;
}

async function seedEpisodicMemories(runtime: MotebitRuntime, n: number): Promise<void> {
  // Backdate memories past their half-life so the consolidate phase sees
  // them as clustering candidates. Embeddings are all-0.1 — fake but
  // uniform, so clusterBySimilarity treats them all as one cluster.
  const { embedText } = await import("@motebit/memory-graph");
  const embedding = await embedText("demo-seed");
  const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const samples = [
    "User opened the editor at 9am",
    "User opened the editor at 10am",
    "User opened the editor at 11am",
    "User ran tests before committing",
    "User pushed a commit after lunch",
    "User took a break at 3pm",
    "User reviewed a PR in the afternoon",
    "User closed the editor at 6pm",
  ];
  for (let i = 0; i < Math.min(n, samples.length); i++) {
    const node = await runtime.memory.formMemory(
      {
        content: samples[i]!,
        confidence: 0.7,
        sensitivity: SensitivityLevel.None,
        memory_type: MemoryType.Episodic,
      },
      embedding,
      7 * 24 * 60 * 60 * 1000,
    );
    node.created_at = fortyDaysAgo;
    node.last_accessed = fortyDaysAgo;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── Identity ────────────────────────────────────────────────────
  let identity: { privateKey: Uint8Array; publicKey: Uint8Array };
  if (args.seedHex) {
    const privateKey = hexToBytes(args.seedHex);
    const publicKey = await getPublicKeyBySuite(privateKey, "motebit-jcs-ed25519-b64-v1");
    identity = { privateKey, publicKey };
  } else {
    identity = await generateKeypair();
  }

  // Solana address = Ed25519 public key, base58-encoded. Matches the
  // motebit's identity, by curve coincidence — no @solana/web3.js
  // needed here; base58btcEncode produces the identical encoding.
  const solanaAddress = base58btcEncode(identity.publicKey);

  process.stdout.write(`\n${b("motebit demo — consolidation anchor")}\n`);
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  process.stdout.write(`identity pubkey (hex):  ${bytesToHex(identity.publicKey)}\n`);
  process.stdout.write(`identity pubkey (Solana base58):  ${solanaAddress}\n`);
  process.stdout.write(`network:                ${args.network}\n`);
  process.stdout.write(`cycles to run:          ${args.cycles}\n`);

  // ── Submitter (optional) ────────────────────────────────────────
  let submitter: ChainAnchorSubmitter | undefined;
  let explorerBase: string | null = null;
  let explorerSuffix = "";
  if (args.network !== "local") {
    const net = NETWORKS[args.network];
    const rpcUrl = args.rpcUrlOverride ?? net.rpcUrl;
    const { createSolanaMemoSubmitter } = await import("@motebit/wallet-solana");
    submitter = createSolanaMemoSubmitter({
      rpcUrl,
      identitySeed: identity.privateKey,
      network: net.caip2,
    });
    explorerBase = net.explorerBase;
    explorerSuffix = net.explorerSuffix;

    // Pre-flight balance check. ~5000 lamports per memo tx; fail fast
    // with useful output before spinning up the runtime.
    const available = await submitter.isAvailable();
    if (!available) {
      process.stdout.write(`\n\x1b[31mSubmitter unavailable.\x1b[0m RPC: ${rpcUrl}\n`);
      process.stdout.write(
        `Check (a) network reachability and (b) SOL balance at ${solanaAddress}.\n`,
      );
      if (args.network === "devnet") {
        process.stdout.write(`Fund on devnet: solana airdrop 1 ${solanaAddress} --url ${rpcUrl}\n`);
      }
      process.exit(1);
    }
    process.stdout.write(`rpc url:                ${rpcUrl}\n`);
  }

  // ── Runtime ─────────────────────────────────────────────────────
  const runtime = new MotebitRuntime(
    {
      motebitId: "demo-mote",
      tickRateHz: 0,
      signingKeys: identity,
      proactiveAnchor: { submitter, batchThreshold: args.cycles },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
    },
  );

  // Seed memories so the consolidate phase has clusters to work on.
  await seedEpisodicMemories(runtime, 6);

  // ── Run cycles ──────────────────────────────────────────────────
  process.stdout.write(`\n${b("running cycles")}\n`);
  for (let i = 0; i < args.cycles; i++) {
    const result = await runtime.consolidationCycle();
    const merged = result.summary.consolidateMerged ?? 0;
    const pruned = (result.summary.prunedDecay ?? 0) + (result.summary.prunedNotability ?? 0);
    process.stdout.write(
      `  cycle ${i + 1}/${args.cycles}  phases=${result.phasesRun.length}  merged=${merged}  pruned=${pruned}\n`,
    );
  }

  // ── Collect receipts + anchor from the event log ────────────────
  const receiptEvents = await runtime.events.query({
    motebit_id: runtime.motebitId,
    event_types: [EventType.ConsolidationReceiptSigned],
  });
  const anchorEvents = await runtime.events.query({
    motebit_id: runtime.motebitId,
    event_types: [EventType.ConsolidationReceiptsAnchored],
  });
  const receipts: ConsolidationReceipt[] = receiptEvents
    .map((ev) => (ev.payload as { receipt: ConsolidationReceipt }).receipt)
    .sort((a, b) => {
      if (a.finished_at !== b.finished_at) return a.finished_at - b.finished_at;
      return a.receipt_id.localeCompare(b.receipt_id);
    });

  process.stdout.write(`\n${b("signed receipts")}: ${receipts.length}\n`);
  if (receipts.length === 0) {
    process.stdout.write(
      `\x1b[31mNo receipts signed.\x1b[0m The cycle ran zero phases or signing keys were absent.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${b("anchors emitted")}: ${anchorEvents.length}\n`);
  if (anchorEvents.length === 0) {
    process.stdout.write(
      `\x1b[33mNo anchors emitted.\x1b[0m Check batchThreshold — expected ${args.cycles}, got ${receipts.length} receipts.\n`,
    );
    process.exit(1);
  }
  const anchor = (anchorEvents[anchorEvents.length - 1]!.payload as { anchor: ConsolidationAnchor })
    .anchor;

  process.stdout.write(`\n${b("anchor")}\n`);
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  process.stdout.write(`batch_id:     ${anchor.batch_id}\n`);
  process.stdout.write(`merkle_root:  ${anchor.merkle_root}\n`);
  process.stdout.write(`leaf_count:   ${anchor.leaf_count}\n`);
  if (anchor.tx_hash) {
    process.stdout.write(`tx_hash:      ${anchor.tx_hash}\n`);
    process.stdout.write(`network:      ${anchor.network ?? "(unknown)"}\n`);
    if (explorerBase) {
      process.stdout.write(`explorer:     ${explorerBase}/${anchor.tx_hash}${explorerSuffix}\n`);
    }
  } else {
    process.stdout.write(`tx_hash:      (local-only — no submitter)\n`);
  }

  // ── Verify end-to-end ───────────────────────────────────────────
  const result = await verifyConsolidationAnchor(anchor, receipts, identity.publicKey);
  process.stdout.write(`\n${b("verification")}\n`);
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  if (result.ok) {
    process.stdout.write(`\x1b[32m✓ verified\x1b[0m\n`);
    process.stdout.write(`recomputed root matches anchor.merkle_root\n`);
    process.stdout.write(`every receipt signed by the motebit's identity key\n`);
    if (anchor.tx_hash && explorerBase) {
      process.stdout.write(
        `${dim("to verify the onchain side manually:")}\n  solana confirm ${anchor.tx_hash}\n`,
      );
    }
  } else {
    process.stdout.write(`\x1b[31m✗ FAILED\x1b[0m — ${result.reason}\n`);
    process.exit(1);
  }

  // ── Optional JSON dump ──────────────────────────────────────────
  if (args.dumpPath) {
    const out = {
      motebit_id: runtime.motebitId,
      identity_public_key_hex: bytesToHex(identity.publicKey),
      solana_address_base58: solanaAddress,
      network: args.network,
      anchor,
      receipts,
    };
    writeFileSync(resolve(ROOT, args.dumpPath), JSON.stringify(out, null, 2) + "\n", "utf-8");
    process.stdout.write(`\n${dim("dumped to:")} ${args.dumpPath}\n`);
  }

  process.stdout.write(`\n`);
  await runtime.stop();
}

main().catch((err) => {
  process.stderr.write(
    `\n\x1b[31mdemo-anchor failed:\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err instanceof Error && err.stack) process.stderr.write(dim(err.stack) + "\n");
  process.exit(1);
});
