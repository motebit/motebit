// Surface-agnostic state controller for the Workstation panel.
//
// The Workstation panel renders the motebit's live work: each tool call it
// makes, a running history of signed per-call receipts, and (once the user
// supplies a browser pane) the current page it's reading. Ring-1 fallback
// is a plain text list of tool calls — the substrate is identical on web,
// desktop, and mobile.
//
// The unique layer versus market agents (ChatGPT's agent mode, the Cowork
// surface): every tool call surfaces with a cryptographic receipt. A
// verifier with only the motebit's public key can prove the call ran with
// the claimed args and returned the claimed result bytes — no relay lookup
// required. Controller state is the accumulator; receipts are the bytes.
//
// The adapter inverts the dependency on @motebit/runtime so this package
// stays at Layer 5 without promoting. The host surface wires
// `runtime.config.onToolInvocation` into `adapter.subscribeToolInvocations`
// — see packages/runtime/src/streaming.ts.

// ── Minimal shape (no @motebit/crypto import) ─────────────────────────
//
// Matches @motebit/crypto `SignableToolInvocationReceipt` structurally.
// Duplicated rather than imported so the panel package stays at Layer 5
// without pulling crypto into its deps — same rationale as the memory
// controller's inline `MemoryNode`. A third-party verifier converts the
// receipt to the full @motebit/crypto shape by matching field-for-field;
// the duplicate-but-structural approach is checked at the host
// (adapter.subscribeToolInvocations is typed against the real receipt).

