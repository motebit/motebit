/**
 * Tamper checks for `MotebitRuntime.getDelegationRelay()`
 * (packages/runtime/src/motebit-runtime.ts), which the CLI's `/connect`
 * reads to decide whether a session is already on a relay. Each entry breaks
 * one clause of its contract and must turn the getter's test red.
 *
 * Re-anchored for part 4a (design runtime-relay-binding rev 6): the getter
 * no longer reads task-query coordinates set by `enableInteractiveDelegation`
 * and cleared by `disableInteractiveDelegation` (both removed); it reports
 * the ONE binding (`bindRelay` / `unbindRelay`), with `pinned`. The three
 * mutations are kept, each on the code that now carries its clause:
 *
 *   - it always reports null;
 *   - a later bind does not move it (main's mutation flipped which enable
 *     won; under the binding the LAST bind must win, so the mutation keeps
 *     the FIRST);
 *   - it survives `unbindRelay` (main: survived `disableInteractiveDelegation`).
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
  "getDelegationRelay: the one relay binding null unbound; every bind reports its relay and pin; unbind clears it";

function entry(name: string, from: string, to: string): TamperEntry {
  return { name, edits: [{ file: SRC, from, to }], pkg: PKG, test: TEST, red: RED };
}

const TAMPERS: TamperEntry[] = [
  entry(
    "getDelegationRelay always reports null",
    "      : { url: binding.syncUrl, pinned: binding.relayPublicKey != null };\n",
    "      : null;\n",
  ),
  entry(
    "a later bind does not move the binding (the first bind wins)",
    "    this._relayBinding = Object.freeze({ ...binding, generation: this._relayGeneration });\n",
    "    this._relayBinding ??= Object.freeze({ ...binding, generation: this._relayGeneration });\n",
  ),
  entry(
    "the binding survives unbindRelay",
    "    if (this._relayBinding != null) {\n      this._relayBinding = null;\n",
    "    if (this._relayBinding != null) {\n",
  ),
];

void runTampers(TAMPERS, { root: ROOT });
