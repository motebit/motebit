/**
 * Delegated PR review — fetches the patch via the `read-url` atom and
 * produces a review with a signed delegation chain.
 *
 * code-review is a molecule: it does not itself reach GitHub. Every fetch
 * flows through another motebit (read-url), which returns a signed
 * `ExecutionReceipt`. Those receipts accumulate into the outer review
 * receipt's `delegation_receipts`, giving callers a verifiable chain
 * `caller → code-review → read-url` they can check with
 * `@motebit/crypto.verifyReceiptChain` — no trust in this service required.
 *
 * The receipt-capture primitive lives in `@motebit/mcp-client`
 * (`McpClientAdapter.getAndResetDelegationReceipts`); it applies to any
 * motebit-to-motebit delegation, not a code-review concern.
 */

import { McpClientAdapter } from "@motebit/mcp-client";
import { openRelaySubTask } from "@motebit/molecule-runner";
import type { TokenAudience } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { PullRequestInfo } from "./github.js";
import { reviewPullRequest } from "./review.js";

/** What the review turn needs from an mcp-client adapter — stub seam for tests. */
export interface AtomAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  getAndResetDelegationReceipts(): ExecutionReceipt[];
}

export type AdapterFactory = (atom: {
  name: string;
  url: string;
  config: ReviewConfig;
}) => AtomAdapter;

export interface ReviewConfig {
  anthropicApiKey: string;
  /** URL of the motebit read-url MCP server (e.g. http://localhost:3500/mcp). */
  readUrlUrl: string;
  /** Caller (this code-review service) identity for signing the bearer tokens. */
  callerMotebitId: string;
  callerDeviceId: string;
  callerPrivateKey: Uint8Array;
  /** Optional: relay sync URL for budget-binding sub-delegations. */
  syncUrl?: string;
  readUrlTargetId?: string;
  /** Mints this service's own `task:submit` bearer for the relay binding. */
  mintRelayToken?: (audience?: TokenAudience) => Promise<string>;
  /** Test seam / observability for the binding decision. */
  log?: (msg: string) => void;
  /**
   * Test seam: factory for the mcp-client adapter. Defaults to constructing
   * a real `McpClientAdapter`. Tests inject a stub that returns canned
   * receipts without spinning up a real MCP server.
   */
  adapterFactory?: AdapterFactory;
}

export interface ReviewResult {
  /** Markdown review text from Claude. */
  review: string;
  /** The parsed PR info used to drive the review (from the .patch). */
  pr: PullRequestInfo;
  /** Signed receipts from every delegated call, in execution order. */
  delegation_receipts: ExecutionReceipt[];
}

/** Default factory: real McpClientAdapter wired with this service's identity. */
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

// === .patch parsing ===========================================================
// GitHub serves `<pr>.patch` as an mbox-format file: one or more commits with
// `From:`, `Subject:`, `Date:` headers followed by a unified diff. For a
// multi-commit PR these blocks are concatenated. We pull Subject/Author from
// the first block (representative of the PR) and use everything from the first
// `diff --git` onward as the review material.

const MAX_DIFF_BYTES = 80_000;

/**
 * Parse a GitHub `.patch` into a PullRequestInfo. Numeric stats
 * (changed_files, additions, deletions) and base/head branches aren't
 * present in the patch format — they're left blank. The review quality
 * comes from the diff itself; the header fields exist for display only.
 */
export function parsePatch(patch: string): PullRequestInfo {
  const subjectMatch = patch.match(/^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+)$/m);
  // Author: "From: Name <email>" — pull out the name part when present.
  const fromMatch = patch.match(/^From:\s*([^<\r\n]+?)\s*(?:<[^>]+>)?\s*$/m);
  const diffIdx = patch.indexOf("\ndiff --git ");

  let diff = diffIdx >= 0 ? patch.slice(diffIdx + 1) : patch;
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[... diff truncated ...]";
  }

  // Derive numeric stats from the diff body — the .patch format doesn't carry
  // GitHub's aggregated stats, so we count them ourselves rather than show
  // zeroes in the review header.
  const fileMarker = /^diff --git /gm;
  const changed_files = (diff.match(fileMarker) ?? []).length;
  const additions = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
  const deletions = (diff.match(/^-(?!--)/gm) ?? []).length;

  return {
    title: subjectMatch?.[1]?.trim() ?? "(untitled PR)",
    body: "",
    author: fromMatch?.[1]?.trim() ?? "unknown",
    base: "",
    head: "",
    changed_files,
    additions,
    deletions,
    diff,
  };
}

