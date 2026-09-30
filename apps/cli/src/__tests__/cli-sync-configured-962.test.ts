/**
 * #962 C2 — the CLI's `syncConfigured` wiring. Every CLI runtime shares
 * `motebit.db` and the REPL always syncs it to a relay, so compaction waits
 * on the relay's acknowledged push cursor: each construction must pass
 * `CLI_SYNC_CONFIGURED` (true). Dropped or inverted, compaction deletes
 * events no relay has acknowledged, whenever no cursor was persisted.
 *
 * The REPL is checked at its real construction seam (`createRuntime`, the
 * runtime's own answer). Every entry point's behaviour — push liveness,
 * compaction safety, surfacing — is held by
 * `every-configured-surface-pushes-962.test.ts`; this file keeps a secondary
 * source guard: every non-test `new MotebitRuntime(` under `apps/cli/src`
 * builds its config with `cliRuntimeConfig` (which sets `syncConfigured`
 * last), and names the sites it found.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import ts from "typescript";

await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-962-cfg-"));
});

import { CLI_SYNC_CONFIGURED } from "../sync-configured.js";
import { createRuntime, InMemoryToolRegistry } from "../runtime-factory.js";
import { parseCliArgs } from "../args.js";

const SRC = join(__dirname, "..");

afterEach(() => {
  vi.restoreAllMocks();
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Each `new MotebitRuntime(...)` under apps/cli/src: its file and the callee its config is built by. */
function runtimeSites(): Array<{ file: string; builtBy: string | null }> {
  const sites: Array<{ file: string; builtBy: string | null }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes("MotebitRuntime(")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "MotebitRuntime"
      ) {
        const arg = node.arguments?.[0];
        const builtBy =
          arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)
            ? arg.expression.text
            : null;
        sites.push({ file: relative(SRC, file), builtBy });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

describe("#962 C2 — the CLI's syncConfigured wiring", () => {
  it("CLI_SYNC_CONFIGURED is true: the CLI always syncs motebit.db to a relay", () => {
    expect(CLI_SYNC_CONFIGURED).toBe(true);
  });

  it("the REPL runtime (createRuntime) answers configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runtime, moteDb } = await createRuntime(
      {
        ...parseCliArgs([]),
        provider: "local-server",
        syncUrl: "http://relay.zz962w.test",
        dbPath: join(mkdtempSync(join(tmpdir(), "motebit-962w-")), "motebit.db"),
      },
      "mote-zz962w",
      new InMemoryToolRegistry(),
      [],
    );
    try {
      expect(await runtime.isSyncConfigured()).toBe(true);
    } finally {
      moteDb.close();
    }
  });

  it("every `new MotebitRuntime(` in apps/cli/src builds its config with cliRuntimeConfig", () => {
    // A secondary guard: `cliRuntimeConfig` sets `syncConfigured` LAST, so no
    // spread at a site can override it. The behaviour of each site is held by
    // every-configured-surface-pushes-962.test.ts.
    const sites = runtimeSites();
    // Aperture: the sites this scan found — the REPL, both daemons, delegate.
    expect(sites.map((s) => s.file).sort()).toEqual(
      ["daemon.ts", "daemon.ts", "runtime-factory.ts", join("subcommands", "delegate.ts")].sort(),
    );
    for (const site of sites) {
      expect(site).toEqual({ file: site.file, builtBy: "cliRuntimeConfig" });
    }
  });
});
