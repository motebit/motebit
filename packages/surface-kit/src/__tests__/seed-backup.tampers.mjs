#!/usr/bin/env node
// Tamper check: a committed key rotation invalidates the previous seed backup,
// and the backup status never reports an old seed as covering a different
// key or identity.
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
const kitTest = relative(kitPkg, join(here, "seed-backup.test.ts"));
const repo = join(kitPkg, "..", "..");
const cliPkg = join(repo, "apps", "cli");
const cliSeed = join(cliPkg, "src", "subcommands", "seed.ts");
const cliTest = relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts"));

const KIT = "seedBackupPosture — the acknowledgment covers the key it names";
const KIT_UNBOUND = `${KIT} an unbound (legacy) acknowledgment is never honoured — one re-confirmation, by design`;
const CLI_ROTATE = "motebit rotate — a committed rotation invalidates the previous seed backup";
const CLI_UNBOUND =
  "an unbound (legacy) acknowledgment is never honoured — one re-confirmation, never false text";
const CLI_CARRY = "an acknowledgment is never carried onto a new identity";
const CLI_REVEAL = "motebit seed reveal — the acknowledgment is for what was shown";

/** The unbound (legacy) branch: never honoured. */
const UNBOUND_BRANCH =
  '    return { status: "not_backed_up", reason: "unconfirmed" };\n  }\n  const current';
/** The bare-timestamp reader the defect had. */
const BARE_TIMESTAMP_READER =
  '  if (config.cli_encrypted_key == null) return "no_identity";\n  return typeof config.seed_backed_up_at === "number" ? "backed_up" : "not_backed_up";';

