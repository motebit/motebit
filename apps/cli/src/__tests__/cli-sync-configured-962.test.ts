/**
 * #962 C2 — the CLI's `syncConfigured` wiring. A CLI runtime that syncs
 * with a relay (the REPL and `delegate` always; a daemon when it has one) is
 * configured, so compaction waits on the relay's acknowledged push cursor;
 * each construction's config is built by `cliRuntimeConfig`, which decides
 * it from the relay URL, last. Dropped or inverted, compaction deletes events
 * no relay has acknowledged, whenever no cursor was persisted.
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

import { cliRuntimeConfig } from "../sync-configured.js";
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

/** The callees `daemon.ts` calls, by name, with how many call sites each. */
function daemonCalls(): Map<string, number> {
  const file = join(SRC, "daemon.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
  const calls = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.set(node.expression.text, (calls.get(node.expression.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe("#962 C2 — the CLI's syncConfigured wiring", () => {
  it("cliRuntimeConfig: a relay URL ⇒ configured; none ⇒ not; it is set last", () => {
    expect(cliRuntimeConfig({ motebitId: "m" }, { syncUrl: "https://r" }).syncConfigured).toBe(
      true,
    );
    expect(cliRuntimeConfig({ motebitId: "m" }, { syncUrl: undefined }).syncConfigured).toBe(false);
    expect(cliRuntimeConfig({ motebitId: "m" }, { syncUrl: "" }).syncConfigured).toBe(false);
    // A caller's own value never survives: the relay decides.
    const smuggled = { motebitId: "m", syncConfigured: false } as Parameters<
      typeof cliRuntimeConfig
    >[0];
    expect(cliRuntimeConfig(smuggled, { syncUrl: "https://r" }).syncConfigured).toBe(true);
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

  it("every daemon starts its event push (run and serve), and resolves its relay once", () => {
    // Secondary guard: the push each daemon starts is held behaviourally by
    // every-configured-surface-pushes-962.test.ts; this holds the calls.
    const calls = daemonCalls();
    expect(calls.get("startRunEventSync")).toBe(1);
    expect(calls.get("startServeEventSync")).toBe(1);
    expect(calls.get("daemonRelayUrl")).toBe(2);
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
