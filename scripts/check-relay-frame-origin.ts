/**
 * A command that arrived over the relay is executed through the door
 * that says so.
 *
 * `executeCommand`'s `origin` option has to default to `local`: that is
 * what almost every call site is — a person at a surface — and a halt
 * mislabelled `remote` writes an untruth into the durable record the
 * halt arc exists to keep honest. But the return view reads the same
 * `origin` to decide whether the credential membrane applies, and there
 * a default of `local` means "disclose". One parameter, two opposite
 * safe defaults, is a thing a reader gets wrong — and did: five surfaces
 * forwarded a relay `command_request` with no origin at all, so a
 * command that arrived over the wire answered as if it had been typed
 * on the machine. Latent for the return view only because none of those
 * surfaces wired a run ledger yet.
 *
 * So the wire gets a named door — `executeRemoteCommand` — and this gate
 * keeps it load-bearing. A file that handles a `command_request` frame
 * must not reach `executeCommand` directly; it calls the door, or it
 * passes `origin` explicitly and says why.
 *
 * Why a gate and not a review: nothing fails when a surface forgets.
 * The command runs, the answer is returned, the tests pass, and the
 * only thing wrong is that a membrane did not close — which no unit
 * test on that surface measures. Same class as
 * `check-affordance-routing`: a structural lock behind a hole closed
 * once, per docs/doctrine/composition-preserves-enforcement.md.
 *
 * Exit 1 on any violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();

/** Where a surface could plausibly handle a relay frame. */
const SCAN_ROOTS = ["apps", "services", "packages"];

/** The marker that says this file handles frames the relay forwards. */
const FRAME_MARKER = /command_request/;

/** The door, and the explicit-argument escape hatch beside it. */
const DOOR = /executeRemoteCommand\s*\(/;
const EXPLICIT_ORIGIN = /origin:\s*"(local|remote)"/;

const DIRECT_CALL = /\bexecuteCommand\s*\(/;

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    // `ios/Pods` carries broken symlinks that make `statSync` throw, and
    // the rest are build output with nothing to scan.
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === ".turbo" ||
      name === "ios" ||
      name === "android" ||
      name === "src-tauri"
    ) {
      continue;
    }
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(full)) continue;
    if (full.includes("__tests__") || /\.test\.tsx?$/.test(full)) continue;
    yield full;
  }
}

const violations: string[] = [];
let filesScanned = 0;
const frameHandlers: string[] = [];

for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    filesScanned += 1;
    const src = readFileSync(file, "utf8");
    if (!FRAME_MARKER.test(src)) continue;
    const rel = relative(ROOT, file);
    // The APERTURE is every file that handles a frame, not only the ones
    // that could fail. A gate that counts its violations as its scope
    // reports "2 handlers, all clean" when there are six — the aperture
    // drift this repo measures for.
    frameHandlers.push(rel);
    if (!DIRECT_CALL.test(src)) continue;
    // The door, or an explicit origin, anywhere in the file. Deliberately
    // file-scoped rather than call-scoped: a handler that names the
    // decision once has made it, and the alternative is parsing.
    if (DOOR.test(src) || EXPLICIT_ORIGIN.test(src)) continue;
    const line = src.split("\n").findIndex((l) => DIRECT_CALL.test(l)) + 1;
    violations.push(`${rel}:${line}`);
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant:
      "a file that handles a relay `command_request` calls `executeCommand` without saying where the command came from",
    canonical: "packages/runtime/src/commands/index.ts — `executeRemoteCommand`",
    fix: 'Call `executeRemoteCommand(runtime, command, args)` for a frame that arrived over the relay. It records `origin: "remote"` in the durable record and closes the return view\'s credential membrane — neither of which a caller should have to remember.',
    sites: violations,
    doctrine: "docs/doctrine/composition-preserves-enforcement.md",
  });
}

process.stdout.write(
  `✓ check-relay-frame-origin: ${filesScanned} source file(s) scanned across ${SCAN_ROOTS.length} tree(s); ` +
    `${frameHandlers.length} relay-frame handler(s) found (${frameHandlers.join(", ")}), each executing through the door that records the origin.\n`,
);
