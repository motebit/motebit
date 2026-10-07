#!/usr/bin/env tsx
/**
 * `check-money-authority` — structural lock for the standing-authority
 * invariant: MEMORY NEVER CONFERS AUTHORITY.
 *
 * Doctrine: `docs/doctrine/memory-never-confers-authority.md`. Shape:
 * ordered source-marker scan, same family as `check-affordance-routing`.
 *
 * Assertions:
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
 *
 *   4. **The deterministic granted-spend path re-composes the R4 AND**
 *      (`executeGrantedDelegation`: fail-closed verify + scope + meter).
 *
 *   5. **No raw registry execute outside the gated paths — type-aware.**
 *      Every reference the TypeScript checker resolves to a tool registry's
 *      `execute` (or a registry class's private handler storage) is held to a
 *      closed set of sanctioned scopes with exact site counts; a built-in
 *      self-test plants every aliasing form and fails if one goes unseen.
 *      Aperture: all `.ts`/`.tsx` under packages/<pkg>/src, apps/<app>/src,
 *      services/<svc>/src in one program (tests excluded); see the assertion's
 *      own comment for what a type cannot show.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanProgram, scanFile, workspaceSourceFiles } from "./lib/registry-execute-refs.js";

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
// MCP said "requires approval" (M2). Every REFERENCE to a tool registry's
// `execute` (and to a registry class's private handler storage) in workspace
// source is therefore a CLOSED set, located by the TypeScript checker — not by
// spelling — so aliasing (`const e = r.execute`), destructuring, bracket
// access, `.call/.apply/.bind`, passing the method as a callback, casting
// through a registry type, computed access and private-member access all
// count (scripts/lib/registry-execute-refs.ts). Each site must be SANCTIONED
// by file + enclosing named scope with an exact site count; a new site, or a
// second site in a sanctioned scope, fails until it is routed through a gated
// path (`MotebitRuntime.executeToolGated`, `invokeLocalTool`, the AI loop) or
// argued into this list in review. A built-in self-test plants every aliasing
// form (virtual files, same program) and fails the gate if any goes unseen.
//
// Aperture: every `.ts`/`.tsx` under packages/*/src, apps/*/src,
// services/*/src (tests, `.test`/`.spec`/`.probe` files and `.d.ts`
// excluded), resolved in ONE program with workspace packages mapped to their
// src. Not seen: values typed so that no registry type is ever in the chain
// (e.g. a registry stored into a `Record<string, Function>` then called), and
// object-destructuring ASSIGNMENT (`({ execute } = r)`); `execute` on an `any`
// receiver is flagged precisely because its type is gone.
{
  interface Sanctioned {
    file: string;
    /** The reference's enclosing named scope chain, exactly (`RegistryRef.container`). */
    container: string;
    /** Exact number of references allowed in that scope. */
    sites: number;
    /** Each site's line must match (literal-tool sites). */
    line?: RegExp;
    /** Must appear in the scope's text before each site (the decision it executes under). */
    precededBy?: RegExp;
    why: string;
  }
  const SANCTIONED: Sanctioned[] = [
    {
      file: "packages/ai-core/src/loop.ts",
      container: "runTurnStreaming",
      sites: 2,
      precededBy: /policyGate/,
      why: "the AI loop — every tool call is decided by the policy gate (R4 step 8b/8c) first",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      container: "MotebitRuntime.invokeLocalTool",
      sites: 1,
      precededBy: /this\.policy\.validate\(/,
      why: "invokeLocalTool — after policy.validate; requiresApproval refuses",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      container: "MotebitRuntime.executeToolGated",
      sites: 2,
      precededBy:
        /verifyGrantForTurn\([\s\S]*this\.policy\.validate\([\s\S]*decision\.requiresApproval/,
      why: "executeToolGated — presenter-bound verifyGrantForTurn, policy.validate, requiresApproval refuses",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      container: "MotebitRuntime.toolsForTurn > execute",
      sites: 1,
      why: "the turn-scoped registry handed ONLY to the AI loop (whose every call the gate decides), forwarding the turn's call context",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      container: "MotebitRuntime.wrapToolRegistryForSensitivity > execute",
      sites: 1,
      why: "sensitivity wrapper around the loop's registry — adds a fail-closed outbound check, forwards otherwise",
    },
    {
      file: "packages/runtime/src/motebit-runtime.ts",
      container: "MotebitRuntime.registerExternalTools",
      sites: 1,
      line: /registerOwnerConnectedTool\(def, \(args\) => registry\.execute\(def\.name, args\)\)/,
      why: "re-registers an owner-connected tool INTO the runtime registry (reached only through a gated path)",
    },
    {
      file: "packages/runtime/src/streaming.ts",
      container: "StreamingManager.resumeAfterApproval",
      sites: 1,
      precededBy: /recordApprovalSatisfied/,
      why: "approval resume — executes exactly the paused, gate-decided call after a human approved it",
    },
    {
      file: "packages/runtime/src/attached-surface.ts",
      container: "resolveAttachedAct",
      sites: 1,
      precededBy: /runtime\.policy\.validate\(/,
      why: "attached-frontend tool_execute — after policy.validate; requiresApproval refuses",
    },
    {
      file: "packages/mcp-server/src/service.ts",
      container: "wireServerDeps > executeTool",
      sites: 1,
      why: "McpServerAdapter executeTool dep — reached only after handleToolCall's validateTool decision",
    },
    {
      file: "apps/cli/src/daemon.ts",
      container: "handleServe > executeTool",
      sites: 1,
      line: /executeTool: \(name, args\) => runtime\.getToolRegistry\(\)\.execute\(name, args\)/,
      why: "McpServerAdapter executeTool dep — reached only after handleToolCall's validateTool decision",
    },
    ...["read-url", "summarize", "web-search"].map((svc) => ({
      file: `services/${svc}/src/index.ts`,
      container: "main > handleAgentTask",
      sites: 1,
      line: /registry\.execute\("(?:read_url|summarize_search|web_search)",/,
      why: "a first-party service executing its own fixed read-class tool, named by literal",
    })),
  ];

  // Self-test: every aliasing form, planted as virtual files in the SAME
  // program the real scan uses. A form the analysis stops seeing fails here.
  const SELFTEST_DIR = resolve(ROOT, "packages/runtime/src/__money_authority_selftest__");
  const SELFTEST_HEADER =
    'import type { ToolRegistry } from "@motebit/protocol";\n' +
    'import { SimpleToolRegistry } from "../simple-tool-registry.js";\n' +
    "void SimpleToolRegistry;\n";
  const SELFTEST_FORMS: Record<string, string> = {
    direct: 'export const p = (r: ToolRegistry) => r.execute("t", {});\n',
    alias:
      'export function p(r: ToolRegistry) {\n  const e = r.execute;\n  return e("t", {});\n}\n',
    destructure:
      'export function p(r: ToolRegistry) {\n  const { execute } = r;\n  return execute("t", {});\n}\n',
    destructure_param:
      'export function p({ execute }: SimpleToolRegistry) {\n  return execute("t", {});\n}\n',
    bracket: 'export function p(r: ToolRegistry) {\n  return r["execute"]("t", {});\n}\n',
    computed: 'export function p(r: ToolRegistry, k: "execute") {\n  return r[k]("t", {});\n}\n',
    call: 'export function p(r: ToolRegistry) {\n  return r.execute.call(r, "t", {});\n}\n',
    apply: 'export function p(r: ToolRegistry) {\n  return r.execute.apply(r, ["t", {}]);\n}\n',
    bind_callback:
      'function run(f: (n: string, a: Record<string, unknown>) => unknown) {\n  return f("t", {});\n}\n' +
      "export function p(r: ToolRegistry) {\n  return run(r.execute.bind(r));\n}\n",
    callback:
      'function run(f: (n: string, a: Record<string, unknown>) => unknown) {\n  return f("t", {});\n}\n' +
      "export function p(r: ToolRegistry) {\n  return run(r.execute);\n}\n",
    cast:
      "export function p(r: unknown) {\n" +
      '  return (r as SimpleToolRegistry as unknown as { execute(n: string, a: object): unknown }).execute("t", {});\n}\n',
    any_receiver: 'export function p(r: any) {\n  return r.execute("t", {});\n}\n',
    handler_map:
      'export function p(r: SimpleToolRegistry) {\n  return r["tools"].get("t")?.handler({});\n}\n',
    concrete_class: 'export const p = (r: SimpleToolRegistry) => r.execute("t", {});\n',
  };
  const virtual = new Map<string, string>();
  for (const [form, body] of Object.entries(SELFTEST_FORMS)) {
    virtual.set(join(SELFTEST_DIR, `${form}.ts`), SELFTEST_HEADER + body);
  }

  const files = workspaceSourceFiles(ROOT);
  const program = createScanProgram(
    ROOT,
    files.map((f) => resolve(ROOT, f)),
    virtual,
  );

  const unseen: string[] = [];
  for (const [path] of virtual) {
    const sf = program.getSourceFile(path);
    const refs = sf == null ? [] : scanFile(program, sf, path);
    if (refs.filter((r) => !r.internal).length === 0) unseen.push(path.slice(ROOT.length + 1));
  }
  if (unseen.length > 0) {
    fail(
      "assertion 5 self-test: the type-aware registry-execute scan no longer sees these planted " +
        "aliasing forms:\n" +
        unseen.map((u) => `  - ${u}`).join("\n") +
        "\nA form the scan cannot see is a raw execute that bypasses the policy gate unseen. " +
        "Fix scripts/lib/registry-execute-refs.ts until every SELFTEST_FORMS entry is reported.",
    );
  }

  const violations: string[] = [];
  const perEntry = new Map<Sanctioned, number>();
  let refs = 0;
  let internal = 0;
  let unresolved = 0;
  for (const rel of files) {
    const sf = program.getSourceFile(resolve(ROOT, rel));
    if (sf == null) {
      unresolved++;
      violations.push(`${rel}  (not loaded into the program — cannot be proven clean)`);
      continue;
    }
    for (const r of scanFile(program, sf, rel)) {
      refs++;
      if (r.internal) {
        internal++;
        continue;
      }
      const entry = SANCTIONED.find(
        (e) =>
          e.file === r.file &&
          e.container === r.container &&
          (e.line == null || e.line.test(r.lineText)) &&
          (e.precededBy == null || e.precededBy.test(r.containerPrefix)),
      );
      if (entry == null) {
        violations.push(`${r.file}:${r.line}  [${r.kind} in ${r.container}]  ${r.lineText.trim()}`);
        continue;
      }
      perEntry.set(entry, (perEntry.get(entry) ?? 0) + 1);
    }
  }
  for (const e of SANCTIONED) {
    const n = perEntry.get(e) ?? 0;
    if (n !== e.sites) {
      violations.push(
        `${e.file} [${e.container}]: ${n} sanctioned site(s), expected exactly ${e.sites} — ` +
          (n > e.sites
            ? "a new raw execute was added inside a sanctioned scope"
            : "the sanctioned site moved or its gate marker no longer precedes it; update SANCTIONED"),
      );
    }
  }
  if (violations.length > 0) {
    fail(
      "tool-registry execute reference outside the gated paths:\n" +
        violations.map((v) => `  - ${v}`).join("\n") +
        "\nA raw registry execute skips the policy gate, so an R4_MONEY tool runs with no verified " +
        "grant (the serve --direct / motebit_task bypass) — whatever its spelling (alias, " +
        "destructure, bracket, .call/.apply/.bind, callback, cast, private handler map). Fix: " +
        "execute through `MotebitRuntime.executeToolGated(name, args, { caller, delegation })` " +
        "(policy.validate + presenter-bound verifyGrantForTurn + metering), or add the scope to " +
        "SANCTIONED in scripts/check-money-authority.ts with the gate it runs under. " +
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
  // The serve --direct handler must execute through the gated runtime path,
  // as a FOREIGN principal (the task submitter is never the owner).
  const direct = readFile("apps/cli/src/direct-task-handler.ts");
  if (
    direct === null ||
    !/deps\.runtime\.executeToolGated\(/.test(direct) ||
    !/caller: \{ principal: "foreign", identity: options\?\.caller \?\? null \}/.test(direct)
  ) {
    fail(
      "apps/cli/src/direct-task-handler.ts (serve --direct: motebit_task + relay dispatch) does not " +
        "execute through `runtime.executeToolGated` as a FOREIGN principal bound to the " +
        'transport-verified caller (`caller: { principal: "foreign", identity: options?.caller ?? null }`) — ' +
        "the R4 bypass the gate exists to prevent: a task submitter riding the owner's grant.",
    );
  }
  console.log(
    `check-money-authority: type-aware scan of ${files.length} source files (.ts/.tsx under ` +
      `packages/*/src, apps/*/src, services/*/src; tests excluded; ${unresolved} unloaded) — ` +
      `${refs} registry execute/private-member reference(s): ${internal} internal to a registry ` +
      `class, ${refs - internal} checked against ${SANCTIONED.length} sanctioned scopes; ` +
      `self-test ${Object.keys(SELFTEST_FORMS).length - unseen.length}/${Object.keys(SELFTEST_FORMS).length} aliasing forms seen.`,
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
