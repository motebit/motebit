#!/usr/bin/env tsx
/**
 * `check-money-authority` — structural lock for the standing-authority
 * invariant: MEMORY NEVER CONFERS AUTHORITY.
 *
 * Doctrine: `docs/doctrine/memory-never-confers-authority.md`. Shape:
 * ordered source-marker scan, same family as `check-affordance-routing`.
 *
 * Three assertions:
 *
 *   1. **The gate step exists and is ordered.** `policy-gate.ts`
 *      contains the R4 standing-authority block (`profile.risk >=
 *      RiskLevel.R4_MONEY` + `ctx.verifiedGrant == null` →
 *      `needsApproval = true`) AFTER the caller-trust-level switch —
 *      ordering is load-bearing: the invariant must subordinate the
 *      Trusted bypass, so it must run after every approval-lowering
 *      adjustment. A refactor that moves the trust switch below the
 *      grant check silently re-opens "Trusted caller auto-executes
 *      money."
 *
 *   2. **`delegate_to_agent` declares its risk explicitly.** The
 *      registration in `interactive-delegation.ts` carries a
 *      `riskHint` — without one, the name/description patterns
 *      classify the money-capable delegation tool R0_READ (the exact
 *      hole the 2026-06-10 audit found) and it auto-executes as
 *      read-class.
 *
 *   3. **One producer.** No file outside the audited producer
 *      (`packages/runtime/src/grant-verifier.ts`) and test fixtures may
 *      CONSTRUCT a `verifiedGrant` object value. Pass-through
 *      threading (`verifiedGrant: options?.verifiedGrant` and the
 *      `ctx` spread) is permitted; minting the object literal anywhere
 *      else is an unverified authority claim.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolve(ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
    const rel = join(dir, entry);
    const full = resolve(ROOT, rel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink (e.g. mobile iOS Pods) — skip
    }
    if (st.isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

/** Every `<root>/<pkg>/src` tree under the workspace roots. */
function workspaceSrcDirs(): string[] {
  const dirs: string[] = [];
  for (const root of ["packages", "apps", "services"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const srcRel = join(root, entry, "src");
      try {
        if (statSync(resolve(ROOT, srcRel)).isDirectory()) dirs.push(srcRel);
      } catch {
        continue;
      }
    }
  }
  return dirs;
}

let failed = false;
function fail(message: string): void {
  console.error(`check-money-authority: ${message}`);
  failed = true;
}

// === 1. Gate step present + ordered after the trust-level switch =====
{
  const source = readFile("packages/policy/src/policy-gate.ts");
  if (source === null) {
    fail("could not read packages/policy/src/policy-gate.ts");
  } else {
    const trustSwitchIdx = source.indexOf("ctx.callerTrustLevel");
    // Match the WHOLE statement — the bare condition, opened directly by
    // `if (` and closed by a body that re-raises approval. A substring match
    // on the condition alone stayed green when the branch was neutralized
    // (`if (false && profile.risk …)`) or its body emptied; the guard must
    // bite on exactly those edits.
    const grantCheckIdx = source.search(
      /if \(\s*profile\.risk >= RiskLevel\.R4_MONEY && !needsApproval && ctx\.verifiedGrant == null\s*\)\s*\{\s*needsApproval = true;\s*\}/,
    );
    if (grantCheckIdx === -1) {
      fail(
        "policy-gate.ts is missing the R4 standing-authority block " +
          "(`if (profile.risk >= RiskLevel.R4_MONEY && !needsApproval && ctx.verifiedGrant == null) { needsApproval = true; }`), " +
          "or the block is present but neutralized (a prefixed constant, an extra conjunct, an emptied body). " +
          "An R4_MONEY tool call must never auto-execute without a verified grant — " +
          "docs/doctrine/memory-never-confers-authority.md.",
      );
    } else if (trustSwitchIdx === -1) {
      fail(
        "policy-gate.ts no longer references ctx.callerTrustLevel — the ordering assertion " +
          "(grant check AFTER the trust switch) can't be validated; update this gate alongside the refactor.",
      );
    } else if (grantCheckIdx < trustSwitchIdx) {
      fail(
        "the R4 standing-authority block runs BEFORE the caller-trust-level switch. " +
          "Ordering is load-bearing: the invariant must subordinate the Trusted bypass, " +
          "so it must run after every approval-lowering adjustment.",
      );
    }
  }
}

