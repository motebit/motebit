// Attached-mode REPL: this terminal renders, the coordinator acts.
// Entered when the election finds a live coordinator (daemon or another
// REPL) already holding ~/.motebit/runtime.sock — instead of
// constructing a second runtime authority, chat turns, capability
// invocations, and approval votes proxy over the local socket
// (docs/doctrine/daemon-desktop-unification.md).

import type { RuntimeHostClient } from "@motebit/runtime-host";
import { dim, warn, meta, prompt as promptColor } from "./colors.js";
import { askQuestion, destroyTerminal, readInput, writeOutput } from "./terminal.js";

/** The chunk fields the attached renderer reads. Wire chunks are the
 * coordinator runtime's StreamChunk values, JSON round-tripped. */
interface WireChunk {
  type?: string;
  text?: string;
  name?: string;
  status?: string;
  tool?: string;
  server?: string;
  args?: Record<string, unknown>;
  message?: string;
  code?: string;
  tool_name?: string;
  receipt?: { task_id?: string; status?: string };
}

interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
}

async function renderStream(
  stream: AsyncGenerator<unknown>,
): Promise<{ pendingApproval: PendingApproval | null }> {
  let pendingApproval: PendingApproval | null = null;
  try {
    for await (const raw of stream) {
      const chunk = raw as WireChunk;
      switch (chunk.type) {
        case "text":
          if (typeof chunk.text === "string") writeOutput(chunk.text);
          break;
        case "tool_status":
          if (chunk.status === "calling") {
            writeOutput(`\n${meta(`[${chunk.name ?? "tool"}]`)} `);
          }
          break;
        case "approval_request":
          pendingApproval = {
            name: chunk.name ?? "tool",
            args: chunk.args ?? {},
          };
          break;
        case "delegation_start":
          writeOutput(`\n${dim(`[delegating · ${chunk.tool ?? ""}]`)} `);
          break;
        case "delegation_complete":
          if (chunk.receipt?.task_id != null) {
            writeOutput(
              `\n${dim(`[receipt ${chunk.receipt.task_id.slice(0, 8)} · ${chunk.receipt.status ?? ""}]`)}\n`,
            );
          }
          break;
        case "injection_warning":
          writeOutput(`\n${warn("⚠")} suspicious content in ${chunk.tool_name ?? "tool"} output\n`);
          break;
        case "invoke_error":
          writeOutput(
            `\n${warn(`[invoke failed${chunk.code != null ? ` · ${chunk.code}` : ""}]`)} ${chunk.message ?? ""}\n`,
          );
          break;
        case "task_step_narration":
          if (typeof chunk.text === "string") writeOutput(dim(chunk.text));
          break;
        default:
          break;
      }
    }
  } catch (err) {
    writeOutput(
      `\n${warn("[coordinator error]")} ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { pendingApproval };
}

/** Render a stream and walk any approval round-trips to completion. */
async function renderTurn(
  client: RuntimeHostClient,
  motebitId: string,
  stream: AsyncGenerator<unknown>,
): Promise<void> {
  let current = stream;
  for (;;) {
    const { pendingApproval } = await renderStream(current);
    if (pendingApproval === null) return;
    const argsPreview = JSON.stringify(pendingApproval.args).slice(0, 120);
    const answer = await askQuestion(
      `\n  ${warn("?")} ${pendingApproval.name}(${argsPreview})\n  Allow? (y/n) `,
    );
    const approved = answer.trim().toLowerCase() === "y";
    current = client.resolveApproval(approved, motebitId);
  }
}

const ATTACHED_HELP = `
  Attached mode — the coordinator process owns the runtime; this terminal renders.
    <text>                chat with your motebit (proxied to the coordinator)
    /invoke <cap> <text>  invoke a capability deterministically
    /help                 this help
    /exit                 leave (the coordinator keeps running)
  Other slash commands need the runtime in-process: exit, stop the coordinator, and re-run \`motebit\`.
`;

export async function runAttachedRepl(client: RuntimeHostClient, motebitId: string): Promise<void> {
  writeOutput(
    `\n  ${dim("Attached to the machine's coordinator runtime")} ${dim(`(pid ${client.coordinatorPid})`)}\n` +
      `  ${dim("This terminal renders; the coordinator acts. /help for what's available.")}\n\n`,
  );

  let closed = false;
  client.onClose(() => {
    closed = true;
    writeOutput(
      `\n${warn("Coordinator exited.")} Run \`motebit\` again to take over as coordinator.\n`,
    );
    destroyTerminal();
    process.exit(0);
  });

  for (;;) {
    if (closed) return;
    let line: string;
    try {
      line = await readInput(promptColor("you>") + " ");
    } catch {
      break; // stdin closed
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "exit" || trimmed === "quit") {
      writeOutput("Goodbye! (coordinator keeps running)\n");
      break;
    }
    if (trimmed === "/help") {
      writeOutput(ATTACHED_HELP);
      continue;
    }
    if (trimmed.startsWith("/invoke ")) {
      const rest = trimmed.slice("/invoke ".length).trim();
      const space = rest.indexOf(" ");
      const capability = space === -1 ? rest : rest.slice(0, space);
      const prompt = space === -1 ? "" : rest.slice(space + 1);
      if (capability === "") {
        writeOutput(`${warn("usage:")} /invoke <capability> <prompt>\n`);
        continue;
      }
      writeOutput(promptColor("mote>") + " ");
      await renderTurn(client, motebitId, client.invoke(capability, prompt));
      writeOutput("\n");
      continue;
    }
    if (trimmed.startsWith("/")) {
      writeOutput(
        `${dim(`${trimmed.split(" ")[0]} needs the runtime in-process — not available in attached mode.`)}\n` +
          `${dim("Stop the coordinator and re-run `motebit` to use it.")}\n`,
      );
      continue;
    }
    writeOutput(promptColor("mote>") + " ");
    await renderTurn(client, motebitId, client.chat(trimmed));
    writeOutput("\n");
  }

  client.close();
  destroyTerminal();
}
