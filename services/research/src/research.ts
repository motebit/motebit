/**
 * Research agent — takes a question, delegates to motebit's web-search/ and
 * read-url/ atoms via a multi-turn Claude tool-use loop, returns a
 * synthesized report with a signed citation chain.
 *
 * Each delegation goes through `McpClientAdapter` from `@motebit/mcp-client`,
 * which handles bearer-token minting, the MCP StreamableHTTP handshake, and
 * automatic capture of `ExecutionReceipt`s from `motebit_task` responses. The
 * captured receipts accumulate into `delegation_receipts` on the top-level
 * research receipt.
 *
 * The chain matters when citations are load-bearing: agent-to-agent
 * composition, dispute evidence, regulated use (journalism, legal,
 * compliance, academic, financial), or any consumer acting on the output
 * without a human in the loop. In those cases, anyone with `@motebit/crypto`
 * and the agents' public keys can verify offline that every search and
 * fetch actually happened. For casual reading the chain is inert — the
 * user clicks URLs directly.
 *
 * The receipt-capture primitive lives in mcp-client and applies to any
 * motebit-to-motebit delegation — not a research feature. Other composing
 * agents (fact-checkers, deep-summarizers, chain-of-agents) use the same
 * primitive; they should not reinvent the transport.
 */

import Anthropic from "@anthropic-ai/sdk";
import { McpClientAdapter } from "@motebit/mcp-client";
import { memoryTaskSpend, openRelaySubTask } from "@motebit/molecule-runner";
import type { TaskSpend, TaskSpendHold } from "@motebit/molecule-runner";
import type { Citation, ExecutionReceipt, TokenAudience } from "@motebit/sdk";
import { querySelfKnowledge } from "@motebit/self-knowledge";
import { SONNET_MICRO_PER_MTOK } from "./helpers.js";
import { reportShapeIssues } from "./report-shape.js";

/**
 * Interior citations are minted only when the REPORT actually cites them.
 * `motebit_recall_self` is a free, speculative, prompt-encouraged first look —
 * its hits are model CONTEXT, not automatically report SOURCES; unconditionally
 * citing them padded off-topic reports with irrelevant self-knowledge excerpts
 * (observed live: 3 of 5 citations on a pure-web question were droplet-physics
 * chunks). The system prompt already contracts the model to list interior
 * sources by locator (`interior:{source}#{title}`), so the filter keeps an
 * interior citation iff its locator appears in the report text. This is an
 * INTERSECTION (recalled ∩ report-listed): the model's Sources list can only
 * shrink the recalled set, never mint provenance for content that was not
 * actually recalled — a hallucinated Sources line cannot fabricate a citation.
 * Web citations are receipt-anchored paid acts and always cite;
 * `recall_self_count` still discloses that interior recalls occurred.
 */
function filterInteriorCitations(citations: Citation[], report: string): Citation[] {
  return citations.filter((c) => c.source !== "interior" || report.includes(c.locator));
}

const SYSTEM_PROMPT = `You are a research analyst. Given a question, your job is to investigate it thoroughly using the available tools and produce a clear, well-structured report.

You have three tools, ordered by preference:
- motebit_recall_self: searches your own committed knowledge about Motebit (docs, doctrine, architecture). INSTANT and FREE. Try this FIRST whenever the question is about Motebit, sovereignty, agent identity, or any concept native to your own documentation. If it returns a strong match, you may not need to go further.
- motebit_web_search: searches the public web. Returns results (title, url, snippet). Use when the question needs information beyond your interior knowledge.
- motebit_read_url: fetches and extracts the readable content of a URL. Use after web_search to get the substance of the most promising 2-4 results.

Standard pattern: recall_self first for anything Motebit-related. If interior is insufficient, search the web, pick the most promising URLs, read them, synthesize. Don't read every result — pick what matters.

For each report:

1. **Question** — restate the question in one line.
2. **Findings** — the substantive answer. Cite sources inline as [1], [2], etc. Be specific: numbers, dates, names, direct quotes when relevant.
3. **Open questions** — what you couldn't answer. Skip if there are none.
4. **Sources** — numbered list: interior chunks you read (via motebit_recall_self) first, then URLs you read (via motebit_read_url), in order of citation. Each line: \`[N] Title — {locator}\` where locator is either \`interior:{source}#{title}\` or the URL.

Be direct. No filler. Match depth to the question. If nothing you looked up answers the question, say so — do not fabricate.

Your final message is delivered verbatim to a paying customer as the purchased report. When you stop calling tools, that message MUST be the complete report in the format above — never planning, running commentary, or pasted tool output.`;

let cachedClient: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

// === Types ===

/** A signed ExecutionReceipt returned by an atom service (web-search or read-url). */
export type SignedReceipt = ExecutionReceipt;

export interface ResearchResult {
  /** Synthesized report text (markdown). */
  report: string;
  /**
   * Operator-side inference-cost estimate (USD) summed from Anthropic
   * `response.usage` across the loop — the number MOTEBIT_UNIT_COST must
   * clear for the archetype's economics to be honest (operator-funded
   * inference is priced into the task, never sold as intelligence).
   */
  cost_estimate_usd: number;
  /** Signed receipts from every delegated call, in execution order. The verifiable citation chain. */
  delegation_receipts: SignedReceipt[];
  /**
   * The money fact per PAID sub-hop, in execution order — the self-attested
   * proof that the atoms were paid P2P (not silently done for free). Empty when
   * no atom hop settled (unpriced atoms / no money seam / free direct-MCP
   * fallback). Distinct from `delegation_receipts`, which a free hop also fills.
   */
  sub_settlements: SubHopSettlement[];
  /**
   * The delegator-signed routing-decision transcripts of the ranked paid
   * hops, in execution order — self-attested into the molecule's signed
   * receipt payload alongside `sub_settlements` so "the winner won on merit"
   * is verifiable from bytes (integrity + faithfulness rungs), never the
   * operator's word. Empty when every hop was pinned/sole-candidate/free.
   */
  routing_transcripts: Record<string, unknown>[];
  /**
   * Provenance of the report's sources. Web citations: one per URL actually
   * read (receipt-bound via receipt_task_id; bare web_search hits are not
   * cited). Interior citations: only recalled chunks the REPORT itself lists
   * as sources (see `filterInteriorCitations` — speculative recalls that
   * didn't make the Sources section are context, not citations;
   * `recall_self_count` discloses they happened). Citation.source
   * discriminates interior (self-attested, no receipt) from web. Aligns 1:1
   * with the outer `CitedAnswer.citations` surface built by the service.
   */
  citations: Citation[];
  /** Number of motebit_recall_self calls (interior tier). */
  recall_self_count: number;
  /** Number of motebit_web_search calls. */
  search_count: number;
  /** Number of motebit_read_url calls. */
  fetch_count: number;
  /**
   * Micro-units this turn actually paid out on sub-hops (worker net + relay
   * fee, from each hop's settlement fact, else its quote). Operator-side
   * observability only — logged, never on the wire.
   */
  paid_spend_micro: number;
  /** The per-task paid-spend budget this turn ran under; `null` = unbudgeted. */
  paid_budget_micro: number | null;
}