// === 2. delegate_to_agent declares an explicit riskHint ==============
{
  const source = readFile("packages/runtime/src/interactive-delegation.ts");
  if (source === null) {
    fail("could not read packages/runtime/src/interactive-delegation.ts");
  } else {
    const regIdx = source.indexOf("name: TOOL_NAME");
    const hintIdx = source.indexOf("riskHint:");
    if (regIdx === -1 || hintIdx === -1) {
      fail(
        "the delegate_to_agent registration in interactive-delegation.ts carries no explicit " +
          "`riskHint`. Without one, the risk-model patterns classify the money-capable " +
          "delegation tool R0_READ and it auto-executes as read-class.",
      );
    } else if (!/RiskLevel\.R4_MONEY/.test(source)) {
      fail(
        "interactive-delegation.ts's riskHint never references RiskLevel.R4_MONEY — a paid " +
          "delegation (payment rail configured) settles real money and must classify R4.",
      );
    }
  }
}

// === 3. One producer — no constructed verifiedGrant elsewhere ========
{
  const PRODUCER = "packages/runtime/src/grant-verifier.ts";
  const violations: string[] = [];
  for (const srcDir of workspaceSrcDirs()) {
    for (const rel of walkTsFiles(srcDir)) {
      if (rel === PRODUCER) continue;
      if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue;
      const content = readFile(rel);
      if (content === null) continue;
      // A CONSTRUCTED grant value, in either producer form:
      //   - property form:   `verifiedGrant: {` (object literal)
      //   - assignment form: `x.verifiedGrant = {`, `verifiedGrant = {`,
      //     `x["verifiedGrant"] = {` (optionally parenthesised / cast)
      // Scanned over the whole file so a line break between the key and the
      // literal does not hide it. Pass-through threading
      // (`verifiedGrant: options?.verifiedGrant`, `x.verifiedGrant = y`)
      // is permitted — it moves a producer-minted value, it mints nothing.
      const constructed = /verifiedGrant\s*:\s*\{|verifiedGrant["'`]?\]?\s*=(?!=)\s*(?:\(\s*)*\{/g;
      for (const m of content.matchAll(constructed)) {
        const line = content.slice(0, m.index).split("\n").length;
        violations.push(`${rel}:${line}`);
      }
    }
  }
  if (violations.length > 0) {
    fail(
      "verifiedGrant object constructed outside the audited producer " +
        `(${PRODUCER}):\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        "\nOnly verifyGrantForTurn may mint the value — a constructed grant is an " +
        "unverified authority claim. Fix: obtain the value from verifyGrantForTurn " +
        "(packages/runtime/src/grant-verifier.ts) and thread it through, or present the signed " +
        "artifacts via the turn's `delegation` option — never construct or assign a grant " +
        "literal. docs/doctrine/memory-never-confers-authority.md.",
    );
  }
}

// === 4. The deterministic granted-spend path re-composes the R4 AND =====
// `MotebitRuntime.executeGrantedDelegation` is the human-absent money path
// (the Clerk archetype). It inherits ONLY the rail-seam meter — which
// fail-OPENS on a null grant (money-meter.ts) — so it MUST re-add the layers
// the AI loop composes: fail-CLOSED grant verification, a scope check, and a
// meter-wrapped builder (never the raw wallet method). This assertion locks
// all three so a refactor cannot quietly turn the sharpest money path into a
// bypass. Doctrine: docs/doctrine/agent-archetypes.md §6.
{
  const source = readFile("packages/runtime/src/motebit-runtime.ts");
  if (source === null) {
    fail("could not read packages/runtime/src/motebit-runtime.ts");
  } else {
    const startIdx = source.indexOf("async executeGrantedDelegation(");
    if (startIdx === -1) {
      fail(
        "motebit-runtime.ts no longer defines `executeGrantedDelegation` — the deterministic " +
          "granted-spend path. If it was renamed, update this gate to match; if removed, remove " +
          "the Clerk archetype's spend seam too. docs/doctrine/agent-archetypes.md §6.",
      );
    } else {
      // Bound the scan to the method body — the next 2-space-indented method
      // boundary after the signature (arrow callbacks inside are deeper-indented,
      // so `\n  name(` matches only a sibling method). Robust to reordering: a
      // fixed-anchor slice could run to EOF and wrongly count another method's
      // raw wallet reference.
      const afterSig = startIdx + "async executeGrantedDelegation(".length;
      const rel = source.slice(afterSig).search(/\n {2}[A-Za-z_$][\w$]*\(/);
      const body =
        rel === -1
          ? source.slice(startIdx, startIdx + 12000)
          : source.slice(startIdx, afterSig + rel);
      const requirements: Array<{ re: RegExp; miss: string }> = [
        {
          re: /const presentedGrant = await verifyGrantForTurn\(/,
          miss: "must verify the grant via the sole producer verifyGrantForTurn",
        },
        {
          re: /if \(presentedGrant == null\) return \{ ok: false, code: "requires_verified_grant" \}/,
          miss: 'must FAIL CLOSED on a null grant (`return { ok: false, code: "requires_verified_grant" }`) — the meter fail-opens on null, so this path cannot',
        },
        {
          re: /this\.policy\.validate\(/,
          miss: "must re-run the policy gate's scope check via this.policy.validate (the meter never checks scope)",
        },
        {
          re: /return \{ ok: false, code: "missing_scope" \}/,
          miss: 'must refuse an out-of-scope grant (`return { ok: false, code: "missing_scope" }`)',
        },
        {
          re: /const buildP2pPayment = wrapP2pPaymentWithMeter\(/,
          miss: "must route the live broadcast through a meter-wrapped builder (wrapP2pPaymentWithMeter), never the raw wallet method",
        },
      ];
      for (const { re, miss } of requirements) {
        if (!re.test(body)) {
          fail(
            `executeGrantedDelegation ${miss}. This is the human-absent R4 path; dropping any ` +
              "layer of the gate ∧ presence ∧ meter AND is a money-safety regression. " +
              "docs/doctrine/agent-archetypes.md §6, docs/doctrine/memory-never-confers-authority.md.",
          );
        }
      }
      // The raw wallet method may appear ONLY as the first argument of the
      // meter wrapper (bound into rawBuild). Any other pass-through of
      // `_solanaWallet.buildP2pPayment` in this method would bypass metering.
      const rawRefs = (body.match(/_solanaWallet\??\.buildP2pPayment/g) ?? []).length;
      if (rawRefs > 1) {
        fail(
          "executeGrantedDelegation references the raw `_solanaWallet.buildP2pPayment` more than " +
            "once — the only sanctioned use is binding it INTO wrapP2pPaymentWithMeter. A second " +
            "reference risks a metering bypass. check-ceiling-from-grant is the sibling guard.",
        );
      }
    }
  }
}

// === 5. No raw registry execute outside the gated paths ================
// The deterministic worker path (`motebit serve --direct`, which answers both
// the MCP `motebit_task` tool and the relay WebSocket dispatch) executed tools
// straight from the registry: an R4_MONEY tool reached through a task moved
// money with no policy decision and no grant, while the same tool called over
// MCP said "requires approval" (M2). Every registry `execute(` call site in
// workspace source is therefore a CLOSED set: each must be a sanctioned site —
// either preceded (in the same function window) by the policy decision it
// executes under, or an adapter whose gate lives in its only caller, or a
// fixed read-class tool named by literal. A new call site is a gate failure
// until it is routed through a gated path (`MotebitRuntime.executeToolGated`,
// `invokeLocalTool`, the AI loop) or argued into this list in review.
{
  const EXECUTE_CALL = /(?:getToolRegistry\(\)|\b[\w$]*[Rr]egistry|\btools)\??\.execute\(/g;
  const WINDOW_LINES = 80;
  interface Sanctioned {
    file: string;
    /** The call line itself must match (adapter / literal sites). */
    line?: RegExp;
    /** A policy decision must appear within WINDOW_LINES before the call. */
    precededBy?: RegExp;
    why: string;
  }
  const SANCTIONED: Sanctioned[] = [
    {
      file: "packages/ai-core/src/loop.ts",
      precededBy: /policyGate/,
      why: "the AI loop — every tool call is decided by the policy gate (R4 step 8b/8c) first",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      precededBy: /this\.policy\.validate\(/,
      why: "invokeLocalTool / executeToolGated — after policy.validate; requiresApproval refuses",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      line: /registerOwnerConnectedTool\(def, \(args\) => registry\.execute\(def\.name, args\)\)/,
      why: "re-registers an owner-connected tool INTO the runtime registry (reached only through a gated path)",
    },
    {
      file: "packages/runtime/src/attached-surface.ts",
      precededBy: /runtime\.policy\.validate\(/,
      why: "attached-frontend tool_execute — after policy.validate; requiresApproval refuses",
    },
    {
      file: "packages/mcp-server/src/service.ts",
      precededBy: /executeTool: async \(name, args\) =>/,
      why: "McpServerAdapter executeTool dep — reached only after handleToolCall's validateTool decision",
    },
    {
      file: "apps/cli/src/daemon.ts",
      line: /executeTool: \(name, args\) => runtime\.getToolRegistry\(\)\.execute\(name, args\)/,
      why: "McpServerAdapter executeTool dep — reached only after handleToolCall's validateTool decision",
    },
    ...["read-url", "summarize", "web-search"].map((svc) => ({
      file: `services/${svc}/src/index.ts`,
      line: /registry\.execute\("(?:read_url|summarize_search|web_search)",/,
      why: "a first-party service executing its own fixed read-class tool, named by literal",
    })),
  ];

  const unsanctioned: string[] = [];
  let scanned = 0;
  let sites = 0;
  for (const srcDir of workspaceSrcDirs()) {
    for (const rel of walkTsFiles(srcDir)) {
      if (rel.includes("__tests__") || /\.(test|probe)\.ts$/.test(rel)) continue;
      const content = readFile(rel);
      if (content === null) continue;
      scanned++;
      const lines = content.split("\n");
      for (const m of content.matchAll(EXECUTE_CALL)) {
        sites++;
        const lineNo = content.slice(0, m.index).split("\n").length;
        const lineText = lines[lineNo - 1] ?? "";
        const window = lines.slice(Math.max(0, lineNo - 1 - WINDOW_LINES), lineNo).join("\n");
        const ok = SANCTIONED.some(
          (s) =>
            s.file === rel &&
            (s.line == null || s.line.test(lineText)) &&
            (s.precededBy == null || s.precededBy.test(window)),
        );
        if (!ok) unsanctioned.push(`${rel}:${lineNo}  ${lineText.trim()}`);
      }
    }
  }
  if (unsanctioned.length > 0) {
    fail(
      "tool-registry execute outside the gated paths:\n" +
        unsanctioned.map((v) => `  - ${v}`).join("\n") +
        "\nA raw registry execute skips the policy gate, so an R4_MONEY tool runs with no verified " +
        "grant (the serve --direct / motebit_task bypass). Fix: execute through " +
        "`MotebitRuntime.executeToolGated(name, args, { delegation })` (policy.validate + " +
        "verifyGrantForTurn + metering), or add the site to SANCTIONED in " +
        "scripts/check-money-authority.ts with the gate it runs under. " +
        "docs/doctrine/memory-never-confers-authority.md.",
    );
  }

  // The MCP adapter's executeTool sites above are sanctioned only because the
  // adapter decides first: validateTool → refuse on requiresApproval → execute.
  const adapter = readFile("packages/mcp-server/src/index.ts");
  if (
    adapter === null ||
    !/const decision = await this\.deps\.validateTool\([\s\S]{0,1500}if \(decision\.requiresApproval\) \{[\s\S]{0,800}const result = await this\.deps\.executeTool\(/.test(
      adapter,
    )
  ) {
    fail(
      "McpServerAdapter.handleToolCall no longer decides before it executes " +
        "(validateTool → requiresApproval refusal → executeTool). The executeTool adapters " +
        "sanctioned in assertion 5 depend on that order — restore it or remove them from SANCTIONED.",
    );
  }
  // The serve --direct handler must execute through the gated runtime path.
  const direct = readFile("apps/cli/src/direct-task-handler.ts");
  if (direct === null || !/deps\.runtime\.executeToolGated\(/.test(direct)) {
    fail(
      "apps/cli/src/direct-task-handler.ts (serve --direct: motebit_task + relay dispatch) does not " +
        "execute through `runtime.executeToolGated` — the R4 bypass the gate exists to prevent.",
    );
  }
  console.log(
    `check-money-authority: scanned ${scanned} source files under packages/*/src, apps/*/src, ` +
      `services/*/src (tests excluded) for registry execute calls — ${sites} site(s), all sanctioned ` +
      `unless listed above.`,
  );
}

if (failed) {
  process.exit(1);
}
console.log(
  "✓ check-money-authority: R4 standing-authority block present + ordered after the trust switch; " +
    "delegate_to_agent declares explicit riskHint (R4 on payment rail); verifiedGrant has a single " +
    "audited producer; executeGrantedDelegation re-composes the R4 AND (fail-closed verify + scope + meter-wrapped builder); " +
    "every tool-registry execute is a sanctioned gated site.",
);
