/**
 * `motebit delegate "<prompt>"` — submit a task to a worker agent
 * and poll for the result.
 *
 * Two modes:
 *   - Default: discover a worker with the requested capability via
 *     the relay's market/candidates endpoint (or use --target to
 *     skip discovery), submit the task, poll for completion.
 *   - --plan: decompose the prompt into a plan via PlanEngine and
 *     delegate each step to the network. This mode initializes a
 *     lightweight local runtime with *no* local capabilities so every
 *     step must route through the relay to a worker agent.
 *
 * `handleDelegatePlan` is private because nothing else uses it;
 * `createHttpPollingDelegationAdapter` is exported for its tests.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { TokenAudience } from "@motebit/sdk";
import type { MotebitRuntime as MotebitRuntimeInstance } from "@motebit/runtime";
import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { StepDelegationAdapter } from "@motebit/planner";
import {
  planStepIdempotencyKey,
  stepRotation,
  receiptBoundTo,
  taskNamedBy409,
  admittedAs,
} from "@motebit/planner";
import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { cliRuntimeConfig } from "../sync-configured.js";
import { openDelegateEventSync } from "../cli-event-push.js";
import { electCoordinatorRole } from "../runtime-host.js";
import { getRelayUrl, getRelayAuthHeaders, requireMotebitId } from "./_helpers.js";
import { sanitizeRelayText } from "@motebit/sync-engine";

// ---------------------------------------------------------------------------
// motebit delegate --plan — multi-agent orchestration via PlanEngine
// ---------------------------------------------------------------------------

async function handleDelegatePlan(
  config: CliConfig,
  motebitId: string,
  prompt: string,
): Promise<void> {
  // Sovereign pay-forward (§9.1) is disabled until a worker's admission mode
  // is discoverable (#887): refuse before election, key unlock, discovery or
  // payment. The runtime's gate is the one switch.
  if (config.sovereign) {
    const { SOVEREIGN_PAY_FORWARD_ENABLED, SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE } =
      await import("@motebit/runtime");
    if (!SOVEREIGN_PAY_FORWARD_ENABLED) {
      console.error(SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE);
      process.exit(1);
    }
  }

  const relayUrl = getRelayUrl(config);

  // Runtime-host election — one sovereign runtime per machine
  // (docs/doctrine/daemon-desktop-unification.md). `delegate --plan`
  // constructs a transient runtime over the shared ~/.motebit WAL and,
  // in sovereign mode, signs with the identity key — a full authority
  // while it lives, however briefly. Coordinator-role for its lifetime:
  // bind before touching shared state, or refuse honestly when another
  // process already coordinates — never a second signing/receipt
  // authority racing the daemon over one key and one database.
  const runtimeRef: { current: MotebitRuntimeInstance | null } = { current: null };
  const hostServer = await electCoordinatorRole(loadFullConfig(), motebitId, runtimeRef);

  // Build auth headers for relay calls
  const authHeaders = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  // Initialize runtime with AI provider for plan decomposition
  const { createProvider, buildToolRegistry, buildStorageAdapters, deriveGovernanceForRuntime } =
    await import("../runtime-factory.js");
  const { MotebitRuntime, NullRenderer, PLANNING_TASK_ROUTER } = await import("@motebit/runtime");

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config);
  const registry = buildToolRegistry(config, runtimeRef);
  const storage = buildStorageAdapters(moteDb);
  const governance = deriveGovernanceForRuntime(loadFullConfig().governance);

  // For sovereign mode, load identity keys and configure Solana wallet
  let signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
  let solanaConfig: { rpcUrl: string } | undefined;
  if (config.sovereign) {
    const fullConfig = loadFullConfig();
    const { fromHex, resolveUnlockPassphrase, decryptPrivateKey } = await import("../identity.js");

    let privateKey: Uint8Array | null = null;
    if (fullConfig.cli_private_key) {
      privateKey = fromHex(fullConfig.cli_private_key);
    } else if (fullConfig.cli_encrypted_key) {
      const passphrase = await resolveUnlockPassphrase("Passphrase (for sovereign wallet): ", {
        encryptedKey: fullConfig.cli_encrypted_key,
      });
      const keyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      privateKey = fromHex(keyHex);
    }

    if (!privateKey) {
      console.error("Sovereign delegation requires identity keys. Run `motebit id` to check.");
      process.exit(1);
    }

    // Sovereign delegation derives the public key through the suite
    // dispatcher rather than calling @noble directly — keeps the
    // @noble import surface confined to packages/crypto/suite-dispatch.ts
    // (the one place check-suite-dispatch permits) and PQ-ready: when
    // ML-DSA suites land, only the dispatcher arm changes.
    const { getPublicKeyBySuite } = await import("@motebit/crypto");
    const publicKey = await getPublicKeyBySuite(privateKey, "motebit-jcs-ed25519-hex-v1");
    signingKeys = { privateKey, publicKey };
    solanaConfig = { rpcUrl: config.solanaRpcUrl ?? "https://api.mainnet-beta.solana.com" };
  }

  const runtime = new MotebitRuntime(
    // #962: `syncConfigured` is decided by `cliRuntimeConfig`, last.
    cliRuntimeConfig(
      {
        motebitId,
        policy: {
          maxRiskLevel: governance.policyApproval.maxRiskLevel,
          requireApprovalAbove: governance.policyApproval.requireApprovalAbove,
          denyAbove: governance.policyApproval.denyAbove,
          budget: governance.policyBudget,
        },
        memoryGovernance: governance.memoryGovernance,
        taskRouter: PLANNING_TASK_ROUTER,
        ...(signingKeys ? { signingKeys } : {}),
        ...(solanaConfig ? { solana: solanaConfig } : {}),
      },
      { syncUrl: relayUrl },
    ),
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  runtimeRef.current = runtime;
  await runtime.init();
  runtime.setProvider(provider);
  // #962: this command's events and their sync, closed before it exits
  // (`openDelegateEventSync` is the wiring under test).
  // The push is E2E and signs its device tokens with the identity key: the
  // sovereign keys when loaded, else the key unlocked here (the passphrase is
  // session-cached by the auth headers above). No key: the configured token
  // alone, raw — the one raw-by-design push path.
  const syncCfg = loadFullConfig();
  let pushKey: Uint8Array | undefined = signingKeys?.privateKey;
  let pushKeyOwned = false;
  if (!pushKey) {
    try {
      const { loadActiveSigningKey } = await import("../identity.js");
      pushKey = (await loadActiveSigningKey(syncCfg, { promptLabel: "Passphrase: " })).privateKey;
      pushKeyOwned = true;
    } catch {
      pushKey = undefined;
    }
  }
  const masterToken =
    config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];
  const eventSync = await openDelegateEventSync(runtime, {
    syncUrl: relayUrl,
    log: (line) => console.log(line),
    privateKey: () => pushKey,
    ...(masterToken ? { configuredToken: masterToken } : {}),
    ...(pushKey && syncCfg.device_id && syncCfg.device_public_key
      ? {
          device: {
            motebitId,
            deviceId: syncCfg.device_id,
            publicKeyHex: syncCfg.device_public_key,
          },
        }
      : {}),
  });

  // Enable credential publishing to relay (sovereign trust → network trust bridge).
  // The relay is used for discovery; credentials published here feed the routing graph.
  const authTokenFactory = async (aud: TokenAudience = "task:submit"): Promise<string> => {
    const h = await getRelayAuthHeaders(config, { aud, json: true });
    return (h["Authorization"] ?? "").replace("Bearer ", "");
  };
  runtime.enableInteractiveDelegation({
    syncUrl: relayUrl,
    authToken: authTokenFactory,
    // Cold-start opt-in (`--pay-new-agents`) — lets a paid delegation to a
    // no-history worker settle P2P instead of degrading to relay-mode. Process-
    // lifetime config, so a plain boolean (no live getter needed on the CLI).
    ...(config.payNewAgents ? { acknowledgeNoHistoryRisk: true } : {}),
  });

  // Sovereign delegation: pay agents directly via Solana wallet (pattern 9.1)
  if (config.sovereign) {
    const sovereignAdapter = runtime.createSovereignDelegationAdapter(relayUrl, {
      authToken: async (aud?: TokenAudience) => {
        const h = await getRelayAuthHeaders(config, { aud: aud ?? "market:query", json: true });
        return (h["Authorization"] ?? "").replace("Bearer ", "");
      },
      routingStrategy: config.routingStrategy,
      onDelegationFailure: (_step, attempt, error) => {
        console.log(`  ✗ Sovereign attempt ${attempt + 1} failed: ${error}`);
      },
    });
    if (!sovereignAdapter) {
      console.error("Sovereign delegation requires identity keys and a configured Solana wallet.");
      console.error("Run `motebit wallet` to check wallet configuration.");
      process.exit(1);
    }
    runtime.setLocalCapabilities([]);
    runtime.setDelegationAdapter(sovereignAdapter);
  } else {
    // HTTP-polling delegation adapter with retry logic matching RelayDelegationAdapter
    const httpDelegationAdapter = createHttpPollingDelegationAdapter({
      relayUrl,
      motebitId,
      submitHeaders: authHeaders,
      // The poll route verifies `task:query`; the submission's
      // `task:submit` headers were refused without a master token (#827).
      queryHeaders: () => getRelayAuthHeaders(config, { aud: "task:query" }),
      routingStrategy: config.routingStrategy,
      onRetry: (step, next, total) => {
        console.log(`  ↻ Retrying step "${step.description}" (attempt ${next}/${total})`);
      },
    });

    // Wire relay delegation: empty local capabilities forces all steps to delegate to the network
    runtime.setLocalCapabilities([]);
    runtime.setDelegationAdapter(httpDelegationAdapter);
  } // end else (relay mode)

  // Execute plan
  const goalId = crypto.randomUUID();
  console.log(`\nDecomposing: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"\n`);

  let stepCount = 0;
  let completedCount = 0;

  try {
    for await (const chunk of runtime.executePlan(goalId, prompt)) {
      switch (chunk.type) {
        case "plan_created":
          stepCount = chunk.steps.length;
          console.log(`Plan: ${chunk.plan.title}`);
          console.log(`  ${stepCount} steps\n`);
          break;

        case "step_started": {
          const caps = chunk.step.required_capabilities ?? [];
          const capsSuffix = caps.length > 0 ? ` (${caps.join(", ")})` : "";
          console.log(
            `Step ${chunk.step.ordinal + 1}/${stepCount}: ${chunk.step.description}${capsSuffix}`,
          );
          break;
        }

        case "step_delegated":
          console.log(
            `  → Delegated${chunk.routing_choice?.selected_agent ? ` to ${chunk.routing_choice.selected_agent.slice(0, 12)}...` : ""} (task: ${chunk.task_id.slice(0, 12)}...)`,
          );
          break;

        case "step_completed": {
          completedCount++;
          const summary = chunk.step.result_summary ?? "";
          const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
          console.log(`  ✓ ${preview || "completed"}\n`);
          break;
        }

        case "step_failed":
          console.log(`  ✗ ${chunk.error}\n`);
          break;

        case "plan_completed":
          console.log(`\nPlan complete. ${completedCount}/${stepCount} steps executed.`);
          break;

        case "plan_failed":
          console.error(`\nPlan failed: ${chunk.reason}`);
          break;

        // #890: not a failure — the task may still complete. Running the
        // same goal again resumes this plan; it never delegates it twice.
        case "plan_undetermined":
          console.error(`\nAwaiting result: ${chunk.reason}`);
          break;

        case "plan_busy":
          console.error("\nThis plan is being run elsewhere right now — try again shortly.");
          break;
      }
    }
  } finally {
    await eventSync.close();
    if (pushKeyOwned && pushKey) {
      const { secureErase } = await import("@motebit/encryption");
      secureErase(pushKey);
      pushKey = undefined;
    }
    runtime.stop();
    moteDb.close();
    // Release the bind so the next coordinator-role process can elect.
    await hostServer.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// motebit delegate "<prompt>" — delegate a task to a worker agent
// ---------------------------------------------------------------------------

/**
 * The CLI paths that submit a task: `delegate`, `delegate --plan`, and the
 * REPL's `/delegate` (which carries what was typed, so its remedy can name
 * the full shell command — `/delegate` parses no flags).
 */
