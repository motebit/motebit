// Checks fold.ts (a TypeScript module).
import { expect, it } from "vitest";

import { fold, plus } from "./fold.ts";

it("folds with a combiner", () => {
  expect(fold(plus, [1, 2, 3])).toBe(6);
});
