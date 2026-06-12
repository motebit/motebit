#!/usr/bin/env tsx
/**
 * check-runtime-host-election — every shared-machine runtime host
 * constructs its `MotebitRuntime` only behind the runtime-host
 * election.
 *
 * The keystone invariant of `docs/doctrine/daemon-desktop-unification.md`:
 * ONE sovereign runtime per machine. Two node processes that each
 * `new MotebitRuntime(...)` against the same `~/.motebit` share one
 * identity key and one SQLite file and become two uncoordinated
 * policy/signing/receipt authorities — the exact four-runtimes ground
 * truth the arc was commissioned to end (finding-h at the process
 * level). The election (`electRuntimeHost` and its surface wrappers)
 * makes the first process the coordinator and every other process an
 * attached frontend, so authority is single by construction.
 *
 * This gate locks that end state: a NEW `new MotebitRuntime(` entry
 * point under a shared-machine host that does not route through the
 * election is the regression the whole arc forbids. The increment-5
 * gate the doctrine reserved.
 *
 * ## Scope — shared-machine hosts only
 *
 * The hazard is multiple processes on ONE machine sharing `~/.motebit`.
 * That is the node-host family: `apps/cli` (REPL, daemon, serve,
 * subcommands) and `apps/desktop` (the Tauri host). It is deliberately
 * NOT:
 *   - per-device surfaces (`apps/web` browser tab / IndexedDB,
 *     `apps/mobile` RN device storage, `apps/spatial` sandbox) — each
 *     runs alone on its own device with its own storage; no shared
 *     socket, no sibling process, no election to route through;
 *   - the deployed server library (`packages/molecule-runner`) — one
 *     runtime per service deployment, not a user machine.
 * So the scan is rooted at `apps/cli/src` + `apps/desktop/src`; the
 * out-of-scope trees are excluded by construction, not by allowlist.
 *
 * ## Detection — closed registry, sibling-aligned both directions
 *
 *   1. Walk the two host roots (excluding `__tests__/`) for files that
 *      contain a `new MotebitRuntime(` CALL.
 *   2. Every constructing file MUST appear in `CONSTRUCTION_SITES`. An
 *      unregistered site fails: the author must classify it — route it
 *      through the election, or register an explicit exemption with a
 *      reason. This is the "no silent new authority" lock.
 *   3. Every registry entry MUST still construct a runtime (stale-entry
 *      check — the reverse direction).
 *   4. For `mode: "elected"` entries, the `electionVia` file MUST
 *      reference an election symbol (`electRuntimeHost`,
 *      `electCliRuntimeHost`, `electDesktopRuntimeHost`,
 *      `electDaemonCoordinator`). Construction and election need not
 *      co-locate — the CLI REPL constructs in `runtime-factory.ts` but
 *      elects in `index.ts` — so the entry names where the election
 *      lives and the gate verifies it is there. Deleting the election
 *      call (the actual regression) fails here.
 *
 * Static text parse — no execution. Doctrine:
 * `docs/doctrine/daemon-desktop-unification.md` increment 5.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/** Symbols whose presence proves a module routes through the election. */
const ELECTION_SYMBOLS = [
  "electRuntimeHost",
  "electCliRuntimeHost",
  "electDesktopRuntimeHost",
  "electDaemonCoordinator",
] as const;

type ConstructionSite =
  | {
      /** Repo-relative file that contains `new MotebitRuntime(`. */
      file: string;
      mode: "elected";
      /** Repo-relative file where this site's election is wired. */
      electionVia: string;
      reason: string;
    }
  | {
      file: string;
      mode: "exempt";
      reason: string;
    };

/**
 * The shared-machine runtime construction sites, each classified. A new
 * `new MotebitRuntime(` under `apps/cli/src` or `apps/desktop/src` must
 * be added here — elected (named where its election lives) or exempt
 * (with an honest reason). This list IS the registry; the gate aligns
 * it against the filesystem both ways.
 */
