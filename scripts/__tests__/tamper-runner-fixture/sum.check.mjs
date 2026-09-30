// The fixture's test: exits non-zero (RED) when sum() is wrong.
import { sum } from "./sum.mjs";

if (sum(2, 3) !== 5) {
  console.error(`sum(2, 3) = ${sum(2, 3)}`);
  process.exit(1);
}
