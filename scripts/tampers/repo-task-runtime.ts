/**
 * Tamper checks for milestone B build step 2 — the runtime pieces of a
 * governed repo change (docs/proposals/governed-repo-change-v1.md, "Build
 * order" step 2):
 *
 *   - honest tool-receipt status on every path of the general runtime
 *     (ai-core loop `outcome`, the streaming signer, the approval resume /
 *     refusal / timeout paths, `invokeLocalTool`) and the durable,
 *     fail-closed receipt sink;
 *   - the repo-task run: authority before start and on every call, the
 *     frozen two-tool registry with its handler-identity assertion, the
 *     scope-built handlers' refusals, no interior, one system prompt;
 *   - the Node adapters (git tree reader, git change stager, receipt file).
 *
 * Each entry removes ONE guard (or every redundant layer of one guard, so
 * the condition is actually let through) and names the test that must go
 * red. Where two layers enforce one rule — the explicit window check and
 * `verifyDelegationTokenVerdict`'s own authority, for instance — the entry
 * removes both: removing one alone is GREEN by design (defense in depth),
 * and a tamper that cannot let the condition through proves nothing.
 *
 *   npx tsx scripts/tampers/repo-task-runtime.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const AUTH = "packages/runtime/src/repo-task/authority.ts";
const RULES = "packages/verifier/src/repo-change-rules.ts";
const RUN = "packages/runtime/src/repo-task/run.ts";
const TOOLS = "packages/runtime/src/repo-task/tools.ts";
const PROMPT = "packages/runtime/src/repo-task/system-prompt.ts";
const STREAM = "packages/runtime/src/streaming.ts";
const RT = "packages/runtime/src/motebit-runtime.ts";
const LOOP = "packages/ai-core/src/loop.ts";
const CORE = "packages/ai-core/src/core.ts";
const STAGER = "apps/cli/src/repo-task/git-change-stager.ts";
const GITSESSION = "apps/cli/src/repo-task/git.ts";
const READER = "apps/cli/src/repo-task/git-tree-reader.ts";
const SINK = "apps/cli/src/repo-task/receipt-file-sink.ts";
const WEB_PULSE = "apps/web/src/ui/cobrowse-chrome.ts";

const RUN_TEST = "src/__tests__/repo-task-run.test.ts";
const AGREE_TEST = "src/__tests__/repo-task-authority-agreement.test.ts";
const IDENTITY_TEST = "src/__tests__/repo-task-tool-identity.test.ts";
const INTERIOR_TEST = "src/__tests__/repo-task-no-interior.test.ts";
const STATUS_TEST = "src/__tests__/tool-receipt-status.test.ts";
const OUTCOME_TEST = "src/__tests__/tool-outcome.test.ts";
const ADAPTER_TEST = "src/repo-task/__tests__/node-adapters.test.ts";

const PRE = "repo task: the run cannot start without a valid tick";
const AGREE = "repo task: the run and the verifier judge authority by one law";
const WRITE_AUTH = "repo task: the run cannot write without a valid tick";
const STATUS = "repo task: every call's real status, durably recorded";
const WRITE = "repo task: repo_write_path is closed over the allowed paths";
const READ = "repo task: repo_read_blob reads only tracked blobs at the tip";
const OFFER = "repo task: no other tool is offered on any model call";
const INTERIOR = "repo task: no interior";
const LOOPST = "tool receipts carry the call's real status (AI loop)";
const RESUME = "tool receipts on the approval resume path";
const REFUSAL = "tool receipts on the approval refusal paths";
const LOCAL = "tool receipts on invokeLocalTool";
const GATED = "tool outcome on every done chunk (policy-gate path)";
const UNGATED = "tool outcome on every done chunk (no policy gate)";

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });

function entry(
  pkg: string,
  test: string,
  name: string,
  red: string,
  ...edits: TamperEdit[]
): TamperEntry {
  return { name, pkg, test, red, only: true, edits };
}
const run = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/runtime", RUN_TEST, name, red, ...edits);
const agree = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/runtime", AGREE_TEST, name, red, ...edits);
/** A verifier edit, read by the runtime test through the verifier's dist: rebuild it first. */
const verifierRule = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  ...run(name, red, ...edits),
  rebuild: ["@motebit/verifier"],
});
const offer = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/runtime", IDENTITY_TEST, name, red, ...edits);
const interior = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/runtime", INTERIOR_TEST, name, red, ...edits);
const status = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/runtime", STATUS_TEST, name, red, ...edits);
const outcome = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("@motebit/ai-core", OUTCOME_TEST, name, red, ...edits);
const adapter = (name: string, red: string, ...edits: TamperEdit[]) =>
  entry("motebit", ADAPTER_TEST, name, red, ...edits);

const IDENTITY_ASSERTION = edit(
  RUN,
  "assertOfferedTools(offered, expected, authorized);",
  "void expected;",
);

