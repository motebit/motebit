import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  // DTS generated separately via tsc (tsup DTS doesn't handle multi-file well)
  dts: false,
  // Bundle all dependencies into the output — zero runtime deps
  noExternal: [/.*/],
});
