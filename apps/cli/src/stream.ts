// --- Streaming consumer and approval flow ---

import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { formatBodyAwareness } from "@motebit/ai-core";
import { action, meta, warn, dim, prompt as promptColor } from "./colors.js";
import { writeOutput, askQuestion } from "./terminal.js";

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
): Promise<void> {
  let pendingApproval: {
    tool_call_id: string;
    name: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null = null;
  let stopAnimation: (() => void) | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text":
        writeOutput(chunk.text);
        break;

      case "tool_status":
        // Delegation tools are announced by delegation_start/delegation_complete instead
        if (chunk.name === "delegate_to_agent") break;
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
        };
        break;

      case "delegation_start":
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
        break;

      case "injection_warning":
        writeOutput(`\n  ${warn("⚠")} ${warn("suspicious content in " + chunk.tool_name)}\n`);
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
    const argsPreview = JSON.stringify(pendingApproval.args).slice(0, 80);
    const quorumInfo =
      pendingApproval.quorum && pendingApproval.quorum.required > 1
        ? ` [${pendingApproval.quorum.collected.length}/${pendingApproval.quorum.required} approvals]`
        : "";
    const answer = await askQuestion(
      `  ${warn("?")} ${pendingApproval.name}(${argsPreview})${quorumInfo}\n  Allow? (y/n) `,
    );

    const approved = answer.trim().toLowerCase() === "y";
    writeOutput("\n" + promptColor("mote>") + " ");
    await consumeStream(runtime.resolveApprovalVote(approved, runtime.motebitId), runtime);
  }
}