const TAMPERS: TamperEntry[] = [
  // ── authority before start ─────────────────────────────────────────────
  // The rules are the verifier's (one law, one implementation): each entry
  // drops the run's CALL of one rule, or weakens the rule in the verifier
  // itself and rebuilds it — the run's test must go red either way.
  run(
    "preflight: the window rule not called",
    `${PRE} refuses an expired tick before any model call`,
    edit(
      AUTH,
      "  checkRepoChangeWindow({ grant, tick, now: clock, wallClock: verdict, failures }, fail);\n",
      "",
    ),
  ),
  run(
    "preflight: the window rule not called (not_before)",
    `${PRE} refuses a tick not yet valid before any model call`,
    edit(
      AUTH,
      "  checkRepoChangeWindow({ grant, tick, now: clock, wallClock: verdict, failures }, fail);\n",
      "",
    ),
  ),
  agree(
    "preflight: the tick-structure rule not called",
    `${AGREE} agree on a tick issued before the grant`,
    edit(AUTH, "  checkRepoChangeTickStructure(grant, tick, fail);\n", ""),
  ),
  run(
    "preflight: the grant rules not called",
    `${PRE} refuses a grant with a spend ceiling before any model call`,
    edit(
      AUTH,
      "  const tickTools = checkRepoChangeGrantShape(grant, tick, fail);",
      '  const tickTools = new Set(["repo_read_blob", "repo_write_path"] as const);',
    ),
  ),
  run(
    "preflight: the pin rules not called",
    `${PRE} refuses a delegator that is not the principal pin before any model call`,
    edit(AUTH, "  checkRepoChangeParties(grant, { principal, agents: [agent] }, fail);\n", ""),
  ),
  agree(
    "preflight: the tick signature not checked",
    `${AGREE} agree on a tick whose signature does not verify`,
    edit(
      AUTH,
      '  if (verdict !== null && verdict.integrity !== "verified") {',
      '  if ((false as boolean) && verdict !== null && verdict.integrity !== "verified") {',
    ),
  ),
  agree(
    "preflight: the grant signature not checked",
    `${AGREE} agree on a grant signed by another key`,
    edit(
      AUTH,
      "    !(await verifyStandingDelegation(grant, { checkExpiry: false, now: Number.MAX_SAFE_INTEGER }))",
      "    (false as boolean) &&\n    !(await verifyStandingDelegation(grant, { checkExpiry: false, now: Number.MAX_SAFE_INTEGER }))",
    ),
  ),
  run(
    "preflight: the revocation-set rule not called (revoked)",
    `${PRE} refuses a revoked grant before any model call`,
    edit(AUTH, "  await checkRepoChangeRevocationSet(grant, revocations, fail);\n", ""),
  ),
  run(
    "preflight: the revocation-set rule not called (malformed file)",
    `${PRE} refuses a revocation file that failed strict parsing before any model call`,
    edit(AUTH, "  await checkRepoChangeRevocationSet(grant, revocations, fail);\n", ""),
  ),
  run(
    "preflight: the revocation-set rule not called (forged entry)",
    `${PRE} refuses a forged revocation in the set (strictly parsed, never skipped) before any model call`,
    edit(AUTH, "  await checkRepoChangeRevocationSet(grant, revocations, fail);\n", ""),
  ),
  verifierRule(
    "verifier rule: a revocation entry's signature not verified",
    `${PRE} refuses a forged revocation in the set (strictly parsed, never skipped) before any model call`,
    edit(
      RULES,
      "      (await verifyDelegationRevocation(r));",
      "      ((await verifyDelegationRevocation(r)) || true);",
    ),
  ),
  agree(
    "preflight: subject_binding digest canonicality not checked",
    `${AGREE} agree on a non-canonical subject_binding digest`,
    edit(
      AUTH,
      "  if (grant.subject_binding !== undefined && !HEX64.test(grant.subject_binding.digest)) {",
      "  if ((false as boolean) && grant.subject_binding !== undefined && !HEX64.test(grant.subject_binding.digest)) {",
    ),
  ),
  run(
    "preflight: scope not matched against the grant's binding",
    `${PRE} refuses a scope the grant does not bind before any model call`,
    edit(AUTH, "    if (!match.valid) {", "    if ((false as boolean) && !match.valid) {"),
  ),
  run(
    "preflight: non-canonical allowed path accepted",
    `${PRE} refuses a non-canonical allowed path before any model call`,
    edit(
      AUTH,
      "    if (!isCanonicalRepoPath(p)) {",
      "    if ((false as boolean) && !isCanonicalRepoPath(p)) {",
    ),
  ),
  run(
    "preflight: path predicate not applied",
    `${PRE} refuses an allowed path the predicate refuses before any model call`,
    edit(
      AUTH,
      "    } else if (!bundle.isPathPermitted(p)) {",
      "    } else if ((false as boolean) && !bundle.isPathPermitted(p)) {",
    ),
  ),
  run(
    "preflight: repository not compared",
    `${PRE} refuses a scope for another repository before any model call`,
    edit(
      AUTH,
      "  if (scope.repo !== bundle.expectedRepo) {",
      "  if ((false as boolean) && scope.repo !== bundle.expectedRepo) {",
    ),
  ),
  // The verifier's own rule weakened (and the verifier rebuilt): the run,
  // which calls it, goes red — evidence the run runs the one implementation.
  verifierRule(
    "verifier rule: tool lists accept names outside the two tools",
    `${PRE} refuses a scope wider than the two tools before any model call`,
    edit(
      RULES,
      "    if (tool === undefined || out.has(tool)) return null;\n    out.add(tool);",
      "    if (out.has((tool ?? part) as RepoChangeTool)) return null;\n    out.add((tool ?? part) as RepoChangeTool);",
    ),
    edit(
      TOOLS,
      "if (offered.length !== expected.size || expected.size !== authorized.size) {",
      "if (offered.length !== expected.size) {",
    ),
  ),
  verifierRule(
    "verifier rule: the 24-hour lifetime not enforced",
    `${PRE} refuses a grant living longer than 24 hours before any model call`,
    edit(
      RULES,
      "  if (lifetime > REPO_CHANGE_MAX_GRANT_LIFETIME_MS) {",
      "  if ((false as boolean) && lifetime > REPO_CHANGE_MAX_GRANT_LIFETIME_MS) {",
    ),
  ),
  verifierRule(
    "verifier rule: the canonical path rule accepts `..`",
    `${PRE} refuses a non-canonical allowed path before any model call`,
    edit(
      RULES,
      '    if (seg.endsWith(".") || seg.toLowerCase() === ".git") return false;',
      '    if (seg.toLowerCase() === ".git") return false;',
    ),
  ),
  verifierRule(
    // Both branches that refuse an expired tick (the expiry branch and the
    // "crypto refuses the tick at this time" branch below it) — one alone is
    // GREEN by design, the verifier's own layering.
    "verifier rule: tick expiry not judged",
    `${PRE} refuses an expired tick before any model call`,
    edit(
      RULES,
      '  } else if (wallClock.authority === "expired" || now > grant.expires_at) {',
      '  } else if ((false as boolean) && (wallClock.authority === "expired" || now > grant.expires_at)) {',
    ),
    edit(
      RULES,
      '    wallClock.authority !== "valid" &&\n',
      '    (false as boolean) &&\n    wallClock.authority !== "valid" &&\n',
    ),
  ),
  run(
    "preflight: agent not matched to the grant's delegate",
    `${PRE} refuses an agent that is not the grant's delegate`,
    edit(
      AUTH,
      "  checkRepoChangeParties(grant, { principal, agents: [agent] }, fail);\n",
      "  checkRepoChangeParties(\n    grant,\n    { principal, agents: [{ motebit_id: grant.delegate_id, public_key: grant.delegate_public_key }] },\n    fail,\n  );\n",
    ),
    edit(
      RUN,
      "if (!(await verifyToolInvocationReceipt(probe, delegateKey))) {",
      "if ((false as boolean) && !(await verifyToolInvocationReceipt(probe, delegateKey))) {",
    ),
  ),
  run(
    "preflight: the agent's key pair not proven before the first call",
    `${PRE} refuses an agent whose private key does not sign as its public key`,
    edit(
      RUN,
      "if (!(await verifyToolInvocationReceipt(probe, delegateKey))) {",
      "if ((false as boolean) && !(await verifyToolInvocationReceipt(probe, delegateKey))) {",
    ),
  ),

  // ── authority on every call ────────────────────────────────────────────
  run(
    "per-call: authority judged only at preflight",
    `${WRITE_AUTH} a tick that expires mid-run makes the next repo_write_path denied, with no write`,
    edit(
      RUN,
      "const check = await checkRepoTaskAuthority(authority, agentPin, startedAt);",
      "const check = preflight as Awaited<ReturnType<typeof checkRepoTaskAuthority>>;",
    ),
  ),

  // ── status honesty and the durable sink (the run) ──────────────────────
  run(
    "run: a throwing handler signed as completed",
    `${STATUS} success is completed, refusal is denied, a throw is failed — each a receipt in the sink`,
    edit(
      RUN,
      'outcome = { status: "failed", result: { ok: false, error: TOOL_FAILED } };',
      'outcome = { status: "completed", result: { ok: false, error: TOOL_FAILED } };',
    ),
  ),
  run(
    "run: a call to an absent tool signed as failed",
    `${STATUS} a call to a tool the run does not have is denied with a receipt`,
    edit(
      RUN,
      '          status: "denied",\n          result: { ok: false, error: `${toolCall.name} is not a tool of this run` },',
      '          status: "failed",\n          result: { ok: false, error: `${toolCall.name} is not a tool of this run` },',
    ),
  ),
  run(
    "run: a rejecting sink swallowed",
    `${STATUS} a sink that rejects aborts the run: no later call runs`,
    edit(
      RUN,
      "throw new RepoTaskAbortedError(`the receipt sink rejected a receipt: ${msg}`, { cause: err });",
      "return void msg;",
    ),
  ),
  run(
    "run: no receipt ceiling",
    `${STATUS} the run stops at the bundle's 256-receipt ceiling`,
    edit(
      RUN,
      "if (receipts.length >= REPO_CHANGE_MAX_TOOL_RECEIPTS) {",
      "if (receipts.length >= Number.MAX_SAFE_INTEGER) {",
    ),
  ),

  // ── exactly the scope's tools, by identity ─────────────────────────────
  offer(
    "identity assertion removed (extra tool)",
    `${OFFER} an injected extra tool aborts before the first model call`,
    IDENTITY_ASSERTION,
  ),
  offer(
    "identity assertion removed (same-named handler)",
    `${OFFER} a same-named stand-in handler aborts before the first model call`,
    IDENTITY_ASSERTION,
  ),
  offer(
    "identity assertion removed (same-named definition)",
    `${OFFER} a same-named copy of the definition aborts before the first model call`,
    IDENTITY_ASSERTION,
  ),
  offer(
    "identity assertion removed (dropped tool)",
    `${OFFER} a dropped tool aborts before the first model call`,
    IDENTITY_ASSERTION,
  ),
  offer(
    "identity assertion removed (swap mid-run)",
    `${OFFER} a handler swapped mid-run aborts at the next model call, before any write`,
    IDENTITY_ASSERTION,
  ),
  offer(
    "registry not frozen",
    `${OFFER} the built registry is frozen: entries cannot be pushed, replaced or rewired`,
    edit(
      TOOLS,
      "const registry: RepoTaskToolRegistry = Object.freeze({ entries: Object.freeze(entries) });",
      "const registry: RepoTaskToolRegistry = { entries };",
    ),
  ),
  run(
    "registry builds a tool the tick does not authorize",
    `${WRITE} a tick without repo_write_path builds no write tool: the call is denied`,
    edit(
      TOOLS,
      'if (tools.has("repo_write_path")) entries.push(',
      "if (true as boolean) entries.push(",
    ),
    edit(
      TOOLS,
      "if (offered.length !== expected.size || expected.size !== authorized.size) {",
      "if (offered.length !== expected.size) {",
    ),
    edit(TOOLS, "      !(authorized as ReadonlySet<string>).has(name) ||\n", ""),
  ),

  // ── repo_write_path ────────────────────────────────────────────────────
  run(
    "write: any path string accepted",
    `${WRITE} refuses any other path string before touching any I/O`,
    edit(
      TOOLS,
      'if (typeof path !== "string" || !allowed.has(path)) {',
      'if (typeof path !== "string") {',
    ),
  ),
  run(
    "write: NUL content accepted",
    `${WRITE} refuses content with a NUL byte`,
    edit(
      TOOLS,
      'if (content.includes("\\0")) return deny(',
      'if ((false as boolean) && content.includes("\\0")) return deny(',
    ),
  ),
  run(
    "write: a tracked non-regular file overwritten",
    `${WRITE} refuses a tracked path that is not a regular 100644 file`,
    edit(
      TOOLS,
      "if (tracked !== null && (tracked.kind",
      "if ((false as boolean) && tracked !== null && (tracked.kind",
    ),
  ),
  run(
    "write: max_changed_files not enforced",
    `${WRITE} refuses a write past max_changed_files`,
    edit(
      TOOLS,
      "if (!written.has(path) && written.size >= maxChanged) {",
      "if ((false as boolean) && !written.has(path) && written.size >= maxChanged) {",
    ),
  ),

  // ── repo_read_blob ─────────────────────────────────────────────────────
  run(
    "read: out-of-tree spellings looked up",
    `${READ} refuses an out-of-tree path before any lookup`,
    edit(
      TOOLS,
      'if (typeof path !== "string" || !isReadablePath(path)) {',
      'if (typeof path !== "string") {',
    ),
  ),
  run(
    "read: symlinks, gitlinks and trees read as files",
    `${READ} refuses untracked paths, symlinks, gitlinks and trees`,
    edit(
      TOOLS,
      'if (entry.kind !== "blob") {',
      'if ((false as boolean) && entry.kind !== "blob") {',
    ),
  ),

  // ── no interior ────────────────────────────────────────────────────────
  interior(
    "the run reads the user's config file",
    `${INTERIOR} reads no file and no config, and forms no memory however the model tags its text`,
    edit(
      RUN,
      'import type { StreamingProvider } from "@motebit/ai-core";',
      'import { readFileSync } from "node:fs";\nimport type { StreamingProvider } from "@motebit/ai-core";',
    ),
    edit(
      RUN,
      "  const clock = input.clock ?? Date.now;",
      '  try {\n    readFileSync("/nonexistent/.motebit/config.json");\n  } catch {\n    // absent\n  }\n  const clock = input.clock ?? Date.now;',
    ),
  ),
  interior(
    "the pack carries a memory index",
    `${INTERIOR} every pack carries only the scope, the two tools and the run's conversation`,
    edit(
      PROMPT,
      "    precisionContext: input.frame,\n",
      '    precisionContext: input.frame,\n    memoryIndex: "[Memory index] recalled",\n',
    ),
  ),

  // ── general runtime: honest status + durable sink ──────────────────────
  status(
    "streaming: every receipt signed completed",
    `${LOOPST} success completed, ok:false failed, a throw failed, a policy refusal denied — all in the durable sink`,
    edit(STREAM, "                status: chunk.outcome,", '                status: "completed",'),
  ),
  status(
    "streaming: a refused call (no calling chunk) gets no receipt",
    `${LOOPST} success completed, ok:false failed, a throw failed, a policy refusal denied — all in the durable sink`,
    edit(STREAM, "const args = pending?.args ?? chunk.args;", "const args = pending?.args;"),
  ),
  status(
    "streaming: the durable sink is fire-and-forget",
    `${LOOPST} a durable sink that rejects stops the turn (fail-closed): no later call runs`,
    edit(
      STREAM,
      "    if (durable) await durable(signed);",
      "    if (durable) void durable(signed).catch(() => undefined);",
    ),
  ),
  status(
    "streaming: an unsignable receipt silently dropped under a durable sink",
    `${LOOPST} with a durable sink, a receipt that cannot be signed (no key) stops the turn`,
    edit(
      STREAM,
      "    if (!deviceId || !privateKey || !this.deps.motebitId) {\n      if (durable) {",
      "    if (!deviceId || !privateKey || !this.deps.motebitId) {\n      if ((false as boolean) && durable) {",
    ),
  ),
  status(
    "resume: an approved call gets no receipt",
    `${RESUME} an approved call that runs gets its completed receipt`,
    edit(
      STREAM,
      "        // loop, so it signs here, with the handler's verdict as status.\n        await this.emitToolInvocationReceipt({",
      "        // loop, so it signs here, with the handler's verdict as status.\n        void ({",
    ),
  ),
  status(
    "resume: an approved call that failed signed completed",
    `${RESUME} an approved call that throws gets a failed receipt`,
    edit(
      STREAM,
      '          status: result.ok ? "completed" : "failed",\n        });\n        yield {',
      '          status: "completed",\n        });\n        yield {',
    ),
  ),
  status(
    "resume: a human refusal gets no receipt",
    `${RESUME} a call the human refuses gets a denied receipt`,
    edit(
      STREAM,
      "        // agent's record of the call it did not make).\n        await this.emitToolInvocationReceipt({",
      "        // agent's record of the call it did not make).\n        void ({",
    ),
  ),
  status(
    "refusal: a suppressed re-proposal gets no receipt",
    `${REFUSAL} a re-proposal of a refused call is suppressed and denied with a receipt`,
    edit(
      STREAM,
      "        // receipt like every other refused call.\n        await this.emitToolInvocationReceipt({",
      "        // receipt like every other refused call.\n        void ({",
    ),
  ),
  status(
    "refusal: an expired approval gets no receipt",
    `${REFUSAL} an approval that times out is denied with a receipt`,
    edit(
      STREAM,
      "      // rejection here is logged, never swallowed silently.\n      this.emitToolInvocationReceipt({",
      "      // rejection here is logged, never swallowed silently.\n      Promise.resolve({",
    ),
  ),
  status(
    "invokeLocalTool: a policy refusal gets no receipt",
    `${LOCAL} a policy refusal is denied with a receipt; an unknown tool too; success completed`,
    edit(
      RT,
      'return refuseLocalCall(decision.reason ?? `Tool "${name}" blocked by policy`);',
      'return { ok: false, error: decision.reason ?? `Tool "${name}" blocked by policy` };',
    ),
  ),
  status(
    "invokeLocalTool: the durable sink is fire-and-forget",
    `${LOCAL} a durable sink that rejects makes invokeLocalTool throw`,
    edit(
      RT,
      "    if (durable) await durable.append(signed);",
      "    if (durable) void durable.append(signed).catch(() => undefined);",
    ),
  ),

  // ── ai-core: the outcome on every done chunk ───────────────────────────
  outcome(
    "loop: ok:false signed completed (gated)",
    `${GATED} ok:false is failed`,
    edit(
      LOOP,
      '          // a completed one.\n          outcome: result.ok ? "completed" : "failed",',
      '          // a completed one.\n          outcome: "completed",',
    ),
  ),
  outcome(
    "loop: a throw signed completed (gated)",
    `${GATED} a throw is failed`,
    edit(
      LOOP,
      '            outcome: "failed",\n            result: msg,',
      '            outcome: "completed",\n            result: msg,',
    ),
  ),
  outcome(
    "loop: a policy refusal signed completed",
    `${GATED} a policy refusal is denied and carries its args and decision time`,
    edit(
      LOOP,
      '            outcome: "denied",\n            result: decision.reason,',
      '            outcome: "completed",\n            result: decision.reason,',
    ),
  ),
  outcome(
    "loop: a policy refusal carries no args (unreceiptable)",
    `${GATED} a policy refusal is denied and carries its args and decision time`,
    edit(
      LOOP,
      "            args: toolCall.args,\n            started_at: Date.now(),\n            mode: toolDef.embodimentMode,\n            slabProjection: toolDef.slabProjection,\n            // Owner channel only",
      "            mode: toolDef.embodimentMode,\n            slabProjection: toolDef.slabProjection,\n            // Owner channel only",
    ),
  ),
  outcome(
    "loop: an offering refusal signed completed",
    `${GATED} a call to a tool the offering filtered out is denied and carries its args`,
    edit(
      LOOP,
      '          outcome: "denied",\n          result: "Tool not available",',
      '          outcome: "completed",\n          result: "Tool not available",',
    ),
  ),
  outcome(
    "loop: a money-meter refusal signed completed",
    `${GATED} a money call with no grant or meter is denied and carries its args`,
    edit(
      LOOP,
      '                outcome: "denied",\n                result: reason,',
      '                outcome: "completed",\n                result: reason,',
    ),
  ),
  outcome(
    "loop: a quarantined result claims the call never ran",
    `${GATED} a call whose result is quarantined for injection still states the call's own outcome`,
    edit(
      LOOP,
      '                // (a `denied` would claim the call never ran).\n                outcome: result.ok ? "completed" : "failed",',
      '                // (a `denied` would claim the call never ran).\n                outcome: "denied",',
    ),
  ),
  outcome(
    "loop: ok:false signed completed (ungated)",
    `${UNGATED} ok:false is failed`,
    edit(
      LOOP,
      '        outcome: result.ok ? "completed" : "failed",\n        result: result.data ?? result.error,',
      '        outcome: "completed",\n        result: result.data ?? result.error,',
    ),
  ),
  outcome(
    "loop: a throw signed completed (ungated)",
    `${UNGATED} a throw is failed`,
    edit(
      LOOP,
      '          outcome: "failed",\n          result: msg,',
      '          outcome: "completed",\n          result: msg,',
    ),
  ),
  outcome(
    "prompt: the user's message rides the system prompt",
    "the system prompt never carries the user's message no line of a multi-line user message reaches the system prompt",
    edit(
      CORE,
      "if (!contextPack.activationPrompt && opts?.omitUserMessage !== true) {",
      "if (!contextPack.activationPrompt) {",
    ),
  ),

  // ── Node adapters ──────────────────────────────────────────────────────
  adapter(
    "reader: an entry at another path answered (exact path compare removed)",
    "git tree reader: the tip's tree, never the worktree sees nothing untracked, nothing through a symlinked directory, no glob",
    edit(READER, "if (!got.equals(want) || mode === undefined", "if (mode === undefined"),
  ),
  adapter(
    "reader: the tracked-path list is not recursive",
    "git tree reader: the tip's tree, never the worktree lists every tracked path at the tip, as git's bytes",
    edit(
      READER,
      '["ls-tree", "-r", "-z", "--full-tree", "--name-only", tip]',
      '["ls-tree", "-z", "--full-tree", "--name-only", tip]',
    ),
  ),
  adapter(
    "stager: the tree is built without the tip (read-tree removed)",
    "git change stager: blobs and a private index, never the worktree stages content as blobs and builds the change commit; worktree, index and refs untouched",
    edit(STAGER, '        await git.run(["read-tree", tip], { env });\n', ""),
  ),
  adapter(
    "stager: the change commit is not parented on the tip",
    "git change stager: blobs and a private index, never the worktree stages content as blobs and builds the change commit; worktree, index and refs untouched",
    edit(STAGER, '["commit-tree", tree, "-p", tip, "-F", "-"]', '["commit-tree", tree, "-F", "-"]'),
  ),
  adapter(
    "stager: a stage records no blob",
    "git change stager: blobs and a private index, never the worktree stages content as blobs and builds the change commit; worktree, index and refs untouched",
    edit(STAGER, "      staging.set(p, blob);", "      void blob;"),
  ),
  adapter(
    "stager: the content is not written to the object store",
    "git change stager: blobs and a private index, never the worktree stages content as blobs and builds the change commit; worktree, index and refs untouched",
    edit(
      STAGER,
      '["hash-object", "-w", "--no-filters", "--stdin"]',
      '["hash-object", "--no-filters", "--stdin"]',
    ),
  ),
  adapter(
    "stager: entries not computed against the tip",
    "git change stager: blobs and a private index, never the worktree stages content as blobs and builds the change commit; worktree, index and refs untouched",
    edit(
      STAGER,
      '["diff-tree", "-r", "-z", "--no-renames", tip, tree]',
      '["diff-tree", "-r", "-z", "--no-renames", tree, tree]',
    ),
  ),
  adapter(
    "stager: an unchanged path reported as an entry",
    "git change stager: blobs and a private index, never the worktree a later stage of the same path replaces the earlier one; an unchanged path is no entry",
    edit(
      STAGER,
      "        for (let i = 0; i + 1 < fields.length; i += 2) {",
      '        for (const [p0, b0] of staging) entries.push({ path: p0, mode: "100644", blob: b0 });\n        for (let i = fields.length; i + 1 < fields.length; i += 2) {',
    ),
  ),
  adapter(
    "stager: a non-relative path accepted",
    "git change stager: blobs and a private index, never the worktree refuses a path that is not repository-relative and a tip that is not an object id",
    edit(
      STAGER,
      '      if (p.length === 0 || p.includes("\\0") || p.startsWith("/")) {',
      "      if ((false as boolean) && p.length === 0) {",
    ),
  ),
  adapter(
    "isolated git: the real repository's GIT_DIR (its config is read)",
    "isolated git: the repository's own config is never read a hostile repo config (fsmonitor script and daemon, splitIndex, commitEncoding, include, hooksPath) steers nothing",
    edit(GITSESSION, "    GIT_DIR: privateRepo,", "    GIT_DIR: real,"),
  ),
  adapter(
    "stager: the postcondition does not throw (a D/F collision commits a deletion)",
    "git change stager: fail-closed postcondition and timestamps staging both a and a/b (a directory/file collision) throws and returns no commit",
    edit(
      STAGER,
      "            throw new Error(\n              `git change stager: the change tree is not exactly the staged adds and modifies",
      "            if (dstMode === undefined || dstBlob === undefined) throw new Error(\n              `git change stager: the change tree is not exactly the staged adds and modifies",
    ),
    edit(
      STAGER,
      '          throw new Error("git change stager: a staged change is missing from the change tree");',
      '          void new Error("git change stager: a staged change is missing from the change tree");',
    ),
  ),
  adapter(
    "stager: the postcondition accepts a type change (symlink/gitlink overwritten)",
    "git change stager: fail-closed postcondition and timestamps a path over a tracked symlink or gitlink throws (a type change, not a modify)",
    edit(STAGER, '            (status !== "A" && status !== "M") ||\n', ""),
  ),
  adapter(
    "stager: any timestamp accepted (milliseconds, fractions)",
    "git change stager: fail-closed postcondition and timestamps the timestamp is integer seconds, formatted as git's @<secs> +0000",
    edit(
      STAGER,
      "  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds >= MAX_TIMESTAMP_SECONDS) {",
      "  if ((false as boolean) && seconds < 0) {",
    ),
  ),
  run(
    "write: the prefix rule not applied (under a tracked file)",
    "repo task: repo_write_path refuses a directory/file conflict (the verifier's prefix rule) a write under a path tracked as a blob is denied, before staging",
    edit(
      TOOLS,
      "      if (conflict !== null) return deny(",
      "      if ((false as boolean) && conflict !== null) return deny(",
    ),
  ),
  run(
    "write: the prefix rule not applied (over a tracked directory)",
    "repo task: repo_write_path refuses a directory/file conflict (the verifier's prefix rule) a write over a tracked directory is denied",
    edit(
      TOOLS,
      "      if (conflict !== null) return deny(",
      "      if ((false as boolean) && conflict !== null) return deny(",
    ),
  ),
  verifierRule(
    "verifier rule: a prefix tracked as a non-tree not refused",
    "repo task: repo_write_path refuses a directory/file conflict (the verifier's prefix rule) a write under a path tracked as a gitlink is denied, before staging",
    edit(
      RULES,
      "    if (trackedNonTree.has(q)) return",
      "    if ((false as boolean) && trackedNonTree.has(q)) return",
    ),
  ),
  verifierRule(
    "verifier rule: allowed paths in a prefix relation not refused",
    "repo task: repo_write_path refuses a directory/file conflict (the verifier's prefix rule) two allowed paths in a prefix relation (a and a/b) are refused",
    edit(
      RULES,
      "    if (a !== p && (a.startsWith(`${p}/`) || p.startsWith(`${a}/`))) {",
      "    if ((false as boolean) && a !== p) {",
    ),
  ),
  agree(
    "preflight: the spent rule not called",
    `${AGREE} agree on a spent grant`,
    edit(AUTH, "  checkRepoChangeSpent(bundle.spent !== false, fail);\n", ""),
  ),
  adapter(
    "receipt file: an older run's file appended to",
    "receipt file sink: durable, one run per file appends each receipt as a line and refuses to reuse a file",
    edit(
      SINK,
      "fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND",
      "fs.constants.O_CREAT | fs.constants.O_APPEND",
    ),
  ),

  // ── case alias, write counting, shapes, unexecuted calls (review round 1) ──
  run(
    "write: the case-collision rule not applied",
    "repo task: repo_write_path refuses a case alias (the verifier's case rule) a tracked Docs/A.md (100755) makes docs/a.md denied, before the writer is touched",
    edit(
      TOOLS,
      "      if (collision !== null) return deny(",
      "      if ((false as boolean) && collision !== null) return deny(",
    ),
  ),
  run(
    "write: allowed paths left out of the case index",
    "repo task: repo_write_path refuses a case alias (the verifier's case rule) two allowed paths that alias by case are both refused",
    edit(
      TOOLS,
      "        caseIndex: repoPathCaseIndex([...names, ...allowed]),",
      "        caseIndex: repoPathCaseIndex([...names, path0]),",
    ),
    edit(
      TOOLS,
      "  let tipPaths:",
      '  const path0 = scope.allowed_paths[0] ?? "";\n  let tipPaths:',
    ),
  ),
  run(
    "write: an undecodable tracked path ignored by the case rule",
    "repo task: repo_write_path refuses a case alias (the verifier's case rule) a tracked path that is not UTF-8 refuses every write (no collision can be ruled out)",
    edit(
      TOOLS,
      "          return null;\n        }\n      }\n      return {",
      "          continue;\n        }\n      }\n      return {",
    ),
  ),
  run(
    "write: a path counted only after a successful stage",
    "repo task: a path counts toward max_changed_files once the stager is called a write that fails part-way is failed and still counts",
    edit(
      TOOLS,
      "      written.add(path);\n      await stager.stage(path, bytes);",
      "      await stager.stage(path, bytes);\n      written.add(path);",
    ),
  ),
  agree(
    "preflight: grant and tick shapes not checked",
    `${AGREE} agree on an extra signed key on the grant`,
    edit(AUTH, '      ["the grant", isRepoChangeGrantShape(grant)],\n', ""),
  ),
  agree(
    "preflight: a grant missing a key accepted",
    `${AGREE} agree on a grant missing its not_before key`,
    edit(AUTH, '      ["the grant", isRepoChangeGrantShape(grant)],\n', ""),
  ),
  agree(
    "preflight: tick shape not checked",
    `${AGREE} agree on an extra signed key on the tick`,
    edit(AUTH, '      ["the tick", isRepoChangeTickShape(tick)],\n', ""),
  ),
  run(
    "run: a port's error message shown to the model",
    "repo task: no host detail reaches the model a port error is a fixed code to the model; the detail stays in the local record",
    edit(
      RUN,
      '          outcome = { status: "failed", result: { ok: false, error: TOOL_FAILED } };',
      '          outcome = { status: "failed", result: { ok: false, error: detail } };',
    ),
  ),
  run(
    "run: the bounds read live from the caller's objects (no snapshot)",
    "repo task: the bounds are a snapshot taken before the first await a caller that widens the scope after calling cannot move the run's limits",
    edit(
      RUN,
      "  const authority: RepoTaskAuthorityBundle = deepFreeze({",
      "  const authority: RepoTaskAuthorityBundle = ({",
    ),
    edit(
      RUN,
      "    scope: structuredClone(input.authority.scope),",
      "    scope: input.authority.scope,",
    ),
  ),
  {
    name: "web: the receipt pulse fires for any status",
    pkg: "@motebit/web",
    test: "src/ui/__tests__/receipt-sign-pulse.test.ts",
    red: "wireReceiptSignPulse — the signed pulse claims only what was signed does NOT pulse for a signed receipt that says the call failed or was denied",
    only: true,
    edits: [edit(WEB_PULSE, '    if (receipt.status !== "completed") return;\n', "")],
  },
  status(
    "runtime: the void runs outside the turn's try (a rejected receipt wedges the runtime)",
    "a durable sink that rejects a void's receipt never wedges the runtime turn 1 pauses, turn 2's void receipt is rejected (that turn fails), turn 3 runs",
    edit(
      RT,
      "      const voidedApproval = principal.foreign ? null : await this.streaming.voidPendingApproval();\n",
      "      const voidedApproval = voidedEarly;\n",
    ),
    edit(
      RT,
      "    const turnStartedAt = Date.now();\n",
      "    const turnStartedAt = Date.now();\n    const voidedEarly = principal.foreign ? null : await this.streaming.voidPendingApproval();\n",
    ),
  ),
  status(
    "streaming: a superseded approval request gets no receipt",
    "every proposed call that is not executed gets a denied receipt two calls needing approval in one response: the superseded one is denied, the kept one approved",
    edit(
      STREAM,
      "        const superseded = this._pendingApproval;\n        if (superseded) {",
      "        const superseded = this._pendingApproval;\n        if ((false as boolean) && superseded) {",
    ),
  ),
  status(
    "streaming: a voided approval gets no receipt",
    "every proposed call that is not executed gets a denied receipt a pending approval voided by a new message is denied with a receipt, and is not a no",
    edit(
      STREAM,
      "    this.approvalVoidedCallback?.(voided.toolName);\n    await this.emitToolInvocationReceipt({",
      "    this.approvalVoidedCallback?.(voided.toolName);\n    void ({",
    ),
  ),
  status(
    "streaming: a voided approval is recorded as a refusal (enters the brake)",
    "every proposed call that is not executed gets a denied receipt a pending approval voided by a new message is denied with a receipt, and is not a no",
    edit(
      STREAM,
      "    this.approvalVoidedCallback?.(voided.toolName);\n",
      "    this.approvalVoidedCallback?.(voided.toolName);\n    this.deniedToolsThisExchange.add(voided.toolName);\n    this.deniedIntents.set(deniedIntentKey(voided.toolName, voided.args), 1);\n",
    ),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
