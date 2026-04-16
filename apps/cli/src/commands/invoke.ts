// ---------------------------------------------------------------------------
// /invoke — deterministic capability-affordance handler
// ---------------------------------------------------------------------------
//
// Sibling of `apps/web/src/ui/pr-url-chip.ts` — a deterministic affordance
// that MUST route through `runtime.invokeCapability`, never through the AI
// loop (see `docs/doctrine/surface-determinism.md` and the
// `check-affordance-routing` gate).
//
// The `/invoke` REPL command is the CLI's medium-native form of a UI chip:
// a user types a capability name and an argument, and the runtime dispatches
// a single-capability delegation with `invocation_origin: "user-tap"`. The
// receipt from the resulting `delegation_complete` is archived and rendered
// immediately — closing the loop locally, no relay roundtrip needed for
// verification.
//
// `/receipt <task-id>` re-renders an archived receipt. It does NOT invoke
// anything — it reads from the session archive, verifies the signature
// offline, and prints. But it IS an affordance (user typed a specific
// command), and category-error-wise it routes through the receipt subsystem,
// not the AI loop — the same doctrine applies.

import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";

import { archiveReceipt, getArchivedReceipt, renderReceipt } from "../receipt.js";
import { dim, error as errorColor, warn } from "../colors.js";
import type { VoiceController } from "../voice.js";

export interface InvokeCommandDeps {
  runtime: MotebitRuntime;
  /** Where to write lines. Defaults to stdout. */
  out?: (line: string) => void;
  /** Voice controller; if enabled, speaks the task result. */
  voice?: VoiceController;
}

/**
 * Handle `/invoke <capability> <args...>`.
 *
 * Contract: this function MUST call `runtime.invokeCapability` for the work.
 * It MUST NOT call `runtime.sendMessageStreaming`, `runtime.sendMessage`, or
 * otherwise construct a prompt and route it through the AI loop. That would
 * be the exact category error the `check-affordance-routing` gate forbids.
 */
export async function handleInvokeCommand(args: string, deps: InvokeCommandDeps): Promise<void> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const trimmed = args.trim();
  if (!trimmed) {
    out(errorColor("Usage: /invoke <capability> <prompt>"));
    return;
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    out(errorColor("Usage: /invoke <capability> <prompt>"));
    return;
  }
  const capability = trimmed.slice(0, spaceIdx);
  const prompt = trimmed.slice(spaceIdx + 1).trim();
  if (!prompt) {
    out(errorColor("Usage: /invoke <capability> <prompt>"));
    return;
  }

  // DETERMINISTIC DISPATCH. This is the load-bearing call the affordance-
  // routing gate protects. Do not replace with sendMessageStreaming.
  const stream = deps.runtime.invokeCapability(capability, prompt);
  await drainInvokeStream(stream, out, deps.voice);
}

/**
 * Handle `/receipt <task-id>` — re-render an archived receipt. Does not
 * invoke a capability; it is a read of local state plus an offline verify.
 */
export async function handleReceiptCommand(
  args: string,
  deps: { out?: (line: string) => void },
): Promise<void> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const taskId = args.trim();
  if (!taskId) {
    out(errorColor("Usage: /receipt <task-id>"));
    return;
  }
  const receipt = getArchivedReceipt(taskId);
  if (!receipt) {
    out(warn(`No archived receipt for task_id=${taskId}`));
    return;
  }
  await renderReceipt(receipt, out);
}

/**
 * Drain the `AsyncGenerator<StreamChunk>` returned by
 * `runtime.invokeCapability`. Emits concise CLI output: a "delegating…"
 * line, an optional result body, and the rendered receipt on completion.
 * Failures surface the closed `DelegationErrorCode` verbatim — honest
 * degradation per surface-determinism doctrine.
 */
async function drainInvokeStream(
  stream: AsyncGenerator<StreamChunk>,
  out: (line: string) => void,
  voice: VoiceController | undefined,
): Promise<void> {
  let textBuf = "";
  for await (const chunk of stream) {
    switch (chunk.type) {
      case "delegation_start":
        out(dim(`  [delegating · ${chunk.tool}…]`));
        break;
      case "text":
        textBuf += chunk.text;
        break;
      case "delegation_complete": {
        if (textBuf.trim()) out(textBuf.trim());
        if (chunk.full_receipt) {
          archiveReceipt(chunk.full_receipt);
          await renderReceipt(chunk.full_receipt, out);
          // Voice speaks only on explicit opt-in + only for completed tasks.
          if (voice && chunk.full_receipt.status === "completed") {
            const spoken = chunk.full_receipt.result ?? "Task complete.";
            void voice.speakIfEnabled(spoken);
          }
        }
        break;
      }
      case "invoke_error": {
        out(errorColor(`  [invoke failed · ${chunk.code}]`));
        if (chunk.message) out(dim(`    ${chunk.message}`));
        break;
      }
      default:
        // Other chunk types (tool_status, result, approval_request) don't
        // apply to the deterministic single-capability path. Ignore.
        break;
    }
  }
}
