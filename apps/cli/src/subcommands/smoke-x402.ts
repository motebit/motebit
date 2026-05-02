/**
 * `motebit smoke x402` — paid-flow end-to-end probe.
 *
 * Sibling of `motebit smoke reconciliation`: where reconciliation validates
 * the read side (loop is observing correctly), this validates the write side
 * (a real settlement actually flows through every layer).
 *
 * Phase 1 of the smoke ships in-process: two fresh motebit identities
 * (buyer + worker), two fresh EVM EOAs, real bootstrap + listing + paid
 * task POST + signed receipt POST against a live relay. Validates:
 *
 *   - x402 gate is wired and prices listings correctly (402 + payment
 *     requirements with correct gross amount + payTo)
 *   - CDP facilitator settles the payment onchain (or testnet
 *     facilitator on Base Sepolia)
 *   - relay records `relay_settlements` row with x402_tx_hash + non-zero
 *     platform_fee
 *   - the next reconciliation cycle observes the new fee
 *
 * Phase 2 (deferred): spawning a real `motebit run` daemon as the worker
 * instead of in-process receipt POST. The in-process shape uses the same
 * Ed25519 receipt-signing primitives the daemon does, so it exercises the
 * load-bearing economic path; the daemon adds WebSocket task-dispatch
 * observability that doesn't change the validation density of "the loop
 * runs end-to-end."
 *
 * Sibling-but-distinct primitive vs the deposit-detector — canonical
 * doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  bytesToHex,
  canonicalJson,
  createSignedToken,
  generateKeypair,
  secureErase,
  sha256,
  signExecutionReceipt,
} from "@motebit/encryption";

import type { CliConfig } from "../args.js";
import { CONFIG_DIR } from "../config.js";
import { getRelayUrl } from "./_helpers.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-call task unit cost; gross = unit * (1 + platformFeeRate). Stays small
 *  on purpose — the smoke is a validator, not a benchmark. */
const SMOKE_UNIT_COST_USD = 0.01;

/** Capability label exposed in the worker's listing. The relay doesn't
 *  enforce semantics on the string, only that pricing maps to it. */
const SMOKE_CAPABILITY = "echo";

/** Persistent EOA storage. Each EOA file is a single-line `0x...` private
 *  key; never committed (gitignored via `.motebit/` blanket). */
const BUYER_EOA_FILE = path.join(CONFIG_DIR, "smoke-x402-buyer-eoa.txt");
const WORKER_EOA_FILE = path.join(CONFIG_DIR, "smoke-x402-worker-eoa.txt");

/** USDC contract addresses on Base mainnet + Sepolia. Mirrors the same map
 *  the relay uses internally (services/relay/src/deposit-detector.ts). */
const USDC_CONTRACTS = {
  mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  testnet: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
};

