import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  dts: true,
  // Bundle all dependencies into the output — zero runtime deps
  noExternal: [/.*/],
});
