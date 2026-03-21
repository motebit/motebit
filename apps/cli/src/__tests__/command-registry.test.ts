import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMANDS } from "../args.js";

describe("command registry", () => {
  // Extract top-level command names from the COMMANDS registry
  const registryCommands = new Set(
    COMMANDS.map((c) => {
      // "/goal add ..." → "goal", "/help" → "help"
      const match = c.usage.match(/^\/(\S+)/);
      return match ? match[1] : "";
    }),
  );

  // Extract switch case names from the handler source
  const source = readFileSync(resolve(import.meta.dirname, "../slash-commands.ts"), "utf-8");
  const casePattern = /^\s+case "(\w+)":/gm;
  const switchCases = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = casePattern.exec(source)) !== null) {
    switchCases.add(match[1]);
  }

  it("every switch case has a COMMANDS registry entry", () => {
    const missing = [...switchCases].filter((c) => !registryCommands.has(c));
    expect(missing, `Switch cases missing from COMMANDS: ${missing.join(", ")}`).toEqual([]);
  });

  it("every COMMANDS registry entry has a switch case", () => {
    const orphaned = [...registryCommands].filter((c) => !switchCases.has(c));
    expect(orphaned, `COMMANDS entries with no switch case: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("no duplicate usage patterns in COMMANDS", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of COMMANDS) {
      if (seen.has(c.usage)) dupes.push(c.usage);
      seen.add(c.usage);
    }
    expect(dupes, `Duplicate COMMANDS entries: ${dupes.join(", ")}`).toEqual([]);
  });
});
