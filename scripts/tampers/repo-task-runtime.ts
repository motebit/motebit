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
 *   - the Node adapters (git tree reader, worktree writer, receipt file).
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
const RUN = "packages/runtime/src/repo-task/run.ts";
const TOOLS = "packages/runtime/src/repo-task/tools.ts";
const PROMPT = "packages/runtime/src/repo-task/system-prompt.ts";
const STREAM = "packages/runtime/src/streaming.ts";
const RT = "packages/runtime/src/motebit-runtime.ts";
const LOOP = "packages/ai-core/src/loop.ts";
const CORE = "packages/ai-core/src/core.ts";
const WRITER = "apps/cli/src/repo-task/worktree-writer.ts";
const READER = "apps/cli/src/repo-task/git-tree-reader.ts";
const SINK = "apps/cli/src/repo-task/receipt-file-sink.ts";

const RUN_TEST = "src/__tests__/repo-task-run.test.ts";
const IDENTITY_TEST = "src/__tests__/repo-task-tool-identity.test.ts";
const INTERIOR_TEST = "src/__tests__/repo-task-no-interior.test.ts";
const STATUS_TEST = "src/__tests__/tool-receipt-status.test.ts";
const OUTCOME_TEST = "src/__tests__/tool-outcome.test.ts";
const ADAPTER_TEST = "src/repo-task/__tests__/node-adapters.test.ts";

const PRE = "repo task: the run cannot start without a valid tick";
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

/** Neutralize one `fail(...)` call of the authority check (keeps it valid code). */
const unfail = (call: string): TamperEdit => edit(AUTH, `fail(${call}`, `void (${call}`);

