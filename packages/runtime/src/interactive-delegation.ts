/**
 * Interactive Delegation — delegate_to_agent tool registration and receipt management.
 *
 * Extracted from MotebitRuntime. Registers a tool that submits tasks to the relay
 * via REST, polls for results, bumps trust on verified receipts, and returns the
 * result as normal tool output.
 */

import { TurnDelegationReceipts } from "./turn-delegation-receipts.js";
import type { ReceiptCarryingResult } from "./turn-delegation-receipts.js";
import type { ExecutionReceipt, ToolRegistry } from "@motebit/sdk";
import type { TokenAudience } from "@motebit/protocol";

import {
  paymentNoticeChunk,
  retrieveDelegationResult,
  selectAndRunDelegation,
  type ConfirmP2pPayment,
  type BuildP2pPayment,
  type DelegationSettlement,
  type TaskRetrieval,
} from "./relay-delegation.js";
import { fromMicro, RiskLevel, SideEffect } from "@motebit/protocol";
import type { ToolCall } from "./turn-principal.js";

/**
 * Render the settlement fact as a sentence the model can relay verbatim. The
 * AI loop reads the tool's `data` text; without an explicit payment statement
 * it confabulated "settlement isn't active" on a SUCCESSFUL onchain payment.
 * Typed-truth: state what actually moved, let the model report it.
 */
function formatSettlementNote(settlement: DelegationSettlement | undefined): string {
  if (!settlement) return "";
  if (settlement.mode === "relay") {
    // Route-honest (#458): relay-mode moves NO money from the delegator's
    // wallet on this path (a paid direct delegation without a P2P proof is
    // refused by the relay's Arc 3.5 gate) — "Paid via the relay ledger"
    // overclaimed a payment on free-routed tasks.
    return "[settlement] Routed relay-mode — no onchain payment left your wallet.";
  }
  // P2P — onchain, paid by the delegator's own atomic transaction.
  const paid =
    settlement.paidMicro != null ? `$${fromMicro(settlement.paidMicro).toFixed(6)}` : "—";
  const fee = settlement.feeMicro != null ? `$${fromMicro(settlement.feeMicro).toFixed(6)}` : "—";
  const tx = settlement.txHash ? ` Transaction: ${settlement.txHash}.` : "";
  // #885: another transaction from this hire may have moved money, or the
  // payment record could not be written — the user must be told.
  const warning =
    settlement.notice != null ? `\n[WARNING — tell the user] ${settlement.notice}` : "";
  return `[settlement] Paid ${paid} to the worker + ${fee} platform fee, peer-to-peer onchain.${tx}${warning}`;
}

/** ToolRegistry extended with `has()` — matches SimpleToolRegistry in MotebitRuntime. */
interface ToolRegistryWithHas extends ToolRegistry {
  has(name: string): boolean;
}

// === Types ===

export interface InteractiveDelegationDeps {
  motebitId: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  toolRegistry: ToolRegistryWithHas;
  /** Maps tool names to motebit server names (only for motebit MCP adapters). */
  motebitToolServers: Map<string, string>;
  /** Set the credential submitter on the credential manager. */
  setCredentialSubmitter: (
    submitter: (
      vc: import("@motebit/encryption").VerifiableCredential<unknown>,
      targetMotebitId: string,
    ) => Promise<void>,
  ) => void;
  /** Bump trust for a remote agent based on a verified receipt. */
  bumpTrustFromReceipt: (receipt: ExecutionReceipt) => Promise<void>;
  /** Re-wire loop deps so newly registered tools are visible to the agentic loop. */
  wireLoopDeps: () => void;
  /**
   * The per-turn delegation-receipt collector (#943). A hire's receipt lands
   * in the turn that made it, never in a shared bucket another principal's
   * task could drain. Optional for bare fixtures (a private collector is
   * made); the runtime always passes its own.
   */
  turnReceipts?: TurnDelegationReceipts;
}