export interface ResearchConfig {
  anthropicApiKey: string;
  /** URL of the motebit web-search MCP server (e.g. http://localhost:3200/mcp). */
  webSearchUrl: string;
  /** URL of the motebit read-url MCP server. */
  readUrlUrl: string;
  /** Caller (this research service) identity for signing the bearer tokens. */
  callerMotebitId: string;
  callerDeviceId: string;
  callerPrivateKey: Uint8Array;
  /** Maximum total tool calls (search + fetch combined) per research turn — runaway-cost guard. */
  maxToolCalls: number;
  /** Optional: relay sync URL for budget-binding sub-delegations. */
  syncUrl?: string;
  /**
   * Mints a short-lived `task:submit` bearer signed by THIS service's identity
   * key, for opening the relay task that binds a sub-delegation's budget. A
   * worker authenticates to its relay as itself — never with the operator's
   * master token (`docs/doctrine/task-admission.md`).
   */
  mintRelayToken?: (audience?: TokenAudience) => Promise<string>;
  webSearchTargetId?: string;
  readUrlTargetId?: string;
  /**
   * Test seam: factory for the mcp-client adapter. Defaults to constructing a
   * real `McpClientAdapter`. Tests inject a stub that returns canned receipts
   * without spinning up a real MCP server.
   */
  adapterFactory?: AdapterFactory;
  /**
   * Inc 2b — the paid sub-delegation seam. Supplied by the money runtime (the
   * molecule-runner spend handle) when the service boots with `moneyExecution`
   * wired. ABSENT ⇒ every atom hop uses the free direct-MCP path (today's
   * behavior), so this is dormant until the money seam is enabled. When
   * present, a PRICED atom is paid P2P (the relay coordinates the hop and earns
   * its fee); an unpriced atom falls back to direct MCP.
   */
  paidSubDelegate?: PaidSubDelegate;
  /**
   * Per-task ceiling (micro-units) on PAID sub-hop outflow — worker net plus
   * relay fee — so the task never spends more on atoms than its own price
   * leaves after margin and inference (`computePaidSpendBudgetMicro`). When
   * set, every paid hop is QUOTED first (a dry run of the same spend path,
   * priced from the target's listing) and skipped if it would cross the
   * budget; the turn synthesizes from what it has (fail-soft). Absent ⇒
   * unbudgeted (no quote round-trip).
   */
  paidSpendBudgetMicro?: number;
  /**
   * Where this turn's paid outflow is charged, reserve-before-pay. The
   * service passes the ADMITTED relay task's durable ledger
   * (`MoleculeSpendHandle.taskSpend(admittedRelayTaskId)`), so every run of
   * one admitted task — a timed-out run still paying, its honest retry —
   * draws on ONE budget. Absent ⇒ a fresh per-run ledger (an unadmitted call
   * keeps the per-run budget).
   */
  paidSpendLedger?: TaskSpend;
}

/**
 * The config ONE run of `motebit_task` executes under: when the MCP surface
 * admitted the call (`admittedRelayTaskId` — the verified dispatch token's
 * `sub`, never a caller-supplied id) and the molecule can spend, the run
 * charges that admitted task's durable ledger, so every run of the task
 * shares one budget. Otherwise the base config (a per-run ledger).
 */
export function researchConfigForTask(
  base: ResearchConfig,
  admittedRelayTaskId: string | undefined,
  taskSpend: ((admittedRelayTaskId: string) => TaskSpend) | undefined,
): ResearchConfig {
  if (admittedRelayTaskId == null || taskSpend == null) return base;
  return { ...base, paidSpendLedger: taskSpend(admittedRelayTaskId) };
}

/** Result of a paid P2P sub-delegation attempt (Inc 2b). */
export interface PaidSubDelegateResult {
  ok: boolean;
  /** The sub-worker's signed execution receipt (present on `ok`). */
  receipt?: SignedReceipt;
  /**
   * The money fact of the hop — mirrored from the runtime's `DelegationSettlement`
   * (`mode`/`txHash`/`paidMicro`/`feeMicro`). Present when a paid hop actually
   * settled so the molecule can self-attest what it paid its atom. Kept in the
   * runtime's camelCase field names because it is passed straight through from
   * the granted-delegation result; the molecule maps it to `SubHopSettlement`
   * for its signed wire payload.
   */
  settlement?: {
    mode: "p2p" | "relay";
    txHash?: string;
    paidMicro?: number;
    feeMicro?: number;
    /** #885: other transactions this hire sent that may have moved money. */
    extraPayments?: ReadonlyArray<unknown>;
  };
  /**
   * The delegator-signed routing-decision transcript for THIS hire's ranked
   * selection (docs/doctrine/routing-decision-transcript.md Inc 4) — passed
   * straight through from the granted-delegation result. Absent on pinned
   * hires and when the runtime has no signing key. Reveals, never authorizes.
   */
  routingTranscript?: Record<string, unknown>;
  /**
   * Quote only: the worker the quote priced. The live call is pinned to it so
   * the quote and the pay name the same counterparty.
   */
  workerMotebitId?: string;
  /** Failure code when `!ok` (e.g. `worker_not_payable`, `money_meter_denied`). */
  code?: string;
  /**
   * Money that LEFT the wallet on a FAILED hop (`!ok`) — the runtime's #433 /
   * #885 facts, passed through: the payment landed but delivery failed
   * (`settledPayment`, e.g. a post-broadcast `timeout` / `agent_failed`), or
   * it may have landed and could not be confirmed (`unconfirmedPayment`).
   * A failed hop that moved money is still charged to the task's budget.
   */
  settledPayment?: { paidMicro: number; feeMicro: number; txHash?: string; taskId?: string };
  unconfirmedPayment?: { paidMicro: number; feeMicro: number };
  /** Other transactions this hire sent that may have moved money (amounts unknown). */
  extraPayments?: ReadonlyArray<unknown>;
}

