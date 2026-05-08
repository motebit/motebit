/**
 * `request_control` — motebit's affordance for asking the user to
 * hand over drive control of the isolated browser (`virtual_browser`
 * embodiment). The companion remediation to Slice 1's
 * `not_in_control` gate: when `computer` denies dispatch because
 * motebit doesn't hold control, this is the typed capability the AI
 * calls to ring the slab's doorbell (Slice 2b's
 * `handoff_pending` band).
 *
 * Doctrine — `docs/doctrine/motebit-computer.md` §"Embodiment modes"
 * (co-browse as substate of `virtual_browser`) +
 * `architecture_cobrowse_belongs_in_virtual_browser` (memory). The
 * tool is registered only on surfaces that carry a
 * `CoBrowseControlMachine` (web's cloud-browser path); the
 * `desktop_drive` embodiment has no co-browse analog.
 *
 * Surface support: web only. Desktop's `registerComputerTool` does
 * NOT expose this tool — there's no machine to drive on the
 * desktop_drive embodiment, and adding it there would advertise an
 * affordance the AI can't actually use. Same defense-in-depth
 * principle as `computer`'s "MUST NOT include in the tool list at
 * all" rule for sandboxed surfaces.
 *
 * Wire shape: the tool waits (with timeout) for the user's verdict,
 * resolving with one of `granted` / `denied` / `timeout` /
 * `already_in_control` / `request_pending` / `session_paused`. The
 * AI gets a structured answer in one tool call rather than polling
 * the gate. This mirrors the existing approval-flow pattern: the
 * tool blocks until the user acts, just keyed on the slab band's
 * Grant/Deny rather than the chat-log's approval card.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/**
 * Outcome of a `request_control` invocation. Closed string-literal
 * union — the AI's reasoning loop discriminates on `kind` to decide
 * the next move (granted → retry `computer`; denied / timeout → ask
 * the user out-of-band; already_in_control → bug, retry `computer`
 * directly). Mirrors the closed-set discipline of
 * `CoBrowseTransitionKind` in `@motebit/protocol`.
 */
export type RequestControlOutcome =
  /** User granted the request. State is now `{kind: "motebit"}`. */
  | { readonly kind: "granted" }
  /** User denied. State reverted to `{kind: "user"}`; the request was lost. */
  | { readonly kind: "denied" }
  /**
   * Timed out waiting for the user. The tool issued a fail-closed
   * disconnect on the way out so the machine reverts to user; the AI
   * SHOULD NOT retry immediately — better to surface the situation
   * to the user via chat.
   */
  | { readonly kind: "timeout" }
  /** Motebit already held control when the tool was called. No-op. */
  | { readonly kind: "already_in_control" }
  /**
   * A request was already pending when the tool was called. The AI
   * SHOULD wait — the existing pending request has its own resolution
   * path (the user clicking Grant/Deny on the band).
   */
  | { readonly kind: "request_pending" }
  /**
   * Session is paused. Resume must happen first. The AI SHOULD ask
   * the user to resume rather than auto-issuing a resume — pause is
   * a user-floor primitive (`/halt` ↔ co-browse pause), and the
   * motebit unilaterally undoing a halt would defeat its purpose.
   */
  | { readonly kind: "session_paused" };

/**
 * Surface-supplied async flow that does the actual work: read state,
 * fire `requestControl("motebit")`, await the verdict via the
 * machine's `subscribe` fan-out (Slice 2b). The `request_control`
 * tool definition is wire-shape-only; the per-surface flow lives
 * with the `CoBrowseControlMachine` instance (apps/web).
 */
export type RequestControlFlow = () => Promise<RequestControlOutcome>;

/** @spec motebit/computer-use@1.0 */
export const requestControlDefinition: ToolDefinition = {
  name: "request_control",
  mode: "api",
  description:
    "Ask the user to grant motebit drive control of the isolated browser. Call this when `computer` failed with reason `not_in_control` — it rings the slab's control band so the user can Grant or Deny. Resolves with one of: `granted` (retry `computer` now), `denied` (ask the user out-of-band), `timeout` (no response), `already_in_control` (you already have it — retry `computer` directly), `request_pending` (an earlier request is still awaiting the user), `session_paused` (ask the user to resume first).",
  // Slice 2f — `request_control` is **state chrome**, not a body act.
  // Its visible representation is the slab control band (the doorbell
  // with Grant/Deny). Without this flag, the runtime opens a generic
  // `tool_call` slab item showing "REQUEST_CONTROL / calling…" — a
  // duplicate, empty-looking card that competes with the band and
  // obscures its buttons. Marking it `"none"` keeps the slab clean
  // and makes the band the canonical surface for this transition.
  // Doctrine: motebit-computer.md — slab content (browser, peer
  // viewport, memory artifact, tool result, desktop surface) vs.
  // slab chrome (control band, address bar, halt indicator). Tools
  // that author chrome MUST NOT also project as content.
  slabProjection: "none",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "Optional cloud-browser session id. Omit to target the runtime's default session for this motebit (v1 supports one session per motebit).",
      },
    },
    // No required fields — `session_id` is optional. Schema stays
    // permissive so the AI can call this with a bare `{}` and get
    // sensible defaults.
  },
};

export interface RequestControlHandlerOptions {
  /**
   * The surface-supplied flow. Required: without it, the handler
   * can't reach the machine. The factory shape mirrors
   * `createComputerHandler({ dispatcher })` — the wire is here, the
   * platform-specific work is injected.
   */
  flow: RequestControlFlow;
}

/**
 * Build the `request_control` tool handler. Wraps the surface flow
 * in the `ToolResult` envelope the AI loop expects: `{ok: true,
 * data}` carries the structured `RequestControlOutcome`; `{ok:
 * false, error}` is reserved for true execution failures (the flow
 * threw — never the verdict, which is always a structured outcome).
 *
 * Why every legal verdict is `ok: true` with a structured `data`
 * shape, not `ok: false` for `denied` / `timeout`: the AI's
 * reasoning loop is far better at branching on a typed `kind` field
 * than at parsing free-form error strings. The tool succeeded — it
 * asked the user and got an answer; the answer's shape is what the
 * AI dispatches on.
 */
export function createRequestControlHandler(opts: RequestControlHandlerOptions): ToolHandler {
  const flow = opts.flow;
  return async () => {
    try {
      const outcome = await flow();
      return { ok: true, data: outcome };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `request_control: ${msg}` };
    }
  };
}