/**
 * `capabilities` is what the REPL learned the pinned target lists on the relay
 * (priced first): `motebit delegate` defaults `--capability` to `web_search`
 * and the sovereign resolver discovers by capability before narrowing to the
 * pin, so the printed command must name the target's own capability.
 */
export type DelegateSubmitPath =
  | "direct"
  | "plan"
  | { repl: { prompt: string; target: string; capabilities?: readonly string[] } };

/**
 * Single-quote `text` for a POSIX shell: nothing inside is expanded (a `!`
 * inside double quotes is history expansion in an interactive shell).
 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const P2P_SETTLES_LINE =
  "Paid delegation to another agent settles P2P: the relay does not take deposit-funded payment for it.";

/**
 * Who the submission's worker is, as far as the caller knows: `self` (the
 * target is the delegator's own id), `other` (another agent), or `unknown`
 * (`--plan` routes each step by capability, so the relay picks the worker).
 */
export type DelegateSubmitWorker = "self" | "other" | "unknown";

/**
 * The remedy for a 402 on task submission — the one reading every delegate
 * path routes its 402 through. The relay answers 402 for different refusals
 * (`{ error, code, status }`, services/relay/src/errors.ts), and a deposit
 * clears only some of them:
 *   - `INSUFFICIENT_FUNDS` — `motebit fund`.
 *   - a codeless 402 (the x402 challenge, a facilitator outage, a non-JSON
 *     body) — the relay's x402 middleware, which runs before the task
 *     handler whenever the spendable balance is below the price, whoever the
 *     worker is. A deposit clears it only for self-delegation: to another
 *     agent, a funded submission reaches the Arc 3.5 gate and is refused
 *     `TASK_P2P_PROOF_REQUIRED`. So `self` — `motebit fund`; `other` —
 *     `--sovereign`; `unknown` — both, each with when it applies.
 *   - `TASK_P2P_PROOF_REQUIRED` — paid delegation to another agent, local or
 *     on a federated peer, must settle P2P (off-ramp-as-user-action.md
 *     § Arc 3.5), so `motebit fund` can never clear it — `--sovereign`.
 *   - any other code (an x402 settlement refusal, an outcome to reconcile, a
 *     code this client does not know) — the relay's own words, never `fund`.
 */
