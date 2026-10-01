#!/usr/bin/env node
// Tamper check for compaction-push-floor-962.test.ts (#962).
//
// Each entry reverts one clause of the fix and names the test expected to go
// red. The script applies the tamper, rebuilds the tampered package when it
// is not the runtime (the runtime's tests import workspace packages from
// dist), runs the file, restores the source, rebuilds, and fails if a tamper
// did not apply (a false green) or the named test stayed green.
//
//   node packages/runtime/src/__tests__/compaction-push-floor-962.tampers.mjs
//
// Run from anywhere; paths resolve relative to this file (TAMPER_DRY=1 only
// checks that every tamper still applies). It EDITS the tree it
// sits in (and restores it), so run it in a copy: `cp -a` the checkout and
// run the copy's script. A package with a `pretest` script (mobile generates
// its creature bundle there) runs it before its entries, as `pnpm test` would.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const root = join(pkg, "..", "..");
const testFile = join(here, "compaction-push-floor-962.test.ts");
const desktop = join(root, "apps", "desktop");
const mobile = join(root, "apps", "mobile");
const desktopTest = join(desktop, "src", "__tests__", "tauri-storage.test.ts");
const mobileTest = join(mobile, "src", "__tests__", "expo-sqlite-sync-cursor.test.ts");
const cli = join(root, "apps", "cli");
const web = join(root, "apps", "web");
const spatial = join(root, "apps", "spatial");
const replTest = join(cli, "src", "__tests__", "repl-compaction-962.test.ts");
const cliWiringTest = join(cli, "src", "__tests__", "cli-sync-configured-962.test.ts");
const desktopWiringTest = join(desktop, "src", "__tests__", "sync-configured-962.test.ts");
const webWiringTest = join(web, "src", "__tests__", "sync-configured-962.test.ts");
const spatialWiringTest = join(spatial, "src", "__tests__", "sync-configured-962.test.ts");
const mobileWiringTest = join(mobile, "src", "__tests__", "mobile-app.test.ts");
const cliMatrix = join(cli, "src", "__tests__", "every-configured-surface-pushes-962.test.ts");

