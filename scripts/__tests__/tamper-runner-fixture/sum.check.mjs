// A non-vitest check: prints its red marker and exits non-zero when sum() is wrong.
import { sum } from "./packages/fx/sum.mjs";

if (sum(2, 3) !== 5) {
  console.error(`SUM CHECK FAILED: sum(2, 3) = ${sum(2, 3)}`);
  process.exit(1);
}
