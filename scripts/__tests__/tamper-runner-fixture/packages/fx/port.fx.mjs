// Binds the FIXED port the self-test hands it (FX_PORT) for a while, as the
// relay's task-dispatch-token.test.ts binds 18951/18952: two copies of this
// file at once collide on EADDRINUSE.
import { createServer } from "node:net";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("holds the fixed port while it checks sum", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.FX_PORT), "127.0.0.1", resolve);
  });
  await new Promise((r) => setTimeout(r, 2500));
  await new Promise((r) => server.close(r));
  expect(sum(2, 3)).toBe(5);
}, 20_000);