export function describeDelegateSubmit402(
  bodyText: string,
  path: DelegateSubmitPath,
  worker: DelegateSubmitWorker,
): string[] {
  let code: unknown;
  let error: unknown;
  try {
    ({ code, error } = JSON.parse(bodyText) as { code?: unknown; error?: unknown });
  } catch {
    code = undefined;
  }
  const codeless = typeof code !== "string";
  if (code === "TASK_P2P_PROOF_REQUIRED" || (codeless && worker === "other")) {
    if (typeof path === "object") {
      const { prompt, target, capabilities = [] } = path.repl;
      const known = capabilities.length === 1 ? capabilities[0] : undefined;
      const command = `motebit delegate --sovereign ${shellQuote(prompt)} --target ${target} --capability ${known ?? "<capability>"}`;
      const lines = [
        P2P_SETTLES_LINE,
        `\`/delegate\` cannot pay P2P: exit the REPL and run \`${command}\` to pay the worker directly from your Solana wallet.`,
      ];
      if (known == null) {
        const listed =
          capabilities.length > 1
            ? ` (it lists: ${capabilities.join(", ")})`
            : " (see `/discover`)";
        lines.push(
          `Replace \`<capability>\` with the capability the worker lists${listed}: without it \`motebit delegate\` assumes web_search, which a worker that does not list it refuses.`,
        );
      }
      return lines;
    }
    return path === "plan"
      ? [
          P2P_SETTLES_LINE,
          "`delegate --plan` cannot pay P2P yet (#887): send the paid step on its own with `motebit delegate --sovereign`.",
        ]
      : [
          P2P_SETTLES_LINE,
          "Re-run with `--sovereign` to pay the worker directly from your Solana wallet.",
        ];
  }
  if (typeof code === "string" && code !== "INSUFFICIENT_FUNDS") {
    const words = typeof error === "string" ? error : bodyText;
    return [`The relay refused payment (${code}): ${sanitizeRelayText(words).slice(0, 300)}`];
  }
  if (codeless && worker === "unknown") {
    const p2p =
      path === "plan"
        ? "`delegate --plan` cannot pay P2P yet (#887), so send the paid step on its own with `motebit delegate --sovereign`."
        : "send it with `motebit delegate --sovereign`.";
    return [
      "Your relay balance is below this task's price. `motebit fund <amount>` clears this only if the relay routes the task to yourself.",
      `${P2P_SETTLES_LINE} If it goes to another agent, ${p2p}`,
    ];
  }
  return ["Insufficient balance. Run `motebit fund <amount>` to deposit."];
}

