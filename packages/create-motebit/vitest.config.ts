import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests spawn child processes that run PBKDF2 (600k iterations).
    // Under turbo parallelism with other packages competing for CPU,
    // the default 5s timeout is insufficient.
    testTimeout: 30_000,
  },
});
