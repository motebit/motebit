// Reads a workspace package THROUGH the store's hoisted link
// (node_modules/.pnpm/node_modules/@fx/lib -> packages/lib), the shape of
// node_modules/.pnpm/node_modules/@motebit/* in the monorepo.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the hoisted store link reads this tree's workspace package", () => {
  const via = new URL("../../node_modules/.pnpm/node_modules/@fx/lib/value.txt", import.meta.url);
  expect(readFileSync(via, "utf8")).toBe("ok\n");
});