export interface InteractiveDelegationConfig {
  syncUrl: string;
  authToken: (audience?: TokenAudience) => Promise<string>;
  timeoutMs?: number;
  routingStrategy?: "cost" | "quality" | "balanced";
  /**
   * The relay's Ed25519 public key (hex), PINNED at pairing. With
   * `buildP2pPayment`, a paid cross-agent `delegate_to_agent` call settles
   * peer-to-peer (treasury derived from this key, never a fetched response);
   * absent → relay-mediated. Surface-provided. See `relay-delegation.ts`
   * `selectAndRunDelegation` + `docs/doctrine/off-ramp-as-user-action.md` § Arc 3.5.
   */
  relayPublicKey?: string;
  /**
   * The sovereign rail's atomic multi-leg payment builder, bound by the runtime
   * from its `SovereignWalletRail` at enable time. Present only when a sovereign
   * wallet is configured.
   */
  buildP2pPayment?: BuildP2pPayment;
  /**
   * The same rail's read-only "did the payment land anyway?" lookup (#885),
   * bound by the runtime beside `buildP2pPayment`. Absent ⇒ a builder error
   * is `payment_status_unknown` (recorded, never retried).
   */
  confirmP2pPayment?: ConfirmP2pPayment;
  /**
   * Cold-start opt-in: whether the user has consented to pay a worker they have
   * NO trust history with directly, peer-to-peer (the Arc-3 acknowledgment).
   * Without it, a first paid delegation to an unknown worker is ineligible for
   * P2P and degrades to relay-mode — so the `delegate_to_agent` tool MUST forward
   * it or the surface's "pay new agents directly" toggle is a no-op for chat-
   * driven delegation (the bug this closes). A function is read fresh per call so
   * toggling the preference takes effect without re-enabling — mirrors
   * `InvokeCapabilityConfig.acknowledgeNoHistoryRisk`.
   */
  acknowledgeNoHistoryRisk?: boolean | (() => boolean);
  /**
   * The current turn's verified standing-grant id (null between turns and
   * on grantless turns) — read fresh per delegation so the relay's
   * acceptance-time revocation fence engages: a task submitted under a
   * grant the relay's delegation-revocation cache shows revoked is
   * refused BEFORE any hold commits (`TASK_GRANT_REVOKED`). Advisory id
   * on the wire, never authority; the runtime's verifier and the metered
   * rail seam are the cryptographic gates.
   */
  getActiveGrantId?: () => string | null;
  /**
   * The runtime's session paid-intent ledger — the mechanical interlock
   * that refuses a duplicate paid delegation BEFORE broadcast while a
   * prior payment is settled-but-unretrieved (#435/#436). Bound by the
   * runtime at enable time; the enforcement itself lives in the shared
   * submit chokepoint so this path and `executeGrantedDelegation` cannot
   * diverge.
   */
  paidIntentLedger?: import("./paid-intent-ledger.js").PaidIntentLedger;
  /**
   * The runtime's `retrieveDelegationResult` — the ONE implementation of
   * the free `task:query` read, which also resolves the paid-unretrieved
   * entry on delivery. Bound by the runtime at enable time; absent (a
   * manager constructed directly), the tool performs the same read and
   * resolution itself.
   */
  retrieveTaskResult?: (taskId: string) => Promise<TaskRetrieval>;
}

/**
 * Render a retrieval as the typed-truth JSON the model reads
 * (docs/doctrine/typed-truth-perception.md). `already_paid` and
 * `retrieval_cost` are the load-bearing fields: the #874 run showed a
 * model, asked for a paid result after a restart, reach for
 * `delegate_to_agent` — a second payment — because nothing told it the
 * work was bought and the result was a free read away.
 */
export function renderTaskRetrieval(
  r: TaskRetrieval,
  paid: import("./paid-intent-ledger.js").UnretrievedPayment | null,
): string {
  const guidance: Record<TaskRetrieval["status"], string> = {
    delivered:
      "The worker's signed result is below. Report it to the user; nothing was paid to fetch it.",
    pending:
      "The task is still running. Retrieve again later — never re-delegate it; that pays a second time.",
    undetermined:
      "The relay handed this task to an executor that was then lost: the work MAY have run, may " +
      "still be running, or never started — nobody knows yet. Do NOT re-delegate it; that is a " +
      "second hire for work that may already be done. Retrieve again later (the executor's late " +
      "signed result still resolves it) and tell the user the outcome is undetermined.",
    expired:
      "No executor ever took this task before it expired: it did NOT run and never will. Tell the " +
      "user; a new delegation would be a separate hire.",
    failed:
      "The relay marked the task failed without a signed result. Tell the user; do not re-delegate on your own.",
    not_found:
      "The relay no longer holds this task (reaped after its retention window) or the id is wrong. " +
      "Do NOT re-delegate to recover it — that pays again. Tell the user and let them decide.",
    auth_error: "The relay refused this read. Tell the user; do not re-delegate.",
    unreachable: "The relay could not be reached. Retrieve again later; do not re-delegate.",
    malformed:
      "The relay returned a receipt for a different task. Tell the user; do not re-delegate.",
    invalid_task_id:
      "That is not a task id. Ask the user for the id (or use /result to list them).",
    not_connected: "No relay is connected on this device, so nothing could be read.",
    not_admitted:
      "This is a payment with NO confirmed relay task: the relay refused it, or its admission " +
      "(or the payment's landing) was never confirmed. There is nothing to fetch by this id. Do " +
      "NOT re-delegate — that would pay again. Tell the user the payment is outstanding and let " +
      "them reconcile it.",
  };
  const out: Record<string, unknown> = {
    task_id: r.taskId,
    status: r.status,
    // Known from this device's own ledger, or not known — never guessed.
    already_paid: paid != null ? true : "unknown",
    retrieval_cost: "free — a read-only task:query; nothing was submitted or paid",
    guidance: guidance[r.status],
  };
  if (paid != null) {
    out.payment = {
      paid_micro: paid.paidMicro,
      fee_micro: paid.feeMicro,
      tx_hash: paid.txHash,
      worker_motebit_id: paid.workerMotebitId,
      capability: paid.capability,
    };
  }
  if (r.status === "delivered") {
    out.receipt_status = r.receipt.status;
    out.delegated_to = r.receipt.motebit_id;
    out.result = r.receipt.result ?? "";
  } else if (r.status === "pending") {
    out.task_status = r.taskStatus;
  } else if (r.status === "undetermined" || r.status === "expired") {
    out.reason = r.reason;
    out.detail = r.detail;
  } else if ("message" in r) {
    out.detail = r.message;
  }
  return JSON.stringify(out);
}