/**
 * Total outflow (worker net + fee) of a settlement fact or quote, in
 * micro-units; `null` when the worker leg is unknown — an unpriced quote is
 * never paid blind.
 */
function outflowMicro(settlement: PaidSubDelegateResult["settlement"]): number | null {
  if (settlement?.paidMicro == null) return null;
  return settlement.paidMicro + (settlement.feeMicro ?? 0);
}

/**
 * Money a FAILED paid hop moved anyway (micro-units): a settled or unconfirmed
 * payment, plus every extra transaction the hire sent, each charged at the
 * same per-transaction amount (or `perTxFallback` — the quote / the cap —
 * when the failure names no amount). Conservative by construction: money that
 * may have left is counted as left.
 */
function failedHopOutflowMicro(r: PaidSubDelegateResult, perTxFallback: number): number {
  const fact = r.settledPayment ?? r.unconfirmedPayment;
  const perTx = fact != null ? fact.paidMicro + fact.feeMicro : perTxFallback;
  return (fact != null ? perTx : 0) + (r.extraPayments?.length ?? 0) * perTx;
}

/**
 * The self-attested money fact of one sub-hop, stamped into the molecule's
 * signed receipt payload so "I paid my atom P2P" is verifiable offline (and the
 * `tx_hash` re-checkable onchain) — never inferred from the mere presence of a
 * nested receipt (a FREE direct-MCP hop also produces one). This is what makes
 * the multi-hop-as-P2P thesis self-attesting rather than a stdout log.
 */
export interface SubHopSettlement {
  /** The capability the atom served (e.g. `web_search`, `read_url`). */
  capability: string;
  /** The atom receipt's `task_id` — links this settlement to `delegation_receipts`. */
  task_id?: string;
  /** `p2p` = paid onchain in the molecule's atomic tx; `relay` = relay-ledger settlement. */
  mode: "p2p" | "relay";
  /** Onchain transaction signature (P2P only) — an auditor resolves it to the transfer. */
  tx_hash?: string;
  /** Micro-units paid to the atom, net of fee (P2P only). */
  paid_micro?: number;
  /** Platform fee in micro-units (P2P only). */
  fee_micro?: number;
}

/**
 * Pay a priced atom P2P from this molecule's own wallet, under its self-issued
 * grant. A `worker_not_payable` / `no_routing` / `p2p_ineligible` result means
 * the atom is not P2P-payable (unpriced / no settlement mode) and the caller
 * falls back to direct MCP; any OTHER failure is a real payment error and is
 * surfaced — the turn never silently does the work for free.
 */
export type PaidSubDelegate = (params: {
  capability: string;
  prompt: string;
  targetWorkerId?: string;
  /**
   * Quote only: resolve + price the hop (settlement carries `paidMicro` /
   * `feeMicro`) without paying or running it. Used by the per-task budget.
   */
  dryRun?: boolean;
  /**
   * Hard ceiling (integer micro-units) on this hop's resolved total outflow,
   * enforced by the runtime BEFORE the payment is signed — over it the hop
   * refuses `budget_exceeded` and no money moves. The budgeted turn passes its
   * REMAINING budget on every live call.
   */
  maxTotalMicro?: number;
}) => Promise<PaidSubDelegateResult>;

/** Codes that mean "this atom is not set up for P2P" → fall back to direct MCP. */
const NOT_PAYABLE_CODES = new Set(["worker_not_payable", "no_routing", "p2p_ineligible"]);

/** Minimal interface the research turn needs from an mcp-client adapter. */
export interface AtomAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    data?: unknown;
    error?: string;
    /** The worker's signed receipt for THIS call (#943) — never a shared bucket. */
    delegation_receipt?: SignedReceipt;
  }>;
}

export type AdapterFactory = (atom: {
  name: string;
  url: string;
  config: ResearchConfig;
}) => AtomAdapter;

/** Default factory: real McpClientAdapter wired with the caller's motebit identity. */
const defaultAdapterFactory: AdapterFactory = ({ name, url, config }) =>
  new McpClientAdapter({
    name,
    transport: "http",
    url,
    motebit: true,
    motebitType: "service",
    callerMotebitId: config.callerMotebitId,
    callerDeviceId: config.callerDeviceId,
    callerPrivateKey: config.callerPrivateKey,
  });

// === Tool definitions for Claude ===

const TOOLS: Anthropic.Tool[] = [
  {
    name: "motebit_recall_self",
    description:
      "Search your own committed knowledge about Motebit (README, DROPLET, THE_SOVEREIGN_INTERIOR, THE_METABOLIC_PRINCIPLE). Instant, free, offline. ALWAYS try this before motebit_web_search when the question is about Motebit, about sovereignty, about agent identity, or about any concept that feels native to the Motebit doctrine. Returns ranked chunks with source and title.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up in interior knowledge." },
        limit: { type: "number", description: "Max chunks to return (default 3)." },
      },
      required: ["query"],
    },
  },
  {
    name: "motebit_web_search",
    description:
      "Search the web via the motebit web-search service. Returns a JSON list of results with title, url, snippet. Use to find candidate URLs, then call motebit_read_url to get content.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (keywords work best)." },
      },
      required: ["query"],
    },
  },
  {
    name: "motebit_read_url",
    description:
      "Fetch and extract readable content from a URL via the motebit read-url service. Returns the page text. Use after motebit_web_search to read the substance of promising results.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
      },
      required: ["url"],
    },
  },
];

/**
 * Prompt caching (2026-08-01, the reprice lever): the loop re-sends the
 * ENTIRE growing history — including every fetched page — on every
 * iteration, and it ran uncached, which is where the 26–42¢/report
 * worst case came from. The static prefix (system + tools) and the
 * conversation prefix are cache-marked; iterations land seconds apart,
 * far inside the 5-minute TTL, so iterations 2..N read the prefix at
 * 0.1× input price. The moving breakpoint is applied per REQUEST to a
 * shallow copy — the canonical `messages` array stays clean, so markers
 * never accumulate past the API's 4-breakpoint limit.
 */
