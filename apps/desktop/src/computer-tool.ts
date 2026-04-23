/**
 * Desktop wiring for the `computer` tool.
 *
 * Composes three primitives:
 *
 *   - `@motebit/runtime`'s `createComputerSessionManager` — owns session
 *     lifecycle + governance + failure-reason normalization.
 *   - `createTauriComputerDispatcher` (sibling module) — platform bridge
 *     to the Rust `computer_*` commands.
 *   - `@motebit/tools`'s `computerDefinition` — the AI-visible tool
 *     schema.
 *
 * The tool handler auto-fills `session_id` from the runtime's
 * lazy-initialized default session. The AI sees only `action`; every
 * receipt still binds the full wire-format `ComputerActionRequest`
 * including the session id.
 *
 * Session lifecycle:
 *   - Opened on the first `computer` tool call (or first `ensureDefaultSession`).
 *   - Reused for every subsequent call within the motebit's lifetime.
 *   - Closed when `disposeComputerTool` is invoked (app teardown).
 */

import {
  computerDefinition,
  createComputerHandler,
  type ComputerDispatcher,
  type ToolRegistry,
} from "@motebit/tools/web-safe";
import {
  createComputerSessionManager,
  type ComputerApprovalFlow,
  type ComputerGovernanceClassifier,
  type ComputerPlatformDispatcher,
  type ComputerSessionHandle,
  type ComputerSessionManager,
} from "@motebit/runtime";
import { createDefaultComputerGovernance } from "@motebit/policy-invariants";
import type { ComputerAction } from "@motebit/sdk";

import { createTauriComputerDispatcher } from "./computer-bridge.js";
import type { InvokeFn } from "./tauri-storage.js";

export interface ComputerToolRegistration {
  /** The session manager; caller may use it for lifecycle events. */
  sessionManager: ComputerSessionManager;
  /** Teardown — closes the default session if one was opened. */
  dispose: () => Promise<void>;
}

/**
 * Options for registering the `computer` tool on the desktop surface.
 */
export interface RegisterComputerToolOptions {
  /** Tauri invoke function. */
  invoke: InvokeFn;
  /** Motebit id for session identity binding. */
  motebitId: string;
  /** Optional platform dispatcher override (for tests). Defaults to Tauri IPC. */
  dispatcher?: ComputerPlatformDispatcher;
  /**
   * Optional governance classifier. When omitted, desktop uses
   * `createDefaultComputerGovernance()` from `@motebit/policy-invariants`
   * — fail-closed sensitivity enforcement at the type-action and
   * screenshot-observation boundary. Tests pass a mock to bypass.
   */
  governance?: ComputerGovernanceClassifier;
  /** Optional approval flow for require_approval classifications. */
  approvalFlow?: ComputerApprovalFlow;
}

/**
 * Register the `computer` tool on the desktop surface and return a
 * handle for lifecycle management. The tool is registered with a
 * handler that:
 *
 *   1. Ensures a default session is open (lazy).
 *   2. Parses `args.action` (the AI-visible discriminated variant).
 *   3. Calls `sessionManager.executeAction(sessionId, action)`.
 *   4. Returns `{ ok: true, data }` on success, `{ ok: false, error, reason }` on failure.
 *
 * Every invocation flows through the existing tool-call signer — the
 * `ToolInvocationReceipt` emits upstream with the full
 * `ComputerActionRequest` (including session id) in the args snapshot.
 */
export function registerComputerTool(
  registry: ToolRegistry,
  opts: RegisterComputerToolOptions,
): ComputerToolRegistration {
  const dispatcher = opts.dispatcher ?? createTauriComputerDispatcher(opts.invoke);
  const sessionManager = createComputerSessionManager({
    dispatcher,
    governance: opts.governance ?? createDefaultComputerGovernance(),
    approvalFlow: opts.approvalFlow,
  });

  let defaultSession: ComputerSessionHandle | null = null;
  let openingDefault: Promise<ComputerSessionHandle> | null = null;

  async function ensureDefaultSession(): Promise<ComputerSessionHandle | null> {
    if (defaultSession) return defaultSession;
    if (openingDefault) return openingDefault.catch(() => null);
    const pending = sessionManager.openSession(opts.motebitId).then(({ handle }) => {
      defaultSession = handle;
      return handle;
    });
    openingDefault = pending;
    try {
      return await pending;
    } catch {
      // Session open failure (e.g. dispatcher not_supported on v1 stub).
      // Return null so the handler can report a structured failure
      // instead of throwing inside the tool-call pipeline.
      return null;
    } finally {
      openingDefault = null;
    }
  }

  /**
   * Dispatcher passed to `createComputerHandler` — adapts the AI-visible
   * args shape (just `action`) to the session manager's
   * (`session_id` + `action`). Session id auto-fills from the default
   * session; if the AI explicitly passed one we honor it.
   */
  const toolDispatcher: ComputerDispatcher = {
    async execute(request) {
      const args = (request ?? {}) as {
        session_id?: unknown;
        action?: unknown;
      };
      const action = args.action as ComputerAction | undefined;
      if (!action || typeof action !== "object" || !("kind" in action)) {
        throw new Error("computer: invalid or missing `action` argument");
      }

      const suppliedId =
        typeof args.session_id === "string" && args.session_id.length > 0 ? args.session_id : null;
      const sessionId = suppliedId ?? (await ensureDefaultSession())?.session_id;
      if (!sessionId) {
        // Default session failed to open (v1 stub path).
        throw new Error(
          "computer: no active session — platform dispatcher failed to open one (likely `not_supported` on this build)",
        );
      }

      const outcome = await sessionManager.executeAction(sessionId, action);
      if (outcome.outcome === "success") {
        return outcome.data;
      }
      // Surface structured failures as thrown errors so the tool handler's
      // wrapper emits `{ ok: false, error: "computer: <reason>: <message>" }`.
      const parts = [outcome.reason, outcome.message].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      throw new Error(parts.join(": "));
    },
  };

  // Build the handler from the shared factory + dispatcher adapter.
  // Using the factory from the tools package rather than a fresh handler
  // keeps error-normalization consistent with other surfaces.
  registry.register(computerDefinition, createComputerHandler({ dispatcher: toolDispatcher }));

  async function dispose(): Promise<void> {
    if (defaultSession) {
      await sessionManager.closeSession(defaultSession.session_id, "desktop_dispose");
      defaultSession = null;
    }
    sessionManager.dispose();
  }

  return { sessionManager, dispose };
}
