/**
 * Desktop Tauri bridge for `@motebit/runtime`'s `ComputerPlatformDispatcher`.
 *
 * Wraps the two Rust-side Tauri commands (`computer_query_display`,
 * `computer_execute`) in the dispatcher interface the session manager
 * expects. Rust returns a structured `FailureEnvelope` on error; we
 * unwrap it into a `ComputerDispatcherError` so the session manager's
 * outcome taxonomy (policy_denied / permission_denied / platform_blocked /
 * target_not_found / …) stays well-typed end-to-end.
 *
 * Status: pairs with the v1 Rust stub. Every call currently surfaces
 * `not_supported`. When the real screen-capture / input-injection
 * implementations land on the Rust side, only those `#[tauri::command]`
 * function bodies change — this TS wrapper is already the seam.
 */

import {
  ComputerDispatcherError,
  type ComputerDisplayInfo,
  type ComputerPlatformDispatcher,
} from "@motebit/runtime";
import type { ComputerAction, ComputerFailureReason } from "@motebit/sdk";

import type { InvokeFn } from "./tauri-storage.js";

/**
 * Rust `FailureEnvelope` shape — mirrors `computer_use.rs`. `reason` is
 * the structured failure reason; invalid reasons degrade to
 * `platform_blocked` at the mapper.
 */
interface FailureEnvelope {
  reason: string;
  message: string;
}

/** Known `ComputerFailureReason` values for runtime validation. */
const KNOWN_FAILURE_REASONS: ReadonlySet<ComputerFailureReason> = new Set<ComputerFailureReason>([
  "policy_denied",
  "approval_required",
  "approval_expired",
  "permission_denied",
  "session_closed",
  "target_not_found",
  "target_obscured",
  "user_preempted",
  "platform_blocked",
  "not_supported",
]);

function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    typeof (value as Record<string, unknown>).reason === "string"
  );
}

/**
 * Normalize whatever the invoke-rejected value is into a
 * `ComputerDispatcherError`. Rust throws `Err(FailureEnvelope)`;
 * Tauri's invoke() surfaces it as the rejection value verbatim. An
 * unknown / malformed rejection becomes `platform_blocked` with the
 * best-effort string message.
 */
function toDispatcherError(err: unknown): ComputerDispatcherError {
  if (isFailureEnvelope(err)) {
    const reason = KNOWN_FAILURE_REASONS.has(err.reason as ComputerFailureReason)
      ? (err.reason as ComputerFailureReason)
      : "platform_blocked";
    return new ComputerDispatcherError(reason, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ComputerDispatcherError("platform_blocked", message);
}

/**
 * Build a `ComputerPlatformDispatcher` backed by the Tauri IPC layer.
 * Pass the same `InvokeFn` the rest of the desktop surface uses.
 */
export function createTauriComputerDispatcher(invoke: InvokeFn): ComputerPlatformDispatcher {
  return {
    async queryDisplay(): Promise<ComputerDisplayInfo> {
      try {
        return await invoke<ComputerDisplayInfo>("computer_query_display");
      } catch (err) {
        throw toDispatcherError(err);
      }
    },
    async execute(action: ComputerAction): Promise<unknown> {
      try {
        return await invoke<unknown>("computer_execute", { action });
      } catch (err) {
        throw toDispatcherError(err);
      }
    },
  };
}
