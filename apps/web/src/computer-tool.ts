/**
 * Web wiring for the `computer` tool — the second surface (after
 * desktop) to expose computer-use to the AI loop.
 *
 * Composition mirrors `apps/desktop/src/computer-tool.ts`:
 *
 *   - `@motebit/runtime`'s `createComputerSessionManager` — owns
 *     session lifecycle + governance + failure-reason normalization.
 *     Same primitive as desktop.
 *   - `CloudBrowserDispatcher` (the slice-1 dispatcher in
 *     `@motebit/runtime`) — talks HTTP to `services/browser-sandbox`.
 *     Replaces desktop's Tauri Rust bridge; everything else is
 *     identical.
 *   - `@motebit/tools`'s `computerDefinition` — same AI-visible tool
 *     schema. The AI sees one tool whose execution surface is
 *     `desktop_drive` on desktop and `virtual_browser` on web.
 *
 * The tool is registered ONLY when a cloud-browser endpoint is
 * configured (`config.baseUrl` non-empty). When unconfigured the
 * computer tool is absent from the AI's tool list — defense in
 * depth, matches the spec §8 "surfaces without OS access return
 * not_supported" but for an explicit-not-configured path rather
 * than implicit not-supported.
 *
 * Session lifecycle (mirrors desktop):
 *   - Opened lazily on the first `computer` tool call.
 *   - Reused for every subsequent call within the motebit's lifetime.
 *   - Closed when `dispose()` is invoked (app teardown). Cloud
 *     dispatcher's `dispose` tears down the Chromium context
 *     server-side.
 */

import {
  CloudBrowserDispatcher,
  createComputerSessionManager,
  createCoBrowseControlMachine,
  type CoBrowseControlMachine,
  type ComputerApprovalFlow,
  type ComputerGovernanceClassifier,
  type ComputerPlatformDispatcher,
  type ComputerSessionHandle,
  type ComputerSessionManager,
} from "@motebit/runtime";
import { createDefaultComputerGovernance } from "@motebit/policy-invariants";
import {
  computerDefinition,
  createComputerHandler,
  type ComputerDispatcher,
  type ToolRegistry,
} from "@motebit/tools/web-safe";
import type {
  CoBrowseControlChangedPayload,
  ComputerAction,
  ComputerSessionClosed,
  ComputerSessionOpened,
  ComputerSessionReceipt,
  EventStoreAdapter,
} from "@motebit/sdk";
import { EventType } from "@motebit/sdk";

export interface ComputerToolRegistration {
  /** The session manager; caller may use it for lifecycle events. */
  readonly sessionManager: ComputerSessionManager;
  /**
   * Co-browse Slice 2a — the control state machine the session
   * manager is gating on. Slab UI (Slice 2b) reads `getState()` to
   * render the control band on the membrane and drives the
   * `requestControl` / `grantControl` / `denyControl` /
   * `reclaimControl` / `releaseControl` / `pause` / `resume`
   * transitions from gestures and slash commands. The runtime
   * already wires `onTransition` to the audit log; consumers don't
   * re-wire it.
   */
  readonly coBrowseControl: CoBrowseControlMachine;
  /** Teardown — closes the default session and disposes the cloud browser. */
  dispose: () => Promise<void>;
}

