#!/usr/bin/env tsx
/**
 * Drift defense: every `check-*` gate named in an ALWAYS-LOADED instruction
 * surface must actually exist.
 *
 * `CLAUDE.md` and the per-directory `CLAUDE.md` files are not documentation —
 * they are loaded into an agent's context and acted on as instructions. When
 * the root index ends a doctrine entry with "Gate check-settlement-authority",
 * in the same grammatical form as seven claims that ARE real, a reader auditing
 * "can a discovered settlement_address become a pay-to destination?" concludes
 * the question is structurally closed. If that gate does not exist, the index
 * has asserted enforcement that nothing performs — the most expensive possible
 * drift, because it stops the audit rather than failing it.
 *
 * This is the phantom-enforcement class, and it is the gate suite's own version
 * of the flaw named in docs/doctrine/composition-preserves-enforcement.md:
 * definition and activation living in different places, with nothing checking
 * that the claim and the mechanism still correspond. `check-claude-md` already
 * validates that every doctrine LINK resolves; nothing validated that every
 * gate NAME resolves.
 *
 * ## Scope, and why it stops where it does
 *
 * `CLAUDE.md` files only. Doctrine docs under `docs/doctrine/` are design
 * documents — they legitimately name gates that are deferred-with-trigger
 * ("a check-settlement-authority gate (sibling of check-money-authority) is
 * Inc 4"), and holding them to this rule would punish honest forward planning.
 * The index is different: it is the surface that says what IS.
 *
 * A gate that is genuinely planned may still be named in an index — but it must
 * be declared in `PLANNED_GATES` below with a reason and a pointer to the
 * doctrine that owns it. That converts a silent phantom into a named, owned
 * decision, which is the same move `EXCLUDED_CHECKS` makes in `check.ts`.
 *
 * Repair: either build the gate, or correct the prose to describe it as
 * deferred and register it in `PLANNED_GATES`.
 *
 * ## What this proves, exactly — and what it does not
 *
 * It proves NAME RESOLUTION: the named gate exists as a runnable script. It
 * does NOT prove the gate runs on every PR. Nine resolvable names are not hard
 * CI gates — the seven `EXCLUDED_CHECKS` in `check.ts` (advisory, scheduled, or
 * separate-job) plus the CI-only helpers with no package.json entry. So the
 * index could still assert "Gate `check-model-catalog-drift`" (weekly, needs
 * network + a key) and satisfy this gate, leaving a reader to conclude an
 * invariant is enforced per-PR when it is not — the same audit-stopping shape
 * one notch weaker.
 *
 * That tier distinction is deliberately NOT enforced here: `GATES` and
 * `EXCLUDED_CHECKS` are module-private consts in `check.ts`, and exporting them
 * to satisfy this gate would couple the runner's shape to a doc gate. The
 * claim is therefore narrowed to what it actually establishes, in both the
 * `defends` string and the inventory row. Trigger to tighten: the first index
 * entry that asserts a non-`GATES` check as if it were per-PR enforcement.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

/**
 * Gates deliberately named in an index while still unbuilt. Each entry is a
 * named, owned deferral — not a silent phantom.
 *
 * Keep this list SHRINKING. An entry earns its place only while the index text
 * around it reads as future tense; if the prose asserts the gate as shipped,
 * the entry is a bug regardless of what this map says.
 */
const PLANNED_GATES: Record<string, string> = {
  "check-settlement-authority":
    "Inc 4 of the settlement-authority arc, owned by docs/doctrine/settlement-authority-binding.md. Blocked on Inc 2 — the signed `SettlementBinding` artifact (`signSettlementBinding`/`verifySettlementBinding`) does not exist yet, so there is no second rung for a gate to enforce. Shipped today is Inc 1, the derived rung, enforced in code at services/relay/src/tasks.ts. The root CLAUDE.md entry must keep naming this as NOT built.",
};

/** Every gate name the repo can actually run. */
function realGateNames(repoRoot: string): Set<string> {
  const names = new Set<string>();

  // Gate implementations on disk.
  for (const file of readdirSync(join(repoRoot, "scripts"))) {
    if (file.startsWith("check-") && file.endsWith(".ts")) {
      names.add(file.replace(/\.ts$/, ""));
    }
  }

  // npm script aliases (`check-specs` → check-spec-references.ts, etc.).
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const script of Object.keys(pkg.scripts ?? {})) {
    if (script.startsWith("check")) names.add(script);
  }

  return names;
}

/**
 * Directories that never hold an instruction surface. Mirrors
 * `SKIP_DIRS` in check-claude-md.ts — see `instructionSurfaces` for why the
 * two gates must agree on the corpus.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".git",
  ".changeset",
  "coverage",
  ".husky",
  ".claude",
  ".vercel",
  "out",
  "target",
]);

/**
 * Every always-loaded instruction surface: root + every other `CLAUDE.md`.
 *
 * Walks the whole repo rather than a hardcoded `packages`/`services`/`apps`
 * list, because `check-claude-md` — the gate this one extends — walks the whole
 * repo to index them. A hardcoded list agrees with that walk only by accident
 * of the current layout: a `CLAUDE.md` added at `docs/`, `scripts/`, or nested
 * at `packages/x/sub/` would be indexed and link-validated there and silently
 * unscanned here, forever, with nothing detecting the divergence. A gate whose
 * own coverage set is narrower than it claims is the aperture hole this gate
 * family exists to close.
 */