/**
 * The remedy for a 402 on `delegate --sovereign`, read from the runtime's
 * `DelegationError`. That path pays from the Solana wallet and never draws
 * on a relay deposit, so a deposit is never the remedy, whatever the code.
 * Empty for any other status.
 */
export function describeSovereignDelegationRefusal(error: {
  code: string;
  message: string;
  status?: number;
}): string[] {
  if (error.status !== 402) return [];
  if (error.code === "payment_proof_required") {
    return [
      "The relay found no usable P2P payment proof on this submission. `--sovereign` pays from your Solana wallet, so a relay deposit cannot clear this.",
    ];
  }
  return [
    "`--sovereign` pays from your Solana wallet, not a relay deposit, so depositing cannot clear this 402.",
  ];
}

export async function handleDelegate(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());

  const prompt = config.positionals.slice(1).join(" ");
  if (!prompt) {
    console.error('Usage: motebit delegate "<prompt>" [--capability web_search] [--target <id>]');
    process.exit(1);
  }

  // --plan: multi-agent orchestration via PlanEngine
  if (config.plan) {
    await handleDelegatePlan(config, motebitId, prompt);
    return;
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  const capability = config.capability ?? "web_search";
  let targetMotebitId = config.target;

  // --sovereign: pay the worker directly from the sovereign Solana wallet —
  // single-step paid P2P delegation (#423). This path NEVER falls back to
  // relay-custody: every missing prerequisite refuses loudly with its remedy
  // (the pre-fix behavior silently ignored the flag, hit the empty virtual
  // account, and misdirected a funded sovereign user to `motebit fund`).
  if (config.sovereign) {
    const fullConfig = loadFullConfig();
    if (fullConfig.relay_public_key == null || fullConfig.relay_public_key === "") {
      console.error(
        "Sovereign delegation requires a pinned relay key (the fee leg's treasury derives from it).",
      );
      console.error("Run `motebit register` to pair with the relay first.");
      process.exit(1);
    }
    const { loadActiveSigningKey } = await import("../identity.js");
    let signing: { privateKey: Uint8Array };
    try {
      signing = await loadActiveSigningKey(fullConfig, {
        promptLabel: "Passphrase (for sovereign wallet): ",
      });
    } catch (err: unknown) {
      console.error(
        `Sovereign delegation requires identity keys: ${sanitizeRelayText(err instanceof Error ? err.message : String(err))}`,
      );
      process.exit(1);
    }
    const { createSolanaWalletRail } = await import("@motebit/wallet-solana");
    const rail = createSolanaWalletRail({
      rpcUrl: config.solanaRpcUrl ?? "https://api.mainnet-beta.solana.com",
      identitySeed: signing.privateKey,
    });
    const buildP2pPayment = rail.buildP2pPayment?.bind(rail);
    if (buildP2pPayment == null) {
      console.error("The sovereign rail cannot build atomic P2P payments on this platform.");
      process.exit(1);
    }
    const { resolveAndSubmitP2pDelegation, PaidIntentLedger, p2pPaymentConfirmerOf } =
      await import("@motebit/runtime");
    const { toMicro, fromMicro } = await import("@motebit/protocol");
    // The durable paid-intent ledger (#874) — the same store the REPL's
    // runtime reads. Without it this path was the one paid door with no
    // interlock at all: it could re-buy work whose result another session
    // was still owed, and a payment it made whose result never arrived
    // was forgotten the moment the process exited.
    const ledgerDb = await openMotebitDatabase(getDbPath(config.dbPath));
    const paidIntentLedger = new PaidIntentLedger(ledgerDb.paidIntentStore, motebitId);
    const mintToken = async (aud?: TokenAudience): Promise<string> => {
      const h = await getRelayAuthHeaders(config, { aud: aud ?? "task:submit", json: true });
      return (h["Authorization"] ?? "").replace("Bearer ", "");
    };

    console.log(
      `Delegating (sovereign P2P) ${targetMotebitId != null ? `to ${targetMotebitId.slice(0, 12)}...` : `— discovering a payable "${capability}" worker`}`,
    );
    const result = await resolveAndSubmitP2pDelegation({
      motebitId,
      syncUrl: relayUrl,
      authToken: mintToken,
      prompt,
      capability,
      ...(targetMotebitId != null ? { targetWorkerId: targetMotebitId } : {}),
      relayPublicKeyHex: fullConfig.relay_public_key,
      buildP2pPayment,
      // #885: a builder that throws is not proof nothing moved — the rail's
      // read-only lookup decides, and "unknown" never pays again.
      ...(p2pPaymentConfirmerOf(rail) != null
        ? { confirmP2pPayment: p2pPaymentConfirmerOf(rail) }
        : {}),
      ...(config.payNewAgents ? { acknowledgeNoHistoryRisk: true } : {}),
      // `--budget` is a hard pre-broadcast ceiling over worker + fee legs.
      ...(config.budget != null ? { maxTotalMicro: toMicro(parseFloat(config.budget)) } : {}),
      logger: { warn: (m, ctx) => console.error(`  warn: ${m}`, ctx ?? "") },
      paidIntentLedger,
    });
    ledgerDb.close();

    if (!result.ok) {
      console.error(
        `Sovereign delegation failed (${result.error.code}): ${sanitizeRelayText(result.error.message)}`,
      );
      const settled = result.error.settledPayment;
      const unconfirmed = result.error.unconfirmedPayment;
      if (
        (result.error.code === "payment_not_admitted" ||
          result.error.code === "payment_admission_unconfirmed") &&
        settled != null
      ) {
        // #885: paid, and no relay task is confirmed — nothing to fetch by
        // id, and a second run would pay again.
        console.error(
          `The payment went out (tx ${settled.txHash}), but ` +
            (result.error.code === "payment_not_admitted"
              ? `the relay refused the task. `
              : `the relay has not confirmed admitting the task (it may have). `) +
            `Do not run this again — it would pay a second time. The payment is recorded as ` +
            `${settled.taskId}; after reconciling it, run \`motebit\`, then ` +
            `/result dismiss ${settled.taskId}`,
        );
      } else if (result.error.code === "payment_status_unknown") {
        console.error(
          `The payment may have left your wallet — check its history before paying this worker ` +
            `again.` +
            (unconfirmed?.ledgerId != null
              ? ` It is recorded as ${unconfirmed.ledgerId}; once reconciled, run \`motebit\`, ` +
                `then /result dismiss ${unconfirmed.ledgerId}`
              : ""),
        );
      } else if (settled != null && result.error.code !== "intent_already_paid") {
        // Paid, not delivered: the recovery is a free read, never a re-hire.
        console.error(
          `The payment settled (tx ${settled.txHash}); only the result did not arrive. ` +
            `Fetch it later for free: run \`motebit\`, then /result ${settled.taskId}`,
        );
      }
      if (result.error.code === "p2p_ineligible" && !config.payNewAgents) {
        console.error(
          "Hint: a pair with no trust history needs `--pay-new-agents` (cold-start acknowledgment).",
        );
      }
      for (const line of describeSovereignDelegationRefusal(result.error)) console.error(line);
      process.exit(1);
    }

    const r = result.receipt;
    if (r.status === "completed") {
      console.log(`\n--- Result ---\n`);
      console.log(r.result);
      console.log();
      if (r.tools_used != null && r.tools_used.length > 0) {
        console.log(`Tools: ${r.tools_used.join(", ")}`);
      }
    } else {
      console.log(`Task ${r.status}: ${r.result || "(no result)"}`);
    }
    const s = result.settlement;
    if (s != null && s.paidMicro != null && s.feeMicro != null && s.txHash != null) {
      console.log(
        `Paid: $${fromMicro(s.paidMicro).toFixed(4)} to worker + $${fromMicro(s.feeMicro).toFixed(4)} fee (tx ${s.txHash.slice(0, 12)}…)`,
      );
    }
    // #885: a second payment from this hire, or a payment record that could
    // not be written — never only a log line.
    if (s?.notice != null) console.error(`Warning: ${s.notice}`);
    return;
  }

  // Discover a worker if no target specified
  if (!targetMotebitId) {
    try {
      const maxBudget = config.budget ? parseFloat(config.budget) : 10;
      // Candidate discovery verifies `market:query` (#827: the `task:submit`
      // headers were refused without a master token).
      const discoverHeaders = await getRelayAuthHeaders(config, { aud: "market:query" });
      const discoverRes = await fetch(
        `${relayUrl}/api/v1/market/candidates?capability=${encodeURIComponent(capability)}&max_budget=${maxBudget}&limit=5`,
        { headers: discoverHeaders },
      );
      if (!discoverRes.ok) {
        const text = await discoverRes.text();
        console.error(`Discovery failed (${discoverRes.status}): ${text.slice(0, 200)}`);
        process.exit(1);
      }
      const discoverData = (await discoverRes.json()) as {
        candidates: Array<{
          motebit_id: string;
          composite: number;
          pricing?: Array<{ capability: string; unit_cost: number }>;
          description?: string;
          selected?: boolean;
        }>;
      };
      const candidates = discoverData.candidates ?? [];
      if (candidates.length === 0) {
        console.error(`No agents found with capability "${capability}". Is a worker running?`);
        process.exit(1);
      }
      const best = candidates.find((c) => c.selected) ?? candidates[0]!;
      targetMotebitId = best.motebit_id;
      const price = best.pricing?.find((p) => p.capability === capability)?.unit_cost;
      console.log(
        `Found worker: ${targetMotebitId.slice(0, 12)}...` +
          (price != null ? ` ($${price.toFixed(4)}/request)` : "") +
          (best.description ? ` — ${best.description}` : ""),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Discovery error: ${sanitizeRelayText(msg)}`);
      process.exit(1);
    }
  }

  // Submit task
  let taskId: string;
  try {
    console.log(`Delegating to ${targetMotebitId.slice(0, 12)}...`);
    const submitRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt,
        submitted_by: motebitId,
        required_capabilities: [capability],
      }),
    });
    if (submitRes.status === 402) {
      const worker = targetMotebitId === motebitId ? "self" : "other";
      for (const line of describeDelegateSubmit402(await submitRes.text(), "direct", worker)) {
        console.error(line);
      }
      process.exit(1);
    }
    if (!submitRes.ok) {
      const text = await submitRes.text();
      console.error(`Task submission failed (${submitRes.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const submitData = (await submitRes.json()) as { task_id: string };
    taskId = submitData.task_id;
    console.log(`Task submitted: ${taskId.slice(0, 12)}...`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Task submission error: ${sanitizeRelayText(msg)}`);
    process.exit(1);
  }

  // Poll for result (60s max, 2s intervals)
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 30;
  process.stdout.write("Waiting");

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      // `task:query`, minted per poll (#827: the `task:submit` headers were
      // refused on every poll without a master token).
      const pollHeaders = await getRelayAuthHeaders(config, { aud: "task:query" });
      const pollRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task/${taskId}`, {
        headers: pollHeaders,
      });
      if (!pollRes.ok) {
        process.stdout.write(".");
        continue;
      }
      const pollData = (await pollRes.json()) as {
        task: { status: string };
        receipt: {
          status: string;
          result: string;
          motebit_id: string;
          tools_used?: string[];
          completed_at?: number;
          submitted_at?: number;
        } | null;
      };
      if (pollData.receipt != null) {
        console.log(); // newline after dots
        const r = pollData.receipt;
        if (r.status === "completed") {
          console.log(`\n--- Result ---\n`);
          console.log(r.result);
          console.log();
          if (r.tools_used && r.tools_used.length > 0) {
            console.log(`Tools: ${r.tools_used.join(", ")}`);
          }
          if (r.submitted_at != null && r.completed_at != null) {
            const latency = r.completed_at - r.submitted_at;
            console.log(`Latency: ${latency}ms`);
          }
        } else {
          console.log(`Task ${r.status}: ${r.result || "(no result)"}`);
        }
        return;
      }
      process.stdout.write(".");
    } catch {
      process.stdout.write(".");
    }
  }
  console.log("\nTask timed out after 60s. The worker may still be running.");
  // The poll route needs a signed `task:query` token — the bare curl this
  // used to print could only ever 401 (#874). `/result` mints the token;
  // this path files the task under the worker, so the owner id rides along.
  console.log(
    `Fetch the result later (free, read-only): run \`motebit\`, then /result ${taskId} ${targetMotebitId}`,
  );
}

// ---------------------------------------------------------------------------
// HTTP-polling step delegation (`delegate --plan`, relay mode)
// ---------------------------------------------------------------------------

export interface HttpPollingDelegationOptions {
  relayUrl: string;
  motebitId: string;
  /** Headers for the submission (`task:submit`). */
  submitHeaders: Record<string, string>;
  /** Mints headers for the poll (`task:query`). */
  queryHeaders: () => Promise<Record<string, string>>;
  routingStrategy?: string;
  /** Called before each retry: the attempt about to run (1-based) and the total. */
  onRetry?: (step: PlanStep, nextAttempt: number, totalAttempts: number) => void;
  /** Poll interval. Default 2s. A test seam. */
  pollIntervalMs?: number;
  /** Max retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** First backoff after a 409 on a submission; doubles each time. Default 1s. */
  conflictBackoffMs?: number;
}

/** An error carrying how the retry must treat it. */
interface StepAttemptError extends Error {
  /** A worker FAILED the task: exclude it, and retry as a new task. */
  failedAgentId?: string;
  /**
   * The deadline passed and the relay could not say the task ended (still
   * running, or unreachable). The retry resubmits under the SAME
   * Idempotency-Key, so the relay replays the task it already admitted
   * instead of admitting — and charging for — a second one (#816).
   */
  deliveryUncertain?: boolean;
  /**
   * Positive evidence nothing more is owed under the current key — a signed
   * failed receipt, or a refusal before admission. The only errors that
   * rotate the step to a new key (#890 r4).
   */
  conclusive?: boolean;
}

/**
 * The step's outcome is UNDETERMINED: the relay may have admitted the task,
 * and it may still complete, but nothing confirmed it within the step's time
 * budget. Not a failure: no retry and no new task, because running the step
 * again could run — and pay for — it twice (#816). Twin of the planner's
 * `DelegationUndeterminedError`.
 */
export class DelegationUndeterminedError extends Error {
  readonly undetermined = true;
  constructor(stepDescription: string, cause?: unknown) {
    super(
      `Submission unconfirmed — the task may still complete; check /result (step "${stepDescription}")`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "DelegationUndeterminedError";
  }
}

/**
 * Polls the relay for each delegated step's receipt. One Idempotency-Key per
 * logical submission: a retry after a deadline the relay could not resolve
 * reuses it; only a task that conclusively failed gets a new key and excludes
 * the failed worker. Mirrors `RelayDelegationAdapter` in `@motebit/planner`,
 * which waits on the socket instead of polling.
 */
export function createHttpPollingDelegationAdapter(
  opts: HttpPollingDelegationOptions,
): StepDelegationAdapter {
  const { relayUrl, motebitId } = opts;
  const maxRetries = opts.maxRetries ?? 2;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const conflictBackoffMs = opts.conflictBackoffMs ?? 1000;
  const conflictBackoffMaxMs = 30_000;

  const unconfirmed = (message: string, cause?: unknown): StepAttemptError => {
    const err: StepAttemptError = new Error(message, cause !== undefined ? { cause } : undefined);
    err.deliveryUncertain = true;
    return err;
  };

  /**
   * Send a submission (`post`, which POSTs under its Idempotency-Key). A thrown fetch (the request
   * may have reached the relay, the response was lost) and a 409 (an earlier
   * request under the same key is still processing) are not "not admitted":
   * a 409 is retried with backoff under the same key, within the step's time
   * budget — the relay then replays its 201 with the same task_id — and one
   * that outlasts the budget ends the step as undetermined. A thrown fetch is
   * delivery-uncertain, so the retry keeps the key (#816). Every other
   * response is returned for the caller to judge.
   */
  const submitUnderKey = async (
    post: () => Promise<Response>,
    budgetMs: number,
    stepDescription: string,
  ): Promise<Response> => {
    let waited = 0;
    for (let conflict = 0; ; conflict++) {
      let resp: Response;
      try {
        resp = await post();
      } catch (err: unknown) {
        throw unconfirmed("Relay task submission unconfirmed: no response", err);
      }
      if (resp.ok) return resp;
      // A response that names a task — any status (#888; #890 r5): the key
      // admitted it. Adopt and poll it; never read it as a refusal.
      const named = await taskNamedBy409(resp);
      if (named != null) return admittedAs(named);
      if (resp.status !== 409) return resp;
      if (waited >= budgetMs) {
        throw new DelegationUndeterminedError(
          stepDescription,
          new Error("Relay task submission still being processed (409)"),
        );
      }
      const wait = Math.min(
        conflictBackoffMs * 2 ** conflict,
        conflictBackoffMaxMs,
        budgetMs - waited,
      );
      waited += wait;
      await new Promise<void>((r) => setTimeout(r, wait));
    }
  };

  /**
   * One ask of the relay: the receipt, "gone" (404 — the task left the queue
   * without a receipt, so none is coming), or null when there is no answer.
   */
  const query = async (taskId: string): Promise<ExecutionReceipt | "gone" | null> => {
    try {
      const pollResp = await fetch(`${relayUrl}/agent/${motebitId}/task/${taskId}`, {
        headers: await opts.queryHeaders(),
      });
      if (pollResp.status === 404) return "gone";
      if (!pollResp.ok) return null;
      const data = (await pollResp.json()) as { receipt: ExecutionReceipt | null };
      return data.receipt ?? null;
    } catch {
      return null; // Network error — no answer
    }
  };

  const attemptDelegation = async (
    step: PlanStep,
    timeoutMs: number,
    excludeAgents: string[],
    idempotencyKey: string,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> => {
    const body: Record<string, unknown> = {
      prompt: step.prompt,
      submitted_by: motebitId,
      required_capabilities: step.required_capabilities,
      step_id: step.step_id,
      routing_strategy: opts.routingStrategy,
    };
    if (excludeAgents.length > 0) body.exclude_agents = excludeAgents;

    // The POST stays here, beside its path; submitUnderKey only decides when
    // to send it again.
    const resp = await submitUnderKey(
      () =>
        fetch(`${relayUrl}/agent/${motebitId}/task`, {
          method: "POST",
          headers: { ...opts.submitHeaders, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(body),
        }),
      timeoutMs,
      step.description,
    );

    if (resp.status === 402) {
      const remedy = describeDelegateSubmit402(await resp.text(), "plan", "unknown").join(" ");
      const err: StepAttemptError = new Error(`${remedy} (HTTP 402)`);
      err.conclusive = true; // refused before admission
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text();
      // 5xx: the relay may have admitted before failing — not a refusal.
      if (resp.status >= 500) {
        throw unconfirmed(`Relay task submission unconfirmed (${resp.status})`);
      }
      const err: StepAttemptError = new Error(
        `Relay task submission failed (${resp.status}): ${text.slice(0, 200)}`,
      );
      err.conclusive = true; // refused before admission
      throw err;
    }

    let taskResp: { task_id: string; routing_choice?: { selected_agent?: string } | null };
    try {
      taskResp = (await resp.json()) as typeof taskResp;
    } catch (err: unknown) {
      // Admitted (2xx), but the answer never arrived whole: same key again.
      throw unconfirmed("Relay task submission unconfirmed: response body lost", err);
    }
    const taskId = taskResp.task_id;
    onTaskSubmitted?.(taskId);

    const settle = (receipt: ExecutionReceipt): DelegatedStepResult => {
      // A receipt about another task answers nothing about this one (#890 r5).
      if (!receiptBoundTo(receipt, taskId)) {
        throw unconfirmed(`A receipt for another task arrived for ${taskId}`);
      }
      if (receipt.status !== "completed") {
        // Evidence only from the worker the relay routed this task to.
        const routed = taskResp.routing_choice?.selected_agent;
        if (routed != null && routed !== "" && receipt.motebit_id !== routed) {
          throw unconfirmed(
            `A failed receipt for ${taskId} is signed by ${receipt.motebit_id}, not the routed worker ${routed}`,
          );
        }
        const err: StepAttemptError = new Error(
          `Delegated step ${receipt.status}: ${receipt.result}`,
        );
        err.failedAgentId = receipt.motebit_id;
        err.conclusive = true; // a signed failed receipt
        throw err;
      }
      return {
        step_id: step.step_id,
        task_id: taskId,
        receipt,
        result_text: receipt.result,
      };
    };

    const outcome = (answer: ExecutionReceipt | "gone" | null): DelegatedStepResult | null => {
      if (answer === null) return null;
      if (answer === "gone") {
        // The relay no longer knows this task (#890 r4): absence, never
        // evidence — it may have been admitted, paid and done. Hold the step
        // on this task and key; never rotate to a new one.
        throw new DelegationUndeterminedError(
          step.description,
          new Error(`Delegated task ${taskId} is no longer known to the relay (404)`),
        );
      }
      return settle(answer);
    };

    // Poll for result
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
      const done = outcome(await query(taskId));
      if (done) return done;
    }
    // The deadline says nothing about the task — ask once more, then hand
    // the retry the same key (#816).
    const last = outcome(await query(taskId));
    if (last) return last;
    throw unconfirmed(`Delegation timed out after ${timeoutMs}ms for step "${step.description}"`);
  };

  return {
    // Every submission carries the step's derived key (#890).
    resubmitsIdempotently: true,
    async delegateStep(
      step: PlanStep,
      timeoutMs: number,
      onTaskSubmitted?: (taskId: string) => void,
      _excludeAgents?: string[],
      onRotate?: (rotation: number) => void,
    ): Promise<DelegatedStepResult> {
      const excludeAgents: string[] = [];
      let lastError: StepAttemptError | undefined;
      // Derived from the step, never random (#890) — see planStepIdempotencyKey —
      // and starting from the step's CURRENT rotation (#890 r4).
      let rotation = stepRotation(step);
      let idempotencyKey = planStepIdempotencyKey(step, rotation);
      let attempts = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attempts++;
        try {
          return await attemptDelegation(
            step,
            timeoutMs,
            excludeAgents,
            idempotencyKey,
            // Every attempt: a same-key retry can be the first to learn the
            // task id (attempt 0's POST threw), and recovery needs it.
            onTaskSubmitted,
          );
        } catch (err: unknown) {
          // Undetermined: the task may have been admitted and may still
          // complete. Not a failure — no retry, no new task.
          if (err instanceof DelegationUndeterminedError) throw err;
          lastError = err instanceof Error ? err : new Error(String(err));
          // Extract failed agent ID from receipt if available
          if (lastError.failedAgentId) excludeAgents.push(lastError.failedAgentId);
          // Don't retry non-retryable errors (submission failures, payment required)
          if (
            lastError.message.includes("Relay task submission failed") ||
            lastError.message.includes("HTTP 402")
          ) {
            break;
          }
          // Rotate ONLY on positive evidence nothing more is owed under the
          // current key (#890 r4); the step forgets the old task first.
          if (lastError.conclusive === true) {
            rotation++;
            idempotencyKey = planStepIdempotencyKey(step, rotation);
            onRotate?.(rotation);
          }
          if (attempt < maxRetries) opts.onRetry?.(step, attempt + 2, maxRetries + 1);
        }
      }
      // Out of attempts while the relay never said the task ended: it may
      // have been admitted and may still complete — not a failure either.
      if (lastError?.conclusive !== true) {
        throw new DelegationUndeterminedError(step.description, lastError);
      }
      throw new Error(
        `Delegation failed after ${attempts} attempt(s): ${lastError?.message ?? "unknown"}`,
        { cause: lastError },
      );
    },
  };
}
