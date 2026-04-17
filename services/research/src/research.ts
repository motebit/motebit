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
import type { Citation, ExecutionReceipt } from "@motebit/sdk";
import { querySelfKnowledge } from "@motebit/self-knowledge";

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

Be direct. No filler. Match depth to the question. If nothing you looked up answers the question, say so — do not fabricate.`;

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
  /** Signed receipts from every delegated call, in execution order. The verifiable citation chain. */
  delegation_receipts: SignedReceipt[];
  /**
   * One citation per tool call that produced source content (interior recall
   * or URL fetch; bare web_search hits are not cited — only content actually
   * read is). Citation.source discriminates interior (self-attested, no
   * receipt) from web (receipt-bound via receipt_task_id). Aligns 1:1 with
   * the outer `CitedAnswer.citations` surface built by the service.
   */
  citations: Citation[];
  /** Number of motebit_recall_self calls (interior tier). */
  recall_self_count: number;
  /** Number of motebit_web_search calls. */
  search_count: number;
  /** Number of motebit_read_url calls. */
  fetch_count: number;
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
  apiToken?: string;
  webSearchTargetId?: string;
  readUrlTargetId?: string;
  /**
   * Test seam: factory for the mcp-client adapter. Defaults to constructing a
   * real `McpClientAdapter`. Tests inject a stub that returns canned receipts
   * without spinning up a real MCP server.
   */
  adapterFactory?: AdapterFactory;
}

/** Minimal interface the research turn needs from an mcp-client adapter. */
export interface AtomAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  getAndResetDelegationReceipts(): SignedReceipt[];
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

// === Optional relay budget binding ===

/**
 * When relay credentials + a target motebit ID are configured, open a relay
 * task for budget allocation. Returns the relay-issued task_id (forwarded to
 * the atom as `relay_task_id` so the atom binds its receipt to the same
 * economic contract). Best-effort: any failure yields undefined and the
 * delegation proceeds without binding.
 */
async function bindRelayBudget(
  config: ResearchConfig,
  prompt: string,
  capabilityHint: string,
  targetMotebitId: string | undefined,
): Promise<string | undefined> {
  if (config.syncUrl == null || config.apiToken == null || targetMotebitId == null)
    return undefined;
  try {
    const resp = await fetch(`${config.syncUrl}/agent/${targetMotebitId}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        prompt,
        submitted_by: config.callerMotebitId,
        required_capabilities: [capabilityHint],
      }),
    });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as { task_id?: string };
    return body.task_id;
  } catch {
    return undefined;
  }
}

/** Extract the human-readable result text from a receipt — what Claude needs to see. */
function receiptResultText(receipt: SignedReceipt): string {
  const r = receipt.result;
  if (typeof r === "string") return r;
  return JSON.stringify(r ?? null);
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
    const citations: Citation[] = [];
    let recallSelfCount = 0;
    let searchCount = 0;
    let fetchCount = 0;
    let toolCallCount = 0;

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

      const relayTaskId = await bindRelayBudget(config, prompt, capabilityHint, targetId);
      const args: Record<string, unknown> = { prompt };
      if (relayTaskId != null) args.relay_task_id = relayTaskId;

      const result = await adapter.executeTool(qualified, args);
      // McpClientAdapter captures any motebit-shaped receipt during executeTool.
      // Drain immediately so receipt order matches the dispatch order.
      const fresh = adapter.getAndResetDelegationReceipts();
      delegationReceipts.push(...fresh);
      toolCallCount++;

      if (!result.ok || fresh.length === 0) {
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `delegation to ${tu.name} failed for "${prompt.slice(0, 80)}"`,
          is_error: true,
        };
      }

      if (tu.name === "motebit_web_search") searchCount++;
      else fetchCount++;

      // The receipt is the cryptographic edge; its `result` is what Claude reads.
      const receipt = fresh[fresh.length - 1]!;
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
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        const report = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return {
          report,
          delegation_receipts: delegationReceipts,
          citations,
          recall_self_count: recallSelfCount,
          search_count: searchCount,
          fetch_count: fetchCount,
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
      system:
        SYSTEM_PROMPT +
        "\n\nNote: tool budget exhausted. Synthesize a report from what you've already gathered.",
      messages,
    });
    const report = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return {
      report,
      delegation_receipts: delegationReceipts,
      citations,
      recall_self_count: recallSelfCount,
      search_count: searchCount,
      fetch_count: fetchCount,
    };
  } finally {
    // Always release the atom MCP sessions
    await Promise.allSettled([webSearch.disconnect(), readUrl.disconnect()]);
  }
}
