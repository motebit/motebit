/**
 * `motebit init` — scaffold a commented `motebit.yaml` in the current
 * directory. Companion to `motebit up`: declare here, apply there.
 *
 * Separate from `npm create motebit` which scaffolds a whole agent project
 * including identity files; `init` is about adding a declarative config to
 * an already-initialized motebit.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CliConfig } from "../args.js";

const DEFAULT_PATH = "motebit.yaml";

const SCAFFOLD = `# motebit.yaml — declarative config for a motebit.
#
# Apply with:   motebit up
# Inspect with: motebit ps
# Tail logs:    motebit logs <routine-id> --tail
#
# Only the fields listed here are declarative. Identity (motebit_id, keys,
# device_id) and the relay URL are device-local and managed by
# \`motebit register\` — yaml never overwrites them.

version: 1

# Optional personality — overrides ~/.motebit/config.json on \`up\`.
# name: "Aria"
# personality_notes: |
#   Warm, concise, asks before inferring.
# temperature: 0.6

# Optional governance. Approval presets: cautious | balanced | autonomous.
# governance:
#   approvalPreset: balanced
#   persistenceThreshold: 0.7
#   rejectSecrets: true
#   maxCallsPerTurn: 12
#   maxMemoriesPerTurn: 6

# Optional MCP servers. Each entry must have a name and transport.
# Secrets (authToken, credentials) are NOT declared here — they come from
# env or keyring at connect time.
# mcp_servers:
#   - name: filesystem
#     transport: stdio
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
#     trusted: true

# Routines — named, scheduled units. Each compiles to exactly one Goal row.
# routine id must be lowercase alphanumeric + _ or -. Use \`motebit up --prune\`
# to delete routines removed from this file.
routines: []
#   - id: daily-digest
#     prompt: "Summarize my pinned memories from the past 24 hours."
#     every: 24h
#   - id: weekly-reflection
#     prompt: "What themes recurred in conversation this week?"
#     every: 7d
#     wall_clock: 10m
`;

export function handleInit(config: CliConfig): void {
  const targetRelative = config.file ?? DEFAULT_PATH;
  const target = path.isAbsolute(targetRelative)
    ? targetRelative
    : path.join(process.cwd(), targetRelative);

  if (fs.existsSync(target) && !config.force) {
    console.error(
      `Error: ${target} already exists. Edit it directly, or pass --force to overwrite.`,
    );
    process.exit(1);
  }

  fs.writeFileSync(target, SCAFFOLD, "utf-8");
  console.log(`Wrote ${target}`);
  console.log("Next: edit the file to declare routines, then run `motebit up`.");
}