/** The verdict's own authority — the second layer under every window / structure check. */
const VERDICT_AUTHORITY = unfail("`the tick's authority is ${verdict.authority}`)");

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
  run(
    "preflight: tick expiry not judged",
    `${PRE} refuses an expired tick before any model call`,
    unfail('"the tick has expired")'),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: tick not_before not judged",
    `${PRE} refuses a tick not yet valid before any model call`,
    unfail('"the tick is not yet valid")'),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: tick grant_id not compared",
    `${PRE} refuses a tick of another grant before any model call`,
    unfail(`"the tick's grant_id is not the grant's")`),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: tick signature not checked",
    `${PRE} refuses a tick whose signature does not verify before any model call`,
    unfail(`"the tick's signature does not verify")`),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: tick signer not checked",
    `${PRE} refuses a tick signed by another key before any model call`,
    unfail(`"the tick's signature does not verify")`),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: revocation not consulted",
    `${PRE} refuses a revoked grant before any model call`,
    unfail("`the grant's revocation status is ${verdict.revocation.status}`)"),
  ),
  run(
    "preflight: a malformed revocation file ignored",
    `${PRE} refuses a revocation file that failed strict parsing before any model call`,
    edit(
      AUTH,
      "if (revocations.failures.length > 0) {",
      "if ((false as boolean) && revocations.failures.length > 0) {",
    ),
  ),
  run(
    "preflight: tool list accepts names outside the two tools",
    `${PRE} refuses a scope wider than the two tools before any model call`,
    edit(
      AUTH,
      "    if (tool === undefined || out.has(tool)) return null;\n    out.add(tool);",
      "    if (out.has((tool ?? part) as RepoChangeTool)) return null;\n    out.add((tool ?? part) as RepoChangeTool);",
    ),
    edit(
      TOOLS,
      "if (offered.length !== expected.size || expected.size !== authorized.size) {",
      "if (offered.length !== expected.size) {",
    ),
  ),
  run(
    "preflight: tick scope not narrowed within the grant's",
    `${PRE} refuses a tick wider than the grant before any model call`,
    unfail(`"the tick's scope is wider than the grant's")`),
    VERDICT_AUTHORITY,
  ),
  run(
    "preflight: scope not matched against the grant's binding",
    `${PRE} refuses a scope the grant does not bind before any model call`,
    unfail("`the scope is not the one the grant binds"),
  ),
  run(
    "preflight: subject_binding not required",
    `${PRE} refuses a grant with no subject_binding before any model call`,
    unfail('"the grant carries no subject_binding")'),
  ),
  run(
    "preflight: subject not checked",
    `${PRE} refuses a grant for another subject before any model call`,
    unfail("`the grant's subject is not"),
  ),
  run(
    "preflight: spend_ceiling allowed",
    `${PRE} refuses a grant with a spend ceiling before any model call`,
    unfail('"the grant carries a spend_ceiling")'),
  ),
  run(
    "preflight: 24-hour lifetime not enforced",
    `${PRE} refuses a grant living longer than 24 hours before any model call`,
    unfail('"the grant lives longer than 24 hours")'),
  ),
  run(
    "preflight: cadence below the lifetime allowed",
    `${PRE} refuses a cadence below the lifetime before any model call`,
    unfail(`"the grant's cadence_ms is less than its lifetime")`),
  ),
  run(
    "preflight: delegator not matched to the principal pin",
    `${PRE} refuses a delegator that is not the principal pin before any model call`,
    unfail(`"the grant's delegator is not the principal pin")`),
  ),
  run(
    "preflight: non-canonical allowed path accepted",
    `${PRE} refuses a non-canonical allowed path before any model call`,
    unfail("`allowed path ${JSON.stringify(p)} is not canonical`)"),
  ),
  run(
    "preflight: path predicate not applied",
    `${PRE} refuses an allowed path the predicate refuses before any model call`,
    unfail("`allowed path ${JSON.stringify(p)} fails the repository's path predicate`)"),
  ),
  run(
    "preflight: repository not compared",
    `${PRE} refuses a scope for another repository before any model call`,
    unfail('"the scope names another repository")'),
  ),
  run(
    "preflight: agent not matched to the grant's delegate",
    `${PRE} refuses an agent that is not the grant's delegate`,
    unfail(`"this agent is not the grant's delegate")`),
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
      'outcome = { status: "failed", result: { ok: false, error: msg } };',
      'outcome = { status: "completed", result: { ok: false, error: msg } };',
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
    "write: a writer refusal reported as completed",
    `${WRITE} a writer refusal (symlink component) is denied`,
    edit(
      TOOLS,
      "if (!outcome.ok) return deny(",
      "if ((false as boolean) && !outcome.ok) return deny(",
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
    "writer: follows a symlinked directory out of the worktree",
    "worktree writer: by real path, never through a symlink refuses a symlinked directory component and leaves the target untouched",
    edit(WRITER, "    return fs.lstatSync(p);", "    return fs.statSync(p);"),
    edit(
      WRITER,
      '      if (realDir !== dir || !inside(root, realDir))\n        return Promise.resolve(refuse("outside_worktree"));',
      "      void inside;",
    ),
  ),
  adapter(
    "writer: writes through a symlink as the final component",
    "worktree writer: by real path, never through a symlink refuses a symlink as the final component",
    edit(WRITER, "    return fs.lstatSync(p);", "    return fs.statSync(p);"),
    edit(
      WRITER,
      "            fs.constants.O_TRUNC |\n            fs.constants.O_NOFOLLOW,",
      "            fs.constants.O_TRUNC,",
    ),
  ),
  adapter(
    "writer: .git and traversal spellings walked",
    "worktree writer: by real path, never through a symlink refuses traversal, absolute and .git spellings",
    edit(
      WRITER,
      'segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")',
      'segments.some((s) => s === "")',
    ),
  ),
  adapter(
    "reader: an entry at another path answered (exact path compare removed)",
    "git tree reader: the tip's tree, never the worktree sees nothing untracked, nothing through a symlinked directory, no glob",
    edit(READER, "if (!got.equals(want) || mode === undefined", "if (mode === undefined"),
  ),
  adapter(
    "writer: creates a missing directory",
    "worktree writer: by real path, never through a symlink refuses a path under a missing directory and creates none",
    edit(
      WRITER,
      '          return Promise.resolve(refuse("missing_directory"));',
      "          fs.mkdirSync(next);",
    ),
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
];

void runTampers(TAMPERS, { root: ROOT });
