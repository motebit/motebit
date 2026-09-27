/**
 * Mobile ↔ Expo SDK alignment.
 *
 * Every dependency of `apps/mobile` that the installed Expo SDK versions
 * (listed in `expo/bundledNativeModules.json`) must resolve, in
 * `pnpm-lock.yaml`, to a version inside the range that SDK names. This is the
 * check `npx expo install --check` makes, run against the lockfile.
 *
 * Why this is "no build" and not a warning: an Expo SDK pins one React Native
 * line and the Metro/Hermes toolchain that can parse it. A react-native past
 * that line ships Flow syntax the SDK's hermes-parser cannot read, so Metro
 * dies mid-bundle and NO iOS or Android build of the app can be produced.
 * #844: a dependabot bump moved react-native 0.83.10 → 0.87.0 (with react and
 * a dozen expo-* modules) under SDK 55; everything else stayed green, because
 * no CI step bundles the mobile app. Found only when a Release build was
 * attempted on a physical phone.
 *
 * Canonical sources:
 *   - the RESOLVED versions: `pnpm-lock.yaml`, importer `apps/mobile` (what
 *     dependabot moves and what CI installs with --frozen-lockfile);
 *   - the EXPECTED ranges: `bundledNativeModules.json` of the expo version that
 *     same importer resolves. It is read from the installed package, and the
 *     gate first checks that the installed expo IS the lockfile's expo, so a
 *     stale node_modules cannot lend it the wrong table.
 *
 * Deliberately offline: `expo install --check` online also asks api.expo.dev,
 * whose answer moves when Expo publishes a patch — a gate that goes red with
 * no repo change is a time bomb. The SDK's bundled table is fixed per expo
 * version, so this verdict is a function of the lockfile alone. It catches the
 * dangerous class (a react / react-native / native-module version off the
 * SDK line); patch-level floors the online API adds are not asserted here.
 *
 * `expo.install.exclude` in apps/mobile/package.json is honoured for bare
 * package names (the only form used); any other form fails closed.
 *
 * Exit 1 on any violation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();
const LOCKFILE = "pnpm-lock.yaml";
const IMPORTER = "apps/mobile";
const MANIFEST = `${IMPORTER}/package.json`;
const EXPO_DIR = `${IMPORTER}/node_modules/expo`;
const TABLE = `${EXPO_DIR}/bundledNativeModules.json`;

type Version = [number, number, number];

function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * The three range forms bundledNativeModules.json uses: exact `X.Y.Z`,
 * `~X.Y.Z` (same minor), `^X.Y.Z` (npm caret, 0.x-aware). Returns null for any
 * other form so the caller fails closed instead of guessing.
 */
function satisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  const m = /^([~^]?)(\d+\.\d+\.\d+)$/.exec(range);
  if (v == null || m == null) return null;
  const base = parseVersion(m[2]!)!;
  if (cmp(v, base) < 0) return false;
  if (m[1] === "") return cmp(v, base) === 0;
  if (m[1] === "~") return v[0] === base[0] && v[1] === base[1];
  // caret: the left-most non-zero component is fixed
  if (base[0] !== 0) return v[0] === base[0];
  if (base[1] !== 0) return v[0] === 0 && v[1] === base[1];
  return v[0] === 0 && v[1] === 0 && v[2] === base[2];
}

/**
 * name → resolved version for every dependency / devDependency of one
 * lockfile importer. Peer suffixes (`0.83.10(@babel/core@…)`) are stripped;
 * `link:` / `workspace:` entries are returned as-is (never in the SDK table).
 *
 *   importers:
 *     apps/mobile:
 *       dependencies:
 *         react-native:
 *           specifier: 0.83.10
 *           version: 0.83.10(@babel/core@7.29.7)…
 */
function importerVersions(lock: string, importer: string): Map<string, string> | null {
  const lines = lock.split("\n");
  const start = lines.findIndex((l) => l === `  ${importer}:`);
  if (start < 0) return null;
  const out = new Map<string, string>();
  let pkg: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^ {0,2}\S/.test(line)) break; // next importer or top-level section
    const name = /^ {6}('?)([^\s':]+(?:\/[^\s':]+)?)\1:$/.exec(line);
    if (name) {
      pkg = name[2]!;
      continue;
    }
    const ver = /^ {8}version: (\S+)$/.exec(line);
    if (ver && pkg != null) {
      out.set(pkg, ver[1]!.split("(")[0]!);
      pkg = null;
    }
  }
  return out;
}

