/**
 * The vite plugin scripts/lib/vitest-recorder.cjs appends to every vite
 * server vitest creates. It writes JSONL to `$MOTEBIT_VITEST_RECORD`:
 *
 * - `config`: the config file vite resolved and its `configFileDependencies`
 *   (every file the config imports — vite bundles them, so they never pass
 *   through `transform`);
 * - `module`: every id vite transforms for vitest — test files, setupFiles,
 *   globalSetup, environment, reporters, snapshot serializers, sequencer,
 *   bench files and everything they import that vitest inlines;
 * - `resolved`: every id vite resolves for vitest, including externalized
 *   modules and `vi.mock` targets (see `configureServer`);
 * - `vitest`: the Vitest instance it attached to (mode, config file), and
 *   `unsupported` for a mode whose modules bypass vite (native module runner,
 *   browser mode) — the gate fails on it;
 * - `collected`: the end of the run, which the plugin makes COLLECTION-ONLY:
 *   `runFiles` is replaced by vitest's own `collectTests` (globalSetup runs,
 *   setupFiles and test files are imported, no test body runs), with
 *   `isolate` off and one worker (each module evaluated once; ~4x faster).
 *   It carries the specs, the files that failed to collect, and the STATIC
 *   prediction (scripts/lib/vitest-collect.mjs over the same resolved
 *   config) the gate cross-checks against the recording.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { staticCollect } from "./vitest-collect.mjs";

const out = process.env.MOTEBIT_VITEST_RECORD;
const write = (rec) => {
  if (out) appendFileSync(out, `${JSON.stringify({ pid: process.pid, ...rec })}\n`);
};
const patched = new WeakSet();
const seen = new Set();
const once = (key, rec) => {
  if (seen.has(key)) return;
  seen.add(key);
  write(rec);
};

export function motebitRecordPlugin() {
  return {
    name: "motebit:record-loaded-modules",
    enforce: "pre",
    configResolved(config) {
      write({
        event: "config",
        root: config.root,
        configFile: config.configFile ?? null,
        deps: config.configFileDependencies ?? [],
      });
    },
    configureServer(server) {
      // With isolate off a module one test file mocks can stay cached for the
      // next file, so its real code is never transformed — but its id is
      // still resolved (the mocker resolves every `vi.mock` path), so every
      // resolution is recorded too. Externalized ids are resolved here as well.
      for (const env of Object.values(server.environments ?? {})) {
        const container = env.pluginContainer;
        const resolveId = container.resolveId.bind(container);
        container.resolveId = async (...args) => {
          const r = await resolveId(...args);
          if (r && typeof r.id === "string") once(`r:${r.id}`, { event: "resolved", id: r.id });
          return r;
        };
      }
    },
    transform(_code, id) {
      once(`m:${id}`, { event: "module", id });
      return null;
    },
    configureVitest({ vitest, project }) {
      project.config.isolate = false;
      const why = [];
      if (project.config.experimental?.viteModuleRunner === false) {
        why.push(
          "experimental.viteModuleRunner: false (modules load by native import, never through vite)",
        );
      }
      if (project.config.browser?.enabled) why.push("browser mode");
      if (why.length > 0) write({ event: "unsupported", project: project.name, why });
      if (patched.has(vitest)) return;
      patched.add(vitest);
      vitest.config.maxWorkers = 1;
      vitest.config.watch = false;
      write({
        event: "vitest",
        mode: vitest.mode,
        configFile: vitest.vite.config.configFile ?? null,
      });
      vitest.runFiles = async (specs) => {
        const result = await vitest.collectTests(specs);
        const failed = [];
        const walk = (t) => {
          for (const e of t.result?.errors ?? []) {
            failed.push({
              file: t.file?.filepath ?? null,
              error: String(e?.message ?? e).slice(0, 300),
            });
          }
          for (const c of t.tasks ?? []) walk(c);
        };
        for (const f of vitest.state.getFiles()) walk(f);
        for (const e of result?.unhandledErrors ?? []) {
          failed.push({ file: null, error: String(e?.message ?? e).slice(0, 300) });
        }
        const repoRoot = resolve(process.env.MOTEBIT_REPO_ROOT || process.cwd());
        write({
          event: "collected",
          specs: specs.map((s) => s.moduleId),
          failed,
          static: await staticCollect(vitest, repoRoot),
        });
        return result;
      };
    },
  };
}