export interface RegisterWebComputerToolOptions {
  /**
   * Base URL of the `services/browser-sandbox` HTTP API. When falsy
   * the tool registration is skipped and the AI never sees a `computer`
   * tool — explicit-not-configured beats silent-not-supported.
   */
  readonly baseUrl: string;
  /**
   * Returns the bearer token the cloud-browser service accepts.
   * Called once per dispatcher request; async so the relay's token
   * lifecycle (rotation, refresh) is honored without re-instantiating
   * the dispatcher.
   */
  readonly getAuthToken: () => Promise<string> | string;
  /** Motebit id for session identity binding. */
  readonly motebitId: string;
  /** Optional override for tests. Defaults to a real `CloudBrowserDispatcher`. */
  readonly dispatcher?: ComputerPlatformDispatcher;
  /**
   * Optional governance classifier. When omitted, web uses
   * `createDefaultComputerGovernance()` from `@motebit/policy-invariants`
   * — fail-closed irreversibility + sensitivity enforcement (slice 1
   * heuristics for Submit / Buy / Pay / File / I agree / etc.).
   */
  readonly governance?: ComputerGovernanceClassifier;
  /**
   * Approval flow invoked when governance returns `require_approval`.
   * Web binds this via `createWebComputerApprovalFlow()` (chat-log
   * render host). Without it, every require_approval surfaces to the
   * AI as `approval_required` failure (the fail-closed door is there,
   * but no doorbell).
   */
  readonly approvalFlow?: ComputerApprovalFlow;
  /**
   * Optional event sink. When provided, `ComputerSessionOpened` +
   * `ComputerSessionClosed` events land in the signed event log so
   * verifiers replaying the audit trail can reconstruct the
   * session_id → observation-action binding.
   */
  readonly events?: EventStoreAdapter;
  /**
   * v1.5 — sign a session-summary receipt body. Wired by the app to
   * `runtime.signComputerSessionReceiptBody`. When supplied, the
   * registration emits a `ComputerSessionSummarized` audit event
   * after each `closeSession` returns. Without it, lifecycle events
   * still fire but no signed receipt lands. Optional precisely
   * because the runtime may not have a signing key yet (test paths,
   * pre-bootstrap).
   */
  readonly signSessionReceipt?: (
    body: import("@motebit/sdk").SignableComputerSessionReceipt,
  ) => Promise<ComputerSessionReceipt | null>;
  /**
   * v1.5 — hash the per-action structural roll-up. Wired to
   * `runtime.hashComputerSessionActions`. When supplied alongside
   * `signSessionReceipt`, the receipt's `actions_hash` commits to
   * the per-action ledger; without it, signing falls back to a
   * digest of the empty array.
   */
  readonly hashSessionActions?: (
    actions: ReadonlyArray<import("@motebit/sdk").ComputerSessionActionRecord>,
  ) => Promise<string>;
  /**
   * v1.5 — fired after a session-summary receipt is signed and
   * emitted to the audit log. Apps wire this to `addArtifact` +
   * `buildComputerSessionReceiptArtifact` so the receipt emerges
   * in the scene as a verifiable artifact the user can hand to a
   * third party. Same calm-software pattern as
   * `buildReceiptArtifact` for delegation/execution chains.
   *
   * Fail-soft: a callback that throws must not break the close
   * path. The signed receipt is already on the audit log by the
   * time this fires; the artifact emergence is a UX layer.
   */
  readonly onSessionReceiptSigned?: (receipt: ComputerSessionReceipt) => void;
  /**
   * v1.3 — when supplied, the registration opens a CDP screencast on
   * the cloud-browser dispatcher right after session-open and pipes
   * frames into the bus. The slab item kind `live_browser` (mounted
   * by `onSessionLive`) subscribes through the bus and renders a
   * continuous JPEG stream. Without this hook, sessions still work
   * — they just fall back to per-action screenshots.
   */
  readonly screencastBus?: import("./screencast-bus.js").ScreencastFrameBus;
  /**
   * v1.3 — fired right after `screencastBus` starts publishing so the
   * surface (apps/web/src/web-app.ts) can mount the
   * `live_browser` slab item. The companion `onSessionEnding` clears
   * it on close. Decoupled callback because the slab controller lives
   * on the runtime, not in this registration scope.
   */
  readonly onSessionLive?: (cloudSessionId: string) => void;
  /**
   * v1.3 — fired right before the cloud session closes (or on
   * dispose), so the surface can dissolve the live slab item before
   * the bus stops publishing. Order matters: dissolve first, then
   * stop publishing, otherwise the slab item could re-mount and
   * subscribe to a frozen bus.
   */
  readonly onSessionEnding?: (cloudSessionId: string) => void;
}

