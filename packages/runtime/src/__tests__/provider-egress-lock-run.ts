/**
 * Child-process entry for the provider egress lock: prints
 * `scanProviderSites(<root>)` as JSON. `egress-canary.test.ts` spawns it so
 * the TypeScript scan runs outside the coverage-instrumented test worker.
 */
import { scanProviderSites } from "./provider-egress-lock";

const root = process.argv[2];
if (root == null) throw new Error("usage: provider-egress-lock-run.ts <root>");
process.stdout.write(JSON.stringify(scanProviderSites(root)));
