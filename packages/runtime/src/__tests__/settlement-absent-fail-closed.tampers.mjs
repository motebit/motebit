#!/usr/bin/env node
// Tamper check for the absent-settlement_address refusal in relay-delegation.ts
// (docs/doctrine/settlement-authority-binding.md "Status").
//
// Each entry restores the old fail-open shape (an absent field skipped the
// registry comparison) at one of the two doors and names the test expected to
// go red. The shared runner (scripts/lib/tamper-runner.ts) applies each tamper
// in an isolated copy of the tree.
//
//   node packages/runtime/src/__tests__/settlement-absent-fail-closed.tampers.mjs [--concurrency=N]

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const src = join(pkg, "src", "relay-delegation.ts");

const TAMPERS = [
  {
    name: "pre-flight: absent settlement_address skips the registry check",
    test: join(here, "settlement-binding-every-candidate.test.ts"),
    from: `        if (typeof data.settlement_address !== "string") {
          return fail(
            "worker_settlement_unbound",
            \`The relay did not confirm a registered settlement address for "\${worker.motebit_id}"; refusing to pay an unconfirmed destination.\`,
          );
        }
        if (data.settlement_address !== worker.settlement_address) {`,
    to: `        if (
          typeof data.settlement_address === "string" &&
          data.settlement_address !== worker.settlement_address
        ) {`,
    red: "payer binds every candidate before broadcast an older relay that confirms no registered address ⇒ worker_settlement_unbound, nothing priced",
  },
  {
    name: "pre-broadcast re-check: absent settlement_address skips the registry check",
    test: join(here, "admission-before-broadcast.test.ts"),
    from: `      if (typeof data.settlement_address !== "string") {
        return refuse("the relay no longer confirms the worker's registered settlement address");
      }
      if (data.settlement_address !== resolved.workerAddress) {`,
    to: `      if (
        typeof data.settlement_address === "string" &&
        data.settlement_address !== resolved.workerAddress
      ) {`,
    red: "M3 — invariant: broadcasts == 0 whenever admission was not secured (b, narrowed) relay no longer confirms the local worker's registered address before broadcast ⇒ nothing broadcast",
  },
];

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name,
    pkg: "@motebit/runtime",
    test: relative(pkg, t.test),
    red: t.red,
    edits: [{ file: src, from: t.from, to: t.to }],
  })),
  { root: here },
);