export interface ToolInvocationReceiptLike {
  invocation_id: string;
  task_id: string;
  motebit_id: string;
  public_key?: string;
  device_id: string;
  tool_name: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  args_hash: string;
  result_hash: string;
  invocation_origin?: "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Activity event — the raw args/result bytes the workstation's browser
 * pane consumes to render *what the motebit is doing right now*.
 * Matches the runtime's `ToolActivityEvent`; duplicated here for the
 * same Layer-5 self-contained reason as `ToolInvocationReceiptLike`.
 *
 * Unlike the signed receipt, activity is ephemeral — consumers must
 * not retain the payload (args/result may contain sensitive content
 * that's deliberately not part of the audit trail).
 */
export interface ToolActivityEvent {
  invocation_id: string;
  task_id: string | undefined;
  tool_name: string;
  args: Record<string, unknown>;
  result: unknown;
  started_at: number;
  completed_at: number;
}

// ── Adapter ──────────────────────────────────────────────────────────

/**
 * Each surface implements this so the controller can receive the runtime's
 * signed tool-invocation receipts without importing @motebit/runtime.
 *
 * `subscribeToolInvocations` returns an unsubscribe thunk. The host wires
 * this to the runtime's `onToolInvocation` hook at construction time.
 * Calling `dispose()` on the controller releases the subscription.
 */
export interface WorkstationFetchAdapter {
  /**
   * Subscribe to signed tool-invocation receipts emitted by the runtime.
   * The listener fires once per matched tool_status calling→done pair,
   * after the receipt has been signed. Returns an unsubscribe thunk.
   */
  subscribeToolInvocations(listener: (receipt: ToolInvocationReceiptLike) => void): () => void;
  /**
   * Subscribe to the ephemeral activity stream — the raw args/result
   * the receipt's hashes commit to, delivered at the same moment as
   * the receipt. Optional: Ring-1 surfaces that render only the audit
   * trail can leave this undefined and the controller's `currentPage`
   * simply stays null.
   */
  subscribeToolActivity?(listener: (event: ToolActivityEvent) => void): () => void;
}

// ── Configuration ────────────────────────────────────────────────────

export interface WorkstationControllerOptions {
  /**
   * Maximum number of completed tool calls to retain in `state.history`.
   * Beyond this, the oldest entries are dropped (FIFO). Defaults to 100 —
   * enough to show a session's worth of activity without unbounded memory
   * growth.
   */
  maxHistory?: number;
}

// ── State ────────────────────────────────────────────────────────────

/**
 * Page the motebit is currently "looking at" — populated from
 * `read_url` activity events, and superseded as the motebit reads
 * new sources. Null when the motebit hasn't read a page yet in this
 * session, or when the most recent tool call wasn't a page fetch.
 *
 * `content` is the raw result the tool returned (typically HTML
 * text or reader-mode markdown); the host surface decides how to
 * render it (iframe srcdoc, sandboxed view, reader template).
 * Ephemeral — rotates forward on every new `read_url` call.
 */
export interface WorkstationCurrentPage {
  url: string;
  content: string;
  fetchedAt: number;
  invocation_id: string;
}

export interface WorkstationState {
  /**
   * Completed tool calls in arrival order (oldest first). Each entry is
   * the full signed receipt — the host renders a human-readable row from
   * the fields and can pass the receipt to a verifier if the user asks to
   * check the signature.
   */
  history: ToolInvocationReceiptLike[];
  /**
   * Unix ms when the most recent receipt arrived. Null when the
   * controller has observed no receipts yet. The host uses this to drive
   * an "active now / idle" indicator; the controller itself does not
   * infer active/idle — the signal is purely the receipt stream.
   */
  lastReceiptAt: number | null;
  /**
   * Monotonic counter of receipts observed since the controller was
   * created, including any dropped by `maxHistory` trimming. Hosts can
   * compare successive values to detect "something new arrived" without
   * deep-equal-checking `history`.
   */
  receiptCount: number;
  /**
   * Current page the motebit is focused on — updated when a `read_url`
   * (or equivalent) activity event arrives. Null before the first
   * page-fetch of the session. The workstation's browser pane reads
   * from this; Ring-1 text surfaces ignore it without issue.
   */
  currentPage: WorkstationCurrentPage | null;
}

function initialState(): WorkstationState {
  return {
    history: [],
    lastReceiptAt: null,
    receiptCount: 0,
    currentPage: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface WorkstationController {
  getState(): WorkstationState;
  subscribe(listener: (state: WorkstationState) => void): () => void;
  /**
   * Drop the history without disposing the subscription. Useful when the
   * user starts a "fresh session" — the receipt stream continues flowing
   * from the runtime; the panel just resets its view. `lastReceiptAt` and
   * `receiptCount` also reset.
   */
  clearHistory(): void;
  /**
   * Unsubscribe from the runtime and drop all listeners. After dispose(),
   * incoming receipts are ignored and the state is frozen.
   */
  dispose(): void;
}

const DEFAULT_MAX_HISTORY = 100;

export function createWorkstationController(
  adapter: WorkstationFetchAdapter,
  options: WorkstationControllerOptions = {},
): WorkstationController {
  const maxHistory = Math.max(1, Math.floor(options.maxHistory ?? DEFAULT_MAX_HISTORY));
  let state = initialState();
  const listeners = new Set<(state: WorkstationState) => void>();
  let disposed = false;

  function emit(next: WorkstationState): void {
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // Listener faults are isolated — the controller's state must
        // not depend on a subscriber's handler completing cleanly. The
        // host surface is free to log at its own layer; the controller
        // is not the place for console noise.
      }
    }
  }

  function onReceipt(receipt: ToolInvocationReceiptLike): void {
    if (disposed) return;
    const trimmed =
      state.history.length >= maxHistory
        ? state.history.slice(state.history.length - maxHistory + 1)
        : state.history;
    const nextHistory = [...trimmed, receipt];
    emit({
      ...state,
      history: nextHistory,
      lastReceiptAt: receipt.completed_at,
      receiptCount: state.receiptCount + 1,
    });
  }

  /**
   * Tool-name set recognized as "page fetches" — their args MUST
   * carry a `url` string and their result is the page content. Extend
   * this list when new page-fetching tools land (e.g. `fetch_archive`,
   * `read_pdf`). Activity events for tools outside the set don't
   * touch `currentPage`; they just populate the audit log via the
   * receipt channel.
   */
  const PAGE_FETCH_TOOLS = new Set(["read_url", "virtual_browser", "browse_page"]);

  function onActivity(event: ToolActivityEvent): void {
    if (disposed) return;
    if (!PAGE_FETCH_TOOLS.has(event.tool_name)) return;
    const url = event.args["url"];
    if (typeof url !== "string" || url.length === 0) return;
    const content =
      typeof event.result === "string"
        ? event.result
        : event.result === undefined || event.result === null
          ? ""
          : JSON.stringify(event.result);
    emit({
      ...state,
      currentPage: {
        url,
        content,
        fetchedAt: event.completed_at,
        invocation_id: event.invocation_id,
      },
    });
  }

  const unsubscribeReceipts = adapter.subscribeToolInvocations(onReceipt);
  const unsubscribeActivity = adapter.subscribeToolActivity?.(onActivity) ?? (() => {});

  function getState(): WorkstationState {
    return state;
  }

  function subscribe(listener: (state: WorkstationState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function clearHistory(): void {
    if (disposed) return;
    // `currentPage` is intentionally preserved — a user clearing the
    // audit log while actively reading a page shouldn't blank the
    // browser pane. The next page-fetch supersedes it normally.
    emit({
      ...state,
      history: [],
      lastReceiptAt: null,
      receiptCount: 0,
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const unsub of [unsubscribeReceipts, unsubscribeActivity]) {
      try {
        unsub();
      } catch {
        // Best-effort — an adapter's unsubscribe fault must not leak.
      }
    }
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    clearHistory,
    dispose,
  };
}