const CONSTRUCTION_SITES: ReadonlyArray<ConstructionSite> = [
  {
    file: "apps/cli/src/daemon.ts",
    mode: "elected",
    electionVia: "apps/cli/src/daemon.ts",
    reason:
      "`motebit run` + `motebit serve` are coordinator-role; both call electDaemonCoordinator (→ electCliRuntimeHost) and bind, or refuse honestly when a coordinator is live.",
  },
  {
    file: "apps/cli/src/runtime-factory.ts",
    mode: "elected",
    electionVia: "apps/cli/src/index.ts",
    reason:
      "createRuntime() builds the REPL's runtime; the election lives at the caller (index.ts) which attaches as a rendering frontend when a coordinator is live — construction and election deliberately do not co-locate.",
  },
  {
    file: "apps/desktop/src/index.ts",
    mode: "elected",
    electionVia: "apps/desktop/src/index.ts",
    reason:
      "DesktopApp.initAI elects via electDesktopRuntimeHost before constructing; an attached desktop bridges its organs instead of constructing a second authority.",
  },
  {
    file: "apps/cli/src/subcommands/delegate.ts",
    mode: "exempt",
    reason:
      "EXEMPT (recorded residual): `motebit delegate` is a one-shot subcommand that constructs a transient runtime to sign one delegation and exit. It does not yet attach to a live coordinator — the 'one-shot subcommands attach' residual of the daemon-desktop unification arc. Its writes ride the v1 shared-WAL + vector-clock storage semantics the arc tolerates; routing it through the election (proxying the delegation to the coordinator) is tracked, not silently allowed.",
  },
];

const HOST_ROOTS = ["apps/cli/src", "apps/desktop/src"];
const CONSTRUCT_RE = /new\s+MotebitRuntime\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function fileReferencesElection(relPath: string): boolean {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return false;
  const src = readFileSync(abs, "utf-8");
  return ELECTION_SYMBOLS.some((sym) => src.includes(sym));
}

function main(): void {
  const violations: string[] = [];

  // Forward direction: every constructing file is registered.
  const constructingFiles = new Set<string>();
  for (const root of HOST_ROOTS) {
    const rootAbs = resolve(REPO_ROOT, root);
    for (const file of walk(rootAbs)) {
      const src = readFileSync(file, "utf-8");
      if (!CONSTRUCT_RE.test(src)) continue;
      const rel = relative(REPO_ROOT, file);
      constructingFiles.add(rel);
      if (!CONSTRUCTION_SITES.some((s) => s.file === rel)) {
        violations.push(
          `${rel} — constructs a MotebitRuntime on a shared-machine host but is not a registered ` +
            `construction site. One sovereign runtime per machine: route this entry point through ` +
            `the runtime-host election (electCliRuntimeHost / electDesktopRuntimeHost), or register ` +
            `an explicit exemption with a reason in scripts/check-runtime-host-election.ts. ` +
            `Doctrine: docs/doctrine/daemon-desktop-unification.md.`,
        );
      }
    }
  }

  for (const site of CONSTRUCTION_SITES) {
    // Reverse direction: no stale registry entries.
    if (!constructingFiles.has(site.file)) {
      violations.push(
        `${site.file} — registered as a runtime construction site but no longer contains ` +
          `\`new MotebitRuntime(\`. Remove the stale entry from CONSTRUCTION_SITES in ` +
          `scripts/check-runtime-host-election.ts.`,
      );
      continue;
    }
    // Elected sites must actually wire the election.
    if (site.mode === "elected" && !fileReferencesElection(site.electionVia)) {
      violations.push(
        `${site.file} — registered as election-routed, but ${site.electionVia} references no ` +
          `election symbol (${ELECTION_SYMBOLS.join(" / ")}). The election wiring was removed or ` +
          `moved — a runtime is now constructed without routing through the election, the exact ` +
          `regression this gate forbids.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`Runtime-host-election violations (${violations.length}):\n`);
    for (const v of violations) console.error(`  ${v}\n`);
    console.error(
      "Doctrine: docs/doctrine/daemon-desktop-unification.md — one sovereign runtime per machine; " +
        "every shared-machine runtime construction routes through the election.",
    );
    process.exit(1);
  }

  const elected = CONSTRUCTION_SITES.filter((s) => s.mode === "elected").length;
  const exempt = CONSTRUCTION_SITES.length - elected;
  console.log(
    `Runtime-host election locked — ${constructingFiles.size} shared-machine construction site(s) ` +
      `all classified (${elected} elected, ${exempt} exempt-with-reason); election wiring present.`,
  );
}

main();
