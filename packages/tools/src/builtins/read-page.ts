/**
 * `read_page` — the first ax-tier tool. Reads the open browser
 * session's DOM-derived structured text (page title, body innerText,
 * heading hierarchy, visible links). Returns the *text* the user is
 * already viewing — no pixel transmission, no screenshots.
 *
 * Doctrine — `CLAUDE.md` Principle 96 (Hybrid engine, structural
 * preference) + `packages/protocol/src/tool-mode.ts`:
 *
 *   ```
 *   api    →  KB round-trip, structured. (web_search, read_url, …)
 *   ax     →  DOM/AX-tree text. Structured but lossy.       ← THIS
 *   pixels →  Screen capture + synthetic input. (computer.)
 *   ```
 *
 * The registry sorts by tier (`api → ax → pixels → undeclared`); the
 * AI defaults to the cheapest structured tool that can answer. Until
 * Slice 2h no tool declared `mode: "ax"` — so on a live browser
 * session the AI's only choice was a pixel screenshot (~30k tokens,
 * crosses the whole-screen privacy surface). `read_page` fills that
 * tier so "what's on the page" lands as a few KB of structured text
 * instead.
 *
 * Why this isn't a `computer` action variant: `computer.mode === "pixels"`
 * is a fact about the tool's cost tier, not the action. A single
 * `ToolDefinition` carries one `mode`. To put a structured-text
 * action under `computer` we'd have to either drop the pixels mode
 * (lose the structural sort signal) or invent a per-action mode (a
 * different drift to manage). Sibling tool is the honest shape:
 * one tool per cost tier, registry sort decides.
 *
 * Surface scope: cloud-browser only (`virtual_browser` embodiment).
 * The desktop surface's `desktop_drive` embodiment doesn't yet have
 * an AX adapter; when it does (macOS AXUIElement, Windows UIA, etc.)
 * a sibling registration there picks up the same tool name with
 * a different dispatcher.
 *
 * Privacy: page text crosses to the AI like `read_url` /
 * `web_search` results do. Marked `outbound: true` so the runtime's
 * sensitivity gate composes — medical/financial/secret sessions
 * with an external provider block the call before any text leaves
 * the device. Same fail-closed contract; no new surface.
 */

import type { ToolDefinition, ToolHandler, ReadPageResult } from "@motebit/sdk";

/**
 * Surface-supplied dispatcher. Mirrors `ComputerDispatcher` in shape
 * but for the structured-read path. The web surface's
 * `registerWebComputerTool` wires this to
 * `CloudBrowserDispatcher.readPage()`. Surfaces without an open
 * browser session (or without an AX adapter) MUST NOT register the
 * tool at all — same defense-in-depth as `computer`'s
 * not-supported-on-this-surface rule.
 */
export interface ReadPageDispatcher {
  readPage(): Promise<ReadPageResult>;
}

export interface ReadPageHandlerOptions {
  /**
   * Required: without a dispatcher the handler returns `not_supported`
   * on every call. Sandboxed surfaces (no browser session) should
   * not register the tool at all rather than register with a null
   * dispatcher — registering an unusable tool advertises an
   * affordance the AI will try and fail at.
   */
  dispatcher?: ReadPageDispatcher;
}

/** @spec motebit/computer-use@1.0 */
export const readPageDefinition: ToolDefinition = {
  name: "read_page",
  // Slice 2h — FIRST tool in the ax tier. Registry sorts ax (1)
  // above pixels (2), so when the AI is choosing how to observe an
  // open page, this lands ahead of `computer({kind:"screenshot"})`.
  // The structural bias is the load-bearing privacy + cost signal.
  mode: "ax",
  // Page text crosses to the external AI provider on every call.
  // The sensitivity gate fail-closes for medical/financial/secret
  // sessions with non-sovereign providers; same contract as
  // read_url / web_search.
  outbound: true,
  description:
    'Read the structured text content of the open browser session — page title, body text, heading hierarchy, visible links. No screenshots, no pixels. Use this when you need to know what\'s on the page (read article content, find a specific element, summarize what motebit just navigated to). Cheaper and more accurate than a screenshot for text-heavy queries; the screenshot path (`computer({kind:"screenshot"})`) remains available when visual context is genuinely required.',
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "Optional cloud-browser session id. Omit to target the runtime's default session for this motebit (v1 supports one session per motebit).",
      },
    },
    // No required fields — `session_id` is optional.
  },
  // Stamped at registration site so the slab projection picks
  // virtual_browser (motebit's eye on the cloud Chromium) without
  // forcing surface-aware code into tool-policy.ts. Same shape as
  // `computer`'s per-dispatcher mode stamping.
  embodimentMode: "virtual_browser",
  // `read_page` is AI-side perception, not a body act — the user
  // already sees the page they're sharing with motebit (live
  // browser frames in the slab body). Opening a `tool_call` slab
  // item with a "READING" header would render duplicate chrome on
  // top of the very surface being read, with an empty card body
  // (the result is text the AI consumes, not an artifact the user
  // needs presented). Same shape as `request_control` — its
  // canonical surface is the doorbell band, not a body card.
  // Doctrine: motebit-computer.md §"slab content (browser, peer
  // viewport, memory artifact, tool result, desktop surface) vs.
  // slab chrome (control band, address bar, halt indicator)."
  // Tools that read what's already on screen are perception, not
  // act — projection: "none".
  slabProjection: "none",
};

/**
 * Build the `read_page` tool handler. Surfaces that cannot reach a
 * browser session MUST NOT register this tool — the `dispatcher`-
 * less path returns `not_supported` as a safety floor in case of
 * misconfiguration, but it should not be reached in practice.
 */
export function createReadPageHandler(opts?: ReadPageHandlerOptions): ToolHandler {
  const dispatcher = opts?.dispatcher;

  return async () => {
    if (!dispatcher) {
      return {
        ok: false,
        error:
          "read_page is not supported on this surface — requires an open browser session (cloud-browser dispatcher).",
      };
    }
    try {
      const data = await dispatcher.readPage();
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Propagate structured `reason` from typed errors (e.g.
      // ComputerDispatcherError) — same pattern as `computer`'s
      // handler. Downstream slab projection routes on reason, not
      // on parsed text.
      const r =
        err !== null &&
        typeof err === "object" &&
        typeof (err as { reason?: unknown }).reason === "string"
          ? (err as { reason: string }).reason
          : undefined;
      return r
        ? { ok: false, error: `read_page: ${msg}`, reason: r }
        : { ok: false, error: `read_page: ${msg}` };
    }
  };
}