const CACHED_SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
);

/** Request-time shallow copy with a cache breakpoint on the final content
 * block of the final message — caches the whole conversation prefix. */
export function withPrefixCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (last == null) return messages;
  const mark = { cache_control: { type: "ephemeral" as const } };
  if (typeof last.content === "string") {
    return [
      ...messages.slice(0, -1),
      { ...last, content: [{ type: "text", text: last.content, ...mark }] },
    ] as Anthropic.MessageParam[];
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = [...last.content];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...mark } as never;
    return [...messages.slice(0, -1), { ...last, content: blocks }] as Anthropic.MessageParam[];
  }
  return messages;
}

// === Optional relay budget binding ===

/** What the relay hands back at submission: the task id plus the admission artifact. */
interface RelayBinding {
  relayTaskId: string;
  /** Relay-signed admission artifact — forwarded verbatim to the atom. */
  dispatchToken?: string;
}

/**
 * Open the relay task that binds a sub-delegation's budget, as the ONE
 * presenter (`presenter: "submitter"` — the relay admits but does not route, so
 * the returned dispatch_token is the only one). Returns the binding, or a
 * refusal the caller must honor: once the atom enforces admission the hop
 * cannot run without the token, and before that, running it free would be the
 * silent-free path this arc exists to close (docs/doctrine/task-admission.md).
 * `undefined` means no relay binding was CONFIGURED for this hop (dev / direct
 * atom), which is the only case the direct call proceeds untokened.
 */
async function bindRelayBudget(
  config: ResearchConfig,
  prompt: string,
  capabilityHint: string,
  targetMotebitId: string | undefined,
): Promise<RelayBinding | { refused: string } | undefined> {
  if (config.syncUrl == null || config.mintRelayToken == null || targetMotebitId == null)
    return undefined;
  const mint = config.mintRelayToken;
  const outcome = await openRelaySubTask({
    syncUrl: config.syncUrl,
    mintToken: (aud) => mint(aud),
    callerMotebitId: config.callerMotebitId,
    targetMotebitId,
    prompt,
    capability: capabilityHint,
  });
  if (!outcome.ok) return { refused: outcome.reason };
  return {
    relayTaskId: outcome.relayTaskId,
    ...(outcome.dispatchToken != null ? { dispatchToken: outcome.dispatchToken } : {}),
  };
}

/** Extract the human-readable result text from a receipt — what Claude needs to see. */
function receiptResultText(receipt: SignedReceipt): string {
  const r = receipt.result;
  if (typeof r === "string") return r;
  return JSON.stringify(r ?? null);
}

/** The joined text of a response's text blocks. */
function responseText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * #479 + #504: the loop treats ANY tool-free response as the finished
 * report, but a synthesis response can legally be empty (an end_turn with
 * zero text blocks, a max_tokens cut — witnessed live: citations delivered,
 * findings blank, receipt signed "completed") or notes-shaped ("mid-work
 * notes plus source snippets", witnessed live 2026-07-30 on a paid hire).
 *
 * Both get ONE tool-free re-synthesis with the deficiency named. Then the
 * remedies diverge on what honesty demands: a still-EMPTY body throws (the
 * molecule signs a failed receipt, never a completed-empty one), while a
 * still-thin body is DELIVERED best-effort with the issues logged — a paid,
 * non-empty artifact belongs to the buyer; shape quality is the archetype's
 * earned record, graded by the conformance probe against the same
 * `reportShapeIssues` contract.
 */
async function ensureReport(params: {
  client: Anthropic;
  messages: Anthropic.MessageParam[];
  lastContent: Anthropic.ContentBlock[];
  report: string;
  citations: Citation[];
  addUsage: (r: Anthropic.Message) => void;
}): Promise<string> {
  // "Sources read" follows the POST-filter citation rule the conformance
  // probe grades on: web citations are receipt-anchored acts and always
  // count; interior recalls count only when the report cites them
  // (speculative uncited recalls are context, not sources). Recomputed per
  // candidate text because the retry may cite differently.
  const sourcesReadFor = (text: string): boolean =>
    filterInteriorCitations(params.citations, text).length > 0;
  const issues = reportShapeIssues(params.report, { sourcesRead: sourcesReadFor(params.report) });
  if (issues.length === 0) return params.report;

  const wasEmpty = issues[0]!.code === "empty";
  const deficiency = wasEmpty
    ? "Your previous reply contained no report text."
    : `Your previous reply is not a finished report (${issues.map((i) => i.detail).join("; ")}).`;

  /**
   * The re-synthesis instruction.
   *
   * The original named the format as a parenthetical aside — "(Question /
   * Findings with inline [N] citations / Sources)" — which a model can read as
   * prose guidance rather than a literal requirement. Measured over the
   * scheduled conformance history (8 runs that reached the shape check, 2 red),
   * the failing mode was always the same: a readable 1600-char answer with no
   * `Findings` heading and no `Sources` list, where the retry ran and did not
   * add them. `hasSection` matches literal headings, so the instruction now
   * SHOWS the headings instead of describing them.
   *
   * `strict` is the escalation used only after a retry produced no improvement
   * at all — the observed dead end, where the previous code simply gave up.
   */
  const instruction = (strict: boolean): string =>
    `${deficiency} Write the complete report NOW from the sources you already gathered. ` +
    `Do not call any tools.${strict ? " This is your final attempt — output the report and nothing else." : ""}\n\n` +
    `Your reply MUST contain these literal section headings, in this order:\n\n` +
    `## Question\n<restate the question in one line>\n\n` +
    `## Findings\n<the substantive answer, with inline [N] citations>\n\n` +
    `## Sources\n[1] <title> — <url>\n`;

  const retry = await params.client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      ...params.messages,
      // Echo the deficient response only when it had content blocks — an
      // empty assistant content array is not a valid turn on the wire.
      ...(params.lastContent.length > 0
        ? [{ role: "assistant" as const, content: params.lastContent }]
        : []),
      {
        role: "user" as const,
        content: instruction(false),
      },
    ],
  });
  params.addUsage(retry);
  const retried = responseText(retry.content);

  if (retried.trim() === "") {
    if (wasEmpty) {
      throw new Error(
        `research synthesis returned an empty report body (${params.citations.length} source(s) gathered) — refusing to complete an empty artifact`,
      );
    }
    // Retry regressed to empty — the original thin-but-real text is still
    // the better artifact for the buyer.
    console.log(
      `[research] report shape: retry came back empty, delivering original with issues [${issues.map((i) => i.code).join(",")}]`,
    );
    return params.report;
  }

  const retriedIssues = reportShapeIssues(retried, { sourcesRead: sourcesReadFor(retried) });
  if (retriedIssues.length >= issues.length && !wasEmpty) {
    // The observed dead end: the retry came back readable but still shapeless.
    // Previously this gave up here. One more attempt, with the strict framing —
    // bounded at two, and only on this branch, so the improved-but-imperfect
    // and regressed-to-empty paths are untouched.
    console.log(
      `[research] report shape: retry did not improve (${retriedIssues.map((i) => i.code).join(",")} vs ${issues.map((i) => i.code).join(",")}), escalating to a final strict attempt`,
    );
    const final = await params.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        ...params.messages,
        { role: "assistant" as const, content: params.lastContent },
        { role: "user" as const, content: instruction(true) },
      ],
    });
    params.addUsage(final);
    // NOTE on the assistant turn above: no `lastContent.length > 0` guard is
    // needed here (unlike the first retry). Empty content yields empty text,
    // which sets `wasEmpty`, and this escalation only runs when `!wasEmpty` —
    // so `lastContent` is non-empty by construction on this path. Guarding it
    // anyway would be an unreachable branch, which the 100% coverage floor
    // correctly refuses to accept as untested.
    const finalText = responseText(final.content);
    if (finalText.trim() === "") {
      console.log(`[research] report shape: strict attempt came back empty, delivering original`);
      return params.report;
    }
    const finalIssues = reportShapeIssues(finalText, { sourcesRead: sourcesReadFor(finalText) });
    if (finalIssues.length < issues.length) {
      if (finalIssues.length > 0) {
        console.log(
          `[research] report shape: delivering strict attempt with residual issues [${finalIssues.map((i) => i.code).join(",")}]`,
        );
      }
      return finalText;
    }
    console.log(
      `[research] report shape: strict attempt did not improve either (${finalIssues.map((i) => i.code).join(",")}), delivering original`,
    );
    return params.report;
  }
  if (retriedIssues.length > 0) {
    console.log(
      `[research] report shape: delivering retry with residual issues [${retriedIssues.map((i) => i.code).join(",")}]`,
    );
  }
  return retried;
}

