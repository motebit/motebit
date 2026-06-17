/**
 * Sensitivity floor for synced conversation / message / plan data.
 *
 * The conversation, message, and plan sync tables hold free-text the user
 * generated — message bodies, conversation titles/summaries, plan step prompts
 * and results. The client encrypts every one of these fields BEFORE pushing
 * (the `EncryptedConversation`/`EncryptedPlan` sync adapters in
 * `@motebit/sync-engine`, keyed by a per-motebit key the relay never holds), so
 * in normal operation the relay only ever sees opaque ciphertext carrying the
 * `ENCRYPTED_FIELD_PREFIX` marker.
 *
 * Until now that was a CONVENTION enforced only on the client. A misconfigured,
 * downgraded, or hostile pusher could POST plaintext bodies and the relay would
 * persist them and fan them out to peer devices verbatim — the same fail-closed
 * gap (sync pushes content with no relay-side floor) the memory-event redactor
 * (`redaction.ts`) closes for `memory_formed`. Unlike memory, conversation
 * content carries NO `sensitivity` field to gate on, so the floor is a pure
 * key-acceptance decision: a field that is not encrypted is, at this boundary,
 * unprotected content and must not land at the relay.
 *
 * The floor therefore runs at INGRESS — inside the storage helpers (so storage
 * is unconditionally safe for any caller) AND on each fan-out object (so peers
 * never receive plaintext) — on both sync surfaces (HTTP push in `data-sync.ts`,
 * WebSocket push in `websocket.ts`). Encrypted fields pass through untouched;
 * a plaintext content field is replaced with `[REDACTED]`. Idempotent:
 * re-flooring an already-floored or encrypted value is a no-op. The set of
 * floored fields is exactly the set the client adapters encrypt.
 */

import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
} from "@motebit/sdk";
import { isEncryptedField } from "@motebit/encryption";

const REDACTED = "[REDACTED]";

/**
 * Floor a nullable free-text field: null/empty and encrypted values pass
 * through; any other (plaintext) value becomes `[REDACTED]`.
 */
function floorOptional(value: string | null): string | null {
  if (value == null || value === "") return value;
  if (isEncryptedField(value)) return value;
  return REDACTED;
}

/** Floor a required (non-null) free-text field. */
function floorRequired(value: string): string {
  if (value === "" || isEncryptedField(value)) return value;
  return REDACTED;
}

export function floorSyncConversation(conv: SyncConversation): SyncConversation {
  return {
    ...conv,
    title: floorOptional(conv.title),
    summary: floorOptional(conv.summary),
  };
}

export function floorSyncMessage(msg: SyncConversationMessage): SyncConversationMessage {
  return {
    ...msg,
    content: floorRequired(msg.content),
    tool_calls: floorOptional(msg.tool_calls),
  };
}

export function floorSyncPlan(plan: SyncPlan): SyncPlan {
  return {
    ...plan,
    title: floorRequired(plan.title),
  };
}

export function floorSyncPlanStep(step: SyncPlanStep): SyncPlanStep {
  return {
    ...step,
    description: floorRequired(step.description),
    prompt: floorRequired(step.prompt),
    result_summary: floorOptional(step.result_summary),
    error_message: floorOptional(step.error_message),
  };
}