const TAMPERS = [
  {
    // The law itself: compaction deletes up to the requested clock, ignoring
    // every relay stream's acked push cursor.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "const floor = await pushCompactionFloor(this.localEventStore, requested, {",
    replacement: "const floor = requested;\n    void this.localEventStore;\n    void ({",
    red: "never pushed: an appended event survives compaction",
  },
  {
    // Fail closed: an unreadable cursor compacts as if no relay existed.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "  } catch {\n    return 0;\n  }\n}",
    replacement: "  } catch {\n    return requested;\n  }\n}",
    red: "sync configured but the cursor unreadable",
  },
  {
    // The minimum across relay streams: only the first stream is read.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "return Math.min(requested, ...acked.values());",
    replacement: "return Math.min(requested, [...acked.values()][0]!);",
    red: "two relay streams: the floor is the minimum across them",
  },
  {
    // Enrollment persisted at connect: a later process, before it connects
    // sync, would not know a relay stream exists.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "if ((await cursors.getSyncSeqCursor(key)) === null) await cursors.setSyncSeqCursor(key, 0);",
    replacement: "void cursors;",
    red: "a later process, before it connects sync",
  },
  {
    // The SQLite store lists its push cursors.
    file: join(root, "packages", "persistence", "src", "index.ts"),
    build: "@motebit/persistence",
    text: "return rows.map((r) => r.cursor_key);",
    replacement: "return rows.length < 0 ? [] : [];",
    red: "sqlite store > a later process, before it connects sync",
  },
  {
    // The IndexedDB store lists its push cursors.
    file: join(root, "packages", "browser-persistence", "src", "event-store.ts"),
    build: "@motebit/browser-persistence",
    text: 'return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));',
    replacement: "return keys.length < 0 ? [prefix] : [];",
    red: "idb store > a later process, before it connects sync",
  },
  {
    // #962 round 2 F1: one relay, many cursors — group keys by relay stream.
    // Keyed per cursor key, mobile's stale /sync cursor pins the live one.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "const stream = relayStreamOfPushKey(key);",
    replacement: "const stream = key;",
    red: "sqlite store > F1 mobile: a /sync cursor and the live cursor",
  },
  {
    // F1: the MAX within a stream — the MIN there pins the CLI's raw cursor
    // at the stale E2E one.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "acked.set(stream, Math.max(acked.get(stream) ?? 0, cursor));",
    replacement: "acked.set(stream, Math.min(acked.get(stream) ?? cursor, cursor));",
    red: "idb store > F1 CLI: a raw cursor beside an E2E cursor",
  },
  {
    // F2 / P-a: configured with no stream cursor compacts nothing.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "return options.syncConfigured === true || intended ? 0 : requested;",
    replacement: "return intended ? 0 : requested;",
    red: "sqlite store) > the marker write fails: this process's own configuration still holds compaction",
  },
  {
    // F2: the runtime passes the host's signal to the floor.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "      syncConfigured: configured,",
    replacement: "      syncConfigured: undefined,",
    red: "idb store) > the marker write fails: this process's own configuration still holds compaction",
  },
  {
    // F2: a provider that cannot tell fails closed.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "    } catch {\n      return { answer: true, decided: false };",
    replacement: "    } catch {\n      return { answer: false, decided: true };",
    red: "sqlite store > P-a: a provider that cannot tell (throws) fails closed",
  },
  {
    // F3: the Tauri store lists its push cursors (SQL over real SQLite).
    file: join(desktop, "src", "tauri-storage.ts"),
    testFile: desktopTest,
    cwd: desktop,
    text: '"SELECT cursor_key FROM sync_seq_cursors WHERE substr(cursor_key, 1, length(?)) = ?",\n      [prefix, prefix],\n    );\n    return rows.map((r) => r.cursor_key);\n  }\n\n  async setSyncSeqCursor',
    replacement:
      '"SELECT cursor_key FROM sync_seq_cursors WHERE 0 AND substr(cursor_key, 1, length(?)) = ?",\n      [prefix, prefix],\n    );\n    return rows.map((r) => r.cursor_key);\n  }\n\n  async setSyncSeqCursor',
    red: "lists exactly its push: cursor keys, and the #962 floor reads them",
  },
  {
    // F3: the Expo store lists its push cursors (SQL over real SQLite).
    file: join(mobile, "src", "adapters", "expo-sqlite.ts"),
    testFile: mobileTest,
    cwd: mobile,
    text: '"SELECT cursor_key FROM sync_seq_cursors WHERE substr(cursor_key, 1, length(?)) = ?",',
    replacement:
      '"SELECT cursor_key FROM sync_seq_cursors WHERE 0 AND substr(cursor_key, 1, length(?)) = ?",',
    red: "lists exactly its push: cursor keys, and the #962 floor reads them",
  },
  // --- #962 round 3 C1: the default REPL's push is authenticated. ---
  {
    // The REPL's event remote presents only the configured token (none by
    // default): every push is refused, the cursor never moves.
    file: join(cli, "src", "runtime-factory.ts"),
    testFile: replTest,
    cwd: cli,
    text: "    deviceId: opts.deviceId,\n    privateKey: opts.privateKey ?? (() => undefined),",
    replacement: "    deviceId: undefined,\n    privateKey: () => undefined,",
    red: "three cycles of 50 appends -> sync -> compact()",
  },
  {
    // createRuntime drops the device credentials the REPL hands it.
    file: join(cli, "src", "runtime-factory.ts"),
    testFile: replTest,
    cwd: cli,
    text: "...(device ? { deviceId: device.deviceId, privateKey: device.privateKey } : {}),",
    replacement: "...(device ? {} : {}),",
    red: "createRuntime's remote authenticates with a device token",
  },
  {
    // The bootstrap introduces a key the device tokens do not verify under.
    file: join(cli, "src", "runtime-factory.ts"),
    testFile: replTest,
    cwd: cli,
    text: "public_key: opts.publicKeyHex,",
    replacement: 'public_key: "0".repeat(64),',
    red: "bootstrapReplDevice introduces the key",
  },
  {
    // A refused push is silent: sync() resolves, nothing records why.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    testFile: replTest,
    cwd: cli,
    text: "        this.lastError = new Error(\n          sanitizeRelayText(",
    replacement:
      "        this.lastError = null;\n        void new Error(\n          sanitizeRelayText(",
    red: "the refusal is one line, never silent",
  },
  {
    // A success never clears the reason: a relay that recovered still reads refused.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "sync-last-error-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (cycle === this.cycle) this.lastError = null;",
    replacement: "void cycle;",
    red: "carries a refused push's reason, and clears once a cycle succeeds",
  },
  // --- #962 round 3 C2: each surface's syncConfigured wiring. ---
  {
    // CLI: a relay URL no longer makes a runtime configured.
    file: join(cli, "src", "sync-configured.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "return { ...base, syncConfigured: named(relay.syncUrl) || named(relay.intentUrl) };",
    replacement: "return { ...base, syncConfigured: false && named(relay.syncUrl) };",
    red: "cliRuntimeConfig: a relay URL ⇒ configured",
  },
  {
    // CLI: a call site's own syncConfigured overrides the relay's answer.
    file: join(cli, "src", "sync-configured.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "return { ...base, syncConfigured: named(relay.syncUrl) || named(relay.intentUrl) };",
    replacement:
      "return { syncConfigured: named(relay.syncUrl) || named(relay.intentUrl), ...base };",
    red: "it is set last",
  },
  {
    // CLI REPL (createRuntime): its relay dropped from the runtime config.
    file: join(cli, "src", "runtime-factory.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "      { syncUrl },\n    ),",
    replacement: "      { syncUrl: undefined },\n    ),",
    red: "the REPL runtime (createRuntime) answers configured",
  },
  {
    // `motebit run`: its runtime config no longer built by cliRuntimeConfig.
    file: join(cli, "src", "daemon.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "    // #962: `syncConfigured` is decided by `cliRuntimeConfig`, last.\n    cliRuntimeConfig(\n      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          maxRiskLevel: maxRiskAuto,",
    replacement:
      "    // #962: `syncConfigured` is decided by `cliRuntimeConfig`, last.\n    ((b: RuntimeConfig, _r: unknown) => b)(\n      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          maxRiskLevel: maxRiskAuto,",
    red: "builds its config with cliRuntimeConfig",
  },
  {
    // `motebit delegate`: likewise.
    file: join(cli, "src", "subcommands", "delegate.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "    cliRuntimeConfig(\n",
    replacement: "    ((b: object, _r: unknown) => b as never)(\n",
    red: "builds its config with cliRuntimeConfig",
  },
  {
    // Desktop: the configured relay ignored.
    file: join(desktop, "src", "index.ts"),
    testFile: desktopWiringTest,
    cwd: desktop,
    text: '(config.syncUrl != null && config.syncUrl !== "") || this._syncStartedUrl != null,',
    replacement: "this._syncStartedUrl != null,",
    red: "a relay in the config: configured",
  },
  {
    // Desktop P3: a relay started later this session is not remembered.
    file: join(desktop, "src", "index.ts"),
    testFile: desktopWiringTest,
    cwd: desktop,
    text: 'if (syncUrl !== "") this._syncStartedUrl = syncUrl;',
    replacement: "void syncUrl;",
    red: "P3: a relay started later this session",
  },
  {
    // Web: the wiring inverted.
    file: join(web, "src", "web-app.ts"),
    testFile: webWiringTest,
    cwd: web,
    text: "syncConfigured: () => isSyncUrlConfigured(),",
    replacement: "syncConfigured: () => !isSyncUrlConfigured(),",
    red: "a saved relay is read at compaction time",
  },
  {
    // Web P1: starting sync (the pairing path) does not save the relay.
    file: join(web, "src", "web-app.ts"),
    testFile: webWiringTest,
    cwd: web,
    text: 'if (relayUrl !== "") saveSyncUrl(relayUrl);',
    replacement: "void relayUrl;",
    red: "P1: starting sync persists the relay URL",
  },
  {
    // Web P1: storage that cannot be read reads as "no relay".
    file: join(web, "src", "storage.ts"),
    testFile: webWiringTest,
    cwd: web,
    text: "  } catch {\n    return true;\n  }\n}\n\nexport function clearSyncUrl",
    replacement: "  } catch {\n    return false;\n  }\n}\n\nexport function clearSyncUrl",
    red: "fails closed when storage throws",
  },
  {
    // Spatial: the wiring dropped.
    file: join(spatial, "src", "spatial-app.ts"),
    testFile: spatialWiringTest,
    cwd: spatial,
    text: '        syncConfigured: () =>\n          this.networkSettings.relayUrl !== "" && this.networkSettings.showNetwork,\n',
    replacement: "",
    red: "the default network settings (relay.motebit.com, showNetwork on): configured",
  },
  {
    // Spatial: showNetwork off (no sync ever connects) still read as configured.
    file: join(spatial, "src", "spatial-app.ts"),
    testFile: spatialWiringTest,
    cwd: spatial,
    text: 'this.networkSettings.relayUrl !== "" && this.networkSettings.showNetwork,',
    replacement: 'this.networkSettings.relayUrl !== "",',
    red: "showNetwork off: not configured",
  },
  {
    // Mobile: the wiring inverted.
    file: join(mobile, "src", "mobile-app.ts"),
    testFile: mobileWiringTest,
    cwd: mobile,
    text: '          const url = await this.getSyncUrl();\n          return url != null && url !== "";',
    replacement: "          const url = await this.getSyncUrl();\n          return url == null;",
    red: "#962 — MobileApp's syncConfigured > a persisted relay URL",
  },
  // --- #962 round 4: every configured CLI entry point pushes (the matrix). ---
  {
    // The daemons' push loop never ticks: only the startup cycle pushes.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "timer = setTimeout(() => void cycle(), pushRetryDelay(opts.intervalMs, failures));",
    replacement: "timer = setTimeout(() => undefined, pushRetryDelay(opts.intervalMs, failures));",
    red: "run | bootstrapped | up | no-token",
  },
  {
    // The REPL's push loop never ticks (the same clause, read from the REPL).
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "timer = setTimeout(() => void cycle(), pushRetryDelay(opts.intervalMs, failures));",
    replacement: "timer = setTimeout(() => undefined, pushRetryDelay(opts.intervalMs, failures));",
    red: "repl | bootstrapped | up | no-token",
  },
  {
    // `motebit run` connects its remote and never pushes (round 3's C1).
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "): CliEventPush {\n  return startDaemonEventSync(runtime, relaySync, opts);\n}\n\n/**\n * `motebit serve`",
    replacement:
      "): CliEventPush {\n  runtime.connectSync(relaySync.transport.remote);\n  void opts;\n  return { stop() {} };\n}\n\n/**\n * `motebit serve`",
    red: "run | fresh | up | token",
  },
  {
    // `motebit serve` connects nothing (round 3's C1).
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "): CliEventPush {\n  return startDaemonEventSync(runtime, relaySync, opts);\n}\n\nexport interface DelegateEventSyncOptions",
    replacement:
      "): CliEventPush {\n  void runtime;\n  void relaySync;\n  void opts;\n  return { stop() {} };\n}\n\nexport interface DelegateEventSyncOptions",
    red: "serve | bootstrapped | up | token",
  },
  {
    // `serve` in daemon.ts: its events' sync never started.
    file: join(cli, "src", "daemon.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "serveEventPush = startServeEventSync(runtime, serveRelaySync, {",
    replacement: "serveEventPush = ((..._a: unknown[]) => undefined)(runtime, serveRelaySync, {",
    red: "every daemon starts its event push",
  },
  {
    // `run` in daemon.ts: its events' sync never started.
    file: join(cli, "src", "daemon.ts"),
    testFile: cliWiringTest,
    cwd: cli,
    text: "runEventPush = startRunEventSync(runtime, relaySync, {",
    replacement: "runEventPush = ((..._a: unknown[]) => undefined)(runtime, relaySync, {",
    red: "every daemon starts its event push",
  },
  {
    // P1: no re-bootstrap on a 401/403 — a relay unreachable at start never
    // learns the device's key, and refuses every push for the session.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "if (err && isAuthRefusal(err) && opts.device && !rebootstrapped) {",
    replacement: "if (err && isAuthRefusal(err) && opts.device && rebootstrapped) {",
    red: "run | fresh | down→up | no-token",
  },
  {
    // P1, the REPL: the same clause.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "if (err && isAuthRefusal(err) && opts.device && !rebootstrapped) {",
    replacement: "if (err && isAuthRefusal(err) && opts.device && rebootstrapped) {",
    red: "repl | fresh | down→up | no-token",
  },
  {
    // C2: the REPL bootstraps AFTER its first push — refused once.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "  if (pushDevice) {\n    const refused = await bootstrapReplDevice({ syncUrl, ...pushDevice });\n    if (refused) warn(refused);\n  }\n",
    replacement: "",
    red: "repl | fresh | up | no-token",
  },
  {
    // delegate bootstraps AFTER its first push — refused once.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "  if (opts.device) {\n    const refused = await bootstrapReplDevice({ syncUrl: opts.syncUrl, ...opts.device });\n    if (refused) opts.log(refused);\n  }\n",
    replacement: "",
    red: "delegate | fresh | up | no-token",
  },
  {
    // A failure is never reported: a refusing relay is silent.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "if (line !== failing) opts.report(line);",
    replacement: "if (line !== failing) void opts;",
    red: "run | bootstrapped | up | REFUSED",
  },
  {
    // delegate exits without its last push.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "const outcome = await Promise.race([loop.flush(), late]);",
    replacement: "const outcome = await Promise.race([Promise.resolve(null), late]);",
    red: "delegate | bootstrapped | up | no-token",
  },
  {
    // A daemon with no relay is still "configured": compaction held for good.
    file: join(cli, "src", "sync-configured.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "return { ...base, syncConfigured: named(relay.syncUrl) || named(relay.intentUrl) };",
    replacement: "return { ...base, syncConfigured: true || named(relay.syncUrl) };",
    red: "run | no relay configured",
  },
  {
    // `serve` over stdio resolves a relay it never reaches.
    file: join(cli, "src", "sync-configured.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: '  if (transport === "stdio") return undefined;\n',
    replacement: "",
    red: "serve | stdio transport with a relay named (--sync-url)",
  },
  {
    // Another identity's acked cursor in the same store floors this one.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "push-compaction-floor-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (motebitId != null && !stream.endsWith(`#${motebitId}`)) continue;",
    replacement: "void motebitId;",
    red: "only the compacted identity's streams count",
  },
  {
    // The runtime does not name its identity to the floor (web: restored identity).
    file: join(pkg, "src", "motebit-runtime.ts"),
    testFile: join(
      root,
      "apps",
      "web",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "web"),
    build: "@motebit/runtime",
    text: "      motebitId: this.motebitId,\n    });",
    replacement: "    });",
    red: "identity changed on one origin",
  },
  {
    // P3: a syncConfigured provider that never settles hangs compaction.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "timer = setTimeout(() => resolve(null), SYNC_CONFIGURED_TIMEOUT_MS);",
    replacement: "void SYNC_CONFIGURED_TIMEOUT_MS;",
    red: "P3: a provider that never settles",
  },
  // --- #962 round 4: the app surfaces' matrices. ---
  {
    // Web: a refused device registration is never retried.
    file: join(root, "apps", "web", "src", "web-app.ts"),
    testFile: join(
      root,
      "apps",
      "web",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "web"),
    text: "    if (!registered) this.retryRegistration(relayUrl);",
    replacement: "    void registered;",
    red: "web | fresh | down→up | token",
  },
  {
    // Spatial: a refused device registration is never retried.
    file: join(root, "apps", "spatial", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "spatial",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "spatial"),
    text: "        if (!registered) this.retryRegistration(relayUrl);",
    replacement: "        void registered;",
    red: "spatial | fresh | down→up | token",
  },
  {
    // Spatial: no token leaves the status at "connecting" forever.
    file: join(root, "apps", "spatial", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "spatial",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "spatial"),
    text: '      : "no runtime: sync cannot start";\n    this.setSyncStatus("error");',
    replacement: '      : "no runtime: sync cannot start";',
    red: "spatial | fresh | up | no-token",
  },
  {
    // Desktop: the legacy unsigned registration (the relay never learns the key).
    file: join(root, "apps", "desktop", "src", "identity-manager.ts"),
    testFile: join(
      root,
      "apps",
      "desktop",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "desktop"),
    text: "      result = await registerDeviceWithRelay({",
    replacement:
      "      result = { ok: true, created: false, registered_at: 0 } as never;\n      void ({",
    red: "desktop | fresh | up | no-token",
  },
  {
    // Desktop: a failed registration stops sync from starting.
    file: join(root, "apps", "desktop", "src", "sync-startup.ts"),
    testFile: join(
      root,
      "apps",
      "desktop",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "desktop"),
    text: "  // Start background sync. Safe to call",
    replacement:
      "  if (failure !== null) return onFailure(failure, () => {});\n  // Start background sync. Safe to call",
    red: "desktop | bootstrapped | down→up | no-token",
  },
  {
    // Desktop: a refused registration is never retried in the background.
    file: join(root, "apps", "desktop", "src", "sync-startup.ts"),
    testFile: join(
      root,
      "apps",
      "desktop",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "desktop"),
    text: "  schedule();\n  return () => {",
    replacement: "  return () => {",
    red: "desktop | fresh | down→up | no-token",
  },
  {
    // Mobile: the device is never registered before its first push.
    file: join(root, "apps", "mobile", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "mobile",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "mobile"),
    text: "    await this.attemptRegistration(url, session);",
    replacement: "    this._registered = true;",
    red: "mobile | fresh | up",
  },
  {
    // Mobile: a refused registration is never retried.
    file: join(root, "apps", "mobile", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "mobile",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "mobile"),
    text: "      void this.attemptRegistration(url, session);",
    replacement: "      void session;",
    red: "mobile | fresh | down→up",
  },
  {
    // Mobile: a refused sync cycle reads "idle".
    file: join(root, "apps", "mobile", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "mobile",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "mobile"),
    text: "      if (eventError) throw eventError;",
    replacement: "      void eventError;",
    red: "mobile | bootstrapped | refusing (identity revoked) | N/A-token",
  },
  {
    // Mobile: a refused /sync toasts "Synced".
    file: join(root, "apps", "mobile", "src", "sync-controller.ts"),
    testFile: join(
      root,
      "apps",
      "mobile",
      "src",
      "__tests__",
      "every-configured-surface-pushes-962.test.ts",
    ),
    cwd: join(root, "apps", "mobile"),
    text: "    if (eventError) {",
    replacement: '    if (eventError && url === "") {',
    red: "user /sync (syncNow)",
  },
  // ── round 5: sync intent is the database's ────────────────────────────────
  {
    // Marker write (runtime): a configured process records no sync intent.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "      await recordSyncIntent(this.localEventStore, this.motebitId);",
    replacement: "      void recordSyncIntent;",
    red: "sqlite store) > configured process A never connects; unconfigured process B on the same database compacts nothing",
  },
  {
    // Marker write (CLI): the REPL's identity bootstrap records no intent.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: "    await recordSyncIntent(db.eventStore, result.motebitId);",
    replacement: "    void result;",
    red: "P6 | REPL first launch (no-config)",
  },
  {
    // Marker write (CLI): stdio serve with a relay named is not configured.
    file: join(cli, "src", "sync-configured.ts"),
    testFile: cliMatrix,
    cwd: cli,
    text: '    intentUrl: daemonRelayUrl(config, fullConfig, "run"),',
    replacement: "    intentUrl: undefined,",
    red: "serve | stdio transport with a relay named (config.json sync_url)",
  },
  {
    // Marker read in the floor: only this process's own configuration counts.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "return options.syncConfigured === true || intended ? 0 : requested;",
    replacement: "return options.syncConfigured === true || (intended && false) ? 0 : requested;",
    red: "idb store) > A's provider says configured (async): B, unconfigured, still compacts nothing",
  },
  {
    // Fail-closed read: an unreadable marker reads as "never configured".
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: '? (await readSyncIntent(localStore, options.motebitId)) === "recorded"',
    replacement:
      '? (await readSyncIntent(localStore, options.motebitId).catch(() => "never")) === "recorded"',
    red: "the sync-intent marker cannot be read: an unconfigured process deletes nothing",
  },
  {
    // Sanitizer (C2): relay text printed verbatim. Round 6: the sanitizer is
    // sync-engine's (one for every surface); the CLI tests read its dist.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    build: "@motebit/sync-engine",
    testFile: join(cli, "src", "__tests__", "push-loop-hardening-962.test.ts"),
    cwd: cli,
    text: "  const clean = String(text)\n",
    replacement: "  if (max > 0) return text;\n  const clean = String(text)\n",
    red: "bootstrapReplDevice: a hostile relay body",
  },
  {
    // Backoff: every retry at the plain interval.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: join(cli, "src", "__tests__", "push-loop-hardening-962.test.ts"),
    cwd: cli,
    text: "timer = setTimeout(() => void cycle(), pushRetryDelay(opts.intervalMs, failures));",
    replacement: "timer = setTimeout(() => void cycle(), pushRetryDelay(opts.intervalMs, 0));",
    red: "N consecutive failures ⇒ growing intervals",
  },
  {
    // Backoff reset: a success keeps the backed-off wait.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: join(cli, "src", "__tests__", "push-loop-hardening-962.test.ts"),
    cwd: cli,
    text: "    failures = 0;\n    return result;",
    replacement: "    return result;",
    red: "reset on success",
  },
  {
    // --- #962 round 6 C1: a pinned floor is never silent or doorless. ---
    // The floor ignores the operator's retirement.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (exclude.has(stream) || retired !== null) {",
    replacement: "if (exclude.has(stream) || (retired as unknown) === own) {",
    red: "the probe: one connect to a typo'd relay; the right relay acked 10 of 20",
  },
  {
    // A retirement marker that cannot be read counts as retired (fail open).
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "const at = await store.getSyncSeqCursor(retiredStreamKey(stream));",
    replacement:
      "const at = await store.getSyncSeqCursor(retiredStreamKey(stream)).catch(() => 1);",
    red: "an unreadable retirement marker fails closed",
  },
  {
    // Connecting to a retired relay again does not restore it.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "            await store.setSyncSeqCursor(retired, 0);",
    replacement: "            void store;",
    red: "a retired stream that is connected again holds the floor again",
  },
  {
    // An acknowledgment records no time.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "            pushAckedAtKey(relayStreamOfPushKey(key)),",
    replacement: "            pushAckedAtKey(`x${key}`),",
    red: "an acknowledgment records its time",
  },
  {
    // The report says nothing of the events a stream holds back.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "return above.filter((e) => e.version_clock <= without).length;",
    replacement: "return without < 0 ? above.length : 0;",
    red: "the probe: one connect to a typo'd relay; the right relay acked 10 of 20",
  },
  {
    // Never-acked only: a stream stale for > 7 days is never named.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (holders.every((s) => s.lastAckAt === null || now - s.lastAckAt > staleMs)) {",
    replacement: "if (holders.every((s) => s.lastAckAt === null && now > staleMs)) {",
    red: "a stream that acked, then stopped for > 7 days",
  },
  {
    // The notice names a stream whose retirement would free nothing.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-doors-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (!holder || holder.heldBackTied <= 0) return null;",
    replacement: "if (!holder) return null;",
    red: "the only stream, never acked: no notice",
  },
  {
    // --- #962 round 6 C2/C3: relay text never prints raw. ---
    // getLastError() carries the relay's text raw.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: "sanitizeRelayText(err instanceof Error ? err.message : String(err)),",
    replacement: "err instanceof Error ? err.message : String(err),",
    red: "getLastError() never carries raw relay text",
  },
  {
    // The HTTP adapter builds its Error from the raw status text.
    file: join(root, "packages", "sync-engine", "src", "http-adapter.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: "throw new Error(`Push failed: ${res.status} ${sanitizeRelayText(res.statusText)}`);",
    replacement: "throw new Error(`Push failed: ${res.status} ${res.statusText}`);",
    red: "the HTTP adapter's refusal",
  },
  {
    // The socket's refusal carries the relay's message raw.
    file: join(root, "packages", "sync-engine", "src", "ws-adapter.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: "new Error(`sync push: ${sanitizeRelayText(msg.message)}`)",
    replacement: "new Error(`sync push: ${msg.message}`)",
    red: "static: every Error a sync-engine source builds",
  },
  // (No entry for the BOM or U+2028/U+2029 clauses: `\s` matches them too,
  // so the whitespace collapse strips them a second time — removing either
  // clause alone changes no output. Their tests still hold the law.)
  {
    // Bidi embeddings / overrides survive.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: '.replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, "")',
    replacement: '.replace(/[\\u200b-\\u200f\\u2066-\\u2069\\ufeff]/g, "")',
    red: "strips U+202E RLO",
  },
  {
    // Bidi isolates survive.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: '.replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, "")',
    replacement: '.replace(/[\\u200b-\\u200f\\u202a-\\u202e\\ufeff]/g, "")',
    red: "strips U+2066 LRI",
  },
  {
    // Zero-width characters survive.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: '.replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, "")',
    replacement: '.replace(/[\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, "")',
    red: "strips U+200B ZWSP",
  },
  {
    // DEL survives.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: ".replace(/[\\x00-\\x1f\\x7f-\\x9f",
    replacement: ".replace(/[\\x00-\\x1f\\x80-\\x9f",
    red: "strips U+007F DEL",
  },
  {
    // Truncation by UTF-16 code unit: a surrogate pair is split at the cap.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: "? Array.from(segmenter.segment(clean), (s) => s.segment)",
    replacement: '? clean.split("")',
    red: "truncation never splits a surrogate pair",
  },
  {
    // A lone surrogate in the input is printed.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(root, "packages", "sync-engine", "src", "__tests__", "relay-text-962.test.ts"),
    cwd: join(root, "packages", "sync-engine"),
    text: '/g, "\\ufffd")',
    replacement: "/g, (c) => c)",
    red: "a lone surrogate in the input is not printed",
  },
  {
    // /sync prints getLastError() raw (the reviewer's C2).
    file: join(cli, "src", "slash-commands.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "        const failed = syncFailureLine(runtime.sync);\n        if (failed) console.error(failed);",
    replacement:
      "        const failed = runtime.sync.getLastError();\n        if (failed) console.error(`Event sync failed: ${failed.message}`);",
    red: "getLastError() carrying the probe",
  },
  {
    // One CLI print of an error message, unsanitized: the static scan names it.
    file: join(cli, "src", "slash-commands.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "console.error(`Event sync failed: ${sanitizeRelayText(message)}`);",
    replacement: "console.error(`Event sync failed: ${message}`);",
    red: "enumerates each console/log/warn/report call carrying an error message",
  },
  {
    // `motebit sync status` does not say which stream holds the floor.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "  else if (s.holdsFloor) {",
    replacement: "  else if (s.holdsFloor && s.acked < 0) {",
    red: "the typo scenario: the typo'd stream holds the floor",
  },
  {
    // REPL start: the pinned floor is never said.
    file: join(cli, "src", "cli-event-push.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "  if (pinned) log(pinned);",
    replacement: "  void pinned;",
    red: "REPL start: replStartupSync prints the notice once",
  },
  {
    // `motebit status`: the pinned floor is never said.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "  if (notice) out.push(`  ${notice}`);",
    replacement: "  void notice;",
    red: "motebit status: one line naming the stream and the retire command",
  },
  {
    // retire: the configured relay is retired without --force.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "if (configured && !ctx.force) {",
    replacement: "if (configured && ctx.force && !ctx.force) {",
    red: "refuses the currently configured relay unless --force",
  },
  {
    // retire: acts without asking.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: 'if (!ctx.yes && !(await ctx.confirm(question))) {\n      ctx.print("Not retired.");',
    replacement: 'if (ctx.yes) {\n      ctx.print("Not retired.");',
    red: "declined at the prompt: nothing changes",
  },
  {
    // retire: not recorded as an event.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: '    await recordAct(store, ctx.motebitId, {\n      action: "sync_stream_retired",',
    replacement: '    void recordAct;\n    void ({\n      action: "sync_stream_retired",',
    red: "confirms, records an event",
  },
  {
    // clear-intent: clears with unacknowledged events on the configured relay.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: "if (unacked > 0 && !ctx.force) {",
    replacement: "if (unacked < 0 && !ctx.force) {",
    red: "refuses while the configured relay has unacked events",
  },
  {
    // clear-intent: not recorded as an event.
    file: join(cli, "src", "subcommands", "sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-doors-962.test.ts"),
    cwd: cli,
    text: '    await recordAct(store, ctx.motebitId, {\n      action: "sync_intent_cleared",',
    replacement: '    void recordAct;\n    void ({\n      action: "sync_intent_cleared",',
    red: "refuses while the configured relay has unacked events",
  },
  // --- #962 round 7: ties, the socket catch-up's text, the compaction-time intent. ---
  {
    // The tied count is the single-stream count: two dead twins report 0.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-ties-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "    s.heldBackTied = tiedFrees;",
    replacement: "    s.heldBackTied = s.heldBack;",
    red: "each tied stream frees nothing alone; together they free 90",
  },
  {
    // The notice reads the single-stream count: a tied set is never reported.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-ties-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (!holder || holder.heldBackTied <= 0) return null;",
    replacement: "if (!holder || holder.heldBack <= 0) return null;",
    red: "the stale tie is reported with the gap to the next distinct stream",
  },
  {
    // One stale twin is enough: a tie with a live relay is reported.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-stream-ties-962.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "if (holders.every((s) => s.lastAckAt === null || now - s.lastAckAt > staleMs)) {",
    replacement: "if (holders.some((s) => s.lastAckAt === null || now - s.lastAckAt > staleMs)) {",
    red: "a tie with a stream that acked recently is not reported",
  },
  {
    // The socket catch-up reports a relay-derived failure raw (the CLI daemon's default).
    file: join(root, "packages", "sync-engine", "src", "ws-adapter.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-text-962-r7.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "(this.config.onCatchUpError ?? warnCatchUpError)(sanitizedCatchUpError(err));",
    replacement: "(this.config.onCatchUpError ?? warnCatchUpError)(err);",
    red: "the default report (no onCatchUpError",
  },
  {
    // The same clause, read by a surface's own onCatchUpError.
    file: join(root, "packages", "sync-engine", "src", "ws-adapter.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-text-962-r7.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "(this.config.onCatchUpError ?? warnCatchUpError)(sanitizedCatchUpError(err));",
    replacement: "(this.config.onCatchUpError ?? warnCatchUpError)(err);",
    red: "a surface's onCatchUpError receives the failure sanitized",
  },
  {
    // The skipped-event default report prints its detail raw.
    file: join(root, "packages", "sync-engine", "src", "seq-cursor.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-text-962-r7.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: "    sanitizeRelayText(\n      `sync: moved past event",
    replacement: "    String(\n      `sync: moved past event",
    red: "prints a relay-derived reason / detail sanitized",
  },
  {
    // The Arabic letter mark and the invisible operators survive.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-text-962-r7.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: '    .replace(/[\\u061c\\u2060-\\u2064]/g, "")\n',
    replacement: "",
    red: "strips U+2063 INVISIBLE SEPARATOR",
  },
  {
    // Tag characters survive.
    file: join(root, "packages", "sync-engine", "src", "relay-text.ts"),
    testFile: join(
      root,
      "packages",
      "sync-engine",
      "src",
      "__tests__",
      "relay-text-962-r7.test.ts",
    ),
    cwd: join(root, "packages", "sync-engine"),
    text: '    .replace(/[\\u{e0000}-\\u{e007f}]/gu, "")\n',
    replacement: "",
    red: "strips U+E0041 TAG LATIN CAPITAL A",
  },
  {
    // `motebit sync status`: a tied stream says retiring it frees nothing.
    file: join(cli, "src", "subcommands/sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-ties-962.test.ts"),
    cwd: cli,
    text: "others > 0 && s.heldBackTied > 0",
    replacement: "others < 0 && s.heldBackTied > 0",
    red: "never 'frees nothing'",
  },
  {
    // The notice names one stream of the tied set.
    file: join(cli, "src", "subcommands/sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-ties-962.test.ts"),
    cwd: cli,
    text: "  const tied = pinned.streams;\n",
    replacement: "  const tied = pinned.streams.slice(0, 1);\n",
    red: "one line naming both streams",
  },
  {
    // `motebit sync retire` on one twin says nothing of the other.
    file: join(cli, "src", "subcommands/sync.ts"),
    testFile: join(cli, "src", "__tests__", "sync-ties-962.test.ts"),
    cwd: cli,
    text: "twins.length > 0 && frees === 0",
    replacement: "twins.length < 0 && frees === 0",
    red: "motebit sync retire on one twin",
  },
  {
    // Compaction never records the intent of a provider that answers "configured" only later.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "    if (decided && answer === true) await this.recordSyncIntentNow();\n    const floor",
    replacement: "    const floor",
    red: "answers 'not configured' at start",
  },
];

function build(name) {
  if (!name) return;
  const out = spawnSync("pnpm", ["--filter", name, "build"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`build ${name} failed:\n${out.stdout}\n${out.stderr}`);
}

// A package's `pretest` (mobile's generated creature bundle), once per package.
const pretested = new Set();
function pretest(cwd) {
  if (pretested.has(cwd)) return;
  pretested.add(cwd);
  const scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
  if (!scripts.pretest) return;
  const out = spawnSync("pnpm", ["run", "pretest"], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`pretest in ${cwd} failed:\n${out.stdout}\n${out.stderr}`);
}

let failed = false;
for (const t of TAMPERS) {
  const original = readFileSync(t.file, "utf8");
  if (!original.includes(t.text)) {
    console.error(`TAMPER DID NOT APPLY (re-target it): ${t.file}: ${JSON.stringify(t.text)}`);
    failed = true;
    continue;
  }
  // TAMPER_DRY=1: check every tamper still applies, run nothing.
  if (process.env.TAMPER_DRY) continue;
  writeFileSync(t.file, original.replace(t.text, t.replacement));
  let out;
  try {
    build(t.build);
    pretest(t.cwd ?? pkg);
    out = spawnSync("npx", ["vitest", "run", t.testFile ?? testFile, "--reporter=verbose"], {
      cwd: t.cwd ?? pkg,
      encoding: "utf8",
    });
  } finally {
    writeFileSync(t.file, original);
    build(t.build);
  }
  const log = `${out.stdout}\n${out.stderr}`;
  const [scope, name] = t.red.includes(" > ") ? t.red.split(" > ") : [null, t.red];
  const redLine = log
    .split("\n")
    .find((l) => l.includes("×") && l.includes(name) && (scope === null || l.includes(scope)));
  if (out.status !== 0 && redLine) {
    console.log(`red as expected: ${t.red}`);
  } else {
    console.error(`STAYED GREEN with the fix removed: ${t.red}\n${log.slice(-4000)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