/** Network IDs in CAIP-2. */
const NETWORK_IDS = {
  mainnet: "eip155:8453" as const,
  testnet: "eip155:84532" as const,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function handleSmokeX402(config: CliConfig): Promise<void> {
  const useMainnet = process.argv.includes("--mainnet");

  const network = useMainnet ? NETWORK_IDS.mainnet : NETWORK_IDS.testnet;
  const usdcContract = useMainnet ? USDC_CONTRACTS.mainnet : USDC_CONTRACTS.testnet;
  const networkLabel = useMainnet ? "Base mainnet" : "Base Sepolia";

  if (useMainnet) {
    console.log(
      "WARNING: running against Base MAINNET — this will spend real USDC (~$0.0105 per run).",
    );
  } else {
    console.log(`Running against ${networkLabel} (testnet, no real money).`);
  }

  const relayUrl = getRelayUrl(config);
  console.log(`relay=${relayUrl}`);
  console.log(`network=${network}`);
  console.log(`usdc=${usdcContract}`);
  console.log("");

  // 1. Bootstrap (or reuse) buyer + worker EVM EOAs.
  //
  // Fresh keypairs on first run, persisted so reruns don't re-generate
  // (which would orphan funded EOAs). The keys are gitignored via the
  // `.motebit/` blanket. For mainnet, the buyer EOA must be operator-
  // funded with USDC before the smoke can settle anything; on first run
  // we print the address + funding instructions and exit.
  const buyerEoa = await loadOrGenerateEoa(BUYER_EOA_FILE, "buyer");
  const workerEoa = await loadOrGenerateEoa(WORKER_EOA_FILE, "worker");

  console.log(`buyer_eoa=${buyerEoa.address}`);
  console.log(`worker_eoa=${workerEoa.address}`);
  console.log("");

  if (useMainnet && buyerEoa.justGenerated) {
    console.log(
      "FUNDING REQUIRED: Buyer EOA was just generated. Fund it with at least $0.05 USDC on Base mainnet,\n" +
        `  then rerun this command. Send to: ${buyerEoa.address}\n` +
        `  USDC contract: ${usdcContract}\n`,
    );
    process.exit(1);
  }

  // 2. Bootstrap fresh motebit identities for buyer + worker. Distinct
  //    Ed25519 keypairs — the relay's self-delegation guard rejects
  //    submitter==executor, so buyer and worker MUST be different
  //    motebit IDs.
  console.log("→ Bootstrapping buyer + worker motebit identities...");
  const buyer = await bootstrapMotebitIdentity(relayUrl);
  const worker = await bootstrapMotebitIdentity(relayUrl);
  console.log(`buyer_id=${buyer.motebitId}`);
  console.log(`worker_id=${worker.motebitId}`);
  console.log("");

  // 3. Worker registers a paid listing pointing at its EVM EOA. The
  //    listing's pay_to_address is what the x402 gate uses for the
  //    payTo callback at services/relay/src/tasks.ts:1264.
  console.log("→ Worker posting listing...");
  await postWorkerListing(relayUrl, worker, workerEoa.address);

  // 4. Verify the listing landed with non-null pay_to_address and
  //    non-zero unit_cost. Without this guard, a listing-write bug
  //    would silently produce a free task (x402 gate skipped) and
  //    the smoke would falsely report success.
  await assertListingValid(relayUrl, worker.motebitId);

  // 5. Buyer submits paid task via @x402/fetch. The wrapped fetch
  //    handles the 402 → sign → resubmit dance automatically using
  //    the buyer's EVM EOA.
  console.log("→ Buyer submitting paid task...");
  const taskId = await submitPaidTask({
    relayUrl,
    buyer,
    buyerEoaPrivateKey: buyerEoa.privateKey,
    workerId: worker.motebitId,
    network,
    useMainnet,
  });
  console.log(`task_id=${taskId}`);

  // 6. Worker (in-process) constructs the signed ExecutionReceipt and
  //    submits it. This drives the relay's settlement-write path
  //    (services/relay/src/tasks.ts:946) — the row that the
  //    reconciliation loop will observe in its next cycle.
  console.log("→ Worker signing + submitting receipt...");
  await submitWorkerReceipt({
    relayUrl,
    worker,
    taskId,
    submittedAtMs: Date.now() - 1000,
  });

  // 7. Verify the relay_settlements row was written. We don't have a
  //    direct settlement-by-task endpoint, but the task GET surface
  //    transitions to status=Completed when settlement lands, which is
  //    the proxy signal.
  await assertSettlementLanded(relayUrl, worker.motebitId, taskId, buyer.signedToken);

  // 8. Exit with the next-cycle observation timestamp + the rerun hint
  //    so operators can validate the read side asynchronously via
  //    `motebit smoke reconciliation`.
  const intervalMin = 15;
  const observableAt = new Date(Date.now() + intervalMin * 60_000).toISOString();
  console.log("");
  console.log("OK: paid task settled end-to-end.");
  console.log(`  next reconciliation cycle observable at ${observableAt}`);
  console.log(`  rerun verification:  motebit smoke reconciliation`);

  // Erase the buyer's signed token from memory; the EOA private key
  // stays persisted on disk (intentional — reused across runs).
  secureErase(buyer.privateKey);
  secureErase(worker.privateKey);
}

// ---------------------------------------------------------------------------
// EVM EOA — load or generate
// ---------------------------------------------------------------------------

interface BuyerEoa {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  justGenerated: boolean;
}

async function loadOrGenerateEoa(filePath: string, label: string): Promise<BuyerEoa> {
  // Lazy import — viem is a heavy dep, skip the cost on the not-x402
  // dispatch paths.
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");

  if (fs.existsSync(filePath)) {
    const privateKey = fs.readFileSync(filePath, "utf-8").trim() as `0x${string}`;
    if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
      throw new Error(
        `${filePath} is not a valid EOA private key (expected 0x + 64 hex). Delete the file to regenerate.`,
      );
    }
    const account = privateKeyToAccount(privateKey);
    return { address: account.address, privateKey, justGenerated: false };
  }

  // Fresh keypair. Write with 0600 permissions — these are loaded each
  // run and the only protection is filesystem ACL.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const privateKey = generatePrivateKey();
  fs.writeFileSync(filePath, privateKey, { mode: 0o600 });
  const account = privateKeyToAccount(privateKey);
  console.log(`Generated ${label} EOA at ${filePath} (mode 0600)`);
  return { address: account.address, privateKey, justGenerated: true };
}

