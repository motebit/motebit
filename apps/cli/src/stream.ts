// --- Streaming consumer and approval flow ---

import * as readline from "node:readline";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { formatBodyAwareness } from "@motebit/ai-core";

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
  } | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text":
        process.stdout.write(chunk.text);
        break;

      case "tool_status":
        if (chunk.status === "calling") {
          process.stdout.write(`\n  [tool] ${chunk.name}...`);
        } else {
          process.stdout.write(" done\n");
        }
        break;

      case "approval_request":
        pendingApproval = { tool_call_id: chunk.tool_call_id, name: chunk.name, args: chunk.args };
        break;

      case "injection_warning":
        process.stdout.write(`\n  [warning] suspicious content in ${chunk.tool_name}\n`);
        break;

      case "result": {
        const result = chunk.result;
        console.log("\n");

        if (result.memoriesFormed.length > 0) {
          console.log(
            `  [memories: ${result.memoriesFormed.map((m: { content: string }) => m.content).join(", ")}]`,
          );
        }

        const s = result.stateAfter;
        console.log(
          `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(`  ${bodyLine}`);
        console.log();
        break;
      }
    }
  }

  // Handle approval request after stream ends -- deterministic resumption
  if (pendingApproval) {
    const argsPreview = JSON.stringify(pendingApproval.args).slice(0, 80);
    const answer = await rlQuestion(
      rl,
      `  [approval] ${pendingApproval.name}(${argsPreview})\n  Allow? (y/n) `,
    );

    const approved = answer.trim().toLowerCase() === "y";
    process.stdout.write("\nmote> ");
    await consumeStream(runtime.resumeAfterApproval(approved), runtime, rl);
  }
}
