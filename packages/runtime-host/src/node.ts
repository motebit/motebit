// Node host entry — the only module in this package permitted to pull
// node:net / node:fs / node:os into a consumer's bundle.
export { nodePlatform } from "./node-platform.js";
export { defaultRuntimeHostPaths } from "./paths.js";
