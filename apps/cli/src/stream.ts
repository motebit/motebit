// --- Streaming consumer and approval flow ---

import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { formatBodyAwareness } from "@motebit/ai-core";
import { action, meta, warn, dim, prompt as promptColor } from "./colors.js";
import { writeOutput, askQuestion } from "./terminal.js";
import { archiveReceipt, renderReceipt } from "./receipt.js";
import { renderApprovalRequest } from "./approval-render.js";
import { renderAuthorityDelta } from "./authority-delta-render.js";
import type { VoiceController } from "./voice.js";

// Animated dots: cycles .  → .. → ... while a tool call is in flight.
// Returns a stop function that clears the interval and writes " done\n".
function startDotAnimation(): () => void {
  let dots = 1;
  const timer = setInterval(() => {
    dots = (dots % 3) + 1;
    // Erase previous dots (max 3 chars) and rewrite
    writeOutput(`\x1b[${3}D${meta(".".repeat(dots) + " ".repeat(3 - dots))}`);
  }, 400);
  return () => {
    clearInterval(timer);
    // Erase dots, write " done\n"
    writeOutput(`\x1b[${3}D${meta("...")} ${meta("done")}\n`);
  };
}

export async function consumeStream(
  stream: AsyncGenerator<StreamChunk>,
  runtime: MotebitRuntime,
  opts?: { voice?: VoiceController; budgetUsd?: number },
): Promise<boolean> {
  let pendingApproval: {
    tool_call_id: string;
    name: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
    risk_level?: number;
  } | null = null;
  let stopAnimation: (() => void) | null = null;
  let lastCompletedReceiptResult: string | null = null;
  // #457: whether ANY chunk arrived — the caller uses this to guarantee an
  // approval answer never ends in pure silence. Returns true once a chunk
  // is observed (every chunk type renders or deliberately captures).
  let sawAnyChunk = false;

  for await (const chunk of stream) {
    sawAnyChunk = true;
    switch (chunk.type) {
      case "text":
        writeOutput(chunk.text);
        break;

      case "tool_status":
        // Owner-facing authority residual — render the exact repair even
        // for delegation tools (the delta rides only this surface channel;
        // the model saw the coarse reason). See AuthorityDelta invariants.
        if (chunk.status === "done" && chunk.missing_authority != null) {
          if (stopAnimation) {
            stopAnimation();
            stopAnimation = null;
          }
          for (const line of renderAuthorityDelta(chunk.name, chunk.missing_authority)) {
            writeOutput(meta(line) + "\n");
          }
          break;
        }
        // Delegation normally announces itself via delegation_start/complete,
        // so tool_status is redundant — UNLESS this is the post-approval
        // execution path, which executes the tool directly and emits ONLY
        // tool_status. Blanket-skipping delegate_to_agent here meant the one
        // path that runs after a human approves a PAID hire rendered nothing
        // at all: the screen went blank for the entire task (#432). Skip only
        // when an animation is already running (delegation_start beat us).
        if (chunk.name === "delegate_to_agent" && chunk.status === "calling" && stopAnimation) {
          break;
        }
        if (chunk.status === "calling") {
          writeOutput(`\n  ${action("●")} ${action(chunk.name)}${meta("...")}`);
          stopAnimation = startDotAnimation();
        } else {
          if (stopAnimation) {
            stopAnimation();
            stopAnimation = null;
          } else writeOutput(meta(" done") + "\n");
        }
        break;

      case "approval_request":
        pendingApproval = {
          tool_call_id: chunk.tool_call_id,
          name: chunk.name,
          args: chunk.args,
          quorum: chunk.quorum,
          // Carried so the prompt can name the stakes. Previously dropped —
          // which is why a money act rendered identically to a read (#432).
          risk_level: chunk.risk_level,
        };
        break;

      case "delegation_start":
        // Guard against a second animation when tool_status already started
        // one (the post-approval path emits tool_status first).
        if (stopAnimation) break;
        writeOutput(
          `\n  ${action("●")} ${dim("[delegating]")} ${action(chunk.tool)}${meta("...")}`,
        );
        stopAnimation = startDotAnimation();
        break;

      case "delegation_complete":
        if (stopAnimation) {
          stopAnimation();
          stopAnimation = null;
        } else writeOutput(meta(" done") + "\n");
        // Archive the signed receipt so `/receipt <task-id>` can re-render
        // it, and emerge a CLI-native rendering right here — the "oh" beat
        // that proves the delegation actually happened and the signature
        // checks out locally. Mirrors the web receipt-artifact.
        if (chunk.full_receipt) {
          archiveReceipt(chunk.full_receipt);
          await renderReceipt(chunk.full_receipt, (line) => writeOutput(line + "\n"));
          if (chunk.full_receipt.status === "completed" && chunk.full_receipt.result) {
            lastCompletedReceiptResult = chunk.full_receipt.result;
          }
        }
        break;

      case "injection_warning":
        writeOutput(`\n  ${warn("⚠")} ${warn("suspicious content in " + chunk.tool_name)}\n`);
        break;

      case "approval_expired":
        // #457: an approval submitted after the timeout voided it used to
        // end with NOTHING on screen — an approved money action with no
        // rendered outcome. The runtime now emits this typed chunk; say
        // plainly that nothing executed and how to proceed.
        if (stopAnimation) {
          stopAnimation();
          stopAnimation = null;
        }
        writeOutput(
          `\n  ${warn("[this approval expired before your answer arrived — nothing was executed]")}\n` +
            `  ${dim(`(${chunk.tool_name} was never run; no money moved. Ask again when ready.)`)}\n`,
        );
        break;

      case "approval_voided":
        // #462: this turn's message set aside a pending approval before the
        // human answered. Not a refusal, not an expiry — say what happened
        // and that nothing ran.
        if (stopAnimation) {
          stopAnimation();
          stopAnimation = null;
        }
        writeOutput(
          `\n  ${warn("[your new message set aside the pending approval — nothing was executed]")}\n` +
            `  ${dim(`(${chunk.tool_name} was never run; no money moved. It can be proposed again.)`)}\n`,
        );
        break;

      case "invoke_error":
        if (stopAnimation) {
          stopAnimation();
          stopAnimation = null;
        }
        writeOutput(`\n  ${warn("[invoke failed · " + chunk.code + "]")}\n`);
        if (chunk.message) writeOutput(`  ${dim(chunk.message)}\n`);
        break;

      case "result": {
        const result = chunk.result;
        writeOutput("\n\n");

        if (result.memoriesFormed.length > 0) {
          writeOutput(
            meta(
              `  [memories: ${result.memoriesFormed.map((m: { content: string }) => m.content).join(", ")}]`,
            ) + "\n",
          );
        }

        const s = result.stateAfter;
        writeOutput(
          meta(
            `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
          ) + "\n",
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) writeOutput(meta(`  ${bodyLine}`) + "\n");
        writeOutput("\n");
        break;
      }
    }
  }

  // Handle approval request after stream ends -- deterministic resumption
  if (pendingApproval) {
    // Write the decision context as OUTPUT, then prompt on a single line.
    // A multi-line prompt string is redrawn by the line editor on every
    // keystroke, which duplicated the whole block on screen as the user
    // typed their answer (#432).
    for (const line of renderApprovalRequest({
      name: pendingApproval.name,
      args: pendingApproval.args,
      ...(pendingApproval.risk_level != null ? { riskLevel: pendingApproval.risk_level } : {}),
      ...(pendingApproval.quorum ? { quorum: pendingApproval.quorum } : {}),
      ...(opts?.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
    })) {
      writeOutput(line + "\n");
    }
    const answer = await askQuestion(`  ${warn("Allow?")} ${dim("(y/n)")} `);

    const approved = answer.trim().toLowerCase() === "y";
    writeOutput("\n" + promptColor("mote>") + " ");
    const resumedRendered = await consumeStream(
      runtime.resolveApprovalVote(approved, runtime.motebitId),
      runtime,
      opts,
    );
    // #457 backstop: an approval answer must never end with a bare orphaned
    // `mote>`. The runtime now emits approval_expired on every late-resume
    // path, so a zero-chunk resume should be impossible — but if a new one
    // appears, say so instead of silence. Terminal-outcome-always is the
    // contract for money surfaces.
    if (!resumedRendered) {
      writeOutput(
        `${warn("[nothing came back for this approval — it may have expired or been resolved elsewhere; nothing was executed]")}\n`,
      );
    }
  }

  // Speak the delegated task's result on completion, but only if voice is
  // opt-in enabled. Explicit policy: never auto-speak conversational text;
  // voice is for completed task outcomes and `/say`, not every message.
  if (opts?.voice && lastCompletedReceiptResult) {
    void opts.voice.speakIfEnabled(lastCompletedReceiptResult);
  }

  return sawAnyChunk;
}
