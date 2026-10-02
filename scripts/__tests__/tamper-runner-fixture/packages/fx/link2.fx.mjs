// Reads a workspace package through a STORE ENTRY's link
// (node_modules/.pnpm/dep@1.0.0/node_modules/@fx/lib -> packages/lib): an
// entry symlinked to the caller's store would read the caller's package.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("a store entry's workspace link reads this tree's package", () => {
  const via = new URL(
    "../../node_modules/.pnpm/dep@1.0.0/node_modules/@fx/lib/value.txt",
    import.meta.url,
  );
  expect(readFileSync(via, "utf8")).toBe("ok\n");
});
