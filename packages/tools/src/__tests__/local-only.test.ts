/**
 * #880 A — exposure is declared on the definition, and EVERY builtin has
 * made the decision.
 *
 * `localOnly: true` keeps a tool off every serve path and out of every
 * foreign principal's turn. Before #880 the runtime kept a residual name
 * list for builtins that had not declared it, and the CLI's `/serve` kept
 * its own list — which had never named `write_file`, so `/serve
 * --operator` served it. The list is gone; the definition is the one
 * source of truth.
 *
 * This walks every `*Definition` the package exports, so a NEW builtin
 * fails here until it is placed in one of the two tables below — the
 * decision cannot be skipped by forgetting a list.
 */
import { describe, it, expect } from "vitest";
import * as tools from "../index.js";
import type { ToolDefinition } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

/** Act for the owner against this motebit's own interior or machine. */
const LOCAL: Record<string, string> = {
  read_file: "reads this machine's filesystem",
  write_file: "writes this machine's filesystem",
  shell_exec: "executes commands on this machine",
  undo_write: "restores this machine's files from local backups",
  recall_memories: "the owner's memory graph (remote callers get the capped motebit_recall)",
  rewrite_memory: "mutates the owner's memory graph",
  search_conversations: "the owner's verbatim transcripts",
  recall_self: "the interior tier of the owner's answer engine",
  self_reflect: "reflects on the owner's interior",
  list_events: "the owner's event log",
  create_sub_goal: "the owner's goals",
  complete_goal: "the owner's goals",
  report_progress: "the owner's goal progress",
  computer: "drives the owner's real OS or cloud browser session",
  request_control: "co-browse control negotiation with the owner",
  read_page: "reads the owner's open browser session",
};

/** Capabilities a motebit may offer another principal (subject to policy). */
const SERVED: Record<string, string> = {
  current_time: "the clock",
  web_search: "public web search",
  read_url: "public URL fetch, under the outbound URL law",
};

function exportedDefinitions(): ToolDefinition[] {
  return Object.entries(tools)
    .filter(([k, v]) => k.endsWith("Definition") && typeof v === "object" && v !== null)
    .map(([, v]) => v as ToolDefinition)
    .filter((d) => typeof d.name === "string");
}

describe("every builtin declares its exposure (#880 A)", () => {
  it("each exported definition is classified — local ones carry localOnly, served ones do not", () => {
    const defs = exportedDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(19);
    for (const def of defs) {
      const local = def.name in LOCAL;
      const served = def.name in SERVED;
      expect(local || served, `${def.name}: classify it in LOCAL or SERVED`).toBe(true);
      if (local) expect(def.localOnly, `${def.name} must declare localOnly`).toBe(true);
      if (served) expect(def.localOnly, `${def.name} is served`).not.toBe(true);
    }
    // No stale table entries.
    const names = new Set(defs.map((d) => d.name));
    for (const name of [...Object.keys(LOCAL), ...Object.keys(SERVED)]) {
      expect(names.has(name), `${name} is no longer exported`).toBe(true);
    }
  });

  it("rewrite_memory declares itself a write (R2), not a read", () => {
    expect(tools.rewriteMemoryDefinition.riskHint?.risk).toBe(RiskLevel.R2_WRITE);
  });
});
