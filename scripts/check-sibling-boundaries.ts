/**
 * Sibling boundary audit for the Motebit monorepo.
 *
 * Enforces the "sibling boundary rule" from CLAUDE.md:
 *   "When you fix a boundary (auth, policy, validation, rendering),
 *    audit all sibling boundaries for the same gap in the same pass."
 *
 * Reads changed files from stdin or CLI args, checks if any belong to a
 * boundary group, and warns about unchanged siblings. Advisory only (exit 0).
 *
 * Usage:
 *   git diff --name-only origin/main...HEAD | npx tsx scripts/check-sibling-boundaries.ts
 *   npx tsx scripts/check-sibling-boundaries.ts file1.ts file2.ts
 */

// ── Boundary group definitions ────────────────────────────────────────
// Each group lists files that are "siblings" — when one changes, the
// others should be reviewed for the same class of change.
//
// To add a new group: append an entry below. To add a file to an
// existing group: add its repo-relative path to the array.

interface BoundaryGroup {
  name: string;
  description: string;
  files: string[];
}

const BOUNDARY_GROUPS: BoundaryGroup[] = [
  {
    name: "auth_boundaries",
    description: "Authentication, token signing/verification, bearer auth",
    files: [
      "services/relay/src/auth.ts",
      "services/relay/src/middleware.ts",
      "packages/crypto/src/index.ts",
      "packages/mcp-server/src/index.ts",
    ],
  },
  {
    name: "policy_boundaries",
    description: "Policy gate, risk model, memory governance, content sanitization",
    files: [
      "packages/policy/src/policy-gate.ts",
      "packages/policy/src/risk-model.ts",
      "packages/policy/src/budget.ts",
      "packages/policy/src/memory-governance.ts",
      "packages/policy/src/sanitizer.ts",
      "packages/policy/src/redaction.ts",
    ],
  },
  {
    name: "rate_limiting",
    description: "Rate limiting across request tiers, WebSocket, federation",
    files: [
      "services/relay/src/rate-limiter.ts",
      "services/relay/src/middleware.ts",
      "services/relay/src/federation.ts",
      "services/relay/src/websocket.ts",
    ],
  },
  {
    name: "identity_boundaries",
    description: "Identity creation, file format, verification, cryptographic binding",
    files: [
      "packages/core-identity/src/index.ts",
      "packages/identity-file/src/index.ts",
      "packages/crypto/src/index.ts",
      "packages/crypto/src/index.ts",
      "packages/crypto/src/credentials.ts",
    ],
  },
  {
    name: "settlement_boundaries",
    description: "Budget allocation, settlement, account balances, market budget",
    files: [
      "packages/market/src/settlement.ts",
      "packages/market/src/budget.ts",
      "services/relay/src/accounts.ts",
      "services/relay/src/budget.ts",
    ],
  },
  {
    name: "trust_boundaries",
    description: "Trust scoring, credential weighting, reputation, sybil defense",
    files: [
      "packages/market/src/credential-weight.ts",
      "packages/market/src/reputation.ts",
      "packages/market/src/scoring.ts",
      "packages/policy/src/reputation.ts",
      "services/relay/src/credentials.ts",
      "services/relay/src/trust-graph.ts",
    ],
  },
  {
    name: "federation_boundaries",
    description: "Federation peering, circuit breaker, callbacks, peer auth",
    files: ["services/relay/src/federation.ts", "services/relay/src/federation-callbacks.ts"],
  },
  {
    name: "sync_encryption_boundaries",
    description: "Encrypted sync adapters, privacy layer, data-sync relay module",
    files: [
      "packages/sync-engine/src/encrypted-adapter.ts",
      "packages/sync-engine/src/encrypted-conversation-adapter.ts",
      "packages/sync-engine/src/encrypted-plan-adapter.ts",
      "packages/privacy-layer/src/index.ts",
      "services/relay/src/data-sync.ts",
    ],
  },
  {
    name: "key_rotation_boundaries",
    description: "Key succession, rotation, signed tombstones",
    files: [
      "services/relay/src/key-rotation.ts",
      "packages/crypto/src/index.ts",
      "packages/core-identity/src/index.ts",
    ],
  },
  {
    name: "scene_primitives",
    description:
      "Scene renderers + SpatialExpression kinds — credentials, receipts, and future agents/goals/memory. When one extracts to @motebit/render-engine or adds a kind, the siblings should move through the same pass (check-scene-primitives gate, invariant #26).",
    files: [
      "packages/render-engine/src/expression.ts",
      "packages/render-engine/src/credential-satellites.ts",
      "apps/spatial/src/receipt-satellites.ts",
      "apps/spatial/src/__tests__/spatial-expression.neg.test.ts",
      "apps/web/src/scene/credential-satellites.ts",
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────

async function readChangedFiles(): Promise<string[]> {
  // Try CLI args first
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args;
  }

  // Otherwise read from stdin (piped)
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks)
      .toString("utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  return [];
}

interface Warning {
  group: string;
  description: string;
  changedFile: string;
  missingSiblings: string[];
}

function checkSiblings(changedFiles: string[]): Warning[] {
  const changedSet = new Set(changedFiles);
  const warnings: Warning[] = [];
  const seenGroups = new Set<string>();

  for (const file of changedFiles) {
    for (const group of BOUNDARY_GROUPS) {
      // Skip if we already reported this group
      if (seenGroups.has(group.name)) continue;

      if (!group.files.includes(file)) continue;

      const missingSiblings = group.files.filter(
        (sibling) => sibling !== file && !changedSet.has(sibling),
      );

      if (missingSiblings.length > 0) {
        seenGroups.add(group.name);
        warnings.push({
          group: group.name,
          description: group.description,
          changedFile: file,
          missingSiblings,
        });
      }
    }
  }

  return warnings;
}

function formatMarkdown(warnings: Warning[]): string {
  if (warnings.length === 0) {
    return "### Sibling Boundary Audit\n\nNo sibling boundary warnings. All changed boundary files have their siblings covered.\n";
  }

  const lines: string[] = [
    "### Sibling Boundary Audit",
    "",
    `Found **${warnings.length}** boundary group(s) where siblings were not changed together.`,
    "The [sibling boundary rule](../CLAUDE.md) says: *when you fix a boundary, audit all sibling boundaries for the same gap in the same pass.*",
    "",
  ];

  for (const w of warnings) {
    lines.push(`#### ${w.group}`);
    lines.push(`> ${w.description}`);
    lines.push("");
    lines.push(`You changed \`${w.changedFile}\`. Please audit these siblings:`);
    lines.push("");
    for (const s of w.missingSiblings) {
      lines.push(`- [ ] \`${s}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatConsole(warnings: Warning[]): string {
  if (warnings.length === 0) {
    return "Sibling boundary audit: no warnings.\n";
  }

  const lines: string[] = [`Sibling boundary audit: ${warnings.length} warning(s)\n`];

  for (const w of warnings) {
    lines.push(`[${w.group}] ${w.description}`);
    lines.push(`  Changed: ${w.changedFile}`);
    lines.push(`  Audit these siblings:`);
    for (const s of w.missingSiblings) {
      lines.push(`    - ${s}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const changedFiles = await readChangedFiles();

  if (changedFiles.length === 0) {
    console.log("Sibling boundary audit: no changed files provided.\n");
    process.exit(0);
  }

  const warnings = checkSiblings(changedFiles);

  // Console output
  console.log(formatConsole(warnings));

  // If running in GitHub Actions, also write markdown to step summary
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, formatMarkdown(warnings));
  }

  // Advisory — always exit 0
  process.exit(0);
}

main().catch((err) => {
  console.error("Sibling boundary audit failed:", err instanceof Error ? err.message : String(err));
  process.exit(0); // Advisory — don't break CI even if the script itself errors
});
