/**
 * Command dispatcher — routes intent to handler, returns structured result.
 *
 * This file is the ONLY entry point. It dispatches and nothing else.
 * Business logic lives in the runtime. Formatting lives in the handlers.
 * Modality logic lives in the surfaces.
 */

import type { MotebitRuntime } from "../index";
import type { CommandResult, RelayConfig } from "./types";
import {
  cmdState,
  cmdModel,
  cmdTools,
  cmdApprovals,
  cmdConversations,
  cmdSummarize,
} from "./system";
import { cmdMemories, cmdGraph, cmdCurious, cmdForget, cmdAudit } from "./memory";
import { cmdGradient, cmdReflect } from "./intelligence";
import { cmdBalance, cmdDeposits, cmdDiscover, cmdProposals } from "./market";

// Re-export types
export type { CommandResult, RelayConfig } from "./types";

/**
 * All commands the shared layer can execute. Surface-specific commands
 * (open panel, export, serve, mcp) are not listed here.
 */
export const COMMAND_DEFINITIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "state", description: "Show state vector" },
  { name: "model", description: "Show current model" },
  { name: "tools", description: "List registered tools" },
  { name: "memories", description: "Memory summary" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Show curiosity targets" },
  { name: "forget", description: "Delete a memory by keyword" },
  { name: "audit", description: "Audit memory integrity" },
  { name: "gradient", description: "Intelligence gradient" },
  { name: "reflect", description: "Trigger self-reflection" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "balance", description: "Show account balance" },
  { name: "deposits", description: "Show deposit history" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "proposals", description: "List active proposals" },
  { name: "conversations", description: "List conversations" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "propose", description: "Propose collaborative plan" },
];

/**
 * Execute a runtime command and return a structured result.
 *
 * Returns null if the command is not recognized by this layer (surface should handle it).
 * Throws on runtime errors (caller should catch and display).
 */
export async function executeCommand(
  runtime: MotebitRuntime,
  command: string,
  args?: string,
  relay?: RelayConfig,
): Promise<CommandResult | null> {
  switch (command) {
    // System
    case "state":
      return cmdState(runtime);
    case "model":
      return cmdModel(runtime);
    case "tools":
      return cmdTools(runtime);
    case "approvals":
      return cmdApprovals(runtime);
    case "conversations":
      return cmdConversations(runtime);
    case "summarize":
      return cmdSummarize(runtime);

    // Memory
    case "memories":
      return cmdMemories(runtime);
    case "graph":
      return cmdGraph(runtime);
    case "curious":
      return cmdCurious(runtime);
    case "forget":
      return cmdForget(runtime, args);
    case "audit":
      return cmdAudit(runtime);

    // Intelligence
    case "gradient":
      return cmdGradient(runtime);
    case "reflect":
      return cmdReflect(runtime);

    // Market (require relay)
    case "balance":
      return relay ? cmdBalance(relay) : { summary: "Not connected to relay." };
    case "deposits":
      return relay ? cmdDeposits(relay) : { summary: "Not connected to relay." };
    case "discover":
      return relay ? cmdDiscover(relay) : { summary: "Not connected to relay." };
    case "proposals":
      return relay ? cmdProposals(relay) : { summary: "Not connected to relay." };

    // Informational (no runtime access needed)
    case "withdraw":
      return { summary: "Withdrawals require the CLI for secure signing. Run: motebit withdraw" };
    case "delegate":
      return {
        summary:
          "Delegation happens transparently during conversation when connected to a relay. " +
          "To delegate manually, use the CLI: motebit delegate",
      };
    case "propose":
      return { summary: "Collaborative proposals require the CLI. Run: motebit propose" };

    default:
      return null;
  }
}
