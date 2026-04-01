// Prevent Expo from using monorepo root as Metro server root
process.env.EXPO_NO_METRO_WORKSPACE_ROOT = "1";

// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;

// Watch the monorepo packages
config.watchFolders = [monorepoRoot];

// Resolve modules from both the app's node_modules and the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Enable package exports resolution (handles subpath exports like ./client/index.js)
config.resolver.unstable_enablePackageExports = true;

// ---------------------------------------------------------------------------
// Node.js built-in shimming
//
// Mobile never calls MCP stdio, shell-exec, DNS discovery, or Node HTTP.
// Those imports exist in the bundle but are dead code paths on mobile.
//
// Strategy:
//   - buffer, events, stream → real npm polyfill packages (needed by transitive deps)
//   - everything else        → empty.js no-op stub
// ---------------------------------------------------------------------------
const emptyModule = path.resolve(projectRoot, "shims/empty.js");

// Modules that have real npm polyfill packages installed.
// Bare names resolve via extraNodeModules below; node: prefixed names need
// explicit routing here because the node: prefix triggers the shim catch-all.
const polyfilled = new Set(["node:buffer", "node:events", "node:stream"]);

// Node built-ins that should be shimmed to empty (never called on mobile).
// buffer, events, stream are NOT in this set — they have real polyfills.
const emptyBuiltins = new Set([
  "child_process",
  "crypto",
  "dns",
  "http",
  "https",
  "net",
  "tls",
  "fs",
  "os",
  "path",
  "zlib",
  "util",
  "url",
  "assert",
  "readline",
  "worker_threads",
  "async_hooks",
  "string_decoder",
  "tty",
  "dgram",
  "cluster",
  "vm",
  "v8",
  "perf_hooks",
  "querystring",
  "punycode",
]);

// pnpm stores packages as symlinks into .pnpm store.
// Watchman ignores node_modules, so we can't return .pnpm real paths.
// Instead, verify the file exists via realpath but return the symlink path
// that lives OUTSIDE node_modules (in watchFolders scope).
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Let polyfilled node: imports fall through to extraNodeModules
  if (polyfilled.has(moduleName)) {
    return context.resolveRequest(context, moduleName, platform);
  }
  // Shim all other node: imports and bare Node built-in names to empty
  if (moduleName.startsWith("node:") || emptyBuiltins.has(moduleName)) {
    return { type: "sourceFile", filePath: emptyModule };
  }

  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (defaultError) {
    // Fallback: manual resolution for pnpm symlink edge cases
    const parts = moduleName.split("/");
    let pkgName, subPath;
    if (moduleName.startsWith("@") && parts.length >= 2) {
      pkgName = parts.slice(0, 2).join("/");
      subPath = parts.slice(2).join("/");
    } else {
      pkgName = parts[0];
      subPath = parts.slice(1).join("/");
    }

    const searchDirs = [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(monorepoRoot, "node_modules"),
    ];

    for (const dir of searchDirs) {
      const pkgPath = path.resolve(dir, pkgName);
      if (!fs.existsSync(pkgPath)) continue;

      // Check package.json "exports" field for subpath resolution
      if (subPath) {
        try {
          const pkgJsonPath = path.resolve(pkgPath, "package.json");
          const realPkgJson = fs.realpathSync(pkgJsonPath);
          const pkg = JSON.parse(fs.readFileSync(realPkgJson, "utf8"));
          if (pkg.exports) {
            const exportKey = "./" + subPath;
            const exportEntry = pkg.exports[exportKey];
            if (exportEntry) {
              const resolved =
                typeof exportEntry === "string"
                  ? exportEntry
                  : exportEntry.default || exportEntry.require || exportEntry.import;
              if (resolved) {
                const exportPath = path.resolve(pkgPath, resolved);
                try {
                  const real = fs.realpathSync(exportPath);
                  if (fs.statSync(real).isFile()) {
                    return { type: "sourceFile", filePath: exportPath };
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }

      // Direct file resolution as fallback
      const targetPath = subPath ? path.resolve(pkgPath, subPath) : pkgPath;

      const exts = ["", ".js", ".ts", ".tsx", ".json", "/index.js", "/index.ts"];
      for (const ext of exts) {
        const candidate = targetPath + ext;
        try {
          const real = fs.realpathSync(candidate);
          if (fs.statSync(real).isFile()) {
            return { type: "sourceFile", filePath: candidate };
          }
        } catch {
          // doesn't exist, try next
        }
      }

      // If it's a directory, check package.json main field
      try {
        const real = fs.realpathSync(targetPath);
        if (fs.statSync(real).isDirectory()) {
          const pkgJson = path.resolve(targetPath, "package.json");
          if (fs.existsSync(pkgJson)) {
            const pkg = JSON.parse(fs.readFileSync(fs.realpathSync(pkgJson), "utf8"));
            const main = pkg.main || "index.js";
            const mainPath = path.resolve(targetPath, main);
            for (const ext of ["", ".js", ".ts", ".tsx"]) {
              const candidate = mainPath + ext;
              try {
                const r = fs.realpathSync(candidate);
                if (fs.statSync(r).isFile()) {
                  return { type: "sourceFile", filePath: candidate };
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    throw defaultError;
  }
};

// Map node:-prefixed polyfills and bare names for pnpm-isolated deps.
// Shim files re-export the npm polyfill packages.
const bufferShim = path.resolve(projectRoot, "shims/buffer-shim.js");
const eventsShim = path.resolve(projectRoot, "shims/events-shim.js");
const streamShim = path.resolve(projectRoot, "shims/stream-shim.js");
config.resolver.extraNodeModules = {
  // Real polyfills (node: prefix → shim file → npm package)
  "node:buffer": bufferShim,
  "node:events": eventsShim,
  "node:stream": streamShim,
  // Bare names for pnpm-isolated deps that can't find these packages
  stream: path.resolve(projectRoot, "node_modules/readable-stream"),
  buffer: path.resolve(projectRoot, "node_modules/buffer"),
  events: path.resolve(projectRoot, "node_modules/events"),
  // Empty stubs for node:-prefixed built-ins
  "node:process": emptyModule,
  "node:child_process": emptyModule,
  "node:fs": emptyModule,
  "node:path": emptyModule,
  "node:os": emptyModule,
  "node:net": emptyModule,
  "node:tls": emptyModule,
  "node:http": emptyModule,
  "node:https": emptyModule,
  "node:util": emptyModule,
  "node:url": emptyModule,
  "node:crypto": emptyModule,
  "node:zlib": emptyModule,
  "node:dns": emptyModule,
  "node:dns/promises": emptyModule,
  "node:async_hooks": emptyModule,
  "node:worker_threads": emptyModule,
  "node:string_decoder": emptyModule,
  "node:assert": emptyModule,
  "node:readline": emptyModule,
  // Bare names that need explicit routing
  child_process: emptyModule,
  dns: emptyModule,
};

// Block heavy directories from Metro's file crawler
config.resolver.blockList = [
  /apps\/desktop\/.*/,
  /apps\/web\/.*/,
  /apps\/admin\/.*/,
  /apps\/docs\/.*/,
  /apps\/spatial\/.*/,
  /services\/.*/,
  /\.git\/.*/,
  /\.turbo\/.*/,
];

module.exports = config;
