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

/**
 * A file that actually HANDLES a relay frame, not one that mentions the
 * word.
 *
 * The first version matched the bare string, so the aperture line
 * counted the crypto package's envelope signer and the runtime's own
 * barrel export as handlers and claimed to have checked them. A gate
 * that overstates what it looked at is the drift `hasApertureDisclosure`
 * exists to catch, in the gate that was just added to catch another one.
 */
const FRAME_MARKER = /[=!]==?\s*["']command_request["']|["']command_request["']\s*[=!]==?/;

/** The door. A different identifier, so it never matches DIRECT_CALL. */
const DIRECT_CALL = /\bexecuteCommand\s*\(/g;

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

/** Does THIS call pass an origin? Read its own argument list, nothing else. */
function callPassesOrigin(src: string, openParenSearchFrom: number): boolean {
  const start = src.indexOf("(", openParenSearchFrom);
  if (start === -1) return false;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return /origin:\s*"(local|remote)"/.test(src.slice(start, i + 1));
    }
  }
  return false;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

const violations: string[] = [];
let filesScanned = 0;
let callSites = 0;
const frameHandlers: string[] = [];

for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    filesScanned += 1;
    const src = readFileSync(file, "utf8");
    if (!FRAME_MARKER.test(src)) continue;
    const rel = relative(ROOT, file);
    // The APERTURE is every file that handles a frame, not only the ones
    // that could fail. A gate that counts its violations as its scope
    // reports "2 handlers, all clean" when there are six.
    frameHandlers.push(rel);
    // CALL-scoped, not file-scoped.
    //
    // File-scoped meant one door anywhere in a file exempted every other
    // call in it — and `apps/cli/src/daemon.ts` has TWO independent
    // frame handlers, so a third could have been added calling
    // `executeCommand` bare and stayed green forever. That is the
    // latency this gate exists to close, in the one file that already
    // has more than one handler.
    DIRECT_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DIRECT_CALL.exec(src)) != null) {
      callSites += 1;
      if (callPassesOrigin(src, m.index)) continue;
      violations.push(`${rel}:${lineOf(src, m.index)}`);
    }
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
    `${frameHandlers.length} file(s) handle a relay frame (${frameHandlers.join(", ")}); ` +
    `${callSites} \`executeCommand\` call(s) among them, each checked on its OWN argument list rather than on the file, and each either the door or naming its origin.\n`,
);
