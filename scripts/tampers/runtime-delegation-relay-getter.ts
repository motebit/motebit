/**
 * Tamper checks for `MotebitRuntime.getDelegationRelay()`
 * (packages/runtime/src/motebit-runtime.ts): the relay of the runtime's
 * task-query coordinates, which the CLI's `/connect` reads to decide whether
 * a session is already on a relay. Each entry breaks one clause of its
 * contract and must turn the getter's test red:
 *
 *   - it always reports null;
 *   - it reports the latest `enableInteractiveDelegation` instead of the
 *     first (the coordinates are overwritten instead of set while empty);
 *   - it survives `disableInteractiveDelegation`.
 *
 *   node_modules/.bin/tsx scripts/tampers/runtime-delegation-relay-getter.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "packages/runtime/src/motebit-runtime.ts";
const PKG = "@motebit/runtime";
const TEST = "src/__tests__/delegation-relay-getter.test.ts";
const RED =
  "getDelegationRelay: the relay of the task-query coordinates null before any enable; the first enable wins; a disable clears it; a first-ever enable-invoke sets it and a later one does not";

function entry(name: string, from: string, to: string): TamperEntry {
  return { name, edits: [{ file: SRC, from, to }], pkg: PKG, test: TEST, red: RED };
}

const TAMPERS: TamperEntry[] = [
  entry(
    "getDelegationRelay always reports null",
    "    return coords === null ? null : { url: coords.syncUrl };\n",
    "    return coords === null ? null : null;\n",
  ),
  // The same `??=` line occurs in `enableInvokeCapability`; the preceding
  // line anchors this edit to `enableInteractiveDelegation`.
  entry(
    "the coordinates follow the latest enableInteractiveDelegation, not the first",
    "      retrieveTaskResult: (taskId) => this.retrieveDelegationResult(taskId),\n    });\n" +
      "    this._taskQueryCoords ??= { syncUrl: config.syncUrl, authToken: config.authToken };\n",
    "      retrieveTaskResult: (taskId) => this.retrieveDelegationResult(taskId),\n    });\n" +
      "    this._taskQueryCoords = { syncUrl: config.syncUrl, authToken: config.authToken };\n",
  ),
  entry(
    "the coordinates survive disableInteractiveDelegation",
    "    this.interactiveDelegation.disable();\n    this._taskQueryCoords = null;\n",
    "    this.interactiveDelegation.disable();\n",
  ),
];

void runTampers(TAMPERS, { root: ROOT });
