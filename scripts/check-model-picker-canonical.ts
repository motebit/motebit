#!/usr/bin/env tsx
/**
 * check-model-picker-canonical — every surface's Anthropic model picker is
 * rendered from `@motebit/sdk` (`ANTHROPIC_PICKER`, `pickerModelForTier`,
 * `DEFAULT_ANTHROPIC_MODEL`), never hand-copied (#654).
 *
 * Born 2026-09-30: after Opus 5.5 and Sonnet 5 shipped, the surfaces
 * disagreed about which Claude models exist. Web's BYOK <select> offered
 * Opus 4.7 / Sonnet 4.6 (hand-typed in index.html), desktop's placeholder
 * pinned an old id, the CLI's `/model haiku` alias named a non-registry id,
 * and `--help` printed a default the code no longer used. Each copy was
 * correct the day it was typed; nothing tied it to the registry, so every
 * Claude release silently staled N copies.
 *
 * Rule — DENY BY DEFAULT over the whole aperture (#654 cold review C4). The
 * first version scanned only quoted literals in `src/**` .ts/.tsx/.html with
 * comments stripped and a line-substring allowlist; a cold review exited 0
 * on concatenation, template literals, `.join`, UPPERCASE, the legacy
 * `claude-3-5-sonnet-…` shape, unquoted attributes, `<option>` text content,
 * `public/*.html`, `.js/.mjs/.json`, root-level `.ts`, `.mdx`, an id after
 * " // " inside a string, and a stale `<option>` appended to an allowlisted
 * line. That is the pattern-match class; the fix is to stop pattern-matching
 * on CONTEXT and match on the TOKEN, everywhere:
 *
 *   Aperture: EVERY git-tracked (and untracked, non-ignored) text file under
 *   `apps/` — all extensions, `public/`, app roots, tests, docs, changelogs.
 *   Case-insensitive. No comment stripping (a comment is a copy too).
 *
 *   Flagged tokens:
 *     ID       `claude` + optional `-`/`_` + a family (opus|sonnet|haiku|
 *              fable|mythos|instant) or a digit, then the id tail —
 *              `claude-sonnet-5`, `CLAUDE_OPUS_5_5`, `claude-3-5-sonnet-…`.
 *     LABEL    the spaced display form with a version — `Claude Opus 4.7`.
 *     FRAGMENT `claude` / `claude-` immediately followed by a quote, backtick
 *              or `${` — the visible head of a concatenation, template
 *              literal or `[...].join` that assembles an id at runtime.
 *
 *   Allowlist: per (file, EXACT token as written, why) — never per line. A
 *   listed token is exempt only in its file, only in that exact spelling;
 *   every listed (file, token) pair that no longer occurs is itself red.
 *
 *   What the scan cannot see: an id assembled from pieces that never spell
 *   `claude` next to a quote (`"cla" + "ude-…"`, a lookup table keyed by
 *   tier). Those are covered by EXECUTION, not by this scan: each surface's
 *   settings test renders the real UI and asserts the Anthropic rows equal
 *   `ANTHROPIC_PICKER` (web/desktop/spatial `settings-anthropic-picker.test`,
 *   mobile `intelligence-tab-picker.test`), so a dynamically-constructed
 *   picker that diverges is red there.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRepair } from "./lib/gate-report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const FAMILY = "(?:opus|sonnet|haiku|fable|mythos|instant)";
const RULES: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: "id", re: new RegExp(`claude[-_]?(?:${FAMILY}|\\d)[a-z0-9._-]*`, "gi") },
  { kind: "label", re: new RegExp(`claude\\s+${FAMILY}\\s+\\d+(?:\\.\\d+)?`, "gi") },
  { kind: "fragment", re: /claude[-_]?(?=["'`]|\$\{)/gi },
];

interface AllowEntry {
  /** Repo-relative path. */
  readonly file: string;
  /** Exact tokens as written (case-sensitive) exempt in this file only. */
  readonly ids: readonly string[];
  /** Why these are not a hand-copied Anthropic picker / default. */
  readonly why: string;
}

const CLOUD_LANE =
  "Motebit Cloud (#cloud-model) selector — its list is the Cloud catalog's concern, out of #654 scope (Cloud/proxy untouched).";
const TEST_FIXTURE =
  "test fixture: a stored / typed / legacy id the test feeds in to prove it is shown, admitted or refused — the test's subject, not a picker copy.";
const DOCS_PICKER =
  "docs prose naming the current picker rows; kept in sync with @motebit/sdk by check-docs-default-models (#56), its own drift gate.";
const CHANGELOG = "release history: records what shipped at that version; immutable by design.";
const GENERATED =
  "generated JSON Schema: the default is interpolated from DEFAULT_ANTHROPIC_MODEL in apps/cli/src/yaml-config.ts and the committed file is regenerated from it.";
