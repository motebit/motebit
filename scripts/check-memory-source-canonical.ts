#!/usr/bin/env tsx
/**
 * `check-memory-source-canonical` — registry-coverage gate for the
 * `MemorySource` closed registry, plus the two load-bearing
 * provenance-authorship scans.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-sensitivity-canonical` (#97),
 * `check-event-type-canonical` (#99),
 * `check-settlement-mode-canonical` (#100).
 *
 *   1. `MemorySource` (the union in
 *      `packages/protocol/src/memory-source.ts`) is the closed
 *      vocabulary of memory provenance — who contributed a remembered
 *      fact. Every `MemoryFormedPayload` MAY carry `source`; render
 *      surfaces show `[from:X]`; policy weighs it. Cross-implementation
 *      drift silently demotes (or worse, promotes) the epistemic
 *      standing of synced memories.
 *
 *   2. Three-way lock: union × `ALL_MEMORY_SOURCES` × this gate's
 *      `MEMORY_SOURCES_REFERENCE` must agree exactly.
 *
 *   3. Wire-format compliance: lowercase snake_case identifiers
 *      (`^[a-z][a-z0-9_]*$`), same convention as `EventType`.
 *
 *   4. **Authorship scan (the load-bearing assertion)**: `source` is
 *      assigned by the FORMING CODE PATH — never authored by the model,
 *      never accepted from a peer.
 *        (a) No file in `packages/ai-core/src` may parse or instruct a
 *            `source` attribute on `<memory>` tags — the model cannot
 *            self-classify provenance (self-escalation channel).
 *        (b) The MCP server's memory write path may only ever pass the
 *            literal `"peer_agent"` source — a remote caller cannot
 *            self-declare a trusted provenance tier.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md` (tenth registered
 * registry, `docs/doctrine/registry-pattern-canonical.md`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/memory-source.ts:ALL_MEMORY_SOURCES`.
 */
const MEMORY_SOURCES_REFERENCE = [
  "user_stated",
  "agent_inferred",
  "tool_derived",
  "peer_agent",
  "consolidation_derived",
] as const;

