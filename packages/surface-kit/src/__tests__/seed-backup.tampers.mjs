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
const kitIdentityFile = join(kitPkg, "src", "machine-roster-identity-file.ts");
/** Round 4's fixes. */
const V8_DATE_VETO = "  if (bound.length > 0 && !bound.some(signedByAck)) return false;\n";
const STRICT_DATE = '  if (typeof value !== "string" || !FULL_ISO_8601.test(value)) return null;';
const LOOSE_DATE = '  if (typeof value !== "string" || FULL_ISO_8601.source === "") return null;';
/** Round 3's fix: a zero-succession file counts only when signed no later than the acknowledgment. */
const DATE_CHECK = "    if (bound.createdAtMs != null && bound.createdAtMs <= ackAt) return true;";
// A revert the package build accepts: no unreachable code, and ackAt still read (tsc -b sets noUnusedParameters).
const NO_DATE_CHECK = "    if (bound != null || ackAt < 0) return true;";

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
          from: "return covered === current\n      ?",
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
          from: "return covered === current\n      ?",
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
          from: "  return false;\n}",
          to: "  return true;\n}",
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
          from: "  return (await seedBackupPostureOf(config, opts)).status;",
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
          from: "  return (await seedBackupPostureOf(config, opts)).status;",
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
    // ── Round 2: cold-review findings ──────────────────────────────────
    {
      name: "kit: a zero-succession bound identity file no longer proves the genesis key",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) legacy (random) id, never rotated: a bound zero-succession file signed BEFORE the acknowledgment ⇒ backed up",
      edits: [
        {
          file: kitSrc,
          from: "    if (bound == null || bound.records.length !== 0) continue;",
          to: "    if (bound == null || bound.records.length >= 0) continue;",
        },
      ],
    },
    {
      name: "cli: a never-rotated legacy identity with a zero-succession motebit.md is a false alarm again",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text never-rotated legacy id with a zero-succession motebit.md reads backed up",
      rebuild: ["@motebit/surface-kit"],
      edits: [
        {
          file: kitSrc,
          from: "    if (bound == null || bound.records.length !== 0) continue;",
          to: "    if (bound == null || bound.records.length >= 0) continue;",
        },
      ],
    },
    {
      name: "kit: unknown coverage is reported as a retired key (the false text)",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) legacy (random) id, no identity file ⇒ unconfirmed (re-confirm), never retired_key",
      edits: [
        {
          file: kitSrc,
          from: '  return { status: "not_backed_up", reason: "unconfirmed" };\n}',
          to: '  return { status: "not_backed_up", reason: "retired_key", coveredPublicKeyHex: "" };\n}',
        },
      ],
    },
    {
      name: "cli: unknown coverage is worded as a retired key (the false text)",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text legacy id with unknown coverage reads 're-confirm', and nothing says 'retired'",
      edits: [
        {
          file: cliSeed,
          from: 'if (posture.status === "not_backed_up" && posture.reason === "retired_key") {',
          to: 'if (posture.status === "not_backed_up" && posture.reason !== "never") {',
        },
      ],
    },
    {
      name: "cli: a bound mismatch no longer says retired key",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text a bound acknowledgment for another key still says 'retired key'",
      edits: [
        {
          file: cliSeed,
          from: 'if (posture.status === "not_backed_up" && posture.reason === "retired_key") {',
          to: 'if (posture.status === "not_backed_up" && posture.reason === "retired") {',
        },
      ],
    },
    {
      name: "cli: an identity-replacing write carries the old acknowledgment as current",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "an acknowledgment is never carried onto a new identity a new identity written over an old acknowledgment reads not backed up; the old one is kept aside",
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
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "an acknowledgment is never carried onto a new identity a stale snapshot saved after the identity was replaced never carries the old acknowledgment back",
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
    // ── Round 3: a file regenerated after the acknowledgment proves nothing ──
    {
      name: "kit: the signed-date check is dropped (a regenerated file proves genesis again)",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) a zero-succession file signed AFTER the acknowledgment (a regenerate) proves nothing ⇒ unconfirmed",
      edits: [{ file: kitSrc, from: DATE_CHECK, to: NO_DATE_CHECK }],
    },
    {
      name: "kit: rotate + regenerate reads backed up without the signed-date check",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) rotate, regenerate a fresh zero-succession file for the new key, read ⇒ not backed up",
      edits: [{ file: kitSrc, from: DATE_CHECK, to: NO_DATE_CHECK }],
    },
    {
      name: "cli: rotate + regenerate motebit.md reads backed up without the signed-date check",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text rotate, regenerate motebit.md for the new key, read: not backed up",
      rebuild: ["@motebit/surface-kit"],
      edits: [{ file: kitSrc, from: DATE_CHECK, to: NO_DATE_CHECK }],
    },
    {
      name: "cli: a motebit.md signed after the acknowledgment reads backed up without the signed-date check",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text a zero-succession motebit.md signed after the acknowledgment (a regenerate) reads re-confirm",
      rebuild: ["@motebit/surface-kit"],
      edits: [{ file: kitSrc, from: DATE_CHECK, to: NO_DATE_CHECK }],
    },
    {
      name: "kit: the date comparison never passes (a file older than the acknowledgment stops counting)",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) legacy (random) id, never rotated: a bound zero-succession file signed BEFORE the acknowledgment ⇒ backed up",
      edits: [
        {
          file: kitSrc,
          from: DATE_CHECK,
          to: "    if (bound.createdAtMs != null && bound.createdAtMs < 0) return true;",
        },
      ],
    },
    {
      name: "cli: motebit keychain keeps the old 'still not backed up' text for unknown coverage",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text legacy id with unknown coverage reads 're-confirm', and nothing says 'retired'",
      edits: [
        {
          file: cliSeed,
          from: '      keychain: "Please re-confirm your recovery seed.",',
          to: '      keychain: "Your recovery seed is still not backed up.",',
        },
      ],
    },
    // ── Round 4: date evidence binds the v8 rule; strict dates; future acks; writer pins ──
    {
      name: "kit: the v8 rule ignores date evidence (main-shaped carry reads backed up)",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) main-shaped carry: X's unbound acknowledgment, Y's v8 id, Y's motebit.md signed after it ⇒ unconfirmed",
      edits: [{ file: kitSrc, from: V8_DATE_VETO, to: "" }],
    },
    {
      name: "cli: the v8 rule ignores date evidence (main-shaped carry reads backed up)",
      pkg: "motebit",
      test: relative(cliPkg, join(cliPkg, "src", "__tests__", "seed-backup-rotation.test.ts")),
      red: "a legacy (unbound) acknowledgment is never a false alarm with false text main-shaped carry: X's unbound acknowledgment, Y's v8 id and Y's motebit.md signed after it ⇒ re-confirm",
      rebuild: ["@motebit/surface-kit"],
      edits: [{ file: kitSrc, from: V8_DATE_VETO, to: "" }],
    },
    {
      name: "kit: a date-only created_at is accepted as proof",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) a date-only created_at proves nothing ⇒ unconfirmed",
      edits: [{ file: kitIdentityFile, from: STRICT_DATE, to: LOOSE_DATE }],
    },
    {
      name: "kit: a zoneless created_at is accepted as proof",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) a zoneless created_at proves nothing ⇒ unconfirmed",
      edits: [{ file: kitIdentityFile, from: STRICT_DATE, to: LOOSE_DATE }],
    },
    {
      name: "kit: a future-dated acknowledgment is honoured",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup.test.ts")),
      red: "seedBackupPosture — the acknowledgment covers the key it names legacy acknowledgment (no key recorded) an acknowledgment dated more than the skew in the future is unproven ⇒ unconfirmed",
      edits: [
        {
          file: kitSrc,
          from: "  if (ack.at > now + ACK_FUTURE_SKEW_MS) return",
          to: "  if (ack.at > now + ACK_FUTURE_SKEW_MS && now < 0) return",
        },
      ],
    },
    {
      name: "writers: create-motebit regenerate preserves a genesis created_at",
      pkg: "create-motebit",
      test: "src/__tests__/created-at-write-time.test.ts",
      red: "create-motebit writers stamp created_at at write time generateIdentity and regenerateIdentityFile both date the file now, with a zone",
      edits: [
        {
          file: join(repo, "packages", "create-motebit", "src", "generate.ts"),
          from: "    motebit_id: opts.motebitId,\n    created_at: new Date().toISOString(),",
          to: '    motebit_id: opts.motebitId,\n    created_at: "2020-01-01T00:00:00.000Z",',
        },
      ],
    },
    {
      name: "writers: identity-file generate stops defaulting created_at to now",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup-writers.test.ts")),
      red: "identity-file generate stamps created_at at write time no createdAt given ⇒ created_at is the signing time, as a full zoned timestamp",
      rebuild: ["@motebit/identity-file"],
      edits: [
        {
          file: join(repo, "packages", "identity-file", "src", "index.ts"),
          from: "    created_at: opts.createdAt ?? new Date().toISOString(),",
          to: '    created_at: opts.createdAt ?? "2020-01-01T00:00:00.000Z",',
        },
      ],
    },
    {
      name: "writers: the CLI export starts preserving a created_at",
      pkg: "@motebit/surface-kit",
      test: relative(kitPkg, join(here, "seed-backup-writers.test.ts")),
      red: "no production writer preserves a genesis created_at no call of identity-file generate passes createdAt",
      edits: [
        {
          file: join(cliPkg, "src", "subcommands", "export.ts"),
          from: "      motebitId,\n      ownerId: motebitId,\n      publicKeyHex,\n      devices,\n",
          to: '      motebitId,\n      ownerId: motebitId,\n      publicKeyHex,\n      devices,\n      createdAt: "2020-01-01T00:00:00.000Z",\n',
        },
      ],
    },
  ],
  { root: here },
);