function main(): void {
  const lock = readFileSync(join(ROOT, LOCKFILE), "utf8");
  const resolved = importerVersions(lock, IMPORTER);
  if (resolved == null || resolved.size === 0) {
    failWithRepair({
      invariant: `${LOCKFILE} must carry an importer for ${IMPORTER} — the gate has nothing to hold to the Expo SDK`,
      sites: [`${LOCKFILE}: no \`  ${IMPORTER}:\` importer block`],
      canonical: `${LOCKFILE} (importers.${IMPORTER})`,
      fix: `Run \`pnpm install\` at the repo root to regenerate the lockfile; if ${IMPORTER} moved, update IMPORTER in scripts/check-mobile-expo-alignment.ts.`,
    });
  }
  const expoVersion = resolved.get("expo");
  if (expoVersion == null) {
    failWithRepair({
      invariant: `${IMPORTER} must depend on expo — the SDK table this gate reads is expo's`,
      sites: [`${LOCKFILE}: importer ${IMPORTER} resolves no \`expo\``],
      canonical: MANIFEST,
      fix: `Restore the \`expo\` dependency in ${MANIFEST}, or retire this gate (scripts/check.ts GATES, docs/drift-defenses.md #164) if the app left Expo.`,
    });
  }

  const installedExpo = existsSync(join(ROOT, EXPO_DIR, "package.json"))
    ? (
        JSON.parse(readFileSync(join(ROOT, EXPO_DIR, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version
    : undefined;
  if (installedExpo !== expoVersion || !existsSync(join(ROOT, TABLE))) {
    failWithRepair({
      invariant: `the SDK table must come from the expo the lockfile resolves (expo@${expoVersion}), so a stale install cannot lend the gate the wrong expected versions`,
      sites: [
        `${EXPO_DIR}: installed ${installedExpo ?? "nothing"}, ${LOCKFILE} resolves expo@${expoVersion}`,
      ],
      canonical: `${LOCKFILE} (importers.${IMPORTER}.dependencies.expo)`,
      fix: "Run `pnpm install --frozen-lockfile` at the repo root, then re-run `pnpm check-mobile-expo-alignment`.",
    });
  }

  const table = JSON.parse(readFileSync(join(ROOT, TABLE), "utf8")) as Record<string, string>;
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8")) as {
    expo?: { install?: { exclude?: string[] } };
  };
  const exclude = manifest.expo?.install?.exclude ?? [];
  const violations: string[] = [];
  for (const entry of exclude) {
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(entry)) {
      violations.push(
        `${MANIFEST}: expo.install.exclude entry "${entry}" is not a bare package name — this gate does not interpret version-scoped excludes; widen the gate or use a bare name`,
      );
    }
  }

  const checked: string[] = [];
  for (const [name, version] of [...resolved].sort(([a], [b]) => a.localeCompare(b))) {
    const range = table[name];
    if (range == null || exclude.includes(name)) continue;
    checked.push(name);
    const ok = satisfies(version, range);
    if (ok === null) {
      violations.push(
        `${name}: cannot compare ${version} against the SDK's "${range}" — the gate knows exact, ~ and ^ only; extend satisfies() in scripts/check-mobile-expo-alignment.ts`,
      );
    } else if (!ok) {
      violations.push(
        `${name}@${version} (${LOCKFILE}, importer ${IMPORTER}) — expo@${expoVersion} expects ${range}`,
      );
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant: `every ${IMPORTER} dependency the installed Expo SDK versions must resolve inside the range that SDK names — a react-native past the SDK line ships syntax the SDK's Metro/Hermes cannot parse, and no iOS or Android bundle can be built (#844)`,
      sites: violations,
      canonical: `${TABLE} (the expected ranges of expo@${expoVersion}) and ${LOCKFILE} (importers.${IMPORTER} — the versions installed)`,
      fix: `In ${IMPORTER} run \`CI=1 npx expo install --fix\`, then \`pnpm install\` at the root, and prove the bundle with \`CI=1 npx expo export --platform ios\`. If a dependabot PR moved these, close it: an SDK-line move is the Expo SDK upgrade arc (#416), never a lockfile merge — and add the package to the SDK-line ignores in .github/dependabot.yml.`,
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }

  const skipped = resolved.size - checked.length;
  console.log(
    `✓ Mobile Expo alignment: ${checked.length} of ${resolved.size} ${IMPORTER} dependencies are versioned by expo@${expoVersion} and resolve inside its ranges (${skipped} not in the SDK table, ${exclude.length} excluded; ${Object.keys(table).length} SDK table entries).`,
  );
}

main();
