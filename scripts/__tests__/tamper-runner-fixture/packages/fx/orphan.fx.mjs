// Binds the port the self-test hands it (FX_PORT), then leaves a process
// behind that holds that port for FX_HOLD ms: in the test's own process group,
// or (FX_DETACH=1) in a session of its own. Each holder's pid is appended to
// FX_STATE-orphans. The next run of this file fails to bind while one lives.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("binds the port, then leaves a holder behind", async () => {
  const port = Number(process.env.FX_PORT);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => server.close(r));
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${port}, "127.0.0.1");` +
        `setTimeout(() => process.exit(0), ${Number(process.env.FX_HOLD ?? 1500)});`,
    ],
    { detached: process.env.FX_DETACH === "1", stdio: "ignore" },
  );
  holder.unref();
  appendFileSync(`${process.env.FX_STATE}-orphans`, `${holder.pid}\n`);
  expect(sum(2, 3)).toBe(5);
});