const SNAKE_CASE_IDENT_PATTERN = /^[a-z][a-z0-9_]*$/;

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
    // Never descend into node_modules: every caller discards those paths (the
    // src roots hold none; the `apps` walk filters `node_modules` out), and
    // following pnpm's workspace symlinks through them cost ~55s of stat per
    // run — 5 probes x 65s was over half of check-gates-effective's runtime.
    if (entry === "node_modules") continue;
    const rel = join(dir, entry);
    const full = resolve(ROOT, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      // A dangling symlink (e.g. a stale Expo prebuild under the gitignored
      // apps/mobile/ios/Pods after node_modules changed) has no content to
      // scan. Any other stat failure still fails the gate.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (st.isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type MemorySource\s*=([^;]+);/);
  if (unionMatch === null) return [];
  const body = unionMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(/ALL_MEMORY_SOURCES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  if (arrayMatch === null) return [];
  const body = arrayMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function main(): void {
  // === Sibling-alignment: three-way lock =========================
  const source = readFile("packages/protocol/src/memory-source.ts");
  if (source === null) {
    console.error(
      "check-memory-source-canonical: could not read packages/protocol/src/memory-source.ts.",
    );
    console.error("The MemorySource registry surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  const unionValues = readUnionValues(source);
  const arrayValues = readArrayValues(source);
  const gateValues = [...MEMORY_SOURCES_REFERENCE];

  if (unionValues.length === 0) {
    console.error("check-memory-source-canonical: could not parse MemorySource union values.");
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error(
      "check-memory-source-canonical: could not parse ALL_MEMORY_SOURCES array values.",
    );
    process.exit(1);
  }

  const unionSet = new Set(unionValues);
  const arraySet = new Set(arrayValues);
  const gateSet = new Set(gateValues);

  const unionOnly = [...unionSet].filter((v) => !arraySet.has(v) || !gateSet.has(v));
  const arrayOnly = [...arraySet].filter((v) => !unionSet.has(v) || !gateSet.has(v));
  const gateOnly = [...gateSet].filter((v) => !unionSet.has(v) || !arraySet.has(v));

  if (unionOnly.length > 0 || arrayOnly.length > 0 || gateOnly.length > 0) {
    console.error(
      "check-memory-source-canonical: sibling-alignment failure across MemorySource × ALL_MEMORY_SOURCES × gate reference.",
    );
    if (unionOnly.length > 0) {
      console.error(`  In union but not all three: ${unionOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    if (arrayOnly.length > 0) {
      console.error(
        `  In ALL_MEMORY_SOURCES but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`,
      );
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    console.error("");
    console.error(
      "The three-way lock requires `MemorySource` (union) × `ALL_MEMORY_SOURCES` (array) × `MEMORY_SOURCES_REFERENCE` (gate) to agree exactly.",
    );
    console.error(
      "Adding a memory source is intentional protocol-level work — update all three (plus MEMORY_SOURCE_MARKERS, compile-locked) in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md.");
    process.exit(1);
  }

  // === Wire-format compliance ====================================
  const malformed = MEMORY_SOURCES_REFERENCE.filter((v) => !SNAKE_CASE_IDENT_PATTERN.test(v));
  if (malformed.length > 0) {
    console.error(
      `check-memory-source-canonical: ${malformed.length} value(s) violate wire-format convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected lowercase snake_case ([a-z][a-z0-9_]*)`);
    }
    process.exit(1);
  }

  // === Authorship scan (a): the model cannot author source =======
  //
  // No file in packages/ai-core/src may (i) include a `source` attribute
  // group in a `<memory` tag pattern (parsing) or (ii) instruct the model
  // to emit one (prompting). A line that mentions `<memory` and `source=`
  // together is the drift signature for both.
  const aiCoreViolations: string[] = [];
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    // Test files are excluded: the negative fixture proving a
    // model-authored source attribute is NOT honored necessarily
    // contains the forbidden pattern.
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.includes("<memory") && /source\s*=/.test(line)) {
        aiCoreViolations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (aiCoreViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: model-authored provenance detected — a `<memory>` tag pattern in ai-core carries a `source` attribute:",
    );
    for (const v of aiCoreViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "`source` is assigned by the forming code path, never parsed from model output. The model self-classifying provenance is the self-escalation channel this registry exists to close.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (b): peers cannot self-declare source =====
  //
  // The MCP server's memory write path may pass ONLY the literal
  // "peer_agent". Any other registry value as a `source:` property in
  // mcp-server source is a peer-trust escalation. (Absence is fine —
  // pre-threading code passes no source at all.)
  const mcpViolations: string[] = [];
  const forbiddenInMcp = MEMORY_SOURCES_REFERENCE.filter((v) => v !== "peer_agent");
  for (const rel of walkTsFiles("packages/mcp-server/src")) {
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      for (const v of forbiddenInMcp) {
        if (new RegExp(`source\\s*:\\s*["']${v}["']`).test(line)) {
          mcpViolations.push(`${rel}:${i + 1} (source: "${v}")`);
        }
      }
      // A source derived from caller input is the same escalation.
      if (/source\s*:\s*(args|params|input|request)\b/.test(line)) {
        mcpViolations.push(`${rel}:${i + 1} (caller-derived source)`);
      }
    }
  }
  if (mcpViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: peer-declared provenance detected in mcp-server — remote writes must be `peer_agent` only:",
    );
    for (const v of mcpViolations) console.error(`  - ${v}`);
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (c): a foreign turn cannot form owner provenance
  //
  // #893: a customer's `motebit_task` (or a caller's `motebit_query`) runs
  // ANOTHER principal's words through the owner's loop. Every memory such a
  // turn forms must be `peer_agent`; stamped `user_stated` it would surface
  // in the owner's recall as `[from:user]`.
  //
  // The structure this locks, link by link:
  //   (i)   the turn-provenance resolver `turnMemorySource` in
  //         `packages/ai-core/src/memory-provenance.ts` returns
  //         `"peer_agent"` for a foreign turn as its FIRST return, so no
  //         later branch can promote one;
  //   (ii)  no other non-test ai-core file names an owner tier
  //         (`"user_stated"` / `"tool_derived"`) — a second formation
  //         path cannot mint owner provenance beside the resolver;
  //   (iii) the loop feeds the resolver the TURN's foreign fact
  //         (`foreignPrincipal: deps.foreignPrincipal`), not a global read;
  //   (iv)  the runtime sets that fact per turn through ONE mechanism,
  //         carried on the CALL PATH (#943 round 9 — never a runtime-wide
  //         mark): `loopDepsForTurn(deps, principal)` stamps
  //         `foreignPrincipal: principal.foreign` on every deps object it
  //         returns; both `sendMessage` entry points and the approval resume
  //         (whose principal is the paused record's) pass their own
  //         `TurnPrincipal`; and `handleAgentTask` starts every task turn
  //         with `foreignPrincipal: true`.
  // What this cannot express textually — that each foreign DOOR outside
  // the runtime (e.g. serve's `motebit_query` in apps/cli) passes the
  // option — is behavior, locked by the runtime and ai-core tests
  // (`foreign-turn-memory-provenance.test.ts`,
  // `foreign-turn-memory-deps.test.ts`, `foreign-turn-provenance.test.ts`).
  const foreignViolations: string[] = [];
  const RESOLVER = "packages/ai-core/src/memory-provenance.ts";
  const resolverSrc = readFile(RESOLVER);
  if (resolverSrc === null) {
    foreignViolations.push(`${RESOLVER}: missing — the one turn-provenance resolver is gone`);
  } else {
    const fnStart = resolverSrc.indexOf("export function turnMemorySource(");
    const firstReturn =
      fnStart === -1
        ? null
        : (resolverSrc
            .slice(fnStart)
            .split("\n")
            .find((l) => /\breturn\b/.test(l)) ?? null);
    if (firstReturn === null) {
      foreignViolations.push(`${RESOLVER}: \`export function turnMemorySource(\` not found`);
    } else if (!/foreignPrincipal\s*===\s*true\)\s*return\s+"peer_agent"/.test(firstReturn)) {
      foreignViolations.push(
        `${RESOLVER}: turnMemorySource's first return must be \`if (facts.foreignPrincipal === true) return "peer_agent";\` — found: ${firstReturn.trim()}`,
      );
    }
  }
  let aiCoreFilesScanned = 0;
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    if (rel.includes("__tests__") || rel === RESOLVER) continue;
    aiCoreFilesScanned++;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      // Prose may NAME the tiers (doc comments, in backticks); code
      // minting one is a quoted string literal.
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (/["'](user_stated|tool_derived)["']/.test(line)) {
        foreignViolations.push(
          `${rel}:${i + 1}: owner-tier provenance literal outside ${RESOLVER} — route through turnMemorySource`,
        );
      }
    }
  }
  const loopSrc = readFile("packages/ai-core/src/loop.ts") ?? "";
  if (!/turnMemorySource\(\{\s*foreignPrincipal:\s*deps\.foreignPrincipal\b/.test(loopSrc)) {
    foreignViolations.push(
      "packages/ai-core/src/loop.ts: formation must call `turnMemorySource({ foreignPrincipal: deps.foreignPrincipal, ... })` — the turn's own deps carry whose words it runs",
    );
  }
  const runtimeSrc = readFile("packages/runtime/src/motebit-runtime.ts") ?? "";
  // (iv-a) ONE loopDepsForTurn stamps the per-turn mark on the deps.
  const ldftStart = runtimeSrc.indexOf("private loopDepsForTurn<");
  const ldftEnd = ldftStart === -1 ? -1 : runtimeSrc.indexOf("\n  }\n", ldftStart);
  const ldftBody = ldftStart === -1 || ldftEnd === -1 ? "" : runtimeSrc.slice(ldftStart, ldftEnd);
  const ldftReturns = ldftBody.split("\n").filter((l) => /\breturn\b/.test(l));
  if (
    !/principal: TurnPrincipal,\s*\n\s*\): D \{\s*\n\s*const foreignPrincipal = principal\.foreign;/.test(
      ldftBody,
    ) ||
    ldftReturns.length === 0 ||
    ldftReturns.some((l) => !/\{\s*\.\.\.deps,\s*foreignPrincipal\b/.test(l))
  ) {
    foreignViolations.push(
      "packages/runtime/src/motebit-runtime.ts: `loopDepsForTurn(deps, principal: TurnPrincipal)` must set `foreignPrincipal` from `principal.foreign` on EVERY deps object it returns (`{ ...deps, foreignPrincipal, ... }`) — the turn's deps are where formation reads whose words it runs",
    );
  }
  // (iv-b) both turn entries build their deps through it.
  const perTurnDeps = (
    runtimeSrc.match(/this\.loopDepsForTurn\(\s*clearedLoopDeps,\s*principal\s*\)/g) ?? []
  ).length;
  if (perTurnDeps < 2) {
    foreignViolations.push(
      `packages/runtime/src/motebit-runtime.ts: sendMessage AND sendMessageStreaming must build their loop deps via \`this.loopDepsForTurn(clearedLoopDeps, principal)\` — found ${perTurnDeps} of 2`,
    );
  }
  // (iv-c) the approval resume builds its continuation's deps through it too,
  // with the principal decided from the paused RECORD (a turn entry).
  if (
    !/loopDepsForTurn: \(deps, principal\) => this\.loopDepsForTurn\(deps, principal\)/.test(
      runtimeSrc,
    )
  ) {
    foreignViolations.push(
      "packages/runtime/src/motebit-runtime.ts: StreamingManager must be wired with `loopDepsForTurn: (deps, principal) => this.loopDepsForTurn(deps, principal)`",
    );
  }
  const streamingSrc = readFile("packages/runtime/src/streaming.ts") ?? "";
  if (
    !/const principal = TurnPrincipal\.of\(pending\.foreignPrincipal === true\);/.test(
      streamingSrc,
    ) ||
    !/runTurnStreaming\(\s*this\.deps\.loopDepsForTurn\?\.\(loopDeps, principal\)/.test(
      streamingSrc,
    ) ||
    !/yield\* this\.processStream\(stream, pending\.userMessage, pending\.runId, \{ principal \}\);/.test(
      streamingSrc,
    )
  ) {
    foreignViolations.push(
      "packages/runtime/src/streaming.ts: the approval resume is a turn entry — decide `const principal = TurnPrincipal.of(pending.foreignPrincipal === true);` from the paused record, run its continuation with `this.deps.loopDepsForTurn?.(loopDeps, principal)` and process it with `{ principal }`",
    );
  }
  const taskHandlerSrc = readFile("packages/runtime/src/agent-task-handler.ts") ?? "";
  if (!/sendMessageStreaming\(task\.prompt,[^)]*foreignPrincipal:\s*true/s.test(taskHandlerSrc)) {
    foreignViolations.push(
      "packages/runtime/src/agent-task-handler.ts: a task's turn must be started with `foreignPrincipal: true` — the prompt is another principal's",
    );
  }
  if (foreignViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: a foreign principal's turn could form owner provenance (#893):",
    );
    for (const v of foreignViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: every memory a foreign turn forms is `peer_agent`. Keep the one resolver (`turnMemorySource`, foreign branch first), feed it `deps.foreignPrincipal`, and set that per turn in the runtime (`loopDepsForTurn(deps, principal)` from the turn entry's `TurnPrincipal`, the resume's paused record, `handleAgentTask`).",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (d): a foreign turn never writes the owner's history
  //
  // #904: a foreign turn's exchange pushed into the owner's conversation
  // reached the NEXT owner turn as `role:"user"`, so a memory that turn
  // formed from it was `user_stated` — scan (c)'s laundering, one hop
  // later — and the store row synced to the owner's other devices as the
  // owner's own conversation. The floor is whose turn it is, carried on
  // the turn's CALL PATH (#943 round 9) — never a runtime-wide mark, so the
  // owner's own concurrent reads and writes are never blanked either:
  //   (i)   no non-test runtime file outside `conversation.ts` writes a
  //         conversation store (`.appendMessage(` / `.createConversation(`)
  //         — every writer of the owner's conversation goes through
  //         `ConversationManager`;
  //   (ii)  `ConversationManager.forTurn(principal)` is the per-turn VIEW:
  //         a foreign principal gets `FOREIGN_TURN_CONVERSATION`, whose every
  //         member is inert (no history, no summary, no session facts, every
  //         write a no-op); `conversation.ts` reads no foreign state itself;
  //   (iii) no non-test runtime file reaches the turn-facing members
  //         (`trimmed`, `liveHistory`, `getSessionInfo`, `clearSessionInfo`,
  //         `pushExchange`, `pushActivation`, `injectIntermediateMessages`)
  //         except through `.forTurn(…)`, and StreamingManager is wired only
  //         with `conversationFor: (principal) => this.conversation.forTurn(principal)`;
  //   (iv)  the approval TIMEOUT (which fires outside any turn) writes the
  //         owner's history only for an owner expiry, and the resume
  //         continues a foreign turn over a private copy;
  //   (vi)  CONSENT: a foreign turn is not the human — every non-test
  //         runtime line that releases the denial brake
  //         (`.beginExchange()`), records user activity
  //         (`_lastUserMessageAt =`) or sets aside a pending approval
  //         (`.voidPendingApproval()`) is guarded by the turn's own
  //         `principal.foreign` on the same line.
  // Behavior: `foreign-turn-history.test.ts` (both doors, the store, a real
  // sync push, the task, the resume, the timeout, the read side, the brake,
  // the pending approval).
  const historyViolations: string[] = [];
  const CONV = "packages/runtime/src/conversation.ts";
  let runtimeFilesScanned = 0;
  let consentSites = 0;
  let viewAccesses = 0;
  for (const rel of walkTsFiles("packages/runtime/src")) {
    if (rel.includes("__tests__") || rel === CONV) continue;
    runtimeFilesScanned++;
    const content = readFile(rel) ?? "";
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (
        /\.conversation\.(trimmed|liveHistory|getSessionInfo|clearSessionInfo|pushExchange|pushActivation|injectIntermediateMessages)\b/.test(
          line,
        ) ||
        /this\.deps\.(pushExchange|pushActivation|injectIntermediateMessages|getLiveHistory)\b/.test(
          line,
        )
      ) {
        historyViolations.push(
          `${rel}:${i + 1}: reaches the conversation's turn-facing members without \`forTurn(principal)\` — whose turn it is must travel with the call: ${line.trim()}`,
        );
      }
      if (/\.forTurn\(/.test(line)) viewAccesses++;
      if (/\.(appendMessage|createConversation)\(/.test(line)) {
        historyViolations.push(
          `${rel}:${i + 1}: writes a conversation store outside ${CONV} — route the write through ConversationManager, whose floor refuses a foreign turn`,
        );
      }
      if (
        /\.beginExchange\(\)|\b_lastUserMessageAt\s*=[^=]|\.voidPendingApproval\(\)/.test(line) &&
        !/^\s*(?:private |public )?_lastUserMessageAt\b/.test(line)
      ) {
        consentSites++;
        if (!/\bprincipal\.foreign\b/.test(line)) {
          historyViolations.push(
            `${rel}:${i + 1}: releases the owner's denial brake, records user activity, or voids the owner's pending approval without the turn's own \`principal.foreign\` guard on the same line — a foreign turn is not the human: ${line.trim()}`,
          );
        }
      }
    }
  }
  const convSrc = readFile(CONV) ?? "";
  const between = (src: string, header: string, close: string): string => {
    const start = src.indexOf(header);
    if (start === -1) return "";
    const end = src.indexOf(close, start);
    return end === -1 ? "" : src.slice(start, end);
  };
  const forTurnBody = between(
    convSrc,
    "  forTurn(principal: TurnPrincipal): TurnConversation {",
    "\n  }\n",
  );
  const foreignView = between(
    convSrc,
    "const FOREIGN_TURN_CONVERSATION: TurnConversation = Object.freeze({",
    "\n});",
  );
  const INERT = [
    "trimmed: () => [],",
    "liveHistory: () => [],",
    "getSessionInfo: () => null,",
    "clearSessionInfo: () => {},",
    "pushExchange: () => {},",
    "pushActivation: () => {},",
    "injectIntermediateMessages: () => {},",
  ];
  const inertMembers = INERT.filter((m) => foreignView.includes(m)).length;
  if (
    !/^\s*if \(principal\.foreign\) return FOREIGN_TURN_CONVERSATION;/m.test(forTurnBody) ||
    inertMembers !== INERT.length
  ) {
    historyViolations.push(
      `${CONV}: \`forTurn(principal)\` must open with \`if (principal.foreign) return FOREIGN_TURN_CONVERSATION;\` and every member of \`FOREIGN_TURN_CONVERSATION\` must be inert (found ${inertMembers}/${INERT.length}) — a foreign turn reads none of the owner's conversation and writes nothing to it`,
    );
  }
  // #943 round 10: a task's isolation is `forTurn(FOREIGN)` alone — no
  // save / clear / restore of the owner's conversation around a task (it
  // blanked the owner's concurrent reads and discarded owner writes made
  // meanwhile).
  const taskSwap =
    /\b(saveContext|restoreContext|clearForTask|saveConversationContext|clearConversationForTask|restoreConversationContext)\b/;
  for (const rel of [
    CONV,
    "packages/runtime/src/agent-task-handler.ts",
    "packages/runtime/src/motebit-runtime.ts",
  ]) {
    const code = (readFile(rel) ?? "").replace(/^\s*(\*|\/\/).*$/gm, "");
    if (taskSwap.test(code)) {
      historyViolations.push(
        `${rel}: swaps the owner's conversation out around a task (save / clear / restore) — a task's turn is foreign and is isolated by \`forTurn(FOREIGN)\`; the owner's live history must stay the owner's while it runs`,
      );
    }
  }
  if (/isForeign|ForeignPrincipalTurn/.test(convSrc.replace(/^\s*(\*|\/\/).*$/gm, ""))) {
    historyViolations.push(
      `${CONV}: reads a "foreign turn in flight" state — the manager must not; whose turn it is arrives with the call (\`forTurn(principal)\`)`,
    );
  }
  if (
    !/conversationFor: \(principal\) => this\.conversation\.forTurn\(principal\)/.test(runtimeSrc)
  ) {
    historyViolations.push(
      "packages/runtime/src/motebit-runtime.ts: StreamingManager must be wired with `conversationFor: (principal) => this.conversation.forTurn(principal)`",
    );
  }
  if (
    !/if \(expired\.foreignPrincipal !== true\) \{\s*this\.deps\.conversationFor\(TurnPrincipal\.OWNER\)\.injectIntermediateMessages\(/.test(
      streamingSrc,
    )
  ) {
    historyViolations.push(
      "packages/runtime/src/streaming.ts: the approval timeout fires outside any turn — it writes the owner's history only for an OWNER expiry (`if (expired.foreignPrincipal !== true) { this.deps.conversationFor(TurnPrincipal.OWNER).injectIntermediateMessages(… }`)",
    );
  }
  if (
    !/if \(principal\.foreign\) \{\s*continuationHistory = \[\.\.\.convo\.liveHistory\(\), \.\.\.continuationPair\];/.test(
      streamingSrc,
    )
  ) {
    historyViolations.push(
      "packages/runtime/src/streaming.ts: a foreign resume must continue over a private copy (`continuationHistory = [...convo.liveHistory(), ...continuationPair]`), never inject into the owner's history",
    );
  }
  if (historyViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: a foreign principal's turn could write, read, or act as the owner's conversation (#904):",
    );
    for (const v of historyViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: a foreign turn's words never enter the owner's history as `user`, and whose turn it is travels on the call path. Every turn path reaches the conversation through `conversation.forTurn(principal)` (a foreign principal gets the inert `FOREIGN_TURN_CONVERSATION`); the manager reads no foreign state; the approval timeout writes only an owner expiry and a foreign resume continues over a private copy. Consent: `beginExchange`, `_lastUserMessageAt =` and `voidPendingApproval` stay behind the turn's own `!principal.foreign`.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Serving scan (e): a foreign turn is served none of the owner's interior
  //
  // #943 (owner decision 2026-09-28, fail closed): a foreign principal's
  // turn — a caller's `motebit_query`, a customer's `motebit_task`, their
  // approval resumes — recalls NONE of the owner's memories and receives
  // NONE of the owner-interior context blocks. The sensitivity ladder
  // governs egress to the model provider on the owner's behalf; serving to
  // another principal is a different boundary (#880's law). One chokepoint
  // per half, both read from the per-turn mark (`deps.foreignPrincipal`):
  //   (i)   RECALL: in `packages/ai-core/src`, every owner-store read
  //         (`.hasAnyMemory(` / `.getPinnedMemories(` / `.recallRelevant(` /
  //         `.getMemoryIndex(` / `eventStore.query(`) lives inside loop.ts's
  //         `recallOwnerInterior`, and `runTurnStreaming` calls it only as
  //         `foreign ? foreignTurnRecall() : await recallOwnerInterior(…)`
  //         with `const foreign = deps.foreignPrincipal === true;`;
  //   (ii)  OPTIONS: `runTurnStreaming` floors its options ONCE
  //         (`const options = foreign ? floorForeignTurnOptions(rawOptions)
  //         : rawOptions;`) and reads `rawOptions` nowhere else;
  //         `foreign-turn.ts` classifies every `TurnOptions` field
  //         (`satisfies Record<keyof TurnOptions, …>` — a new field is a
  //         compile error until classified), the owner-interior set is at
  //         least the decided eight, `sessionState` is `projected`, and
  //         `foreignSessionState` reads no snapshot facet but `substrate`;
  //   (iii) RUNTIME: every call of an owner-interior builder
  //         (`buildAgentContext(`, `buildSelfAwareness(`,
  //         `.buildCuriosityHints(`, `resolveSkillsForTurn(`,
  //         `emitSkillLoadEvents(`) in a non-test runtime file sits inside
  //         `ownerInteriorForTurn`, which opens with the foreign early
  //         return; and the `recall_memories` backend
  //         (`recallMemoriesForTool`) opens with
  //         `if (this.isForeignPrincipalTurn()) return [];`.
  // Behavior: `packages/ai-core/src/__tests__/foreign-turn-interior.test.ts`
  // (the loop, the resume shape) and
  // `packages/runtime/src/__tests__/foreign-turn-interior.test.ts` (both
  // doors, the task, the resume, the recall backend, no regression).
  const interiorViolations: string[] = [];
  const LOOP = "packages/ai-core/src/loop.ts";
  const FOREIGN_TURN = "packages/ai-core/src/foreign-turn.ts";
  // Every READ of the owner's stores: any `memoryGraph.` / `eventStore.`
  // member call that is not one of the known writes, plus any receiver's
  // `.exportAll(` / `.recallRelevant(` / `.getPinnedMemories(` /
  // `.getMemoryIndex(` / `.hasAnyMemory(` (a read renamed through another
  // binding is still caught). Writes (formation, appends) are allowed.
  const OWNER_STORE_WRITES = new Set([
    "append",
    "appendWithClock",
    "tombstone",
    "formMemory",
    "consolidateAndForm",
    "pinMemory",
    "deleteMemory",
    "saveNode",
  ]);
  const OWNER_STORE_READ = {
    test(line: string): boolean {
      if (
        /\.(hasAnyMemory|getPinnedMemories|recallRelevant|getMemoryIndex|exportAll)\??\.?\(/.test(
          line,
        )
      )
        return true;
      for (const m of line.matchAll(/\b(memoryGraph|eventStore)\s*\??\.\s*(\w+)\s*\??\.?\(/g)) {
        if (!OWNER_STORE_WRITES.has(m[2] as string)) return true;
      }
      return false;
    },
  };
  const bodyOf = (src: string, header: string, close: string): string => {
    const start = src.indexOf(header);
    if (start === -1) return "";
    const end = src.indexOf(close, start);
    return end === -1 ? "" : src.slice(start, end);
  };
  const recallBody = bodyOf(loopSrc, "async function recallOwnerInterior(", "\n}\n");
  if (recallBody === "") {
    interiorViolations.push(
      `${LOOP}: \`async function recallOwnerInterior(\` not found — the one recall chokepoint is gone`,
    );
  }
  let interiorAiCoreFiles = 0;
  let ownerStoreReads = 0;
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    if (rel.includes("__tests__")) continue;
    interiorAiCoreFiles++;
    const content = readFile(rel) ?? "";
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (!OWNER_STORE_READ.test(line)) continue;
      ownerStoreReads++;
      if (rel !== LOOP || !recallBody.includes(line)) {
        interiorViolations.push(
          `${rel}:${i + 1}: reads the owner's memory graph or event log outside \`recallOwnerInterior\` — a foreign turn would recall it: ${line.trim()}`,
        );
      }
    }
  }
  if (ownerStoreReads < 5) {
    interiorViolations.push(
      `${LOOP}: expected the five owner-store reads (hasAnyMemory, eventStore.query, getPinnedMemories, recallRelevant, getMemoryIndex) inside \`recallOwnerInterior\` — found ${ownerStoreReads}; the scan pattern may have drifted from the code`,
    );
  }
  const rtsBody = bodyOf(loopSrc, "export async function* runTurnStreaming(", "\n}\n");
  if (!/const foreign = deps\.foreignPrincipal === true;/.test(rtsBody)) {
    interiorViolations.push(
      `${LOOP}: runTurnStreaming must read the per-turn mark as \`const foreign = deps.foreignPrincipal === true;\``,
    );
  }
  if (
    !/const interior: OwnerInteriorRecall = foreign\s*\?\s*foreignTurnRecall\(\)\s*:\s*await recallOwnerInterior\(deps, userMessage\);/.test(
      rtsBody,
    )
  ) {
    interiorViolations.push(
      `${LOOP}: runTurnStreaming must recall as \`foreign ? foreignTurnRecall() : await recallOwnerInterior(deps, userMessage)\` — a foreign turn recalls nothing of the owner's`,
    );
  }
  const recallCalls = (loopSrc.match(/\brecallOwnerInterior\(/g) ?? []).length;
  if (recallCalls !== 2) {
    interiorViolations.push(
      `${LOOP}: \`recallOwnerInterior(\` must appear exactly twice (its definition and the one guarded call) — found ${recallCalls}`,
    );
  }
  if (
    !/const options = foreign \? floorForeignTurnOptions\(rawOptions\) : rawOptions;/.test(rtsBody)
  ) {
    interiorViolations.push(
      `${LOOP}: runTurnStreaming must floor its options once: \`const options = foreign ? floorForeignTurnOptions(rawOptions) : rawOptions;\``,
    );
  }
  const rawOptionUses = rtsBody
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && /\brawOptions\b/.test(l)).length;
  if (rawOptionUses !== 2) {
    interiorViolations.push(
      `${LOOP}: \`rawOptions\` must appear only in runTurnStreaming's parameter and its floor line — found ${rawOptionUses} code line(s); read the turn's options through the floored \`options\``,
    );
  }
  const ftSrc = readFile(FOREIGN_TURN) ?? "";
  const DECIDED_OWNER_INTERIOR = [
    "sessionInfo",
    "curiosityHints",
    "knownAgents",
    "agentCapabilities",
    "precisionContext",
    "firstConversation",
    "activationPrompt",
    "selectedSkills",
    "previousCues",
  ];
  if (
    !/satisfies Record<keyof TurnOptions, "owner_interior" \| "projected" \| "turn_own">/.test(
      ftSrc,
    )
  ) {
    interiorViolations.push(
      `${FOREIGN_TURN}: \`TURN_OPTION_FOREIGN_CLASS\` must \`satisfies Record<keyof TurnOptions, "owner_interior" | "projected" | "turn_own">\` — every turn input classified, a new one a compile error`,
    );
  }
  let ownerKeysClassified = 0;
  for (const key of DECIDED_OWNER_INTERIOR) {
    if (new RegExp(`^\\s*${key}: "owner_interior",`, "m").test(ftSrc)) ownerKeysClassified++;
    else
      interiorViolations.push(
        `${FOREIGN_TURN}: \`${key}\` must be classified \`"owner_interior"\` — the owner decided a foreign turn never receives it (#943)`,
      );
  }
  if (!/^\s*sessionState: "projected",/m.test(ftSrc)) {
    interiorViolations.push(
      `${FOREIGN_TURN}: \`sessionState\` must be classified \`"projected"\` — the owner's [Now] facets are projected away on a foreign turn`,
    );
  }
  // (ii-b) the PACK floor (#943 round 5): `CONTEXT_PACK_FOREIGN_CLASS`
  // classifies every `ContextPack` field (a new context source is a compile
  // error until classified), the owner's live state vector is projected and
  // the body cues are owner-interior, and every pack the loop hands the
  // provider passes `packFor(…)`.
  if (
    !/satisfies Record<keyof ContextPack, "owner_interior" \| "projected" \| "turn_own">/.test(
      ftSrc,
    ) ||
    !/^\s*current_state: "projected",/m.test(ftSrc) ||
    !/^\s*behavior_cues: "owner_interior",/m.test(ftSrc) ||
    !/floored\.current_state = neutralState\(\);/.test(ftSrc)
  ) {
    interiorViolations.push(
      `${FOREIGN_TURN}: \`CONTEXT_PACK_FOREIGN_CLASS\` must \`satisfies Record<keyof ContextPack, …>\`, project \`current_state\` (neutral) and class \`behavior_cues\` owner-interior — the owner's live state and body cues are never another principal's`,
    );
  }
  let providerCalls = 0;
  for (const line of loopSrc.split("\n")) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    if (!/\bprovider\.(generateStream|generate)\(/.test(line)) continue;
    providerCalls++;
    if (!/provider\.(generateStream|generate)\(packFor\(/.test(line)) {
      interiorViolations.push(
        `${LOOP}: a provider call that does not pass its pack through \`packFor(…)\` — a foreign turn's pack must be floored: ${line.trim()}`,
      );
    }
  }
  // (ii-c) FORMATION (#943 round 7): a foreign turn's memory formation is
  // `isolated_add` — ADD-only, never reading the owner's graph or touching
  // an owner node. The mode is a REQUIRED field of the formation deps
  // (compile-time); the loop derives it from the turn's mark through the one
  // producer of the branded `TurnFormationMode` (round 8), passes it to the
  // inline pass and carries it on the deferred chunk, and the memory-graph
  // pass branches on it exhaustively.
  const mfSrc = readFile("packages/memory-graph/src/memory-formation.ts") ?? "";
  if (
    !/const formation = turnFormationMode\(foreign\);/.test(rtsBody) ||
    !/mode: formation,/.test(rtsBody) ||
    !/\n\s*formation,\n/.test(rtsBody) ||
    !/export function turnFormationMode\(foreign: boolean\): TurnFormationMode \{\s*\n\s*return \(foreign \? "isolated_add" : "consolidate"\) as TurnFormationMode;/.test(
      ftSrc,
    ) ||
    !/readonly mode: FormationMode;/.test(mfSrc) ||
    !/case "isolated_add":\s*\n\s*return true;/.test(mfSrc) ||
    !/const linkTargets = isolated \? \[\] : relevantMemories;/.test(mfSrc)
  ) {
    interiorViolations.push(
      "packages/ai-core/src/loop.ts + packages/ai-core/src/foreign-turn.ts + packages/memory-graph/src/memory-formation.ts: a foreign turn's formation must be `isolated_add` (`const formation = turnFormationMode(foreign);`, passed as `mode` inline and carried as `formation` on the deferred chunk), and `isolated_add` must ADD only — no consolidation lookup, no link to an owner node",
    );
  }
  // (ii-d) the DEFERRED consumer (#943 round 8): desktop, web and mobile
  // defer formation, so the queue is the live path for a delegated task.
  // The runtime's ONLY `formMemoriesFromCandidates(` call is inside
  // `formDeferredMemories`, whose `mode` is a `TurnFormationMode` (a
  // hard-coded mode is a type error), and the consumer hands it the TURN's
  // decision — `chunk.formation` — never a mode of its own.
  let runtimeFormCalls = 0;
  for (const rel of walkTsFiles("packages/runtime/src")) {
    if (rel.includes("__tests__")) continue;
    for (const line of (readFile(rel) ?? "").split("\n")) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (/\bformMemoriesFromCandidates\(/.test(line)) runtimeFormCalls++;
    }
  }
  const deferredBody = bodyOf(runtimeSrc, "private async formDeferredMemories(", "\n  }\n");
  if (
    runtimeFormCalls !== 1 ||
    !/formMemoriesFromCandidates\(/.test(deferredBody) ||
    !/mode: import\("@motebit\/ai-core"\)\.TurnFormationMode,/.test(deferredBody) ||
    !/^\s*mode,$/m.test(deferredBody) ||
    !/const turnMode = chunk\.formation;/.test(runtimeSrc) ||
    !/this\.formDeferredMemories\(turnMode, candidates, relevantMemories\)/.test(runtimeSrc)
  ) {
    interiorViolations.push(
      `packages/runtime/src/motebit-runtime.ts: the deferred formation consumer must pass the turn's own decision — \`const turnMode = chunk.formation;\` then \`this.formDeferredMemories(turnMode, candidates, relevantMemories)\` — and \`formDeferredMemories(mode: TurnFormationMode, …)\` must hold the runtime's only \`formMemoriesFromCandidates(\` call (found ${runtimeFormCalls})`,
    );
  }
  // (ii-e) the owner's SELF-MODEL (#943 round 8): behavioural stats,
  // precision, the gradient bootstrap and reflection are the owner's; a
  // foreign turn feeds none of them. Whose turn it is is the stats call's
  // REQUIRED argument (round 9), never runtime state.
  const statsBody = bodyOf(runtimeSrc, "private accumulateTurnStats(", "\n  }\n");
  const statsFirst = statsBody
    .split("\n")
    .slice(1)
    .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
  if (
    !statsBody.startsWith(
      "private accumulateTurnStats(result: TurnResult, principal: TurnPrincipal): void {",
    ) ||
    statsFirst?.trim() !== "if (principal.foreign) return;"
  ) {
    interiorViolations.push(
      "packages/runtime/src/motebit-runtime.ts: `accumulateTurnStats(result, principal: TurnPrincipal)` must open with `if (principal.foreign) return;` — another principal's turn is not the owner's behaviour",
    );
  }
  // (ii-f) CONTENT-FREE REFUSAL (#943 round 8): a foreign principal's
  // refusal never names the owner's sensitivity tier, slab or activity.
  // Decided by the CALL's principal (round 9): both turn doors wrap the gate
  // (and their busy refusal) by the turn's own `principal`; a turn's
  // outbound-tool gate is wrapped by that call's `call.principal`. The shared
  // gate itself reads no foreign state, so an owner's concurrent refusal
  // stays descriptive.
  const gateBody = bodyOf(runtimeSrc, "  assertSensitivityPermitsAiCall(\n", "\n  }\n");
  const cfBody = bodyOf(runtimeSrc, "private contentFreeIfForeign<T>(", "\n  }\n");
  const busyBody = bodyOf(runtimeSrc, "private busyRefusal(", "\n  }\n");
  const doorWraps = (
    runtimeSrc.match(
      /this\.contentFreeIfForeign\(principal\.foreign, \(\) =>\s*\n?\s*this\.assertSensitivityPermitsAiCall\("(sendMessage|sendMessageStreaming)"\)/g,
    ) ?? []
  ).length;
  const busyDoors = (
    runtimeSrc.match(/if \(this\._isProcessing\) throw this\.busyRefusal\(principal\);/g) ?? []
  ).length;
  if (
    doorWraps !== 2 ||
    busyDoors !== 2 ||
    !/return principal\.foreign\s*\n?\s*\? new ForeignTurnRefusedError\(\)/.test(busyBody) ||
    !/if \(!foreign\) return gate\(\);\s*\n\s*try \{\s*\n\s*return gate\(\);\s*\n\s*\} catch \{\s*\n\s*throw new ForeignTurnRefusedError\(\);/.test(
      cfBody,
    ) ||
    !/contentFree\(call\?\.principal\.foreign === true, \(\) => assertGate\(name\)\);/.test(
      runtimeSrc,
    ) ||
    /ForeignTurnRefusedError|isForeign|_foreign/.test(gateBody)
  ) {
    interiorViolations.push(
      `packages/runtime/src/motebit-runtime.ts: a foreign principal's refusal must be content-free, decided by the CALL's principal — both turn doors wrap the gate in \`this.contentFreeIfForeign(principal.foreign, () => …)\` (found ${doorWraps}) and refuse busy with \`throw this.busyRefusal(principal)\` (found ${busyDoors}), \`contentFreeIfForeign\` rethrows any refusal as \`ForeignTurnRefusedError\` with no cause, the outbound-tool wrapper uses \`contentFree(call?.principal.foreign === true, …)\`, and the shared \`assertSensitivityPermitsAiCall\` reads no foreign state`,
    );
  }
  // (ii-g) STATE (#943 round 9): a foreign turn's model state updates never
  // reach the owner's live state vector — every `stateEngine.pushUpdate(` /
  // `stateEngine.tickNow(` in the loop sits inside the `if (!foreign) {`
  // block, and the runtime's stream processing drops a foreign turn's state
  // tags.
  const stateBlockStart = loopSrc.indexOf(
    "  if (!foreign) {\n    if (Object.keys(finalResponse.state_updates).length > 0) {",
  );
  const stateBlockEnd =
    stateBlockStart === -1 ? -1 : loopSrc.indexOf("stateEngine.tickNow();\n  }", stateBlockStart);
  const stateWrites = [...loopSrc.matchAll(/stateEngine\.(pushUpdate|tickNow)\(/g)].map(
    (m) => m.index ?? -1,
  );
  if (
    stateBlockStart === -1 ||
    stateBlockEnd === -1 ||
    stateWrites.length === 0 ||
    stateWrites.some((i) => i < stateBlockStart || i > stateBlockEnd) ||
    !/if \(!principal\.foreign && Object\.keys\(pendingStateUpdates\)\.length > 0\) \{/.test(
      streamingSrc,
    )
  ) {
    interiorViolations.push(
      `${LOOP} + packages/runtime/src/streaming.ts: a foreign turn's state updates must be discarded — every loop \`stateEngine.pushUpdate(\` / \`tickNow(\` inside \`if (!foreign) {\` (found ${stateWrites.length} write(s)), and \`processStream\` applies state tags only \`if (!principal.foreign && …)\``,
    );
  }
  if (providerCalls < 2) {
    interiorViolations.push(
      `${LOOP}: expected the two provider calls (the turn, the empty-text nudge) — found ${providerCalls}; the scan pattern may have drifted`,
    );
  }
  const fssBody = bodyOf(ftSrc, "export function foreignSessionState(", "\n}\n");
  const facetReads = [...fssBody.matchAll(/\bsnapshot\.(\w+)/g)].map((m) => m[1]);
  if (fssBody === "" || facetReads.some((f) => f !== "substrate")) {
    interiorViolations.push(
      `${FOREIGN_TURN}: \`foreignSessionState\` may read only \`snapshot.substrate\` — found ${fssBody === "" ? "(function missing)" : facetReads.join(", ")}`,
    );
  }
  const ownerInteriorBody = bodyOf(runtimeSrc, "private async ownerInteriorForTurn(", "\n  }\n");
  if (
    ownerInteriorBody === "" ||
    !/principal: TurnPrincipal,\s*\n\s*\): Promise</.test(ownerInteriorBody) ||
    !/>\s*\{\s*\n\s*if \(principal\.foreign\) return \{ sessionState: await this\.getSessionStateSnapshot\(\) \};/.test(
      ownerInteriorBody,
    )
  ) {
    interiorViolations.push(
      `packages/runtime/src/motebit-runtime.ts: \`ownerInteriorForTurn(text, runId, principal: TurnPrincipal)\` must open with \`if (principal.foreign) return { sessionState: await this.getSessionStateSnapshot() };\``,
    );
  }
  const OWNER_BUILDER_CALL =
    /\b(buildAgentContext|buildSelfAwareness|resolveSkillsForTurn|emitSkillLoadEvents)\(|\.buildCuriosityHints\(/;
  let builderCalls = 0;
  let runtimeInteriorFiles = 0;
  for (const rel of walkTsFiles("packages/runtime/src")) {
    if (rel.includes("__tests__")) continue;
    runtimeInteriorFiles++;
    const lines = (readFile(rel) ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      // Definitions (`private buildX(`, a class member `  buildX(): …`) are not calls.
      if (
        /^\s*(private |public )?(async )?(buildAgentContext|buildSelfAwareness|buildCuriosityHints|resolveSkillsForTurn|emitSkillLoadEvents)\(/.test(
          line,
        )
      )
        continue;
      if (!OWNER_BUILDER_CALL.test(line)) continue;
      builderCalls++;
      if (rel !== "packages/runtime/src/motebit-runtime.ts" || !ownerInteriorBody.includes(line)) {
        interiorViolations.push(
          `${rel}:${i + 1}: builds an owner-interior context block outside \`ownerInteriorForTurn\` — a foreign turn would receive it: ${line.trim()}`,
        );
      }
    }
  }
  if (builderCalls < 5) {
    interiorViolations.push(
      `packages/runtime/src/motebit-runtime.ts: expected the five owner-interior builder calls inside \`ownerInteriorForTurn\` — found ${builderCalls}; the scan pattern may have drifted from the code`,
    );
  }
  const recallToolBody = bodyOf(runtimeSrc, "async recallMemoriesForTool(", "\n  }\n");
  const recallSigEnd = recallToolBody.indexOf("): Promise<ToolRecallResult[]> {");
  const recallToolFirst = recallToolBody
    .slice(recallSigEnd === -1 ? recallToolBody.length : recallSigEnd)
    .split("\n")
    .slice(1)
    .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
  if (
    !/principal: TurnPrincipal,\s*\n\s*\): Promise<ToolRecallResult\[\]> \{/.test(recallToolBody) ||
    recallToolFirst === undefined ||
    !/^\s*if \(principal\.foreign\) return \[\];/.test(recallToolFirst)
  ) {
    interiorViolations.push(
      `packages/runtime/src/motebit-runtime.ts: \`recallMemoriesForTool(query, opts, principal: TurnPrincipal)\` (the recall_memories backend) must take whose call it is as a REQUIRED argument and open with \`if (principal.foreign) return [];\` — found: ${(recallToolFirst ?? "(missing)").trim()}`,
    );
  }
  // Each surface's recall_memories wiring names the owner explicitly —
  // true because that tool is `localOnly`, which a foreign turn's registry
  // never offers or runs.
  const RECALL_DEF = "packages/tools/src/builtins/recall-memories.ts";
  if (!/^\s*localOnly: true,/m.test(readFile(RECALL_DEF) ?? "")) {
    interiorViolations.push(
      `${RECALL_DEF}: the recall_memories definition must be \`localOnly: true\` — the surfaces' owner-principal recall wiring depends on no foreign turn ever running it`,
    );
  }
  let recallCallSites = 0;
  for (const rel of walkTsFiles("apps")) {
    if (rel.includes("__tests__") || rel.includes("node_modules")) continue;
    for (const line of (readFile(rel) ?? "").split("\n")) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line) || !/\.recallMemoriesForTool\(/.test(line)) continue;
      recallCallSites++;
      if (!/recallMemoriesForTool\(query, opts, TurnPrincipal\.OWNER\)/.test(line)) {
        interiorViolations.push(
          `${rel}: a surface's recall backend call must name its principal explicitly (\`recallMemoriesForTool(query, opts, TurnPrincipal.OWNER)\`): ${line.trim()}`,
        );
      }
    }
  }
  // (ii-h) THE LAW (#943 round 9): foreign-ness is a property of a CALL PATH,
  // never ambient runtime state. No non-test runtime file keeps or reads a
  // "foreign turn in flight" flag; a `TurnPrincipal` is DECIDED only at the
  // turn entries (`sendMessage`, `sendMessageStreaming` from their option, the
  // approval resume from its paused record) and threaded from there; the
  // runtime registry hands each handler its call's context; and the foreign
  // tool scope lives on the turn-scoped registry, never the shared one.
  let ambientReads = 0;
  let principalDecisions = 0;
  let runtimeLawFiles = 0;
  for (const rel of walkTsFiles("packages/runtime/src")) {
    if (rel.includes("__tests__")) continue;
    runtimeLawFiles++;
    const lines = (readFile(rel) ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (
        /\b(isForeignPrincipalTurn|enterForeignPrincipalTurn|_foreignTurn|_foreignResume)\b/.test(
          line,
        )
      ) {
        ambientReads++;
        interiorViolations.push(
          `${rel}:${i + 1}: a runtime-wide "foreign turn in flight" mark — whose call it is must travel on the call path (a \`TurnPrincipal\` / \`ToolCall\`), never be read from runtime state: ${line.trim()}`,
        );
      }
      if (/TurnPrincipal\.of\(/.test(line) && rel !== "packages/runtime/src/turn-principal.ts") {
        principalDecisions++;
        const isEntry =
          (rel === "packages/runtime/src/motebit-runtime.ts" &&
            /const principal = TurnPrincipal\.of\(options\?\.foreignPrincipal === true\);/.test(
              line,
            )) ||
          (rel === "packages/runtime/src/streaming.ts" &&
            /const principal = TurnPrincipal\.of\(pending\.foreignPrincipal === true\);/.test(
              line,
            ));
        if (!isEntry) {
          interiorViolations.push(
            `${rel}:${i + 1}: decides a \`TurnPrincipal\` outside a turn entry — only \`sendMessage*\` (from its option) and the approval resume (from its paused record) decide; everything else receives it: ${line.trim()}`,
          );
        }
      }
    }
  }
  if (principalDecisions !== 3) {
    interiorViolations.push(
      `packages/runtime/src: expected exactly three turn entries deciding a \`TurnPrincipal\` (sendMessage, sendMessageStreaming, the approval resume) — found ${principalDecisions}`,
    );
  }
  const strSrcLaw = readFile("packages/runtime/src/simple-tool-registry.ts") ?? "";
  const toolsForTurnBody = bodyOf(runtimeSrc, "private toolsForTurn(", "\n  }\n");
  if (
    !/\(entry\.handler as CallAwareToolHandler\)\(args, call\)/.test(strSrcLaw) ||
    !/const call: ToolCall = \{ destination: this\._turnReceiptKey \?\? OWNER_ACT, principal \};/.test(
      toolsForTurnBody,
    ) ||
    !/execute: \(name, args\) => inner\.execute\(name, args, call\),/.test(toolsForTurnBody) ||
    !/if \(!principal\.foreign\) return turnRegistry;\s*\n\s*return new ScopedToolRegistry\(turnRegistry, \{\s*\n\s*allows: \(toolName\) => !this\.isLocalOnlyTool\(toolName\),/.test(
      toolsForTurnBody,
    )
  ) {
    interiorViolations.push(
      "packages/runtime/src/motebit-runtime.ts + simple-tool-registry.ts: the turn-scoped registry (`toolsForTurn(tools, principal)`) must hand every execute the turn's `ToolCall` (`{ destination: this._turnReceiptKey ?? OWNER_ACT, principal }`), scope a FOREIGN turn to no `localOnly` tool (`new ScopedToolRegistry(turnRegistry, { allows: (toolName) => !this.isLocalOnlyTool(toolName), … })`), and the runtime registry must pass that call to the handler (`(entry.handler as CallAwareToolHandler)(args, call)`)",
    );
  }
  if (interiorViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: a foreign principal's turn could be served the owner's interior (#943):",
    );
    for (const v of interiorViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: a foreign turn recalls none of the owner's memories and receives no owner-interior block. Keep every owner-store read inside ai-core's `recallOwnerInterior` (called only when `deps.foreignPrincipal` is not true), floor the turn's options once with `floorForeignTurnOptions`, classify any new `TurnOptions` field in `TURN_OPTION_FOREIGN_CLASS` (owner-private ⇒ `owner_interior`), and build the runtime's owner blocks only in `ownerInteriorForTurn` behind its foreign early return. A future shareable tier is an explicit owner opt-in, never a default.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship (#943).");
    process.exit(1);
  }

  // === Serving scan (f): the owner's memories are served only to the owner
  //
  // #943 round 2: `motebit_recall` and the `motebit://memories` resource
  // returned the owner's memories to any authenticated caller. The rule
  // (decided): the owner's memories are served only to the OWNER principal,
  // judged from the request's VERIFIED caller context (`servedPrincipal`:
  // stdio = owner by construction; HTTP = owner iff the verified motebit
  // token's `mid` is this motebit; static / pluggable bearer and every other
  // caller = other). Locked textually:
  //   (i)   in every non-test file of `packages/mcp-server/src`, each
  //         `server.tool(` / `server.resource(` registration whose handler
  //         CALLS a memory read (`queryMemories(`, `getMemories(`,
  //         `recallRelevant(`, `exportAll(`) opens its check with
  //         `const principal = this.ownerPrincipal(extra);` followed by a
  //         refusal on `principal === null` — a new memory-read tool or
  //         resource without the check fails here;
  //   (ii)  every non-test definition of a memory-read dep
  //         (`getMemories:` / `queryMemories:` / `deps.queryMemories =`) in
  //         packages/ and apps/ opens with `assertOwnerPrincipal(principal);`;
  //   (iii) the coordinator's `memory_recall` frame (attached-surface.ts)
  //         opens with `if (params["principal"] !== "owner")` — an attached
  //         frontend must name the verified owner or get nothing.
  // Behavior: `packages/mcp-server/src/__tests__/owner-only-memory.test.ts`
  // (real HTTP: another motebit and a static bearer refused with no content,
  // the owner served), `service.test.ts`, `attached-surface.test.ts`.
  const ownerOnlyViolations: string[] = [];
  // Owner-interior reads served by a handler: memories, and (#943 round 4)
  // the owner's live state vector (`getState`).
  const MEMORY_READ_CALL = /\b(queryMemories|getMemories|recallRelevant|exportAll|getState)\(/;
  let mcpFilesScanned = 0;
  let memoryReadRegistrations = 0;
  let registrationsScanned = 0;
  for (const rel of walkTsFiles("packages/mcp-server/src")) {
    if (rel.includes("__tests__")) continue;
    mcpFilesScanned++;
    const src = readFile(rel) ?? "";
    const starts: number[] = [];
    const re = /\bserver\.(tool|resource)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) starts.push(m.index);
    for (let k = 0; k < starts.length; k++) {
      registrationsScanned++;
      const start = starts[k] as number;
      const end = k + 1 < starts.length ? (starts[k + 1] as number) : src.length;
      const block = src.slice(start, end);
      const code = block
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      if (!MEMORY_READ_CALL.test(code)) continue;
      memoryReadRegistrations++;
      if (
        !/const principal = this\.ownerPrincipal\(extra\);\s*\n\s*if \(principal === null\)/.test(
          code,
        )
      ) {
        const line = src.slice(0, start).split("\n").length;
        const name = /server\.(?:tool|resource)\(\s*"([^"]+)"/.exec(block)?.[1] ?? "(unnamed)";
        ownerOnlyViolations.push(
          `${rel}:${line}: \`${name}\` reads the owner's interior (memories or live state) without the owner check — open its handler with \`const principal = this.ownerPrincipal(extra); if (principal === null) …refuse\``,
        );
      }
    }
  }
  if (memoryReadRegistrations < 3) {
    ownerOnlyViolations.push(
      `packages/mcp-server/src: expected at least the three owner-interior registrations (motebit_recall, motebit://memories, motebit://state) — found ${memoryReadRegistrations}; the scan pattern may have drifted from the code`,
    );
  }
  let memoryDepDefs = 0;
  let depFilesScanned = 0;
  const srcRoots: string[] = [];
  for (const root of ["packages", "apps", "services"]) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(resolve(ROOT, root));
    } catch {
      dirs = [];
    }
    for (const d of dirs) srcRoots.push(join(root, d, "src"));
  }
  for (const srcRoot of srcRoots) {
    for (const rel of walkTsFiles(srcRoot)) {
      if (rel.includes("__tests__")) continue;
      depFilesScanned++;
      const lines = (readFile(rel) ?? "").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        // Any function form: `getMemories: async (…) =>`, a non-async arrow,
        // method shorthand `getMemories(…) {`, or `deps.queryMemories = …`.
        // A type signature (header reaches `;` before `{`/`=>`) is not a
        // definition.
        if (
          !/^\s*(async\s+)?(getMemories|queryMemories)\s*(:|\()|\bdeps\.(queryMemories|getMemories)\s*=/.test(
            line,
          )
        )
          continue;
        // Inside an `interface`/`type` declaration block ⇒ a signature, skip.
        let inTypeDecl = false;
        for (let k = i - 1; k >= 0; k--) {
          const up = lines[k] as string;
          if (/^(export\s+)?(interface|type)\b/.test(up)) {
            inTypeDecl = true;
            break;
          }
          if (/^\S/.test(up) && !/^\s*(\*|\/\/|\/\*)/.test(up)) break;
        }
        if (inTypeDecl) continue;
        memoryDepDefs++;
        // The body's first statement: the line after the one that opens it.
        const openLine = lines.slice(i).findIndex((l) => /\{\s*$/.test(l));
        const first =
          openLine === -1
            ? undefined
            : lines
                .slice(i + openLine + 1)
                .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
        if (first === undefined || !/^\s*assertOwnerPrincipal\(principal\);/.test(first)) {
          ownerOnlyViolations.push(
            `${rel}:${i + 1}: a memory-read dep must open with \`assertOwnerPrincipal(principal);\` — found: ${(first ?? "(nothing)").trim()}`,
          );
        }
      }
    }
  }
  if (memoryDepDefs < 6) {
    ownerOnlyViolations.push(
      `expected the six memory-read dep definitions (packages/mcp-server/src/service.ts ×2, apps/cli/src/daemon.ts ×4) — found ${memoryDepDefs}; the scan pattern may have drifted from the code`,
    );
  }
  // (iv) the owner principal is the local stdio session ONLY (#943 round 3):
  // `servedPrincipal` opens by returning "other" for every non-stdio
  // transport — an HTTP token, however verified, is never the owner (the
  // owner signs `mid`=self tokens for other parties; they replay).
  const mcpIndexSrc = readFile("packages/mcp-server/src/index.ts") ?? "";
  const spBody = bodyOf(mcpIndexSrc, "export function servedPrincipal(", "\n}\n");
  const spFirst = spBody
    .split("\n")
    .slice(1)
    .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
  if (
    spFirst === undefined ||
    !/^\s*if \(transport !== "stdio"\) return "other";/.test(spFirst) ||
    /motebitId|caller/.test(spBody)
  ) {
    ownerOnlyViolations.push(
      `packages/mcp-server/src/index.ts: \`servedPrincipal\` must open with \`if (transport !== "stdio") return "other";\` and read no caller identity — HTTP callers are never the owner (found: ${(spFirst ?? "(missing)").trim()})`,
    );
  }
  // (f)(v) #943 round 10: `motebit_query` runs as the request's SERVED
  // principal — stdio (the owner, the principal `motebit_recall` is served to)
  // an owner turn, every HTTP caller a foreign turn — and reports a formation
  // count to the owner only. The CLI's two serve deps take that principal and
  // never force one.
  const serveDepsSrc = readFile("apps/cli/src/serve-deps.ts") ?? "";
  if (
    !/const principal = servedPrincipal\(extra, this\.transportKind\);\s*\n\s*const result = await sendMessage\(args\.message, principal\);/.test(
      mcpIndexSrc,
    ) ||
    !/memories_formed: principal === "owner" \? result\.memoriesFormed : 0,/.test(mcpIndexSrc) ||
    !/\{ foreignPrincipal: !owner \}/.test(serveDepsSrc) ||
    !/client\.chat\(text, owner \? \{\} : \{ foreignPrincipal: true \}\)/.test(serveDepsSrc) ||
    (serveDepsSrc.match(/memoriesFormed: owner \? /g) ?? []).length !== 2 ||
    /\{ foreignPrincipal: true \}\)/.test(
      serveDepsSrc.replace("owner ? {} : { foreignPrincipal: true })", ""),
    )
  ) {
    ownerOnlyViolations.push(
      'packages/mcp-server/src/index.ts + apps/cli/src/serve-deps.ts: `motebit_query` must run as the request\'s served principal — `const principal = servedPrincipal(extra, this.transportKind); const result = await sendMessage(args.message, principal);`, report `memories_formed: principal === "owner" ? result.memoriesFormed : 0`, and both CLI serve deps must take the principal (`{ foreignPrincipal: !owner }`, `client.chat(text, owner ? {} : { foreignPrincipal: true })`, a count only when `owner`), never force one',
    );
  }
  const attachedSrc = readFile("packages/runtime/src/attached-surface.ts") ?? "";
  const recallArm = bodyOf(attachedSrc, 'case "memory_recall": {', "\n    }\n");
  const recallArmFirst = recallArm
    .split("\n")
    .slice(1)
    .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
  if (
    recallArmFirst === undefined ||
    !/^\s*if \(params\["principal"\] !== "owner"\) \{/.test(recallArmFirst)
  ) {
    ownerOnlyViolations.push(
      `packages/runtime/src/attached-surface.ts: the \`memory_recall\` frame must open with \`if (params["principal"] !== "owner") {\` (refuse) — found: ${(recallArmFirst ?? "(missing)").trim()}`,
    );
  }
  if (ownerOnlyViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: the owner's memories could be served to another principal (#943):",
    );
    for (const v of ownerOnlyViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      'Repair: a server-side read of the owner\'s memories is served only to the owner principal. In an MCP tool/resource handler, open with `const principal = this.ownerPrincipal(extra); if (principal === null) return/throw OWNER_ONLY_REFUSAL;` and pass `principal` to the dep; open every memory-read dep with `assertOwnerPrincipal(principal);`; keep the runtime-host `memory_recall` frame refusing any `principal` but `"owner"`.',
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship (#943).");
    process.exit(1);
  }

  // === Serving scan (g): a task's receipt embeds only its own turn's hires
  //
  // #943 rounds 3–4: hire receipts sat in shared buckets (the
  // interactive-delegation stash, each MCP adapter's array) drained by the
  // next task — or at turn close, which still swept in an owner's CONCURRENT
  // out-of-turn call (an `invokeLocalTool` tap, a PlanEngine step). The
  // owner's private results were signed into a customer's task receipt.
  // Now a receipt is attributed AT CAPTURE: it rides on the tool result
  // (`delegation_receipt`) and the runtime registry records it for the
  // destination the caller threaded into that call. Locked:
  //   (i)   no shared bucket anywhere: no non-test file in packages/*/src,
  //         apps/*/src or services/*/src defines or calls
  //         `getAndResetDelegationReceipts`, and neither
  //         `packages/mcp-client/src` nor the runtime's delegation paths
  //         keep an `ExecutionReceipt[] = []` array;
  //   (ii)  a carried receipt is taken off a result in exactly one place,
  //         `simple-tool-registry.ts`, whose `execute` takes the caller's
  //         `destination` (default `OWNER_ACT`), and the collector records a
  //         turn receipt only when the destination IS the open turn's key;
  //   (iii) the turn's loop deps thread the turn key (`loopDepsForTurn` →
  //         `toolsForTurn`), and the single-writer hold opens and closes the
  //         turn collector (`set _isProcessing`);
  //   (iv)  no turn sink or task path can reach the owner's record: the
  //         only `.drainOwner(` call is `getAndResetReceipts` in
  //         interactive-delegation.ts, and the only
  //         `getAndResetInteractiveDelegationReceipts` / `getAndResetReceipts`
  //         call is the runtime's public owner-only method; the task handler
  //         takes receipts only from its turn's sink (`onDelegationReceipts`);
  //   (v)   the tap path (`pushReceipt`) records as an owner act.
  // Behavior: `task-receipt-scoping.test.ts` (concurrent invokeLocalTool and
  // PlanEngine calls during a task, owner turn, tap, the task's own sub-hire,
  // owner trust credit).
  const receiptViolations: string[] = [];
  const codeOf = (src: string): string =>
    src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
  const handlerSrc = readFile("packages/runtime/src/agent-task-handler.ts") ?? "";
  const handlerCode = codeOf(handlerSrc);
  if (
    /getAndReset\w*\(|\.drainOwner\(/.test(handlerCode) ||
    !/onDelegationReceipts:/.test(handlerCode)
  ) {
    receiptViolations.push(
      "packages/runtime/src/agent-task-handler.ts: a task's receipt must take its delegation receipts ONLY from its turn's sink (`onDelegationReceipts`) and drain no bucket or owner record",
    );
  }
  const idSrc = readFile("packages/runtime/src/interactive-delegation.ts") ?? "";
  const pushReceiptBody = bodyOf(
    idSrc,
    "  pushReceipt(receipt: ExecutionReceipt): void {",
    "\n  }\n",
  );
  if (!/this\.receipts\.recordOwnerAct\(receipt\);/.test(pushReceiptBody)) {
    receiptViolations.push(
      "packages/runtime/src/interactive-delegation.ts: `pushReceipt` (the user-tap path) must record as an owner act (`this.receipts.recordOwnerAct(receipt)`), never into an in-flight turn",
    );
  }
  const setterBody = bodyOf(runtimeSrc, "private set _isProcessing(", "\n  }\n");
  if (
    !/this\.turnReceipts\.open\(\)/.test(setterBody) ||
    !/this\.turnReceipts\.close\(/.test(setterBody)
  ) {
    receiptViolations.push(
      "packages/runtime/src/motebit-runtime.ts: the single-writer hold (`set _isProcessing`) must open and close the turn's receipt collector (`this.turnReceipts.open()` / `.close(`)",
    );
  }
  const ldftTurnBody = bodyOf(runtimeSrc, "private loopDepsForTurn<", "\n  }\n");
  const turnToolsBody = bodyOf(runtimeSrc, "private toolsForTurn(", "\n  }\n");
  if (
    !/this\.toolsForTurn\(deps\.tools, principal\)/.test(ldftTurnBody) ||
    !/const call: ToolCall = \{ destination: this\._turnReceiptKey \?\? OWNER_ACT, principal \};/.test(
      turnToolsBody,
    ) ||
    !/execute: \(name, args\) => inner\.execute\(name, args, call\)/.test(turnToolsBody)
  ) {
    receiptViolations.push(
      "packages/runtime/src/motebit-runtime.ts: `loopDepsForTurn` must thread the turn's key into every tool execute (`this.toolsForTurn(deps.tools, principal)` → `inner.execute(name, args, call)` with `call = { destination: this._turnReceiptKey ?? OWNER_ACT, principal }`)",
    );
  }
  const strSrc = readFile("packages/runtime/src/simple-tool-registry.ts") ?? "";
  if (
    !/call: ToolCall = OWNER_CALL/.test(strSrc) ||
    !/this\.receiptRouter\?\.\(call\.destination, carried\.receipt/.test(strSrc)
  ) {
    receiptViolations.push(
      "packages/runtime/src/simple-tool-registry.ts: `execute` must take the caller's `call` (default `OWNER_CALL`) and route the carried receipt to `call.destination`",
    );
  }
  const tdrSrc = readFile("packages/runtime/src/turn-delegation-receipts.ts") ?? "";
  const recordForBody = bodyOf(tdrSrc, "  recordFor(", "\n  }\n");
  if (
    !/destination !== OWNER_ACT && this\.active != null && this\.active\.key === destination/.test(
      recordForBody,
    )
  ) {
    receiptViolations.push(
      "packages/runtime/src/turn-delegation-receipts.ts: `recordFor` must record into the open turn ONLY when the caller's destination IS that turn's key — never into whatever turn is open",
    );
  }
  let receiptFilesScanned = 0;
  let takeSites = 0;
  let drainOwnerSites = 0;
  let ownerDrainApiSites = 0;
  const receiptSrcRoots: string[] = [];
  for (const root of ["packages", "apps", "services"]) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(resolve(ROOT, root));
    } catch {
      dirs = [];
    }
    for (const d of dirs) receiptSrcRoots.push(join(root, d, "src"));
  }
  for (const srcRoot of receiptSrcRoots) {
    for (const rel of walkTsFiles(srcRoot)) {
      if (rel.includes("__tests__")) continue;
      receiptFilesScanned++;
      const lines = (readFile(rel) ?? "").split("\n");
      const isRuntime = rel.startsWith("packages/runtime/src/");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
        const where = `${rel}:${i + 1}`;
        if (/\bgetAndResetDelegationReceipts\b/.test(line)) {
          receiptViolations.push(
            `${where}: a shared MCP receipt bucket (\`getAndResetDelegationReceipts\`) — return the receipt on the call's result instead: ${line.trim()}`,
          );
        }
        if (
          (rel.startsWith("packages/mcp-client/src/") ||
            rel === "packages/runtime/src/interactive-delegation.ts" ||
            rel === "packages/runtime/src/invoke-capability.ts") &&
          /ExecutionReceipt\[\]\s*=\s*\[\]/.test(line)
        ) {
          receiptViolations.push(
            `${where}: keeps a shared receipt array — a receipt must ride on its call's result and be attributed at capture: ${line.trim()}`,
          );
        }
        if (
          isRuntime &&
          /\btakeCarriedReceipt\(/.test(line) &&
          !/export function takeCarriedReceipt/.test(line)
        ) {
          takeSites++;
          if (rel !== "packages/runtime/src/simple-tool-registry.ts") {
            receiptViolations.push(
              `${where}: takes a carried receipt outside the runtime tool registry — the one place that knows the caller's destination: ${line.trim()}`,
            );
          }
        }
        if (/\.drainOwner\(/.test(line)) {
          drainOwnerSites++;
          if (
            rel !== "packages/runtime/src/interactive-delegation.ts" ||
            !/return this\.receipts\.drainOwner\(\);/.test(line)
          ) {
            receiptViolations.push(
              `${where}: reads the owner's receipt record outside its one owner-only accessor — a turn sink or task path must never reach it: ${line.trim()}`,
            );
          }
        }
        if (/\bgetAndResetInteractiveDelegationReceipts\(|\.getAndResetReceipts\(/.test(line)) {
          if (/^\s*(async\s+)?getAndReset(InteractiveDelegation)?Receipts\(\)/.test(line)) continue;
          ownerDrainApiSites++;
          if (
            rel !== "packages/runtime/src/motebit-runtime.ts" ||
            !/return this\.interactiveDelegation\.getAndResetReceipts\(\);/.test(line)
          ) {
            receiptViolations.push(
              `${where}: drains the owner's receipt record — only the runtime's public owner-only accessor may; a turn sink or task path never does: ${line.trim()}`,
            );
          }
        }
      }
    }
  }
  // (vi) tools from servers the OWNER connected are `localOnly` (#943 round
  // 4): `registerExternalTools` and the runtime's `mcpServers` path register
  // only through `registerOwnerConnectedTool`, which forces `localOnly: true`.
  const rocBody = bodyOf(runtimeSrc, "private registerOwnerConnectedTool(", "\n  }\n");
  const retBody = bodyOf(runtimeSrc, "registerExternalTools(sourceId: string", "\n  }\n");
  if (
    !/this\.toolRegistry\.replace\(\{ \.\.\.def, localOnly: true \}, handler\)/.test(rocBody) ||
    !/has: \(name: string\) => discovered\.has\(name\),/.test(runtimeSrc) ||
    !/this\.registerOwnerConnectedTool\(def,/.test(retBody) ||
    // round 6: a same-named tool already in the registry is MARKED
    // `localOnly` — the floor must not depend on registration order.
    !/this\.toolRegistry\.markLocalOnly\(def\.name\);/.test(retBody) ||
    /connectMcpServers\(this\.mcpConfigs, this\.toolRegistry/.test(runtimeSrc)
  ) {
    receiptViolations.push(
      "packages/runtime/src/motebit-runtime.ts: owner-connected tools (`registerExternalTools`, the `mcpServers` path) must register through `registerOwnerConnectedTool`, which forces `localOnly: true` — never straight into the registry",
    );
  }
  // (vi-b) the CLI REPL owns ONE connection per config-listed server (#943
  // round 6): it hands the runtime none (`runtimeMcpServersForRepl` returns
  // `[]`, and index.ts passes it to `createRuntime`), so `/mcp remove` —
  // which disconnects the REPL's adapter — takes the server out of service.
  const wiringSrc = readFile("apps/cli/src/mcp-config-wiring.ts") ?? "";
  const replIndexSrc = readFile("apps/cli/src/index.ts") ?? "";
  const rmsBody = bodyOf(wiringSrc, "export function runtimeMcpServersForRepl(", "\n}\n");
  if (
    !/^\s*return \[\];/m.test(rmsBody) ||
    !/runtimeMcpServersForRepl\(mcpServers\)/.test(replIndexSrc)
  ) {
    receiptViolations.push(
      "apps/cli/src: the REPL must hand the runtime NO config MCP servers (`runtimeMcpServersForRepl` returns `[]`, passed to `createRuntime`) — a second, runtime-owned connection outlives `/mcp remove`",
    );
  }
  // (vii) surfaces: an owner-connected MCP tool reaches a runtime ONLY
  // through `registerExternalTools` (#943 round 5 — the CLI REPL connected
  // `mcp_servers` into its own registry and MERGED it straight into the
  // runtime registry, so the tools were never `localOnly`). In
  // apps/*/src and packages/*/src (outside mcp-client and runtime): no
  // `.getToolRegistry().merge(`, and a file that connects MCP servers
  // (`connectMcpServers(` / `.registerInto(` / `new McpClientAdapter(`) hands the result to
  // `registerExternalTools(`.
  let mcpWiringFiles = 0;
  for (const srcRoot of receiptSrcRoots) {
    if (!/^(apps|packages)\//.test(srcRoot)) continue;
    if (srcRoot === "packages/mcp-client/src" || srcRoot === "packages/runtime/src") continue;
    for (const rel of walkTsFiles(srcRoot)) {
      if (rel.includes("__tests__")) continue;
      const code = codeOf(readFile(rel) ?? "");
      if (/\.getToolRegistry\(\)\.merge\(/.test(code)) {
        receiptViolations.push(
          `${rel}: merges a registry straight into the runtime's tool registry — owner-connected tools must go through \`runtime.registerExternalTools(…)\` (which forces \`localOnly\`)`,
        );
      }
      if (
        /(?<!typeof )\bconnectMcpServers\(|\.registerInto\(|\bnew McpClientAdapter\(/.test(code)
      ) {
        mcpWiringFiles++;
        if (/\.getToolRegistry\(\)\.(register|replace)\(/.test(code)) {
          receiptViolations.push(
            `${rel}: connects MCP servers AND registers straight into the runtime's tool registry — owner-connected tools reach a runtime only through \`registerExternalTools(…)\``,
          );
        }
        if (!/registerExternalTools\(/.test(code)) {
          receiptViolations.push(
            `${rel}: connects MCP servers but never hands the tools to \`registerExternalTools(…)\` — an owner-connected tool must be registered \`localOnly\``,
          );
        }
      }
    }
  }
  if (takeSites !== 1) {
    receiptViolations.push(
      `packages/runtime/src: expected exactly one \`takeCarriedReceipt(\` call (the tool registry) — found ${takeSites}`,
    );
  }
  if (receiptViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: the owner's delegation receipts could be signed into another principal's task receipt (#943):",
    );
    for (const v of receiptViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: a hire's receipt is attributed AT CAPTURE. Return it on the tool call's result (`delegation_receipt`), let the runtime tool registry route it to the destination the caller threaded into that execute (a turn's key via `loopDepsForTurn`, else the owner), keep no shared receipt array or drain, and have `handleAgentTask` take receipts only from its turn's `onDelegationReceipts` sink.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship (#943).");
    process.exit(1);
  }

  console.log(
    `✓ check-memory-source-canonical: ${MEMORY_SOURCES_REFERENCE.length} memory source(s) locked across union + ALL_MEMORY_SOURCES + gate reference; wire-format-compliant; model/peer authorship scans clean; foreign-turn provenance locked (resolver + ${aiCoreFilesScanned} other ai-core file(s) scanned, 7 wiring links checked); foreign-turn history floor locked (${runtimeFilesScanned} other runtime file(s) scanned for conversation-store writes, ${viewAccesses} per-turn conversation view(s), foreign view ${inertMembers}/${INERT.length} members inert, ${consentSites} consent site(s) guarded, 4 wiring links checked); foreign-turn serving floor locked (${interiorAiCoreFiles} ai-core file(s) scanned, ${ownerStoreReads} owner-store read(s) all inside recallOwnerInterior; ${runtimeInteriorFiles} runtime file(s) scanned, ${builderCalls} owner-block builder call(s) all inside ownerInteriorForTurn; ${ownerKeysClassified}/${DECIDED_OWNER_INTERIOR.length} decided owner-interior option(s) classified, recall backend floored; call-path law: ${runtimeLawFiles} runtime file(s) scanned, ${ambientReads} ambient foreign mark(s), ${principalDecisions} turn-entry principal decision(s), ${recallCallSites} surface recall call(s) naming the owner); owner-only memory serving locked (${mcpFilesScanned} mcp-server file(s), ${registrationsScanned} tool/resource registration(s) scanned, ${memoryReadRegistrations} memory-read registration(s) all owner-checked; ${depFilesScanned} package/app/service src file(s) scanned, ${memoryDepDefs} memory-read dep(s) all asserting the owner; memory_recall frame owner-gated, HTTP never the owner); task receipts attributed at capture (${receiptFilesScanned} package/app/service src file(s) scanned: no shared receipt bucket; ${takeSites} carried-receipt take site (the tool registry, caller's destination); ${drainOwnerSites} owner-record read(s) + ${ownerDrainApiSites} owner-drain call(s), all the owner-only accessor; turn key threaded; handler sink-only; tap = owner act; owner-connected tools localOnly; ${mcpWiringFiles} surface MCP-wiring file(s) all through registerExternalTools, no runtime-registry merge).`,
  );
}

main();