const LLMS_FULL =
  "generated concatenation of the docs content (the DOCS_PICKER pages above); regenerated with the docs, never hand-edited.";

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "apps/web/index.html",
    ids: ["claude-sonnet-4-20250514", "claude-opus-4-20250115", "claude-haiku-4-5-20251001"],
    why: CLOUD_LANE,
  },
  {
    file: "apps/cli/schema/motebit-yaml-v1.json",
    ids: ["claude-sonnet-5"],
    why: GENERATED,
  },
  {
    file: "apps/cli/CHANGELOG.md",
    ids: [
      "Claude-5",
      "claude-haiku-4-5",
      "claude-opus",
      "claude-opus-4-6",
      "claude-opus-4-6-20250414",
      "claude-opus-5",
      "claude-sonnet-4-5-latest",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
    ],
    why: CHANGELOG,
  },
  {
    file: "apps/docs/content/docs/apps/cli.mdx",
    ids: ["claude-sonnet-5"],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/content/docs/apps/configuration.mdx",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/content/docs/apps/desktop.mdx",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-sonnet-5",
    ],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/public/llms-full.txt",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ],
    why: LLMS_FULL,
  },
  {
    file: "apps/cli/src/__tests__/bare-command-routing.test.ts",
    ids: ["claude-opus-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/index.test.ts",
    ids: ["claude-haiku-3"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/mode-render.test.ts",
    ids: ["claude-opus-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/model-admission.test.ts",
    ids: ["claude-opus-5", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/money-flows.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/terminal-render.test.ts",
    ids: ["claude-haiku-4-5", "claude-opus-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/desktop/src/__tests__/index.test.ts",
    ids: ["claude-haiku-4-5-20251001"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/desktop/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/intelligence-tab-picker.test.tsx",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/mobile-app.test.ts",
    ids: ["claude-haiku-4-5-20251001", "claude-sonnet"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/slash-commands.test.ts",
    ids: ["claude-haiku-4-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/spatial/src/__tests__/providers.test.ts",
    ids: ["claude-3"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/spatial/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/anthropic-picker.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/bootstrap.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/providers.test.ts",
    ids: ["claude-sonnet-4-20250514"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/storage.test.ts",
    ids: ["claude-opus-4-6", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/web-app.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
];

function trackedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter((f) => f !== ""))].sort();
}

/** Text = readable and no NUL in the first 8 KiB (git's own heuristic). */
function readText(rel: string): string | null {
  const abs = path.join(REPO_ROOT, rel);
  let buf: Buffer;
  try {
    if (!fs.statSync(abs).isFile()) return null;
    buf = fs.readFileSync(abs);
  } catch {
    return null; // deleted in the worktree but still in the index
  }
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly token: string;
  readonly kind: string;
  readonly source: string;
}

function main(): void {
  const files = trackedFiles();
  const findings: Finding[] = [];
  const seenAllow = new Set<string>(); // `${file}\0${token}`
  const allowed = new Map<string, Set<string>>();
  for (const a of ALLOWLIST) {
    const s = allowed.get(a.file) ?? new Set<string>();
    for (const id of a.ids) s.add(id);
    allowed.set(a.file, s);
  }

  let textFiles = 0;
  for (const rel of files) {
    const src = readText(rel);
    if (src == null) continue;
    textFiles++;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const { kind, re } of RULES) {
        for (const m of line.matchAll(re)) {
          // A sentence-final "." / "-" is punctuation, not part of the id.
          const token = m[0].replace(/[._-]+$/, "");
          if (allowed.get(rel)?.has(token)) {
            seenAllow.add(`${rel}\0${token}`);
            continue;
          }
          findings.push({ file: rel, line: i + 1, token, kind, source: line.trim() });
        }
      }
    });
  }

  const stale = ALLOWLIST.flatMap((a) =>
    a.ids.filter((id) => !seenAllow.has(`${a.file}\0${id}`)).map((id) => ({ file: a.file, id })),
  );
  const pairs = ALLOWLIST.reduce((n, a) => n + a.ids.length, 0);

  console.log(
    `▸ check-model-picker-canonical — aperture: ${textFiles} text file(s) of ${files.length} git-tracked/untracked-unignored path(s) under apps/ (all extensions, case-insensitive, comments included); ${seenAllow.size} of ${pairs} allowlisted (file, token) pair(s) matched. Dynamically-assembled ids that never spell "claude" beside a quote are covered by the per-surface settings execution tests, not this scan.`,
  );

  if (findings.length === 0 && stale.length === 0) {
    console.log(
      `✓ check-model-picker-canonical: 0 Claude model-id tokens outside the allowlist across ${textFiles} file(s); every Anthropic picker renders from @motebit/sdk ANTHROPIC_PICKER.`,
    );
    return;
  }

  let out = "";
  if (findings.length > 0) {
    out += formatRepair({
      invariant: `${findings.length} Claude model-id token(s) under apps/ outside the allowlist — a hand-copied picker row, default, alias or label that will stale on the next Claude release.`,
      canonical:
        "packages/sdk/src/models.ts (ANTHROPIC_PICKER, pickerModelForTier, pickerOptionsWithStored, DEFAULT_ANTHROPIC_MODEL, defaultModelForProvider)",
      fix:
        "import the id from @motebit/sdk instead — render picker rows with pickerOptionsWithStored()/ANTHROPIC_PICKER, " +
        "resolve a tier with pickerModelForTier(), a provider default with defaultModelForProvider(). Do not assemble an " +
        "id from pieces. If the token is genuinely not a picker copy (a test fixture, the Cloud selector, release history), " +
        "add {file, ids: [exact token], why} to ALLOWLIST in scripts/check-model-picker-canonical.ts.",
      sites: findings.map(
        (f) => `${f.file}:${f.line}  [${f.kind}] ${f.token}  — ${f.source.slice(0, 110)}`,
      ),
      doctrine: "docs/doctrine/intelligence-pluggability-contract.md; docs/drift-defenses.md",
    });
  }
  if (stale.length > 0) {
    out += formatRepair({
      invariant: `${stale.length} stale ALLOWLIST (file, token) pair(s) — the argued exception no longer occurs in that file.`,
      canonical: "scripts/check-model-picker-canonical.ts (ALLOWLIST)",
      fix: "remove the stale token from the entry's `ids` (drop the entry when it empties).",
      sites: stale.map((s) => `${s.file}: ${s.id}`),
    });
  }
  process.stderr.write(out);
  process.exit(1);
}

main();