// === The research turn ===

/**
 * Run one research turn — Claude orchestrates motebit atom calls until it has
 * enough to synthesize, then returns a final report. Receipts captured from
 * each atom call are accumulated into `delegation_receipts`; the chain is
 * re-derivable offline with `@motebit/crypto`.
 */
export async function research(question: string, config: ResearchConfig): Promise<ResearchResult> {
  const client = getClient(config.anthropicApiKey);
  const factory = config.adapterFactory ?? defaultAdapterFactory;

  // Construct + connect the atom adapters once per research turn. The adapters
  // own the MCP session; we own the receipt accumulation.
  const webSearch = factory({ name: "web-search", url: config.webSearchUrl, config });
  const readUrl = factory({ name: "read-url", url: config.readUrlUrl, config });
  await Promise.all([webSearch.connect(), readUrl.connect()]);

  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
    const delegationReceipts: SignedReceipt[] = [];
    const subSettlements: SubHopSettlement[] = [];
    const routingTranscripts: Record<string, unknown>[] = [];
    const citations: Citation[] = [];
    let recallSelfCount = 0;
    // claude-sonnet-4-6 list pricing (helpers.ts, shared with the budget's
    // LLM reserve); estimate only — logged per report so the operator can tune
    // MOTEBIT_UNIT_COST. The loop's repeated prefix makes cache reads dominate
    // from iteration 2 on.
    const USD_PER_M_INPUT = SONNET_MICRO_PER_MTOK.input / 1e6;
    const USD_PER_M_OUTPUT = SONNET_MICRO_PER_MTOK.output / 1e6;
    const USD_PER_M_CACHE_WRITE = SONNET_MICRO_PER_MTOK.cacheWrite / 1e6;
    const USD_PER_M_CACHE_READ = SONNET_MICRO_PER_MTOK.cacheRead / 1e6;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    const addUsage = (u: Anthropic.Message["usage"] | undefined): void => {
      inputTokens += u?.input_tokens ?? 0;
      outputTokens += u?.output_tokens ?? 0;
      cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
      cacheReadTokens += u?.cache_read_input_tokens ?? 0;
    };
    const costUsd = (): number =>
      (inputTokens * USD_PER_M_INPUT +
        outputTokens * USD_PER_M_OUTPUT +
        cacheWriteTokens * USD_PER_M_CACHE_WRITE +
        cacheReadTokens * USD_PER_M_CACHE_READ) /
      1e6;
    let searchCount = 0;
    let fetchCount = 0;
    let toolCallCount = 0;
    // Integer micro-units — the money path carries no floating point.
    // Defence in depth: a non-finite or negative budget is ZERO paid hops,
    // never "no ceiling" (`spent + q > NaN` is false — it would pay every hop).
    const rawBudget = config.paidSpendBudgetMicro;
    const budgetMicro =
      rawBudget == null
        ? null
        : Number.isFinite(rawBudget)
          ? Math.max(0, Math.floor(rawBudget))
          : 0;
    // Charged reserve-before-pay against the task's ledger (shared by every
    // run of one admitted task); `paidSpentMicro` is THIS run's share, for the
    // result's observability field only.
    const taskSpend = config.paidSpendLedger ?? memoryTaskSpend();
    let paidSpentMicro = 0;
    /** Committed spend of the TASK (every run): settled + outstanding holds. */
    const committedMicro = (): number => {
      try {
        return taskSpend.committedMicro();
      } catch {
        return budgetMicro ?? paidSpentMicro;
      }
    };
    /** Replace a hold with what left the wallet. Never throws past the hop. */
    const settleHop = (hold: TaskSpendHold | null, chargeMicro: number): void => {
      if (Number.isFinite(chargeMicro) && chargeMicro > 0) paidSpentMicro += chargeMicro;
      if (hold == null && !(chargeMicro > 0)) return;
      try {
        taskSpend.settle(hold?.holdId ?? null, chargeMicro);
      } catch (err: unknown) {
        // The hold (if it was written) stays charged in full — conservative.
        console.log(
          `[research] spend ledger settle FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    /**
     * Dispatch one Claude tool_use. Interior tier (recall_self) runs locally
     * and emits an interior-source Citation with no receipt. Web tier calls
     * dispatch through the atom MCP adapter, capture signed receipts, and
     * emit a web-source Citation bound to the receipt's task_id — the
     * verifier's anchor for "this motebit actually read this URL."
     */
    const dispatchToolUse = async (
      tu: Anthropic.ToolUseBlock,
    ): Promise<Anthropic.ToolResultBlockParam> => {
      // The runaway-cost cap is checked PER CALL, not only per model turn: one
      // response may carry many tool_uses, and each must still fit the cap.
      // Every tool_use gets a tool_result (the API requires the pairing).
      if (toolCallCount >= config.maxToolCalls) {
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `${tu.name} was not performed: this report's tool-call limit (${config.maxToolCalls}) is reached. Write the report from what you already gathered.`,
        };
      }
      // ── Interior tier — synchronous, no network, no receipt. ─────────
      if (tu.name === "motebit_recall_self") {
        const query = (tu.input as { query?: string }).query ?? "";
        const limit = (tu.input as { limit?: number }).limit ?? 3;
        const hits = querySelfKnowledge(query, { limit });
        recallSelfCount++;
        toolCallCount++;

        if (hits.length === 0) {
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `No interior knowledge matched "${query}". Consider motebit_web_search if the question extends beyond Motebit itself.`,
          };
        }

        // One Citation per chunk actually returned. Locator mirrors the
        // chunk id used in the committed corpus, so a downstream verifier
        // can rehydrate the exact text against `@motebit/self-knowledge`.
        for (const hit of hits) {
          citations.push({
            text_excerpt: hit.content,
            source: "interior",
            locator: `${hit.source}#${hit.title}`,
          });
        }

        const formatted = hits
          .map(
            (h, i) =>
              `${i + 1}. [${h.source} · ${h.title} · score=${h.score.toFixed(2)}]\n${h.content}`,
          )
          .join("\n\n---\n\n");

        return { type: "tool_result", tool_use_id: tu.id, content: formatted };
      }

      // ── Web tier — goes through the atom MCP adapter. ────────────────
      let adapter: AtomAdapter;
      let qualified: string;
      let prompt: string;
      let capabilityHint: string;
      let targetId: string | undefined;

      if (tu.name === "motebit_web_search") {
        adapter = webSearch;
        qualified = "web-search__motebit_task";
        prompt = (tu.input as { query?: string }).query ?? "";
        capabilityHint = "web_search";
        targetId = config.webSearchTargetId;
      } else if (tu.name === "motebit_read_url") {
        adapter = readUrl;
        qualified = "read-url__motebit_task";
        prompt = (tu.input as { url?: string }).url ?? "";
        capabilityHint = "read_url";
        targetId = config.readUrlTargetId;
      } else {
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `unknown tool: ${tu.name}`,
          is_error: true,
        };
      }

      // Every web tool dispatch counts against the runaway-cost cap, success or
      // failure, on either the paid or the free path.
      toolCallCount++;

      // Inc 2b: a PRICED atom is paid P2P (this molecule pays the atom onchain
      // from its own wallet under its self-grant — the relay coordinates the hop
      // and earns its fee); a free/unpriced atom uses the direct MCP call.
      // `paidSubDelegate` is absent unless the money seam is wired, so this is
      // dormant (today's direct path) until the atoms are priced.
      let receipt: SignedReceipt | undefined;
      // Observability — the sub-hop path is otherwise invisible from outside;
      // log which lane fires (paid P2P vs free direct MCP) and, on fallback,
      // the exact not-payable code. Same "make the silent decision loud"
      // discipline as the relay's mcp-forward logging.
      // Per-task budget: quote the hop from the target's own listing BEFORE
      // paying it. A not-payable quote goes straight to the free lane; a hop
      // that would cross the budget is not made — the model is told to
      // synthesize from what it has (fail-soft, never a failed report).
      let quotedMicro: number | null = null;
      // The reservation for this hop: everything left of the TASK's budget,
      // held atomically before the live call and settled to what actually
      // moved after it. A concurrent run of the same task sees it as spent.
      let hold: TaskSpendHold | null = null;
      let quotedWorkerId: string | undefined;
      let quoteTranscript: Record<string, unknown> | undefined;
      let payable = config.paidSubDelegate != null;
      if (config.paidSubDelegate != null && budgetMicro != null) {
        const quote = await config.paidSubDelegate({
          capability: capabilityHint,
          prompt,
          ...(targetId != null ? { targetWorkerId: targetId } : {}),
          dryRun: true,
        });
        if (!quote.ok) {
          if (!NOT_PAYABLE_CODES.has(quote.code ?? "")) {
            console.log(
              `[research] sub-hop: quote REFUSED cap=${capabilityHint} code=${quote.code ?? "unknown"}`,
            );
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              content: `paid delegation to ${tu.name} refused (${quote.code ?? "unknown"})`,
              is_error: true,
            };
          }
          console.log(
            `[research] sub-hop: fallback DIRECT cap=${capabilityHint} code=${quote.code}`,
          );
          payable = false;
        } else {
          quotedMicro = outflowMicro(quote.settlement);
          quotedWorkerId = quote.workerMotebitId;
          quoteTranscript = quote.routingTranscript;
          if (quotedMicro != null) {
            try {
              hold = taskSpend.reserve(budgetMicro, quotedMicro);
            } catch (err: unknown) {
              // An unreadable ledger reserves nothing (fail closed).
              console.log(
                `[research] spend ledger reserve FAILED: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (hold == null) {
            const spentNow = committedMicro();
            if (spentNow === 0 && quotedMicro != null) {
              console.log(
                `[research] paid-spend budget ${budgetMicro} < one paid call (${quotedMicro}) cap=${capabilityHint} — running with zero paid calls; raise the listing price or lower the margin/reserve`,
              );
            }
            console.log(
              `[research] sub-hop: BUDGET SKIP cap=${capabilityHint} spent=${spentNow} quote=${quotedMicro ?? "unpriced"} budget=${budgetMicro}`,
            );
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              content: `${tu.name} was not performed: this report's paid-call budget is exhausted (spent ${spentNow} of ${budgetMicro} micro-USD; next call quoted ${quotedMicro ?? "unpriced"}). Do not call ${tu.name} again — write the report from what you already gathered (free tools such as motebit_recall_self remain available).`,
            };
          }
        }
      }

      if (config.paidSubDelegate != null && payable) {
        // Attempt paid P2P for any PRICED capability — pinned to `targetId` when
        // one is configured, otherwise UNPINNED so the runtime's first-person
        // ranker chooses among the discovered providers (the market). A
        // not-payable code still falls through to direct MCP below.
        console.log(
          `[research] sub-hop: attempting P2P cap=${capabilityHint}${targetId ? ` target=${targetId}` : " (ranked)"}`,
        );
        // The live call pays the worker the quote priced (pinned), under a hard
        // ceiling of the RESERVED remainder of the task's budget that the
        // runtime enforces before it signs — so a re-ranked worker or a
        // repriced listing can never pay past the budget; it refuses
        // `budget_exceeded` with no money moved.
        const liveTarget = targetId ?? quotedWorkerId;
        const remainingMicro = hold?.heldMicro ?? null;
        let paid: PaidSubDelegateResult;
        try {
          paid = await config.paidSubDelegate({
            capability: capabilityHint,
            prompt,
            ...(liveTarget != null ? { targetWorkerId: liveTarget } : {}),
            ...(remainingMicro != null ? { maxTotalMicro: remainingMicro } : {}),
          });
        } catch (err: unknown) {
          // Unknown whether money moved: the hold is charged in full.
          settleHop(hold, hold?.heldMicro ?? 0);
          throw err;
        }
        // Settle the reservation to what LEFT the wallet — once, on every
        // path: a paid hop at its settlement fact (or its quote), extra
        // transactions at the same per-transaction amount (#885); a failed hop
        // at what it moved anyway; a hop refused before money moved at zero
        // (the hold is released for the next hop / the next run).
        const chargeMicro = paid.ok
          ? (outflowMicro(paid.settlement) ?? quotedMicro ?? 0) *
            (1 + (paid.settlement?.extraPayments?.length ?? 0))
          : failedHopOutflowMicro(paid, quotedMicro ?? remainingMicro ?? 0);
        settleHop(hold, chargeMicro);
        if (!paid.ok) {
          // Money that left on a FAILED hop (paid, then timeout / agent_failed /
          // unconfirmed) is still spent — charged above.
          const moved = chargeMicro;
          if (moved > 0) {
            console.log(
              `[research] sub-hop: paid-then-FAILED cap=${capabilityHint} code=${paid.code ?? "unknown"} moved=${moved} spent=${committedMicro()}${budgetMicro != null ? `/${budgetMicro}` : ""}`,
            );
            // Bought but not delivered: never re-do it for free, never re-hire.
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              content: `paid delegation to ${tu.name} was paid but did not deliver (${paid.code ?? "unknown"})`,
              is_error: true,
            };
          }
        }
        if (!paid.ok && paid.code === "budget_exceeded") {
          // The runtime refused before signing: the resolved price exceeded
          // the remaining budget (the market moved since the quote).
          console.log(
            `[research] sub-hop: BUDGET REFUSED pre-sign cap=${capabilityHint} spent=${committedMicro()} remaining=${remainingMicro ?? "unbudgeted"}`,
          );
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `${tu.name} was not performed: its price exceeds what remains of this report's paid-call budget. Do not call ${tu.name} again — write the report from what you already gathered.`,
          };
        }
        if (paid.ok) {
          if (paid.receipt == null) {
            console.log(`[research] sub-hop: paid ok but NO receipt cap=${capabilityHint}`);
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              content: `paid delegation to ${tu.name} returned no receipt`,
              is_error: true,
            };
          }
          // Charged above at its settlement fact (a live result with no fact at
          // its quote; 0 only on the unbudgeted, unquoted path).
          console.log(
            `[research] sub-hop: PAID P2P cap=${capabilityHint} spent=${committedMicro()}${budgetMicro != null ? `/${budgetMicro}` : ""}`,
          );
          receipt = paid.receipt;
          delegationReceipts.push(receipt);
          // Self-attest the money fact: stamp the hop's settlement (mode + onchain
          // tx) into the molecule's receipt so "I paid my atom P2P" is verifiable
          // from signed bytes, never inferred from the receipt's mere presence
          // (the free path below also pushes a receipt). Absent settlement ⇒ omit;
          // the assertion is presence-of-p2p, so a missing fact never fabricates one.
          // Pinned to the quote's worker, the hire's routing decision is the
          // QUOTE's ranked selection — its transcript is the one to attest.
          const transcript = paid.routingTranscript ?? quoteTranscript;
          if (transcript != null) {
            routingTranscripts.push(transcript);
          }
          if (paid.settlement != null) {
            const atomTaskId = (receipt as { task_id?: unknown }).task_id;
            subSettlements.push({
              capability: capabilityHint,
              ...(typeof atomTaskId === "string" ? { task_id: atomTaskId } : {}),
              mode: paid.settlement.mode,
              ...(paid.settlement.txHash != null ? { tx_hash: paid.settlement.txHash } : {}),
              ...(paid.settlement.paidMicro != null
                ? { paid_micro: paid.settlement.paidMicro }
                : {}),
              ...(paid.settlement.feeMicro != null ? { fee_micro: paid.settlement.feeMicro } : {}),
            });
          }
        } else if (!NOT_PAYABLE_CODES.has(paid.code ?? "")) {
          // A real payment failure (ceiling/grant/auth) — never silently do the
          // work for free; surface the closed code to the loop.
          console.log(
            `[research] sub-hop: paid FAILED cap=${capabilityHint} code=${paid.code ?? "unknown"}`,
          );
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `paid delegation to ${tu.name} refused (${paid.code ?? "unknown"})`,
            is_error: true,
          };
        } else {
          // Not P2P-payable (unpriced atom / no route) → fall through to direct
          // MCP. `paid.code` is guaranteed a not-payable code here (it passed
          // NOT_PAYABLE_CODES.has above).
          console.log(
            `[research] sub-hop: fallback DIRECT cap=${capabilityHint} code=${paid.code}`,
          );
        }
      } else if (config.paidSubDelegate == null) {
        // No paid seam (money env unset) → free direct MCP.
        console.log(`[research] sub-hop: DIRECT (no paid seam) cap=${capabilityHint}`);
      }

      if (receipt == null) {
        const binding = await bindRelayBudget(config, prompt, capabilityHint, targetId);
        if (binding != null && "refused" in binding) {
          // Fail honestly: a relay-bound hop the relay would not admit is not
          // done for free. (The paid lane above is the way to buy a priced
          // atom; this is the free lane being told no.)
          console.log(
            `[research] sub-hop: relay REFUSED cap=${capabilityHint} target=${targetId} — ${binding.refused}`,
          );
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `delegation to ${tu.name} was not admitted by the relay (${binding.refused})`,
            is_error: true,
          };
        }
        const args: Record<string, unknown> = { prompt };
        if (binding != null) {
          args.relay_task_id = binding.relayTaskId;
          if (binding.dispatchToken != null) args.dispatch_token = binding.dispatchToken;
        }

        const result = await adapter.executeTool(qualified, args);
        // The receipt rides on THIS call's result (#943): a concurrent call
        // on the same adapter can never take it, and order is dispatch order.
        const fresh = result.delegation_receipt != null ? [result.delegation_receipt] : [];
        delegationReceipts.push(...fresh);

        if (!result.ok || fresh.length === 0) {
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `delegation to ${tu.name} failed for "${prompt.slice(0, 80)}"`,
            is_error: true,
          };
        }
        receipt = fresh[fresh.length - 1]!;
      }

      if (tu.name === "motebit_web_search") searchCount++;
      else fetchCount++;

      // The receipt is the cryptographic edge; its `result` is what Claude reads.
      const resultText = receiptResultText(receipt);

      // Only read_url hits become citations — bare search results are
      // lookup scaffolding, not source content. The Citation's
      // receipt_task_id binds the claim "this URL was actually fetched"
      // to the signed atom receipt in delegation_receipts.
      if (tu.name === "motebit_read_url") {
        citations.push({
          text_excerpt: resultText,
          source: "web",
          locator: prompt,
          receipt_task_id: receipt.task_id,
          // Re-verifiable evidence provenance — present when the read_url atom
          // attested the raw source. `resultText` is the span; `source_digest`
          // content-addresses the RAW fetched bytes. Two paths, both re-checkable by a
          // third party who re-fetches `locator` (verifyEvidenceProvenance, no shared
          // code): RAW-BYTE (text/*) — projection absent, span located over the raw
          // bytes directly; RECIPE (HTML) — `source_projection` names the published
          // byte-deterministic recipe (`agency.html-text.v1`) a re-verifier applies to
          // the raw bytes before locating the span. ABSENT for reformatted JSON until a
          // JSON recipe lands — back-compat by absence, never a claim the producer
          // can't back. `binding` is omitted: motebit resolves no issuer identity for
          // arbitrary URLs (domain-blind).
          ...(receipt.source_digest != null
            ? {
                provenance: {
                  digest: receipt.source_digest,
                  span: resultText,
                  ...(receipt.source_projection != null
                    ? { projection: receipt.source_projection }
                    : {}),
                },
              }
            : {}),
        });
      }

      return { type: "tool_result", tool_use_id: tu.id, content: resultText };
    };

    // Multi-turn loop: keep dispatching tool calls until Claude returns
    // text-only or we hit the runaway-cost cap. Interior calls count
    // against the same budget as web calls — recall_self is cheap but
    // not free of runaway-loop risk.
    while (toolCallCount < config.maxToolCalls) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: CACHED_SYSTEM,
        tools: CACHED_TOOLS,
        messages: withPrefixCacheBreakpoint(messages),
      });

      // Optional-chained: unit-test mocks omit usage; the live API always sends it.
      addUsage(response.usage);

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        const report = await ensureReport({
          client,
          messages,
          lastContent: response.content,
          report: responseText(response.content),
          citations,
          addUsage: (r) => addUsage(r.usage),
        });
        return {
          report,
          cost_estimate_usd: costUsd(),
          delegation_receipts: delegationReceipts,
          sub_settlements: subSettlements,
          routing_transcripts: routingTranscripts,
          citations: filterInteriorCitations(citations, report),
          recall_self_count: recallSelfCount,
          search_count: searchCount,
          fetch_count: fetchCount,
          paid_spend_micro: paidSpentMicro,
          paid_budget_micro: budgetMicro,
        };
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        toolResults.push(await dispatchToolUse(tu));
      }
      messages.push({ role: "user", content: toolResults });
    }

    // Hit the cap before Claude finished — force a final synthesis without further tools.
    const finalResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      // The cached system block stays byte-identical (prefix hit); the
      // budget-exhausted note rides as a second, uncached block.
      system: [
        ...CACHED_SYSTEM,
        {
          type: "text",
          text: "Note: tool budget exhausted. Synthesize a report from what you've already gathered.",
        },
      ],
      messages: withPrefixCacheBreakpoint(messages),
    });
    addUsage(finalResponse.usage);
    const report = await ensureReport({
      client,
      messages,
      lastContent: finalResponse.content,
      report: responseText(finalResponse.content),
      citations,
      addUsage: (r) => addUsage(r.usage),
    });

    return {
      report,
      cost_estimate_usd: costUsd(),
      delegation_receipts: delegationReceipts,
      sub_settlements: subSettlements,
      routing_transcripts: routingTranscripts,
      citations: filterInteriorCitations(citations, report),
      recall_self_count: recallSelfCount,
      search_count: searchCount,
      fetch_count: fetchCount,
      paid_spend_micro: paidSpentMicro,
      paid_budget_micro: budgetMicro,
    };
  } finally {
    // Always release the atom MCP sessions
    await Promise.allSettled([webSearch.disconnect(), readUrl.disconnect()]);
  }
}
