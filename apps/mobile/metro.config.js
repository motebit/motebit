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

// pnpm stores packages as symlinks into .pnpm store.
// Watchman ignores node_modules, so we can't return .pnpm real paths.
// Instead, verify the file exists via realpath but return the symlink path
// that lives OUTSIDE node_modules (in watchFolders scope).
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Shim Node.js built-ins (node: protocol and bare names)
  const nodeBuiltins = new Set([
    "child_process",
    "dns",
    "stream",
    "http",
    "https",
    "net",
    "tls",
    "fs",
    "os",
    "path",
    "crypto",
    "zlib",
    "util",
    "events",
    "buffer",
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
  if (moduleName.startsWith("node:") || nodeBuiltins.has(moduleName)) {
    return { type: "sourceFile", filePath: emptyModule };
  }

  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (defaultError) {
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
          // Check if the real file exists behind the symlink
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

// Shim Node.js built-ins that aren't available in React Native.
// MCP SDK's stdio transport imports these but mobile only uses HTTP transport.
const emptyModule = path.resolve(projectRoot, "shims/empty.js");
config.resolver.extraNodeModules = {
  "node:process": emptyModule,
  "node:child_process": emptyModule,
  "node:fs": emptyModule,
  "node:path": emptyModule,
  "node:os": emptyModule,
  "node:net": emptyModule,
  "node:tls": emptyModule,
  "node:http": emptyModule,
  "node:https": emptyModule,
  "node:stream": emptyModule,
  "node:util": emptyModule,
  "node:events": emptyModule,
  "node:buffer": emptyModule,
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
