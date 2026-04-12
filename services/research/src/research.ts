/**
 * Research agent — synthesizing molecule with cryptographic citation chain.
 *
 * Takes a research question. Runs a multi-turn Claude tool-use loop with two
 * tools: `motebit_web_search` (delegates to motebit's web-search/) and
 * `motebit_read_url` (delegates to motebit's read-url/). Each delegation
 * goes through `@motebit/mcp-client`'s `McpClientAdapter` — the existing
 * protocol primitive that handles signed bearer token minting, the MCP
 * StreamableHTTP handshake, and **automatic capture of signed
 * ExecutionReceipts** from `motebit_task` responses.
 *
 * The captured receipts are accumulated into `delegation_receipts` on the
 * research turn's top-level receipt, forming a verifiable provenance graph.
 *
 * **Citations are receipts, not strings.** The chain is re-derivable offline
 * with `@motebit/crypto` alone — no relay dependency. This is the protocol
 * claim cloud-monolith research products (Perplexity Deep Research, etc.)
 * cannot make: their citations are URLs printed next to text, "trust me I
 * read this." Motebit's are signed receipts in a chain.
 *
 * **Architectural note:** The receipt-chain primitive lives in `mcp-client`
 * (see `_delegationReceipts` + `getAndResetDelegationReceipts` on
 * `McpClientAdapter`). The doctrine that "the citation IS the receipt" is
 * enforced for ANY motebit-to-motebit delegation, not just research. Future
 * molecules (fact-checkers, deep-summarizers, multi-step research) compose
 * the same primitive — they should not reinvent the transport.
 *
 * Full doctrine: the citation IS the receipt — not a label next to one. Any
 * synthesizing molecule that cites sources must return signed receipts
 * chained through `delegation_receipts`, verifiable offline with
 * `@motebit/crypto` and the atoms' public keys. Never emit citation strings
 * without receipts; never emit hashes-of-URLs without proof of fetch.
 */

import Anthropic from "@anthropic-ai/sdk";
import { McpClientAdapter } from "@motebit/mcp-client";
import type { ExecutionReceipt } from "@motebit/sdk";

const SYSTEM_PROMPT = `You are a research analyst. Given a question, your job is to investigate it thoroughly using the available tools and produce a clear, well-structured report.

You have two tools:
- motebit_web_search: searches the web. Returns a list of results (title, url, snippet).
- motebit_read_url: fetches and extracts the readable content of a URL. Use this to get the substance of a result, not just the snippet.

Standard pattern: search, identify the most promising 2-4 URLs, read them, then synthesize. Don't read every result — pick what matters.

For each report:

1. **Question** — restate the question in one line.
2. **Findings** — the substantive answer. Cite sources inline as [1], [2], etc. Be specific: numbers, dates, names, direct quotes when relevant.
3. **Open questions** — what you couldn't answer. Skip if there are none.
4. **Sources** — numbered list of URLs you actually read (via motebit_read_url), in order of citation. Each line: \`[N] Title — URL\`.

Be direct. No filler. Match depth to the question.`;

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
    let searchCount = 0;
    let fetchCount = 0;

    /**
     * Dispatch one Claude tool_use to its atom, capture receipt(s), and
     * produce the tool_result block to feed back to Claude.
     */
    const dispatchToolUse = async (
      tu: Anthropic.ToolUseBlock,
    ): Promise<Anthropic.ToolResultBlockParam> => {
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
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: receiptResultText(receipt),
      };
    };

    // Multi-turn loop: keep dispatching tool calls until Claude returns
    // text-only or we hit the runaway-cost cap.
    while (delegationReceipts.length < config.maxToolCalls) {
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
      search_count: searchCount,
      fetch_count: fetchCount,
    };
  } finally {
    // Always release the atom MCP sessions
    await Promise.allSettled([webSearch.disconnect(), readUrl.disconnect()]);
  }
}