// === Manager ===

export class InteractiveDelegationManager {
  /** #943: receipts are collected per turn — see `turn-delegation-receipts.ts`. */
  private readonly receipts: TurnDelegationReceipts;
  /** #885: money warnings from delegate_to_agent calls, drained by the stream. */
  private paymentNotices: Array<NonNullable<ReturnType<typeof paymentNoticeChunk>>> = [];

  /** Take the pending payment notices (the streaming layer emits them). */
  drainPaymentNotices(): Array<NonNullable<ReturnType<typeof paymentNoticeChunk>>> {
    const out = this.paymentNotices;
    this.paymentNotices = [];
    return out;
  }

  constructor(private readonly deps: InteractiveDelegationDeps) {
    this.receipts = deps.turnReceipts ?? new TurnDelegationReceipts();
  }

  /**
   * Register the `delegate_to_agent` tool for interactive delegation.
   *
   * The tool submits tasks to the relay via REST, polls for results, bumps trust
   * on verified receipts, and returns the result as normal tool output.
   */
  enable(config: InteractiveDelegationConfig): void {
    const TOOL_NAME = "delegate_to_agent";

    // Avoid double-registration
    if (this.deps.toolRegistry.has(TOOL_NAME)) return;

    // Wire credential submission to relay — credentials issued by bumpTrustFromReceipt
    // are submitted to the relay for routing indexing. The subject agent (the one we
    // delegated to) gets the credential pushed to its relay profile.
    const { logger } = this.deps;
    this.deps.setCredentialSubmitter(async (vc, targetMotebitId) => {
      try {
        const token = await config.authToken();
        const resp = await fetch(
          `${config.syncUrl}/api/v1/agents/${encodeURIComponent(targetMotebitId)}/credentials/submit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ credentials: [vc] }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          logger.warn("credential relay submission http_failed", {
            status: resp.status,
            targetMotebitId,
          });
          return;
        }
        // The relay returns HTTP 200 even when it filters every credential
        // server-side (spec/credential-v1.md §23 — self-issued / signature-
        // failed / unknown-subject all collapse to a body-level rejection).
        // Inspect the body counts so silent server-side filtering surfaces
        // in the runtime logs, not just at status-code level.
        const body = (await resp.json().catch(() => null)) as {
          accepted?: number;
          rejected?: number;
          errors?: string[];
        } | null;
        if (body == null) return;
        const accepted = body.accepted ?? 0;
        const rejected = body.rejected ?? 0;
        if (rejected > 0) {
          logger.warn("credential relay submission body_rejected", {
            targetMotebitId,
            accepted,
            rejected,
            errors: body.errors ?? [],
          });
        }
      } catch (err: unknown) {
        logger.warn("credential relay submission failed", {
          error: err instanceof Error ? err.message : String(err),
          targetMotebitId,
        });
      }
    });

    const timeoutMs = config.timeoutMs ?? 120_000;
    const motebitId = this.deps.motebitId;
    const bumpTrust = (receipt: ExecutionReceipt) => this.deps.bumpTrustFromReceipt(receipt);

    // Mark as delegation tool for processStream to emit delegation_start/complete
    this.deps.motebitToolServers.set(TOOL_NAME, "relay");

    this.deps.toolRegistry.register(
      {
        name: TOOL_NAME,
        description:
          "Delegate a task to a remote agent on the motebit network. " +
          "The relay routes to the best capable agent based on trust and capabilities. " +
          "Use when the user asks you to delegate, or when a task would benefit from " +
          "a specialized agent. Returns the agent's response text. " +
          "NEVER use this to get the result of a task already hired — that hires (and may " +
          "pay) again; use retrieve_task_result with the task id instead.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The task prompt to send to the remote agent.",
            },
            required_capabilities: {
              type: "array",
              items: { type: "string" },
              description:
                "Capabilities the target agent must have (e.g. ['web_search', 'read_url']). " +
                "Optional — if omitted, the relay routes based on the prompt alone.",
            },
          },
          required: ["prompt"],
        },
        // Cross-motebit delegation sends the prompt + arguments to a
        // remote agent via the relay. Same outbound boundary as
        // web_search / read_url; the runtime's sensitivity gate
        // refuses to dispatch this tool when session_sensitivity is
        // medical/financial/secret AND the configured provider is not
        // sovereign.
        outbound: true,
        // api-tier per the hybrid-engine structural preference. Inline
        // registration escapes check-tool-modes' literal scan (it only
        // sweeps exported Definition consts) — tagged here so the registry
        // sort still prefers it over pixel-tier fallbacks.
        mode: "api",
        // Interior: hires and pays FOR THIS motebit's owner. Never served
        // to another principal over MCP, never advertised (#874).
        localOnly: true,
        // Risk classification is explicit, never inferred: with a
        // payment rail configured, a paid delegation settles real money
        // onchain (R4_MONEY, irreversible) — the name/description
        // patterns would otherwise classify this tool R0_READ and let
        // it auto-execute as read-class. Without a rail, delegation is
        // still an outbound side effect (R2_WRITE). Gate-enforced by
        // check-money-authority; doctrine
        // docs/doctrine/memory-never-confers-authority.md.
        riskHint: config.buildP2pPayment
          ? { risk: RiskLevel.R4_MONEY, sideEffect: SideEffect.IRREVERSIBLE }
          : { risk: RiskLevel.R2_WRITE, sideEffect: SideEffect.REVERSIBLE },
        // The spend is LATE-BOUND: the amount materializes at quote
        // resolution inside execution, not in the tool args — so the
        // loop's AND-composition admits a grant-cleared call on
        // grant+meter presence, and the metered rail seam
        // (wrapP2pPaymentWithMeter, which the runtime binds as
        // `buildP2pPayment`) enforces the signed ceiling at the last
        // point before broadcast. Only meaningful with a payment rail;
        // harmless without one (the tool is R2 and never meters).
        ...(config.buildP2pPayment ? { moneyBinding: "late" as const } : {}),
      },
      // #943 round 9: whose call this is arrives WITH the call (`call`,
      // from the runtime registry) — never from runtime-wide state.
      async (args: Record<string, unknown>, call?: ToolCall) => {
        const prompt = args.prompt as string;
        const requiredCapabilities = args.required_capabilities as string[] | undefined;

        // Resolve the cold-start ack fresh per call (a function reflects a live
        // surface toggle without re-enabling). Without forwarding this, a paid
        // delegation to a no-history worker is denied P2P eligibility and silently
        // degrades to relay-mode — the "pay new agents directly" toggle would be a
        // no-op for the AI-loop path.
        const ack =
          typeof config.acknowledgeNoHistoryRisk === "function"
            ? config.acknowledgeNoHistoryRisk()
            : config.acknowledgeNoHistoryRisk;

        // Read the active grant id fresh per call — the relay's
        // acceptance-time revocation fence keys on it.
        const grantId = config.getActiveGrantId?.() ?? null;

        // Route-degrade capture (#458): if the sovereign P2P route fails
        // pre-broadcast and the delegation proceeds relay-mode, the human's
        // approval may have been framed as a wallet payment — the switch is
        // stated in this tool's result so the model reports it, never
        // narrates the sovereign route it didn't take.
        const routeDegrade: { current: import("./relay-delegation.js").RouteDegrade | null } = {
          current: null,
        };

        const result = await selectAndRunDelegation({
          motebitId,
          syncUrl: config.syncUrl,
          authToken: config.authToken,
          prompt,
          ...(requiredCapabilities ? { requiredCapabilities } : {}),
          ...(config.buildP2pPayment ? { buildP2pPayment: config.buildP2pPayment } : {}),
          ...(config.confirmP2pPayment ? { confirmP2pPayment: config.confirmP2pPayment } : {}),
          ...(config.relayPublicKey != null ? { relayPublicKey: config.relayPublicKey } : {}),
          ...(ack === true ? { acknowledgeNoHistoryRisk: true } : {}),
          ...(config.routingStrategy ? { routingStrategy: config.routingStrategy } : {}),
          ...(grantId != null ? { grantId } : {}),
          ...(config.paidIntentLedger != null ? { paidIntentLedger: config.paidIntentLedger } : {}),
          invocationOrigin: "ai-loop",
          ...(timeoutMs != null ? { timeoutMs } : {}),
          logger,
          onRouteDegrade: (degrade) => {
            routeDegrade.current = degrade;
          },
        });
        // #885: a money warning reaches the OWNER as a typed stream chunk
        // (drained by the streaming layer after this call), not only the
        // model through the tool text below.
        const notice = paymentNoticeChunk(result);
        if (notice != null) this.paymentNotices.push(notice);

        if (!result.ok) {
          // A failure AFTER the onchain payment settled is categorically
          // different from a failure that spent nothing, and flattening both
          // into one string is how a transient poll error becomes a second
          // real-money charge (#433): the model reads "timeout", concludes the
          // hire didn't happen, and delegates again. Name the money.
          const settled = result.error.settledPayment;
          // The interlock refused BEFORE broadcast: no NEW money moved — the
          // settledPayment here is the PRIOR task's. Distinct wording from
          // PAYMENT_ALREADY_SETTLED so the model cannot read this refusal as
          // "this call paid" (it didn't) or as a retryable failure (it isn't).
          // Inside ANOTHER principal's task (a molecule serving a customer),
          // the prior payment is the owner's business: refuse without the
          // owner's task id, tx or /result pointer (#874 review).
          if (result.error.code === "intent_already_paid" && call?.principal.foreign === true) {
            return {
              ok: false,
              error:
                "INTENT_ALREADY_PAID — refused BEFORE broadcasting; no new money moved. This " +
                "motebit already has a paid delegation outstanding that this hire would " +
                "duplicate. Do NOT re-delegate; report that the hire could not be made now.",
            };
          }
          if (result.error.code === "intent_already_paid" && settled) {
            return {
              ok: false,
              error:
                `INTENT_ALREADY_PAID — refused BEFORE broadcasting; no new money moved. ` +
                `An earlier payment already settled onchain for this work: ` +
                `${(settled.paidMicro / 1_000_000).toFixed(4)} USDC (+ ` +
                `${(settled.feeMicro / 1_000_000).toFixed(4)} fee), tx ${settled.txHash}, ` +
                `task ${settled.taskId} — and its result was never retrieved. ` +
                `${result.error.message} ` +
                `Do NOT re-delegate. Call retrieve_task_result with task_id ${settled.taskId} ` +
                `(free, read-only) to fetch it; if that does not deliver, tell the user the work ` +
                `was already paid for and its result is outstanding, and let them decide.`,
            };
          }
          // #885: the money left the wallet but the relay never admitted the
          // task — there is no task id to fetch. Not "the hire succeeded".
          if (
            (result.error.code === "payment_not_admitted" ||
              result.error.code === "payment_admission_unconfirmed") &&
            settled
          ) {
            const refused = result.error.code === "payment_not_admitted";
            return {
              ok: false,
              error:
                `${refused ? "PAYMENT_NOT_ADMITTED" : "PAYMENT_ADMISSION_UNCONFIRMED"} — you have ` +
                `ALREADY PAID ${(settled.paidMicro / 1_000_000).toFixed(4)} USDC (+ ` +
                `${(settled.feeMicro / 1_000_000).toFixed(4)} fee) onchain, tx ${settled.txHash}, ` +
                (refused
                  ? `and the relay refused the task. `
                  : `and the relay has not confirmed admitting the task (it may have, without ` +
                    `the answer arriving). `) +
                `No task id is known, so there is nothing to fetch. Do NOT delegate this task ` +
                `again — a second delegation pays a SECOND time. Tell the user the payment went ` +
                `out (${result.error.message}), and let them decide.`,
            };
          }
          if (result.error.code === "payment_status_unknown") {
            return {
              ok: false,
              error:
                `PAYMENT_STATUS_UNKNOWN — the payment step failed and the wallet could not ` +
                `confirm whether money left it. Nothing was submitted. Do NOT delegate this task ` +
                `again — if the payment landed, a second delegation pays twice. Tell the user to ` +
                `check the wallet's history (${result.error.message}).`,
            };
          }
          // One task, one body: the relay's own verdict on the hire. Typed
          // truth, never flattened into a timeout or a delivery failure.
          const verdict = result.error.relayVerdict;
          const paidLine = settled
            ? `You have ALREADY PAID ${(settled.paidMicro / 1_000_000).toFixed(4)} USDC (+ ` +
              `${(settled.feeMicro / 1_000_000).toFixed(4)} fee) onchain, tx ${settled.txHash}. `
            : "";
          if (result.error.code === "undetermined" && verdict != null) {
            return {
              ok: false,
              error:
                `TASK_UNDETERMINED — the relay handed task ${verdict.taskId} to an executor that ` +
                `was then lost (${verdict.reason}). The work MAY have run, may still be running, ` +
                `or never started; the relay does not know and will not give it to anyone else. ` +
                paidLine +
                `Do NOT delegate this task again — that is a second hire for work that may ` +
                `already be done. The executor's late signed result still resolves it: fetch it ` +
                `later with retrieve_task_result (task_id ${verdict.taskId}; free, read-only). ` +
                `Tell the user the outcome is undetermined, and let them decide.`,
            };
          }
          if (result.error.code === "task_expired" && verdict != null) {
            return {
              ok: false,
              error:
                `TASK_EXPIRED — no executor ever took task ${verdict.taskId} before it expired ` +
                `(${verdict.reason}): it did NOT run and never will. ` +
                (settled
                  ? paidLine +
                    `Do NOT delegate again on your own — a new delegation pays a SECOND time. ` +
                    `Tell the user the work was paid for and never ran, and let them decide.`
                  : `Nothing ran. A new delegation would be a separate hire; tell the user.`),
            };
          }
          if (settled) {
            return {
              ok: false,
              error:
                `PAYMENT_ALREADY_SETTLED — the hire SUCCEEDED and you have already paid ` +
                `${(settled.paidMicro / 1_000_000).toFixed(4)} USDC (+ ` +
                `${(settled.feeMicro / 1_000_000).toFixed(4)} fee) onchain, tx ${settled.txHash}. ` +
                `Only RESULT DELIVERY failed (${result.error.code}: ${result.error.message}). ` +
                `Do NOT delegate this task again — a second delegation broadcasts a SECOND ` +
                `payment for work already bought. The task id is ${settled.taskId}; the worker's ` +
                `result may still arrive — fetch it with retrieve_task_result (free, read-only; ` +
                `the user can also type /result ${settled.taskId}). Tell the user the work was ` +
                `paid for and the result did not come back yet, and let them decide.`,
            };
          }
          return {
            ok: false,
            error:
              `${result.error.code}: ${result.error.message}` +
              (routeDegrade.current != null
                ? ` (This failure happened AFTER the sovereign peer-payment route was unavailable (${routeDegrade.current.code}) and the task had rerouted through the relay — no onchain payment left the wallet at any point.)`
                : ""),
          };
        }

        // Bump trust (best-effort)
        try {
          await bumpTrust(result.receipt);
        } catch {
          // Best-effort
        }

        // Surface the settlement fact so the model reports payment truthfully
        // (it previously narrated "settlement isn't active" on a paid run). The
        // worker's answer stays primary; the payment is a labeled footnote.
        // The worker's identity is a second footnote — witnessed 2026-07-09 in
        // prod: the model could not say WHO it had delegated to, because this
        // result never carried it. The receipt's signer is the ground truth.
        const workerResult = result.receipt.result ?? "Task completed (no result text)";
        const settlementNote = formatSettlementNote(result.settlement);
        const workerNote = `[delegated_to: ${result.receipt.motebit_id}]`;
        // Route honesty (#458): the approval may have been framed as a
        // sovereign-wallet payment; if the route switched, the result says so
        // explicitly so the model relays the switch to the user.
        const degradeNote =
          routeDegrade.current != null
            ? `[route] The sovereign peer-payment route was unavailable (${routeDegrade.current.code}); this task ran relay-routed instead — NO onchain payment left the wallet. Tell the user the route changed from what the approval described.`
            : "";
        const footnotes = [
          workerNote,
          ...(settlementNote ? [settlementNote] : []),
          ...(degradeNote ? [degradeNote] : []),
        ].join("\n");
        // #943: the receipt rides ON the result; the tool registry records
        // it for the destination the caller named (the turn that made this
        // call, or the owner). Trust was credited above.
        const carrying: ReceiptCarryingResult = {
          ok: true,
          data: `${workerResult}\n\n${footnotes}`,
          delegation_receipt: result.receipt,
          delegation_receipt_trust_credited: true,
        };
        return carrying;
      },
    );