function instructionSurfaces(repoRoot: string): string[] {
  const files: string[] = [];
  if (existsSync(join(repoRoot, "CLAUDE.md"))) files.push("CLAUDE.md");
  // `AGENTS.md` is the cross-tool convention some agents read instead of
  // CLAUDE.md, so it is an always-loaded instruction surface too and must be
  // held to the same standard. It earned its place here: the first version was
  // a mechanical find-replace of CLAUDE.md that shipped a reference to a gate
  // named `check-Codex-md` — a phantom, produced by the same substitution that
  // rewrote every real path. Scanning only CLAUDE.md left this gate with the
  // exact aperture hole it exists to close.
  if (existsSync(join(repoRoot, "AGENTS.md"))) files.push("AGENTS.md");

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — leave to other tooling
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name === "CLAUDE.md" || entry.name === "AGENTS.md")) {
        const rel = relative(repoRoot, full);
        if (rel !== "CLAUDE.md" && rel !== "AGENTS.md") files.push(rel);
      }
    }
  };
  walk(repoRoot);

  return files;
}

/**
 * A gate mention. The leading `(?<![-\w])` matters: `\b` alone matches `check-`
 * as a NON-INITIAL component of any hyphenated compound, because `-` is a
 * non-word character — `spell-check-mode` would yield `check-mode`, and the
 * repair instruction would tell the reader to go build a gate by that name.
 *
 * The character class is case-INSENSITIVE while the comparison against real
 * gate names stays case-SENSITIVE, and that asymmetry is the point. Real gates
 * are lowercase-kebab, so a mixed-case mention can never resolve — it is a
 * phantom by construction. A lowercase-only pattern silently skipped them:
 * the `check-Codex-md` that shipped in `AGENTS.md` (a blind find-replace of
 * `check-claude-md`) went unmatched, which is precisely the case this gate is
 * cited as catching. A gate blind to the incident that justifies it is worse
 * than no gate.
 */
const GATE_MENTION = /(?<![-\w])check-[A-Za-z0-9][A-Za-z0-9-]*/g;

function main(): void {
  const repoRoot = process.cwd();
  const real = realGateNames(repoRoot);
  const surfaces = instructionSurfaces(repoRoot);

  const violations: Array<{ file: string; line: number; name: string; text: string }> = [];
  const usedPlanned = new Set<string>();

  for (const file of surfaces) {
    const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(GATE_MENTION)) {
        const name = match[0];
        // A trailing hyphen means the token is cut off — a hand-wrapped
        // `check-money-` / `authority` across two lines. SKIP rather than
        // strip: stripping would report a violation named `check-money`, a
        // name that appears nowhere in the file, sending the reader to a site
        // that does not say what the gate claims it says. A false negative on
        // a wrapped name is cheaper than a misleading repair instruction.
        if (name.endsWith("-")) continue;
        if (real.has(name)) continue;
        if (name in PLANNED_GATES) {
          usedPlanned.add(name);
          continue;
        }
        violations.push({ file, line: i + 1, name, text: line.trim().slice(0, 140) });
      }
    });
  }

  // A planned-gate entry that is no longer referenced (or has since been built)
  // is stale scaffolding — the same stale-waiver detection the README-exports
  // gate performs.
  const stale = Object.keys(PLANNED_GATES).filter((n) => real.has(n) || !usedPlanned.has(n));

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "every `check-*` gate named in an always-loaded CLAUDE.md must exist — an index that asserts enforcement nothing performs stops an audit instead of failing it",
      sites: violations.map((v) => `${v.file}:${v.line} — "${v.name}" in: ${v.text}`),
      canonical: "scripts/ (gate implementations) + the `scripts` block of package.json",
      fix: "Either build the named gate (add scripts/<name>.ts and register it in the GATES array of scripts/check.ts), or — if it is genuinely deferred — reword the index so it reads as future work AND add the name to PLANNED_GATES in scripts/check-gate-references.ts with a reason and the doctrine doc that owns it.",
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }

  if (stale.length > 0) {
    failWithRepair({
      invariant: "PLANNED_GATES carries a stale entry",
      sites: stale.map((n) =>
        real.has(n)
          ? `${n} — now exists; the deferral entry is obsolete`
          : `${n} — no longer referenced by any CLAUDE.md`,
      ),
      canonical: "scripts/check-gate-references.ts (PLANNED_GATES)",
      fix: "Remove the obsolete entry from PLANNED_GATES so the list keeps shrinking.",
    });
  }

  const mentions = surfaces.length;
  console.log(
    `✓ Every \`check-*\` gate named across ${mentions} CLAUDE.md instruction surface(s) resolves to a real gate (${real.size} known).`,
  );
}

main();