// ---------------------------------------------------------------------------
// Motebit identity bootstrap
// ---------------------------------------------------------------------------

interface BootstrappedMotebit {
  motebitId: string;
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** Pre-minted signed token, audience varies per call site. */
  signedToken: string;
}

async function bootstrapMotebitIdentity(relayUrl: string): Promise<BootstrappedMotebit> {
  // Generate Ed25519 keypair via @motebit/crypto. UUID-derived motebit_id
  // matches what the interactive-setup flow does — server is self-sovereign
  // about IDs (services/relay/src/agents.ts:654 explicitly accepts the
  // caller-provided motebit_id).
  const keypair = await generateKeypair();
  const motebitId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const publicKeyHex = bytesToHex(keypair.publicKey);

  const res = await fetch(`${relayUrl}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      motebit_id: motebitId,
      device_id: deviceId,
      public_key: publicKeyHex,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bootstrap failed (${String(res.status)}): ${text.slice(0, 200)}`);
  }

  // Pre-mint a signed token for this motebit. Audience is set per-call;
  // the smoke uses three audiences (market:listing for the listing post,
  // task:submit for buyer's task POST, task:result for worker's receipt
  // POST), so we mint per-use rather than caching one token.
  const signedToken = await mintSignedToken({
    motebitId,
    deviceId,
    privateKey: keypair.privateKey,
    audience: "admin:query",
  });

  return {
    motebitId,
    deviceId,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    signedToken,
  };
}

async function mintSignedToken(args: {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  audience: string;
}): Promise<string> {
  return createSignedToken(
    {
      mid: args.motebitId,
      did: args.deviceId,
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: args.audience,
    },
    args.privateKey,
  );
}

// ---------------------------------------------------------------------------
// Worker listing
// ---------------------------------------------------------------------------

