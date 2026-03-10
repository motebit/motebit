// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo packages that this app depends on
config.watchFolders = [monorepoRoot];

// Resolve modules from both the app's node_modules and the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

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
