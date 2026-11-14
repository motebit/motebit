#!/usr/bin/env node
// Tamper check: a committed key rotation invalidates the previous seed backup.
//
// Each entry reverts one piece of the fix and names the test expected to go
// red. The shared runner (scripts/lib/tamper-runner.ts) applies each tamper
// in an isolated copy of the tree.
//
//   node packages/surface-kit/src/__tests__/seed-backup.tampers.mjs [--concurrency=N]

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kitPkg = join(here, "..", "..");
const kitSrc = join(kitPkg, "src", "seed-backup.ts");
const repo = join(kitPkg, "..", "..");
const cliPkg = join(repo, "apps", "cli");
const cliSeed = join(cliPkg, "src", "subcommands", "seed.ts");

await runTampers(
  [
    {
      name: "kit: the acknowledgment's key is not compared to the current key",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "a committed rotation invalidates the previous seed backup rotate (no relay) ⇒ not backed up; the old acknowledgment is untouched",
      edits: [
        {
          file: kitSrc,
          from: 'return current !== "" && covered === current\n      ?',
          to: 'return covered !== ""\n      ?',
        },
      ],
    },
    {
      name: "kit: the fingerprint mismatch (an old backup presented as current) reads backed up",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names an old backup presented as current (key mismatch) ⇒ not backed up, naming the covered key",
      edits: [
        {
          file: kitSrc,
          from: 'return current !== "" && covered === current\n      ?',
          to: 'return covered !== ""\n      ?',
        },
      ],
    },
    {
      name: "kit: a legacy unbound acknowledgment is honoured after a rotation",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) NOT honoured once a sovereign identity has rotated (the already-rotated upgrader)",
      edits: [
        {
          file: kitSrc,
          from: '    if (genesis) return { status: "backed_up", at: ack.at };',
          to: '    if (genesis || current !== "") return { status: "backed_up", at: ack.at };',
        },
      ],
    },
    {
      name: "cli: seedBackupStatus back to the bare timestamp (the defect)",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "motebit rotate — a committed rotation invalidates the previous seed backup rotate ⇒ not backed up; the old acknowledgment and the retired key are both still there",
      edits: [
        {
          file: cliSeed,
          from: "  return (await seedBackupPostureOf(config)).status;",
          to: '  if (config.cli_encrypted_key == null) return "no_identity";\n  return typeof config.seed_backed_up_at === "number" ? "backed_up" : "not_backed_up";',
        },
      ],
    },
    {
      name: "cli: interrupted commit finished on resume still reads backed up under the bare timestamp",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "motebit rotate — a committed rotation invalidates the previous seed backup commit interrupted between its writes, finished on the next run ⇒ invalidated, and stays so",
      edits: [
        {
          file: cliSeed,
          from: "  return (await seedBackupPostureOf(config)).status;",
          to: '  if (config.cli_encrypted_key == null) return "no_identity";\n  return typeof config.seed_backed_up_at === "number" ? "backed_up" : "not_backed_up";',
        },
      ],
    },
    {
      name: "cli: the reader drops the acknowledgment's key (falls back to the legacy rule)",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "seedBackupPostureOf / seedBackupStatus — the CLI reader an old backup presented as current (bound to another key) reads not backed up",
      edits: [
        {
          file: cliSeed,
          from: "      ...(config.seed_backed_up_key !== undefined\n        ? { publicKeyHex: config.seed_backed_up_key }\n        : {}),\n",
          to: "",
        },
      ],
    },
    {
      name: "web: a committed rotation says nothing about the seed",
      pkg: "@motebit/web",
      test: "src/__tests__/settings-rotation-seed-notice.test.ts",
      red: "web Settings — Rotate Key tells the owner the seed changed a committed rotation says the seed notice, once",
      edits: [
        {
          file: join(repo, "apps", "web", "src", "ui", "settings.ts"),
          from: '        addMessage("system", ROTATION_SEED_BACKUP_NOTICE);\n',
          to: "",
        },
      ],
    },
    {
      name: "desktop: a committed rotation says nothing about the seed",
      pkg: "@motebit/desktop",
      test: "src/__tests__/settings-rotation-seed-notice.test.ts",
      red: "desktop Settings — Rotate Key tells the owner the seed changed a committed rotation says the seed notice, once",
      edits: [
        {
          file: join(repo, "apps", "desktop", "src", "ui", "settings.ts"),
          from: '      addMessage("system", ROTATION_SEED_BACKUP_NOTICE);\n',
          to: "",
        },
      ],
    },
    {
      name: "mobile: the Key Rotated alert drops the seed notice",
      pkg: "@motebit/mobile",
      test: "src/__tests__/settings-modal-rotation-seed-notice.test.tsx",
      red: "mobile SettingsModal — Rotate Key tells the owner the seed changed a committed rotation's alert carries the seed notice",
      edits: [
        {
          file: join(repo, "apps", "mobile", "src", "components", "SettingsModal.tsx"),
          from: "...\\n\\n${ROTATION_SEED_BACKUP_NOTICE}`,",
          to: "...`,",
        },
      ],
    },
  ],
  { root: here },
);