// === The review turn =========================================================

/**
 * Run one review turn: delegate fetch to read-url, parse the patch, ask
 * Claude to review the diff. Every delegation receipt is captured into
 * the returned chain; the outer receipt (built by the caller via
 * buildServiceReceipt) embeds the chain in its delegation_receipts field.
 */
export async function reviewPrViaMotebit(
  prUrl: string,
  config: ReviewConfig,
): Promise<ReviewResult> {
  const factory = config.adapterFactory ?? defaultAdapterFactory;
  const readUrl = factory({ name: "read-url", url: config.readUrlUrl, config });
  await readUrl.connect();

  try {
    const delegationReceipts: ExecutionReceipt[] = [];

    // Fetch the patch (mbox format with author/subject headers + diff).
    const patchUrl = prUrl.replace(/\/?$/, "") + ".patch";
    const readArgs: Record<string, unknown> = { prompt: patchUrl };
    const log = config.log ?? ((m: string) => console.log(`[code-review] ${m}`));
    if (config.syncUrl != null && config.readUrlTargetId != null && config.mintRelayToken != null) {
      // Bind the hop through the relay as the ONE presenter (`presenter:
      // "submitter"`): the relay admits, does not route, returns the
      // dispatch_token that read-url's admission verifies.
      const mint = config.mintRelayToken;
      const bound = await openRelaySubTask({
        syncUrl: config.syncUrl,
        mintToken: (aud) => mint(aud),
        callerMotebitId: config.callerMotebitId,
        targetMotebitId: config.readUrlTargetId,
        prompt: patchUrl,
        capability: "read_url",
      });
      if (bound.ok) {
        readArgs.relay_task_id = bound.relayTaskId;
        if (bound.dispatchToken != null) readArgs.dispatch_token = bound.dispatchToken;
      } else if (bound.code === "TASK_P2P_PROOF_REQUIRED") {
        // NAMED BLOCKER (docs/doctrine/task-admission.md § trigger): read-url
        // is priced and this service has no payer seam yet, so the relay will
        // not admit the hop unpaid. While read-url's admission is OPEN the
        // direct call still succeeds; once it enforces, this fallback is
        // refused at the atom and the review fails there, honestly. Loud on
        // every occurrence so the gap stays visible until code-review pays.
        log(
          `read-url hop NOT admitted (unpaid priced atom — code-review has no payer seam yet); ` +
            `calling read-url directly while its admission is open: ${bound.reason}`,
        );
      } else {
        throw new Error(`read-url hop was not admitted by the relay: ${bound.reason}`);
      }
    }
    const readResult = await readUrl.executeTool("read-url__motebit_task", readArgs);
    const fresh = readUrl.getAndResetDelegationReceipts();
    delegationReceipts.push(...fresh);

    if (!readResult.ok || fresh.length === 0) {
      throw new Error(
        `Delegated fetch of ${patchUrl} returned no receipt${
          readResult.error ? `: ${readResult.error}` : ""
        }`,
      );
    }

    // The receipt's `result` is the read-url handler's `data` string —
    // the .patch text. read-url returns the receipt via motebit_task; we
    // take the last fresh receipt as the immediate delegation.
    const receipt = fresh[fresh.length - 1]!;
    const patchText = typeof receipt.result === "string" ? receipt.result : "";
    if (!patchText) {
      throw new Error(`read-url receipt had no patch text for ${patchUrl}`);
    }
    if (patchText.startsWith("HTTP 404") || patchText.startsWith("HTTP 401")) {
      throw new Error(
        `GitHub returned ${patchText.split(":")[0]} for ${patchUrl} — private repos are not yet supported by the showcase flow`,
      );
    }

    const pr = parsePatch(patchText);
    const review = await reviewPullRequest(pr, config.anthropicApiKey);

    return { review, pr, delegation_receipts: delegationReceipts };
  } finally {
    await readUrl.disconnect().catch(() => {});
  }
}
