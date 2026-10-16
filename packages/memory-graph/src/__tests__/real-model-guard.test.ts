import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as transformers from "@xenova/transformers";

// The shared vitest config aliases @xenova/transformers to
// vitest.real-model-guard.ts in every unit-test run (vitest.shared.ts →
// REAL_MODEL_GUARD_ALIAS), so no unit test can load or download the real
// embedding model. Under MOTEBIT_REAL_MODEL_TESTS=1 the alias is lifted.
const guard = transformers as unknown as {
  REAL_MODEL_GUARD_MESSAGE?: string;
  pipeline: () => Promise<never>;
};

describe.skipIf(process.env.MOTEBIT_REAL_MODEL_TESTS === "1")("real-model guard", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("@xenova/transformers resolves to the guard in unit tests", () => {
    expect(guard.REAL_MODEL_GUARD_MESSAGE).toMatch(/REAL embedding-model loader/);
  });

  it("reaching the loader rejects AND schedules an uncaught error, so a swallowing caller still fails the run", async () => {
    vi.useFakeTimers();
    await expect(guard.pipeline()).rejects.toThrow(/REAL embedding-model loader/);
    expect(vi.getTimerCount()).toBe(1);
    // Firing it is the loud part — vitest reports it as an unhandled error.
    expect(() => vi.runOnlyPendingTimers()).toThrow(/REAL embedding-model loader/);
  });
});

describe("real-model guard coverage", () => {
  // Every workspace package's vitest config must install the guard: either
  // through `defineMotebitTest` (which applies it) or by spreading
  // `REAL_MODEL_GUARD_ALIAS` into a bare config (apps/cli). A new bare config
  // without it would let that package's unit tests reach the real model again.
  it("every workspace vitest config installs it", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const configs: string[] = [];
    for (const ws of ["packages", "apps", "services"]) {
      for (const pkg of readdirSync(join(root, ws))) {
        for (const name of [
          "vitest.config.ts",
          "vitest.config.mts",
          "vitest.config.js",
          "vitest.config.mjs",
        ]) {
          const file = join(root, ws, pkg, name);
          if (existsSync(file)) configs.push(file);
        }
      }
    }
    expect(configs.length).toBeGreaterThan(50);
    const unguarded = configs.filter((file) => {
      const src = readFileSync(file, "utf8");
      return !/\bdefineMotebitTest\(/.test(src) && !/\bREAL_MODEL_GUARD_ALIAS\b/.test(src);
    });
    expect(
      unguarded.map((f) => f.slice(root.length)),
      "use defineMotebitTest (vitest.shared.ts) or add `resolve: { alias: REAL_MODEL_GUARD_ALIAS }`",
    ).toEqual([]);
  });
});
