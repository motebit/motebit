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

  const sessionManager = createComputerSessionManager({
    dispatcher,
    governance: opts.governance ?? createDefaultComputerGovernance(),
    approvalFlow: opts.approvalFlow,
  });

  let defaultSession: ComputerSessionHandle | null = null;
  let openingDefault: Promise<ComputerSessionHandle> | null = null;

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

  return { sessionManager, dispose };
}
