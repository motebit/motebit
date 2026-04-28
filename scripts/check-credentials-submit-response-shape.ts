/**
 * `/credentials/submit` response-shape gate.
 *
 * The relay's `POST /api/v1/agents/:id/credentials/submit` returns
 * **HTTP 200 even when it rejects every credential in the batch**. Per
 * spec/credential-v1.md §23, self-issued credentials and signature-failed
 * credentials are filtered server-side; the response body carries the
 * outcome:
 *
 *   { accepted: <number>, rejected: <number>, errors: [string, ...] }
 *
 * A submitter that checks only `response.ok` (HTTP 2xx) and treats it as
 * success will report "submitted" while the relay's index never accepted
 * the credential. This is the bug commit `63fa2199` reverted on
 * 2026-04-25 ("revert(hardware-attestation): unwind broken
 * publish-at-bootstrap flow on all three surfaces") — surface tests
 * mocked `fetch` to return `{ok: true, status: 200}` and never exercised
 * the relay's actual reject path; the publish helper checked only
 * `response.ok` and reported `kind: "submitted"` while the relay returned
 * `{accepted: 0, rejected: 1, errors: ["self-issued credential rejected"]}`.
 *
 * Memory `lesson_hardware_attestation_self_issued_dead_drop` named the
 * mechanical detector at the time: "response.ok check on
 * /credentials/submit without inspecting accepted/rejected body counts."
 * This gate is that detector, codified.
 *
 * ## What this gate enforces
 *
 * Any TypeScript file under `packages/**`, `apps/**`, `services/**` (excluding
 * tests, dist, generated) that calls `fetch(...)` with a URL containing
 * `/credentials/submit` MUST also reference `accepted` AND `rejected` as
 * identifier accesses somewhere in the same file — evidence the submitter
 * is reading the response body, not just the HTTP status.
 *
 * Exempt:
 *   - `services/relay/src/credentials.ts` — the *server* side that emits the
 *     `{accepted, rejected}` shape. It produces, doesn't consume.
 *   - Test files — they construct mocks.
 *
 * Detection is intentionally minimal (substring presence) rather than
 * AST-walked. Any submitter that legitimately reads `accepted`/`rejected`
 * either as object fields or destructured locals will trip the substring
 * match. False positives are fine — if the file mentions both tokens for
 * any reason, the gate is satisfied; the cost of a false negative
 * (missing the body-inspection on a real submitter) is much higher.
 *
 * Companion: `services/relay/src/credentials.ts:428` enforces the
 * server-side `self-issued credential rejected` filter; this gate
 * defends the *client-side response handling* that pairs with it.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_ROOTS = ["packages", "apps", "services"];
const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  ".turbo",
  "build",
  "generated",
]);
const SKIP_FILE_SUFFIXES = [".d.ts", ".d.ts.map", ".js.map", ".generated.ts"];

/** The relay's own server-side route handler emits the {accepted, rejected}
 *  shape; it doesn't consume it. Exempting it keeps the gate's signal sharp. */
const SERVER_SIDE_FILE = "services/relay/src/credentials.ts";

/** The submit endpoint substring. Matches both literal URL strings and
 *  template literals carrying the path. */
const SUBMIT_URL_TOKEN = "/credentials/submit";

/** Detects a real `fetch(...)` call against `/credentials/submit` — not
 *  just a comment that mentions the URL elsewhere in the file. The URL
 *  may sit on a continuation line, so we look up to ~500 chars past
 *  each `fetch(` for the path. */
const FETCH_OPEN_RE = /\bfetch\s*\(/g;
const FETCH_LOOKAHEAD = 500;

/** Body-field tokens. Either `body.accepted` / `body.rejected`, or a
 *  destructured `const { accepted, rejected } = ...`, or any reference
 *  whatsoever counts. The gate is happy as long as the submitter mentions
 *  both names — that is the cheapest signal that a body inspection
 *  exists. */
const ACCEPTED_TOKEN_RE = /\baccepted\b/;
const REJECTED_TOKEN_RE = /\brejected\b/;

interface Violation {
  file: string;
  reason: string;
}

function walk(dir: string, out: string[]): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (SKIP_FILE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
    out.push(full);
  }
}

/** True if the source has a real `fetch(...)` call whose argument list
 *  includes `/credentials/submit` within ~500 chars. Walks every fetch
 *  opening and looks ahead so multi-line fetch(arg1,\n  arg2,\n  ...) is
 *  caught even when the URL sits on a continuation line. */
function hasRealSubmitFetch(src: string): boolean {
  FETCH_OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FETCH_OPEN_RE.exec(src)) !== null) {
    const start = match.index + match[0].length;
    const window = src.slice(start, start + FETCH_LOOKAHEAD);
    if (window.includes(SUBMIT_URL_TOKEN)) return true;
  }
  return false;
}

function checkFile(file: string): Violation | null {
  const rel = relative(ROOT, file);
  if (rel === SERVER_SIDE_FILE) return null;

  const src = readFileSync(file, "utf-8");
  if (!hasRealSubmitFetch(src)) return null;

  const hasAccepted = ACCEPTED_TOKEN_RE.test(src);
  const hasRejected = REJECTED_TOKEN_RE.test(src);
  if (hasAccepted && hasRejected) return null;

  const missing: string[] = [];
  if (!hasAccepted) missing.push("`accepted`");
  if (!hasRejected) missing.push("`rejected`");

  return {
    file: rel,
    reason:
      `file calls fetch() against \`/credentials/submit\` but never references ${missing.join(" + ")} ` +
      `— the relay returns HTTP 200 with \`{accepted, rejected, errors}\` even when it filters every ` +
      `credential server-side (spec/credential-v1.md §23). Inspect the body counts, don't just check resp.ok.`,
  };
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = resolve(ROOT, root);
    if (existsSync(abs)) walk(abs, files);
  }

  const violations: Violation[] = [];
  for (const f of files) {
    const v = checkFile(f);
    if (v) violations.push(v);
  }

  if (violations.length > 0) {
    process.stderr.write(
      `\nerror: ${violations.length} \`/credentials/submit\` submitter(s) check only HTTP status, not the ` +
        `\`{accepted, rejected, errors}\` response body shape:\n\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ✗ ${v.reason}\n\n`);
    }
    process.stderr.write(
      "Background: the relay returns HTTP 200 even when it rejects every credential in a batch — ` ` \n" +
        "self-issued credentials, signature-failed credentials, and unknown subjects are filtered server-side.\n" +
        "A submitter that checks only `response.ok` reports success while the relay's index never accepted\n" +
        "the credential. This is the same shape of bug as the 2026-04-25 hardware-attestation revert\n" +
        "(commit 63fa2199); see `lesson_hardware_attestation_self_issued_dead_drop` for the original.\n",
    );
    process.exit(1);
  }

  const submitters = files.filter((f) => {
    const rel = relative(ROOT, f);
    if (rel === SERVER_SIDE_FILE) return false;
    const src = readFileSync(f, "utf-8");
    return hasRealSubmitFetch(src);
  }).length;
  process.stderr.write(
    `  ✓ ${submitters} \`/credentials/submit\` submitter(s) inspect the \`{accepted, rejected}\` body counts\n`,
  );
}

main();