    // discover_agents — the LIVE roster read, registered beside
    // delegate_to_agent so every surface that enables delegation gets
    // grounded discovery in the same pass. Exists because of a witnessed
    // 2026-07-09 prod failure: asked "who's discoverable right now?", the
    // model answered from the committed self-knowledge corpus (the repo's
    // marketplace description — wrong roster, stale pricing) because no
    // tool exposed the relay's actual directory to the loop. Typed-truth
    // discipline (docs/doctrine/typed-truth-perception.md): the result
    // carries `roster_source: "live_relay_read"` and the prompt teaches
    // that roster questions are answerable ONLY from this field — corpus
    // recall is design-shape, never current state.
    const DISCOVER_TOOL = "discover_agents";
    if (!this.deps.toolRegistry.has(DISCOVER_TOOL)) {
      this.deps.toolRegistry.register(
        {
          name: DISCOVER_TOOL,
          description:
            "List the agents discoverable on the connected relay RIGHT NOW — the live directory read. " +
            "Use whenever the user asks who is available, what agents exist, what delegation costs, " +
            "or before choosing a delegation target. Names are self-asserted claims, never verified " +
            "handles. This is the ONLY source for the current roster; never answer roster questions " +
            "from memory or self-description.",
          inputSchema: {
            type: "object",
            properties: {
              capability: {
                type: "string",
                description:
                  "Optional capability filter (e.g. 'research'). Omit for the full roster.",
              },
            },
            required: [],
          },
          // Same outbound boundary as web_search — a network read that
          // reveals the question being asked, nothing more. Read-class.
          outbound: true,
          mode: "api",
          // Interior: reads the relay with THIS motebit's token for its own
          // hiring decisions. The web, desktop and mobile serve paths
          // already refused it by name; the CLI and molecule MCP servers
          // served it (#874). Never a sellable capability.
          localOnly: true,
          riskHint: { risk: RiskLevel.R0_READ, sideEffect: SideEffect.NONE },
        },
        async (args: Record<string, unknown>) => {
          const capability = typeof args.capability === "string" ? args.capability : undefined;
          try {
            const token = await config.authToken();
            const url = new URL(`${config.syncUrl}/api/v1/agents/discover`);
            if (capability != null && capability.length > 0) {
              url.searchParams.set("capability", capability);
            }
            const resp = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!resp.ok) {
              return { ok: false, error: `discover read failed: HTTP ${resp.status}` };
            }
            const body = (await resp.json()) as {
              agents?: Array<{
                motebit_id: string;
                capabilities: string[];
                display_name?: string | null;
                description?: string | null;
                pricing?: Array<{
                  capability: string;
                  unit_cost: number;
                  currency: string;
                  per: string;
                }> | null;
                freshness?: string;
                trust_level?: string;
                settlement_modes?: string | null;
              }>;
            };
            const agents = (body.agents ?? []).map((a) => ({
              motebit_id: a.motebit_id,
              // A self-asserted CLAIM (agents-as-first-person-trust-graph §3)
              // — surfaced under that name so the model inherits the framing.
              ...(a.display_name != null && a.display_name.length > 0
                ? { claimed_name: a.display_name }
                : {}),
              ...(a.description != null && a.description.length > 0
                ? { description: a.description }
                : {}),
              capabilities: a.capabilities,
              ...(a.pricing != null && a.pricing.length > 0 ? { pricing: a.pricing } : {}),
              ...(a.freshness != null ? { freshness: a.freshness } : {}),
              ...(a.trust_level != null ? { trust_level: a.trust_level } : {}),
              ...(a.settlement_modes != null ? { settlement_modes: a.settlement_modes } : {}),
            }));
            return {
              ok: true,
              data: JSON.stringify({
                roster_source: "live_relay_read",
                relay: config.syncUrl,
                as_of_ms: Date.now(),
                agent_count: agents.length,
                agents,
              }),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `discover read failed: ${msg}` };
          }
        },
      );
    }

    // retrieve_task_result — the free, read-only recovery read (#874).
    // Registered beside delegate_to_agent so every surface that can hire
    // can also fetch a result it already paid for. Witnessed 2026-09-27:
    // after a restart, asked for a paid result, the model's only tool was
    // delegate_to_agent — a second MONEY · IRREVERSIBLE prompt that only a
    // human "n" stopped. Read-class by construction: one task:query GET,
    // never a submit, never a payment.
    const RETRIEVE_TOOL = "retrieve_task_result";
    if (!this.deps.toolRegistry.has(RETRIEVE_TOOL)) {
      const ledger = config.paidIntentLedger;
      const retrieve =
        config.retrieveTaskResult ??
        (async (taskId: string): Promise<TaskRetrieval> => {
          const r = await retrieveDelegationResult({
            motebitId,
            syncUrl: config.syncUrl,
            authToken: config.authToken,
            taskId,
          });
          if (r.status === "delivered") ledger?.resolve(r.taskId);
          return r;
        });
      this.deps.toolRegistry.register(
        {
          name: RETRIEVE_TOOL,
          description:
            "Fetch the result of a task ALREADY delegated, by its task id — free and read-only " +
            "(one relay read; never hires, never pays). Use this whenever the user asks for the " +
            "result of a task, asks what happened to a task, or says they already paid for " +
            "something. ALWAYS prefer this over delegate_to_agent for an existing task: " +
            "delegating again hires and pays a second time. Omit task_id to list this device's " +
            "paid tasks whose results have not been retrieved.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: {
                type: "string",
                description:
                  "The relay task id (as given in an earlier delegation result or by the user). " +
                  "A unique prefix of an outstanding paid task's id also works.",
              },
            },
            required: [],
          },
          // A read of this motebit's own task on its relay — same outbound
          // boundary as discover_agents, and never a sellable capability.
          outbound: true,
          mode: "api",
          // Interior: lists this motebit's own paid tasks and returns work
          // bought for its owner (or, on a molecule, for its customers).
          // Never served over MCP, never advertised (#874 review).
          localOnly: true,
          riskHint: { risk: RiskLevel.R0_READ, sideEffect: SideEffect.NONE },
        },
        // `retrieve_task_result` is owner-only: a foreign CALL (a customer's
        // prompt) cannot list this motebit's paid tasks or read work it
        // bought for someone else. Defense in depth — the tool is
        // `localOnly`, so a foreign turn's registry never offers it.
        async (args: Record<string, unknown>, call?: ToolCall) => {
          if (call?.principal.foreign === true) {
            return {
              ok: false,
              error:
                "retrieve_task_result is owner-only and this turn is running another principal's " +
                "task — nothing was read.",
            };
          }
          const raw = typeof args.task_id === "string" ? args.task_id.trim() : "";
          const outstanding = ledger?.outstanding() ?? [];
          if (raw === "") {
            return {
              ok: true,
              data: JSON.stringify({
                outstanding_paid_results: outstanding.map((e) => ({
                  task_id: e.taskId,
                  worker_motebit_id: e.workerMotebitId,
                  capability: e.capability,
                  paid_micro: e.paidMicro,
                  fee_micro: e.feeMicro,
                  tx_hash: e.txHash,
                  recorded_at: e.recordedAt,
                })),
                guidance:
                  outstanding.length > 0
                    ? "Each of these was paid for and its result never arrived. Call " +
                      "retrieve_task_result with its task_id — never re-delegate."
                    : "No paid result is known on this device. Its ledger records only " +
                      "payments made here, so this is not proof that no task is owed a result.",
              }),
            };
          }
          // A unique prefix of an outstanding paid task resolves to it — the
          // owner is shown short ids ("/result ed665235").
          const matches = outstanding.filter((e) => e.taskId.startsWith(raw));
          const taskId = matches.length === 1 ? matches[0]!.taskId : raw;
          const paid = ledger?.find(taskId) ?? null;
          const result = await retrieve(taskId);
          return { ok: true, data: renderTaskRetrieval(result, paid) };
        },
      );
    }

    // Re-wire loop deps so the tools are visible to the agentic loop
    this.deps.wireLoopDeps();
  }

  /**
   * Drain the OWNER's record: receipts produced outside any task's turn
   * (#943). Never read by `handleAgentTask` — a task's receipt gets only its
   * own turn's hires, through the turn's sink.
   */
  getAndResetReceipts(): ExecutionReceipt[] {
    return this.receipts.drainOwner();
  }

  /**
   * A receipt from an owner act outside any turn (today: `invokeCapability`,
   * a user tap). It goes to the owner's record ONLY — never into an
   * in-flight turn's collector, which may be another principal's task
   * (#943: a tap during a customer's `motebit_task` must not be signed into
   * the customer's receipt).
   */
  pushReceipt(receipt: ExecutionReceipt): void {
    this.receipts.recordOwnerAct(receipt);
  }

  /**
   * Non-draining view of the stash for the streaming layer's
   * `delegation_complete` emission (#493): mark the count before a
   * `delegate_to_agent` call, peek what arrived after it. MUST NOT drain —
   * `getAndResetReceipts` composes the same bucket into the parent
   * receipt's `delegation_receipts` chain, and a draining reader here
   * would silently sever that chain (composition-preserves-enforcement).
   */
  get stashedReceiptCount(): number {
    return this.receipts.count();
  }

  /** See {@link stashedReceiptCount} — the peek half of the pair. */
  peekReceiptsSince(count: number): ExecutionReceipt[] {
    return this.receipts.peekSince(count);
  }
}
