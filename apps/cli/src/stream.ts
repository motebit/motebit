// --- Streaming consumer and approval flow ---

import * as readline from "node:readline";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { formatBodyAwareness } from "@motebit/ai-core";
import { action, meta, warn, dim, prompt as promptColor } from "./colors.js";

export function rlQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

export async function consumeStream(
  stream: AsyncGenerator<StreamChunk>,
  runtime: MotebitRuntime,
  rl: readline.Interface,
): Promise<void> {
  let pendingApproval: {
    tool_call_id: string;
    name: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text":
        process.stdout.write(chunk.text);
        break;

      case "tool_status":
        if (chunk.status === "calling") {
          process.stdout.write(`\n  ${action("●")} ${action(chunk.name)}${meta("...")}`);
        } else {
          process.stdout.write(meta(" done") + "\n");
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
        process.stdout.write(
          `\n  ${action("●")} ${dim("[delegating]")} ${action(chunk.tool)}${meta("...")}`,
        );
        break;

      case "delegation_complete":
        process.stdout.write(meta(" done") + "\n");
        break;

      case "injection_warning":
        process.stdout.write(
          `\n  ${warn("⚠")} ${warn("suspicious content in " + chunk.tool_name)}\n`,
        );
        break;

      case "result": {
        const result = chunk.result;
        console.log("\n");

        if (result.memoriesFormed.length > 0) {
          console.log(
            meta(
              `  [memories: ${result.memoriesFormed.map((m: { content: string }) => m.content).join(", ")}]`,
            ),
          );
        }

        const s = result.stateAfter;
        console.log(
          meta(
            `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
          ),
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(meta(`  ${bodyLine}`));
        console.log();
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
    const answer = await rlQuestion(
      rl,
      `  ${warn("?")} ${pendingApproval.name}(${argsPreview})${quorumInfo}\n  Allow? (y/n) `,
    );

    const approved = answer.trim().toLowerCase() === "y";
    process.stdout.write("\n" + promptColor("mote>") + " ");
    await consumeStream(runtime.resolveApprovalVote(approved, runtime.motebitId), runtime, rl);
  }
}
