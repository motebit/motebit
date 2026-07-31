// Attached-mode REPL: this terminal renders, the coordinator acts.
// Entered when the election finds a live coordinator (daemon or another
// REPL) already holding ~/.motebit/runtime.sock — instead of
// constructing a second runtime authority, chat turns, capability
// invocations, and approval votes proxy over the local socket
// (docs/doctrine/daemon-desktop-unification.md).

import type { RuntimeHostClient } from "@motebit/runtime-host";
import { action, dim, warn, meta, prompt as promptColor } from "./colors.js";
import {
  askQuestion,
  destroyTerminal,
  readInput,
  setModeRow,
  writeLine,
  writeOutput,
} from "./terminal.js";
import { renderModeRow } from "./mode-render.js";
import { startStatus, type StatusHandle } from "./statusline.js";
import { formatElapsed } from "./status-render.js";
import { renderApprovalRequest } from "./approval-render.js";

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
  risk_level?: number;
  receipt?: { task_id?: string; status?: string };
}

interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

async function renderStream(
  stream: AsyncGenerator<unknown>,
): Promise<{ pendingApproval: PendingApproval | null }> {
  let pendingApproval: PendingApproval | null = null;
  // Same owned-status treatment as the coordinator REPL in stream.ts
  // (sibling boundary rule): in-flight state lives on the status row,
  // scrollback gets one durable line per completed act.
  let status: StatusHandle | null = null;
  // Model-latency cover (#480) — same two-row split as stream.ts: `thinking`
  // fills the gaps before the first token and between a tool's done-line and
  // the model's next words; `status` is real in-flight work.
  let thinking: StatusHandle | null = null;
  const stopThinking = (): void => {
    thinking?.stop();
    thinking = null;
  };
  const stopStatus = (): number => {
    stopThinking();
    const elapsed = status?.stop() ?? 0;
    status = null;
    return elapsed;
  };
  thinking = startStatus("thinking");
  try {
    for await (const raw of stream) {
      const chunk = raw as WireChunk;
      switch (chunk.type) {
        case "text":
          stopThinking();
          if (typeof chunk.text === "string") writeOutput(chunk.text);
          break;
        case "tool_status": {
          const name = chunk.name ?? "tool";
          if (chunk.status === "calling") {
            if (name === "delegate_to_agent" && status) break;
            stopThinking();
            status =
              name === "delegate_to_agent"
                ? startStatus("delegating")
                : startStatus("running", name);
          } else if (status) {
            // A `done` with no status in flight already rendered via
            // delegation_complete — same guard as stream.ts.
            writeLine(
              `  ${action("●")} ${action(name)} ${meta(`· done · ${formatElapsed(0, stopStatus())}`)}`,
            );
            thinking = startStatus("thinking");
          }
          break;
        }
        case "approval_request":
          pendingApproval = {
            name: chunk.name ?? "tool",
            args: chunk.args ?? {},
            ...(chunk.risk_level != null ? { riskLevel: chunk.risk_level } : {}),
          };
          break;
        case "delegation_start":
          if (status) break;
          stopThinking();
          status = startStatus("delegating", chunk.tool ?? "task");
          break;
        case "delegation_complete":
          stopStatus();
          if (chunk.receipt?.task_id != null) {
            writeLine(
              dim(`[receipt ${chunk.receipt.task_id.slice(0, 8)} · ${chunk.receipt.status ?? ""}]`),
            );
          }
          thinking = startStatus("thinking");
          break;
        case "injection_warning":
          writeLine(`${warn("⚠")} suspicious content in ${chunk.tool_name ?? "tool"} output`);
          break;
        case "approval_expired":
          // #457 sibling: the coordinator-owned REPL renders this in
          // stream.ts; an attached frontend must never get silence on an
          // approval outcome either.
          stopStatus();
          writeLine(
            `${warn("[this approval expired before your answer arrived — nothing was executed]")}\n${dim(`(${chunk.tool_name ?? "the tool"} was never run; no money moved. Ask again when ready.)`)}`,
          );
          break;
        case "approval_voided":
          // #462: this turn's message set aside a pending approval (possibly
          // one prompted on another surface). Not a refusal, not an expiry.
          stopStatus();
          writeLine(
            `${warn("[your new message set aside the pending approval — nothing was executed]")}\n${dim(`(${chunk.tool_name ?? "the tool"} was never run; no money moved. It can be proposed again.)`)}`,
          );
          break;
        case "invoke_error":
          stopStatus();
          writeLine(
            `${warn(`[invoke failed${chunk.code != null ? ` · ${chunk.code}` : ""}]`)} ${chunk.message ?? ""}`,
          );
          break;
        case "task_step_narration":
          // Current step on the status row; dim durable echo in scrollback —
          // the same two-register treatment as the coordinator REPL (#456).
          if (typeof chunk.text === "string") {
            status?.step(chunk.text.trim());
            writeLine(`    ${meta("· " + chunk.text.trim())}`);
          }
          break;
        default:
          break;
      }
    }
  } catch (err) {
    writeLine(`${warn("[coordinator error]")} ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // The status row must not outlive the stream (see stream.ts).
    stopStatus();
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
    // Context as output, prompt on one line — a multi-line prompt string is
    // redrawn by the line editor per keystroke (#432). Same treatment as the
    // coordinator-owned REPL in stream.ts.
    for (const line of renderApprovalRequest({
      name: pendingApproval.name,
      args: pendingApproval.args,
      ...(pendingApproval.riskLevel != null ? { riskLevel: pendingApproval.riskLevel } : {}),
    })) {
      writeLine(line);
    }
    const answer = await askQuestion(`  ${warn("Allow?")} ${dim("(y/n)")} `);
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
  // Sibling of the coordinator REPL's mode row (#480): the attached truth
  // stays visible as chrome, not just as a scrolled-away banner line.
  setModeRow(renderModeRow({ attachedPid: client.coordinatorPid }));

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
