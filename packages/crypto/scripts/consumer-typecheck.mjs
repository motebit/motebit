#!/usr/bin/env node
/**
 * Pack-and-typecheck the published `@motebit/crypto` as a standalone
 * consumer would see it.
 *
 * `publint` + `attw` (the rest of `lint:pack`) check the manifest and the
 * export map, but neither installs the tarball next to ONLY what its
 * manifest declares and type-checks it with `skipLibCheck: false`. That is
 * the failure a real consumer hits: the emitted `.d.ts` files import
 * `@motebit/protocol`, so a manifest that does not declare it produces
 * `TS2307: Cannot find module '@motebit/protocol'` the moment a consumer
 * stops skipping lib checks.
 *
 * Steps:
 *   1. `pnpm pack` this package (workspace ranges rewritten exactly as on
 *      publish) into a scratch dir.
 *   2. Read the PACKED manifest. The consumer installs ONLY this package's
 *      tarball; peers are left to the package manager. npm >= 7 and pnpm
 *      auto-install every NON-optional peer and never install an optional
 *      one, so a peer marked `optional` in `peerDependenciesMeta` is absent
 *      from a plain `npm i @motebit/crypto`. The scan is hermetic (offline,
 *      no registry), so auto-install is simulated exactly: each
 *      non-optional peer (and every `dependencies` entry) is packed from the
 *      workspace and installed; optional peers are not installed, and the
 *      script asserts they are absent. A declared non-workspace dependency
 *      is a failure — the package promises zero runtime dependencies.
 *   3. Run `tsc --noEmit` with `skipLibCheck: false` over a file that
 *      imports both export-map entries.
 *
 * Exit 0 on a clean typecheck, 1 otherwise (with the compiler output).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgDir, "../..");
const require = createRequire(join(pkgDir, "package.json"));
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");

const scratch = mkdtempSync(join(tmpdir(), "motebit-crypto-consumer-"));
const packs = join(scratch, "packs");
mkdirSync(packs);

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function pack(dir) {
  const before = new Set(readdirSync(packs));
  run("pnpm", ["pack", "--pack-destination", packs], dir);
  const added = readdirSync(packs).filter((f) => !before.has(f));
  if (added.length !== 1) throw new Error(`expected one tarball from ${dir}, got ${added}`);
  return join(packs, added[0]);
}

function workspacePackageDir(name) {
  for (const group of ["packages", "services", "apps"]) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, group));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(repoRoot, group, entry);
      try {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (manifest.name === name) return dir;
      } catch {
        // not a package
      }
    }
  }
  return null;
}

let failed = false;
try {
  const own = pack(pkgDir);
  const packed = JSON.parse(
    run("tar", ["-xzOf", own, "package/package.json"], scratch),
  );
  const optionalMeta = packed.peerDependenciesMeta ?? {};
  const peers = Object.keys(packed.peerDependencies ?? {});
  const optionalPeers = peers.filter((name) => optionalMeta[name]?.optional === true);
  // What `npm i <this package>` actually installs next to it: runtime deps
  // plus every non-optional peer. Optional peers are never auto-installed.
  const autoInstalled = [
    ...Object.keys(packed.dependencies ?? {}),
    ...peers.filter((name) => !optionalPeers.includes(name)),
  ];

  if (Object.keys(packed.dependencies ?? {}).length > 0) {
    console.error(
      `consumer-typecheck: ${packed.name} declares runtime dependencies ` +
        `${JSON.stringify(packed.dependencies)} — it promises zero.`,
    );
    failed = true;
  }

  const consumerDeps = { [packed.name]: `file:${own}` };
  for (const name of autoInstalled) {
    const dir = workspacePackageDir(name);
    if (dir === null) {
      console.error(`consumer-typecheck: declared dependency ${name} is not a workspace package`);
      failed = true;
      continue;
    }
    consumerDeps[name] = `file:${pack(dir)}`;
  }

  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: consumerDeps }),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
        lib: ["es2022", "dom"],
      },
      include: ["index.ts"],
    }),
  );
  writeFileSync(
    join(consumer, "index.ts"),
    [
      `import * as crypto from "${packed.name}";`,
      `import * as dispatch from "${packed.name}/suite-dispatch";`,
      `export const surface: unknown[] = [crypto, dispatch];`,
      "",
    ].join("\n"),
  );
  run(
    "npm",
    ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
    consumer,
  );
  for (const name of optionalPeers) {
    let present = true;
    try {
      readFileSync(join(consumer, "node_modules", name, "package.json"));
    } catch {
      present = false;
    }
    if (present) {
      console.error(`consumer-typecheck: optional peer ${name} was installed — simulation is wrong`);
      failed = true;
    }
  }

  try {
    run(process.execPath, [tsc, "-p", "tsconfig.json"], consumer);
    if (!failed) {
      console.log(
        `consumer-typecheck: ${packed.name}@${packed.version} type-checks standalone ` +
          `(skipLibCheck: false) with auto-installed deps [${autoInstalled.join(", ")}]`,
      );
    }
  } catch (err) {
    failed = true;
    console.error(
      `consumer-typecheck: ${packed.name} does not type-check for a standalone consumer ` +
        `(skipLibCheck: false, auto-installed deps [${autoInstalled.join(", ")}], ` +
        `optional peers NOT installed [${optionalPeers.join(", ")}]):`,
    );
    console.error(String(err.stdout ?? "") + String(err.stderr ?? ""));
    console.error(
      "Repair: every package a published .d.ts imports must be declared in package.json " +
        "(type-only imports included) as a dependency or a NON-optional peer — npm never " +
        "installs an optional peer. See the peerDependencies note in packages/crypto/CLAUDE.md.",
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
