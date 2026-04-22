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
}

function initialState(): WorkstationState {
  return {
    history: [],
    lastReceiptAt: null,
    receiptCount: 0,
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
      history: nextHistory,
      lastReceiptAt: receipt.completed_at,
      receiptCount: state.receiptCount + 1,
    });
  }

  const unsubscribe = adapter.subscribeToolInvocations(onReceipt);

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
    emit({ history: [], lastReceiptAt: null, receiptCount: 0 });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe();
    } catch {
      // Best-effort — an adapter's unsubscribe fault must not leak.
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
