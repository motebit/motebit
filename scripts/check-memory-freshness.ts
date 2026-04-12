#!/usr/bin/env tsx
/**
 * check-memory-freshness — soft signal for memory ↔ code drift.
 *
 * Reports every auto-memory file by age, with a description excerpt. The
 * operator eyeballs this to decide which memories need re-verification
 * against current code. Not a CI gate — memories can legitimately outlast
 * specific code citations (principles outlive renames).
 *
 * Policy: before acting on a memory's specific claim (file:line, function
 * name, config flag), verify it against current code. If the memory is
 * wrong, update it. If it's architecturally stale, rewrite; never just
 * delete unless the premise no longer applies.
 *
 * Exit codes:
 *   0 — always
 *
 * Usage:
 *   pnpm check-memory
 *   pnpm check-memory --older-than 14   # filter to memories older than 14 days
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Match the path pattern auto-memory uses for this project
const MEMORY_DIR = join(homedir(), ".claude/projects/-Users-daniel-src-motebit/memory");

interface MemoryEntry {
  filename: string;
  lastModified: Date;
  ageDays: number;
  description: string;
  type: string;
}

function parseFrontmatter(content: string): { description: string; type: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: "", type: "" };
  const fm = match[1]!;
  const descMatch = fm.match(/description:\s*(.+)/);
  const typeMatch = fm.match(/type:\s*(.+)/);
  return {
    description: descMatch?.[1]?.trim() ?? "",
    type: typeMatch?.[1]?.trim() ?? "",
  };
}

function collectMemories(): MemoryEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(MEMORY_DIR);
  } catch {
    console.error(`Memory directory not found: ${MEMORY_DIR}`);
    process.exit(0); // soft — no memory dir is not an error
  }

  const now = Date.now();
  const out: MemoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
    const full = join(MEMORY_DIR, entry);
    const stat = statSync(full);
    const content = readFileSync(full, "utf-8");
    const { description, type } = parseFrontmatter(content);
    out.push({
      filename: entry,
      lastModified: stat.mtime,
      ageDays: Math.floor((now - stat.mtime.getTime()) / 86_400_000),
      description: description.slice(0, 120),
      type,
    });
  }

  return out.sort((a, b) => b.ageDays - a.ageDays);
}

function parseOlderThan(): number {
  const idx = process.argv.indexOf("--older-than");
  if (idx === -1 || idx === process.argv.length - 1) return 0;
  const n = parseInt(process.argv[idx + 1]!, 10);
  return Number.isFinite(n) ? n : 0;
}

function main(): void {
  const olderThan = parseOlderThan();
  const memories = collectMemories();
  const filtered = olderThan > 0 ? memories.filter((m) => m.ageDays >= olderThan) : memories;

  if (filtered.length === 0) {
    console.log(olderThan > 0 ? `No memories older than ${olderThan} days.` : "No memories found.");
    return;
  }

  console.log("Auto-memories by age (oldest first):\n");
  for (const m of filtered) {
    const ageLabel = m.ageDays === 0 ? "today" : m.ageDays === 1 ? "1 day" : `${m.ageDays} days`;
    const marker = m.ageDays >= 14 ? "⚠ " : "  ";
    console.log(`${marker}${m.filename.padEnd(50)} ${ageLabel.padStart(8)} · [${m.type}]`);
    if (m.description) {
      console.log(`      ${m.description}${m.description.length === 120 ? "…" : ""}`);
    }
  }

  const stale = memories.filter((m) => m.ageDays >= 14).length;
  console.log(
    `\n${memories.length} memories total${stale > 0 ? `, ${stale} older than 14 days` : ""}.`,
  );
  if (stale > 0) {
    console.log(
      "\n⚠ Memories older than 14 days may cite code that has moved. Verify specific\n" +
        "  claims (file:line, function names, config flags) against current code before\n" +
        "  acting on them. If stale: rewrite the claim, don't just delete.",
    );
  }
}

main();