/**
 * Register the `computer` tool on the web surface. Returns a
 * registration handle whose `dispose` tears down the cloud browser
 * session at app shutdown.
 *
 * Returns `null` when `baseUrl` is empty — caller's signal that the
 * tool is not registered. The web app's tool-list reflects this:
 * if cloud-browser is unconfigured, the AI doesn't advertise
 * `computer` and never tries to call it.
 */
export function registerWebComputerTool(
  registry: ToolRegistry,
  opts: RegisterWebComputerToolOptions,
): ComputerToolRegistration | null {
  if (!opts.baseUrl || opts.baseUrl.length === 0) {
    return null;
  }

  const dispatcher =
    opts.dispatcher ??
    new CloudBrowserDispatcher({
      baseUrl: opts.baseUrl,
      getAuthToken: opts.getAuthToken,
    });

  // Co-browse Slice 2a — construct the control machine BEFORE
  // anything that could call `disconnect()` on it. The transport-
  // failure handlers (openScreencast.onError, closeAndEmit teardown)
  // reference this binding by closure; constructing here ensures the
  // reference is always valid by the time those handlers can fire.
  // V1: one cloud session per registration, so one machine per
  // registration. When concurrent cloud sessions become a real
  // consumer need, this lifts to a Map<sessionId, machine>; the per-
  // session shape stays.
  //
  // The audit emitter wires `onTransition` directly into the runtime
  // event log (when supplied). Each transition lands as one signed
  // `CoBrowseControlChanged` event, exactly the substrate Slice 2b
  // (UI affordances) and Slice 2c (wire forwarding) read off.
  // Slice 1 + Slice 2a together: gate exists AND fires in production
  // for the first time.
  const coBrowseControl: CoBrowseControlMachine = createCoBrowseControlMachine({
    sessionId: "cs_pending", // placeholder; rebound below if v1.5+ multi-session lifts this
    motebitId: opts.motebitId,
    onTransition: (payload: CoBrowseControlChangedPayload) => {
      void emitControlEvent(payload);
    },
  });

  const sessionManager = createComputerSessionManager({
    dispatcher,
    governance: opts.governance ?? createDefaultComputerGovernance(),
    approvalFlow: opts.approvalFlow,
    coBrowseControl,
  });

  /**
   * Best-effort audit append for `co_browse_control_changed` events.
   * Same fail-soft shape as `emit()` below — an event-sink fault must
   * not block the state-machine transition itself (which has already
   * committed by the time `onTransition` fires).
   */
  async function emitControlEvent(payload: CoBrowseControlChangedPayload): Promise<void> {
    if (!opts.events) return;
    try {
      const entry = {
        event_id: crypto.randomUUID(),
        motebit_id: opts.motebitId,
        timestamp: payload.timestamp,
        event_type: EventType.CoBrowseControlChanged,
        payload: payload as unknown as Record<string, unknown>,
        tombstoned: false,
      };
      if (opts.events.appendWithClock) {
        await opts.events.appendWithClock(entry);
      } else {
        await opts.events.append({ ...entry, version_clock: 0 });
      }
    } catch {
      // Audit-log fault must not break the AI loop or the gate.
    }
  }

  let defaultSession: ComputerSessionHandle | null = null;
  let openingDefault: Promise<ComputerSessionHandle> | null = null;
  /**
   * v1.3 — disposer for the active CDP screencast. `null` outside an
   * open session or when no screencast is wired (e.g. tests that
   * don't supply a `screencastBus`). Cleared on session close so the
   * next session can re-open a fresh stream.
   */
  let stopScreencast: (() => Promise<void>) | null = null;

  /**
   * Best-effort event-log append. An event sink that throws must not
   * break session open/close. Same isolation as desktop.
   */
  async function emit(
    eventType: EventType,
    payload: ComputerSessionOpened | ComputerSessionClosed | ComputerSessionReceipt,
  ): Promise<void> {
    if (!opts.events) return;
    try {
      const entry = {
        event_id: crypto.randomUUID(),
        motebit_id: opts.motebitId,
        timestamp: Date.now(),
        event_type: eventType,
        payload: payload as unknown as Record<string, unknown>,
        tombstoned: false,
      };
      if (opts.events.appendWithClock) {
        await opts.events.appendWithClock(entry);
      } else {
        await opts.events.append({ ...entry, version_clock: 0 });
      }
    } catch {
      // Event sink faults are non-fatal — the AI loop must keep working.
    }
  }

  /**
   * v1.5 — close the session, emit `ComputerSessionClosed`, and (when
   * a signing path is wired) also emit `ComputerSessionSummarized`
   * with the signed `ComputerSessionReceipt`. Centralized so every
   * close path goes through the same audit emission. Best-effort
   * isolation: a signing failure must not prevent the close-event
   * append, and an event-sink failure must not prevent the close
   * itself.
   */
  async function closeAndEmit(sessionId: string, reason: string): Promise<void> {
    // v1.3 — tear down the screencast BEFORE the session closes so
    // the slab can dissolve its live_browser item against a known
    // sessionId, and so the bus stops publishing before the
    // dispatcher's session is gone. Order: surface dissolves, then
    // bus stops, then session closes.
    opts.onSessionEnding?.(sessionId);
    if (stopScreencast) {
      try {
        await stopScreencast();
      } catch {
        // best-effort
      }
      stopScreencast = null;
    }
    opts.screencastBus?.reset();
    // Co-browse Slice 2a — session is going away; revert control to
    // user. Same fail-closed semantics as a transport drop: the
    // motebit cannot continue acting on a session that no longer
    // exists. From {kind: "user"} this is a no-op (no audit
    // emission); from any other state it emits one final
    // co_browse_control_changed event so the audit log records the
    // revert before the session-close event lands.
    coBrowseControl.disconnect();
    const closedEvent = await sessionManager.closeSession(sessionId, reason);
    await emit(EventType.ComputerSessionClosed, closedEvent);
    if (!opts.signSessionReceipt) return;
    try {
      // Fail-permissive fallback: an empty digest still produces a
      // verifiable signature. Apps SHOULD wire the real hash so the
      // receipt commits to the actual roll-up.
      const hashActions = opts.hashSessionActions ?? (() => Promise.resolve("0".repeat(64)));
      const body = await sessionManager.summarize(sessionId, {
        generateReceiptId: () => `csr_${crypto.randomUUID()}`,
        embodimentMode: "virtual_browser",
        hashActions,
      });
      if (!body) return;
      const signed = await opts.signSessionReceipt(body);
      if (signed) {
        await emit(EventType.ComputerSessionSummarized, signed);
        if (opts.onSessionReceiptSigned) {
          try {
            opts.onSessionReceiptSigned(signed);
          } catch {
            // UX-emergence callback is fail-soft — the audit log
            // already has the receipt; a render failure must not
            // tear down the close path.
          }
        }
      }
    } catch {
      // Receipt path is fail-soft — the close already landed.
    }
  }

  async function ensureDefaultSession(): Promise<ComputerSessionHandle | null> {
    if (defaultSession) return defaultSession;
    if (openingDefault) return openingDefault.catch(() => null);
    const pending = sessionManager.openSession(opts.motebitId).then(async ({ handle, event }) => {
      defaultSession = handle;
      await emit(EventType.ComputerSessionOpened, event);
      // v1.3 — start the live screencast right after the session
      // opens. The dispatcher's `queryDisplay` (called from inside
      // `openSession`) seeded the cloud session id; `openScreencast`
      // attaches CDP and pipes JPEG frames to the bus. Best-effort:
      // a screencast failure must not prevent the AI from acting on
      // the session — the per-action screenshot fallback still
      // works. The slab simply stays still until manual screenshot.
      if (opts.screencastBus && dispatcher instanceof CloudBrowserDispatcher) {
        try {
          stopScreencast = await dispatcher.openScreencast({
            onFrame: (frame) => opts.screencastBus?.publish(frame),
            onError: () => {
              // Transport faults are surfaced through the slab's own
              // pending state; no toast, no console noise (the AI
              // loop notices when screenshot actions return errors).
              // Co-browse Slice 2a — fail-closed revert. A dead
              // screencast means we've lost our window into the
              // page; if motebit was driving, it must yield. The
              // machine's disconnect from non-user states reverts
              // to user, blocking the next motebit dispatch via
              // Slice 1's gate. From {kind: "user"} this is a no-op
              // (no audit event; the user already holds).
              coBrowseControl.disconnect();
            },
          });
          opts.onSessionLive?.(handle.session_id);
        } catch {
          // Open-screencast failure leaves stopScreencast null; the
          // session is still usable for actions.
        }
      }
      return handle;
    });
    openingDefault = pending;
    try {
      return await pending;
    } catch {
      // Session open failure (cloud browser unreachable, auth rejected,
      // etc.). Return null so the handler reports a structured failure
      // instead of throwing inside the tool-call pipeline.
      return null;
    } finally {
      openingDefault = null;
    }
  }

  /**
   * Adapter from the AI-visible args (`{ session_id?, action }`) to
   * the session manager's call shape. Identical to desktop.
   */
  const toolDispatcher: ComputerDispatcher = {
    async execute(request) {
      const args = (request ?? {}) as { session_id?: unknown; action?: unknown };
      const action = args.action as ComputerAction | undefined;
      if (!action || typeof action !== "object" || !("kind" in action)) {
        throw new Error("computer: invalid or missing `action` argument");
      }

      const suppliedId =
        typeof args.session_id === "string" && args.session_id.length > 0 ? args.session_id : null;
      const sessionId = suppliedId ?? (await ensureDefaultSession())?.session_id;
      if (!sessionId) {
        throw new Error(
          "computer: no active session — cloud browser failed to open one (check baseUrl + auth token).",
        );
      }

      const outcome = await sessionManager.executeAction(sessionId, action);
      if (outcome.outcome === "success") {
        return outcome.data;
      }
      const parts = [outcome.reason, outcome.message].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      throw new Error(parts.join(": "));
    },
  };

  // Per-dispatcher embodiment stamp. The web surface drives a cloud-
  // hosted Chromium via CloudBrowserDispatcher — that's the
  // `virtual_browser` embodiment per motebit-computer.md §"Embodiment
  // modes" (driver: motebit, observer: user, source: isolated-browser,
  // consent: session-scoped, sensitivity: tier-bounded-by-source,
  // lifecycle defaults: [resting, detached]). Stamping the embodiment
  // here at the registration site lets the runtime's slab-projection
  // pick the right mode contract per dispatcher without forcing
  // surface-aware code into the central tool-policy registry.
  // Doctrine: motebit-computer.md §"v1 implementation status —
  // Deferred to v1.5+: per-dispatcher mode stamping" — landed as
  // v1.1 of the virtual_browser arc.
  const computerDefinitionForCloud = {
    ...computerDefinition,
    embodimentMode: "virtual_browser",
  };
  registry.register(
    computerDefinitionForCloud,
    createComputerHandler({ dispatcher: toolDispatcher }),
  );

  async function dispose(): Promise<void> {
    if (defaultSession) {
      await closeAndEmit(defaultSession.session_id, "web_dispose");
      defaultSession = null;
    }
    sessionManager.dispose();
  }

  return { sessionManager, coBrowseControl, dispose };
}
