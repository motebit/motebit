---
"motebit": minor
---

Skills phase 2 — operator-gated script execution via `motebit skills run-script <skill> <script-name> [args...]`.

Closes the `spec/skills-v1.md` §10 + §13 gap where `scripts/` files were stored at install but never executable. The directory layout IS the quarantine (no auto-execution path exists); each invocation is gated through the canonical operator approval queue (`SqliteApprovalStore` from `@motebit/persistence`) — same store the existing `motebit approvals list/show/approve/deny` surface reads. Per-script invocation creates a row at `RiskLevel.R3_EXECUTE` with `tool_name: "skill.script:<skill>/<script>"`.

```text
$ motebit skills run-script my-skill build.sh --release
  Skill script execution requested
  Skill:        my-skill
  Script:       build.sh (412 bytes)
  Args:         --release
  Approval ID:  appr-skill-lq8r…

  Approve execution? [y/N] y
  ↳ ./build.sh runs with stdio inherited; exit code passes through
```

Interpreter detection: shebang takes precedence (POSIX `#!` line); fallback by extension (`.js`/`.mjs`/`.cjs` → `node`, `.py` → `python3`, `.sh`/`.bash` → `bash`, `.rb` → `ruby`); reject if neither resolves so the audit row's approval doesn't grant execution of an opaque format. `--auto-approve` (or `MOTEBIT_AUTO_APPROVE=1`) skips the prompt for scripted/CI use but STILL records the approval row pre-resolved for audit.

Drift gate `check-skill-script-uses-tool-approval` (invariant #69) catches any TS file that reads bytes from a skill's `scripts/` tree, imports `node:child_process`, and calls a spawn primitive but never invokes `approvalStore.add(...)`. Heuristic gate (lexical co-occurrence within a single file); `// eslint-disable check-skill-script-uses-tool-approval` near the spawn site escapes a known false positive. Effectiveness probe in `check-gates-effective.ts` plants a fixture that bypasses the approval store; the gate fires.

AI-callable scripts as registered tools (the runtime exposes `skill.script:*` to the AI's tool catalog with the same approval gate) is deferred to phase 2.5 — bigger surface (tool registration + args schema + per-tool MCP-style description).