await runTampers(
  [
    // ── Key binding (rounds 1–2) ──────────────────────────────────────
    {
      name: "kit: the acknowledgment's key is not compared to the current key",
      pkg: "@motebit/surface-kit",
      test: kitTest,
      red: "a committed rotation invalidates the previous seed backup rotate (no relay) ⇒ not backed up; the old acknowledgment is untouched",
      edits: [
        {
          file: kitSrc,
          from: "return covered === current\n    ?",
          to: 'return covered !== ""\n    ?',
        },
      ],
    },
    {
      name: "kit: an old backup presented as current (key mismatch) reads backed up",
      pkg: "@motebit/surface-kit",
      test: kitTest,
      red: `${KIT} an old backup presented as current (key mismatch) ⇒ not backed up, naming the covered key`,
      edits: [
        {
          file: kitSrc,
          from: "return covered === current\n    ?",
          to: 'return covered !== ""\n    ?',
        },
      ],
    },
    {
      name: "cli: seedBackupStatus back to the bare timestamp (the defect)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_ROTATE} rotate ⇒ not backed up; the old acknowledgment and the retired key are both still there`,
      edits: [
        {
          file: cliSeed,
          from: "  return seedBackupPostureOf(config).status;",
          to: BARE_TIMESTAMP_READER,
        },
      ],
    },
    {
      name: "cli: interrupted commit finished on resume reads backed up under the bare timestamp",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_ROTATE} commit interrupted between its writes, finished on the next run ⇒ invalidated, and stays so`,
      edits: [
        {
          file: cliSeed,
          from: "  return seedBackupPostureOf(config).status;",
          to: BARE_TIMESTAMP_READER,
        },
      ],
    },
    {
      name: "cli: the reader drops the acknowledgment's key (a bound backup stops counting)",
      pkg: "motebit",
      test: cliTest,
      red: "seedBackupPostureOf / seedBackupStatus — the CLI reader a bound acknowledgment for the current key reads backed up",
      edits: [
        {
          file: cliSeed,
          from: "      ...(config.seed_backed_up_key !== undefined\n        ? { publicKeyHex: config.seed_backed_up_key }\n        : {}),\n",
          to: "",
        },
      ],
    },
    // ── The once-only notice (round 1) ────────────────────────────────
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
    // ── Bound-only (round 5): an unbound acknowledgment is never honoured ──
    {
      name: "kit: an unbound acknowledgment is honoured (a never-rotated v8 identity reads backed up)",
      pkg: "@motebit/surface-kit",
      test: kitTest,
      red: `${KIT_UNBOUND} even for a never-rotated sovereign (v8) identity ⇒ unconfirmed`,
      edits: [
        {
          file: kitSrc,
          from: UNBOUND_BRANCH,
          to: '    return { status: "backed_up", at: ack.at };\n  }\n  const current',
        },
      ],
    },
    {
      name: "cli: an unbound acknowledgment is honoured (main-shaped carry reads backed up)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_UNBOUND} main-shaped carry: X's unbound acknowledgment beside Y's v8 id reads re-confirm`,
      rebuild: ["@motebit/surface-kit"],
      edits: [
        {
          file: kitSrc,
          from: UNBOUND_BRANCH,
          to: '    return { status: "backed_up", at: ack.at };\n  }\n  const current',
        },
      ],
    },
    {
      name: "cli: an unbound acknowledgment is honoured (legacy user reads backed up before a rotation)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_ROTATE} a legacy (unbound) acknowledgment reads not backed up — before a rotation and after it`,
      rebuild: ["@motebit/surface-kit"],
      edits: [
        {
          file: kitSrc,
          from: UNBOUND_BRANCH,
          to: '    return { status: "backed_up", at: ack.at };\n  }\n  const current',
        },
      ],
    },
    {
      name: "kit: unknown coverage is reported as a retired key (the false text)",
      pkg: "@motebit/surface-kit",
      test: kitTest,
      red: `${KIT_UNBOUND} a legacy (random) id ⇒ unconfirmed, never retired_key`,
      edits: [
        {
          file: kitSrc,
          from: UNBOUND_BRANCH,
          to: '    return { status: "not_backed_up", reason: "retired_key", coveredPublicKeyHex: "" };\n  }\n  const current',
        },
      ],
    },
    {
      name: "cli: unknown coverage is worded as a retired key (the false text)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_UNBOUND} unknown coverage is worded 're-confirm' everywhere, and nothing says 'retired'`,
      edits: [
        {
          file: cliSeed,
          from: 'if (posture.status === "not_backed_up" && posture.reason === "retired_key") {',
          to: 'if (posture.status === "not_backed_up" && posture.reason !== "never") {',
        },
      ],
    },
    {
      name: "cli: motebit keychain keeps the old 'still not backed up' text for unknown coverage",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_UNBOUND} unknown coverage is worded 're-confirm' everywhere, and nothing says 'retired'`,
      edits: [
        {
          file: cliSeed,
          from: '      keychain: "Please re-confirm your recovery seed.",',
          to: '      keychain: "Your recovery seed is still not backed up.",',
        },
      ],
    },
    {
      name: "cli: a bound mismatch no longer says retired key",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_UNBOUND} a bound acknowledgment for another key of this identity says 'retired key'`,
      edits: [
        {
          file: cliSeed,
          from: 'if (posture.status === "not_backed_up" && posture.reason === "retired_key") {',
          to: 'if (posture.status === "not_backed_up" && posture.reason === "retired") {',
        },
      ],
    },
    // ── The acknowledgment names its identity (round 5) ────────────────
    {
      name: "kit: another identity's acknowledgment is compared by key only",
      pkg: "@motebit/surface-kit",
      test: kitTest,
      red: `${KIT} the acknowledgment also names its identity another identity ⇒ other_identity, never retired_key — even with the same key`,
      edits: [
        {
          file: kitSrc,
          from: "    if (id.toLowerCase() !== ack.motebitId.toLowerCase()) {",
          to: "    if (id.length < 0) {",
        },
      ],
    },
    {
      name: "cli: another identity is worded without 'for this identity'",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_UNBOUND} a bound acknowledgment for another identity says 'not backed up for this identity', never 'retired'`,
      edits: [
        {
          file: cliSeed,
          from: 'posture.reason === "other_identity"',
          to: 'posture.reason === "other-identity"',
        },
      ],
    },
    {
      name: "cli: motebit seed records without re-checking the key it showed (rotation race)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_REVEAL} a rotation while the seed was on screen ⇒ nothing recorded, with the reason`,
      edits: [
        {
          file: cliSeed,
          from: "    next.motebit_id !== input.shown.motebitId ||\n    next.device_public_key !== input.shown.publicKeyHex\n",
          to: "    next.motebit_id !== input.shown.motebitId\n",
        },
      ],
    },
    {
      name: "cli: motebit seed records without re-checking the identity it showed (switch race)",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_REVEAL} an identity switch while the seed was on screen ⇒ nothing recorded`,
      edits: [
        {
          file: cliSeed,
          from: "    next.motebit_id !== input.shown.motebitId ||\n    next.device_public_key !== input.shown.publicKeyHex\n",
          to: "    next.device_public_key !== input.shown.publicKeyHex\n",
        },
      ],
    },
    // ── Never carried onto a new identity (round 2, + desktop in round 5) ──
    {
      name: "cli: an identity-replacing write carries the old acknowledgment as current",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_CARRY} a new identity written over an old acknowledgment reads not backed up; the old one is kept aside`,
      edits: [
        {
          file: join(cliPkg, "src", "config.ts"),
          from: "        setAsideReplacedSeedBackup(onDisk, write);\n",
          to: "",
        },
      ],
    },
    {
      name: "cli: a stale snapshot carries the replaced identity's acknowledgment back",
      pkg: "motebit",
      test: cliTest,
      red: `${CLI_CARRY} a stale snapshot saved after the identity was replaced never carries the old acknowledgment back`,
      edits: [
        {
          file: join(cliPkg, "src", "config.ts"),
          from: "        for (const f of [...IDENTITY_FIELDS, ...SEED_BACKUP_FIELDS]) {",
          to: "        for (const f of IDENTITY_FIELDS) {",
        },
      ],
    },
    {
      name: "create-motebit: the replace path carries the old acknowledgment as current",
      pkg: "create-motebit",
      test: "src/__tests__/config-file-seed-backup.test.ts",
      red: "create-motebit replace — the old seed-backup acknowledgment is set aside, never carried a new identity over an acknowledged one: no current acknowledgment, the old one kept",
      edits: [
        {
          file: join(repo, "packages", "create-motebit", "src", "config-file.ts"),
          from: "        setAsideReplacedSeedBackup(onDisk as Record<string, unknown>, write);\n",
          to: "",
        },
      ],
    },
    {
      name: "desktop: an identity switch carries the old acknowledgment as current",
      pkg: "@motebit/desktop",
      test: "src/__tests__/identity-switch-seed-backup.test.ts",
      red: "desktop identity switch — the outgoing identity's seed backup is set aside, never carried switching X → Y moves X's acknowledgment into seed_backup_prior; nothing is current",
      edits: [
        {
          file: join(repo, "apps", "desktop", "src", "identity-manager.ts"),
          from: "  await updateConfig(invoke, { ...patch, ...seed.patch }, seed.expect);",
          to: "  await updateConfig(invoke, patch);",
        },
      ],
    },
  ],
  { root: here },
);