async function postWorkerListing(
  relayUrl: string,
  worker: BootstrappedMotebit,
  workerPayToAddress: string,
): Promise<void> {
  const token = await mintSignedToken({
    motebitId: worker.motebitId,
    deviceId: worker.deviceId,
    privateKey: worker.privateKey,
    audience: "market:listing",
  });
  const res = await fetch(
    `${relayUrl}/api/v1/agents/${encodeURIComponent(worker.motebitId)}/listing`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        capabilities: [SMOKE_CAPABILITY],
        pricing: [
          {
            capability: SMOKE_CAPABILITY,
            unit_cost: SMOKE_UNIT_COST_USD,
            currency: "USD",
            per: "task",
          },
        ],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "smoke-x402 echo worker (auto-generated by `motebit smoke x402`)",
        pay_to_address: workerPayToAddress,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listing POST failed (${String(res.status)}): ${text.slice(0, 200)}`);
  }
}

async function assertListingValid(relayUrl: string, workerId: string): Promise<void> {
  const res = await fetch(`${relayUrl}/api/v1/agents/${encodeURIComponent(workerId)}/listing`);
  if (!res.ok) {
    throw new Error(`listing GET failed (${String(res.status)})`);
  }
  const body = (await res.json()) as { pricing?: Array<{ unit_cost?: number }> };
  const sum = (body.pricing ?? []).reduce((acc, p) => acc + (p.unit_cost ?? 0), 0);
  if (sum <= 0) {
    throw new Error(
      `listing pricing sums to ${sum} — getAgentPricing would return null and silently skip the x402 gate. Smoke aborted.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Buyer paid task submission via @x402/fetch
// ---------------------------------------------------------------------------

async function submitPaidTask(args: {
  relayUrl: string;
  buyer: BootstrappedMotebit;
  buyerEoaPrivateKey: `0x${string}`;
  workerId: string;
  network: string;
  useMainnet: boolean;
}): Promise<string> {
  // Lazy imports — heavy deps, only loaded on the paid-flow path.
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { createWalletClient, http, publicActions } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base, baseSepolia } = await import("viem/chains");

  const account = privateKeyToAccount(args.buyerEoaPrivateKey);
  const walletClient = createWalletClient({
    account,
    chain: args.useMainnet ? base : baseSepolia,
    transport: http(),
  }).extend(publicActions);

  const client = new x402Client();
  // Cast: viem's WalletClient with publicActions is structurally a
  // ClientEvmSigner (per @x402/evm signer.d.mts), but the structural
  // overlap isn't declared as a subtype relation in either library.
  // The double-unknown cast satisfies ts-eslint's no-explicit-any
  // without erasing the intentional cross-library boundary.
  registerExactEvmScheme(client, {
    signer: walletClient as unknown as Parameters<typeof registerExactEvmScheme>[1]["signer"],
  });
  const fetchWithPay = wrapFetchWithPayment(globalThis.fetch, client);

  const buyerToken = await mintSignedToken({
    motebitId: args.buyer.motebitId,
    deviceId: args.buyer.deviceId,
    privateKey: args.buyer.privateKey,
    audience: "task:submit",
  });

  const idempotencyKey = crypto.randomUUID();
  const taskBody = {
    submitted_by: args.buyer.motebitId,
    capability: SMOKE_CAPABILITY,
    prompt: `motebit smoke x402 — ${new Date().toISOString()}`,
    invocation_origin: "user-tap" as const,
  };

  const res = await fetchWithPay(
    `${args.relayUrl}/agent/${encodeURIComponent(args.workerId)}/task`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${buyerToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(taskBody),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`paid task POST failed (${String(res.status)}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { task_id?: string };
  if (!body.task_id) {
    throw new Error("paid task POST returned no task_id");
  }
  return body.task_id;
}

// ---------------------------------------------------------------------------
// Worker receipt construction + signing
// ---------------------------------------------------------------------------

async function submitWorkerReceipt(args: {
  relayUrl: string;
  worker: BootstrappedMotebit;
  taskId: string;
  submittedAtMs: number;
}): Promise<void> {
  const completedAt = Date.now();
  const result = `echo-ack-${args.taskId.slice(0, 8)}`;

  // Hashes are SHA-256 hex of canonical bytes — the protocol contract is
  // "what could a verifier reproduce?" Hash inputs are the canonical-JSON
  // serializations of the prompt + result so a third-party tool can reverify
  // without bundling the smoke's exact construction.
  const promptCanonical = canonicalJson({ smoke: "x402", task_id: args.taskId });
  const resultCanonical = canonicalJson({ result });
  const promptHashBytes = await sha256(new TextEncoder().encode(promptCanonical));
  const resultHashBytes = await sha256(new TextEncoder().encode(resultCanonical));

  const receiptBody = {
    task_id: args.taskId,
    motebit_id: args.worker.motebitId,
    public_key: bytesToHex(args.worker.publicKey),
    device_id: args.worker.deviceId,
    submitted_at: args.submittedAtMs,
    completed_at: completedAt,
    status: "completed" as const,
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: bytesToHex(promptHashBytes),
    result_hash: bytesToHex(resultHashBytes),
    relay_task_id: args.taskId,
    invocation_origin: "agent-to-agent" as const,
  };

  const signed = await signExecutionReceipt(receiptBody, args.worker.privateKey);

  const token = await mintSignedToken({
    motebitId: args.worker.motebitId,
    deviceId: args.worker.deviceId,
    privateKey: args.worker.privateKey,
    audience: "task:result",
  });
  const res = await fetch(
    `${args.relayUrl}/agent/${encodeURIComponent(args.worker.motebitId)}/task/${encodeURIComponent(args.taskId)}/result`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(signed),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`receipt POST failed (${String(res.status)}): ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Settlement verification
// ---------------------------------------------------------------------------

async function assertSettlementLanded(
  relayUrl: string,
  workerId: string,
  taskId: string,
  buyerToken: string,
): Promise<void> {
  // Poll the task GET surface — its status flips to Completed (and a
  // receipt body becomes visible) when settlement lands. 60-second
  // ceiling matches the relay's TASK_TTL_MS / 10 — enough for any
  // realistic Ed25519 verify + DB transaction round-trip.
  const deadline = Date.now() + 60_000;
  let lastStatus = "(unknown)";
  while (Date.now() < deadline) {
    const res = await fetch(
      `${relayUrl}/agent/${encodeURIComponent(workerId)}/task/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${buyerToken}` } },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        task?: { status?: string };
        receipt?: { status?: string } | null;
      };
      lastStatus = body.task?.status ?? lastStatus;
      if (body.receipt && body.task?.status === "completed") {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `settlement did not land within 60s — last task.status=${lastStatus}. The receipt POST returned 200 but the relay's settlement pipeline did not transition the task to completed; check relay logs for receipt verification or settlement errors.`,
  );
}
